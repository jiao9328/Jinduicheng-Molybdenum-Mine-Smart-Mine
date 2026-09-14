/**
 * 应急救援页专项检查。
 *
 * 覆盖两部分：
 *   A. **三维图层与工具栏**（原有内容）——实体建全了没有、五个按钮是不是真的起作用。
 *   B. **docx §7.2 的四块新能力**——预案匹配与操作指引浮层、一键指令下发的状态机、
 *      最优调配方案、多源画面占位。
 *
 * 用法：node scripts/check-emergency.mjs [baseUrl] [--self-test]
 *
 * ── 为什么这个脚本要重写 ──────────────────────────────────────────────
 * 上一版是个**倾倒器**：所有「检查」都是 `console.log(JSON.stringify(...))`，
 * 一句断言都没有，也**没有 `process.exit`** —— 页面白屏、面板少一块、
 * 按钮点了没反应，它都会照样打印一堆 JSON 然后以退出码 0 结束。
 * 也就是说它在 CI 里永远是绿的。现在每一项都是断言 + 退出码。
 *
 * ── 两类会静默通过的错误，本脚本专门盯着 ──────────────────────────────
 * ① **状态机一次到位**：一键下发如果瞬间把所有通道置成 100%，
 *    画面上只是闪一下，而下发「完成」本身是**正确的终态** ——
 *    只在结尾断言「全部送达」的实现永远看不出这个区别。
 *    所以判据必须落在**过程中的中间态**上（见下面「立刻读」那一对）。
 * ② **环形图点不动**：环形图的类型名与预案的 `type` 对不上时，
 *    点扇区什么都不发生，且不报任何错。这里逐个扇区点过去，
 *    要求**四个扇区都能弹出对应预案** —— 只要有一个是死点就红。
 *
 * ── 一条判据纪律 ─────────────────────────────────────────────────────
 * `/api/*` 的 404 **不算错**：那是 `requestWithFallback` 在后端未就绪时的正常
 * 降级路径（真的发一次请求 → 404 → 用内置数据渲染）。把它判红，这条判据就永远红，
 * 而恒红的判据等于没有判据。所以 `/api/` 的失败只计数打印，其余照旧判死。
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const argv = process.argv.slice(2)
const selfTest = argv.includes('--self-test')
const base = argv.find((a) => !a.startsWith('--')) || 'http://localhost:4173'
const outDir = '.snapshots/emergency'
await mkdir(outDir, { recursive: true })

/** 硬编码规格 —— 不从 src 读。脚本去读被测代码的常量，两边一起改就永远绿了 */
const EXPECT_CHIPS = ['边坡滑坡', '爆破事故', '运输故障', '水害隐患']
const EXPECT_PLANS = [
  '边坡滑坡事故专项应急预案',
  '爆破事故专项应急预案',
  '运输事故专项应急预案',
  '坑底积水（透水）专项应急预案'
]
const EXPECT_DISPATCH_HEADS = ['队伍 / 物资', '来源', '目的地', '到场']
const EXPECT_VIDEO_CELLS = 3
/** 环形图配色板：扇区中点算点击坐标用（与 mock 里的占比一致，和是 98） */
const PIE_SLICES = [43.46, 27.27, 18.18, 9.09]

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`)
}

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--js-flags=--max-old-space-size=3072'
  ]
})
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
/**
 * 控制台错误与失败请求 —— 但 `/api/*` 的 404 **是设计的一部分**，不算错。
 *
 * 后端未就绪时 `requestWithFallback` 会真的发一次请求、拿到 404、再用内置数据
 * 降级渲染。所以浏览器控制台必然出现「Failed to load resource ... 404」，
 * 且它**不带 URL 文本**（URL 在 `location()` 里）。
 * 把它们一并算成错误，这条判据就会永远红 —— 而一条恒红的判据等于没有判据，
 * 下次真的少了张图片、少了个 chunk，也没人会看它。
 * 所以：`/api/` 的失败**计数、打印**，但不判死；其余任何 4xx/5xx 与任何
 * 非 `/api/` 的控制台错误，照旧判死。
 */
