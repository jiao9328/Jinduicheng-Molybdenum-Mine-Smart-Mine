/**
 * 口令哈希、会话与身份识别。
 *
 * ## 这里是唯一的权限边界
 *
 * README §13 第 4 条记着一条当时立的规矩：**前端裁剪界面从来不是安全边界，
 * 每个写操作都必须由后端校验**。本次把登录与权限体系加回来，规矩不变 ——
 * 前端藏掉「数据管理」入口只是少让评审看到按钮，真正的拦截在
 * `routes.mjs` 里逐个写接口上做的（`requireAdmin`）。所以本文件只关心
 * 「你是谁」，不关心「你能干什么」。
 *
 * ## 口令怎么存
 *
 * `scrypt` + **每用户独立随机盐**，绝不明文、绝不复用盐。校验用
 * `timingSafeEqual` 而不是 `===`：后者会在第一个不同的字节处提前返回，
 * 逐字节爆破的时间差是可测的。
 *
 * ## 演示口令是公开的
 *
 * 这是演示平台，账号口令直接印在登录页上（见 `LoginView.vue`）。
 * 当年删掉登录墙的理由是「演示定位下登录墙只会挡住评审」，把口令写在
 * 页面上正好化解这个顾虑：评审零成本进入，而权限差异仍然真实存在。
 * **正因如此，这套鉴权不应当被当成生产级方案** —— 详见 README §13 第 30 条。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** 会话有效期 12 小时。大屏是值班制，一个班次内不该被踢下线 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

/** 密钥长度（字节）。scrypt 默认参数（N=16384）对本场景足够 */
const KEY_LEN = 64

/**
 * 预置账号。
 *
 * 口令只在这里出现一次，登录页印的是同一份文案 —— 两边靠
 * `scripts/check-auth.mjs` 断言「这两个账号真的能登进去」来防漂移：
 * 改了这里而忘了改页面，自检会红，不会静默失配。
 */
export const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'admin123', role: 'admin', displayName: '系统管理员' },
  { username: 'user', password: 'user123', role: 'user', displayName: '值班员' }
]

function hash(password, salt) {
  return scryptSync(password, salt, KEY_LEN)
}

/**
 * 建账号。已存在则**原样返回、不覆盖**。
 *
 * 不覆盖是有意的：库里的口令可能已经被改过，每次启动都重置回默认口令
 * 会让「改口令」这个动作失去意义。要重置请删掉 `server/data/mine.db`。
 */
export function ensureUser(db, { username, password, role, displayName }) {
  const existing = db.prepare('SELECT * FROM users WHERE "username" = ?').get(username)
  if (existing) return existing

  const salt = randomBytes(16).toString('hex')
  const info = db
    .prepare(
      'INSERT INTO users ("username", "password_hash", "salt", "role", "display_name", "created_at") ' +
        'VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      username,
      hash(password, salt).toString('hex'),
      salt,
      role,
      displayName,
      new Date().toISOString()
    )
  return db.prepare('SELECT * FROM users WHERE "id" = ?').get(Number(info.lastInsertRowid))
}

/** 幂等地把预置账号灌好。服务启动与种子脚本都调它 */
export function ensureDemoUsers(db) {
  for (const account of DEMO_ACCOUNTS) ensureUser(db, account)
}

/** 对外可见的用户信息 —— **绝不能带 password_hash / salt 出去** */
function publicUser(row) {
  return { id: Number(row.id), username: row.username, role: row.role, displayName: row.display_name }
}

/**
 * 校验口令。成功返回用户，失败返回 `null`。
 *
 * 用户不存在与口令错**返回同一个结果**，不区分 —— 区分开等于免费告诉
 * 试探者「这个用户名是对的」。
 */
export function verifyLogin(db, username, password) {
  const row = db.prepare('SELECT * FROM users WHERE "username" = ?').get(String(username ?? ''))
  if (!row) return null

  const expected = Buffer.from(row.password_hash, 'hex')
  const actual = hash(String(password ?? ''), row.salt)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return publicUser(row)
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions ("token", "user_id", "expires_at") VALUES (?, ?, ?)').run(
    token,
    userId,
    Date.now() + SESSION_TTL_MS
  )
  return token
}

export function destroySession(db, token) {
  if (!token) return
  db.prepare('DELETE FROM sessions WHERE "token" = ?').run(token)
}

/** 顺手清掉过期会话。量很小，每次登录时清一遍就够，不必上定时任务 */
export function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE "expires_at" < ?').run(Date.now())
}

/** 从 `Authorization: Bearer <token>` 里取 token，取不到返回空串 */
export function bearerToken(req) {
  const header = req.headers.authorization ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : ''
}

/**
 * 认出请求背后的用户。匿名返回 `null`（不是错误）。
 *
 * 会话过期与 token 不存在同样返回 `null`：对调用方而言两者没区别，
 * 都是「需要重新登录」。
 */
export function currentUser(db, req) {
  const token = bearerToken(req)
  if (!token) return null

  const session = db.prepare('SELECT * FROM sessions WHERE "token" = ?').get(token)
  if (!session) return null

  if (Number(session.expires_at) < Date.now()) {
    destroySession(db, token)
    return null
  }

  const row = db.prepare('SELECT * FROM users WHERE "id" = ?').get(session.user_id)
  return row ? publicUser(row) : null
}
