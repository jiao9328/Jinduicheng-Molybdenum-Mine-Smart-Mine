/**
 * 登录 / 角色权限 / 数据入库 巡检。
 *
 * 用法：node scripts/check-auth.mjs [baseUrl] [--self-test]
 *      默认 baseUrl = http://localhost:8787
 *
 * ## 这个脚本要证明的四件事
 *
 * 1. **没登录进不去**：匿名开 `#/` 必须落到 `#/login`；
 * 2. **权限由后端说了算**：匿名写 → 401，普通用户写 → 403。
 *    直连接口验，**不只看界面** —— 前端藏一个按钮不构成任何拦截
 *    （README §13 第 4 条立的规矩）；
 * 3. **写操作真的落库了**：新增一条 → 刷新页面 → 它还在。
 *    这一条是整套「入库」的命门：内存态、被吞掉的失败、前端自己造的假象，
 *    都能让前两条全绿而这套东西其实没写进任何地方；
 * 4. **四张表的条数与种子对得上**，且一次增删往返后回到原值。
 *
 * ## 为什么必须有「正向对照」
 *
 * 只断言「普通用户写会被 403」是不够的 —— **一个把所有写操作都拒绝的后端
 * 也能让这条全绿**，而那是个坏掉的系统。所以下面既验 403，也验管理员写
 * 得进去（201/200），并且验它真的改变了库里的状态。少了正向那一半，
 * 这个脚本会变成一具「永远绿的壳」，正是 README §13 第 23 条记的那类失效。
 *
 * ## --self-test
 *
 * 自证模式把几条**故意写错**的期望喂进同一批判据函数，要求它们全部报红。
 * 这样能证明「判据函数真的会返回 false」——一个恒返回 true 的判据
 * 和没写是一样的。
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { login, applySession, STORAGE_KEY, USER } from './lib/session.mjs'

const argv = process.argv.slice(2)
const SELF_TEST = argv.includes('--self-test')
const base = argv.find((a) => !a.startsWith('--')) || 'http://localhost:8787'

/** 种子基线（`scripts/seed-db.mjs` 灌的就是这些条数） */
const SEED_BASELINE = {
  quality_records: 6,
  duty_schedule: 3,
  spare_parts: 8,
  hazard_disposals: 4
}

// ---------------------------------------------------------------------------
// 判据（纯函数，`--self-test` 直接喂合成值）
// ---------------------------------------------------------------------------

/** 状态码判据。`实际 === 期望` —— 就这一条，不要放宽成「4xx 都算」 */
export function 判状态(实际, 期望, 说明) {
  return [`${说明}（期望 HTTP ${期望}，实为 ${实际 ?? '无响应'}）`, 实际 === 期望]
}

/** 条数判据：不低于种子基线。**用 ≥ 而不是 =**：演示时手工加过记录是合法状态 */
export function 判条数(实际, 基线, 表名) {
  const 合格 = typeof 实际 === 'number' && 实际 >= 基线
  return [`${表名}有 ${实际} 条（基线 ${基线}）`, 合格]
}

/** 相等判据（源码漂移、哈希落点这类） */
export function 判相等(实际, 期望, 说明) {
  return [`${说明}（实际 ${JSON.stringify(实际)}）`, 实际 === 期望]
}

// ---------------------------------------------------------------------------
// 源码漂移检查 —— 纯读文件，不需要浏览器
// ---------------------------------------------------------------------------
//
// 有几处字面量在前后端各写了一份（localStorage 的键、演示账号口令），
// 它们**必须一致但编译器管不着**：改了一边忘了另一边，后果是全部巡检脚本
// 挂在「找不到元素」上、或者登录页印的口令是错的。这里读源码比对，
// 是这套东西里唯一能防住它的地方。

