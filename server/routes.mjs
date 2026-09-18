/**
 * 接口路由与权限判定。
 *
 * ## 只用四个状态码，语义固定
 *
 * | 码 | 含义 | 前端会怎么处理 |
 * | --- | --- | --- |
 * | 400 | 请求体不合法（缺必填、没给可更新字段） | **不降级**，直接抛给调用方 |
 * | 401 | 没登录 / 会话过期 | 清会话跳登录页 |
 * | 403 | 登录了但角色不够 | 提示无权限，不跳转 |
 * | 404 | 路由或行不存在 | **可降级** —— 见下面那条 |
 *
 * ## 404 要分两种，别混
 *
 * 本方案只实现了全部 74 个接口里的 5 个，其余仍由前端降级到 mock。前端
 * 的降级判定把 404 当「这个接口还没实现」（`http.ts` 的 `degradable`），
 * 所以：
 * - **路由不存在** → 404，正是我们想要的（前端继续用 mock）
 * - **行不存在**（改一条已被别人删掉的记录）→ 也回 404
 *
 * 后者严格说该是 410/409，但读接口走的是 `requestWithFallback`，
 * 改行用的是前端 `http.put`（不降级），两条路不会互相污染。为省一个
 * 状态码的复杂度，这里统一 404 并把原因写在 body 里。
 *
 * ## 权限：每个写操作单独判，不靠中间件一把梭
 *
 * 写操作只有四个资源 + 隐患状态推进，逐个调 `requireAdmin`。用中间件按
 * 方法统一拦（「非 GET 即 403」）看着更省事，但以后加一个「用户也能写」
 * 的接口（比如值班员提交交接班）就得推翻它 —— 显式判定改起来是加一行，
 * 隐式规则改起来是动全局。
 */
import {
  RESOURCES,
  HAZARD_STATUS,
  FieldError,
  pickFields,
  listRows,
  getRow,
  insertRow,
  updateRow,
  deleteRow,
  tableCounts,
  logAudit
} from './db.mjs'
import {
  DEMO_ACCOUNTS,
  verifyLogin,
  createSession,
  destroySession,
  purgeExpiredSessions
} from './auth.mjs'
import { chat, confirm, receipt, capabilities } from './duner/service.mjs'
import { getDict, countDict, upsertTerm, deleteTerm } from './duner/dict.mjs'
import { auditDict, recentAudit } from './duner/audit.mjs'

const ok = (body, status = 200) => ({ status, body })
const fail = (status, message) => ({ status, body: { message } })

/**
 * 写操作的闸门。
 *
 * 返回错误对象表示拦下，返回 `null` 表示放行。调用处一律写成
 * `const denied = requireAdmin(ctx); if (denied) return denied`，
 * 这样漏判一眼能看出来 —— 比 `if (!isAdmin) return` 那种写法更难漏。
 */
function requireAdmin(ctx) {
  if (!ctx.user) return fail(401, '未登录或登录已过期')
  if (ctx.user.role !== 'admin') {
    return fail(403, `当前账号（${ctx.user.username}）是「${ctx.user.role === 'user' ? '普通用户' : ctx.user.role}」角色，只有管理员可以增删改`)
  }
  return null
}

