/**
 * 「三维 ↔ 面板」双向联动的专项检查（统计报表页，`#/reports`）。
 *
 * 用法：node scripts/check-linkage.mjs [baseUrl] [--self-test]
 *
 * ── 为什么这个脚本必须存在 ────────────────────────────────────────────
 * 联动是本项目**唯一一类「坏了也全绿」**的功能：面板少一块会被
 * `check-panel-overflow.mjs` 抓到、数字对不上会被 `check-decision.mjs` 抓到，
 * 但「点标注没反应」「点图表相机不动」这两种失效**画面不报错、控制台不报错、
 * 数据也全对**——用户点一下发现没动静，就再也不点了，然后以为这个功能本来就
 * 只是张静态图。没有这个脚本，整条联动链上任何一环断了都没人知道。
 *
 * ── 两条最容易被实现骗过去的判据，以及为什么这么写 ───────────────────
 * ① **「相机飞到目标单元」不能只断言「相机动了」。**
 *    飞错地方、或者相机因为 `shouldAnimate` 的时钟自己在飘，位移一样 > 0。
 *    所以判据是**相机离哪个标注最近**：点「北帮采剥面」之后，相机必须
 *    是离 北帮采剥面 最近，而不是随便动了一下。这个判据用不着写死任何坐标，
 *    也就不会随着机位调整而失效。
 * ② **「点标注出浮层」不能只断言「弹出了浮层」。**
 *    标注层四个点的 `key` 一旦与 `AREA_ANCHORS` 对不上，
 *    `openUnitCard` 会打开一张**别的单元**的卡片——看起来完全正常。
 *    所以逐个标注点过去，要求弹出来的标题**就是它自己**，四个都要对。
 *
 * ── 一条最容易把脚本写废的坑：**不能用固定毫秒数等相机飞完** ─────────
 * 软件渲染（SwiftShader）下这页**一帧要 2~3 秒**：实测 12 秒里只出了 5 帧
 * （`frames: 43 → 44 → 48`）。而 `camera.flyTo` 的缓动是**按真实时间推进**的,
 * 只要**有一帧**落在 2.5 秒之后，缓动就一步跳到终点。
 * 所以「点完等 4 秒再读数」很可能**一帧都没等到**，读回来是「位移 0 m」——
 * 这是探针自己的假象，不是页面没动。本项目已经在 `probe-runtime.mjs` 上
 * 吃过一次同款亏（当时差点把它当成页面缺陷报上去）。
 *
 * 正确写法是**等这条缓动队列排空**：`scene.tweens` 正是 `camera.flyTo` 用的
 * 那条队列，它空了就是飞完了（`flySettle()`）。这是**等待条件**而不是等待时长，
 * 慢机器上自动多等，快机器上立刻过。
 *
 * ── 还有一条：点图表不能点画布正中 ───────────────────────────────────
 * ECharts 的 `click` **只在命中图元时发出**，点在网格空白处什么都不发
 * （实测：点画布中心，面板 `cursor: pointer` 是对的、坐标也没错，但处理函数
 * 一次都没被调到 —— 卡片还停在上一次点击的标题上，看上去「点了有反应」）。
 * 所以下面沿图表底边**扫一遍**找数据项：扫到第一个就停，并把落点写进日志。
 * 顺带证明了一件更重要的事：**图表画布没有被任何透明层吃掉鼠标事件**
 * （本项目硬约束之一，真鼠标点击能穿透到 ECharts 才算数）。
 *
 * ── 自证（--self-test）────────────────────────────────────────────────
 * 两处注入都做在**真实链路上**，不是拿纯函数喂假数据：
 *   S1 把 `stat-area-选矿厂` 的 `show` 置假 ⇒ 同一屏幕坐标再拾取必须落空
 *   S2 把 `camera.flyTo` 打成空函数 ⇒ 点目录行相机必须原地不动
 * 两处都按本项目惯例要求 `注入前 → 注入后 → 还原` 三个读数对上。
 * S2 还顺带回答了「相机自己会不会飘」——如果会，主判据本来就是废的。
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'
// ⚠️ 点 DOM 一律走 `clickAt`，**不要用 `locator.click()`** —— 理由见该文件头
import { clickAt } from './lib/click.mjs'

const argv = process.argv.slice(2)
const selfTest = argv.includes('--self-test')
const base = argv.find((a) => !a.startsWith('--')) || 'http://localhost:8787'
const url = `${base}/#/reports`

/** 硬编码规格 —— **不从 src 读**。脚本去读被测代码的常量，两边一起改就永远绿了 */
const EXPECT_UNITS = ['北帮采剥面', '东帮爆破区', '选矿厂', '厂区']
/**
 * 四个作业单元里挑「选矿厂」做联动细节的样本，点它应当同时点亮 3 块面板 + 目录里 2 行。
 *
 * ⚠️ 为什么挑它、为什么是 3 和 2 —— **写死在这里**，不从 `dirRows`（DOM）里算。
 * 一度写成「取目录里条数 ≥2 的第一个」，那是在**从被测代码读期望值**：
 * 页面上少渲染一列，算出来的样本跟着变，`EXPECT_LINKED_PANELS` 却还是 3，
 * 于是红的是「面板数不对」而真因是「目录少了一列」——排查方向从第一步就错了。
 * 硬编码的那份才是规格；DOM 里读出来的只能用来**对照**。
 */
