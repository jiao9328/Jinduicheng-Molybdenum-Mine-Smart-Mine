/**
 * 全站页面巡检：逐页打开，收集控制台错误、请求失败，并统计关键元素数量。
 * 用法：node scripts/check-all-pages.mjs [baseUrl] [--self-test]
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'
import { mkdir } from 'node:fs/promises'

const base = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] || 'http://localhost:8787'
const outDir = '.snapshots/pages'

/**
 * 全站路由清单 —— **10 条**，与 `src/router/index.ts` 里的业务路由一一对应。
 *
 * 原来还有 5 条 `/module/*` 占位页（顶栏「规划中」Tab 的落点），
 * 随那些 Tab 一起删除了：本平台的路由现在**条条都有真实页面**，
 * 不存在「打开是空壳」的地址。所以本表不再有 `占位·` 前缀，
 * 下面那套「占位页标题反查」的断言也一并删了（它已无对象可测）。
 *
 * `/data-admin`（数据管理）2026-09-14 加入：它成了真实业务页面，
 * 而它又最容易悄悄坏掉（表格没渲染、接口全 403），正是该被巡检盯住的类型。
 * 巡检用 admin 账号登录（见 `lib/session.mjs`），所以进得去。
 *
 * 2026-09-15：`/production` 退役，拆成 `/monitoring`（智能监控）与
 * `/reports`（统计报表）；`/decision` 一分为二，`/cost`（成本管理）独立出来。
 * 原来是「四条 Tab 只指向两条路由」，两个 Tab 点进去是同一个页面。
 * **新页面必须进这张表**，不进就没人巡检它们 —— 而拆分本身
 * 恰恰是最容易让某一页悄悄坏掉的动作。
 *
 * 两条**不在表内**：
 * - `/coord-picker` 是开发工具（把三维模型对齐到底图真实地物），不是业务页面；
 * - `/login` 是登录页本身。巡检已带会话，打开它会被守卫弹回 `/`，
 *   于是这一条量的其实是首页，只会让首页被数两遍。
 */
const PAGES = [
  ['/', '综合管控平台'],
  ['/safety', '安全管理'],
  ['/monitoring', '智能监控'],
  ['/reports', '统计报表'],
  ['/equipment', '设备管理'],
  ['/emergency', '应急救援'],
  ['/digital-twin', '数字孪生'],
  ['/decision', '决策指挥'],
  ['/cost', '成本管理'],
  ['/data-admin', '数据管理']
]

// ---------------------------------------------------------------------------
// 判据（纯函数，`--self-test` 直接喂合成结论行）
// ---------------------------------------------------------------------------

/**
 * 有问题的行。两条口径：
 *
 * - **只数真错误**：`接口未就绪` 不算失败——后端没起时接口 404 是预期行为，
 *   请求层会自动降级到内置数据，把它算成失败等于这个脚本在后台没起时永远红。
 * - `渲染失败` / `截图失败` / `三维报错面板` 是**带值的说明文字**（正常时是 `null`），
 *   所以按真值判，不按 `> 0` 判——这是这三列的实际形状。
 */
export function 挑问题(rows) {
  return rows.filter(
    (row) => row.错误 > 0 || row.渲染失败 || row.截图失败 || row.三维报错面板
  )
}

/**
 * 违规说明数组，空数组 = 通过。
 *
 * 除了逐页挑问题，还卡**行数**（防假绿）：巡检一行结论都没产出时，
 * `挑问题` 拿到的是空数组，脚本会打印「✓ 0 个页面全部通过」并退出 0——
 * **一个页面都没打开也算通过**，这正是第十三节第 23 条那具「永远绿的壳」的形状。
 * 行数对不上（页面少了、循环中途退出了）直接判违规。
 */
export function 判(rows, 期望页数) {
  const 违规 = []
  const 行数 = Array.isArray(rows) ? rows.length : null
  if (行数 !== 期望页数) {
    违规.push(
      `只产出 ${行数 === null ? '非数组' : 行数} 行页面结论，期望 ${期望页数} 行` +
        '——有页面根本没被打开，这一轮巡检不成立'
    )
  }
  for (const row of 挑问题(Array.isArray(rows) ? rows : [])) {
    const why = [
      row.错误 > 0 && `${row.错误} 条错误`,
      row.渲染失败 && '渲染失败',
      row.截图失败 && '截图失败',
      row.三维报错面板 && '三维报错面板'
    ].filter(Boolean)
    违规.push(`${row.页面}：${why.join('，')}`)
  }
  return 违规
}

