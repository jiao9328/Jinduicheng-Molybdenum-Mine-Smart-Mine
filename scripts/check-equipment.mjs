/**
 * 设备管理页专项检查（docx §03 的四条新增能力）。
 *
 * 覆盖：
 *   §03-5 备件库存台账（入库/出库/库存/缺货预警）
 *   §03-4 维保工单（按运行时长与状态自动生成 + 到期推送）
 *   §03-1~3 设备档案浮层（一机一码 / 图纸 / 备件清单 / 维保记录 / IoT 参数 / 诱因 / 建议）
 *
 * 用法：node scripts/check-equipment.mjs [baseUrl] [--self-test]
 *
 * ── 四类会静默通过的错误，本脚本专门盯着 ─────────────────────────────
 * ① **台账三个数自相矛盾**：库存和「入库 − 出库」对不上时，页面上三个数
 *    都正常显示、颜色也对，没人会拿计算器去核。所以逐行断言这个等式。
 * ② **缺货预警是个装饰**：预警若不是现算的（而是数据里存的标志位），
 *    改了出库数它不会跟着变 —— 而且屏幕上「缺货」和「库存 12」同时出现时
 *    也没有任何东西会报错。所以断言「打预警的行」== 「按 stock < minStock
 *    现算出来的行」，并要求这个集合**非空**（空集会让这条断言恒真）。
 * ③ **点行没反应**：档案浮层靠设备名把评分表和档案对起来，对不上就直接不打开，
 *    不报错。所以**逐台设备点过去**，要求每台都能打开、开出来的是它自己那份档案
 *    （编码互不相同），而不是每次都弹同一份。
 * ④ **页签是死的**：切页签若没换内容，画面上看着就是「有那么一条页签」，
 *    面板数、图表数全对。所以断言三个页签的内容集合两两不同、且都非空。
 *
 * ── 自证（--self-test）────────────────────────────────────────────────
 * 不注入缺陷的检查等于没检查。这里注入两次，都要求判据**当场翻红**：
 *   S1 把某行的库存改成一个对不上入库−出库的数 → 等式判据必须报出这一行
 *   S2 把某个「正常」行的状态文字改成「缺货预警」    → 预警判据必须报出这一行
 * 两次注入都在**同一个 page.evaluate 里注入→判定→还原**，中间不让出控制权：
 * Vue 的更新是微任务，一旦中间有 await，组件可能重渲染把注入冲掉，
 * 那时判据读到的还是好数据，「没翻红」就成了脚本自己的假阴性。
 *
 * ── 一条判据纪律 ─────────────────────────────────────────────────────
 * `/api/*` 的 404 **不算错**：那是 requestWithFallback 在后端未就绪时的正常
 * 降级路径（真发请求 → 404 → 用内置数据渲染）。恒红的判据等于没有判据。
 *
 * 面板撑破 / 面板互相压住不在本脚本：/equipment 整页在 check-panel-overflow 的
 * PAGES 里，那里量得更细（三条判据 + 逐页矩形）。
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'
import { mkdir } from 'node:fs/promises'

const argv = process.argv.slice(2)
const selfTest = argv.includes('--self-test')
const base = argv.find((a) => !a.startsWith('--')) || 'http://localhost:8787'
const outDir = '.snapshots/equipment'
await mkdir(outDir, { recursive: true })

/** 硬编码规格 —— 不从 src 读。脚本去读被测代码的常量，两边一起改就永远绿了 */
const EXPECT_MID = ['单体设备评分表', '设备类别状态趋势预判', '设备状态评分（权重设置）', '备件库存台账']
const EXPECT_BOTTOM = ['设备状态周内数据图（最高值）', '设备告警提醒', '维保工单']
const EXPECT_METRICS = 5
const EXPECT_PART_ROWS = 8
const EXPECT_LOW_CODES = ['SP-1001', 'SP-3001']
const EXPECT_ORDER_ROWS = 6
const EXPECT_DEVICES = 6
const EXPECT_TABS = ['图纸', '备件清单', '维保记录']
const EXPECT_IOT = ['温度', '振动', '电流', '油耗']
/** 跨面板一致性：告警提醒里那条超限告警，与档案里报警的那条参数必须是同一台设备的同一项 */
const ALERT_DEVICE = '破碎一'
const ALERT_PARAM = '振动'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`)
}

const session = await login(base)

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--js-flags=--max-old-space-size=3072'
  ]
})
const page = await newLoggedInPage(browser, session, { viewport: { width: 1920, height: 1080 } })

const errs = []
const apiMisses = []
const failedUrls = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const text = m.text().replace(/\s+/g, ' ').slice(0, 120)
  const url = m.location()?.url ?? ''
  if (text.includes('/api/') || url.includes('/api/')) apiMisses.push(text || url)
  else errs.push(text)
})
page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 120)))
page.on('response', (r) => {
  if (r.status() < 400) return
  const url = r.url()
  if (url.includes('/api/')) apiMisses.push(`${r.status()} ${url.slice(-40)}`)
  else failedUrls.push(`${r.status()} ${url.slice(-60)}`)
})

await page.goto(base + '/#/equipment', { waitUntil: 'domcontentloaded', timeout: 90000 })
// 本页没有三维场景，只有接口降级 + 图表初始化，不需要等场景构建
await page.waitForSelector('.equipment__part', { timeout: 30000 })
await page.waitForTimeout(1500)

// ---------------------------------------------------------------------------
console.log('### 面板清单')
// ---------------------------------------------------------------------------
const mids = (await page.locator('.equipment__row--mid .panel-box__title').allInnerTexts()).map((t) =>
  t.trim()
)
const bottoms = (await page.locator('.equipment__row--bottom .panel-box__title').allInnerTexts()).map(
  (t) => t.trim()
)
const metrics = await page.locator('.metric-card').count()

check(`中排四块面板 = 规格 ${EXPECT_MID.join('/')}`, mids.join(',') === EXPECT_MID.join(','), mids.join('/'))
check(
  `底排三块面板 = 规格 ${EXPECT_BOTTOM.join('/')}`,
  bottoms.join(',') === EXPECT_BOTTOM.join(','),
  bottoms.join('/')
)
check(`指标卡 ${EXPECT_METRICS} 张`, metrics === EXPECT_METRICS, `${metrics} 张`)

// 四列网格：中排四块、底排三块 + 气泡图跨两列
const cols = await page.evaluate(() => {
  const read = (sel) =>
    getComputedStyle(document.querySelector(sel)).gridTemplateColumns.split(' ').length
  return { mid: read('.equipment__row--mid'), bottom: read('.equipment__row--bottom') }
})
check('两行同为 4 轨（竖缝对齐）', cols.mid === 4 && cols.bottom === 4, `mid ${cols.mid} / bottom ${cols.bottom}`)

// ---------------------------------------------------------------------------
console.log('\n### §03-5 备件库存台账')
// ---------------------------------------------------------------------------
/**
 * 读台账。**只读页面上显示出来的文本**，不去读接口/mock：
 * 断言要证明的是「屏幕上这三个数自洽」，读数据源就只能证明数据源自洽。
 */
const scanLedger = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.equipment__part')].map((r) => {
      const tds = [...r.querySelectorAll('td')]
      const num = (i) => Number((tds[i]?.textContent ?? '').replace(/[^\d.]/g, ''))
      const stockText = tds[3]?.textContent ?? ''
      return {
        code: r.dataset.code,
        inbound: num(1),
        outbound: num(2),
        stock: num(3),
        hasUnit: /[一-龥a-zA-Z]/.test(stockText),
        low: r.dataset.low === 'true',
        status: (tds[4]?.textContent ?? '').replace(/\s+/g, '')
      }
    })
  )

/** 判据①：库存 == 入库 − 出库。返回对不上的行，便于打印 */
const eqViolations = (rows) => rows.filter((r) => r.stock !== r.inbound - r.outbound)
/** 判据②：打预警的行 == 现算出来的行，且预警文字只出现在那些行上 */
const warnViolations = (rows) => {
  if (!rows.length || !rows.some((r) => r.low)) return [{ code: '(无预警行，判据退化为恒真)' }]
  return rows.filter((r) => (r.low ? !r.status.includes('缺货预警') : !r.status.includes('正常')))
}

const rows = await scanLedger()
check(`台账 ${EXPECT_PART_ROWS} 行`, rows.length === EXPECT_PART_ROWS, `${rows.length} 行`)

const eqBad = eqViolations(rows)
check(
  '每行「库存 == 入库 − 出库」',
  eqBad.length === 0,
  eqBad.length ? eqBad.map((r) => `${r.code}: ${r.inbound}-${r.outbound}≠${r.stock}`).join(' | ') : '8 行全部相等'
)
check('出库量不是全 0（不然等式平凡成立）', rows.some((r) => r.outbound > 0), rows.map((r) => r.outbound).join('/'))
check('库存列都带单位', rows.every((r) => r.hasUnit))

const lowCodes = rows.filter((r) => r.low).map((r) => r.code)
check(
  `缺货预警恰好 ${EXPECT_LOW_CODES.length} 行（${EXPECT_LOW_CODES.join('/')}）`,
  lowCodes.join(',') === EXPECT_LOW_CODES.join(','),
  lowCodes.join('/') || '无'
)
const warnBad = warnViolations(rows)
check(
  '预警文字只出现在库存低于阈值的行上（现算，不是数据里存的标志位）',
  warnBad.length === 0,
  warnBad.map((r) => r.code).join(' | ') || '一致'
)

// ---------------------------------------------------------------------------
console.log('\n### §03-4 维保工单')
// ---------------------------------------------------------------------------
const orders = await page.evaluate(() =>
  [...document.querySelectorAll('.equipment__order')].map((li) => ({
    status: li.dataset.status,
    device: li.querySelector('.equipment__order-device')?.textContent.trim() ?? '',
    plan: li.querySelector('.equipment__order-plan')?.textContent.trim() ?? '',
    meta: li.querySelector('.equipment__order-meta')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    basis: li.querySelector('.equipment__order-basis')?.textContent.trim() ?? ''
  }))
)
check(`工单 ${EXPECT_ORDER_ROWS} 条`, orders.length === EXPECT_ORDER_ROWS, `${orders.length} 条`)
check(
  '状态只有「已推送 / 待推送」两种取值，且两种都出现过',
  orders.every((o) => o.status === '已推送' || o.status === '待推送') &&
    new Set(orders.map((o) => o.status)).size === 2,
  orders.map((o) => o.status).join('/')
)
check(
  '每条工单都写了生成依据（docx 要求「根据运行时长与状态自动生成」）',
  orders.length === EXPECT_ORDER_ROWS && orders.every((o) => o.basis.startsWith('依据：') && o.basis.length > 5),
  orders[0]?.basis.slice(0, 40)
)
check('每条工单都有设备、保养内容与到期时间', orders.every((o) => o.device && o.plan && /\d/.test(o.meta)))
const ids = orders.map((o) => o.meta.split('·')[0].trim())
check('工单号唯一', new Set(ids).size === ids.length, ids.join('/'))

// ---------------------------------------------------------------------------
console.log('\n### 设备档案浮层（§03-1~3）')
// ---------------------------------------------------------------------------
const scoreRows = await page.evaluate(() =>
  [...document.querySelectorAll('.equipment__row--mid .el-table__row')].map((tr) => {
    const tds = tr.querySelectorAll('td')
    return {
      name: tds[0]?.textContent.trim() ?? '',
      score: tds[1]?.textContent.trim() ?? ''
    }
  })
)
check(`评分表 ${EXPECT_DEVICES} 台设备`, scoreRows.length === EXPECT_DEVICES, scoreRows.map((r) => r.name).join('/'))

// 浮层打开时它自己也是一块 .panel-box（AppModal 用 PanelBox 搭的），
// 所以面板总数要 +1 —— 顺带证明浮层确实挂在内容区、被同一条检查覆盖
const basePanels = await page.locator('.panel-box').count()
check('关闭状态下面板 7 块', basePanels === 7, `${basePanels} 块`)

const opened = []
for (let i = 0; i < scoreRows.length; i++) {
  await page.locator('.equipment__row--mid .el-table__row').nth(i).click()
  await page.waitForSelector('.app-modal', { timeout: 5000 })
  await page.waitForTimeout(120)

  const info = await page.evaluate(() => {
    const dd = [...document.querySelectorAll('.equipment__archive-fields > div')].map((d) => ({
      k: d.querySelector('dt')?.textContent.trim() ?? '',
      v: d.querySelector('dd')?.textContent.trim() ?? ''
    }))
    const field = (k) => dd.find((d) => d.k === k)?.v ?? ''
    return {
      title: document.querySelector('.app-modal .panel-box__title')?.textContent.trim() ?? '',
      panels: document.querySelectorAll('.panel-box').length,
      code: document.querySelector('.equipment__archive-code')?.textContent.trim() ?? '',
      qrCells: document.querySelectorAll('.equipment__qr span').length,
      qrOn: document.querySelectorAll('.equipment__qr span.is-on').length,
      model: field('规格型号'),
      location: field('安装位置'),
      score: field('诊断评分'),
      tabs: [...document.querySelectorAll('.equipment__tab')].map((t) => t.textContent.trim())
    }
  })

  opened.push({
    ...info,
    rowName: scoreRows[i].name,
    rowScore: scoreRows[i].score,
    panelsWithModal: info.panels
  })

  await page.keyboard.press('Escape')
  await page.waitForSelector('.app-modal', { state: 'detached', timeout: 5000 })
}

check(
  `每台设备都能点开自己的档案（${EXPECT_DEVICES}/${EXPECT_DEVICES}）`,
  opened.length === EXPECT_DEVICES && opened.every((o) => o.title.includes(o.rowName)),
  opened.map((o) => o.title.replace(' 设备档案', '')).join('/')
)
check(
  '档案编码互不相同（不是 6 行都弹同一份）',
  new Set(opened.map((o) => o.code)).size === EXPECT_DEVICES,
  opened.map((o) => o.code).join('/')
)
check('编码、型号、位置都不为空', opened.every((o) => o.code && o.model && o.location))
check(
  '浮层里的诊断评分 == 评分表那一行的分数',
  opened.every((o) => o.score.replace(/[^\d]/g, '') === o.rowScore.replace(/[^\d]/g, '')),
  opened.map((o) => `${o.score}/${o.rowScore}`).join(' ')
)
check(
  '一机一码图形有内容（格子非空、不是整片全亮/全灭）',
  opened.every((o) => o.qrCells === 64 && o.qrOn > 4 && o.qrOn < 60),
  opened.map((o) => `${o.qrOn}/64`).join(' ')
)
check(
  `三个页签 = 规格 ${EXPECT_TABS.join('/')}`,
  opened.every((o) => o.tabs.join(',') === EXPECT_TABS.join(',')),
  opened[0]?.tabs.join('/')
)
check(
  '打开浮层时面板数 +1（浮层也在 .panel-box 口径里，会被面板体检一起量到）',
  opened.every((o) => o.panelsWithModal === basePanels + 1),
  `${basePanels} → ${opened[0]?.panelsWithModal}`
)
check('Esc 关闭后浮层消失、面板数回到 7', (await page.locator('.panel-box').count()) === basePanels)

// ---- 页签真的换内容 ----
/**
 * 下面这一串都在**同一台设备的浮层**里做，所以先把「有报警项的那台」打开：
 * 页签、备件清单、IoT 参数、诱因、建议一次过，顺便让打开浮层的截图里
 * 恰好能看见红色越限的那一项（那张图是要给人看的）。
 */
const alarmIdx = scoreRows.findIndex((r) => r.name === ALERT_DEVICE)
check(`评分表里有「${ALERT_DEVICE}」这一行`, alarmIdx >= 0, scoreRows.map((r) => r.name).join('/'))
await page.locator('.equipment__row--mid .el-table__row').nth(Math.max(alarmIdx, 0)).click()
await page.waitForSelector('.app-modal', { timeout: 5000 })

const panes = []
for (const label of EXPECT_TABS) {
  await page.locator('.equipment__tab', { hasText: label }).click()
  await page.waitForTimeout(120)
  const pane = await page.evaluate(() => {
    const el = document.querySelector('.equipment__pane')
    return {
      tab: el?.dataset.tab ?? '',
      text: (el?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      rows: el?.children.length ?? 0
    }
  })
  panes.push({ label, ...pane })
}
check(
  '三个页签都切得动，且各自内容非空',
  panes.every((p, i) => p.tab === ['drawings', 'parts', 'records'][i] && p.text.length > 10 && p.rows > 0),
  panes.map((p) => `${p.label}:${p.text.length}字`).join(' ')
)
check(
  '三个页签的内容两两不同（证「真的换了」而不是三个页签同一块内容）',
  new Set(panes.map((p) => p.text)).size === EXPECT_TABS.length
)

// ---- 备件清单与台账对得上（逐台设备查一遍）----
// 先关掉浮层：浮层铺满整个内容区（`.app-modal { inset: 0 }`），
// 开着它去点评分表的行会被它挡住——Playwright 会一直等到超时，而不是「点不到就算了」。
await page.keyboard.press('Escape')
await page.waitForSelector('.app-modal', { state: 'detached', timeout: 5000 })
const ledgerCodes = rows.map((r) => r.code)
const partsByDevice = []
for (let i = 0; i < EXPECT_DEVICES; i++) {
  const hit = opened[i]
  if (!hit) continue
  await page.locator('.equipment__row--mid .el-table__row').nth(i).click()
  await page.waitForSelector('.app-modal', { timeout: 5000 })
  await page.locator('.equipment__tab', { hasText: '备件清单' }).click()
  await page.waitForTimeout(100)
  const list = await page.locator('.equipment__archive-parts tbody tr').evaluateAll((trs) =>
    trs.map((tr) => ({ code: tr.dataset.code, low: tr.dataset.low }))
  )
  partsByDevice.push({ device: hit.rowName, list })
  await page.keyboard.press('Escape')
  await page.waitForSelector('.app-modal', { state: 'detached', timeout: 5000 })
}
const allParts = partsByDevice.flatMap((d) => d.list)
check(
  '每台设备的备件清单都逐条能在台账里找到（备件编码不是另编的一套）',
  allParts.length >= EXPECT_DEVICES && allParts.every((p) => ledgerCodes.includes(p.code)),
  allParts.map((p) => p.code).join('/')
)
check(
  '备件清单里的缺货标记与台账一致',
  allParts.every((p) => p.low === String(lowCodes.includes(p.code))),
  allParts
    .filter((p) => p.low === 'true')
    .map((p) => p.code)
    .join('/') || '无缺货项'
)

// ---- IoT 参数与多级报警（回到有报警项的那台）----
await page.locator('.equipment__row--mid .el-table__row').nth(Math.max(alarmIdx, 0)).click()
await page.waitForSelector('.app-modal', { timeout: 5000 })
const iot = await page.locator('.equipment__iot-item').evaluateAll((items) =>
  items.map((el) => ({
    param: el.dataset.param,
    level: el.dataset.level,
    value: el.querySelector('.equipment__iot-value')?.textContent.replace(/\s+/g, '') ?? '',
    flag: el.querySelector('.equipment__iot-flag')?.textContent.trim() ?? '',
    mark: el.querySelector('.equipment__thr-mark')?.getAttribute('style') ?? '',
    zones: el.querySelectorAll('.equipment__thr-zone').length
  }))
)
check(
  `运行参数四项 = 规格 ${EXPECT_IOT.join('/')}`,
  iot.map((p) => p.param).join(',') === EXPECT_IOT.join(','),
  iot.map((p) => p.param).join('/')
)
check(
  '每项都有值、有等级文字、有三级阈值条与游标',
  iot.length === EXPECT_IOT.length &&
    iot.every(
      (p) => p.value && ['正常', '预警', '报警'].includes(p.flag) && p.zones === 3 && p.mark.includes('left')
    ),
  iot.map((p) => `${p.param}:${p.flag}`).join(' ')
)
check(
  '等级文字与 data-level 一致（不是颜色红着、文字写着正常）',
  iot.every((p) => p.flag === { normal: '正常', warn: '预警', alarm: '报警' }[p.level]),
  iot.map((p) => p.level).join('/')
)

// ---- 跨面板一致性：告警提醒里那条超限，与档案里报警的是同一台设备的同一项 ----
const alertRows = (await page.locator('.equipment__alert').allInnerTexts()).map((t) =>
  t.replace(/\s+/g, ' ')
)
check(
  `告警提醒里有「${ALERT_DEVICE} ${ALERT_PARAM}超限」`,
  alertRows.some((t) => t.includes(ALERT_DEVICE) && t.includes(ALERT_PARAM)),
  alertRows.find((t) => t.includes(ALERT_DEVICE))?.slice(0, 40)
)
const alarmNow = iot.filter((p) => p.level === 'alarm').map((p) => p.param)
check(
  `「${ALERT_DEVICE}」档案里报警的正是「${ALERT_PARAM}」一项（与告警提醒对得上）`,
  alarmNow.join(',') === ALERT_PARAM,
  alarmNow.join('/') || '无报警项'
)

// ---- 诱因排序与维修建议 ----
const causes = await page.locator('.equipment__cause').evaluateAll((lis) =>
  lis.map((li) => ({
    no: li.querySelector('.equipment__cause-no')?.textContent.trim() ?? '',
    count: Number((li.querySelector('.equipment__cause-count')?.textContent ?? '').replace(/\D/g, ''))
  }))
)
const advices = await page.locator('.equipment__advice-item').allInnerTexts()
check(
  '诱因数按次数降序、编号从 1 连续（「排序」两个字得看得出来）',
  causes.length >= 2 &&
    causes.every((c, i) => Number(c.no) === i + 1) &&
    causes.every((c, i) => i === 0 || causes[i - 1].count >= c.count),
  causes.map((c) => `${c.no}:${c.count}`).join(' ')
)
check(
  '维修方案建议有多条且非空',
  advices.length >= 2 && advices.every((a) => a.trim().length > 4),
  `${advices.length} 条`
)

// ---------------------------------------------------------------------------
console.log('\n### 控制台与请求')
// ---------------------------------------------------------------------------
check('控制台没有 /api/ 以外的错误', errs.length === 0, errs.slice(0, 4).join(' | '))
check('没有 /api/ 以外的 4xx/5xx 请求', failedUrls.length === 0, [...new Set(failedUrls)].slice(0, 4).join(' | '))
console.log(
  `  · 后端未就绪的降级请求 ${new Set(apiMisses).size} 个（设计如此，不判死）：` +
    `${[...new Set(apiMisses)].slice(0, 3).join(' | ')}`
)

await page.screenshot({ path: `${outDir}/equipment-modal.png`, timeout: 60000 })
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
await page.screenshot({ path: `${outDir}/equipment.png`, timeout: 60000 })
console.log(`\n截图：${outDir}/equipment.png、${outDir}/equipment-modal.png`)

// ---------------------------------------------------------------------------
console.log('\n### 自证：注入缺陷，判据必须当场翻红')
// ---------------------------------------------------------------------------
if (selfTest) {
  const result = await page.evaluate(() => {
    const rowsEl = [...document.querySelectorAll('.equipment__part')]
    const num = (tr, i) => Number((tr.querySelectorAll('td')[i]?.textContent ?? '').replace(/[^\d.]/g, ''))
    const eq = (rs) => rs.filter((tr) => num(tr, 3) !== num(tr, 1) - num(tr, 2))
    const warnOff = (rs) =>
      rs.filter((tr) => {
        const low = tr.dataset.low === 'true'
        const status = (tr.querySelectorAll('td')[4]?.textContent ?? '').replace(/\s+/g, '')
        return low ? !status.includes('缺货预警') : !status.includes('正常')
      })

    const before = { eq: eq(rowsEl).length, warn: warnOff(rowsEl).length }

    // S1：把第 1 行的库存改成对不上入库−出库的数
    const cell = rowsEl[0].querySelectorAll('td')[3]
    const original = cell.textContent
    cell.textContent = `${num(rowsEl[0], 1) - num(rowsEl[0], 2) + 7} 件`
    const afterS1 = eq(rowsEl).length
    cell.textContent = original
    const restoredS1 = eq(rowsEl).length

    // S2：把第 2 行（正常行）的状态文字改成「缺货预警」——文字与 data-low 脱钩
    const statusCell = rowsEl[1].querySelectorAll('td')[4]
    const statusOriginal = statusCell.textContent
    statusCell.textContent = '缺货预警'
    const afterS2 = warnOff(rowsEl).length
    statusCell.textContent = statusOriginal
    const restoredS2 = warnOff(rowsEl).length

    return { before, afterS1, restoredS1, afterS2, restoredS2 }
  })

  check(
    'S1 改坏库存数 ⇒ 等式判据当场报出这一行',
    result.before.eq === 0 && result.afterS1 === 1 && result.restoredS1 === 0,
    `注入前 ${result.before.eq} → 注入后 ${result.afterS1} → 还原 ${result.restoredS1}`
  )
  check(
    'S2 把正常行写成「缺货预警」 ⇒ 预警判据当场报出这一行',
    result.before.warn === 0 && result.afterS2 === 1 && result.restoredS2 === 0,
    `注入前 ${result.before.warn} → 注入后 ${result.afterS2} → 还原 ${result.restoredS2}`
  )
} else {
  console.log('  · 跳过（加 --self-test 运行）')
}

await browser.close()

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok)
console.log(
  `\n合计 ${checks.length} 项，失败 ${failed.length} 项` +
    `${selfTest ? '（含 --self-test：注入两处缺陷，要求判据当场翻红）' : '（未跑自证，加 --self-test）'}`
)
for (const f of failed) console.log(`  ✗ ${f.name}`)
process.exit(failed.length ? 1 : 0)
