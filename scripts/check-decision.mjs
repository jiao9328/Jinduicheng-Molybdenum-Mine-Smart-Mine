/**
 * 决策指挥页专项检查（`#/decision`，改造后的单屏大屏形态）。
 *
 * 覆盖「看将来」这一层：产量趋势（计划 vs 实际）/ 设备利用率 / 工序效率 /
 * 损失贫化率趋势 / 安全指标 / 事故率趋势 / 隐患类型分布 /「三违」行为统计，
 * 以及**决策闭环**——智能辅助决策建议（可采纳）→ 决策工单跟踪。
 *
 * 用法：node scripts/check-decision.mjs [baseUrl] [--self-test]
 *
 * ── 2026-09-15 重写说明（原来那份已经跑不动了）─────────────────────
 * 原 `/decision` 是「成本效益 / 生产分析 / 安全分析 / 能耗单耗」四维切换的驾驶舱，
 * 本脚本靠 `.decision__dim` 的四个按钮逐维切过去读 DOM。那次拆分把这四条 Tab
 * 指向了**四条互不相同的路由**（用户报的「决策指挥和成本管理一模一样」就是
 * 两个 Tab 指同一个页面造成的），于是：
 *   · 成本效益 + 能耗单耗 两维整块搬去了 `/cost`（另见 `check-cost.mjs`）；
 *   · `/decision` 上不再有 `.decision__dim`，**原脚本第 153 行直接卡死**——
 *     `waitForSelector('.decision__dim')` 等一个已经不存在的类，30 秒后抛错。
 * 一个等不到元素的脚本不会「红」，它会**挂**在那儿，这比红更糟：
 * 接进 CI 就是一直转圈。所以这里按新页面重写，不是打补丁。
 *
 * ── 本脚本盯的三类错误 ───────────────────────────────────────────────
 * ① **同一个数在两个地方各写一份，还对不上**。大屏上最典型的一种：
 *    指标卡写「本月隐患上报 48」，隐患分布的环形图各段加起来是 45。
 *    两块面板颜色都对、都不报错，只有拿计算器核才发现。这类数**只在 canvas 里**，
 *    所以派生量被写进了面板底栏（如「合计 48 项，等于安全指标的上报数」），
 *    让它们变成 DOM 里可断言的事实 —— 底栏对看的人也有用，不是为检查加的脚手架。
 * ② **决策闭环是假的**。建议卡上的「采纳」点下去必须真的多出一条工单，
 *    状态能流转。这一条最容易做成「点了弹个 toast，列表纹丝不动」。
 * ③ **口径切换是假的**。「三违」那块面板把「按类别 / 按区队」做成切换按钮，
 *    两个口径切过去必须都渲染出来、且总数相等 —— 只切按钮不重算图，
 *    画面上是看不出破绽的（底栏文字跟着按钮变就行了，图还是老图）。
 *
 * ── 判据分两类，强度不一样，别混 ─────────────────────────────────────
 * **页面内自洽**：两个都在 DOM 里的数必须满足某个等式（如「底栏实际 == 指标卡本月产量」）。
 *   这类判据有真正的分辨力 —— 改任何一边都会红，所以**自证注入选的就是这一类**。
 * **规格常量**：需要跨路由比较、两个数从不同时在屏幕上的（如吨成本合计 128.60
 *   搬去了 `/cost`），只能把期望值写进下面的 `SPEC_*`。它只能抓「改了数据没改规格」
 *   的漂移，抓不到「规格本身就写错了」。**别当强判据用**。
 *
 * ── 拆分让哪条判据变弱了（如实记账，README §13 也有这一段）──────────
 * 「千人负伤率 = 事故起数 ÷ **在册职工 2400** × 1000」这条，原来是**三个数全在屏上**
 * 的自洽判据（事故率趋势的底栏写着分母）。新页面取消了那条底栏，分母只剩
 * `mock/decision.ts` 里的 `ACCIDENT_HEADCOUNT`。于是分母退化成脚本里的规格常量
 * `SPEC_HEADCOUNT`，判据从「三个屏上数互相印证」降级成「两个屏上数 + 一个脚本常量」。
 * 仍然能抓到「改了起数没改负伤率」，但抓不到「分母本身被改成 3000」。
 * **这是真的变弱了，不假装没变。**
 *
 * ── 一条判据纪律 ─────────────────────────────────────────────────────
 * `/api/*` 的 404 **不算错**：那是 requestWithFallback 在后端未就绪时的正常
 * 降级路径（真发请求 → 404 → 用内置数据渲染）。恒红的判据等于没有判据。
 *
 * 面板撑破 / 面板互相压住不在本脚本：`/decision` 整页在 check-panel-overflow 的
 * PAGES 里。三维联动也不在这里 —— 本页的联动走建议列表，判据在 check-linkage 那一套。
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'
import { clickAt } from './lib/click.mjs'

const argv = process.argv.slice(2)
const selfTest = argv.includes('--self-test')
const base = argv.find((a) => !a.startsWith('--')) || 'http://localhost:8787'

// ===========================================================================
// 硬编码规格 —— 不从 src 读。脚本去读被测代码的常量，两边一起改就永远绿了。
// ===========================================================================

/** 本页应当出现且仅出现的 10 块面板标题（按集合比对，顺序不计） */
const SPEC_PANELS = [
  '产量趋势（计划 vs 实际）',
  '设备利用率',
  '工序效率',
  '损失贫化率趋势',
  '安全指标',
  '事故率趋势',
  '隐患类型分布',
  '「三违」行为统计',
  '智能辅助决策建议',
  '决策工单跟踪'
]

