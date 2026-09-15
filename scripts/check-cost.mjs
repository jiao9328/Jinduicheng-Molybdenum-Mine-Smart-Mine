/**
 * 成本管理页专项检查（`#/cost`，2026-09-15 从 `/decision` 拆出来的独立路由）。
 *
 * 覆盖「看花钱」这一层：吨成本拆解 / 峰谷平电费 / 各类型成本分布 / 前 5 大支出项 /
 * 能耗构成 / 单耗趋势 / 单机成本。
 *
 * 用法：node scripts/check-cost.mjs [baseUrl] [--self-test]
 *
 * ── 为什么要有这个脚本（不是「顺手多写一个」）─────────────────────────
 * 拆路由之前，这 7 块面板里最要紧的几条自洽判据（「峰谷平底栏电费 == 月电费指标卡」
 * 之类）是挂在 `check-decision.mjs` 的「能耗单耗」维上的。页面一拆，那些面板
 * 整块搬到了 `/cost`，如果只改 `check-decision.mjs` 而不把这批判据一起搬过来，
 * **它们就静默消失了** —— 脚本还是绿的，覆盖却少了一大块。
 * 所以这是搬迁，不是新增：下面的等式判据与 `check-decision.mjs` 旧版里的
 * 「能耗单耗」一节逐条对应，只是换了个页面读。
 *
 * ── 本脚本盯的两类错误 ───────────────────────────────────────────────
 * ① **同一笔钱在两张卡上各写一份，还对不上**。大屏上最典型的一种：
 *    指标卡写「月电费 412.3 万元」，峰谷平那块图的三段电费加起来是 398.6 ——
 *    两张卡颜色都对、都不报错，只有拿计算器核才发现。这些派生量都写进了面板底栏
 *    （如「合计 612.4 万kWh · 电费 412.3 万元」），让它们变成 DOM 里可断言的事实；
 *    底栏对看的人也有用，不是为检查加的脚手架。
 * ② **吨成本拆解的五项与数据源标称的 total 分叉**。这一条页面自己会红着写出来
 *    （`.cost__mismatch`），脚本要断言它**不存在** —— 页面提示了、
 *    但没人看提示跟「没提示」是一回事，得有东西替人盯着。
 *
 * ── 判据分两类，强度不一样，别混 ─────────────────────────────────────
 * **页面内自洽**：两个都在 DOM 里的数必须满足某个等式（如「底栏电费 == 指标卡月电费」）。
 *   这类判据有真正的分辨力 —— 改任何一边都会红，所以**自证注入选的就是这一类**。
 * **规格常量**：需要跨路由比较、两个数从不同时在屏幕上的（如吨矿电耗要拿
 *   `/decision` 的月产量当分母），只能把期望值写进下面的 `SPEC_*`。
 *   它只能抓「改了数据没改规格」的漂移，抓不到「规格本身就写错了」。**别当强判据用**。
 *
 * ── 一条判据纪律 ─────────────────────────────────────────────────────
 * `/api/*` 的 404 **不算错**：那是 requestWithFallback 在后端未就绪时的正常
 * 降级路径（真发请求 → 404 → 用内置数据渲染）。恒红的判据等于没有判据。
 *
 * 面板撑破 / 面板互相压住不在本脚本：`/cost` 整页在 check-panel-overflow 的 PAGES 里。
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'

const argv = process.argv.slice(2)
const selfTest = argv.includes('--self-test')
const base = argv.find((a) => !a.startsWith('--')) || 'http://localhost:8787'

// ===========================================================================
// 硬编码规格 —— 不从 src 读。脚本去读被测代码的常量，两边一起改就永远绿了。
// ===========================================================================

/** 本页应当出现且仅出现的 7 块面板标题（按集合比对，顺序不计） */
const SPEC_PANELS = [
  '吨成本拆解',
  '峰谷平电费',
  '各类型成本分布',
  '前 5 大支出项',
  '能耗构成',
  '单耗趋势',
  '单机成本'
]

/** 顶部 5 张指标卡 */
const SPEC_METRICS = ['吨成本', '月电费', '月用电量', '月用水量', '吨矿电耗']

/** 「前 5 大支出项」的条数与金额（万元），顺序即页面顺序，**降序是这张表的语义** */
const SPEC_TOP_EXPENSES = [391, 268, 156, 118, 86]