const EXPECT_PICKED = '选矿厂'
const EXPECT_LINKED_PANELS = 3
const EXPECT_LINKED_ROWS = 2
/** 相机「飞到了」的判据：位移至少这么大（m）；低于它连抖动都算不上 */
const MIN_MOVE_M = 100

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

/** 与 check-emergency 同一套：`/api/*` 的 404 是降级路径，不算错 */
const errs = []
const apiMisses = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const u = m.location()?.url ?? ''
  if (u.includes('/api/')) apiMisses.push(u.slice(-60))
  else errs.push(m.text().slice(0, 120))
})

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })

// 建场景要好几秒（地形采样 + 底图瓦片），标注是在 build 之后才加进实体的
await page
  .waitForFunction(
    () =>
      !!window.__cesiumViewer &&
      [...window.__cesiumViewer.entities.values].filter((e) => String(e.id).startsWith('stat-area-')).length === 4,
    { timeout: 90000 }
  )
  .catch(() => {})
/** 页内等待，只用来让 Vue 把 DOM 渲染出来；**不用它等相机**（见文件头） */
const settle = (ms) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms)
await settle(2500)

/**
 * 等渲染循环真的又出了 n 帧 —— 「时间确实过去了」的最诚实写法。
 *
 * 软件渲染下一帧 2~3 秒，所以这比 `settle(3000)` 更能说明问题：
 * 帧数没动就说明画面根本没再算过，此时读到的「相机没动」没有意义。
 *
 * ⚠️ **等不到就当场喊出来**，不许 `.catch(() => {})` 咽掉。
 * 咽掉之后每一处等待都会安静地烧满超时，整段看上去就是「脚本卡住了」——
 * 实测撞过这个：24 分钟里只挪到第二阶段的第一行，而进程 CPU 几乎是 0
 * （真在渲染的话不该是 0），全靠另开一个终端看进程状态才判断出是「空等」。
 * 现在超时缩短到 30 秒，并且把读数写进日志。
 */
const framesAdvance = async (need = 3) => {
  const start = await page.evaluate(() => window.__cesiumViewer?.scene?.frameState?.frameNumber ?? -1)
  if (start < 0) {
    console.log('      · 读不到 scene.frameState.frameNumber（不是慢，是这个属性没了）')
    return false
  }
  const ok = await page
    .waitForFunction(
      ([s, n]) => (window.__cesiumViewer?.scene?.frameState?.frameNumber ?? -1) >= s + n,
      [start, need],
      { timeout: 30000, polling: 'raf' }
    )
    .then(() => true)
    .catch(() => false)
  const end = await page.evaluate(() => window.__cesiumViewer?.scene?.frameState?.frameNumber ?? -1)
  if (!ok) console.log(`      · 30 秒内帧数没走够：${start} → ${end}（要 +${need}）`)
  return end >= start + need
}

/**
 * 等相机飞完并且**位置真的落定**。
 *
 * 三段缺一不可，少哪一段都会读出假结果：
 *   ① 先等出 2 帧 —— 缓动是**在帧里**推进的。不等帧，`tweens` 可能还是 1，
 *      而相机一毫米没动，「位移 0 m」于是成了探针的假象（本项目吃过一次）。
 *   ② 再等 `scene.tweens` 排空 —— 这是 `camera.flyTo` 用的那条缓动队列。
 *      判据是**队列空了**，不是等了多久：慢机器多等、快机器立刻过。
 *   ③ 排空后再等 1 帧 —— `positionWC` 是在帧里更新的，缓动刚结束的那一瞬间
 *      读到的还可能是上一帧的位置。
 */
const flySettle = async () => {
  await framesAdvance(2)
  const drained = await page
    .waitForFunction(() => (window.__cesiumViewer?.scene?.tweens?.length ?? 0) === 0, null, {
      timeout: 60000,
      polling: 'raf'
    })
    .then(() => true)
    .catch(() => false)
  if (!drained) {
    // 缓动排不空 = 相机一直在飞（或者是 `tweens` 这个属性没了）。
    // 两种都可能，所以把当时的长度读出来，别让人猜。
    const n = await page.evaluate(() => window.__cesiumViewer?.scene?.tweens?.length ?? -1)
    console.log(`      · 60 秒后缓动队列还没空：tweens.length = ${n}`)
  }
  await framesAdvance(1)
}

/**
 * 某个标注**此刻**在屏幕上的位置。
 *
 * ⚠️ 必须在每次点击之前重读，**不能拿一开始量好的那份**：点一个标注会
 * 把相机飞过去（这是设计如此，见 `openUnitCard`），相机一飞，
 * 其余三个标注的屏幕位置就全变了。用旧坐标接着点，会点到别的标注身上
 * ——实测就是「点东帮爆破区，弹出来的是北帮采剥面」，而这一条看上去
 * 完全像是锚点表串了，排查方向会被带偏到十万八千里外。
 */
const markAt = (name) =>
  page.evaluate((id) => {
    const v = window.__cesiumViewer
    const e = v.entities.getById(id)
    if (!e) return null
    const w = v.scene.cartesianToCanvasCoordinates(e.position.getValue(v.clock.currentTime))
    const rect = v.scene.canvas.getBoundingClientRect()
    return {
      x: w.x,
      y: w.y,
      ox: rect.left,
      oy: rect.top,
      onScreen: w.x > 0 && w.x < rect.width && w.y > 0 && w.y < rect.height
    }
  }, `stat-area-${name}`)

// ---------------------------------------------------------------------------
console.log('\n### 一、默认机位：四个标注都得看得见、点得着')
// ---------------------------------------------------------------------------