function 源码检查() {
  const checks = []

  const store = readFileSync('src/stores/user.ts', 'utf8')
  const 前端键 = /const STORAGE_KEY = '([^']+)'/.exec(store)?.[1]
  checks.push(判相等(前端键, STORAGE_KEY, 'stores/user.ts 的 STORAGE_KEY 与 lib/session.mjs 一致'))

  const server = readFileSync('server/auth.mjs', 'utf8')
  const 服务端账号 = [...server.matchAll(/username: '([^']+)', password: '([^']+)'/g)].map(
    (m) => `${m[1]}/${m[2]}`
  )
  const loginView = readFileSync('src/views/LoginView.vue', 'utf8')
  const 页面账号 = [...loginView.matchAll(/username: '([^']+)', password: '([^']+)'/g)].map(
    (m) => `${m[1]}/${m[2]}`
  )
  checks.push(
    判相等(
      页面账号.join(','),
      服务端账号.join(','),
      '登录页印的演示账号与服务端 DEMO_ACCOUNTS 一致'
    )
  )
  // 至少得真的有两条，否则两边都空也能「相等」
  checks.push(判相等(服务端账号.length, 2, '服务端预置 2 个账号'))

  // 守卫是 fail-closed 的（除登录页外一律要求登录），`public: true` 是唯一的
  // 放行开关。**多出一个就是悄悄放出一个免登录页面** —— 这条要有东西守着
  const router = readFileSync('src/router/index.ts', 'utf8')
  const 放行数 = [...router.matchAll(/public:\s*true/g)].length
  checks.push(判相等(放行数, 1, 'router 里只有 1 条 public:true（即登录页）'))
  const 登录块 = /path: '\/login'[\s\S]{0,400}?public: true/.test(router)
  checks.push([`那条 public:true 就是登录页`, 登录块])

  return checks
}

// ---------------------------------------------------------------------------
// 接口层：匿名 / 普通用户 / 管理员
// ---------------------------------------------------------------------------

async function 调(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let payload = null
  try {
    payload = await res.json()
  } catch {
    // 204 / 空体，忽略
  }
  return { status: res.status, payload }
}

