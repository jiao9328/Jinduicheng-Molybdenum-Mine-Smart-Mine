/**
 * 分析决策页专项检查（《项目文档.docx》§06 的四维「驾驶舱」）。
 *
 * 覆盖：
 *   成本效益 —— 甲方硬要求「一字不动」的一维，本脚本是它的回归守门人
 *   生产分析 —— §9.2-1 产量趋势 / 设备利用率 / 工序效率 / 损失贫化率
 *   安全分析 —— §9.2-2 隐患类型分布 /「三违」行为统计 / 事故率趋势
 *   能耗单耗 —— §9.2-3 吨成本 / 单机成本 / 峰谷平电费 / 水消耗
 *
 * 用法：node scripts/check-decision.mjs [baseUrl] [--self-test]
 *
 * ── 本脚本盯的三类错误 ───────────────────────────────────────────────
 * ① **同一个数在两个面板上各写一份，还对不上**。大屏上最典型的一种：
 *    指标卡写「本月隐患上报 48」，隐患分布的环形图各段加起来是 45，
 *    两块面板颜色都对、都不报错，只有拿计算器核才发现。这类数**只在 canvas 里**，
 *    所以本页把派生量写进了面板底栏（如「各类型合计 48 项」），
 *    让它们变成 DOM 里可断言的事实 —— 底栏对看的人也有用，不是为检查而加的脚手架。
 * ② **维度切换是假的**。加载完页面就只看默认维的话，另外三维从没被渲染过，
 *    而报告照样全绿（面板数、图表数都是 0 也是「没问题」）。
 *    所以四个维度逐个切过去，每维都断言标题集合与硬编码规格一致。
 * ③ **成本效益维被顺手改了**。这一维是甲方拿参考截图逐像素要求保留的，
 *    改了不会有任何报错。所以它的 8 个面板标题、5 张指标卡、4 条决策建议
 *    全部按硬编码集合比对（含 A4 那次「第 4 条建议改成定价策略」的修复）。
 *
 * ── 判据分两类，强度不一样，别混 ─────────────────────────────────────
 * **页面内自洽**：两个都在 DOM 里的数必须满足某个等式（如「底栏电费 == 月电费指标卡」）。
 *   这类判据有真正的分辨力 —— 改任何一边都会红，所以**自证注入选的就是这一类**。
 * **规格常量**：需要跨维度比较、两个数从不同时在屏幕上的（如吨成本合计 128.60
 *   在能耗维，「效益分析」的吨成本在成本效益维），只能把期望值写进下面的 SPEC_*。
 *   它只能抓「改了数据没改规格」的漂移，抓不到「规格本身就写错了」。**别当强判据用**。
 *
 * ── 自证（--self-test）────────────────────────────────────────────────
 * 一个从没见过它变红的检查不算证据。注入两次，都要求判据当场翻红：
 *   S1 把峰谷平底栏的电费改成别的数 → 「底栏电费 == 月电费卡」必须报出这一处
 *   S2 把隐患分布底栏的合计改成 47   → 「底栏合计 == 本月隐患上报卡」必须报出这一处
 * 两次都在**同一个 page.evaluate 里注入→判定→还原**，中间不让出控制权：
 * Vue 的更新走微任务，中间一旦有 await，组件可能重渲染把注入冲掉，
 * 那时判据读到的还是好数据，「没翻红」就成了脚本自己的假阴性。
 *
 * ── 一条判据纪律 ─────────────────────────────────────────────────────
 * `/api/*` 的 404 **不算错**：那是 requestWithFallback 在后端未就绪时的正常
 * 降级路径（真发请求 → 404 → 用内置数据渲染）。恒红的判据等于没有判据。
 *
 * 面板撑破 / 面板互相压住不在本脚本：/decision 整页在 check-panel-overflow 的 PAGES
 * 里，四维切换的遍历也在那里（判据 A/B/C + 注入自证）。
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'

const argv = process.argv.slice(2)
const selfTest = argv.includes('--self-test')
const base = argv.find((a) => !a.startsWith('--')) || 'http://localhost:8787'

// ===========================================================================
// 硬编码规格 —— 不从 src 读。脚本去读被测代码的常量，两边一起改就永远绿了。
// ===========================================================================

/** 四个维度：按钮文案 + 该维应当出现且仅出现的面板标题（按集合比对，顺序不计） */
const DIMS = [
  {
    label: '成本效益',
    panels: [
      '年度成本对比',
      '前 5 大支出项',
      '各类型成本分布',
      '维护成本月度趋势',
      '用水用电成本月度趋势',
      '人力成本月度趋势',
      '效益分析',
      '智能辅助决策建议'
    ],
    metrics: ['用水用电成本', '人力成本', '易损成本', '维护成本', '其他业务成本']
  },
  {
    label: '生产分析',
    panels: ['产量趋势（计划 vs 实际）', '设备利用率', '工序效率', '损失贫化率趋势'],
    metrics: ['本月产量', '计划完成率', '设备综合利用率', '矿石损失率', '矿石贫化率']
  },
  {
    label: '安全分析',
    panels: ['隐患类型分布', '事故率趋势', '「三违」行为统计（按类别）', '「三违」行为统计（按区队）'],
    metrics: ['本月隐患上报', '隐患整改率', '本月「三违」', '本月事故起数', '千人负伤率']
  },
  {
    label: '能耗单耗',
    panels: ['峰谷平电费', '能耗构成', '水消耗', '单耗趋势', '吨成本拆解', '单机成本'],
    metrics: ['月用电量', '月电费', '峰段电量占比', '月用水量', '吨矿电耗']
  }
]