/** 主键取值：整型主键要收敛成数字，`abc` 直接当参数错误，别拿去查库 */
function coerceKey(resource, raw) {
  if (resource.key === 'id') {
    const n = Number(raw)
    if (!Number.isInteger(n)) throw new FieldError(`主键 ${resource.key} 必须是整数，收到「${raw}」`)
    return n
  }
  return String(raw)
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

function login(ctx) {
  const { username, password } = ctx.body ?? {}
  const user = verifyLogin(ctx.db, username, password)
  if (!user) return fail(401, '用户名或口令不正确')

  purgeExpiredSessions(ctx.db)
  const token = createSession(ctx.db, user.id)
  logAudit(ctx.db, user, 'login', 'auth', `会话 token ${token.slice(0, 8)}…`)
  return ok({ token, user })
}

function logout(ctx) {
  logAudit(ctx.db, ctx.user, 'logout', 'auth', '')
  destroySession(ctx.db, ctx.bearer)
  return ok({ ok: true })
}

/**
 * 健康检查 —— **刻意不要求登录**。
 *
 * 它是给运维与巡检脚本用的探针（「后端活着吗、库里有没有数据」），
 * 要求登录就等于让探针自己先走一遍登录流程。返回的内容只有表名与条数、
 * 以及演示账号的**用户名与角色**（口令不在其中，它只印在登录页上），
 * 没有任何一项是拿到接口就能白得的信息。
 */
function health(ctx) {
  return ok({
    ok: true,
    database: 'sqlite',
    tables: tableCounts(ctx.db),
    accounts: DEMO_ACCOUNTS.map(({ username, role, displayName }) => ({
      username,
      role,
      displayName
    }))
  })
}

// ---------------------------------------------------------------------------
// 四张台账的增删改查
// ---------------------------------------------------------------------------

const list = (ctx) => ok(listRows(ctx.db, ctx.resource))

const readOne = (ctx) => {
  const row = getRow(ctx.db, ctx.resource, coerceKey(ctx.resource, ctx.params.id))
  return row ? ok(row) : fail(404, `${ctx.resource.label}：找不到主键为「${ctx.params.id}」的记录`)
}

const create = (ctx) => {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const values = pickFields(ctx.resource, ctx.body)
  let row
  try {
    row = insertRow(ctx.db, ctx.resource, values)
  } catch (err) {
    // 唯一约束冲突（备件编码重复）是**请求本身的问题**，必须回 4xx。
    // 回 5xx 会被前端当成「后端坏了」而降级到 mock，那样界面会显示成功，
    // 实则根本没写进去 —— 这是最坏的一种失败。
    if (/UNIQUE|PRIMARY KEY/i.test(String(err.message))) {
      return fail(409, `${ctx.resource.label}：主键「${values[ctx.resource.key]}」已存在`)
    }
    throw err
  }
  logAudit(ctx.db, ctx.user, 'create', ctx.resource.table, JSON.stringify(values))
  return ok(row, 201)
}

const update = (ctx) => {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const keyValue = coerceKey(ctx.resource, ctx.params.id)
  const values = pickFields(ctx.resource, ctx.body, { partial: true })
  const row = updateRow(ctx.db, ctx.resource, keyValue, values)
  if (!row) return fail(404, `${ctx.resource.label}：找不到主键为「${ctx.params.id}」的记录`)

  logAudit(ctx.db, ctx.user, 'update', ctx.resource.table, JSON.stringify({ [ctx.resource.key]: keyValue, ...values }))
  return ok(row)
}

const remove = (ctx) => {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const keyValue = coerceKey(ctx.resource, ctx.params.id)
  const existed = getRow(ctx.db, ctx.resource, keyValue)
  if (!existed || !deleteRow(ctx.db, ctx.resource, keyValue)) {
    return fail(404, `${ctx.resource.label}：找不到主键为「${ctx.params.id}」的记录`)
  }
  logAudit(ctx.db, ctx.user, 'delete', ctx.resource.table, JSON.stringify(existed))
  return ok({ ok: true, deleted: existed })
}

/**
 * 推进一条隐患的处置状态 —— **本项目原有的第一个写接口**
 *（前端 `emergencyApi.updateHazardStatus`，页面用乐观更新）。
 *
 * 它落在 `hazard_disposals` 表上，所以接库之后它从「写不进去、返回 false」
 * 变成真的落库。前端一行都不用改：那边本来就等着这一天。
 *
 * 状态取值按 `HAZARD_STATUS` 校验 —— 这是唯一一个「字段值有枚举约束」
 * 的写接口，放非法值进来会让页面上的 `StatusTag` 渲染成空白。
 */
const advanceHazard = (ctx) => {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const resource = RESOURCES['emergency/hazard-disposals']
  const id = coerceKey(resource, ctx.params.id)
  const status = ctx.body?.status
  if (!HAZARD_STATUS.includes(status)) {
    return fail(400, `隐患状态只能是 ${HAZARD_STATUS.join(' / ')}，收到「${status}」`)
  }

  const text = { done: '已处置', doing: '处置中', todo: '未处理' }[status]
  const row = updateRow(ctx.db, resource, id, { status, statusText: text })
  if (!row) return fail(404, `隐患处置：找不到 id 为 ${id} 的记录`)

  logAudit(ctx.db, ctx.user, 'update', resource.table, JSON.stringify({ id, status }))
  return ok(row)
}

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

/**
 * 资源路由由 `RESOURCES` 生成，不手写 —— 加一张表只改 `db.mjs` 一处。
 * `:id` 用 `([^/]+)` 匹配，交给各自的 `coerceKey` 收敛类型。
 */
const RESOURCE_ROUTES = Object.entries(RESOURCES).flatMap(([path, resource]) => [
  { method: 'GET', re: new RegExp(`^/${path}$`), resource, handler: list },
  { method: 'GET', re: new RegExp(`^/${path}/([^/]+)$`), resource, handler: readOne },
  { method: 'POST', re: new RegExp(`^/${path}$`), resource, handler: create },
  { method: 'PUT', re: new RegExp(`^/${path}/([^/]+)$`), resource, handler: update },
  { method: 'PATCH', re: new RegExp(`^/${path}/([^/]+)$`), resource, handler: update },
  { method: 'DELETE', re: new RegExp(`^/${path}/([^/]+)$`), resource, handler: remove }
])

// ---------------------------------------------------------------------------
// 墩儿（AI 助手）—— 指导书 4.2 的五步链路
// ---------------------------------------------------------------------------
//
// 这里的 handler **全是异步**的（要调模型、要等超时），所以 `handleRequest`
// 也必须是 async 并且真的 await 它们。理由写在那个函数上，别改成同步。

/**
 * 一句话 → 意图 → 视图指令。
 *
 * **任何登录用户都能用**：导航和查询是只读的，真正的写操作闸门在
 * `policy.mjs` 里按工具判（`readOnly: false` → 必须管理员 + 必须确认），
 * 不在这里按角色拦。理由与 `requireAdmin` 那段注释同源 ——
 * 在路由层统一拦「非 GET 即 403」，等于把「哪句话会写库」这件事
 * 押在 HTTP 方法上，而对话接口的方法永远是 POST。
 */
async function dunerChat(ctx) {
  const text = String(ctx.body?.text ?? '')
  if (!text.trim()) return fail(400, 'text 不能为空')
  // 超长输入截断而不是拒绝：大屏前的人是说话、粘贴，不是填表单，
  // 因为粘贴长了就报错不如截断后如实告知（审计里存的是截断后的）。
  const trimmed = text.slice(0, 500)
  const res = await chat({ db: ctx.db, user: ctx.user, text: trimmed, context: ctx.body?.context })
  return ok(res)
}

async function dunerConfirm(ctx) {
  const token = String(ctx.body?.token ?? '')
  if (!token) return fail(400, 'token 不能为空')
  const res = await confirm({ db: ctx.db, user: ctx.user, token })
  // 令牌无效/过期/已用 —— 是**请求本身**的问题，不是服务器故障。
  // 回 409（冲突：这条令牌的状态和你以为的不一样）而不是 500，
  // 前端才能把它当成一句可读的话展示给用户。
  // 注意 HTTP 状态与 `res.ok` 是两件事：这里 ok 一定为 true（请求处理成功），
  // 兑换是否成功看 `res.ok`。
  return res.ok === false ? { status: 409, body: res } : ok(res)
}

function dunerReceipt(ctx) {
  return ok(receipt(ctx.db, ctx.user, ctx.body ?? {}))
}

function dunerCapabilities(ctx) {
  return ok(capabilities(ctx.db))
}

function dunerDictGet(ctx) {
  return ok({ dict: getDict(ctx.db), count: countDict(ctx.db) })
}

function dunerDictPost(ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const term = String(ctx.body?.term ?? '').trim()
  if (!term) return fail(400, 'term 不能为空')
  const synonyms = Array.isArray(ctx.body?.synonyms) ? ctx.body.synonyms.map((s) => String(s).trim()).filter(Boolean) : []
  try {
    const row = upsertTerm(ctx.db, { term, category: String(ctx.body?.category ?? ''), synonyms })
    auditDict(ctx.db, ctx.user, { action: 'upsert', term, synonyms })
    return ok(row)
  } catch (err) {
    if (err instanceof FieldError) return fail(400, err.message)
    throw err
  }
}

function dunerDictDelete(ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const term = String(ctx.query?.term ?? '').trim()
  if (!term) return fail(400, '缺少 term 参数')
  const removed = deleteTerm(ctx.db, term)
  if (!removed) return fail(404, `词典里没有「${term}」`)
  auditDict(ctx.db, ctx.user, { action: 'delete', term, synonyms: [] })
  return ok({ ok: true })
}

/** 审计查询 —— **只给管理员**：里面存的是所有人的原话 */
function dunerAudit(ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const limit = Math.min(Math.max(Number(ctx.query?.limit) || 50, 1), 200)
  return ok({ rows: recentAudit(ctx.db, limit) })
}

const FIXED_ROUTES = [
  { method: 'PUT', re: /^\/emergency\/hazards\/([^/]+)\/status$/, handler: advanceHazard },

  { method: 'POST', re: /^\/duner\/chat$/, handler: dunerChat },
  { method: 'POST', re: /^\/duner\/confirm$/, handler: dunerConfirm },
  { method: 'POST', re: /^\/duner\/receipt$/, handler: dunerReceipt },
  { method: 'GET', re: /^\/duner\/capabilities$/, handler: dunerCapabilities },
  { method: 'GET', re: /^\/duner\/dict$/, handler: dunerDictGet },
  { method: 'POST', re: /^\/duner\/dict$/, handler: dunerDictPost },
  { method: 'DELETE', re: /^\/duner\/dict$/, handler: dunerDictDelete },
  { method: 'GET', re: /^\/duner\/audit$/, handler: dunerAudit }
]

/**
 * 唯一入口。`ctx.path` 是**去掉 `/api` 前缀**后的路径。
 *
 * 返回 `{ status, body }`，不碰 `res` —— 路由与 HTTP 分离，这样权限判定
 * 可以脱离服务器单独测（`scripts/check-auth.mjs` 就是这么用的）。
 *
 * **是 `async` 的**：墩儿的对话路由要等模型返回，命中那条路由时整个函数
 * 就是一个 Promise。同步路由照旧 —— 它们返回的是值，`await` 拿到的是同一个值。
 * 调用方（`server/index.mjs`）必须 `await`，理由写在那边。
 */
export async function handleRequest(ctx) {
  const { method, path } = ctx

  // 1. 公开路由：只有登录与健康检查，别的统统要先登录
  if (method === 'POST' && path === '/auth/login') return login(ctx)
  if (method === 'GET' && path === '/health') return health(ctx)

  if (!ctx.user) return fail(401, '未登录或登录已过期')

  if (method === 'POST' && path === '/auth/logout') return logout(ctx)
  if (method === 'GET' && path === '/auth/me') return ok({ user: ctx.user })

  // 2. 资源路由
  for (const route of [...RESOURCE_ROUTES, ...FIXED_ROUTES]) {
    if (route.method !== method) continue
    const match = route.re.exec(path)
    if (!match) continue

    const params = { id: match[1] }
    try {
      // await 写在 try 里面：异步 handler 抛出的错也要被这里接住。
      // 写成 `return route.handler(...)` 的话拒绝会绕开这个 catch，
      // FieldError 就翻不成 400 了 —— 表现是 AI 相关的接口偶发 500。
      return await route.handler({ ...ctx, params, resource: route.resource })
    } catch (err) {
      if (err instanceof FieldError) return fail(400, err.message)
      throw err
    }
  }

  // 3. 其余 70 个接口本方案没实现 —— 404，前端照旧降级到内置数据
  return fail(404, `接口未实现：${method} /api${path}`)
}
