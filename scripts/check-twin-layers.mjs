/**
 * 三维图层体检：证明数字孪生页的三组图层**真的画在画面上**，且边坡模拟真的在动。
 *
 * 这条检查是为两类**不报错**的失效立的：
 *
 * ① 实体建了但永远不渲染。Cesium 的 `EllipseGeometryUpdater.prototype._isHidden`
 *    第一句就是 `!defined(entity.position) → true`，而它不抛错、不告警：实体照建、
 *    `entities.getById()` 照能拿到、`show` 照能读写，只是画面上一片都没有。
 *    应急救援页的定位基站覆盖圈（`station-ring-*`）正是这个写法，
 *    一直没画出来——本脚本的「结构性审计」就是为它写的。
 *
 * ② 高度写死导致整片埋在土里或浮在空中。项目先后用过三种底座，地面标高各不相同，
 *    任何写死的绝对高度在其中一种下必然是错的（见 mock/safety.ts 那段注释）。
 *    这类问题在画面上表现为「就没有这些东西」，与 ① 长得一样。
 *
 * ── 判定方式 ──
 * 不看截图内容、不猜坐标，用两条独立证据：
 *
 * A. **结构性审计**（不截图）：两条「配置本身就不出图」的不变式——
 *    形状缺自己那份坐标、贴地几何关掉了填充。与相机在哪、渲染多慢都无关，
 *    所以这一条对**整个程序化三维底座**也成立，见下面的 B3。
 *
 * B. **像素证据**：把该组图层全部隐藏截一张，只显示这一组再截一张，
 *    两张图的 sha1 **必须不同** ⇒ 这组图层确实在画面上有像素。
 *    反过来，把**不存在的图层**（前缀 `zzz-`）「显示」一遍，两张图必须**相同**
 *    —— 这是自证：若「显示后画面变了」是恒真的（噪声、瓦片还在加载、抗锯齿抖动），
 *    不存在的前缀也会「变」，B 就成了空转。
 *
 * 噪声底另有一条：把渲染漂移源（场景时钟）冻住后，**同一个状态**连截两张必须
 * 逐像素一致。这既排除抗锯齿抖动，也确认瓦片已经加载完（还在流式加载时不一致）。
 *
 * ⚠️ 两条与「慢」有关的实测教训（都在这份脚本里红过一次）：
 *   ① **地面图元重建慢**：贴地的 ellipse 被换掉再换回来，要重新生成几何、
 *      进地面批次、与地形做分类，软件渲染下要好几秒。卡死 2.5s 等它，
 *      会把「慢」误报成「坏」——所以还原那一枪用 `shootUntilChanged` 等到变化为止。
 *   ② **基准画面必须先证成静止**：相机一动，瓦片就会重新加载并逐级细化，
 *      画面在好几秒里一直变。此时「注入后像素变了」是**恒真**的，
 *      而自证里最关键的两条恰恰要的是「像素**没**变」。基准不稳时，
 *      像素那一半如实标成「未测」，不拿漂移冒充结论。
 *   ③ **负结论的观察窗口要由对照组实测给出，不能猜**：`nopos / deadoutline`
 *      两条自证要的是「注入后像素**没**变」，而「没变」既可以是真的没渲染、
 *      也可以是**还没渲染出来**。两者在画面上完全一样。所以先跑对照组
 *      （配置正确、必然要出像素的那一个），把它**实测**需要的等待时间量出来，
 *      再拿这个时间来量另外两个 —— 窗口够不够用是被证明的，不是被假设的。
 *      对照组自己没在预算内出图时，另外两条如实标成「未测」而不是「通过」。
 *   ④ **像素判据只能量三维画面那一块，不能截全页**：这条是被一次「红得没道理」
 *      逼出来的。两次独立探针（同一台机器、同一条注入路径）量到：
 *        · 场外对照（经度 +0.4°，投影落点 **(2041, −670)** —— 实测在视口外，
 *          一个像素都画不到）**仍然让锚点近区变了** ⇒ 只要建了地面批次，
 *          整个地球都会重新镶嵌，三维画面会抖一次。所以「画面变了」推不出「画出来了」。
 *        · `fill:false` 那一条（不建批次）三维窗口**一个都没变**，
 *          变的只有**右侧数据面板条与底部机位条**，而且连截 3 轮都没落定 ——
 *          那两个区域有自己的、与三维无关的噪声。
 *      也就是说：全页比较把「界面的噪声」当成了「三维的证据」，
 *      于是同一套判据下 `nopos` 绿、`deadoutline` 红 —— 判据本身是飘的。
 *      现在自证只比**锚点近区**（600×600，正好是注入点所在的位置），
 *      界面怎么抖都与它无关。
 *
 *      诚实记一笔：这样一来负例证的是「**没建地面批次**」，不是「一个像素都没画」。
 *      两者在无批次时等价（没有批次就没有几何可画），但**正面那一半变弱了**：
 *      阳性对照的「变」也可能来自批次重建的抖动，不能单独证明它画了出来。
 *
 * B3. **全场景审计**：在 `/safety` 上审计该页**全部**实体（不传前缀），
 *    把三维底座一起查了——`buildMineScene` 造的东西比业务图层多得多，
 *    也更容易在改标高/改布局时被改坏，而它此前从未被查过。
 *
 * C. **边坡动态模拟**：读实体坐标而不是看截图。模拟跑到 1 之后，SL-01 的点位
 *    位移量必须等于 `26.4mm ÷ 1000 × 200`（放大倍数），且**方向**与数据里的
 *    方位角一致；复位后必须回到基准位置。距离对了方向反了，看图是看不出来的。
 *
 * 用法：node scripts/check-twin-layers.mjs [baseUrl]
 *       node scripts/check-twin-layers.mjs --self-test
 *
 * `--self-test` 除常规判定外，还会**亲手造一个「有 ellipse 却缺 position」的实体**
 * （以及一个只多一个 `position`、其余全同的对照），要求结构性审计点名前者、
 * 放过后者，且像素证据显示前者一个像素都没画、后者画了出来。
 * 没有这一步，「审计全绿」和「像素变了」都无法排除是空转。
 * 每个变体拆成**审计**与**像素**两条判据：审计那一半与画面稳不稳定无关，
 * 不该被基准问题连坐。
 *
 * ⚠️ 本脚本**冻结时钟但不停渲染循环**（要出图），与 check-clock-motion.mjs 相反。
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'
import { createHash } from 'node:crypto'

const argv = process.argv.slice(2)
const selfTest = argv.includes('--self-test')
const base = argv.find((a) => !a.startsWith('--')) || 'http://localhost:8787'
const sha = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 12)

/**
 * 待检页面与图层。
 *
 * `layers[].prefix` 之间**不能互相包含**（`station-` 会连 `station-ring-` 一起吞，
 * 于是「只显示覆盖圈」实际把站点也显示出来了，结论就不是这一组图层的了）。
 */