// ---- 规格常量（跨路由，两个数不同时在屏幕上，只能写死；见文件头「判据分两类」） ----
/** 吨成本拆解五项之和 —— docx §06「成本效益」维逐像素要求保留的那个锚点 */
const SPEC_TON_COST = 128.6
/** 生产分析维 6 月的实际产量（万吨）—— 吨矿电耗 / 吨矿水耗拿它当分母，那个数在 `/decision` */
const SPEC_OUTPUT = 46.9
/** 单机成本月合计（万元）= Σ 单机成本 × 台数 */
const SPEC_MACHINE_TOTAL = 277.0

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

await page.goto(base + '/#/cost', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForSelector('.cost__main', { timeout: 60000 })
await page.waitForSelector('.cost__metrics .metric-card', { timeout: 60000 })
// 指标卡的数字是 NumberFlip 滚出来的（1200ms 缓出），读数前必须等它落位
await page.waitForTimeout(2500)

// ---------------------------------------------------------------------------
// DOM 读数
// ---------------------------------------------------------------------------
const dom = await page.evaluate(() => {
  const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  /**
   * 数字可能在文本里带千分位（`formatMetric` 对大数会加逗号），
   * `Number('2,400')` 是 NaN —— 而 NaN 参与的比较**恒假**，
   * 表现出来是「这条判据永远红」，很容易被误判成页面缺陷。先去掉逗号。
   */
  const num = (el) => Number(txt(el).replace(/,/g, ''))

  return {
    metrics: [...document.querySelectorAll('.cost__metrics .metric-card')].map((c) => ({
      label: txt(c.querySelector('.metric-card__label')),
      value: num(c.querySelector('.number-flip')),
      unit: txt(c.querySelector('.metric-card__unit'))
    })),
    panels: [...document.querySelectorAll('.panel-box')].map((p) => ({
      title: txt(p.querySelector('.panel-box__title')),
      foot: txt(p.querySelector('.panel-box__foot'))
    })),
    /** 吨成本拆解的五项与数据源标称 total 对不上时，页面会红着写出这一行 */
    mismatch: txt(document.querySelector('.cost__mismatch')),
    /** 前 5 大支出项表格里的金额列（万元） */
    expenses: [...document.querySelectorAll('.cost__amount')].map(num),
    /** 可点的图表（吨成本拆解 / 各类型成本分布 / 单机成本）的手形光标 */
    clickableCursors: [...document.querySelectorAll('.echart-box.is-clickable')].map(
      (b) => getComputedStyle(b).cursor
    )
  }
})

const foot = (title) => dom.panels.find((p) => p.title === title)?.foot ?? ''
const metric = (label) => dom.metrics.find((m) => m.label === label)?.value ?? NaN
const pick = (s, re) => {
  const m = String(s).match(re)
  return m ? Number(m[1]) : NaN
}

// ---------------------------------------------------------------------------
// 甲：版面规格
// ---------------------------------------------------------------------------
console.log('\n### 甲、版面规格：7 块面板 + 5 张指标卡')

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
}

// ---------------------------------------------------------------------------
// 乙：同一笔钱在两张卡上必须对得上（页面内自洽，强判据）
// ---------------------------------------------------------------------------
console.log('\n### 乙、同一笔钱的两种写法必须对得上')