const errs = []
const apiMisses = []
const failedUrls = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const url = m.location()?.url ?? ''
  if (url.includes('/api/')) {
    apiMisses.push(url.slice(-60))
    return
  }
  errs.push(m.text().replace(/\s+/g, ' ').slice(0, 130))
})
page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 130)))
page.on('response', (r) => {
  if (r.status() < 400) return
  const line = `${r.status()} ${r.url().slice(-70)}`
  if (r.url().includes('/api/')) apiMisses.push(line)
  else failedUrls.push(line)
})

// 本平台没有登录，直接进页面（登录 + 权限体系已移除，见 README §13）
await page.goto(base + '/#/emergency', { waitUntil: 'domcontentloaded', timeout: 90000 })

// 等三维底座 + 业务图层都建出来。上一版是盲等 40s —— 快了会在场景没建好时
// 就开始断言（红得莫名其妙），慢了白等。等条件比等时间靠谱。
await page.waitForFunction(() => !!window.__cesiumViewer, null, { timeout: 240000 })
await page.waitForFunction(
  () => {
    const v = window.__cesiumViewer?.entities?.values
    if (!v) return false
    const ids = v.map((e) => String(e.id))
    return (
      ids.some((i) => i.startsWith('person-')) &&
      ids.some((i) => i.startsWith('station-ring-')) &&
      ids.some((i) => i.startsWith('route-base-'))
    )
  },
  null,
  { timeout: 240000 }
)
// 面板数据也到位（异步 mock/接口），否则下面的行数、chip 数会读到空
await page.waitForFunction(
  () =>
    document.querySelectorAll('.emergency__chip').length >= 4 &&
    document.querySelectorAll('.emergency__dispatch tbody tr').length >= 4,
  null,
  { timeout: 120000 }
)
// 地形采样是异步的，建完之后再让它稳定一会儿
await page.waitForTimeout(6000)

console.log('### 实体与工具栏')

const stats = await page.evaluate(() => {
  const v = window.__cesiumViewer
  if (!v) return { err: '无 __cesiumViewer' }
  const groups = {}
  const all = [...v.entities.values]
  for (const e of all) {
    const id = String(e.id)
    const prefix = id.startsWith('route-flow-')
      ? 'route-flow'
      : id.startsWith('route-base-')
        ? 'route-base'
        : id.startsWith('person-')
          ? 'person'
          : id.startsWith('station-ring-')
            ? 'station-ring'
            : id.startsWith('station-')
              ? 'station'
              : id.startsWith('track-')
                ? 'track'
                : id.split('-')[0]
    groups[prefix] = groups[prefix] || { total: 0, shown: 0 }
    groups[prefix].total++
    if (e.show) groups[prefix].shown++
  }
  return { groups, totalEntities: all.length }
})

for (const [key, label] of [
  ['person', '作业人员定位'],
  ['station-ring', '基站覆盖圈'],
  ['station', '定位基站'],
  ['track', '人员当日轨迹'],
  ['route-base', '撤离路线'],
  ['route-flow', '路线流动光带']
]) {
  const g = stats.groups?.[key]
  check(`图层「${label}」建出来了（${key}-*）`, !!g && g.total > 0, g ? `${g.total} 个实体` : '一个都没有')
}

/**
 * 基站覆盖圈曾经**两个独立的、各自致命的原因**同时导致它从来没被渲染出来
 * （缺 position + 贴地几何只画轮廓），而两条都不报错。
 * check-twin-layers.mjs 里管这条规则；这里只做一条便宜的定点复检：
 * 有 ellipse 就必须有 position。
 */
const ringBroken = await page.evaluate(() => {
  const v = window.__cesiumViewer
  const bad = []
  for (const e of v.entities.values) {
    if (!String(e.id).startsWith('station-ring-')) continue
    if (e.ellipse && !e.position) bad.push(String(e.id))
  }
  return bad
})
check('基站覆盖圈都有 position（缺了会被 Cesium 静默丢弃）', ringBroken.length === 0, ringBroken.join(','))