/**
 * 标注的屏幕位置 + 挡在它上面的面板矩形，一次读回来。
 *
 * ⚠️ 面板矩形是**量出来的 DOM 实际位置**，不是从 SCSS 抄 `$panel-width`。
 * 这里要判的是「这个点会不会被面板挡住」，唯一的真值就是面板此刻在哪儿；
 * 抄常量的话，哪天布局改了，脚本会拿一个过时的数去判一个当下的问题。
 * （要被判死的**规格**——四个单元叫什么——仍然是上面硬编码的那份。）
 */
const geom = await page.evaluate(() => {
  const C = window.__cesiumNS
  const v = window.__cesiumViewer
  const canvas = v.scene.canvas.getBoundingClientRect()
  const map = document.querySelector('.reports__map').getBoundingClientRect()
  const rectOf = (sel) =>
    [...document.querySelectorAll(sel)].map((el) => {
      const r = el.getBoundingClientRect()
      // 换成 canvas 坐标系，好跟标注的屏幕位置直接比
      return {
        left: r.left - canvas.left,
        right: r.right - canvas.left,
        top: r.top - canvas.top,
        bottom: r.bottom - canvas.top
      }
    })

  const marks = [...v.entities.values]
    .filter((e) => String(e.id).startsWith('stat-area-'))
    .map((e) => {
      const w = v.scene.cartesianToCanvasCoordinates(e.position.getValue(v.clock.currentTime))
      return {
        id: String(e.id).replace('stat-area-', ''),
        x: w.x,
        y: w.y,
        caption: String(e.label?.text?.getValue(v.clock.currentTime) ?? '')
      }
    })

  return {
    /**
     * 画布原点在**视口**里的位置。
     *
     * ⚠️ 标注的屏幕坐标是 `cartesianToCanvasCoordinates` 给的，**相对画布**；
     * 而 `page.mouse.click` 要的是**视口**坐标。少了这一步加法，点出去的位置
     * 会整体偏掉一个顶栏的高度，症状是「点了四下，四下全都没反应」——
     * 而坐标本身看着完全正常。这里先把偏移量量准。
     */
    canvasPage: { left: canvas.left, top: canvas.top },
    canvas: { w: canvas.width, h: canvas.height },
    marks,
    panels: [...rectOf('.reports__side--left'), ...rectOf('.reports__side--right'), ...rectOf('.reports__bottom')]
  }
})

check(
  '三维里正好 4 个作业单元标注',
  geom.marks.length === EXPECT_UNITS.length,
  geom.marks.map((m) => m.id).join(' / ')
)
check(
  '四个标注就是硬编码的那四个（不多不少、不重名）',
  EXPECT_UNITS.every((u) => geom.marks.some((m) => m.id === u)) &&
    new Set(geom.marks.map((m) => m.id)).size === EXPECT_UNITS.length,
  `期望 ${EXPECT_UNITS.join('/')}`
)

/**
 * 「看得见」= 标注点连同它正上方那两行标签都不被面板压住。
 *
 * 标签挂在点的正上方 20px，两行 11px 字号约 30px 高、半宽约 40px
 * （最长的「北帮采剥面 · 2 张报表」那张实测不超过这个数）。
 * 判据只要求**点本身没被压住、标签的横向范围也没被压住**——
 * 标签纵向顶到指标卡下面无关紧要，点被压住才是真的点不着。
 */
const labelBox = (m) => ({ left: m.x - 40, right: m.x + 40, top: m.y - 50, bottom: m.y + 8 })
const coveredBy = (m, p) => !(labelBox(m).right < p.left || labelBox(m).left > p.right || labelBox(m).bottom < p.top || labelBox(m).top > p.bottom)
const covered = geom.marks.filter((m) => geom.panels.some((p) => coveredBy(m, p)))
check(
  '四个标注都没有被侧栏/底栏压住（压住了就是「看不见的地物」，点了也不会有反应）',
  covered.length === 0,
  covered.length
    ? covered.map((m) => `${m.id}@[${Math.round(m.x)},${Math.round(m.y)}]`).join(' ')
    : geom.marks.map((m) => `${m.id}@[${Math.round(m.x)},${Math.round(m.y)}]`).join(' ')
)

check(
  '标注还在画布范围内（四个都要，不是「有三个在就行」）',
  geom.marks.every((m) => m.x > 0 && m.x < geom.canvas.w && m.y > 0 && m.y < geom.canvas.h),
  `画布 ${Math.round(geom.canvas.w)}×${Math.round(geom.canvas.h)}`
)

// 标注副行写的是「N 张报表」，得和右列报表目录里数出来的行数一致
const dirRows = await page.evaluate(() =>
  [...document.querySelectorAll('.reports__row')].map((el) => ({
    name: el.querySelector('.reports__row-name')?.textContent?.trim() ?? '',
    scope: el.querySelector('.reports__row-scope')?.textContent?.trim() ?? ''
  }))
)
check('报表中心列出 6 张报表（硬编码，源数据条数变了要有人知道）', dirRows.length === 6, `${dirRows.length} 行`)

const captionMismatch = []
for (const m of geom.marks) {
  const on3d = Number((m.caption.match(/(\d+)\s*张报表/) ?? [])[1] ?? NaN)
  const inList = dirRows.filter((r) => r.scope === m.id).length
  if (!(on3d === inList && on3d > 0)) captionMismatch.push(`${m.id}: 三维写 ${on3d} / 目录 ${inList}`)
}
check(
  '三维标注的「N 张报表」与目录里该单元的行数一致（两边都单独看都像对的，只有对起来才知道）',
  captionMismatch.length === 0,
  captionMismatch.length ? captionMismatch.join('；') : geom.marks.map((m) => `${m.id} ${m.caption.split('\n')[1] ?? ''}`).join(' / ')
)

