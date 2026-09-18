/**
 * 库连接、表结构与资源定义。
 *
 * ## 为什么用 `node:sqlite` 而不是 better-sqlite3
 *
 * 本仓库有一条贯穿始终的取舍：**能自己写就不加依赖**（`scripts/ws-stub.mjs`
 * 手写 HTTP/WebSocket 就是同一个理由）。Node 24 起 `node:sqlite` 已内置，
 * 一个真实的关系库、零新增依赖、零原生编译 —— 在这个体量的演示平台上
 * 没有任何理由再引第三方包。代价是启动时会打印一行 ExperimentalWarning，
 * 可以接受。
 *
 * ## 表是「四张真表」，不是「一张万能表」
 *
 * 平台上还有七十来个接口的图表数据（月份+数值、饼图占比）**刻意不入库**：
 * 它们是一张图一个形状的展示参数，不是「一条条记录」。硬塞进一张
 * `datasets(name, json)` 万能表只会得到一堆字段各异、没人看得懂的 JSON 串，
 * 既不能按字段查询、也不能按字段校验，等于把数据库当文件用。
 * 这里只收**真的有记录语义**的四类台账。
 *
 * ## 字段名与 mock 一字不差
 *
 * 四张表的字段直接照搬 `src/mock/*.ts` 里的接口定义。理由：页面的类型是从
 * mock 透出的（`@/api/*` 那一层 `export type`），巡检脚本也有按这些字段名写的
 * 断言。改一个名字就会同时打断页面类型和脚本断言，收益却为零。
 * 接口就绪后 mock 仍是**降级数据源**，两边的形状必须长期保持一致。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 库文件位置。`MINE_DB` 可覆盖（`:memory:` 用于自检，见 scripts/check-auth.mjs） */
export const DB_PATH = process.env.MINE_DB ?? join(HERE, 'data', 'mine.db')