/**
 * 已知「在这个环境里连不上」的外网主机。
 *
 * `tile.googleapis.com` 是 Cesium Ion 那个实景三维资产真正托管数据的地方
 * （Ion 的 endpoint 只返回一个指向它的 URL）。国内网络**连 TCP 都建不起来**，
 * Chromium 一直重试到约 **87 秒**才放弃。它是「默认打开在线实景三维」这个
 * **知情决定**（第十三节第 37 条）的必然产物，不是任何页面的缺陷。
 *
 * ⚠️ 别把它当「网络错误一律不算」。这条豁免是**要证据的**（见 `分类消息`）：
 * 本页必须真的有一条发往该主机的 `requestfailed`，否则规则完全不生效。
 */
export const 已知不可达外网 = 'tile.googleapis.com'

/**
 * 控制台错误分类 → 三个数组。纯函数，`--self-test` 直接喂合成样本。
 *
 * - **接口未就绪**：后端没起时接口 404 是预期行为，请求层会自动降级到内置数据。
 * - **外网不可达**：那条到 `已知不可达外网` 的连接超时。**证据门控** ——
 *   必须 `失败主机` 里真有那台主机才豁免；只匹配错误文本会把「页面自己的请求
 *   超时」也一起吞掉，那正是这条检查该抓的东西。
 * - **真错误**：剩下的。
 *
 * 分类放到最后做（而不是在 `console` 监听里当场分），是因为 `requestfailed`
 * 与 `console` 是两个独立的 CDP 事件、到达顺序没有保证：当场分会因为
 * 「主机还没记上」而把这条误判成真错误 —— 那就成了抛硬币。
 */
export function 分类消息(原文, 失败主机) {
  const 真错误 = []
  const 接口未就绪 = []
  const 外网不可达 = []
  for (const text of 原文) {
    if (text.includes('404') || text.includes('/api/')) 接口未就绪.push(text)
    else if (text.includes('net::ERR_CONNECTION_TIMED_OUT') && 失败主机.has(已知不可达外网))
      外网不可达.push(text)
    else 真错误.push(text)
  }
  return { 真错误, 接口未就绪, 外网不可达 }
}

/** 合成一行健康结论 —— 字段与下面 `summary.push` 的形状逐字对应 */
const 健康行 = (页面) => ({
  页面,
  面板: 6,
  图表: 4,
  指标卡: 8,
  三维: true,
  滚动条: '无',
  错误: 0,
  接口未就绪: 3,
  外网不可达: 0,
  三维报错面板: null,
  渲染失败: null,
  截图失败: null
})
const 全页 = () => PAGES.map(([, name]) => 健康行(name))

export const 自证样本 = [
  { name: '正例·全部页面全健康', 行: 全页(), 应报: 0 },
  {
    // 这条是口径本身：后端没起时接口 404 是预期行为，不许把它算成失败
    name: '反例·某页 99 条接口未就绪（后端没起，预期降级）',
    行: 全页().map((r) => (r.页面 === '安全管理' ? { ...r, 接口未就绪: 99 } : r)),
    应报: 0
  },
  { name: '正例·某页 1 条真错误', 行: 全页().map((r) => (r.页面 === '智能监控' ? { ...r, 错误: 1 } : r)), 应报: 1 },
  {
    name: '正例·渲染失败（停渲染循环时抛错）',
    行: 全页().map((r) => (r.页面 === '数字孪生' ? { ...r, 渲染失败: 'Cannot read properties of undefined' } : r)),
    应报: 1
  },
  {
    name: '正例·截图失败（超时）',
    行: 全页().map((r) => (r.页面 === '综合管控平台' ? { ...r, 截图失败: 'Timeout 120000ms exceeded' } : r)),
    应报: 1
  },
  {
    name: '正例·三维报错面板（Cesium 自己报了错）',
    行: 全页().map((r) => (r.页面 === '应急救援' ? { ...r, 三维报错面板: 'An error occurred while rendering.' } : r)),
    应报: 1
  },
  {
    // 与上面那条同源：已知连不上的外网主机，是第 37 条那个知情决定的产物。
    // **报了但不判** —— 数字仍在行里（`外网不可达` 列），只是不算失败。
    name: '反例·某页 9 条外网不可达（已确认连不上的那台主机，预期）',
    行: 全页().map((r) => (r.页面 === '数字孪生' ? { ...r, 外网不可达: 9 } : r)),
    应报: 0
  },
  { name: '正例·一行结论都没有（巡检空转，最容易冒充绿）', 行: [], 应报: 1 },
  { name: '正例·少跑一页', 行: 全页().slice(0, -1), 应报: 1 },
  { name: '正例·结论不是数组（读挂了）', 行: null, 应报: 1 }
]