// ---------------------------------------------------------------------------
console.log('\n### 二、三维 → 面板：点标注弹出它自己的卡片')
// ---------------------------------------------------------------------------

/**
 * 开场那个机位（也就是 `REPORTS_HOME`，第一节刚验过四个标注都看得见）。
 *
 * 记下来是为了**每点一个标注之前退回去**，理由见 `backToHome`。
 */
const initialView = await page.evaluate(() => {
  const v = window.__cesiumViewer
  const c = v.camera
  return {
    destination: { x: c.positionWC.x, y: c.positionWC.y, z: c.positionWC.z },
    orientation: { heading: c.heading, pitch: c.pitch, roll: c.roll }
  }
})

/**
 * 把相机退回开场机位。
 *
 * ⚠️ **不退回不行**：点一个标注会让相机飞到那个单元旁边（设计如此），
 * 于是另外三个标注**跑到画布外面去了** —— 实测连点四个之后，
 * 选矿厂在 x=2262、厂区在 x=2097，而画布只有 1920 宽。
 * 探针这时量到的坐标点不到任何东西，报出来却是「(没弹)」，
 * 看上去像锚点表串了或者浮层坏了，其实只是**那两个点根本不在屏幕上**。
 *
 * 用 `setView` 而不是 `flyTo`：这里要的是「回到刚才那个状态」，
 * 不是一次新的飞行 —— 飞行本身会再引入一段不确定的等待和一次缓动。
 * 这不是让脚本替页面干活，是**给下一条判据摆好它成立所需的现场**：
 * 被断言的事情仍然只有「点这个标注，弹出来的卡片是不是它自己」。
 */
const backToHome = async () => {
  await page.evaluate((view) => {
    const C = window.__cesiumNS
    window.__cesiumViewer.camera.setView({
      destination: new C.Cartesian3(view.destination.x, view.destination.y, view.destination.z),
      orientation: view.orientation
    })
  }, initialView)
  await framesAdvance(2)
}

const readCard = () =>
  page.evaluate(() => {
    const el = document.querySelector('.reports__pick')
    if (!el) return null
    return {
      title: el.querySelector('.reports__pick-title')?.textContent?.trim() ?? '',
      kind: el.querySelector('.reports__pick-kind')?.textContent?.trim() ?? '',
      body: el.innerText.replace(/\s+/g, ' ').trim()
    }
  })

/**
 * 关掉已经开着的浮层。
 *
 * ⚠️ **不关就会挡住下一个要点的标注** —— 这不是猜的，是算出来的：
 * 浮层贴在点击处右下 14px（`pickStyle`），并夹在
 * `[432..1188] × [104..574]` 里，尺寸 300×190。于是：
 *   · 点北帮采剥面 [476,547] → 浮层落在 [490..790] × [561..751]，
 *     **正好盖住东帮爆破区 [674,664]**；
 *   · 点选矿厂 [1395,360] → 浮层落在 [1188..1488] × [374..564]，
 *     **正好盖住厂区 [1256,450]**。
 * 这精确解释了那个「隔一个错一个」的现象（1 ✓ 2 ✗ 3 ✓ 4 ✗）——
 * 报出来却是「点东帮爆破区弹的是北帮采剥面」，看着像锚点串了。
 *
 * 页面本身没问题：关掉浮层有两条路（右上角的 ×，或者点三维里的空白处，
 * 见 `onPick` → `clearPick`）。这里走 ×，顺带把「浮层关得掉」也验了。
 */
const closeCard = async () => {
  if (!(await readCard())) return
  /**
   * ⚠️ 这里**必须**用 `clickAt`，不能用 `locator.click()`。
   *
   * 原来写的是 `locator.click({timeout:10000}).catch(() => {})`，两个 `.catch`
   * 把失败吞得干干净净，于是这一步**从头到尾什么都没做**，而
   * `waitForSelector(state:'detached')` 也「成功」了 —— 因为浮层压根没被关掉，
   * 它等的是「消失」，永远等不到，10 秒后静默超时，脚本继续往下跑。
   *
   * 后果精确地是那个「隔一个错一个」（1 ✓ 2 ✗ 3 ✓ 4 ✗）：
   * 上一个浮层留在原地，正好压住下一个要点的标注。
   * 这一条连着好几轮被读成「锚点表串了」「坐标系过期」，都不是。
   * 真正的原因与教训写在 `scripts/lib/click.mjs` 的文件头。
   */
  const r = await clickAt(page, '.reports__pick-close', { timeout: 8000 })
  if (!r.ok) {
    console.log(`      · 关浮层失败：${r.reason}`)
    return
  }
  // 等它真的从 DOM 上消失再往下走 —— 用 interval 轮询，
  // 不用默认的 `polling: 'raf'`：这几页的帧正被 Cesium 占着（同上）。
  await page
    .waitForFunction(() => !document.querySelector('.reports__pick'), null, { timeout: 10000, polling: 200 })
    .catch(() => console.log('      · 点了 ×，浮层 10 秒还没消失'))
}