const takeStats = () =>
  page.evaluate(() => {
    const v = window.__cesiumViewer
    const out = {}
    for (const e of v.entities.values) {
      const id = String(e.id)
      const k = id.startsWith('person-')
        ? 'person'
        : id.startsWith('station-ring-') || id.startsWith('station-')
          ? 'station'
          : id.startsWith('track-')
            ? 'track'
            : id.startsWith('route-')
              ? 'route'
              : null
      if (!k) continue
      out[k] = out[k] || { total: 0, shown: 0 }
      out[k].total++
      if (e.show) out[k].shown++
    }
    return out
  })

const clickTool = async (label) => {
  await page.locator('.emergency__tool', { hasText: label }).click()
  await page.waitForTimeout(900)
}

// 每个按钮点一下应当只影响它自己那一组：该组 shown 归零，其余组不变
for (const [label, key] of [
  ['人员', 'person'],
  ['基站', 'station'],
  ['轨迹', 'track']
]) {
  const before = await takeStats()
  await clickTool(label)
  const off = await takeStats()
  await clickTool(label)
  const back = await takeStats()

  const others = Object.keys(before).filter((k) => k !== key)
  check(
    `「${label}」按钮把「${key}」图层关掉又打开`,
    off[key]?.shown === 0 && back[key]?.shown === before[key]?.shown && before[key]?.shown > 0,
    `关 ${before[key]?.shown}→${off[key]?.shown}，开 →${back[key]?.shown}`
  )
  // 只动自己那一组 —— 按钮关错图层（比如点「人员」把轨迹关了）不报任何错
  check(
    `「${label}」按钮没有连带关掉别的图层`,
    others.every((k) => off[k].shown === before[k].shown)
  )
}

const panelBefore = await page.locator('.emergency__layers').count()
await clickTool('图层')
const panelAfter = await page.locator('.emergency__layers').count()
await clickTool('图层')
const panelRestored = await page.locator('.emergency__layers').count()
check(
  '「图层」按钮开合图层数据面板',
  panelBefore === 1 && panelAfter === 0 && panelRestored === 1,
  `${panelBefore} → ${panelAfter} → ${panelRestored}`
)

const checkboxCount = await page.locator('.emergency__layer-item input').count()
const layerNames = await page.locator('.emergency__layer-name').allInnerTexts()
check('图层面板条目数 = 3 条撤离路线 + 人员/基站/轨迹', checkboxCount === 6, `${checkboxCount} 条`)

/**
 * 勾选框是**逐条**的：取消第一条只该关掉那一条（base + flow 两个实体），
 * 其余两条路线不受影响。断言写成「整组归零」是错的 ——
 * 那会要求取消一条就隐藏三条，而一个「关一条」的正确实现会被判红。
 * 所以按 id 精确点名，顺便证明它没有连坐别的路线。
 */
const FIRST_ROUTE = 'landslide'
await page.locator('.emergency__layer-item input').first().uncheck()
await page.waitForTimeout(900)
const routeShow = await page.evaluate((k) => {
  const v = window.__cesiumViewer
  const out = {}
  for (const e of v.entities.values) {
    const id = String(e.id)
    if (id.startsWith('route-base-') || id.startsWith('route-flow-')) {
      out[id.replace(/^route-(base|flow)-/, '') + (id.startsWith('route-flow-') ? '/flow' : '/base')] = e.show
    }
  }
  return out
}, FIRST_ROUTE)
await page.locator('.emergency__layer-item input').first().check()
await page.waitForTimeout(900)
check(
  `取消勾选「${FIRST_ROUTE}」只关掉这一条（base + flow），其余路线不动`,
  routeShow[`${FIRST_ROUTE}/base`] === false &&
    routeShow[`${FIRST_ROUTE}/flow`] === false &&
    Object.entries(routeShow).every(([k, v]) => k.startsWith(FIRST_ROUTE) || v === true),
  JSON.stringify(routeShow)
)