/**
 * 建表语句。全部 `IF NOT EXISTS`，重复启动不报错。
 *
 * 主键一律用自增整数，唯一例外是 `spare_parts` —— 备件天然有业务主键
 * `code`（SP-1001），拿它当主键比再造一个 id 更有意义：台账里同一编码
 * 不可能有两行，而自增 id 拦不住这种重复录入。
 *
 * 列名统一加双引号：`type` / `location` / `group` 这类词在 SQL 里
 * 时而保留时而普通，加引号就不必逐个去查关键字表。同理，下面所有语句
 * 都显式列出列名，不写 `INSERT INTO t VALUES(...)` 那种靠位置的写法 ——
 * 加一列就静默错位是这类代码最经典的报废方式。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  "id"            INTEGER PRIMARY KEY AUTOINCREMENT,
  "username"      TEXT    NOT NULL UNIQUE,
  "password_hash" TEXT    NOT NULL,
  "salt"          TEXT    NOT NULL,
  "role"          TEXT    NOT NULL CHECK ("role" IN ('admin', 'user')),
  "display_name"  TEXT    NOT NULL DEFAULT '',
  "created_at"    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  "token"      TEXT    PRIMARY KEY,
  "user_id"    INTEGER NOT NULL REFERENCES users("id"),
  "expires_at" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  "id"       INTEGER PRIMARY KEY AUTOINCREMENT,
  "username" TEXT    NOT NULL,
  "role"     TEXT    NOT NULL,
  "action"   TEXT    NOT NULL,
  "target"   TEXT    NOT NULL,
  "detail"   TEXT    NOT NULL DEFAULT '',
  "at"       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS quality_records (
  "id"     INTEGER PRIMARY KEY AUTOINCREMENT,
  "time"   TEXT NOT NULL DEFAULT '',
  "issue"  TEXT NOT NULL DEFAULT '',
  "action" TEXT NOT NULL DEFAULT '',
  "owner"  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS duty_schedule (
  "id"     INTEGER PRIMARY KEY AUTOINCREMENT,
  "shift"  TEXT NOT NULL DEFAULT '',
  "time"   TEXT NOT NULL DEFAULT '',
  "leader" TEXT NOT NULL DEFAULT '',
  "crew"   TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS spare_parts (
  "code"     TEXT    PRIMARY KEY,
  "name"     TEXT    NOT NULL DEFAULT '',
  "device"   TEXT    NOT NULL DEFAULT '',
  "inbound"  INTEGER NOT NULL DEFAULT 0,
  "outbound" INTEGER NOT NULL DEFAULT 0,
  "stock"    INTEGER NOT NULL DEFAULT 0,
  "minStock" INTEGER NOT NULL DEFAULT 0,
  "unit"     TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS hazard_disposals (
  "id"         INTEGER PRIMARY KEY AUTOINCREMENT,
  "type"       TEXT NOT NULL DEFAULT '',
  "location"   TEXT NOT NULL DEFAULT '',
  "status"     TEXT NOT NULL DEFAULT 'todo',
  "statusText" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS decision_orders (
  "id"         INTEGER PRIMARY KEY AUTOINCREMENT,
  "suggestion" TEXT NOT NULL DEFAULT '',
  "content"    TEXT NOT NULL DEFAULT '',
  "level"      TEXT NOT NULL DEFAULT 'mid',
  "owner"      TEXT NOT NULL DEFAULT '',
  "status"     TEXT NOT NULL DEFAULT 'todo',
  "due"        TEXT NOT NULL DEFAULT '',
  "createdAt"  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 墩儿（AI 助手）用的两张表。DDL 放在这里而不是 server/duner/ 里，
-- 是因为**建表只能有一个入口**：分散成两处，加表的人漏调一次
-- 那个 init 函数，表就不存在，而报错要等到第一次真正用到才炸。

-- 矿山术语词典（指导书第 5 节）。term 是标准词，synonyms 是 JSON 数组。
-- builtin 标出"平台自带"还是"管理员加的" —— 种子只补缺不覆盖，
-- 所以这个标记是用来让人分辨"这条是我改的还是自带的"，不参与任何逻辑分支。
CREATE TABLE IF NOT EXISTS dict_term (
  "id"        INTEGER PRIMARY KEY AUTOINCREMENT,
  "term"      TEXT NOT NULL UNIQUE,
  "category"  TEXT NOT NULL DEFAULT '',
  "synonyms"  TEXT NOT NULL DEFAULT '[]',
  "builtin"   INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 待确认的写操作（指导书第 2 节第 2 条）。
--
-- 为什么落库而不是放一个进程内的 Map —— 后者看着够用（单进程、单线程），
-- 但一次性兑换会有一个真实的竞态窗口：POST /api/duner/confirm 是异步的，
-- 校验 token 与标记已用之间隔着 await（要执行工具、要写库）。
-- 两个并发的同 token 请求可以双双通过校验。
-- 落库之后兑换就是一条 UPDATE ... WHERE token=? AND redeemed=0，
-- 拿 changes 当闸门：单条 SQL 内完成判定与置位，窗口不存在。
--
-- expires_at 存毫秒时间戳（不是文本）：判断过期要做数值比较，
-- 存 ISO 串就得在 SQL 里比字符串，跨时区/跨格式迟早出错。
--
-- ⚠️ 上面的注释里**不要出现反引号**。整段 SCHEMA 是一个 JS 模板字符串，
-- 一个反引号就会把它提前截断，报错是
-- 「SyntaxError: Unexpected identifier」指向注释里的某个英文单词 ——
-- 看起来像 SQL 写坏了，其实是被当成 JS 了。
CREATE TABLE IF NOT EXISTS pending_confirm (
  "token"      TEXT    PRIMARY KEY,
  "user_id"    INTEGER NOT NULL REFERENCES users("id"),
  "username"   TEXT    NOT NULL,
  "intent"     TEXT    NOT NULL,
  "payload"    TEXT    NOT NULL DEFAULT '{}',
  "created_at" INTEGER NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "redeemed"   INTEGER NOT NULL DEFAULT 0
);
`

// ---------------------------------------------------------------------------
// 值域常量
// ---------------------------------------------------------------------------
// ⚠️ 这几个常量**必须定义在 `RESOURCES` 之前**：`RESOURCES` 的初始化表达式
// 里直接引用了它们，而 `const` 有暂时性死区 —— 写在后面会让整个模块在
// import 的一瞬间就抛 `Cannot access 'X' before initialization`，
// 表现为「后端起不来但看不出是哪一行」。

/** 隐患状态机。写接口只认这三个值，别的一律当参数错误 */
export const HAZARD_STATUS = ['todo', 'doing', 'done']

/** 决策工单的紧急度 */
export const DECISION_LEVELS = ['high', 'mid', 'low']

/** 决策工单状态机。与隐患共用同一套三档语义，页面的 StatusTag 也认这三个值 */
export const ORDER_STATUS = ['todo', 'doing', 'done']