const PAGES = [
  {
    path: '/digital-twin',
    ready: ['twin-device-', 'twin-risk-', 'slope-'],
    layers: [
      { label: '设备点位', prefix: 'twin-device-' },
      { label: '风险区四色分布', prefix: 'twin-risk-' },
      { label: '边坡监测点', prefix: 'slope-' }
    ]
  },
  {
    path: '/emergency',
    ready: ['route-base-', 'person-', 'station-ring-'],
    layers: [
      { label: '避灾路线', prefix: 'route-' },
      { label: '定位基站覆盖圈', prefix: 'station-ring-' }
    ],
    // 这一页的覆盖圈曾经静默不渲染，跑一次「改回旧写法」的回归自证
    regression: true
  }
]

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

const checks = []

/** 等场景建完（软件渲染下几十秒）。`settleMs` 只在要出图时才需要 */
async function buildScene(path, ready, settleMs = 25000) {
  /*
   * ⚠️ 用**查询串**强制整页重载，不能只改 hash。
   *
   * 只改 hash 的 `page.goto` 是**同文档导航**：SPA 路由换页时，旧页面的
   * `useCesium` 会销毁旧 viewer 并 `delete window.__cesiumViewer`（见 useCesium.ts）。
   * 于是「等 __cesiumViewer 出现」会**被上一页的 viewer 立刻满足**，
   * 紧接着它被销毁 ⇒ 下一句断言读到 `undefined.entities`。
   * 而 `waitForFunction` 不会重试——它把谓词里的异常直接抛出来，脚本当场崩。
   * （这个坑本身也说明「等一个全局对象存在」不足以证明页面换了。）
   *
   * 查询串一变就是真重载：`window` 干净、旧实体不会残留，
   * 下面那条「审计该页全部实体」的判据才成立。
   */
  await page.goto(`${base}/?page=${encodeURIComponent(path)}#${path}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  })
  await page.waitForFunction(() => !!window.__cesiumViewer, null, { timeout: 240000 })
  // 谓词里一律用 `?.`：即使 __cesiumViewer 中途消失，也只是本次为假、下轮重试，
  // 而不是抛异常把脚本打死
  await page.waitForFunction(
    (list) => {
      const v = window.__cesiumViewer?.entities?.values
      return !!v && list.every((p) => v.some((e) => typeof e.id === 'string' && e.id.startsWith(p)))
    },
    ready,
    { timeout: 240000 }
  )
  // 冻住场景时钟：避灾路线的流动光带随时钟走相位，不冻的话每一次截图都不同，
  // 「显示了图层所以画面变了」就无从分辨。渲染循环**保持运行**（要出图）。
  await page.evaluate(() => {
    window.__cesiumViewer.clock.shouldAnimate = false
  })
  // 等瓦片与首帧稳定。软件渲染下这一步很慢，宁可多等。
  if (settleMs) await page.waitForTimeout(settleMs)
}

/** 按前缀开关实体，返回命中的实体个数 */
const setShow = (prefix, on) =>
  page.evaluate(
    ({ p, o }) => {
      const v = window.__cesiumViewer
      let n = 0
      for (const e of v.entities.values) {
        if (typeof e.id === 'string' && e.id.startsWith(p)) {
          e.show = o
          n++
        }
      }
      return n
    },
    { p: prefix, o: on }
  )

const shoot = () => page.screenshot({ timeout: 180000 })

/**
 * 一直截到画面**相对基准发生变化**为止，返回最后一次的哈希与总共等了多久。
 *
 * 为什么需要它：地面图元（`heightReference: CLAMP_TO_GROUND` 的 ellipse）重建要走
 * 「生成几何 → 进 StaticGroundGeometryColorBatch → 与地形做分类」。
 *
 * ⚠️ **这个窗口不能猜，只能量。** 最初这里等的是固定的 2500ms，而且是拿
 * `waitForTimeout` 的累计时间当依据的 —— 那个数根本不是「等到像素出现」的时间，
 * 因为**一次截图本身就要 20~25 秒**。用对照组实测（正确配置的贴地椭圆）
 * 得到的真实数字是 **2 张截图 / 约 45~55 秒**才在画面上出现像素，
 * 比原来那个窗口长了一个数量级。原判据于是对负例毫无分辨力：
 * 它绿是因为「还没来得及看」，不是因为「真的没有」。
 *
 * 所以现在的写法是：**对照组先跑**，用本函数把「要等多久」实测出来；
 * 负例只在这个实测窗口内下结论；窗口没量到就如实标「未测」，
 * 不拿「没看见」冒充「没有」。
 *
 * 这条判据问的是「**最终有没有**回来」，不是「它够不够快」。
 * 到了预算上限仍然没变就判失败 —— 不是无限重试。
 */
async function shootUntilChanged(baseline, attempts = 4) {
  const t0 = Date.now()
  let s
  for (let i = 0; i < attempts; i++) {
    s = sha(await shoot())
    if (s !== baseline) return { s, ms: Date.now() - t0, tries: i + 1 }
    await page.waitForTimeout(3000)
  }
  return { s, ms: Date.now() - t0, tries: attempts }
}

/**
 * 在**时间预算**内连截，回答「画面相对基准有没有变」。
 *
 * 上限用时间而不是次数：一次截图本身就要 15~30s（682 个实体的场景实测 31s），
 * 按次数算等于把观察窗口绑在截图速度上 —— 换台机器窗口就变了，判据也跟着变。
 * 顺带把实测耗时返回出去：调用方要用它当**下一个**判据的窗口。
 */
async function observeChange(baseline, budgetMs, shot = null) {
  const take = shot ?? (async () => sha(await shoot()))
  const t0 = Date.now()
  let shots = 0
  let hash = null
  for (;;) {
    hash = await take()
    shots++
    if (hash !== baseline) return { changed: true, ms: Date.now() - t0, shots, hash }
    if (Date.now() - t0 >= budgetMs) return { changed: false, ms: Date.now() - t0, shots, hash }
    await page.waitForTimeout(1500)
  }
}

/**
 * 连截到**两张一致**为止，返回那一帧静止画面（画面还在变就返回 stable:false）。
 *
 * 用途只有一个：给下一枪一个**干净的基准**。上一个变体被移除时会触发地面批次
 * 重建，画面在随后几秒里还在变；不等它落定就注入下一个变体，那次观察里的
 * 「变了」根本分不清是新变体渲染了还是上一个还在散场。
 *
 * `shot` 可换成**局部窗口**的取景函数（自证用锚点近区，理由见文件头 ④）。
 */
async function shootUntilStable(maxShots = 3, shot = null) {
  const take = shot ?? (async () => sha(await shoot()))
  const t0 = Date.now()
  let prev = await take()
  for (let i = 1; i < maxShots; i++) {
    await page.waitForTimeout(2500)
    const cur = await take()
    if (cur === prev) return { hash: cur, stable: true, shots: i + 1, ms: Date.now() - t0 }
    prev = cur
  }
  return { hash: prev, stable: false, shots: maxShots, ms: Date.now() - t0 }
}

/**
 * 「这对实体里有多少个落在当前画面内」。
 *
 * 只在某组图层**没出像素**时打印，用来把两种完全不同的原因分开：
 * 一是它真的没渲染（要查的正是这个），二是相机压根没照着它（脚本的锅）。
 * 分不开的话，一次红会是「需要调查」而不是「已经定位」。
 */
const countInView = (prefix) =>
  page.evaluate((p) => {
    const v = window.__cesiumViewer
    const C = window.__cesiumNS
    const now = v.clock.currentTime
    const w = v.canvas.clientWidth
    const h = v.canvas.clientHeight
    let inView = 0
    let total = 0
    for (const e of v.entities.values) {
      if (typeof e.id !== 'string' || !e.id.startsWith(p)) continue
      // 标注点直接取 position；折线取第一个顶点（否则整条线都没有 position）
      const pos =
        (e.position && typeof e.position.getValue === 'function' && e.position.getValue(now)) ||
        (e.polyline &&
          e.polyline.positions?.getValue?.(now)?.[0]) ||
        null
      if (!pos) continue
      total++
      const s = C.SceneTransforms.worldToWindowCoordinates(v.scene, pos)
      if (s && s.x >= 0 && s.x <= w && s.y >= 0 && s.y <= h) inView++
    }
    return { inView, total }
  }, prefix)

/**
 * 结构性审计：两条「配置本身就不出图」的不变式。两条都已核对 CesiumUnminified 源码，
 * 且**都不抛错、不告警**（第二条有一条没人会看的一次性 console 告警）。
 *
 * 规则① 形状缺少它自己那份坐标。**「需要 position」是逐形状不同的**，
 *   一律要求 position 会误报（`wall`/`corridor`/`polygon`/`rectangle` 用的是各自
 *   自带的 world 坐标，给了 position 也没用）：
 *     ellipse    `_isHidden` 要求 entity.position          （L171308）
 *     box        `_isHidden` 要求 entity.position          （L62626）
 *     cylinder   `_isHidden` 要求 entity.position          （L161269）
 *     polygon    要求 polygon.hierarchy —— **不看 position**（L173883）
 *     corridor   要求 corridor.positions + width            （L157667）
 *     rectangle  要求 rectangle.coordinates                 （L176029）
 *     wall       要求 wall.positions                        （L177080）
 *
 * 规则② 贴地（heightReference = CLAMP/RELATIVE_TO_GROUND）却关掉了填充：
 *   `GeometryUpdater` 构造函数 `if (outlineEnabled && onTerrain) { oneTimeWarning(...);
 *   outlineEnabled = false }` —— 贴地几何的轮廓被强制关掉，
 *   而 `_insertUpdaterIntoBatch`（L179863）只在 `outlineEnabled` / `fillEnabled`
 *   为真时才把它塞进批次 ⇒ 两个都假时**一个批次都不进，什么都不建**。
 *
 * 规则②是规则①的补充而不是重复：只把 position 补上，规则①会变绿而圈**仍然看不见**。
 */
const structuralAudit = (prefixes) =>
  page.evaluate((list) => {
    const v = window.__cesiumViewer
    const C = window.__cesiumNS
    const now = v.clock.currentTime
    /** 需要 entity.position 的形状 */
    const NEEDS_POSITION = ['ellipse', 'box', 'cylinder']
    /** 需要自带坐标的形状 → 取坐标的属性名 */
    const NEEDS_OWN_COORDS = {
      polygon: 'hierarchy',
      corridor: 'positions',
      rectangle: 'coordinates',
      wall: 'positions'
    }
    const ON_TERRAIN = [C.HeightReference.CLAMP_TO_GROUND, C.HeightReference.RELATIVE_TO_GROUND]
    const bad = []
    let checked = 0

    for (const e of v.entities.values) {
      if (typeof e.id !== 'string') continue
      if (list.length && !list.some((p) => e.id.startsWith(p))) continue
      checked++

      for (const s of NEEDS_POSITION) {
        if (e[s] && !e.position) {
          bad.push(`${e.id}（${s} 缺 entity.position，_isHidden 恒真、静默不画）`)
        }
      }
      for (const [s, coord] of Object.entries(NEEDS_OWN_COORDS)) {
        if (e[s] && !e[s][coord]) {
          bad.push(`${e.id}（${s} 缺 ${s}.${coord}，_isHidden 恒真、静默不画）`)
        }
      }

      for (const s of ['ellipse', 'polygon', 'rectangle', 'corridor']) {
        const g = e[s]
        if (!g) continue
        // polygon 只有「不按顶点高度」时才算贴地
        if (s === 'polygon' && g.perPositionHeight?.getValue?.(now) === true) continue
        if (!ON_TERRAIN.includes(g.heightReference?.getValue?.(now))) continue
        if (g.fill?.getValue?.(now) === false) {
          bad.push(`${e.id}（贴地的 ${s} 关掉了 fill，轮廓又被 Cesium 强制关掉 ⇒ 一个批次都不进）`)
        }
      }
    }
    return { checked, bad }
  }, prefixes)

// ---------------------------------------------------------------------------
/**
 * 覆盖圈回归自证：把**真实实体**逐字改回修复前的写法，要求本脚本认出它。
 *
 * 为什么不能只靠新写一段代码去证明旧代码有问题：修复前的 /emergency 已经不复存在，
 * 想「看见它变红」就只能在运行期把缺陷重新注入一次。这里注入的是**同一批实体、
 * 同一个机位、同一份半径与颜色**，唯一变化的就是那两行配置——
 * 比拿一段人工构造的等价物去演示更硬。
 *
 * ⚠️ 注入只能用**被观察的属性**：`EllipseGeometryUpdater` 的
 * `observedPropertyNames` 是 `["availability","position","ellipse"]`（L171208），
 * 改 `ellipse.fill` 这种子属性根本不会通知更新器。所以这里换的是**整个 ellipse 对象**。
 */
async function runRingRegression() {
  const hiddenShot = sha(await shoot())

  const rings = await page.evaluate(() => {
    const v = window.__cesiumViewer
    const C = window.__cesiumNS
    const now = v.clock.currentTime
    window.__ringBackup = []
    for (const e of v.entities.values) {
      if (typeof e.id !== 'string' || !e.id.startsWith('station-ring-')) continue
      const b = { id: e.id, position: e.position, ellipse: e.ellipse }
      window.__ringBackup.push(b)
      // ---- 逐字改回修复前：没有 position + 只画轮廓不填充 ----
      e.position = undefined
      e.ellipse = {
        semiMajorAxis: b.ellipse.semiMajorAxis.getValue(now),
        semiMinorAxis: b.ellipse.semiMinorAxis.getValue(now),
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        fill: false,
        outline: true,
        outlineWidth: 2,
        outlineColor: b.ellipse.material.color.getValue(now)
      }
    }
    return window.__ringBackup.length
  })

  const audit = await structuralAudit(['station-ring-'])
  const flagged = new Set(audit.bad.map((s) => s.slice(0, s.indexOf('（'))))
  const rule2 = audit.bad.some((s) => s.includes('关掉了 fill'))
  console.log(
    `  --- 回归自证：把 ${rings} 个覆盖圈改回修复前，审计点名 ${flagged.size} 个，` +
      `其中规则②（贴地关填充）${rule2 ? '触发' : '未触发'}`
  )
  checks.push([
    `回归自证：改回修复前后，结构性审计点名全部 ${rings} 个覆盖圈（规则②${rule2 ? '并' : '未'}触发）`,
    rings > 0 && flagged.size === rings && rule2
  ])

  await setShow('station-ring-', true)
  await page.waitForTimeout(2500)
  const sBad = sha(await shoot())
  console.log(
    `  ${sBad === hiddenShot ? '✓' : '✗'} 改回修复前后一个像素都没有：${sBad} ${sBad === hiddenShot ? '=' : '≠'} ${hiddenShot}`
  )
  checks.push(['回归自证：改回修复前，覆盖圈在画面上一个像素都没有', sBad === hiddenShot])

  // 还原成修复后的写法
  await page.evaluate(() => {
    const v = window.__cesiumViewer
    for (const b of window.__ringBackup) {
      const e = v.entities.getById(b.id)
      if (!e) continue
      e.position = b.position
      e.ellipse = b.ellipse
    }
  })
  await page.waitForTimeout(2500)
  const sOk = await shootUntilChanged(hiddenShot)
  console.log(
    `  ${sOk.s !== hiddenShot ? '✓' : '✗'} 还原后像素回来了：${sOk.s} ${
      sOk.s !== hiddenShot ? '≠' : '='
    } ${hiddenShot}（第 ${sOk.tries} 张，等了 ${sOk.ms}ms）`
  )
  // 判据问的是「最终有没有回来」。地面图元重建 + 地形分类在软件渲染下要好几秒，
  // 卡死 2.5s 会把「慢」误报成「坏」——这条曾经就是这样红过一次（见文件头注释）
  checks.push(['回归自证：还原成修复后的写法，覆盖圈重新有像素（变量只有一个）', sOk.s !== hiddenShot])

  await setShow('station-ring-', false)
  await page.waitForTimeout(1000)
}

// ---------------------------------------------------------------------------
// 常规：逐页逐图层
// ---------------------------------------------------------------------------
for (const spec of PAGES) {
  await buildScene(spec.path, spec.ready)
  console.log(`\n### ${spec.path}`)

  // ---- A. 结构性审计 ----
  const audit = await structuralAudit(spec.ready)
  if (audit.bad.length) {
    for (const b of audit.bad) console.log(`  ✗ ${b}`)
  } else {
    console.log(`  ✓ 结构性审计：${audit.checked} 个实体，没有「有形状却缺 position」的`)
  }
  checks.push([
    `${spec.path} 结构性审计（${audit.checked} 个实体）`,
    audit.bad.length === 0
  ])

  // ---- B0. 噪声底：同一状态连截两张必须逐像素一致 ----
  //
  // ⚠️ **已知弱点（2026-09-12 实测，尚未修）**：下面这一组（B0 / B1 / B2）比的是
  // **全页**哈希，而全页里含右侧数据面板条与底部控件条 —— 那两个区域**有自己的、
  // 与三维无关的噪声**，实测会间歇性地连着几轮都在变（自证那一段的三臂探针量到：
  // 注入一个建不了批次的实体后，三维窗口一个都没变，变的只有 panel / bottom，
  // 且连读 3 轮都没落定）。
  // 对 B0 与 B1 这两条**负判据**（「必须没变」）来说，这种噪声会直接造成假红；
  // 对 B2 那条正判据则是假绿 —— 界面自己抖一下也会被算成「这组图层有像素」。
  // 今天它一直绿，是因为那份噪声是间歇的，不是因为它不存在。
  //
  // 修法与自证里用的是同一条路：把比较窗口收到**三维画面那一块**
  // （避开 x≥1504 的面板列、y≥996 的底部控件条，以及左侧 x<600 的几个浮层），
  // 自证的锚点近区窗口就是先例，且已有三臂探针的实测支撑。
  // 之所以**这次没改**：B0/B1/B2 是当前在跑的判据，改窗口需要重跑整轮验证；
  // 一旦它们开始间歇性红，第一件事就是按上面那条改，而不是重试。
  const allPrefixes = spec.layers.map((l) => l.prefix)
  await page.evaluate((list) => {
    const v = window.__cesiumViewer
    for (const e of v.entities.values) {
      if (typeof e.id !== 'string') continue
      if (list.some((p) => e.id.startsWith(p))) e.show = false
    }
  }, allPrefixes)

  // 等画面**自己落定**，而不是「隔 3 秒再截一张」。
  //
  // 2026-09-14 这一条真的红了（连同下面的 B1 自证一起），根因不是噪声：
  // 是**底图开始真的拉瓦片了**。修掉「几何误差返 0 → 影像层级塌成 0 级」
  // 之后，三维区每帧都在收新瓦片（见 README 十三节第 28 条），
  // 固定 3 秒截的两张图必然不同。
  //
  // 原来那个 3 秒之所以一直绿，是因为影像层级被算成 0 级、请求全被透明占位图
  // 挡了回去，三维区**根本没在加载** —— 判据是绿在故障上的。
  // 换句话说：这条判据这次红，是它第一次真的在测东西。
  //
  // 这正是本文件记过的教训①「窗口不能猜，只能量」。所以改成量到落定为止；
  // 量不到就如实报红（不无限重试，也不把窗口放宽到永远绿）。
  const settle = await shootUntilStable(4)
  const noiseFree = settle.stable
  console.log(
    `  ${noiseFree ? '✓' : '✗'} 噪声底：全隐藏后连截 ${settle.shots} 张、` +
      `${Math.round(settle.ms / 1000)}s ` +
      (noiseFree ? '落定' : `仍未落定（${settle.hash}）`)
  )
  checks.push([`${spec.path} 噪声底为零（画面落定后逐像素一致）`, noiseFree])

  const baseline = settle.hash


  // ---- B1. 不存在的前缀：必须**不变**（自证 B 不是恒真） ----
  await setShow('zzz-not-a-layer-', true) // 什么都不命中
  await page.waitForTimeout(1500)
  const ghost = sha(await shoot())
  const ghostSame = ghost === baseline
  console.log(
    `  ${ghostSame ? '✓' : '✗'} [自证] 显示一个不存在的前缀，画面不变（${ghost} ${ghostSame ? '=' : '≠'} ${baseline}）`
  )
  checks.push([`${spec.path} [自证] 不存在的前缀不改变画面 —— 判据 B 不是恒真`, ghostSame])

  // ---- B2. 逐个图层：单独显示后画面必须变 ----
  for (const layer of spec.layers) {
    const hit = await setShow(layer.prefix, true)
    await page.waitForTimeout(2500)
    const h = sha(await shoot())
    const changed = h !== baseline
    console.log(
      `  ${changed ? '✓' : '✗'} ${layer.label}（${hit} 个实体）在画面上有像素：${h} ${changed ? '≠' : '='} ${baseline}`
    )
    if (!changed) {
      const v = await countInView(layer.prefix)
      console.log(
        `      ↳ 该组有 ${v.total} 个实体能取到坐标，其中 ${v.inView} 个落在当前画面内` +
          `（0 个 = 相机没照着它，脚本的锅；有若干个却仍无像素 = 真的没渲染）`
      )
    }
    checks.push([`${spec.path} 「${layer.label}」确实渲染到画面上`, changed && hit > 0])
    await setShow(layer.prefix, false)
    await page.waitForTimeout(1200)
  }

  if (spec.regression) await runRingRegression()
}

// ---------------------------------------------------------------------------
// B3. 整个程序化场景的结构性审计（不截图 ⇒ 不用等瓦片）
//
// 上面只查了各图层的实体。但**三维底座本身**（`buildMineScene.ts` 造的采坑台阶、
// 排土场、建筑屋面、挡土墙、运输道…）同样是「形状 + 坐标」的组合，同样会踩
// 规则①/② 那两个静默坑，而它从来没被查过——它比业务图层大得多，也更容易在
// 改标高、改布局时被改坏。传空前缀列表＝审计该页**全部**实体。
//
// 这一页查完等于查了所有页面的底座：`buildMineScene` 是全站共用的。
// ---------------------------------------------------------------------------
await buildScene('/safety', ['safety-facility-'], 0)
console.log('\n### /safety 全场景结构性审计（含三维底座）')

const siteAudit = await structuralAudit([])
if (siteAudit.bad.length) {
  for (const b of siteAudit.bad) console.log(`  ✗ ${b}`)
} else {
  console.log(`  ✓ 全场景 ${siteAudit.checked} 个实体，没有静默不画的配置`)
}
checks.push([`/safety 全场景结构性审计（${siteAudit.checked} 个实体，含三维底座）`, siteAudit.bad.length === 0])

// ---------------------------------------------------------------------------
// C. 边坡动态模拟：距离 + 方向 + 复位
// ---------------------------------------------------------------------------
await buildScene('/digital-twin', PAGES[0].ready)
console.log('\n### /digital-twin 边坡动态模拟')

// 切到边坡页签（模拟控件在那块面板里）
// 与下面「复位」那处同一个道理：这几个 click 都只是 actionability 等 stable，
// 不是判据本身，软件渲染下 10s 会不够。三处一起放宽，免得改完一处又卡下一处。
await page.locator('.twin__tab').nth(2).click({ timeout: 120000 })
await page.waitForSelector('.twin__sim', { timeout: 60000 })

/** 读 SL-01 的点位、标签文本与模拟进度 */
const readSim = () =>
  page.evaluate(() => {
    const v = window.__cesiumViewer
    const C = window.__cesiumNS
    const e = v.entities.getById('slope-site-SL-01')
    if (!e) return { error: '找不到 slope-site-SL-01' }
    const now = v.clock.currentTime
    const p = e.position?.getValue(now)
    if (!p) return { error: 'SL-01 没有 position' }
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      lon: C.Math.toDegrees(C.Cartographic.fromCartesian(p).longitude),
      lat: C.Math.toDegrees(C.Cartographic.fromCartesian(p).latitude),
      label: e.label?.text?.getValue(now) ?? '',
      progress: document.querySelector('.twin__sim')?.dataset.progress ?? ''
    }
  })