/**
 * 分类器的自证样本。**带 ★ 的两条是这组存在的理由** ——
 * 它们证明「外网不可达」这条豁免是**收窄的**，而不是「网络错误一律不算」：
 * 少了失败记录就不豁免，豁免了也不吞同页的其它错误。
 */
export const 分类样本 = [
  {
    name: '分类 正例·404 进接口未就绪',
    原文: ['Failed to load resource: the server responded with a status of 404 (Not Found)'],
    主机: [],
    应: { 真错误: 0, 接口未就绪: 1, 外网不可达: 0 }
  },
  {
    name: '分类 反例·有该主机的失败记录 → 外网不可达（不判）',
    原文: ['Failed to load resource: net::ERR_CONNECTION_TIMED_OUT'],
    主机: ['tile.googleapis.com'],
    应: { 真错误: 0, 接口未就绪: 0, 外网不可达: 1 }
  },
  {
    name: '分类 反例·★没有失败记录时，同样的文本不许豁免',
    原文: ['Failed to load resource: net::ERR_CONNECTION_TIMED_OUT'],
    主机: [],
    应: { 真错误: 1, 接口未就绪: 0, 外网不可达: 0 }
  },
  {
    name: '分类 反例·★豁免只吃那一条，同页其它真错误照报',
    原文: [
      'Failed to load resource: net::ERR_CONNECTION_TIMED_OUT',
      "TypeError: Cannot read properties of undefined (reading 'x')"
    ],
    主机: ['tile.googleapis.com'],
    应: { 真错误: 1, 接口未就绪: 0, 外网不可达: 1 }
  },
  {
    name: '分类 反例·主机对但错误文本不对（连接被重置）不许豁免',
    原文: ['Failed to load resource: net::ERR_CONNECTION_RESET'],
    主机: ['tile.googleapis.com'],
    应: { 真错误: 1, 接口未就绪: 0, 外网不可达: 0 }
  },
  {
    name: '分类 正例·后端没起时一批 404 全进接口未就绪',
    原文: Array(5).fill('Failed to load resource: the server responded with a status of 404 (Not Found)'),
    主机: [],
    应: { 真错误: 0, 接口未就绪: 5, 外网不可达: 0 }
  }
]

function 自证() {
  let 坏 = 0
  console.log('=== 自证：控制台错误分类 ===')
  for (const c of 分类样本) {
    const got = 分类消息(c.原文, new Set(c.主机))
    const 实际 = { 真错误: got.真错误.length, 接口未就绪: got.接口未就绪.length, 外网不可达: got.外网不可达.length }
    const ok = Object.keys(c.应).every((k) => c.应[k] === 实际[k])
    if (!ok) 坏++
    console.log(`  ${ok ? '✓' : '✗'} ${c.name}`)
    if (!ok) console.log(`      期望 ${JSON.stringify(c.应)}，实际 ${JSON.stringify(实际)}`)
  }

  console.log('\n=== 自证：合成的页面结论行 ===')
  for (const c of 自证样本) {
    const 违规 = 判(c.行, PAGES.length)
    const 报了几条 = 违规.length
    const ok = c.应报 === 0 ? 报了几条 === 0 : 报了几条 > 0
    if (!ok) 坏++
    console.log(`  ${ok ? '✓' : '✗'} ${c.name}`)
    if (!ok) {
      console.log(
        `      期望${c.应报 === 0 ? '不报' : '报红'}，实际报出 ${报了几条} 条：${违规.join('；') || '（无）'}`
      )
    }
  }
  const 共 = 自证样本.length + 分类样本.length
  console.log(坏 ? `\n✗ 自证 ${坏}/${共} 项不通过` : `\n✓ 自证 ${共} 项全过`)
  return 坏
}

if (process.argv.includes('--self-test')) {
  process.exit(自证() ? 1 : 0)
}

// ---------------------------------------------------------------------------
await mkdir(outDir, { recursive: true })

const session = await login(base)

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=3072']
})

const summary = []