{
  // ---- 峰谷平底栏 ↔ 月用电量 / 月电费 指标卡 ----
  const tariffFoot = foot('峰谷平电费')
  const kwhInFoot = pick(tariffFoot, /合计\s*([\d.]+)\s*万kWh/)
  const costInFoot = pick(tariffFoot, /电费\s*([\d.]+)\s*万元/)
  check(
    '峰谷平底栏的电量合计 == 指标卡「月用电量」',
    Math.abs(kwhInFoot - metric('月用电量')) < 0.05,
    `底栏 ${kwhInFoot} vs 指标卡 ${metric('月用电量')}`
  )
  check(
    '峰谷平底栏的电费合计 == 指标卡「月电费」',
    Math.abs(costInFoot - metric('月电费')) < 0.05,
    `底栏 ${costInFoot} vs 指标卡 ${metric('月电费')}`
  )

  // ---- 能耗构成里的「电力」== 峰谷平三段电费之和 ----
  const mixElectric = pick(foot('能耗构成'), /电力\s*([\d.]+)\s*万元/)
  check(
    '能耗构成的「电力」== 峰谷平三段电费之和',
    Math.abs(mixElectric - costInFoot) < 0.05,
    `能耗构成 ${mixElectric} 万元 vs 峰谷平电费 ${costInFoot} 万元`
  )

  /**
   * ---- 吨成本拆解五项之和 ↔ 指标卡「吨成本」 ----
   *
   * 这两处**必须**相等：指标卡取的正是 `tonSum`（五项之和），不取数据源的 `total`，
   * 所以它是全页最硬的一条自洽判据 —— 拆解五项里任何一项被改，两张卡同时红。
   */
  const tonSum = pick(foot('吨成本拆解'), /五项合计\s*([\d.]+)/)
  check(
    '吨成本拆解五项合计 == 指标卡「吨成本」',
    Math.abs(tonSum - metric('吨成本')) < 0.05,
    `底栏 ${tonSum} vs 指标卡 ${metric('吨成本')}`
  )
  check(
    '…而且数据源标称的 total 与五项之和一致（页面没写出「对不上」那行红字）',
    dom.mismatch === '',
    dom.mismatch || '无告警，两边一致'
  )
  check(
    `…合计本身还是 ${SPEC_TON_COST} 元/吨（docx §06 的锚点，规格常量）`,
    Math.abs(tonSum - SPEC_TON_COST) < 0.05,
    `实测 ${tonSum}，规格 ${SPEC_TON_COST}`
  )

  // ---- 吨矿电耗 == 月用电量 ÷ 月产量 ----
  // ⚠️ 分母（月产量）在 `/decision` 上，本页屏幕里没有，只能用规格常量
  const wantPerTon = metric('月用电量') / SPEC_OUTPUT
  check(
    `吨矿电耗 = 月用电量 ÷ 月产量（${SPEC_OUTPUT} 万吨在 /decision 上，此处是脚本常量）`,
    Math.abs(metric('吨矿电耗') - wantPerTon) < 0.05,
    `${metric('月用电量')} ÷ ${SPEC_OUTPUT} = ${wantPerTon.toFixed(2)}，指标卡 ${metric('吨矿电耗')}`
  )

  // ---- 单机成本月合计 ----
  const machineSum = pick(foot('单机成本'), /月合计\s*([\d.]+)\s*万元/)
  check(
    `单机成本月合计 = ${SPEC_MACHINE_TOTAL} 万元（Σ 单机成本 × 台数，规格常量）`,
    Math.abs(machineSum - SPEC_MACHINE_TOTAL) < 0.05,
    `实测 ${machineSum}`
  )
}

// ---------------------------------------------------------------------------
// 丙：前 5 大支出项
// ---------------------------------------------------------------------------
console.log('\n### 丙、前 5 大支出项')

{
  check(
    `表里正好 ${SPEC_TOP_EXPENSES.length} 行（「前 5 大」写的是 5 就是 5）`,
    dom.expenses.length === SPEC_TOP_EXPENSES.length,
    `实测 ${dom.expenses.length} 行：${dom.expenses.join(' / ')}`
  )
  check(
    '金额降序 —— 这是「前 5 大」这张表的语义，排错了表名就不成立',
    dom.expenses.every((v, i) => i === 0 || dom.expenses[i - 1] >= v),
    dom.expenses.join(' ≥ ')
  )
  check(
    `金额与规格一致（${SPEC_TOP_EXPENSES.join(' / ')} 万元）`,
    JSON.stringify(dom.expenses) === JSON.stringify(SPEC_TOP_EXPENSES),
    `实测 ${dom.expenses.join(' / ')}`
  )
}

// ---------------------------------------------------------------------------
// 丁：可点的图表给了手形光标
// ---------------------------------------------------------------------------
console.log('\n### 丁、联动入口的可见性')