const at0 = await readSim()
if (at0.error) {
  console.log(`  ✗ ${at0.error}`)
  await browser.close()
  process.exit(1)
}
console.log(`  起手：${at0.label}　进度 ${at0.progress}`)

// 点「开始模拟」，等进度走满（动画自停）
await page.locator('.twin__sim-btn.is-primary').click({ timeout: 120000 })
await page.waitForFunction(
  () => Number(document.querySelector('.twin__sim')?.dataset.progress) >= 1,
  null,
  // 用定时轮询而不是默认的 rAF 轮询：软件渲染下帧率很低，rAF 轮询会把
  // 「等进度」拖成「等帧」
  { timeout: 60000, polling: 250 }
)

const at1 = await readSim()
console.log(`  演完：${at1.label}　进度 ${at1.progress}`)

/**
 * 用 ENU 局部坐标系量「东 / 北 / 天」三个分量。
 * 只量直线距离的话，方向反了（往山里滑）也照样通过——而方向正是这张图要说的事。
 */
const enu = await page.evaluate(
  ({ a, b }) => {
    const C = window.__cesiumNS
    const origin = new C.Cartesian3(a.x, a.y, a.z)
    const target = new C.Cartesian3(b.x, b.y, b.z)
    const m = C.Transforms.eastNorthUpToFixedFrame(origin)
    const inv = C.Matrix4.inverseTransformation(m, new C.Matrix4())
    const local = C.Matrix4.multiplyByPoint(inv, target, new C.Cartesian3())
    return { east: local.x, north: local.y, up: local.z }
  },
  { a: at0, b: at1 }
)