/** 成本效益维的 4 条建议类型，顺序即页面上的顺序 —— 第 4 条是 A4 那次修复的内容 */
const SPEC_SUGGESTION_TYPES = ['生产计划优化', '设备维保时机', '库存周转', '定价策略']
const SPEC_BENEFIT_LABELS = ['投入产出比', '利润率', '吨成本', '投资回报周期']

// ---- 规格常量（跨维度，两个数从不同时在屏幕上，只能写死；见文件头「判据分两类」） ----
/** 成本效益维「效益分析」的吨成本，能耗维的「吨成本拆解」合计必须等于它 */
const SPEC_TON_COST = 128.6
/** 生产分析维 6 月的实际产量（万吨）—— 能耗维的吨矿电耗/吨矿水耗拿它当分母 */
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

await page.goto(base + '/#/decision', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForSelector('.decision__dim', { timeout: 30000 })
await page.waitForTimeout(2000)

// ---------------------------------------------------------------------------
// DOM 读数：本页所有判据的原料都在这一个 evaluate 里取
// ---------------------------------------------------------------------------
const readDom = () =>
  page.evaluate(() => {
    const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

    const metrics = [...document.querySelectorAll('.metric-card')].map((c) => ({
      label: txt(c.querySelector('.metric-card__label')),
      // 数字是 NumberFlip 滚出来的（1200ms 缓出），读数前必须等它落位
      value: Number(txt(c.querySelector('.number-flip'))),
      unit: txt(c.querySelector('.metric-card__unit'))
    }))

    const panels = [...document.querySelectorAll('.panel-box')].map((p) => ({
      title: txt(p.querySelector('.panel-box__title')),
      foot: txt(p.querySelector('.panel-box__foot'))
    }))

    return {
      metrics,
      panels,
      // 成本效益维专用的两块（其余维度没有这些结构）
      suggestionTypes: [...document.querySelectorAll('.decision__suggestion-tag')].map(txt),
      benefitLabels: [...document.querySelectorAll('.decision__benefit-label')].map(txt)
    }
  })

const foot = (dom, title) => dom.panels.find((p) => p.title === title)?.foot ?? ''
const metric = (dom, label) => dom.metrics.find((m) => m.label === label)?.value ?? NaN

/** 从文本里抠出「关键字 后面的第一个数」 */
const pick = (s, re) => {
  const m = String(s).match(re)
  return m ? Number(m[1]) : NaN
}

// ---------------------------------------------------------------------------
// 切维度
// ---------------------------------------------------------------------------
async function switchTo(label) {
  const btn = page.locator('.decision__dim', { hasText: label })
  await btn.click({ timeout: 10000 })
  const expect = DIMS.find((d) => d.label === label)
  await page.waitForFunction(
    (want) =>
      want.panels.every((t) =>
        [...document.querySelectorAll('.panel-box__title')].some(
          (el) => el.textContent.trim() === t
        )
      ),
    expect,
    { timeout: 20000 }
  )
  // 指标卡的数字在 1200ms 内滚到位，等它停
  await page.waitForTimeout(1600)
}

// ===========================================================================
// 甲：成本效益维 —— 回归守门人（先看这一维，它是「一字不动」的那一维）
// ===========================================================================
console.log('\n### 成本效益（甲方要求原样保留的一维）')
await switchTo('成本效益')
const cost = await readDom()

{
  const spec = DIMS[0]
  const titles = cost.panels.map((p) => p.title)
  check(
    `面板标题与规格一致（${spec.panels.length} 块）`,
    sameSet(titles, spec.panels),
    sameSet(titles, spec.panels) ? titles.join(' / ') : setDiff(titles, spec.panels)
  )

  const labels = cost.metrics.map((m) => m.label)
  check(
    `指标卡与规格一致（${spec.metrics.length} 张）`,
    sameSet(labels, spec.metrics),
    sameSet(labels, spec.metrics) ? labels.join(' / ') : setDiff(labels, spec.metrics)
  )

  check(
    '决策建议 4 条的类型正是 docx §06 列举的四类（含「定价策略」那次修复）',
    sameSet(cost.suggestionTypes, SPEC_SUGGESTION_TYPES),
    sameSet(cost.suggestionTypes, SPEC_SUGGESTION_TYPES)
      ? cost.suggestionTypes.join(' / ')
      : setDiff(cost.suggestionTypes, SPEC_SUGGESTION_TYPES)
  )

  check(
    '效益分析 4 项与规格一致',
    sameSet(cost.benefitLabels, SPEC_BENEFIT_LABELS),
    cost.benefitLabels.join(' / ')
  )

  // 吨成本 128.6 是下面能耗维要对的锚点，先确认它本身没变。
  // 「效益分析」是列表不是图表、没有底栏，数值直接在 li 的文字里。
  const benefitText = await page.evaluate(() =>
    [...document.querySelectorAll('.decision__benefit')].map((li) =>
      (li.textContent ?? '').replace(/\s+/g, ' ').trim()
    )
  )
  const tonFromDom = pick(
    benefitText.find((t) => t.includes('吨成本')) ?? '',
    /吨成本\s*([\d.]+)/
  )
  check(
    `效益分析的吨成本 = ${SPEC_TON_COST}（能耗维「吨成本拆解」合计要对上它）`,
    Math.abs(tonFromDom - SPEC_TON_COST) < 0.005,
    `实测 ${tonFromDom}`
  )
}

// ===========================================================================
// 乙：生产分析
// ===========================================================================
console.log('\n### 生产分析（§9.2-1）')
await switchTo('生产分析')
const prod = await readDom()

{
  const spec = DIMS[1]
  const titles = prod.panels.map((p) => p.title)
  check(
    `面板标题与规格一致（${spec.panels.length} 块）`,
    sameSet(titles, spec.panels),
    sameSet(titles, spec.panels) ? titles.join(' / ') : setDiff(titles, spec.panels)
  )
  const labels = prod.metrics.map((m) => m.label)
  check(
    `指标卡与规格一致（${spec.metrics.length} 张）`,
    sameSet(labels, spec.metrics),
    sameSet(labels, spec.metrics) ? labels.join(' / ') : setDiff(labels, spec.metrics)
  )

  // ---- 页面内自洽：产量趋势底栏的算式 ÷ 指标卡 ----
  const outFoot = foot(prod, '产量趋势（计划 vs 实际）')
  const rateInFoot = pick(outFoot, /完成率\s*([\d.]+)%/)
  const actualInFoot = pick(outFoot, /实际\s*([\d.]+)/)
  const planInFoot = pick(outFoot, /计划\s*([\d.]+)/)
  const cardOutput = metric(prod, '本月产量')
  const cardRate = metric(prod, '计划完成率')

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

  // ---- 页面内自洽：设备利用率底栏的均值 ÷ 指标卡 ----
  const utilFoot = foot(prod, '设备利用率')
  const avgInFoot = pick(utilFoot, /综合利用率\s*([\d.]+)%/)
  const cardUtil = metric(prod, '设备综合利用率')
  check(
    '设备利用率底栏的均值与指标卡「设备综合利用率」是同一个数',
    Math.abs(avgInFoot - cardUtil) < 0.005,
    `底栏 ${avgInFoot}% vs 指标卡 ${cardUtil}%`
  )

  check(
    '「本月产量」= 生产分析末月实际产量',
    Math.abs(cardOutput - SPEC_OUTPUT) < 0.005,
    `实测 ${cardOutput}，规格 ${SPEC_OUTPUT}`
  )
  check(
    '损失率 / 贫化率都在合理区间（0 < x < 20%）',
    metric(prod, '矿石损失率') > 0 &&
      metric(prod, '矿石损失率') < 20 &&
      metric(prod, '矿石贫化率') > 0 &&
      metric(prod, '矿石贫化率') < 20,
    `损失 ${metric(prod, '矿石损失率')}% / 贫化 ${metric(prod, '矿石贫化率')}%`
  )
}

// ===========================================================================
// 丙：安全分析
// ===========================================================================
console.log('\n### 安全分析（§9.2-2）')
await switchTo('安全分析')
const safe = await readDom()

{
  const spec = DIMS[2]
  const titles = safe.panels.map((p) => p.title)
  check(
    `面板标题与规格一致（${spec.panels.length} 块）`,
    sameSet(titles, spec.panels),
    sameSet(titles, spec.panels) ? titles.join(' / ') : setDiff(titles, spec.panels)
  )
  const labels = safe.metrics.map((m) => m.label)
  check(
    `指标卡与规格一致（${spec.metrics.length} 张）`,
    sameSet(labels, spec.metrics),
    sameSet(labels, spec.metrics) ? labels.join(' / ') : setDiff(labels, spec.metrics)
  )

  // ---- 隐患类型分布各段之和 == 指标卡「本月隐患上报」 ----
  const hazardSum = pick(foot(safe, '隐患类型分布'), /合计\s*([\d.]+)\s*项/)
  const cardReported = metric(safe, '本月隐患上报')
  check(
    '隐患类型各段之和 == 指标卡「本月隐患上报」',
    hazardSum === cardReported && cardReported > 0,
    `底栏合计 ${hazardSum} vs 指标卡 ${cardReported}`
  )

  // ---- 「三违」两个口径之和相等，且都 == 指标卡 ----
  const violSum = pick(foot(safe, '「三违」行为统计（按区队）'), /都是\s*([\d.]+)\s*次/)
  const cardViol = metric(safe, '本月「三违」')
  check(
    '「三违」两个口径之和相等，且 == 指标卡「本月「三违」」',
    violSum === cardViol && cardViol > 0,
    `底栏 ${violSum} vs 指标卡 ${cardViol}`
  )

  // ---- 千人负伤率 == 起数 ÷ 在册职工 × 1000 ----
  const accFoot = foot(safe, '事故率趋势')
  const headcount = pick(accFoot, /在册职工\s*([\d.]+)\s*人/)
  const cardCount = metric(safe, '本月事故起数')
  const cardRate = metric(safe, '千人负伤率')
  const want = (cardCount / headcount) * 1000
  check(
    '千人负伤率 = 事故起数 ÷ 在册职工 × 1000（底栏写明了分母）',
    headcount > 0 && Math.abs(cardRate - want) < 0.005,
    `${cardCount} ÷ ${headcount} × 1000 = ${want.toFixed(4)}，指标卡 ${cardRate}`
  )

  // ---- 隐患整改率 == 整改完成 ÷ 上报（闭环的第二、四环，来自安全管理页） ----
  const cardRect = metric(safe, '隐患整改率')
  check(
    '隐患整改率 = 41 ÷ 48 = 85.42%（与安全管理页的隐患闭环同源）',
    Math.abs(cardRect - (41 / 48) * 100) < 0.005,
    `实测 ${cardRect}%，41/48 = ${((41 / 48) * 100).toFixed(2)}%`
  )
}

// ===========================================================================
// 丁：能耗单耗
// ===========================================================================
console.log('\n### 能耗单耗（§9.2-3）')
await switchTo('能耗单耗')
const energy = await readDom()

{
  const spec = DIMS[3]
  const titles = energy.panels.map((p) => p.title)
  check(
    `面板标题与规格一致（${spec.panels.length} 块）`,
    sameSet(titles, spec.panels),
    sameSet(titles, spec.panels) ? titles.join(' / ') : setDiff(titles, spec.panels)
  )
  const labels = energy.metrics.map((m) => m.label)
  check(
    `指标卡与规格一致（${spec.metrics.length} 张）`,
    sameSet(labels, spec.metrics),
    sameSet(labels, spec.metrics) ? labels.join(' / ') : setDiff(labels, spec.metrics)
  )

  // ---- 峰谷平底栏 ↔ 月用电量 / 月电费 指标卡 ----
  const tariffFoot = foot(energy, '峰谷平电费')
  const kwhInFoot = pick(tariffFoot, /合计\s*([\d.]+)\s*万kWh/)
  const costInFoot = pick(tariffFoot, /电费\s*([\d.]+)\s*万元/)
  const cardKwh = metric(energy, '月用电量')
  const cardCost = metric(energy, '月电费')
  check(
    '峰谷平底栏的电量合计 == 指标卡「月用电量」',
    Math.abs(kwhInFoot - cardKwh) < 0.05,
    `底栏 ${kwhInFoot} vs 指标卡 ${cardKwh}`
  )
  check(
    '峰谷平底栏的电费合计 == 指标卡「月电费」',
    Math.abs(costInFoot - cardCost) < 0.05,
    `底栏 ${costInFoot} vs 指标卡 ${cardCost}`
  )

  // ---- 能耗构成里的「电力」== 峰谷平三段电费之和 ----
  const mixElectric = pick(foot(energy, '能耗构成'), /电力\s*([\d.]+)\s*万元/)
  check(
    '能耗构成的「电力」== 峰谷平三段电费之和',
    Math.abs(mixElectric - costInFoot) < 0.05,
    `能耗构成 ${mixElectric} 万元 vs 峰谷平电费 ${costInFoot} 万元`
  )

  // ---- 吨矿电耗 == 月用电量 ÷ 月产量 ----
  const cardPerTon = metric(energy, '吨矿电耗')
  const wantPerTon = cardKwh / SPEC_OUTPUT
  check(
    `吨矿电耗 = 月用电量 ÷ 月产量（${SPEC_OUTPUT} 万吨，取自生产分析维）`,
    Math.abs(cardPerTon - wantPerTon) < 0.05,
    `${cardKwh} ÷ ${SPEC_OUTPUT} = ${wantPerTon.toFixed(2)}，指标卡 ${cardPerTon}`
  )

  // ---- 吨成本拆解合计 == 效益分析的吨成本 ----
  const tonSum = pick(foot(energy, '吨成本拆解'), /合计\s*([\d.]+)\s*元\/吨/)
  check(
    `吨成本拆解合计 = 效益分析的吨成本 ${SPEC_TON_COST}（跨维度，用规格常量比）`,
    Math.abs(tonSum - SPEC_TON_COST) < 0.005,
    `实测 ${tonSum}`
  )

  // ---- 单机成本月合计 ----
  const machineSum = pick(foot(energy, '单机成本'), /月合计\s*([\d.]+)\s*万元/)
  check(
    `单机成本月合计 = ${SPEC_MACHINE_TOTAL} 万元（Σ 单机成本 × 台数，规格常量）`,
    Math.abs(machineSum - SPEC_MACHINE_TOTAL) < 0.05,
    `实测 ${machineSum}`
  )

  // ---- 水 ----
  const waterPerTon = pick(foot(energy, '水消耗'), /吨矿水耗\s*([\d.]+)\s*m³\/t/)
  const cardWater = metric(energy, '月用水量')
  const wantWater = cardWater / SPEC_OUTPUT
  check(
    '吨矿水耗 = 月用水量 ÷ 月产量',
    Math.abs(waterPerTon - wantWater) < 0.005,
    `${cardWater} ÷ ${SPEC_OUTPUT} = ${wantWater.toFixed(3)}，底栏 ${waterPerTon}`
  )

  // ---- 峰段电量占比 == 峰段电量 ÷ 总电量：占比这一项只有指标卡，用 26% 的规格兜住 ----
  check(
    '峰段电量占比在 10%~50% 的合理区间（不是 0 也不是 100）',
    metric(energy, '峰段电量占比') > 10 && metric(energy, '峰段电量占比') < 50,
    `实测 ${metric(energy, '峰段电量占比')}%`
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
  //
  // 两处注入分别做在两个维度里：峰谷平电费与「月电费」卡同属能耗维，
  // 隐患分布与「本月隐患上报」卡同属安全维 —— 改不到不在 DOM 里的那一维。

  // ---- S1：能耗维，把峰谷平底栏的电费改成别的数 ----
  await switchTo('能耗单耗')
  const s1 = await page.evaluate(() => {
    const footOf = (title) =>
      [...document.querySelectorAll('.panel-box')]
        .find(
          (p) => p.querySelector('.panel-box__title')?.textContent.trim() === title
        )
        ?.querySelector('.panel-box__foot')
    const read = () => {
      const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const metric = (label) => {
        const c = [...document.querySelectorAll('.metric-card')].find(
          (x) => txt(x.querySelector('.metric-card__label')) === label
        )
        return Number(txt(c?.querySelector('.number-flip')))
      }
      const pick = (s, re) => {
        const m = String(s).match(re)
        return m ? Number(m[1]) : NaN
      }
      const bad = []
      const tariffCost = pick(txt(footOf('峰谷平电费')), /电费\s*([\d.]+)\s*万元/)
      const cardCost = metric('月电费')
      if (!(Math.abs(tariffCost - cardCost) < 0.05)) {
        bad.push(`峰谷平底栏电费 ${tariffCost} ≠ 指标卡月电费 ${cardCost}`)
      }
      return bad
    }

    const before = read().length
    const el = footOf('峰谷平电费')
    const original = el.textContent
    // 改成一个一定对不上的数：把「电费 X 万元」里的 X 加 111
    const m = original.match(/电费\s*([\d.]+)\s*万元/)
    el.textContent = original.replace(
      /电费\s*[\d.]+\s*万元/,
      `电费 ${(Number(m[1]) + 111).toFixed(1)} 万元`
    )
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

  // ---- S2：安全维，把隐患分布底栏的合计改成 47 ----
  await switchTo('安全分析')
  const s2 = await page.evaluate(() => {
    const footOf = (title) =>
      [...document.querySelectorAll('.panel-box')]
        .find(
          (p) => p.querySelector('.panel-box__title')?.textContent.trim() === title
        )
        ?.querySelector('.panel-box__foot')
    const read = () => {
      const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const metric = (label) => {
        const c = [...document.querySelectorAll('.metric-card')].find(
          (x) => txt(x.querySelector('.metric-card__label')) === label
        )
        return Number(txt(c?.querySelector('.number-flip')))
      }
      const pick = (s, re) => {
        const m = String(s).match(re)
        return m ? Number(m[1]) : NaN
      }
      const bad = []
      const hazardSum = pick(txt(footOf('隐患类型分布')), /合计\s*([\d.]+)\s*项/)
      const cardReported = metric('本月隐患上报')
      if (!(hazardSum === cardReported && cardReported > 0)) {
        bad.push(`隐患类型合计 ${hazardSum} ≠ 指标卡上报 ${cardReported}`)
      }
      return bad
    }

    const before = read().length
    const el = footOf('隐患类型分布')
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
    `${selfTest ? '（含 --self-test：注入两处缺陷，要求判据当场翻红）' : '（未跑自证，加 --self-test）'}`
)
for (const f of failed) console.log(`  ✗ ${f.name}`)
process.exit(failed.length ? 1 : 0)