/**
 * 资源定义 —— 后端路由、种子脚本、自检脚本**共用这一份**。
 *
 * 三处各写一份的话，加一个字段就要改三个地方，漏一处不会报错、
 * 只会静默丢字段。所以这里是唯一事实来源。
 *
 * `fields` 用对象而不是数组，是为了同时携带类型；字符串键的对象
 * 保留书写顺序，拼 SQL 时列顺序稳定。
 */
export const RESOURCES = {
  'production/quality-records': {
    table: 'quality_records',
    label: '质检记录',
    key: 'id',
    autoKey: true,
    fields: { time: 'text', issue: 'text', action: 'text', owner: 'text' },
    /** 空值时拒绝创建 —— 这一列空了这条记录就没意义了 */
    required: ['time']
  },
  'production/duty-schedule': {
    table: 'duty_schedule',
    label: '值班与交接班',
    key: 'id',
    autoKey: true,
    fields: { shift: 'text', time: 'text', leader: 'text', crew: 'text', status: 'text' },
    required: ['shift']
  },
  'equipment/spare-parts': {
    table: 'spare_parts',
    label: '备件台账',
    key: 'code',
    /** 业务主键，由调用方给，不自增 */
    autoKey: false,
    fields: {
      code: 'text',
      name: 'text',
      device: 'text',
      inbound: 'int',
      outbound: 'int',
      stock: 'int',
      minStock: 'int',
      unit: 'text'
    },
    required: ['code', 'name']
  },
  'emergency/hazard-disposals': {
    table: 'hazard_disposals',
    label: '隐患处置',
    key: 'id',
    autoKey: true,
    fields: { type: 'text', location: 'text', status: 'text', statusText: 'text' },
    required: ['type']
  },
  /**
   * 决策工单 —— 由「决策指挥」页采纳一条建议后生成，之后可流转状态。
   *
   * `createdAt` **刻意不在 `fields` 里**：它由建表语句的 SQL DEFAULT 填。
   * 放进 fields 的话 `pickFields` 会老老实实把客户端传来的值写进去，
   * 而「工单什么时候建的」不该由前端说了算 —— 客户端时钟错一点就写错，
   * 更别说谁都能随手backdate。不进 fields ⇒ INSERT 语句里没这一列 ⇒ 走 DEFAULT。
   */
  'decision/orders': {
    table: 'decision_orders',
    label: '决策工单',
    key: 'id',
    autoKey: true,
    fields: {
      suggestion: 'text',
      content: 'text',
      level: 'text',
      owner: 'text',
      status: 'text',
      due: 'text'
    },
    required: ['suggestion', 'content'],
    enumFields: {
      level: { values: DECISION_LEVELS, fallback: 'mid' },
      status: { values: ORDER_STATUS, fallback: 'todo' }
    }
  }
}