{
  /**
   * 本页三块图是可点的（吨成本拆解 / 各类型成本分布 / 单机成本），各自有浮层。
   * 「能不能点」这件事只能靠光标提示 —— 没有提示，用户根本不会去点，
   * 这个功能等于不存在（且**不报错**）。所以这条虽然不是数据判据，也得有人盯。
   */
  check(
    '三块可点的图表都给了手形光标（不然用户不知道能点）',
    dom.clickableCursors.length === 3 && dom.clickableCursors.every((c) => c === 'pointer'),
    `${dom.clickableCursors.length} 块：${dom.clickableCursors.join(' / ') || '一块都没有'}`
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

  // ---- S1：把峰谷平底栏的电费改成别的数 ----
  const s1 = await page.evaluate(() => {
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
      const card = [...document.querySelectorAll('.cost__metrics .metric-card')].find(
        (c) => txt(c.querySelector('.metric-card__label')) === '月电费'
      )
      const cardCost = Number(txt(card?.querySelector('.number-flip')).replace(/,/g, ''))
      const inFoot = pick(txt(panelOf('峰谷平电费')?.querySelector('.panel-box__foot')), /电费\s*([\d.]+)\s*万元/)
      return !(Math.abs(inFoot - cardCost) < 0.05)
        ? [`峰谷平底栏电费 ${inFoot} ≠ 指标卡月电费 ${cardCost}`]
        : []
    }

    const before = read().length
    const el = panelOf('峰谷平电费').querySelector('.panel-box__foot')
    const original = el.textContent
    const m = original.match(/电费\s*([\d.]+)\s*万元/)
    el.textContent = original.replace(/电费\s*[\d.]+\s*万元/, `电费 ${(Number(m[1]) + 111).toFixed(1)} 万元`)
    const after = read().length
    el.textContent = original
    const restored = read().length
    return { before, after, restored }
  })
  check(
    'S1 改坏峰谷平底栏的电费 ⇒ 等式判据当场报出这一处',
    s1.before === 0 && s1.after === 1 && s1.restored === 0,
    `注入前 ${s1.before} → 注入后 ${s1.after} → 还原 ${s1.restored}`
  )

  // ---- S2：把吨成本拆解底栏的五项合计改成别的数 ----
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
      const card = [...document.querySelectorAll('.cost__metrics .metric-card')].find(
        (c) => txt(c.querySelector('.metric-card__label')) === '吨成本'
      )
      const cardTon = Number(txt(card?.querySelector('.number-flip')).replace(/,/g, ''))
      const sum = pick(txt(panelOf('吨成本拆解')?.querySelector('.panel-box__foot')), /五项合计\s*([\d.]+)/)
      return !(Math.abs(sum - cardTon) < 0.05)
        ? [`吨成本拆解合计 ${sum} ≠ 指标卡吨成本 ${cardTon}`]
        : []
    }

    const before = read().length
    const el = panelOf('吨成本拆解').querySelector('.panel-box__foot')
    const original = el.textContent
    const m = original.match(/五项合计\s*([\d.]+)/)
    el.textContent = original.replace(/五项合计\s*[\d.]+/, `五项合计 ${(Number(m[1]) + 9).toFixed(1)}`)
    const after = read().length
    el.textContent = original
    const restored = read().length
    return { before, after, restored }
  })
  check(
    'S2 改坏吨成本拆解底栏的合计 ⇒ 等式判据当场报出这一处',
    s2.before === 0 && s2.after === 1 && s2.restored === 0,
    `注入前 ${s2.before} → 注入后 ${s2.after} → 还原 ${s2.restored}`
  )

  // ---- S3：把能耗构成的「电力」改成别的数 ----
  // 这一条与 S1 是**不同的两个等式**（能耗构成 ↔ 峰谷平），共用峰谷平那个数当右端。
  // 只证明 S1 能红，说明不了这条也活着 —— 各注一次。
  const s3 = await page.evaluate(() => {
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
      const tariff = pick(txt(panelOf('峰谷平电费')?.querySelector('.panel-box__foot')), /电费\s*([\d.]+)\s*万元/)
      const mix = pick(txt(panelOf('能耗构成')?.querySelector('.panel-box__foot')), /电力\s*([\d.]+)\s*万元/)
      return !(Math.abs(mix - tariff) < 0.05)
        ? [`能耗构成电力 ${mix} ≠ 峰谷平电费 ${tariff}`]
        : []
    }

    const before = read().length
    const el = panelOf('能耗构成').querySelector('.panel-box__foot')
    const original = el.textContent
    const m = original.match(/电力\s*([\d.]+)\s*万元/)
    el.textContent = original.replace(/电力\s*[\d.]+\s*万元/, `电力 ${(Number(m[1]) + 5).toFixed(1)} 万元`)
    const after = read().length
    el.textContent = original
    const restored = read().length
    return { before, after, restored }
  })
  check(
    'S3 改坏能耗构成的「电力」⇒ 等式判据当场报出这一处',
    s3.before === 0 && s3.after === 1 && s3.restored === 0,
    `注入前 ${s3.before} → 注入后 ${s3.after} → 还原 ${s3.restored}`
  )
} else {
  console.log('\n### 自证：跳过（加 --self-test 运行）')
}

// ---------------------------------------------------------------------------
console.log('\n### 控制台与网络')
check('没有非 /api 的控制台错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '干净')
check('没有非 /api 的失败请求', failedUrls.length === 0, failedUrls.slice(0, 3).join(' | ') || '干净')
check('/api 走的是降级路径（404 后回落到 mock）', apiMisses.length > 0, `${apiMisses.length} 次`)

await browser.close()

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok)
console.log(
  `\n合计 ${checks.length} 项，失败 ${failed.length} 项` +
    `${selfTest ? '（含 --self-test：注入三处缺陷，要求判据当场翻红）' : '（未跑自证，加 --self-test）'}`
)
for (const f of failed) console.log(`  ✗ ${f.name}`)
process.exit(failed.length ? 1 : 0)