const camBefore = await page.evaluate(() => {
  const c = window.__cesiumViewer.camera
  return {
    lon: +c.positionCartographic.longitude.toFixed(6),
    lat: +c.positionCartographic.latitude.toFixed(6),
    h: Math.round(c.positionCartographic.height)
  }
})
await clickTool('定位')
await page.waitForTimeout(6000)
const camAfter = await page.evaluate(() => {
  const c = window.__cesiumViewer.camera
  return {
    lon: +c.positionCartographic.longitude.toFixed(6),
    lat: +c.positionCartographic.latitude.toFixed(6),
    h: Math.round(c.positionCartographic.height)
  }
})
check(
  '「定位」按钮把相机飞到作业人员点位',
  camBefore.lon !== camAfter.lon || camBefore.lat !== camAfter.lat,
  `lon ${camBefore.lon}→${camAfter.lon}`
)
await clickTool('定位')
await page.waitForTimeout(4000)

check(
  '救援资源面板有队伍与物资',
  (await page.locator('.emergency__rescue-row').count()) >= 5,
  `${await page.locator('.emergency__rescue-row').count()} 行`
)

// ---------------------------------------------------------------------------
console.log('\n### §7.2-1 应急预案匹配 + 操作指引浮层')
// ---------------------------------------------------------------------------

const chips = await page.locator('.emergency__chip').allInnerTexts()
const chipTexts = chips.map((t) => t.trim())
check(
  `灾害类型 chip = 硬编码规格 ${EXPECT_CHIPS.join('/')}`,
  chipTexts.join(',') === EXPECT_CHIPS.join(','),
  chipTexts.join('/')
)

const guideBtn = page.locator('.emergency__plans .emergency__btn')
check('未选类型时「查看操作指引」是禁用的', await guideBtn.isDisabled())

await page.locator('.emergency__chip', { hasText: '爆破事故' }).click()
check(
  '点 chip ⇒ 匹配结果换成对应预案',
  (await page.locator('.emergency__match-name').innerText()).trim() === EXPECT_PLANS[1],
  (await page.locator('.emergency__match-name').innerText()).trim()
)

await guideBtn.click()
await page.waitForSelector('.app-modal', { timeout: 5000 })
const modalSteps = await page.locator('.emergency__guide-step').count()
const modalTitle = (await page.locator('.app-modal .panel-box__title').innerText()).trim()
check('点「查看操作指引」弹出浮层，标题即预案名', modalTitle === EXPECT_PLANS[1], modalTitle)
check('浮层里逐条列出操作指引', modalSteps === 5, `${modalSteps} 步`)

await page.keyboard.press('Escape')
await page.waitForTimeout(400)
check('Esc 关闭浮层', (await page.locator('.app-modal').count()) === 0)

/**
 * 环形图扇区 ⇒ 预案。
 *
 * 逐个扇区点过去：**四个都要能弹出来**。这是本页唯一能证明
 * 「环形图的类型名与预案的 type 是对得上的」的办法 ——
 * 名字对不上的那些扇区是死点，画面上什么都不发生、控制台也不报错。
 * 点击坐标按 ECharts 的饼图几何算（startAngle 90、顺时针、
 * radius ['46%','68%']、center ['50%','44%']），不靠肉眼看图猜位置。
 */
const donut = await page.locator('.emergency__donut .echart-box').boundingBox()
check(
  '环形图容器有非零尺寸（0 高的话图根本没渲染，也就点不到）',
  !!donut && donut.height > 40,
  donut ? `${Math.round(donut.width)}×${Math.round(donut.height)}` : '量不到'
)

const total = PIE_SLICES.reduce((a, b) => a + b, 0)
const pointAt = (frac) => {
  const r = 0.57 * (Math.min(donut.width, donut.height) / 2)
  const theta = frac * 2 * Math.PI
  return {
    x: donut.x + donut.width * 0.5 + r * Math.sin(theta),
    y: donut.y + donut.height * 0.44 - r * Math.cos(theta)
  }
}
let cum = 0
for (let i = 0; i < PIE_SLICES.length; i++) {
  const mid = (cum + PIE_SLICES[i] / 2) / total
  cum += PIE_SLICES[i]
  const p = pointAt(mid)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(500)
  const open = (await page.locator('.app-modal').count()) === 1
  const title = open ? (await page.locator('.app-modal .panel-box__title').innerText()).trim() : ''
  check(
    `点环形图「${EXPECT_CHIPS[i]}」扇区弹出对应预案`,
    open && title === EXPECT_PLANS[i],
    open ? title : '没弹出（扇区是死点）'
  )
  if (open) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
}

