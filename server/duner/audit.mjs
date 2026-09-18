/**
 * 全链路审计 —— 指导书第 2 节第 3 条「一切可审计」。
 *
 * 要求记的是四段：**原始输入 → 识别的意图 → 调用的工具 → 执行结果**。
 * 缺任何一段，事后都答不出"它当时为什么这么干"：
 * - 少了原始输入，就不知道用户到底说了什么（归一化会改字）；
 * - 少了意图，就不知道是规则还是模型判的；
 * - 少了工具与结果，就分不清"识别对了但没执行"和"根本没识别出来"。
 *
 * ## 复用既有的 `audit_log`，不另起一张表
 *
 * `server/db.mjs` 的 `logAudit(db, user, action, target, detail)` 已经在用了
 * （登录、增删改业务表都往里写）。再开一张"AI 审计表"会得到两本账，
 * 而排查时最需要的那句"这次对话之后系统里发生了什么"要跨两张表拼 —— 没有意义。
 *
 * 所以一次对话落**一行**：`action='duner'`、`target=<意图 ID>`、
 * `detail=JSON`。写操作成功时**额外**落一行 `action='duner.write'`，
 * 因为"改了数据"和"查了一下"的排查优先级完全不同，混在一行里靠 detail 区分
 * 会让「最近谁改了东西」这个最常见的问法变得难查。
 *
 * ## `detail` 为什么截断
 *
 * `audit_log.detail` 是 TEXT 不设限，而工具结果里可能带很长的卡片。
 * 一次对话几百字、一天几百次是正常的，但有人把整篇预案贴进来问就会失控。
 * 截到 2000 字并**在末尾标明已截断** —— 悄悄截断会让人以为原始输入就这么短。
 */

import { logAudit } from '../db.mjs'

const MAX_DETAIL = 2000

/** 记一次对话（读或写都记） */
export function auditChat(db, user, { raw, normalized, intents, source, confidence, results, reply, ms, degraded }) {
  const detail = {
    raw,
    // 归一化后的文本单独留一份：raw 与 normalized 不同时，
    // 「为什么把"边皮廊"认成了皮带廊」这个问题只有这一行能回答
    normalized,
    source,
    confidence,
    intents: (intents ?? []).map((i) => ({ id: i.intent, slots: i.slots })),
    tools: (results ?? []).map((r) => ({ tool: r.tool, kind: r.result?.kind })),
    reply,
    ms,
    degraded
  }
  const target = (intents ?? []).map((i) => i.intent).join(',') || '(未识别)'
  logAudit(db, user, 'duner', target, truncate(detail))
  return target
}

/** 记一次写操作的确认与执行。**与对话那行分开**（见文件头） */
export function auditWrite(db, user, { tool, payload, ok, message, token, ms }) {
  logAudit(db, user, 'duner.write', tool, truncate({ token, payload, ok, message, ms }))
}

/**
 * 记一次前端回执（指导书 4.3 的闭环：后端发指令，前端执行后回执）。
 *
 * `auditId` 是**这一次对话那行审计的 id**，由前端原样带回。有了它，
 * 「指令发下去了、前端执行成没有」这件事才和原始输入串得上；
 * 只有 `cmdId` 的话，两行审计之间没有任何共同的键。
 */
export function auditReceipt(db, user, { cmdId, tool, ok, ms, note, auditId }) {
  logAudit(db, user, 'duner.receipt', tool || cmdId || '(未知指令)', truncate({ auditId, cmdId, ok, ms, note }))
}

/** 记一次拒绝（越权 / 越界 / 注入）。拒绝也要留痕 —— "被拒绝过几次"是安全信号 */
export function auditDenied(db, user, { raw, reason, intent }) {
  logAudit(db, user, 'duner.denied', intent || reason, truncate({ raw, reason }))
}

/** 记一次词典改动（谁把"大车"加进来了） */
export function auditDict(db, user, { action, term, synonyms }) {
  logAudit(db, user, `duner.dict.${action}`, term, truncate({ term, synonyms }))
}

/**
 * 序列化并截断。用 JSON 而不是拼字符串：审计要能被程序读，
 * 而"从一段中文里正则抠出槽位"是排查时最不该做的事。
 */
function truncate(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text.length <= MAX_DETAIL) return text
  return `${text.slice(0, MAX_DETAIL)}…(已截断，原长 ${text.length})`
}

/** 最近审计（管理员接口 `GET /api/duner/audit`） */
export function recentAudit(db, limit = 50) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50))
  return db
    .prepare(
      'SELECT "id","username","role","action","target","detail","at" FROM audit_log ' +
        "WHERE \"action\" LIKE 'duner%' ORDER BY \"id\" DESC LIMIT ?"
    )
    .all(n)
    .map((r) => ({ ...r, detail: safeParse(r.detail) }))
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