// SL-01：累计位移 26.4mm，放大 200 倍 = 5.28m，方位角 175°（几乎正南，略偏东）
const EXPECT_DIST = 5.28
const dist = Math.hypot(enu.east, enu.north)
const expectEast = EXPECT_DIST * Math.sin((175 * Math.PI) / 180)
const expectNorth = EXPECT_DIST * Math.cos((175 * Math.PI) / 180)

console.log(
  `  位移量：${dist.toFixed(2)}m（东 ${enu.east.toFixed(2)} / 北 ${enu.north.toFixed(2)}），` +
    `期望 ${EXPECT_DIST}m（东 ${expectEast.toFixed(2)} / 北 ${expectNorth.toFixed(2)}）`
)
checks.push([`模拟终点的位移量 = 累计位移 × 放大倍数（${dist.toFixed(2)}m）`, Math.abs(dist - EXPECT_DIST) < 0.2])
checks.push([
  `模拟方向与数据里的方位角一致（东 ${enu.east.toFixed(2)} vs ${expectEast.toFixed(2)}）`,
  Math.abs(enu.east - expectEast) < 0.2 && Math.abs(enu.north - expectNorth) < 0.2
])
checks.push([`标签读数演到实测值（${at1.label}）`, at1.label.includes('26.4mm')])

