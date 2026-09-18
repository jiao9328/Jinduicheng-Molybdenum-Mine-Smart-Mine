/**
 * ConfirmManager —— 写操作的确认令牌（指导书第 2 节第 2 条、4.4）。
 *
 * 状态机：`发起` → 落一条 pending → 用户点确认 → **一次性兑换** → 执行 → 作废。
 * 令牌 60 秒过期（`config.CONFIRM_TTL_MS`）。
 *
 * ## 一次性兑换为什么要靠 SQL 的 `changes`，而不是"先查再改"
 *
 * 直觉写法是：
 * ```
 * const row = get(token)
 * if (row.redeemed) return '已用过'
 * markRedeemed(token)          // ← 这里有窗口
 * ```
 * 在单线程 Node 里这看着安全，但 `POST /api/duner/confirm` 是 **async** 的，
 * 而兑换之后要 `await` 执行工具、写审计。两个并发的同 token 请求
 * 完全可以在第一个还没 `markRedeemed` 时双双通过 `get` 的检查 ——
 * 结果是一次确认执行了两遍写操作，而指标恰恰要求"未经确认执行写操作 = 0"。
 *
 * 所以改成一条语句内完成判定与置位：
 * `UPDATE ... WHERE token=? AND redeemed=0 AND expires_at>?`
 * 拿 `changes === 1` 当唯一凭据。这是唯一不会被并发钻空子的写法。
 *
 * ## 令牌必须是不可猜的
 *
 * 用 `randomBytes(24)`（192 位）而不是递增 id / 时间戳。
 * 令牌就是"已获用户授权"的凭据，可猜的令牌等于任何人都能替别人确认一次写操作。
 */

import { randomBytes } from 'node:crypto'
import { CONFIRM_TTL_MS } from './config.mjs'

/** 过期与已用的清理窗口：留着更久的行没有用处，也没有排查价值 */
const SWEEP_KEEP_MS = 24 * 3600_000

/**
 * 登记一次待确认的写操作，返回令牌。
 *
 * @param user 发起人。**兑换时必须是同一个人** —— 换个人拿到令牌也不能用
 */
export function issue(db, { user, tool, payload, card, text }) {
  const token = randomBytes(24).toString('hex')
  const now = Date.now()
  db.prepare(
    'INSERT INTO pending_confirm ("token","user_id","username","intent","payload","created_at","expires_at","redeemed") ' +
      'VALUES (?,?,?,?,?,?,?,0)'
  ).run(token, user.id, user.username, tool, JSON.stringify(payload ?? {}), now, now + CONFIRM_TTL_MS)
  return { token, expiresInMs: CONFIRM_TTL_MS, card, text, tool }
}

/**
 * 兑换令牌。返回 `{ok:true, row}` 或 `{ok:false, reason}`。
 *
 * 失败原因是**分开**的（过期 / 已用过 / 不是你的），因为对应的用户提示不一样：
 * 过期要"重新说一遍"，已用过要"这条已经执行过了"，不是你的要"别动别人的操作"。
 * 合成一个"无效令牌"会让人反复重试一个永远不可能成功的动作。
 */
export function redeem(db, token, user) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' }

  const row = db
    .prepare('SELECT * FROM pending_confirm WHERE "token" = ?')
    .get(token)

  if (!row) return { ok: false, reason: 'not_found' }

  // 先判归属再判状态：别人的令牌不该从我们这里得到"已过期"这种有效信息
  if (Number(row.user_id) !== Number(user?.id)) return { ok: false, reason: 'not_yours' }

  const now = Date.now()
  if (Number(row.expires_at) <= now) return { ok: false, reason: 'expired' }

  // 判定与置位在同一条语句里 —— 这是本模块的核心（见文件头）
  const info = db
    .prepare(
      'UPDATE pending_confirm SET "redeemed" = 1 ' +
        'WHERE "token" = ? AND "redeemed" = 0 AND "expires_at" > ?'
    )
    .run(token, now)

  if (Number(info.changes) !== 1) return { ok: false, reason: 'already_used' }

  let payload = {}
  try {
    payload = JSON.parse(row.payload)
  } catch {
    payload = {}
  }
  return { ok: true, row: { token: row.token, tool: row.intent, payload, username: row.username } }
}

/** 把失败原因翻成给用户看的话 */
export const REDEEM_MESSAGE = {
  missing: '这次操作没有带上确认令牌，请重新发起。',
  not_found: '这个确认令牌不存在，可能已经清理掉了，请重新发起。',
  not_yours: '这条待确认操作不是你发起的，不能由你确认。',
  // 秒数与 `service.mjs` 那句一样从配置现算（理由见那边）
  expired: `这次确认已超时（${Math.round(CONFIRM_TTL_MS / 1000)} 秒内需确认），请重新说一遍。`,
  already_used: '这条操作已经确认执行过了，没有重复执行。'
}

/** 清理过期记录。启动时与每次兑换后顺手跑，避免表无限增长 */
export function sweep(db) {
  const info = db
    .prepare('DELETE FROM pending_confirm WHERE "expires_at" < ?')
    .run(Date.now() - SWEEP_KEEP_MS)
  return Number(info.changes)
}

/** 供界面显示"有一条待确认"（`GET /api/duner/pending`） */
export function listPending(db, user) {
  return db
    .prepare(
      'SELECT "token","intent","payload","expires_at" FROM pending_confirm ' +
        'WHERE "user_id" = ? AND "redeemed" = 0 AND "expires_at" > ? ORDER BY "created_at" DESC'
    )
    .all(user?.id ?? -1, Date.now())
    .map((r) => ({ token: r.token, tool: r.intent, expiresAt: r.expires_at }))
}