// ---------------------------------------------------------------------------
console.log('\n### §7.2-5 一键指令下发')
// ---------------------------------------------------------------------------

/** 读 DOM 上的 data-*，不碰组件内部状态 */
const readCmd = () =>
  page.evaluate(() => {
    const root = document.querySelector('.emergency__cmd')
    if (!root) return null
    const items = [...root.querySelectorAll('.emergency__channel')]
    return {
      state: root.getAttribute('data-state'),
      acked: items.map((el) => Number(el.getAttribute('data-acked'))),
      totals: items.map((el) => Number(el.getAttribute('data-total'))),
      names: items.map((el) => el.querySelector('.emergency__channel-name').textContent.trim()),
      disabled: root.querySelector('.emergency__btn')?.disabled ?? null
    }
  })

const idle = await readCmd()
check(
  '空闲态：三条通道都在 0，状态 idle',
  idle?.state === 'idle' && idle.acked.every((n) => n === 0) && idle.names.length === 3,
  `${idle?.names.join('/')} = ${idle?.acked.join('/')}`
)
check(
  '空闲态终端总数 = 128 + 24 + 12（docx 点名的三类终端）',
  idle?.totals.join('/') === '128/24/12',
  idle?.totals.join('/')
)

/**
 * 判据的**自证**：这两条谓词就是下面全部指令断言的基础。
 * 拿「一次到位」和「三条齐步走」的假状态喂进去，它们必须返回 false ——
 * 否则下面的断言在一份错误实现上也会全绿。
 */
const notOneShot = (acked, totals) =>
  acked.reduce((a, b) => a + b, 0) < totals.reduce((a, b) => a + b, 0)
const staggered = (acked, totals) => {
  const f = acked.map((n, i) => n / totals[i])
  return f[0] - f[2] >= 0.125
}
console.log('  [自证] 判据对错误实现的态度：')
check('  · 「全部已送达」判为「不是一次到位」= false', notOneShot([128, 24, 12], [128, 24, 12]) === false)
check('  · 「三条齐步走」判为「错峰」= false', staggered([64, 64, 64], [128, 24, 12]) === false)
check('  · 控制组：真实错峰状态判为 true', staggered([64, 12, 0], [128, 24, 12]) === true)

if (selfTest) {
  /**
   * 自证：把 DOM 改成「一次到位」的样子，检查器必须**读到这个假状态**并判它不合格。
   *
   * 证的是读数路径有分辨力 —— 不是读了个常量、也不是在断言自己刚写死的东西。
   * 注入与还原在**同一个同步块**里完成：Vue 的 flush 是微任务，
   * 同步块中间插不进来，所以不存在「被组件改回去」的竞态。
   */
  const injected = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.emergency__cmd .emergency__channel')]
    const before = items.map((el) => el.getAttribute('data-acked'))
    items.forEach((el) => el.setAttribute('data-acked', el.getAttribute('data-total')))
    const fake = items.map((el) => Number(el.getAttribute('data-acked')))
    const totals = items.map((el) => Number(el.getAttribute('data-total')))
    items.forEach((el, i) => el.setAttribute('data-acked', before[i]))
    const restored = items.map((el) => Number(el.getAttribute('data-acked')))
    return { fake, totals, restored }
  })
  check(
    '[自证] 注入「一次到位」后判据判它不合格',
    notOneShot(injected.fake, injected.totals) === false,
    injected.fake.join('/')
  )
  check(
    '[自证] 同一同步块内还原，判据重新成立',
    notOneShot(injected.restored, injected.totals) === true,
    injected.restored.join('/')
  )
}

await page.locator('.emergency__cmd .emergency__btn').click()