/** 打开库并确保表结构就位。目录不存在就建（首次 clone 后 server/data 不存在） */
export function openDb(path = DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

// ---------------------------------------------------------------------------
// 字段取值与校验
// ---------------------------------------------------------------------------

/**
 * 按 `fields` 声明把请求体收敛成可入库的一行。
 *
 * 三条规则，都是为了「宁可报错也不静默写脏」：
 * 1. **只认声明过的字段**，请求体里多传的一律丢弃 —— 否则前端一个笔误
 *    (`tme` 而不是 `time`) 会静默写入空值，页面上看起来就是「保存了但没生效」；
 * 2. 整型列做数值收敛，非数字给 0 而不是字符串 `"abc"`；
 * 3. `required` 里声明的字段为空则抛 `FieldError`，由路由层翻成 400。
 *
 * @param partial 更新时只收敛传了的字段（PATCH 语义），创建时收敛全部
 */
export function pickFields(resource, body, { partial = false } = {}) {
  const src = body && typeof body === 'object' ? body : {}
  const out = {}

  for (const [name, type] of Object.entries(resource.fields)) {
    const present = Object.prototype.hasOwnProperty.call(src, name)
    if (partial && !present) continue

    const raw = src[name]
    if (type === 'int') {
      const n = Number(raw)
      out[name] = Number.isFinite(n) ? Math.trunc(n) : 0
    } else {
      out[name] = raw === undefined || raw === null ? '' : String(raw).trim()
    }
  }

  for (const name of resource.required) {
    // 更新时只校验**这次真的传了的**必填字段。
    // 传了空值照旧拒绝（不能把 time 清空），但压根没传说明本次不改它，
    // 该用库里的原值 —— 漏了这句就会出现「只改 action 却被 time 拦下」，
    // 页面表现为整张表单必须全填一遍才能保存，等于把 PATCH 又做成了 PUT。
    if (partial && !Object.prototype.hasOwnProperty.call(out, name)) continue

    const value = out[name]
    if (value === undefined || value === '' || value === null) {
      throw new FieldError(`字段 ${name} 不能为空`)
    }
  }

  /**
   * 值域校验 —— 只对声明了 `enumFields` 的资源生效。
   *
   * 为什么非要有这一层：这些列的值会被页面直接喂给 `StatusTag` 之类的组件
   * （`todo/doing/done` → 三种颜色标签）。放一个 `doingg` 进去不会报任何错，
   * 页面照常渲染，只是那一格的标签是**空白**的 —— 又是「不报错的错」。
   *
   * 空值退回该列的默认档而不是直接拒绝：非 partial 的创建会把所有声明过的
   * 字段都集合一遍，客户端没传的列这时就是空串，一律拒绝的话
   * 「只填建议正文就建单」会失败，而那正是页面最常用的调用方式。
   */
  for (const [name, rule] of Object.entries(resource.enumFields ?? {})) {
    if (partial && !Object.prototype.hasOwnProperty.call(out, name)) continue

    const raw = out[name]
    const value = raw ? raw : rule.fallback
    if (!rule.values.includes(value)) {
      throw new FieldError(`字段 ${name} 只能是 ${rule.values.join(' / ')}，收到「${raw}」`)
    }
    out[name] = value
  }

  if (partial && Object.keys(out).length === 0) {
    throw new FieldError('没有可更新的字段')
  }
  return out
}

/** 请求体不合法（缺必填、传了无意义的空更新）。路由层据此回 400 */
export class FieldError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FieldError'
  }
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

const q = (name) => `"${name}"`

export function listRows(db, resource) {
  return db.prepare(`SELECT * FROM ${q(resource.table)} ORDER BY ${q(resource.key)}`).all()
}

export function getRow(db, resource, keyValue) {
  return db.prepare(`SELECT * FROM ${q(resource.table)} WHERE ${q(resource.key)} = ?`).get(keyValue)
}

export function insertRow(db, resource, values) {
  const names = Object.keys(values)
  const sql =
    `INSERT INTO ${q(resource.table)} (${names.map(q).join(', ')}) ` +
    `VALUES (${names.map(() => '?').join(', ')})`
  const info = db.prepare(sql).run(...names.map((n) => values[n]))
  // lastInsertRowid 在 node:sqlite 里可能是 BigInt（视版本与取值而定），
  // 直接塞进 JSON 会抛「Do not know how to serialize a BigInt」，这里统一收成 number
  return getRow(db, resource, Number(info.lastInsertRowid)) ?? { ...values }
}

export function updateRow(db, resource, keyValue, values) {
  const names = Object.keys(values)
  const sql =
    `UPDATE ${q(resource.table)} SET ${names.map((n) => `${q(n)} = ?`).join(', ')} ` +
    `WHERE ${q(resource.key)} = ?`
  const info = db.prepare(sql).run(...names.map((n) => values[n]), keyValue)
  if (!info.changes) return null
  return getRow(db, resource, keyValue)
}

export function deleteRow(db, resource, keyValue) {
  const info = db
    .prepare(`DELETE FROM ${q(resource.table)} WHERE ${q(resource.key)} = ?`)
    .run(keyValue)
  return info.changes > 0
}

/** 各业务表条数 —— 顶栏「数据源」角标与 `/api/health` 都用它 */
export function tableCounts(db) {
  const counts = {}
  for (const resource of Object.values(RESOURCES)) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${q(resource.table)}`).get()
    counts[resource.table] = Number(row.n)
  }
  return counts
}

/** 写操作留痕。「谁在什么时候改了哪张表的哪一行」 */
export function logAudit(db, user, action, target, detail) {
  db.prepare(
    'INSERT INTO audit_log ("username", "role", "action", "target", "detail", "at") ' +
      'VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    user?.username ?? '(匿名)',
    user?.role ?? '-',
    action,
    target,
    typeof detail === 'string' ? detail : JSON.stringify(detail ?? ''),
    new Date().toISOString()
  )
}