// 复位：必须回到基准位置
//
// ⚠️ 这里的 timeout 必须给足。`复位` 上没有 `:disabled`，永远是可点的，
// 所以卡住只可能是 Playwright 的 actionability 里那条 **stable**（要求元素矩形
// 在两个连续动画帧里一致）——软件渲染下 Cesium 渲染循环把主线程占满，
// 实测同一步里等一张画面等了 **104612ms**，10s 的预算就是这么耗光的。
// 2026-09-14 就因此红过一次（`locator.click: Timeout 10000ms exceeded`）。
// 放宽**不削弱判据**：紧接着两条断言仍然卡「复位真的回到基准位置」
// （偏差 < 0.01m）与「标签归零」——复位要是坏的，它们照样红。
await page.locator('.twin__sim-btn', { hasText: '复位' }).click({ timeout: 120000 })
await page.waitForTimeout(600)
const at2 = await readSim()
const back = Math.hypot(at2.x - at0.x, at2.y - at0.y, at2.z - at0.z)
console.log(`  复位后离基准 ${back.toFixed(4)}m，标签 ${at2.label}，进度 ${at2.progress}`)
checks.push([`复位回到基准位置（偏差 ${back.toFixed(4)}m）`, back < 0.01])
checks.push([`复位后标签归零（${at2.label}）`, at2.label.includes('0.0mm')])