for (const [path, name] of PAGES) {
  const page = await newLoggedInPage(browser, session, { viewport: { width: 1920, height: 1080 } })
  // 先收**原文**，分类留到本页跑完再做（理由见 `分类消息` 的注释）
  const 原文 = []
  const 失败主机 = new Set()
  const failed = []

  page.on('console', (m) => {
    if (m.type() !== 'error') return
    原文.push(m.text().replace(/\s+/g, ' ').slice(0, 110))
  })
  page.on('pageerror', (e) => 原文.push('PAGEERROR ' + String(e).slice(0, 110)))
  page.on('requestfailed', (r) => {
    failed.push(r.url().slice(-60))
    try {
      失败主机.add(new URL(r.url()).host)
    } catch {
      /* data: / blob: 之类没有 host，忽略 */
    }
  })
  // 页面现在默认要登录，会话由上面的 newLoggedInPage 注入（见 lib/session.mjs）

  await page.goto(base + '/#' + path, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(22000)

  const stats = await page.evaluate(() => ({
    panels: document.querySelectorAll('.panel-box').length,
    charts: document.querySelectorAll('.echart-box canvas').length,
    metrics: document.querySelectorAll('.metric-card').length,
    canvas: !!document.querySelector('#cesium-container canvas'),
    docHeight: document.documentElement.scrollHeight,
    winHeight: window.innerHeight
  }))

  const panel = await page.evaluate(() => {
    const p = document.querySelector('.cesium-widget-errorPanel')
    return p && getComputedStyle(p).display !== 'none' ? p.innerText.replace(/\s+/g, ' ').slice(0, 90) : null
  })

  // 截图前先停掉 Cesium 的渲染循环。
  //
  // 它每帧都在重绘，页面永远没有「稳定帧」，Playwright 会一直等到超时
  // （场景元素一多就必现）。停之前手动渲染一帧，保证截到的是当前画面。
  //
  // 这一步和截图都不能让整轮巡检挂掉：单页失败要记进该页的结论里继续跑，
  // 否则一个页面出问题就看不到后面所有页的结果了。
  let renderErr = null
  try {
    await page.evaluate(() => {
      const v = window.__cesiumViewer
      if (v) {
        v.render()
        v.useDefaultRenderLoop = false
      }
    })
  } catch (err) {
    renderErr = String(err.message || err).replace(/\s+/g, ' ').slice(0, 110)
  }
  await page.waitForTimeout(800)

  const file = path.replace(/\//g, '_') || '_root'
  // 软件渲染（CI / 无头）下，重场景合成一帧可能要几十秒，
  // 默认 30s 不够用，这里放宽
  let shotErr = null
  try {
    await page.screenshot({ path: `${outDir}/${file}.png`, timeout: 120000 })
  } catch (err) {
    shotErr = String(err.message || err).replace(/\s+/g, ' ').slice(0, 110)
  }

  // 分类放在截屏之后：那条 tile.googleapis.com 的超时实测在 **87 秒**才到，
  // 而截图（软渲染 60~120 秒）正是它落进来的窗口 —— 早于截图分类就会漏掉它，
  // 也就复现不出这个坑。见第十三节第 37 条。
  const { 真错误: errs, 接口未就绪: apiMisses, 外网不可达: 外网断 } = 分类消息(原文, 失败主机)

  const row = {
    页面: name,
    面板: stats.panels,
    图表: stats.charts,
    指标卡: stats.metrics,
    三维: stats.canvas,
    滚动条: stats.docHeight > stats.winHeight ? `溢出 ${stats.docHeight - stats.winHeight}px` : '无',
    错误: errs.length,
    接口未就绪: apiMisses.length,
    外网不可达: 外网断.length,
    三维报错面板: panel,
    渲染失败: renderErr,
    截图失败: shotErr
  }
  /* 只报「1 条错误」这个数字，排障就得从零开始 —— 说不出是谁、长什么样。
     2026-09-18 它两次报「2/10 个页面各有 1 条错误」，却没有任何线索可查，
     探针复现又抓不到。把原文带上，下次再红，看一眼就知道去哪儿找。 */
  if (errs.length) row.错误明细 = errs.slice(0, 5)
  summary.push(row)

  await page.close()
}

console.log(JSON.stringify(summary, null, 1))
await browser.close()

// 退出码：README 说这个脚本「适合接入 CI 做回归」，那就得能让 CI 判成败。
const 违规 = 判(summary, PAGES.length)
const 坏行 = 挑问题(summary)
if (违规.length) {
  console.error(`\n✗ ${坏行.length}/${summary.length} 个页面有问题：`)
  for (const m of 违规) console.error(`   ${m}`)
} else {
  console.log(`\n✓ ${summary.length} 个页面全部通过`)
}
process.exit(违规.length ? 1 : 0)