/** 顶部 5 张指标卡（生产分析那一组，带环比/同比） */
const SPEC_METRICS = ['本月产量', '计划完成率', '设备综合利用率', '矿石损失率', '矿石贫化率']

/**
 * 「安全指标」面板里的 5 项。
 *
 * ⚠️ 它们在本页是 `.decision__kpi` 列表项，**不是 `.metric-card`**：
 * 一页上放 10 张同款指标卡就分不出主次了。读数的选择器要跟着改，
 * 不然会读回一个空数组，而 `sameSet([], spec)` 是**假**——还好，
 * 但更阴的是若规格也写成空数组，那就是恒真。
 */
const SPEC_KPIS = ['本月隐患上报', '隐患整改率', '本月「三违」', '本月事故起数', '千人负伤率']

/** 决策建议的类型，顺序即页面上的顺序 —— 第 4 条是 A4 那次「定价策略」修复的内容 */
const SPEC_SUGGESTION_TYPES = ['生产计划优化', '设备维保时机', '库存周转', '定价策略']

/** 「三违」两个口径的按钮文案 */
const SPEC_VIOLATION_VIEWS = ['按类别', '按区队']

// ---- 规格常量（两个数不同时在屏幕上，只能写死；见文件头「判据分两类」） ----
/** 在册职工数 —— 千人负伤率的分母（原页面写在这条面板的底栏上，现已在屏上取消） */
const SPEC_HEADCOUNT = 2400
/** 隐患整改率 = 整改完成 41 ÷ 上报 48（源数据是安全管理页那张闭环图） */
const SPEC_HAZARD_REPORTED = 48
const SPEC_HAZARD_RECTIFIED = 41

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`)
}

/** 按集合比对，顺序不计；两边都排序后接成串 */
const sameSet = (a, b) => [...a].sort().join('|') === [...b].sort().join('|')
const setDiff = (got, want) => {
  const missing = want.filter((t) => !got.includes(t))
  const extra = got.filter((t) => !want.includes(t))
  return [
    missing.length ? `缺 ${JSON.stringify(missing)}` : '',
    extra.length ? `多 ${JSON.stringify(extra)}` : ''
  ]
    .filter(Boolean)
    .join('、')
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

await page.goto(base + '/#/decision', { waitUntil: 'domcontentloaded', timeout: 90000 })

/**
 * 入口判据 —— 等的是**这一页真的有的东西**。
 *
 * ⚠️ 原来这里等 `.decision__dim`（四维按钮），拆分后那个类全库 0 处引用，
 * 脚本会一直等到超时。**等不存在的元素不会报「红」，它会挂住**，
 * 接进 CI 就是永远转圈。所以入口条件必须挂在本页此刻真实存在的结构上。
 */
await page.waitForSelector('.decision__main', { timeout: 60000 })
await page.waitForSelector('.decision__suggestion', { timeout: 60000 })
// 指标卡的数字是 NumberFlip 滚出来的（1200ms 缓出），读数前必须等它落位
await page.waitForTimeout(2500)

// ---------------------------------------------------------------------------
// DOM 读数：本页所有判据的原料都在这一个 evaluate 里取
// ---------------------------------------------------------------------------
const readDom = () =>
  page.evaluate(() => {
    const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    /**
     * 数字可能在文本里带千分位（`formatMetric` 对大数会加逗号），
     * `Number('2,400')` 是 NaN —— 而 NaN 参与的比较**恒假**，
     * 表现出来是「这条判据永远红」，很容易被误判成页面缺陷。先去掉逗号。
     */
    const num = (el) => Number(txt(el).replace(/,/g, ''))

    return {
      metrics: [...document.querySelectorAll('.metric-card')].map((c) => ({
        label: txt(c.querySelector('.metric-card__label')),
        value: num(c.querySelector('.number-flip')),
        unit: txt(c.querySelector('.metric-card__unit'))
      })),
      kpis: [...document.querySelectorAll('.decision__kpi')].map((li) => ({
        label: txt(li.querySelector('.decision__kpi-label')),
        value: num(li.querySelector('.decision__kpi-value')),
        unit: txt(li.querySelector('.decision__kpi-unit'))
      })),
      panels: [...document.querySelectorAll('.panel-box')].map((p) => ({
        title: txt(p.querySelector('.panel-box__title')),
        foot: txt(p.querySelector('.panel-box__foot'))
      })),
      /**
       * ⚠️ `.decision__suggestion-tag` 里是**两段**：
       * `<span class="decision__suggestion-tag">{{ s.type }} · {{ levelText(s.level) }}</span>`
       * —— 渲染出来是「生产计划优化 · 紧急」。所以这里按 `·` 拆开，
       * 类型那一段拿去比规格，级别那一段单独判「在不在」。
       *
       * 原来这里直接拿整段去比 `SPEC_SUGGESTION_TYPES`，判据是红的，
       * 报「缺 [四个类型]、多 [生产计划优化 · 紧急, ...]」。
       * 那不是页面错：规格管的是「这四条建议的类型对不对」，
       * **没有**管「标签上不许再写级别」。把渲染格式当成规格是判据自己的毛病。
       */
      suggestionTags: [...document.querySelectorAll('.decision__suggestion-tag')].map(txt),
      orderCount: document.querySelectorAll('.decision__order').length,
      violationViews: [...document.querySelectorAll('.decision__toggle')].map(txt)
    }
  })

const foot = (dom, title) => dom.panels.find((p) => p.title === title)?.foot ?? ''
const metric = (dom, label) => dom.metrics.find((m) => m.label === label)?.value ?? NaN
const kpi = (dom, label) => dom.kpis.find((k) => k.label === label)?.value ?? NaN

/** 从文本里抠出「关键字 后面的第一个数」 */
const pick = (s, re) => {
  const m = String(s).match(re)
  return m ? Number(m[1]) : NaN
}

// ---------------------------------------------------------------------------
// 甲：面板与指标卡的规格
// ---------------------------------------------------------------------------
console.log('\n### 甲、版面规格：10 块面板 + 5 张指标卡 + 5 项安全指标')
const dom = await readDom()

{
  const titles = dom.panels.map((p) => p.title)
  check(
    `面板标题与规格一致（${SPEC_PANELS.length} 块）`,
    sameSet(titles, SPEC_PANELS),
    sameSet(titles, SPEC_PANELS) ? `${titles.length} 块，无缺无多` : setDiff(titles, SPEC_PANELS)
  )

  const labels = dom.metrics.map((m) => m.label)
  check(
    `指标卡与规格一致（${SPEC_METRICS.length} 张）`,
    sameSet(labels, SPEC_METRICS),
    sameSet(labels, SPEC_METRICS) ? labels.join(' / ') : setDiff(labels, SPEC_METRICS)
  )

  const kpiLabels = dom.kpis.map((k) => k.label)
  check(
    `安全指标与规格一致（${SPEC_KPIS.length} 项）`,
    sameSet(kpiLabels, SPEC_KPIS),
    sameSet(kpiLabels, SPEC_KPIS) ? kpiLabels.join(' / ') : setDiff(kpiLabels, SPEC_KPIS)
  )

  const tags = dom.suggestionTags.map((t) => t.split('·').map((s) => s.trim()))
  const types = tags.map((p) => p[0])
  check(
    '决策建议 4 条的类型正是 docx §06 列举的四类（含「定价策略」那次修复）',
    sameSet(types, SPEC_SUGGESTION_TYPES),
    sameSet(types, SPEC_SUGGESTION_TYPES) ? types.join(' / ') : setDiff(types, SPEC_SUGGESTION_TYPES)
  )

  /**
   * 上面那条只比类型，所以「级别」有没有被丢掉它看不见 —— 补一条单独钉住。
   *
   * ⚠️ 这里**不写死级别是哪几个词**（紧急/一般/较低 是数据，不是规格）：
   * 判的是「每条标签都还是『类型 · 级别』两段、且级别那段非空」。
   * 这样哪天把级别整段删了、或者分隔符改了导致拆不开，都会红；
   * 而把「一般」改成「普通」这种纯文案改动不会误伤。
   */
  const badTag = tags.filter((p) => p.length !== 2 || !p[1]).map((p) => `「${p.join(' · ')}」`)
  check(
    '每条建议的标签都带上了紧急度（「类型 · 级别」两段，改文案可以，整段丢了不行）',
    badTag.length === 0,
    badTag.length ? `这 ${badTag.length} 条拆不出级别：${badTag.join('、')}` : `4 条都带级别，如「${dom.suggestionTags[0]}」`
  )
}

// ---------------------------------------------------------------------------
// 乙：产量与设备 —— 底栏的算式必须与指标卡对得上
// ---------------------------------------------------------------------------
console.log('\n### 乙、生产分析：底栏算式 ↔ 指标卡')

{
  const outFoot = foot(dom, '产量趋势（计划 vs 实际）')
  const rateInFoot = pick(outFoot, /完成率\s*([\d.]+)%/)
  const actualInFoot = pick(outFoot, /实际\s*([\d.]+)/)
  const planInFoot = pick(outFoot, /计划\s*([\d.]+)/)
  const cardOutput = metric(dom, '本月产量')
  const cardRate = metric(dom, '计划完成率')

  check(
    '产量趋势底栏的「实际」与指标卡「本月产量」是同一个数',
    Math.abs(actualInFoot - cardOutput) < 0.005,
    `底栏 ${actualInFoot} vs 指标卡 ${cardOutput}`
  )
  check(
    '底栏完成率 = 实际 ÷ 计划（自己跟自己算得上）',
    Math.abs((actualInFoot / planInFoot) * 100 - rateInFoot) < 0.005,
    `${actualInFoot} ÷ ${planInFoot} = ${((actualInFoot / planInFoot) * 100).toFixed(2)}%，底栏写 ${rateInFoot}%`
  )
  check(
    '底栏完成率与指标卡「计划完成率」是同一个数',
    Math.abs(rateInFoot - cardRate) < 0.005,
    `底栏 ${rateInFoot}% vs 指标卡 ${cardRate}%`
  )

  const avgInFoot = pick(foot(dom, '设备利用率'), /综合利用率\s*([\d.]+)%/)
  const cardUtil = metric(dom, '设备综合利用率')
  check(
    '设备利用率底栏的均值与指标卡「设备综合利用率」是同一个数',
    Math.abs(avgInFoot - cardUtil) < 0.005,
    `底栏 ${avgInFoot}% vs 指标卡 ${cardUtil}%`
  )

  check(
    '损失率 / 贫化率都在合理区间（0 < x < 20%）',
    metric(dom, '矿石损失率') > 0 &&
      metric(dom, '矿石损失率') < 20 &&
      metric(dom, '矿石贫化率') > 0 &&
      metric(dom, '矿石贫化率') < 20,
    `损失 ${metric(dom, '矿石损失率')}% / 贫化 ${metric(dom, '矿石贫化率')}%`
  )
}

// ---------------------------------------------------------------------------
// 丙：安全 —— 隐患分布各段之和、「三违」两个口径、千人负伤率
// ---------------------------------------------------------------------------
console.log('\n### 丙、安全分析：图里的数 ↔ 安全指标')

{
  // ---- 隐患类型分布各段之和 == 安全指标「本月隐患上报」 ----
  const hazardSum = pick(foot(dom, '隐患类型分布'), /合计\s*([\d.]+)\s*项/)
  const kpiReported = kpi(dom, '本月隐患上报')
  check(
    '隐患类型各段之和 == 安全指标「本月隐患上报」',
    hazardSum === kpiReported && kpiReported > 0,
    `底栏合计 ${hazardSum} vs 安全指标 ${kpiReported}`
  )
  check(
    `…而且上报数就是闭环图上的 ${SPEC_HAZARD_REPORTED} 项（与安全管理页同源，规格常量）`,
    kpiReported === SPEC_HAZARD_REPORTED,
    `实测 ${kpiReported}，规格 ${SPEC_HAZARD_REPORTED}`
  )

  // ---- 「三违」：两个口径各自渲染，总数相等，且都 == 安全指标 ----
  check(
    `「三违」面板给了两个口径的切换按钮（${SPEC_VIOLATION_VIEWS.join(' / ')}）`,
    sameSet(dom.violationViews, SPEC_VIOLATION_VIEWS),
    sameSet(dom.violationViews, SPEC_VIOLATION_VIEWS)
      ? dom.violationViews.join(' / ')
      : setDiff(dom.violationViews, SPEC_VIOLATION_VIEWS)
  )

  /**
   * 逐个口径切过去读底栏 —— 这一步是这次重写**新增**的判据，也是唯一能抓住
   * 「切了按钮但图没重算」的办法。
   *
   * 原来两个口径是**并排两块面板**（「按类别」+「按区队」），两块同时在屏上，
   * 各读各的就行；现在合成一块面板靠切换，于是「切过去到底重没重画」
   * 只有切了才知道。若实现成「按钮高亮变了、图还是老图」，底栏文字照样跟着变
   * （它绑的是同一个 `violationView`），**光看文字是发现不了的** ——
   * 所以下面同时断言两个口径各自的段数与底栏总数，两处都得动。
   */
  const kpiViol = kpi(dom, '本月「三违」')
  const perView = []
  for (const label of SPEC_VIOLATION_VIEWS) {
    await page.locator('.decision__toggle', { hasText: label }).click()
    await page.waitForTimeout(1200)
    const sum = await page.evaluate(
      (lbl) => {
        const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
        const buttons = [...document.querySelectorAll('.decision__toggle')]
        const btn = buttons.find((b) => txt(b) === lbl)
        const panel = btn?.closest('.panel-box')
        return {
          foot: txt(panel?.querySelector('.panel-box__foot')),
          /** 图元个数 —— 「图真的换了」不能靠底栏文字，得看画布里的段数 */
          bars: panel?.querySelectorAll('.echart-box canvas').length ?? 0,
          /**
           * ⚠️ 取的是**所有**按钮里亮着的那些，不是「我刚点的那个亮没亮」。
           *
           * 原来只读被点的那一个（`btn.classList.contains('is-active')`），
           * 于是这条判据实际上只验了「点它有反应」—— 两个按钮**同时亮着**
           * 它照样绿，而标题上却写着「另一个不是」。
           * 那个漏检漏掉的正是用户最初报的毛病：顶栏点「统计报表」时
           * 「智能监控」**同时高亮**（README §13 第 31 条）。
           * 同一类缺陷不该在两个地方只堵住一个。
           */
          activeLabels: buttons.filter((b) => b.classList.contains('is-active')).map(txt)
        }
      },
      label
    )
    perView.push({ label, ...sum, total: pick(sum.foot, /均为\s*([\d.]+)\s*次/) })
  }

  check(
    '两个口径的底栏总数相等（同一批行为换个切法，总数不该变）',
    perView.length === 2 && perView[0].total === perView[1].total && perView[0].total > 0,
    perView.map((v) => `${v.label} ${v.total}`).join(' vs ')
  )
  check(
    '两个口径的底栏总数都 == 安全指标「本月「三违」」',
    perView.every((v) => v.total === kpiViol) && kpiViol > 0,
    `${perView.map((v) => v.total).join('/')} vs 安全指标 ${kpiViol}`
  )
  const badActive = perView.filter((v) => !(v.activeLabels.length === 1 && v.activeLabels[0] === v.label))
  check(
    '切过去的那一个按钮是 active、另一个不是（同时亮两个就是切换没生效）',
    perView.length === 2 && badActive.length === 0,
    perView.map((v) => `点「${v.label}」时亮着 [${v.activeLabels.join('、')}]`).join('；')
  )
  check(
    '两个口径的画布都在（切过去不是把图切没了）',
    perView.every((v) => v.bars > 0),
    perView.map((v) => `${v.label} ${v.bars} 张画布`).join(' / ')
  )

  // ---- 千人负伤率 == 起数 ÷ 在册职工 × 1000 ----
  // ⚠️ 分母现在只在脚本里（原页面那条底栏取消了），判据强度见文件头「变弱了」一段
  const kpiCount = kpi(dom, '本月事故起数')
  const kpiRate = kpi(dom, '千人负伤率')
  const want = (kpiCount / SPEC_HEADCOUNT) * 1000
  check(
    `千人负伤率 = 事故起数 ÷ ${SPEC_HEADCOUNT} × 1000（分母是脚本常量，不是屏上的数）`,
    kpiCount > 0 && Math.abs(kpiRate - want) < 0.005,
    `${kpiCount} ÷ ${SPEC_HEADCOUNT} × 1000 = ${want.toFixed(2)}，安全指标 ${kpiRate}`
  )

  // ---- 隐患整改率 = 整改完成 ÷ 上报（闭环的第二、四环，来自安全管理页） ----
  const kpiRect = kpi(dom, '隐患整改率')
  const wantRect = (SPEC_HAZARD_RECTIFIED / SPEC_HAZARD_REPORTED) * 100
  check(
    `隐患整改率 = ${SPEC_HAZARD_RECTIFIED} ÷ ${SPEC_HAZARD_REPORTED} = ${wantRect.toFixed(2)}%（与安全管理页的闭环同源）`,
    Math.abs(kpiRect - wantRect) < 0.005,
    `实测 ${kpiRect}%，${SPEC_HAZARD_RECTIFIED}/${SPEC_HAZARD_REPORTED} = ${wantRect.toFixed(2)}%`
  )
}

// ---------------------------------------------------------------------------
// 丁：决策闭环 —— 采纳建议必须真的多出一条工单
// ---------------------------------------------------------------------------
console.log('\n### 丁、决策闭环：建议 → 采纳 → 工单')

{
  check(
    '决策工单跟踪面板已在页面上（哪怕一条工单都没有，面板本身要在）',
    dom.panels.some((p) => p.title === '决策工单跟踪'),
    `初始 ${dom.orderCount} 条工单`
  )

  /**
   * 点第一条建议的「采纳」→ 填责任人/期限 → 确认，然后断言工单列表**多了一条**。
   *
   * ⚠️ 判据落在「列表条数 +1」上，不落在「弹了个提示」上：后者是典型的
   * 「点了有反应、其实没落库」。后端未就绪时页面按设计走「未落库·演示」那条路
   * （`createDecisionOrder` 返回 null），**本地仍会乐观插入一条**，
   * 所以条数照样 +1 —— 这条判据在两种后端状态下都成立，不是恒真也不是恒假。
   */
  const before = dom.orderCount
  let after = before
  let acted = ''
  try {
    /**
     * 「采纳」按钮按 `store.isAdmin` 条件渲染（照 HazardDisposal 的先例）——
     * 本脚本用 admin 账号登录（见 lib/session.mjs），所以它必须在。
     *
     * ⚠️ 这两下点击**必须**走 `clickAt`，不能再用 `locator.click()`。
     * 上一版就是被它卡死的：
     *   `locator.click: Timeout 10000ms exceeded. - waiting for locator('.decision__suggestion-act')`
     * 报出来却是「操作失败 …；工单 2 → 2 条」——**看上去像采纳功能坏了**，
     * 其实只是探针点不下去。坑的成因与适用范围见 `lib/click.mjs` 文件头。
     */
    const r1 = await clickAt(page, '.decision__suggestion-act', { timeout: 15000 })
    if (!r1.ok) throw new Error(r1.reason)
    // 采纳表单是**内联在这一条里**的（不弹窗），填完点「生成工单」
    await page.waitForSelector('.decision__adopt', { timeout: 10000 })
    await page.locator('.decision__adopt-input').first().fill('巡检脚本', { timeout: 10000 })
    const r2 = await clickAt(page, '.decision__adopt-ok', { timeout: 15000 })
    if (!r2.ok) throw new Error(r2.reason)

    /**
     * 等的是**可观察的效果**（工单条数真的变多），不是等一个时长。
     * 写接口要走一个来回：固定时长要么白等、要么不够 ——
     * 这条教训在 README §13 第 31 条的 ③ 里，同一轮里已经犯过一次。
     */
    const grew = await page
      .waitForFunction((n) => document.querySelectorAll('.decision__order').length > n, before, {
        timeout: 15000,
        polling: 200
      })
      .then(() => true)
      .catch(() => false)
    after = await page.evaluate(() => document.querySelectorAll('.decision__order').length)
    acted = grew ? '已点采纳并生成工单' : `点了采纳，15 秒内工单条数没变（${before} → ${after}）`
  } catch (err) {
    acted = `操作失败：${String(err.message || err).replace(/\s+/g, ' ').slice(0, 120)}`
  }

  check(
    '点「采纳」并生成工单后，工单列表真的多了一条（不是只弹了个提示）',
    after === before + 1,
    `${acted}；工单 ${before} → ${after} 条`
  )
}

// ===========================================================================
// 自证：注入缺陷，要求判据当场翻红
// ===========================================================================
if (selfTest) {
  console.log('\n### 自证（注入缺陷，要求判据当场翻红）')

  // 判据写进 evaluate 里（不在外面抽函数）是有意的：
  // 必须**注入 → 判定 → 还原**全在同一个同步任务里做完，中间不让出控制权。
  // 一旦中间有 await，Vue 的微任务可能重渲染把注入冲掉，判据读到的就还是好数据，
  // 「没翻红」于是成了脚本自己的假阴性。

  // ---- S1：把产量趋势底栏的「实际」改成别的数 ----
  const s1 = await page.evaluate(() => {
    const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const panelOf = (title) =>
      [...document.querySelectorAll('.panel-box')].find(
        (p) => txt(p.querySelector('.panel-box__title')) === title
      )
    const footOf = (title) => panelOf(title)?.querySelector('.panel-box__foot')
    const read = () => {
      const num = (el) => Number(txt(el).replace(/,/g, ''))
      const pick = (s, re) => {
        const m = String(s).match(re)
        return m ? Number(m[1]) : NaN
      }
      const card = [...document.querySelectorAll('.metric-card')].find(
        (c) => txt(c.querySelector('.metric-card__label')) === '本月产量'
      )
      const bad = []
      const actual = pick(txt(footOf('产量趋势（计划 vs 实际）')), /实际\s*([\d.]+)/)
      const cardOutput = num(card?.querySelector('.number-flip'))
      if (!(Math.abs(actual - cardOutput) < 0.005)) {
        bad.push(`底栏实际 ${actual} ≠ 指标卡本月产量 ${cardOutput}`)
      }
      return bad
    }

    const before = read().length
    const el = footOf('产量趋势（计划 vs 实际）')
    const original = el.textContent
    const m = original.match(/实际\s*([\d.]+)/)
    el.textContent = original.replace(/实际\s*[\d.]+/, `实际 ${(Number(m[1]) + 7).toFixed(1)}`)
    const after = read().length
    el.textContent = original
    const restored = read().length
    return { before, after, restored }
  })
  check(
    'S1 改坏产量趋势底栏的「实际」⇒ 等式判据当场报出这一处',
    s1.before === 0 && s1.after === 1 && s1.restored === 0,
    `注入前 ${s1.before} → 注入后 ${s1.after} → 还原 ${s1.restored}`
  )

  // ---- S2：把隐患分布底栏的合计改成 47 ----
  const s2 = await page.evaluate(() => {
    const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const panelOf = (title) =>
      [...document.querySelectorAll('.panel-box')].find(
        (p) => txt(p.querySelector('.panel-box__title')) === title
      )
    const read = () => {
      const pick = (s, re) => {
        const m = String(s).match(re)
        return m ? Number(m[1]) : NaN
      }
      const foot = txt(panelOf('隐患类型分布')?.querySelector('.panel-box__foot'))
      const li = [...document.querySelectorAll('.decision__kpi')].find(
        (x) => txt(x.querySelector('.decision__kpi-label')) === '本月隐患上报'
      )
      const reported = Number(txt(li?.querySelector('.decision__kpi-value')).replace(/,/g, ''))
      const bad = []
      const sum = pick(foot, /合计\s*([\d.]+)\s*项/)
      if (!(sum === reported && reported > 0)) {
        bad.push(`隐患类型合计 ${sum} ≠ 安全指标上报 ${reported}`)
      }
      return bad
    }

    const before = read().length
    const el = panelOf('隐患类型分布').querySelector('.panel-box__foot')
    const original = el.textContent
    el.textContent = original.replace(/合计\s*[\d.]+\s*项/, '合计 47 项')
    const after = read().length
    el.textContent = original
    const restored = read().length
    return { before, after, restored }
  })
  check(
    'S2 把隐患分布底栏的合计改成 47 ⇒ 等式判据当场报出这一处',
    s2.before === 0 && s2.after === 1 && s2.restored === 0,
    `注入前 ${s2.before} → 注入后 ${s2.after} → 还原 ${s2.restored}`
  )

  // ---- S3：「三违」口径切换 —— 只点亮按钮、图不重算，必须能被抓到 ----
  //
  // 这一条是这次重写新增的，注入的正是它要防的那个缺陷：
  // 把「按区队」那一次的底栏总数改成别的数（等价于「切过去了但数据没跟着换」）。
  // 若判据只看底栏文字是否随按钮变化，这里不会红 —— 所以我们同时断言总数相等。
  const s3 = await page.evaluate(() => {
    const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const footOfViol = () => {
      const btn = document.querySelector('.decision__toggle.is-active')
      return btn?.closest('.panel-box')?.querySelector('.panel-box__foot')
    }
    const read = () => {
      const pick = (s, re) => {
        const m = String(s).match(re)
        return m ? Number(m[1]) : NaN
      }
      const li = [...document.querySelectorAll('.decision__kpi')].find(
        (x) => txt(x.querySelector('.decision__kpi-label')) === '本月「三违」'
      )
      const viol = Number(txt(li?.querySelector('.decision__kpi-value')).replace(/,/g, ''))
      const total = pick(txt(footOfViol()), /均为\s*([\d.]+)\s*次/)
      return !(total === viol && viol > 0) ? [`口径总数 ${total} ≠ 安全指标 ${viol}`] : []
    }

    const el = footOfViol()
    if (!el) return { before: -1, after: -1, restored: -1 }
    const before = read().length
    const original = el.textContent
    const m = original.match(/均为\s*([\d.]+)/)
    el.textContent = original.replace(/均为\s*[\d.]+/, `均为 ${Number(m[1]) + 3}`)
    const after = read().length
    el.textContent = original
    const restored = read().length
    return { before, after, restored }
  })
  check(
    'S3 改坏当前口径底栏的总数 ⇒「口径总数 == 安全指标」当场报出这一处',
    s3.before === 0 && s3.after === 1 && s3.restored === 0,
    `注入前 ${s3.before} → 注入后 ${s3.after} → 还原 ${s3.restored}`
  )
  // ---- S4：把建议标签的「级别」整段抹掉 ----
  //
  // 钉的是上面那条新判据。比类型的那一条**看不见这个缺陷** ——
  // 它只取 `·` 前面那一段，后面有没有东西它不管。所以「标签带着级别」
  // 这件事必须单独验一次，否则那条新判据就成了「从没见过它变红」的那种，
  // 按《补充件 3》§1.3 不算证据。
  const s4 = await page.evaluate(() => {
    const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const tags = () => [...document.querySelectorAll('.decision__suggestion-tag')]
    const read = () =>
      tags()
        .map((t) => txt(t).split('·').map((s) => s.trim()))
        .filter((p) => p.length !== 2 || !p[1])
        .map((p) => p.join(' · '))

    const el = tags()[0]
    if (!el) return { before: -1, after: -1, restored: -1 }
    const before = read().length
    const original = el.textContent
    // 只留类型那一段，级别连同分隔符一起去掉
    el.textContent = txt(el).split('·')[0].trim()
    const after = read().length
    el.textContent = original
    const restored = read().length
    return { before, after, restored }
  })
  check(
    'S4 抹掉建议标签的紧急度 ⇒「每条都带级别」当场报出这一处',
    s4.before === 0 && s4.after === 1 && s4.restored === 0,
    `注入前 ${s4.before} → 注入后 ${s4.after} → 还原 ${s4.restored}`
  )
  // ---- S5：把两个口径按钮**同时**点亮 ----
  //
  // 钉的是「另一个不是 active」。它正是原来漏掉的那个漏检：
  // 判据当时只读**被点的那个**按钮亮没亮，两个同时亮着也照样绿。
  // 注入后必须当场报出「亮着 [按类别、按区队]」。
  const s5 = await page.evaluate(() => {
    const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const buttons = () => [...document.querySelectorAll('.decision__toggle')]
    /** 与主流程同一条判据：亮着的**恰好**是刚点的那个 */
    const read = (clicked) => {
      const on = buttons().filter((b) => b.classList.contains('is-active')).map(txt)
      return on.length === 1 && on[0] === clicked ? [] : [`点「${clicked}」时亮着 [${on.join('、')}]`]
    }

    const active = buttons().find((b) => b.classList.contains('is-active'))
    const other = buttons().find((b) => !b.classList.contains('is-active'))
    if (!active || !other) return { before: -1, after: -1, restored: -1 }
    const clicked = txt(active)

    const before = read(clicked).length
    other.classList.add('is-active')
    const after = read(clicked).length
    other.classList.remove('is-active')
    const restored = read(clicked).length
    return { before, after, restored }
  })
  check(
    'S5 把两个口径按钮同时点亮 ⇒「另一个不是 active」当场报出这一处',
    s5.before === 0 && s5.after === 1 && s5.restored === 0,
    `注入前 ${s5.before} → 注入后 ${s5.after} → 还原 ${s5.restored}`
  )
} else {
  console.log('\n### 自证：跳过（加 --self-test 运行）')
}

// ---------------------------------------------------------------------------
console.log('\n### 控制台与网络')
check('没有非 /api 的控制台错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '干净')
check('没有非 /api 的失败请求', failedUrls.length === 0, failedUrls.slice(0, 3).join(' | ') || '干净')
// /api 的 404 是降级路径，不是错；但如果一个都没出现，说明这一页压根没走接口层
check('/api 走的是降级路径（404 后回落到 mock）', apiMisses.length > 0, `${apiMisses.length} 次`)

await browser.close()

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok)
console.log(
  `\n合计 ${checks.length} 项，失败 ${failed.length} 项` +
    `${selfTest ? '（含 --self-test：注入五处缺陷，要求判据当场翻红）' : '（未跑自证，加 --self-test）'}`
)
for (const f of failed) console.log(`  ✗ ${f.name}`)
process.exit(failed.length ? 1 : 0)