const clickMark = async (name) => {
  const t0 = Date.now()
  await closeCard()
  await backToHome()
  const at = await markAt(name)
  if (!at || !at.onScreen) {
    console.log(`      · ${name} 量不到位置或不在屏内，跳过点击`)
    return { card: null, at }
  }
  /**
   * ⚠️ `page.mouse.click` **没有超时参数**，是这里唯一一处「可以无限期挂住」的调用。
   *
   * 挂住的**不是点击本身**。实测过：卡住 68 秒的那一次，之后读卡片拿到的是
   * **正确的那一个单元** —— 事件早就派发到页面了，回不来的只是 CDP 的**回执**
   * （`Input.dispatchMouseEvent` 要等渲染进程 ack，而渲染进程正被 Cesium 占着；
   * 单独跑同一个点击只要 3.0 秒，一旦机器上还留着上次跑挂的 chromium 一起抢 CPU，
   * 就能拖到一分钟以上）。
   *
   * 所以这里的超时**不是失败判据**，只是「别让整轮巡检无声地停在这一行」的保险。
   * 点击到没到，由后面的卡片标题断言回答 —— 那才是这件事的真值。
   * 措辞上也别写成「点击没发出去」：那是把「我没等到回执」说成了「页面没收到」，
   * 正是本项目反复吃过的那种把探针现象当页面缺陷的错。
   */
  await Promise.race([
    page.mouse.click(at.x + at.ox, at.y + at.oy),
    new Promise((_, rej) => setTimeout(() => rej(new Error('90 秒')), 90000))
  ]).catch((err) =>
    console.log(`      · ${name} 的点击回执等了 ${err.message} 还没回来，继续（以卡片标题为准）`)
  )

  /**
   * ⚠️ 点完之后**不能直接 `flySettle()`**，它答不了「这次点击被处理了吗」。
   *
   * `flySettle` 等的是 `scene.tweens` 排空，可**缓动要等页面处理完点击才有**：
   * 点击还没轮到处理时，队列本来就是空的，于是它**立刻返回**，
   * 接着读到的还是上一张卡片。实测就是这条把结果变成「隔一个错一个」的：
   * 北帮采剥面 ✓、东帮爆破区 → 北帮采剥面、选矿厂 ✓、厂区 → 选矿厂，
   * 而两次错的那回耗时只有 4.3s / 14.7s，两次对的耗时 70.5s / 84.4s
   * （慢的那两次反而是**点击回执等了很久**，等到的时候页面早处理完了，于是"对"了）
   * —— 快慢本身在提示：快的那些根本没等到效果。
   *
   * 所以这里等的是**可观察的效果**：浮层标题变成本次点的那个单元。
   * 它同时管住了两件事 —— 点击被处理了，且处理成了正确的那一个。
   * 等到了再 `flySettle`，让相机把路走完。
   */
  const landed = await page
    .waitForFunction(
      (n) => document.querySelector('.reports__pick-title')?.textContent?.trim() === n,
      name,
      { timeout: 60000, polling: 'raf' }
    )
    .then(() => true)
    .catch(() => false)
  if (!landed) console.log(`      · ${name} 等了 60 秒，浮层标题也没换成它`)
  await flySettle()
  const card = await readCard()
  // 每个标注一行 —— 慢的时候一眼看出是「等相机」慢还是「点击」慢
  console.log(
    `      · ${name}@[${Math.round(at.x)},${Math.round(at.y)}] → ${card?.title || '(没弹)'}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
  )
  return { card, at }
}

/**
 * 逐个点过去 —— 四个都要弹出**它自己**。点出一个别的单元，就是锚点表串了。
 *
 * ⚠️ `clickMark` 每次点击前**重新量**这个标注此刻在屏幕上的位置（`markAt`），
 * 用完就扔，**不用开场量好的 `geom.marks`**。点一个标注会把相机飞过去
 * （设计如此，见 `openUnitCard`），飞完之后其余标注的屏幕坐标就全变了。
 * 拿旧坐标接着点第二个、第三个，点中的是别的标注。
 *
 * 实测撞上过：连点四个，「点东帮爆破区弹出来的是北帮采剥面、点选矿厂压根没反应」。
 * 这个症状**看上去**完全是锚点表串了，纯靠读代码能排查到天荒地老 ——
 * 实际原因是坐标系过期。所以这里宁可每轮多花几秒重量一次。
 */
const wrongCard = []
for (const name of EXPECT_UNITS) {
  const { card, at } = await clickMark(name)
  if (!card) wrongCard.push(`${name}@[${Math.round(at?.x ?? -1)},${Math.round(at?.y ?? -1)}] → (没弹)`)
  else if (card.title !== name) wrongCard.push(`${name} → ${card.title || '(空标题)'}`)
}
check(
  '四个标注逐个点过去，弹出来的都是它自己（点出一个别的单元就是锚点表串了）',
  wrongCard.length === 0,
  wrongCard.length ? wrongCard.join('；') : `${EXPECT_UNITS.length}/${EXPECT_UNITS.length} 全对`
)

/**
 * 浮层关得掉吗 —— 上面每点一个标注都要先把它关掉让路（`closeCard`）。
 *
 * 它坏了不会报错，只会让**下一个标注点不动**，然后表现为「点 B 弹的是 A」。
 * 这个症状与「锚点表串了」一模一样，所以必须有一条判据把它单独钉住。
 */
{
  const before = await readCard()
  await closeCard()
  const after = await readCard()
  check(
    '浮层的 × 能关掉它（关不掉的话下一个标注就被压在它下面，点不着）',
    !!before && after === null,
    before ? `点了 × 之后${after ? '还在' : '已关'}` : '点之前就没有浮层可关'
  )
}

// 用「选矿厂」做联动细节的样本：它的卡片行数最多，最能看出浮层有没有漏项
const { card } = await clickMark(EXPECT_PICKED)
check('点标注弹出浮层', !!card, card ? card.title : '没弹出来')
check('浮层第一行标明这是「作业单元」', card?.kind === '作业单元', card?.kind ?? '')
check('浮层里带「作业内容」（这是静态事实，不是编出来的统计值）', /作业内容/.test(card?.body ?? ''), '')
check(
  '浮层里带「口径」一行（把「按作业内容归集」这件事告诉用户，而不是藏起来）',
  /按作业内容归集/.test(card?.body ?? ''),
  ''
)
check(
  '浮层里的报表条数与目录一致',
  new RegExp(`承载报表 ${dirRows.filter((r) => r.scope === EXPECT_PICKED).length} 张`).test(card?.body ?? ''),
  `期望 ${dirRows.filter((r) => r.scope === EXPECT_PICKED).length} 张`
)

const linked = await page.evaluate(() => ({
  panels: document.querySelectorAll('.reports__panel.is-linked').length,
  rows: document.querySelectorAll('.reports__row.is-linked').length
}))
check(
  `点「${EXPECT_PICKED}」同时点亮 ${EXPECT_LINKED_PANELS} 块面板`,
  linked.panels === EXPECT_LINKED_PANELS,
  `实测 ${linked.panels} 块`
)
check(
  `点「${EXPECT_PICKED}」同时点亮目录里 ${EXPECT_LINKED_ROWS} 行`,
  linked.rows === EXPECT_LINKED_ROWS,
  `实测 ${linked.rows} 行`
)

/**
 * 高亮：判据是「被点的那个比没被点的大」，**不写死 22px** ——
 * 样式常量改了，这条判据不该跟着红；而「高亮没落在被点的那一个身上」必须红。
 *
 * 「没被点的」那个单元由 `EXPECT_UNITS` 里**排除 `EXPECT_PICKED`** 现算，
 * 不另写一个单元名：两个名字分头写死，哪天改重了就成了「自己比自己」，
 * 恒假恒红而且看不出为什么；从同一份规格里排除出来就不可能重。
 */
const otherName = EXPECT_UNITS.find((u) => u !== EXPECT_PICKED)
const highlight = await page.evaluate(
  ([mineId, otherId]) => {
    const v = window.__cesiumViewer
    const size = (e) => e?.point?.pixelSize?.getValue(v.clock.currentTime) ?? NaN
    return {
      mine: size(v.entities.getById(mineId)),
      other: size(v.entities.getById(otherId)),
      otherName: otherId.replace('stat-area-', '')
    }
  },
  [`stat-area-${EXPECT_PICKED}`, `stat-area-${otherName}`]
)
check(
  `被点中的「${EXPECT_PICKED}」实体点变大了，没被点中的「${highlight.otherName}」没变（高亮真的落在那一个身上）`,
  highlight.mine > highlight.other,
  `选中 ${highlight.mine}px vs 其它 ${highlight.other}px`
)

// ---------------------------------------------------------------------------
console.log('\n### 三、面板 → 三维：相机必须真的飞到那个单元旁边')
// ---------------------------------------------------------------------------

/**
 * 相机「在看谁」—— 判据是**哪个标注离画布中心最近**，不是哪个离相机最近。
 *
 * ⚠️ 一开始写的是「离相机最近的那个」，那是错的，而且错得很像对的：
 * `openUnitCard` 是按 `range ≈ 1200m` 飞过去的，而北帮采剥面与东帮爆破区
 * 彼此只隔一千多米 —— 飞到位之后，**相机到「目标」和到「隔壁」的距离差不多**，
 * 谁近全看机位朝向的零头。实测就报出过「点北帮采剥面，相机最近的却是东帮爆破区
 * （1102m），次近才是北帮采剥面（1218m）」，而相机其实正正好好对着北帮采剥面。
 * 那是判据的毛病，不是页面的。
 *
 * 相机「看着」谁，在屏幕上是一目了然的：注视点就落在画布中心附近。
 * 所以判据改成**目标标注到画布中心的距离最小**，与它离相机多远无关，
 * 也就不会因为两个单元挨得近而失效。
 *
 * 3D 距离仍然读出来放进日志 —— 排查时想知道相机退到了多远，它有用。
 */
const cameraAim = () =>
  page.evaluate(() => {
    const C = window.__cesiumNS
    const v = window.__cesiumViewer
    const cam = v.scene.camera.positionWC
    const rect = v.scene.canvas.getBoundingClientRect()
    const cx = rect.width / 2
    const cy = rect.height / 2
    const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

    const marks = [...v.entities.values]
      .filter((e) => String(e.id).startsWith('stat-area-'))
      .map((e) => {
        const pos = e.position.getValue(v.clock.currentTime)
        const w = v.scene.cartesianToCanvasCoordinates(pos)
        return {
          id: String(e.id).replace('stat-area-', ''),
          d: dist3(cam, pos),
          // 到画布中心的屏幕距离 —— 相机注视谁就看它
          center: Math.hypot(w.x - cx, w.y - cy),
          x: w.x,
          y: w.y
        }
      })
      .sort((a, b) => a.center - b.center)

    const carto = C.Cartographic.fromCartesian(cam)
    return {
      x: cam.x,
      y: cam.y,
      z: cam.z,
      lon: +C.Math.toDegrees(carto.longitude).toFixed(6),
      lat: +C.Math.toDegrees(carto.latitude).toFixed(6),
      aimed: marks[0],
      second: marks[1]
    }
  })

const moveOf = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// ---- 3.1 点报表目录某行 ----

/**
 * ⚠️ 挑一行**目标不是相机当前所在单元**的点。
 *
 * 上一段刚点过 `EXPECT_PICKED` 的标注，相机正停在那上面。此时点一行指向同一个单元的
 * 报表，`flyTo` 会把相机从 1200m 挪到……同一个单元的 1200m 处 —— 位移接近 0，
 * 于是「相机真的动了」这条会红，**而功能其实是好的**。
 * 那不是探针发现了缺陷，是探针自己把「位移」当成了「有没有飞」。
 * （反过来，若它真的一点没飞，`camAfter.near` 也就不会变成这一行的单元，
 *   第二条断言照样能抓住 —— 两条判据是分开的，不能只留一条。）
 */
const camBefore = await cameraAim()
const rowIdx = dirRows.findIndex((r) => r.scope && r.scope !== camBefore.aimed?.id)
const row = dirRows[rowIdx] ?? dirRows[0]
const rowUnit = row?.scope ?? ''
await page.locator('.reports__row').nth(rowIdx < 0 ? 0 : rowIdx).click()
await flySettle()
const camAfter = await cameraAim()
const moved = moveOf(camBefore, camAfter)

check(
  `点目录第 ${(rowIdx < 0 ? 0 : rowIdx) + 1} 行（${row?.name ?? '?'} → ${rowUnit}）相机真的动了`,
  moved > MIN_MOVE_M,
  `位移 ${moved.toFixed(1)} m（点之前相机正对着 ${camBefore.aimed?.id}）`
)
check(
  `…而且飞到的是「${rowUnit}」头上（不是随便动了一下）`,
  camAfter.aimed?.id === rowUnit,
  `相机正对 ${camAfter.aimed?.id}@[${Math.round(camAfter.aimed?.x ?? NaN)},${Math.round(
    camAfter.aimed?.y ?? NaN
  )}]（离画布中心 ${Math.round(camAfter.aimed?.center ?? NaN)}px、退到 ${Math.round(
    camAfter.aimed?.d ?? NaN
  )}m），次之 ${camAfter.second?.id}（${Math.round(camAfter.second?.center ?? NaN)}px）`
)

// ---- 3.2 点图表数据项 ----
const chartBox = await page.evaluate(() => {
  const panel = [...document.querySelectorAll('.panel-box')].find(
    (p) => p.querySelector('.panel-box__title')?.textContent?.trim() === '质量活动'
  )
  const box = panel?.querySelector('.echart-box')
  if (!box) return null
  const r = box.getBoundingClientRect()
  return {
    x: r.left,
    y: r.top,
    w: r.width,
    h: r.height,
    hasCursor: getComputedStyle(box).cursor
  }
})
check(
  '「质量活动」这块面板的图表量得到（量不到说明图没渲染，也就点不到）',
  !!chartBox && chartBox.h > 40,
  chartBox ? `${Math.round(chartBox.w)}×${Math.round(chartBox.h)}` : '量不到'
)
check(
  '可点的图表给了手形光标（不然用户根本不知道这张图能点）',
  chartBox?.hasCursor === 'pointer',
  `cursor: ${chartBox?.hasCursor ?? '?'}`
)

if (chartBox) {
  /**
   * 沿图表**底边往上一点**横扫，找第一个真的能触发处理函数的数据项。
   *
   * 为什么扫底边：柱状图的柱子是从坐标轴往上的矩形，**贴着轴那一条横线上
   * 每根柱子都在**，不管它多高。所以这条线扫过去，命中率最高、最不依赖
   * 图表配置（`grid` / `barWidth` / 类别数怎么改都不影响这个性质）。
   *
   * 不用 `page.mouse.click` 之外的手段：`dispatchEvent` 造出来的合成事件
   * 绕过不了「透明层吃掉鼠标」这类问题，而那个恰恰是本项目硬约束之一。
   */
  const camBeforeChart = await cameraAim()
  const cardBeforeChart = await readCard()
  const yBase = chartBox.y + chartBox.h - 26
  let hit = null
  const tried = []
  for (let dy = 0; dy <= 24 && !hit; dy += 8) {
    for (let x = chartBox.x + 10; x < chartBox.x + chartBox.w - 6; x += 7) {
      tried.push({ x: Math.round(x), y: Math.round(yBase - dy) })
      await page.mouse.click(x, yBase - dy)
      const card = await readCard()
      if (card && card.title === '选矿厂' && card.title !== cardBeforeChart?.title) {
        hit = { x: Math.round(x), y: Math.round(yBase - dy), tries: tried.length }
        break
      }
    }
  }
  await flySettle()
  const camAfterChart = await cameraAim()
  const cardAfterChart = await readCard()
  const movedChart = moveOf(camBeforeChart, camAfterChart)
  check(
    '点图表数据项真的触发了处理函数（卡片换成该图归属的单元）',
    !!hit,
    hit
      ? `第 ${hit.tries} 次点击命中 [${hit.x},${hit.y}]`
      : `扫了 ${tried.length} 个点都没命中——要么接线没通，要么画布被透明层吃掉了`
  )
  check(
    '…而且相机跟着飞了（同一条联动链，不是另写的一套）',
    movedChart > MIN_MOVE_M,
    `位移 ${movedChart.toFixed(1)} m，卡片「${cardAfterChart?.title ?? '没弹'}」`
  )
}

// ---------------------------------------------------------------------------
if (selfTest) {
  console.log('\n### 自证（在真实链路上注入缺陷，要求判据当场翻红）')
  console.log('  · 判据函数与主流程用的是同一份读数逻辑，注入→判定→还原全在一次 evaluate 里做完，')
  console.log('    中间不让出控制权 —— 一旦有 await，Vue 的微任务可能重渲染把注入冲掉，')
  console.log('    「没翻红」于是成了脚本自己的假阴性。')

  // ---- S1：拾取链 ----
  /**
   * ⚠️ 每次判定前后都要**同步渲染一帧**（`v.render()`）。
   *
   * `probeAt` 走的是 `scene.pick`，而 `scene.pick` 打的是**上一帧已经建好的图元**；
   * 标记点的显隐是 `PointVisualizer` 在帧的 update 阶段才落实的。
   * 所以「设 `show = false` → 立刻 pick」读到的仍是旧帧里的那个点，
   * 注入看上去**没生效** —— 实测这条自证第一次就是这么假红的
   * （注入前 → 注入后 → 还原，三个读数全是 `stat-area-选矿厂`）。
   *
   * 这三行仍然全在一次 evaluate 里同步做完，没有 await：
   * 「注入到判定之间不能让出控制权」那条纪律（防 Vue 微任务重渲染冲掉注入）照样成立，
   * 只是中间补了一次手动渲染 —— 让现场跟上注入。
   */
  const s1 = await page.evaluate(() => {
    const v = window.__cesiumViewer
    const e = v.entities.getById('stat-area-选矿厂')
    const w = v.scene.cartesianToCanvasCoordinates(e.position.getValue(v.clock.currentTime))
    /** 先渲染再拾取 —— 顺序反了读到的是上一帧 */
    const hit = () => {
      v.render()
      return window.__mapScene.probeAt(w.x, w.y).entityId
    }
    const before = hit()
    e.show = false
    const after = hit()
    e.show = true
    return { before, after, restored: hit() }
  })
  check(
    'S1 藏掉 stat-area-选矿厂 ⇒ 同一屏幕坐标不再命中它（证明「点标注 → 得这个单元」不是恒真）',
    s1.before === 'stat-area-选矿厂' && s1.after !== 'stat-area-选矿厂' && s1.restored === 'stat-area-选矿厂',
    `注入前 ${s1.before} → 注入后 ${s1.after} → 还原 ${s1.restored}`
  )

  // ---- S2：飞行链 ----
  await page.evaluate(() => {
    const v = window.__cesiumViewer
    window.__flyToBackup = v.camera.flyTo.bind(v.camera)
    v.camera.flyTo = () => {} // 注入：飞行失效，但别的一概照旧
  })
  const camBeforeStub = await cameraAim()
  await page.locator('.reports__row').last().click()
  // ⚠️ 这里**必须等帧**，不能等固定毫秒数：飞行被注入打掉了，没有缓动可等，
  // 而「相机没动」只有在**时间真的过去了**之后才有意义。
  // 等到了帧还说没动，才排除得了「其实是还没开始动」。
  const sawFrames = await framesAdvance(3)
  const camAfterStub = await cameraAim()
  const movedStub = moveOf(camBeforeStub, camAfterStub)
  await page.evaluate(() => {
    const v = window.__cesiumViewer
    if (window.__flyToBackup) v.camera.flyTo = window.__flyToBackup
  })
  check(
    'S2 注入后渲染循环又出了 3 帧（不然下面那个「没动」可能是「还没轮到动」）',
    sawFrames,
    sawFrames ? '帧数确实前进了' : '帧数没动，这条自证不成立'
  )
  check(
    'S2 把 camera.flyTo 打成空函数 ⇒ 点目录行相机必须原地不动（证明上面「动了」不是相机自己在飘）',
    movedStub < 1,
    `位移 ${movedStub.toFixed(1)} m（应当 ≈0）`
  )

  // 还原之后再点一次，相机得重新飞起来 —— 否则 S2 的还原本身没验证
  const camBeforeRevive = await cameraAim()
  await page.locator('.reports__row').first().click()
  await flySettle()
  const camAfterRevive = await cameraAim()
  check(
    'S2 还原 flyTo 之后同一次点击又能飞（证明上面那个 0 m 是注入造成的，不是页面本来就坏了）',
    moveOf(camBeforeRevive, camAfterRevive) > MIN_MOVE_M,
    `位移 ${moveOf(camBeforeRevive, camAfterRevive).toFixed(1)} m`
  )
} else {
  console.log('\n### 自证：跳过（加 --self-test 运行）')
}

// ---------------------------------------------------------------------------
console.log('\n### 控制台与请求')
check('没有 /api 以外的控制台错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '干净')
console.log(
  `  · 后端未就绪的降级请求 ${new Set(apiMisses).size} 个（设计如此，不判死）`
)

await browser.close()

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok)
console.log(
  `\n合计 ${checks.length} 项，失败 ${failed.length} 项` +
    `${selfTest ? '（含 --self-test：真实链路上注入两处缺陷，要求判据当场翻红）' : '（未跑自证，加 --self-test）'}`
)
for (const f of failed) console.log(`  ✗ ${f.name}`)
process.exit(failed.length ? 1 : 0)