// 「立刻读」这一对是**无竞态**的：一次到位的实现会直接 idle→done，
// 根本进不了 running，第一条就此超时变红。
let enteredRunning = true
await page
  .waitForFunction(() => document.querySelector('.emergency__cmd')?.dataset.state === 'running', null, {
    timeout: 1500
  })
  .catch(() => (enteredRunning = false))
check('点下按钮即进入「下发中」（一次到位的实现没有这个中间态）', enteredRunning)

const immediate = await readCmd()
check(
  '刚点下时送达数 < 总数（否则就是一次到位）',
  !!immediate && notOneShot(immediate.acked, immediate.totals),
  immediate ? `${immediate.acked.join('/')} < ${immediate.totals.join('/')}` : '读不到'
)
check('下发中按钮禁用（防重复触发）', immediate?.disabled === true)

const samples = []
const t0 = Date.now()
while (Date.now() - t0 < 9000) {
  const s = await readCmd()
  if (s) samples.push(s)
  if (s?.state === 'done') break
  await page.waitForTimeout(90)
}
const runningSamples = samples.filter((s) => s.state === 'running')
check('下发过程中采到 ≥3 个中间态', runningSamples.length >= 3, `${runningSamples.length} 个`)
check(
  '三条通道**错峰**推进（首尾进度差 ≥ 1/8，齐步走看不出来）',
  runningSamples.some((s) => staggered(s.acked, s.totals)),
  runningSamples.map((s) => s.acked.join('/')).join(' → ').slice(0, 90)
)

const final = samples[samples.length - 1]
check('收尾自停：state = done', final?.state === 'done', `用时 ${Date.now() - t0}ms`)
check(
  '每条通道都送满（acked = total）',
  !!final && final.acked.every((n, i) => n === final.totals[i]),
  final?.acked.join('/')
)
const afterDone = await readCmd()
check('停表后进度不再变化（自停生效）', afterDone?.acked.join('/') === final?.acked.join('/'))

// ---------------------------------------------------------------------------
console.log('\n### §7.2-3 最优调配方案 / §7.2-4 多源画面')
// ---------------------------------------------------------------------------

const heads = (await page.locator('.emergency__dispatch th').allInnerTexts()).map((t) => t.trim())
check(
  `表头 = 硬编码规格 ${EXPECT_DISPATCH_HEADS.join('/')}`,
  heads.join(',') === EXPECT_DISPATCH_HEADS.join(','),
  heads.join('/')
)

const etas = (await page.locator('.emergency__dispatch-eta').allInnerTexts()).map((t) =>
  Number(t.replace(/[^\d]/g, ''))
)
check('每行都有预计到场时间', etas.length === 4 && etas.every((n) => n > 0), etas.join('/'))
check(
  '按预计到场时间升序（「最优」的可见含义就是这个排序）',
  etas.every((n, i) => i === 0 || etas[i - 1] <= n),
  etas.join(' ≤ ')
)

const videoCells = await page.locator('.emergency__video-cell').count()
const videoTips = await page.locator('.emergency__video-tip').allInnerTexts()
check('多源画面三路点位都在', videoCells === EXPECT_VIDEO_CELLS, `${videoCells} 路`)
check(
  '画面区一律是「信号接入中」（不伪造视频帧）',
  videoTips.length === EXPECT_VIDEO_CELLS && videoTips.every((t) => t.includes('信号接入中')),
  videoTips.join('/')
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

await page.evaluate(() => {
  const v = window.__cesiumViewer
  if (v) {
    v.render()
    v.useDefaultRenderLoop = false
  }
})
await page.waitForTimeout(800)
await page.screenshot({ path: `${outDir}/emergency.png`, timeout: 180000 })
console.log(`\n截图：${outDir}/emergency.png`)

await browser.close()

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok)
console.log(
  `\n合计 ${checks.length} 项，失败 ${failed.length} 项` +
    `${selfTest ? '（含 --self-test：注入「一次到位」状态，要求判据当场判它不合格）' : ''}`
)
for (const f of failed) console.log(`  ✗ ${f.name}`)
process.exit(failed.length ? 1 : 0)