async function 接口检查(base) {
  const checks = []
  const 探针 = `校验探针-${Date.now()}`

  const 匿名 = await 调(base, 'GET', '/production/quality-records')
  checks.push(判状态(匿名.status, 401, '匿名读台账'))

  const 匿名写 = await 调(base, 'POST', '/production/quality-records', { body: { time: 探针 } })
  checks.push(判状态(匿名写.status, 401, '匿名新增台账'))

  const 普通 = (await login(base, USER)).token
  checks.push(判相等(typeof 普通, 'string', '普通用户登录拿得到令牌'))
  checks.push(判状态((await 调(base, 'GET', '/production/quality-records', { token: 普通 })).status, 200, '普通用户读台账'))

  for (const [method, path, 说明, body] of [
    ['POST', '/production/quality-records', '普通用户新增质检记录', { time: 探针 }],
    ['PUT', '/production/quality-records/1', '普通用户改质检记录', { issue: 探针 }],
    ['DELETE', '/production/quality-records/1', '普通用户删质检记录', undefined],
    ['POST', '/equipment/spare-parts', '普通用户新增备件', { code: 探针, name: 探针 }],
    ['PUT', '/emergency/hazards/1/status', '普通用户推进隐患状态', { status: 'done' }]
  ]) {
    const r = await 调(base, method, path, { token: 普通, body })
    checks.push(判状态(r.status, 403, 说明))
  }

  const 管理 = (await login(base)).token

  // ---- 正向对照：管理员必须写得进去 ----
  const 新增 = await 调(base, 'POST', '/production/quality-records', {
    token: 管理,
    body: { time: '2000-1-1 00:00', issue: 探针, action: '—', owner: '探**' }
  })
  checks.push(判状态(新增.status, 201, '管理员新增质检记录'))
  const 新id = 新增.payload?.id
  checks.push([`新增返回了主键 id（${新id}）`, Number.isInteger(Number(新id)) && 新id !== undefined])
  // 落库内容要能被独立读回来，且**字段没被改形**（中文/长文本原样）
  checks.push(判相等(新增.payload?.issue, 探针, '新增的 issue 原样返回（中文字节没被改）'))

  const 改 = await 调(base, 'PUT', `/production/quality-records/${新id}`, {
    token: 管理,
    body: { issue: `${探针}-已改` }
  })
  checks.push(判状态(改.status, 200, '管理员改质检记录'))
  checks.push(判相等(改.payload?.issue, `${探针}-已改`, '改完返回值里是新值'))
  // PATCH 语义：没传的字段必须原样保留，不能被清空
  checks.push(判相等(改.payload?.owner, '探**', '只改一个字段时其余字段未被清空'))

  // 校验类必须回 400 而不是 5xx —— 5xx 会被前端当成「后端坏了」而降级到 mock，
  // 那样界面显示成功、实际没写进去，是最坏的一种失败
  checks.push(判状态((await 调(base, 'POST', '/production/quality-records', { token: 管理, body: {} })).status, 400, '缺必填字段回 400（不是 5xx）'))
  checks.push(判状态((await 调(base, 'PUT', '/production/quality-records/abc', { token: 管理, body: { issue: 'x' } })).status, 400, '主键非整数回 400'))
  checks.push(判状态((await 调(base, 'DELETE', '/production/quality-records/999999', { token: 管理 })).status, 404, '删不存在的行回 404'))
  checks.push(判状态((await 调(base, 'POST', '/equipment/spare-parts', { token: 管理, body: { code: 'SP-1001', name: '重复' } })).status, 409, '备件编码重复回 409'))

  const 删 = await 调(base, 'DELETE', `/production/quality-records/${新id}`, { token: 管理 })
  checks.push(判状态(删.status, 200, '管理员删质检记录'))
  checks.push(判状态((await 调(base, 'DELETE', `/production/quality-records/${新id}`, { token: 管理 })).status, 404, '再删一次回 404（确实删掉了）'))

  // ---- 条数与基线 ----
  const health = await 调(base, 'GET', '/health')
  checks.push(判状态(health.status, 200, '健康检查（不要求登录）'))
  checks.push(判相等(health.payload?.ok, true, '健康检查报告 ok'))
  for (const [table, 基线] of Object.entries(SEED_BASELINE)) {
    checks.push(判条数(health.payload?.tables?.[table], 基线, table))
  }

  return checks
}

// ---------------------------------------------------------------------------
// 界面层：守卫、角色裁剪、刷新后仍在
// ---------------------------------------------------------------------------