// ---------------------------------------------------------------------------
// 自证：亲手造一个「有形状却没 position」的实体，看这两条判据认不认得出来
//
// 造两个实体，**位置、大小、颜色完全一样，只差一个 `position`**：
//   zz-selftest-nopos  椭圆无 position ⇒ 结构性审计必须点名，像素必须**没有变化**
//   zz-selftest-ok     椭圆有 position ⇒ 结构性审计必须放过，像素必须**变了**
//
// 这一步同时钉死两件事：
//   ① 判据 A 不是「一律报红」——它放过了后者；
//   ② 判据 B 量的确实是**渲染**，不是「实体存在」——前者在 `entities.values` 里
//      明明躺着，两张截图却一模一样。这正是 `station-ring-*` 一直没被发现的原因：
//      任何「数实体个数」的检查都会说它健康。
// ---------------------------------------------------------------------------
if (selfTest) {
  console.log('\n### 自证：造一个静默不渲染的实体')

  // 借一台设备的坐标当圆心（自己算经纬度会引入第二个变量）
  const anchor = await page.evaluate(() => {
    const p = window.__cesiumViewer.entities.getById('twin-device-DR-01')?.position?.getValue(
      window.__cesiumViewer.clock.currentTime
    )
    return p ? { x: p.x, y: p.y, z: p.z } : null
  })
  if (!anchor) {
    console.log('  ✗ 借不到锚点坐标')
    checks.push(['自证：锚点可借', false])
  } else {
    const anchorLonLat = await page.evaluate((a) => {
      const C = window.__cesiumNS
      const c = C.Cartographic.fromCartesian(new C.Cartesian3(a.x, a.y, a.z))
      return { lon: C.Math.toDegrees(c.longitude), lat: C.Math.toDegrees(c.latitude) }
    }, anchor)

    // -----------------------------------------------------------------------
    // 自证专用的像素窗口：**只截锚点近区**，不截全页（理由见文件头 ④）
    //
    // 注入点就是锚点自己（`Cartesian3.fromDegrees(anchorLonLat…)`），
    // 所以「它到底画没画」这个问题，答案只可能出现在锚点周围这一块。
    // 全页比较会把右侧数据面板条与底部机位条的噪声算进来 ——
    // 那两个区域与三维无关，而且实测连截 3 轮都不落定。
    //
    // 窗口边界夹在视口内：贴边的锚点会让窗口被裁，裁掉的是空白，不影响判定。
    // -----------------------------------------------------------------------
    const anchorScreen = await page.evaluate((a) => {
      const C = window.__cesiumNS
      const v = window.__cesiumViewer
      const w = C.SceneTransforms.worldToWindowCoordinates(v.scene, new C.Cartesian3(a.x, a.y, a.z))
      return w ? { x: Math.round(w.x), y: Math.round(w.y) } : null
    }, anchor)
    if (!anchorScreen) {
      console.log('  ✗ 锚点不在画面里，近区窗口无从谈起')
      checks.push(['自证：锚点落在画面内', false])
    }
    const GLOBE_CLIP = anchorScreen
      ? {
          x: Math.max(0, anchorScreen.x - 300),
          y: Math.max(0, anchorScreen.y - 300),
          width: 600,
          height: 600
        }
      : null
    if (GLOBE_CLIP) {
      console.log(
        `  自证像素窗口：锚点屏幕 ${anchorScreen.x}, ${anchorScreen.y} ⇒ ` +
          `${GLOBE_CLIP.x},${GLOBE_CLIP.y} ${GLOBE_CLIP.width}×${GLOBE_CLIP.height}（只比这一块）`
      )
      checks.push(['自证：锚点落在画面内', true])
    }
    /** 自证专用取景：截锚点近区并取哈希（窗口为 null 时返回 null，判定会如实退化为「未测」） */
    const shootGlobe = GLOBE_CLIP
      ? async () => sha(await page.screenshot({ clip: GLOBE_CLIP, timeout: 180000 }))
      : async () => null
    const observeGlobe = (baseline, budgetMs) => observeChange(baseline, budgetMs, shootGlobe)
    const globeUntilStable = (maxShots) => shootUntilStable(maxShots, shootGlobe)

    // 先清场：三组图层全隐藏，作为自证的基准画面
    await page.evaluate((list) => {
      const v = window.__cesiumViewer
      for (const e of v.entities.values) {
        if (typeof e.id === 'string' && list.some((p) => e.id.startsWith(p))) e.show = false
      }
    }, PAGES[0].ready)
    /**
     * 先把基准画面**证成静止的**，不能假设。
     *
     * 这一段紧跟在边坡模拟之后：模拟动过相机，相机一动，瓦片就会重新加载并逐级
     * 细化，画面在好几秒里一直变。画面在漂的话，「注入之后像素变了」就成了**恒真**
     * 判据（漂移也算变），nopos / deadoutline 这两条自证就白做了 ——
     * 它们要证的恰恰是「像素**没**变」。
     *
     * 所以连截到两张一致为止；到上限仍不一致 ⇒ 本组直接判失败，
     * 且下面的三个变体不再记录为通过（不稳定的基准上得出的「通过」是假的）。
     */
    let SELFTEST_BASE = null
    let tries = 0
    let prev = await shootGlobe()
    for (tries = 1; tries <= 5; tries++) {
      await page.waitForTimeout(3000)
      const cur = await shootGlobe()
      if (cur === prev) {
        SELFTEST_BASE = cur
        break
      }
      prev = cur
    }
    const baselineStable = SELFTEST_BASE !== null
    console.log(
      `  ${baselineStable ? '✓' : '✗'} 自证基准画面静止（${SELFTEST_BASE ?? prev}` +
        `${baselineStable ? `，第 ${tries + 1} 张与上一张一致` : `，连截 6 张都在变`}）` +
        '　—— 只比锚点近区，界面噪声与它无关'
    )
    checks.push(['自证：基准画面静止（不静止则本组的像素判据恒真）', baselineStable])
    if (!baselineStable) {
      const snap = () =>
        page.evaluate(() => {
          const v = window.__cesiumViewer
          const c = v.camera.positionCartographic
          return {
            相机: `${c.longitude.toFixed(6)},${c.latitude.toFixed(6)},${Math.round(c.height)}`,
            时钟在走: v.clock.shouldAnimate,
            瓦片未加载完: v.scene.globe.tilesLoaded === false
          }
        })
      const a = await snap()
      await page.waitForTimeout(1200)
      const b = await snap()
      console.log(
        '      ↳ 基准不稳定，现场诊断：',
        JSON.stringify(a),
        '→ 1.2s 后：',
        JSON.stringify(b),
        a.相机 !== b.相机 ? '**相机还在动**' : '相机已静止（多半是瓦片仍在细化）'
      )
    }

    /**
     * 三个变体，**每次只差配置里的一个字段**：
     *   nopos        没有 position             ⇒ 规则①
     *   deadoutline  有 position + fill:false  ⇒ 规则②（轮廓被强制关掉，净效果是一个都不建）
     *   ok           有 position + 填充        ⇒ 对照组
     * 对照组是必须的：没有它，「审计报红 ⇒ 像素不变」也可能只是「这个位置本来就画不出来」。
     */
    const VARIANTS = {
      nopos: { withPosition: false, fill: true },
      deadoutline: { withPosition: true, fill: false },
      ok: { withPosition: true, fill: true }
    }
    const inject = (id, variant) =>
      page.evaluate(
        ({ id, v, lon, lat }) => {
          const C = window.__cesiumNS
          window.__cesiumViewer.entities.add({
            id,
            ...(v.withPosition ? { position: C.Cartesian3.fromDegrees(lon, lat) } : {}),
            ellipse: {
              semiMajorAxis: 400,
              semiMinorAxis: 400,
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
              fill: v.fill,
              material: C.Color.RED.withAlpha(0.6),
              outline: true,
              outlineColor: C.Color.RED
            }
          })
        },
        { id, v: VARIANTS[variant], lon: anchorLonLat.lon, lat: anchorLonLat.lat }
      )
    const drop = (id) =>
      page.evaluate((i) => {
        const e = window.__cesiumViewer.entities.getById(i)
        if (e) window.__cesiumViewer.entities.remove(e)
      }, id)

    /**
     * 顺序是**对照组先跑**，不是随手的：
     * 负例两条的判据是「像素没变」，而「没变」既可能是真的没渲染，也可能是还没渲染完；
     * 只有先跑对照组，把「这个场景里，一个配置正确的贴地椭圆要等多久才出像素」量出来，
     * 负例的「没变」才有分辨力。预算 100s ≈ 这个场景 3~4 张截图。
     */
    const CONTROL_BUDGET_MS = 100000
    const SELFTEST_VARIANTS = [
      { key: 'ok', id: 'zz-selftest-ok', flagged: false, pixels: true },
      { key: 'nopos', id: 'zz-selftest-nopos', flagged: true, pixels: false },
      { key: 'deadoutline', id: 'zz-selftest-dead', flagged: true, pixels: false }
    ]

    /** 当前画面的静止基准：每移除一个变体都重新认一次 */
    let settled = baselineStable ? SELFTEST_BASE : null
    /** 对照组实测出来的窗口（毫秒）。没用它量过，负例的结论不算数 */
    let control = null

    for (const t of SELFTEST_VARIANTS) {
      await inject(t.id, t.key)
      const audit = await structuralAudit([t.id])
      const flagged = audit.bad.some((b) => b.startsWith(t.id))

      let rendered = null
      let note = ''
      if (settled === null) {
        note = '基准没证成静止，未测'
      } else if (t.pixels) {
        const obs = await observeGlobe(settled, CONTROL_BUDGET_MS)
        rendered = obs.changed
        control = obs
        note = `等了 ${obs.ms}ms / ${obs.shots} 张${obs.changed ? `（这就是负例的观察窗口）` : '，**预算内没出图**'}`
      } else if (!control?.changed) {
        note = '对照组没在预算内出图，观察窗口未被证明够用 ⇒ 未测'
      } else {
        // 负例：等画面**落定**再判定。用 settled 与注入后静止帧对比，
        // 而不是「注入后随便截一张」——后者会把上一个变体散场的余波算进来。
        // 真的会渲染的话，画面会收敛到**另一个**静止帧（变了，判红）；
        // 一直落不下来（别的东西在动）则如实标未测，不拿它当结论。
        const st = await globeUntilStable(3)
        if (st.stable) {
          rendered = st.hash !== settled
          note = `落定 ${st.shots} 张 / ${st.ms}ms（对照组窗口 ${control.ms}ms）`
        } else {
          note = `注入后画面一直没落定（${st.shots} 张），未测`
        }
      }

      const auditOk = flagged === t.flagged
      const pixelOk = rendered === t.pixels
      console.log(
        `  ${auditOk && pixelOk ? '✓' : '✗'} ${t.key}：审计${flagged ? '报红' : '放过'}、` +
          `像素${rendered === null ? '（未测）' : rendered ? '变了' : '没变'}` +
          `（期望 审计${t.flagged ? '报红' : '放过'}、像素${t.pixels ? '变了' : '没变'}）` +
          `　${note}${audit.bad[0] ? '　' + audit.bad[0] : ''}`
      )
      // 拆成两条：结构性审计这一半与画面稳不稳定无关，不该被基准问题连坐
      checks.push([`自证[${t.key}]：结构性审计${t.flagged ? '点名' : '放过'}它`, auditOk])
      checks.push([`自证[${t.key}]：像素结论与审计一致`, pixelOk])

      await drop(t.id)
      // 清场并等落定，给下一个变体一个干净的基准；
      // 没落定就把基准作废（置 null），后面的变体如实标「未测」。
      // 最后一个变体后面不用再等 —— 没人接着用它了（省两张截图 ≈ 1 分钟）
      if (t !== SELFTEST_VARIANTS[SELFTEST_VARIANTS.length - 1]) {
        const clean = await globeUntilStable(3)
        settled = clean.stable ? clean.hash : null
      }
    }
  }
}

await browser.close()

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(64))
for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`)
console.log('='.repeat(64))

const failed = checks.filter(([, ok]) => !ok)
if (failed.length) console.log(`\n✗ ${failed.length}/${checks.length} 项不通过`)
else console.log(`\n✓ ${checks.length} 项全部通过 —— 三组图层真的画在画面上，模拟的距离与方向都对得上`)
process.exit(failed.length ? 1 : 0)