async function 界面检查(base) {
  const checks = []
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  })
  // 不带 session 就是**匿名页** —— 登录页与守卫必须在这一档上验，
  // 带着会话去测「没登录会被弹走」是测不出来的
  async function 新页(session) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    if (session) await applySession(page, session)
    return page
  }

  try {
    // ---- 匿名 ----
    const 匿名页 = await 新页(null)
    await 匿名页.goto(`${base}/#/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await 匿名页.waitForTimeout(2500)
    const 匿名hash = await 匿名页.evaluate(() => location.hash)
    checks.push(判相等(匿名hash, '#/login', '匿名打开 #/ 落到登录页'))
    const 有登录卡片 = (await 匿名页.locator('.login__card').count()) > 0
    checks.push(['登录页渲染出登录卡片', 有登录卡片])
    await 匿名页.close()

    // ---- 普通用户 ----
    const 普通页 = await 新页(await login(base, USER))
    await 普通页.goto(`${base}/#/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await 普通页.waitForTimeout(3000)
    checks.push(判相等(await 普通页.evaluate(() => location.hash), '#/', '普通用户能进首页'))
    checks.push([
      '普通用户看不到「数据管理」入口',
      (await 普通页.locator('.app-header__user-btn', { hasText: '数据管理' }).count()) === 0
    ])
    checks.push([
      '普通用户看得到「退出」入口',
      (await 普通页.locator('.app-header__user-btn', { hasText: '退出' }).count()) > 0
    ])
    // 手敲地址闯一次 —— 这才是「守卫真的拦了」的验证，不是「按钮没了」
    await 普通页.evaluate(() => (location.hash = '#/data-admin'))
    await 普通页.waitForTimeout(1500)
    checks.push(判相等(await 普通页.evaluate(() => location.hash), '#/', '普通用户手敲 #/data-admin 被弹回首页'))

    // 应急救援页上那一个写操作（推进隐患状态）也必须对普通用户消失。
    // 它原先带 `v-permission.disable`，那套按钮级权限随登录体系删掉后就退化成了
    // 普通按钮 —— 界面在提供一个点下去必然 403 的操作。**这条要有东西守着**，
    // 否则下次重构又会悄悄退化回可见状态。（后端拦截由上面的 403 那几条兜着，
    // 这里量的是「界面裁剪跟后端规则一不一致」。）
    await 普通页.goto(`${base}/#/emergency`, { waitUntil: 'domcontentloaded', timeout: 90000 })
    // 等**隐患列表的行**，不是等 `.panel-box`：面板是静态骨架、很快就出来，
    // 而列表要等接口回来（软件渲染下主线程还忙着建三维场景）。
    // 等错了对象就会拿到 0 行 —— 那样「看不到按钮」也会绿，等于没验。
    // 等不到就继续往下走，由 `隐患行 > 0` 那条判红，而不是让整个界面段抛异常。
    await 普通页
      .waitForSelector('.emergency__hazard', { timeout: 60000 })
      .catch(() => {})
    const 隐患行 = await 普通页.locator('.emergency__hazard').count()
    const 推进按钮 = await 普通页.locator('.emergency__hazard-act').count()
    checks.push([`普通用户看得到隐患列表（${隐患行} 行）`, 隐患行 > 0])
    checks.push([`普通用户看不到「推进隐患状态」按钮（${推进按钮} 个）`, 隐患行 > 0 && 推进按钮 === 0])
    await 普通页.close()

    // ---- 管理员：界面 CRUD + 刷新仍在 ----
    const 管理页 = await 新页(await login(base))
    await 管理页.goto(`${base}/#/data-admin`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await 管理页.waitForSelector('.data-admin__tab', { timeout: 30000 })
    checks.push(判相等(await 管理页.evaluate(() => location.hash), '#/data-admin', '管理员进得去数据管理页'))

    const 行数 = () => 管理页.locator('.data-table .el-table__body tr').count()
    const 起始 = await 行数()
    checks.push([`质检记录表格渲染出 ${起始} 行`, 起始 > 0])
    checks.push([
      '页签条数与库一致（4 张表）',
      (await 管理页.locator('.data-admin__tab').count()) === 4
    ])

    // 界面新增
    const 标记 = `界面探针-${Date.now()}`
    await 管理页.locator('.data-admin__btn--primary', { hasText: '新增' }).click()
    await 管理页.waitForSelector('.app-modal', { timeout: 10000 })
    const 输入 = 管理页.locator('.app-modal input[type=text]')
    await 输入.first().fill('2000-2-2 00:00')
    await 输入.nth(1).fill(标记)
    await 管理页.locator('.app-modal .data-admin__btn--primary').click()
    await 管理页.waitForTimeout(2500)
    checks.push([`界面新增后 ${起始} → ${await 行数()} 行`, (await 行数()) === 起始 + 1])

    // **关键：刷新一次**。不刷新的话，页面上的行可能纯粹是前端内存里的
    // 乐观结果，根本没进库 —— 那样上面那条也会绿
    await 管理页.reload({ waitUntil: 'domcontentloaded' })
    await 管理页.waitForSelector('.data-admin__tab', { timeout: 30000 })
    await 管理页.waitForTimeout(1500)
    const 刷新后 = await 行数()
    const 有标记 = (await 管理页.locator('.data-table .el-table__body tr', { hasText: 标记 }).count()) > 0
    checks.push([`刷新后仍是 ${刷新后} 行`, 刷新后 === 起始 + 1])
    checks.push(['刷新后仍能看到刚新增的那条（真落库，不是内存态）', 有标记])

    // 界面删除，把状态还原
    const 目标行 = 管理页.locator('.data-table .el-table__body tr', { hasText: 标记 }).first()
    await 目标行.locator('.data-admin__row-btn', { hasText: '删除' }).click()
    await 管理页.waitForSelector('.data-admin__confirm-row', { timeout: 10000 })
    await 管理页.locator('.app-modal .data-admin__btn--danger').click()
    await 管理页.waitForTimeout(2500)
    checks.push([`界面删除后回到 ${await 行数()} 行`, (await 行数()) === 起始])

    // 校验失败要在浮层里看到**后端原文**
    await 管理页.locator('.data-admin__btn--primary', { hasText: '新增' }).click()
    await 管理页.waitForSelector('.app-modal', { timeout: 10000 })
    await 管理页.locator('.app-modal .data-admin__btn--primary').click()
    await 管理页.waitForTimeout(2000)
    const 错误文案 = (await 管理页.locator('.app-modal .data-admin__error').textContent().catch(() => '')) ?? ''
    checks.push([`缺必填时浮层显示后端文案（${JSON.stringify(错误文案)}）`, 错误文案.includes('不能为空')])
    checks.push(['校验失败后浮层不关闭（不假装保存成功）', (await 管理页.locator('.app-modal').count()) > 0])

    // ---- 正向对照：同一个按钮，管理员必须看得见 ----
    // 少了这一条，上面那句「普通用户看到 0 个」在**选择器过期、按钮压根不渲染**时
    // 也会绿 —— 那是本仓库记过的「恒真的死断言」（第 23、24 条）。
    // 必须有人量出「健康状态下它是存在的」。
    await 管理页.goto(`${base}/#/emergency`, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await 管理页
      .waitForSelector('.emergency__hazard-act', { timeout: 60000 })
      .catch(() => {})
    const 管理_推进按钮 = await 管理页.locator('.emergency__hazard-act').count()
    checks.push([`管理员看得到「推进隐患状态」按钮（${管理_推进按钮} 个）`, 管理_推进按钮 > 0])
    await 管理页.close()
  } finally {
    await browser.close()
  }

  return checks
}

// ---------------------------------------------------------------------------
// 自证：把故意写错的期望喂进同一批判据
// ---------------------------------------------------------------------------

function 自证检查() {
  const 结果 = []
  const 应为假 = [
    判状态(200, 403, '自证·匿名写却给了 200'),
    判状态(403, 200, '自证·管理员写却给了 403'),
    判条数(2, 6, '自证·条数低于基线'),
    判条数(undefined, 6, '自证·读不到表'),
    判相等('#/login', '#/', '自证·匿名没被弹走'),
    判相等('admin/admin123', 'admin/x', '自证·口令漂移没被发现')
  ]
  for (const [label, ok] of 应为假) {
    结果.push([`${label} —— 应报红`, ok === false])
  }
  // 反过来，正确的期望必须报绿，否则判据可能是个恒 false 的壳
  const 应为真 = [判状态(403, 403, '自证·正常的 403 判定'), 判条数(9, 6, '自证·条数达标')]
  for (const [label, ok] of 应为真) {
    结果.push([`${label} —— 应报绿`, ok === true])
  }
  return 结果
}

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------

let checks = []
if (SELF_TEST) {
  checks = 自证检查()
} else {
  checks.push(...源码检查())
  checks.push(...(await 接口检查(base)))
  checks.push(...(await 界面检查(base)))
}

console.log('='.repeat(64))
if (SELF_TEST) console.log('【自证模式】故意喂错值，下面应当**全部报红**（判据需自证会返回 false）')
for (const [label, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${label}`)

const 红 = checks.filter(([, ok]) => !ok)
console.log('='.repeat(64))
console.log(`${红.length ? '✗' : '✓'} ${checks.length - 红.length}/${checks.length} 项通过`)
process.exit(红.length ? 1 : 0)
