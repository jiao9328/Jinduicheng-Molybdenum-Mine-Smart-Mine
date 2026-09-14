/**
 * 面板体检：逐页量每块面板，看内容有没有**撑破**面板、面板有没有**压到**别的面板上。
 *
 * 这条检查是为两类真实缺陷立的，两类都**不报错、控制台干净、页面计数也正常**：
 *
 * ① 图表写死像素高度，撑破自己所在的面板 —— 首页右栏由 3 块补成 4 块后，
 *    每块只剩约 195px，「产量统计」写死 150 会把多出的 13px 压到下一块面板上。
 *    `check-all-pages.mjs` 看不到它：面板数、图表数都对，文档也没出滚动条。
 *
 * ② 浮层盖住面板内容 —— 安全页底部两块浮层与右栏最后一块面板锚在同一条底边上，
 *    把「本周存在安全风险项类型分布」的环形图整块盖住，页面上只剩标题加一片空白。
 *    这个更隐蔽：DOM 里那块面板和它的 canvas 都在，计数完全正常，
 *    只有量矩形（或者肉眼看截图）才发现得了。
 *
 * 判定不靠看截图：1920×1080 上十几像素的重叠，肉眼和识别模型都数不准，
 * 但矩形是可以精确量的。三条判据：
 *   ① body.scrollHeight > body.clientHeight  → 内容撑破了 body
 *   ② 图表元素的矩形超出所属 body 的矩形      → 图表溢到面板外面
 *   ③ 两块面板的矩形相交                      → 面板互相压住了
 *
 * ---------------------------------------------------------------------------
 * 页签遍历（数字孪生页 / 分析决策页）
 * ---------------------------------------------------------------------------
 * 05 数字孪生页只有一列 400px 的面板位，三块面板靠底部页签切换（同一时刻只有一块
 * 在 DOM 里）；06 分析决策页靠顶栏四维切换，成本效益 8 块、生产 4 块、安全 4 块、
 * 能耗 6 块。只量默认态的话，其余态从没被量过，而报告里照样是绿的。
 * 所以对这类页面额外遍历每个页签态，三条判据一起判：
 *
 *   A. 该态下 `.panel-box` 数 ≥ 1 —— 数量为 0 就是「页签点了没反应」，
 *      `measurePanels` 会返回空数组、循环体一次都不进、**一行红字都没有**。
 *      这是最危险的静默全绿，必须显式判死。
 *   B. 各态标题集合两两不同 —— 证「真的换了内容」，不是几个页签同一块面板。
 *   C. 与**硬编码规格**逐一比对（按集合）—— 期望标题写在下面的 TAB_PAGES 里，
 *      不从页面源码读。从被测对象里取期望值，检查就成了同义反复。
 *      分析决策页成本效益维那 8 个标题是甲方硬要求的「一字不动」的守门人。
 *
 * 数字孪生页另加一条「页签 ↔ 三维图层」联动断言：切到哪一态，就只有那一组实体
 * 是显示的。面板换了、三维没换，也是一种「看起来正常」的不一致。
 * 分析决策页没有三维场景，该字段省略即整段跳过（是不适用，不是通过）。
 *
 * 用法：
 *   node scripts/check-panel-overflow.mjs [baseUrl]
 *   node scripts/check-panel-overflow.mjs --self-test    # 自证：先注入缺陷，确认检查真的会红
 *
 * `--self-test` 不是可选装饰。**一个从没见过它变红的检查不算证据**——
 * 它做三段：
 *   1. 首页在「产量统计」的图表容器上写死一个高度，断言三条判据确实报警；
 *   2. **切到数字孪生页的非默认页签**再做一遍，并且先断言默认态的面板已经消失
 *      （若没消失，说明页签压根没切，后面量到的还是默认态 —— 那这条遍历就是空转）；
 *   3. 分析决策页切到**离默认态最远**的「能耗单耗」再做一遍，并额外断言
 *      ① 面板容器仍在 84px 顶栏下方、正好 996px 高（顶栏插槽没吃掉内容高度的结构性前提）；
 *      ② 成本效益维的 8 块面板与硬编码规格一致；
 *      ③ 该维每块面板的 body 高 > 0 —— 面板被「隐藏」而非「卸载」时三条判据会全部
 *         平凡为真，报告里会出现一排 body 0×0 的绿灯行。
 * 不加这个参数时行为不变。
 *
 * ⚠️ 注入的高度**由实测的 body 高度算出来**（×2），不写死像素值。
 * 写死的数字会随布局变化悄悄失去杀伤力：面板 body 一旦长到 562px，
 * 注入 200px 就成了「把图表改矮」，判据当然不响，于是自证变成
 * 「注入缺陷后仍然全绿」的假红——或者更糟，被当成检查有分辨力。
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'

const argv = process.argv.slice(2)
const selfTest = argv.includes('--self-test')
const base = argv.find((a) => !a.startsWith('--')) || 'http://localhost:8787'

/** 有面板的页面。坐标拾取工具页与占位页没有面板，不在此列 */
const PAGES = ['/', '/safety', '/production', '/equipment', '/emergency', '/decision']

/**
 * 靠页签切换面板的页面。
 *
 * `expect[i]` 是页签 `tabs[i]` 下**应当出现且仅出现**的面板标题**数组**：
 * 数字孪生页一次只显示一块，分析决策页一次显示 4～8 块，所以这里统一按
 * **集合**比对 —— 少一块、多一块、标题写错都会红，而顺序不参与判定。
 *
 * `layerGroups[i]` 是同一态下唯一应当显示的实体 id 前缀。分析决策页没有三维场景，
 * 这个字段**可以省略**，省略即跳过页签 ↔ 图层联动那一段（不是"通过"，是不适用）。
 */
const TAB_PAGES = [
  {
    path: '/digital-twin',
    tabSelector: '.twin__tab',
    tabs: ['设备效率', '风险分布', '边坡监测'],
    expect: [
      ['设备定位与作业效率'],
      ['三类安全风险四色分布'],
      ['边坡位移监测与动态模拟']
    ],
    layerGroups: ['twin-device-', 'twin-risk-', 'slope-']
  },
  {
    path: '/decision',
    tabSelector: '.decision__dim',
    tabs: ['成本效益', '生产分析', '安全分析', '能耗单耗'],
    expect: [
      // 成本效益维是本页改造前的原样 —— 这 8 个标题就是「一字不动」的守门人
      [
        '年度成本对比',
        '前 5 大支出项',
        '各类型成本分布',
        '维护成本月度趋势',
        '用水用电成本月度趋势',
        '人力成本月度趋势',
        '效益分析',
        '智能辅助决策建议'
      ],
      // §9.2-1
      ['产量趋势（计划 vs 实际）', '设备利用率', '工序效率', '损失贫化率趋势'],
      // §9.2-2
      [
        '隐患类型分布',
        '事故率趋势',
        '「三违」行为统计（按类别）',
        '「三违」行为统计（按区队）'
      ],
      // §9.2-3
      ['峰谷平电费', '能耗构成', '水消耗', '单耗趋势', '吨成本拆解', '单机成本']
    ]
  }
]

// ---------- 规格自身的静态自检（不开浏览器） ----------
// 期望标题若写成同一个字符串，判据 C 就退化成「页面里有一块面板」，而这个退化**不报错**。
// 所以在这里静态断言掉，跑之前就拦住。
for (const spec of TAB_PAGES) {
  if (spec.expect.length !== spec.tabs.length) {
    console.error(`✗ ${spec.path} 的 tabs( ${spec.tabs.length} ) 与 expect( ${spec.expect.length} ) 长度不一致`)
    process.exit(1)
  }
  if (spec.layerGroups && spec.layerGroups.length !== spec.tabs.length) {
    console.error(`✗ ${spec.path} 的 layerGroups 与 tabs 长度不一致`)
    process.exit(1)
  }
  for (const [i, titles] of spec.expect.entries()) {
    if (!titles.length) {
      console.error(`✗ ${spec.path} 页签「${spec.tabs[i]}」的期望标题是空的，判据 C 会退化成恒真`)
      process.exit(1)
    }
    const dup = titles.filter((t, k) => titles.indexOf(t) !== k)
    if (dup.length) {
      console.error(
        `✗ ${spec.path} 页签「${spec.tabs[i]}」的期望标题有重复（${[...new Set(dup)].join('、')}），` +
          `按集合比对时这会少判一块面板`
      )
      process.exit(1)
    }
  }
  // 同一页里两个页签的期望集合若完全相同，判据 B（各态标题不同）必然红，
  // 与其跑完再看红字，不如在这里说清原因
  const sigs = spec.expect.map((t) => [...t].sort().join('|'))
  for (let a = 0; a < sigs.length; a++) {
    for (let b = a + 1; b < sigs.length; b++) {
      if (sigs[a] === sigs[b]) {
        console.error(
          `✗ ${spec.path} 的页签「${spec.tabs[a]}」与「${spec.tabs[b]}」期望标题集合相同 —— ` +
            `判据 B 永远为红，规格写错了`
        )
        process.exit(1)
      }
    }
  }
}

/** 量当前页所有面板。判据就是上面注释里的三条。 */
const measurePanels = (page) =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.panel-box')]
    const rects = boxes.map((b) => ({ el: b, r: b.getBoundingClientRect() }))
    const out = []

    for (const b of boxes) {
      const title = b.querySelector('.panel-box__title')?.textContent.trim() ?? '(无标题)'
      const body = b.querySelector('.panel-box__body')
      const r = b.getBoundingClientRect()
      const rec = { title, spill: 0, outside: null, overlap: null, body: '', charts: 0 }
      if (!body) {
        out.push(rec)
        continue
      }

      const br = body.getBoundingClientRect()
      rec.body = `${Math.round(br.width)}×${Math.round(br.height)}`
      rec.bodyHeight = Math.round(br.height)

      // 判据 ① body 被内容撑破
      // （.panel-box__body 有 overflow: hidden，撑破时内容是**被裁掉**而不是压出去，
      //   但 scrollHeight 照实报告内容高度，所以这条照样响）
      rec.spill = body.scrollHeight - body.clientHeight

      // 判据 ② 图表溢到 body 外面（1px 容差给边框与亚像素）
      const inner = [...body.querySelectorAll('.echart-box, .echart-box canvas')]
      rec.charts = inner.filter((e) => e.tagName === 'CANVAS').length
      for (const el of inner) {
        const er = el.getBoundingClientRect()
        if (er.bottom > br.bottom + 1 || er.right > br.right + 1 || er.top < br.top - 1) {
          rec.outside = `${el.className.split(' ')[0] || el.tagName} 超出 ${Math.round(er.bottom - br.bottom)}px`
          break
        }
      }

      // 判据 ③ 压到别的面板上
      for (const o of rects) {
        if (o.el === b) continue
        if (r.left < o.r.right - 1 && r.right > o.r.left + 1 && r.top < o.r.bottom - 1 && r.bottom > o.r.top + 1) {
          rec.overlap = o.el.querySelector('.panel-box__title')?.textContent.trim() ?? '(无标题)'
          break
        }
      }
      out.push(rec)
    }
    return out
  })

/** 面板有没有问题（判据命中就返回原因数组） */
const issuesOf = (p) => {
  const issues = []
  if (p.spill > 0) issues.push(`body 被撑破 ${p.spill}px`)
  if (p.outside) issues.push(p.outside)
  if (p.overlap) issues.push(`压到「${p.overlap}」`)
  return issues
}

const session = await login(base)

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=3072']
})
const page = await newLoggedInPage(browser, session, { viewport: { width: 1920, height: 1080 } })

/** 等页面把面板和图表都排好版 */
const settle = async (path, selector = '.panel-box', extra = 9000) => {
  await page.goto(base + '/#' + path, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForSelector(selector, { timeout: 30000 })
  // ECharts 画完后会把容器尺寸定下来，面板要重新排一次版
  await page.waitForTimeout(extra)
}

/** 停掉 Cesium 渲染循环：它每帧重绘，会把后面的量测拖到超时 */
const stopRenderLoop = () =>
  page.evaluate(() => {
    const v = window.__cesiumViewer
    if (v) v.useDefaultRenderLoop = false
  })

/**
 * `waitForFunction` 一律带定时器轮询，不用 Playwright 默认的 `raf`。
 *
 * 这不是因为踩过坑 —— **恰恰相反，它是排查另一个坑时顺手加的，而那次排查的
 * 结论是错的**，这里留个记号免得后人重走：
 *   自证的第二段一直超时，报「切页签后等不到标题」。当时的现场是
 *     切「风险分布」后 60956ms 仍未出现标题 ["三类安全风险四色分布"]
 *       现场：页签 active=[false,true,false]　面板标题=["三类安全风险四色分布"]
 *   —— **条件早就成立，等待却一直挂着**，看起来完全像「轮询函数没被执行」。
 *   于是怀疑：无头 Chromium 里 rAF 靠合成器产帧驱动，而 `stopRenderLoop()`
 *   之后没人再请求帧 ⇒ rAF 不回调 ⇒ 轮询被饿死。
 *   但这个假设**被证伪了**：改成 `polling: 250`（定时器）**照样超时 60s**。
 *   真凶在调用处 —— 期望值 `spec.expect[i]` 是**标题数组**，而谓词把它当成
 *   单个字符串比，恒为 false。见那段旁边的注释。
 *
 * 那为什么还留着 `polling`？因为「渲染循环停掉后 rAF 可能被节流」是真实存在的
 * 行为，只是**在本项目没有复现**；而我们对帧对齐没有任何需求，定时器轮询是
 * 严格更稳的选择，代价为零。这是一个未经证实的加固，不是一条经验教训。
 */
const POLL = { polling: 250 }

/** 三维实体显隐探针：按 id 前缀统计显示/隐藏数量 */
const layerProbe = (prefixes) =>
  page.evaluate((list) => {
    const v = window.__cesiumViewer
    if (!v) return null
    const out = {}
    for (const prefix of list) {
      let on = 0
      let off = 0
      for (const e of v.entities.values) {
        if (typeof e.id !== 'string' || !e.id.startsWith(prefix)) continue
        if (e.show) on++
        else off++
      }
      out[prefix] = { on, off }
    }
    return out
  }, prefixes)

/**
 * 等三组图层都建出来。
 *
 * 软件渲染下建场景要几十秒，比面板排版慢得多。探针在实体还没建完时跑，
 * 会把「还没轮到」误报成「图层没显示」——那是**假红**，比假绿好但也得避免。
 *
 * 实体建完 ⇒ `applyLayerVisibility()` 已经跑过了：建图层的那几个 await 一落地，
 * 后面的赋值与显隐刷新是同一个微任务里同步做完的，浏览器来不及插进一次轮询。
 */
async function waitForLayers(prefixes) {
  try {
    await page.waitForFunction(
      (list) => {
        const v = window.__cesiumViewer
        if (!v) return false
        return list.every((p) =>
          v.entities.values.some((e) => typeof e.id === 'string' && e.id.startsWith(p))
        )
      },
      prefixes,
      { timeout: 240000, ...POLL }
    )
    return true
  } catch {
    return false
  }
}

// ---------- 页签遍历 ----------
/** 按页签逐个量过去。返回该页测量到的标题集，供判据 B 用 */
async function runTabPage(spec) {
  await settle(spec.path)
  console.log(`\n### ${spec.path}  （页签遍历 ${spec.tabs.length} 态）`)

  // 图层探针要等场景建完；建不出来就明说，不要让探针返回半截结果。
  // 没有 layerGroups 的页面（分析决策）本就没有三维场景，这一段整体跳过。
  const needLayers = Array.isArray(spec.layerGroups)
  const layersReady = needLayers ? await waitForLayers(spec.layerGroups) : false
  if (needLayers && !layersReady) {
    rows.push({
      path: spec.path,
      title: '(图层探针)',
      issues: ['三维图层在 240s 内没建出来，页签 ↔ 图层联动这一条没能验证（不是通过）']
    })
  }

  const titleSets = []

  for (const [i, label] of spec.tabs.entries()) {
    if (i > 0) {
      try {
        await page.locator(spec.tabSelector).nth(i).click({ timeout: 10000 })
        // 等**全部**期望面板标题都出现。用固定 sleep 的话，「点了没反应」也会被放过去；
        // 只等第一块则会在「切了一半」时误判成功。
        await page.waitForFunction(
          (want) =>
            want.every((t) =>
              [...document.querySelectorAll('.panel-box__title')].some(
                (el) => el.textContent.trim() === t
              )
            ),
          spec.expect[i],
          { timeout: 20000, ...POLL }
        )
      } catch {
        console.log(`  ✗ 页签「${label}」点了没反应：等不到面板「${spec.expect[i]}」出现`)
        rows.push({
          path: `${spec.path} [${label}]`,
          title: '(切换失败)',
          issues: ['等不到期望面板出现 —— 这一态从没被量过']
        })
        titleSets.push([])
        continue
      }
    } else {
      await page.waitForTimeout(2500)
    }

    const panels = await measurePanels(page)
    const titles = panels.map((p) => p.title)
    titleSets.push(titles)

    console.log(`\n  ── 页签「${label}」  （${panels.length} 块面板）`)
    for (const p of panels) {
      const issues = issuesOf(p)
      rows.push({ path: `${spec.path} [${label}]`, title: p.title, issues })
      console.log(
        `    ${issues.length ? '✗' : '✓'} ${p.title.padEnd(12, '　')} body ${p.body.padEnd(10)} canvas ${p.charts}` +
          (issues.length ? `  → ${issues.join('；')}` : '')
      )
    }

    // 判据 A：一块面板都没有 = 页签点了没反应，必须显式判死
    const want = spec.expect[i]
    if (panels.length === 0) {
      rows.push({
        path: `${spec.path} [${label}]`,
        title: '(无面板)',
        issues: ['该页签下一块面板都没有 —— 页签点了没反应，这一态从没被量过']
      })
    } else if ([...titles].sort().join('|') !== [...want].sort().join('|')) {
      // 判据 C：按**集合**比对 —— 顺序不计，少一块、多一块、标题写错都要红
      const missing = want.filter((t) => !titles.includes(t))
      const extra = titles.filter((t) => !want.includes(t))
      const why = [
        missing.length ? `缺 ${JSON.stringify(missing)}` : '',
        extra.length ? `多 ${JSON.stringify(extra)}` : ''
      ]
        .filter(Boolean)
        .join('、')
      rows.push({
        path: `${spec.path} [${label}]`,
        title: '(标题不符)',
        issues: [`应恰好是规格里的 ${want.length} 块面板，实测 ${titles.length} 块：${why}`]
      })
    }

    // 页签 ↔ 三维图层联动：只有当前那一组实体该是显示的
    const probe = layersReady ? await layerProbe(spec.layerGroups) : null
    if (!needLayers) {
      // 该页没有三维场景，这一段不适用（上面不打「没验证」的红字，避免误报）
    } else if (!layersReady) {
      // 上面已经记过一次「图层没建出来」，这里不再每个页签重复刷屏
    } else if (!probe) {
      rows.push({
        path: `${spec.path} [${label}]`,
        title: '(图层探针)',
        issues: ['拿不到 window.__cesiumViewer，图层联动没能验证（不是通过）']
      })
    } else {
      for (const [gi, prefix] of spec.layerGroups.entries()) {
        const { on, off } = probe[prefix]
        const wantOn = gi === i
        if (wantOn && on === 0) {
          rows.push({
            path: `${spec.path} [${label}]`,
            title: '(图层)',
            issues: [`当前页签对应的 ${prefix}* 实体一个都没显示（共 ${on + off} 个）`]
          })
        } else if (!wantOn && on > 0) {
          rows.push({
            path: `${spec.path} [${label}]`,
            title: '(图层)',
            issues: [`非当前页签的 ${prefix}* 实体有 ${on} 个还在显示，三维与页签不一致`]
          })
        }
      }
      console.log(
        `    图层：` +
          spec.layerGroups
            .map((p, gi) => `${p}${probe[p].on}/${probe[p].on + probe[p].off}${gi === i ? '(当前)' : ''}`)
            .join('  ')
      )
    }
  }

  // 判据 B：各态标题集合两两不同
  const normalized = titleSets.map((t) => [...t].sort().join('|'))
  for (let a = 0; a < normalized.length; a++) {
    for (let b = a + 1; b < normalized.length; b++) {
      if (normalized[a] === normalized[b] && normalized[a] !== '') {
        rows.push({
          path: `${spec.path}`,
          title: '(页签重复)',
          issues: [
            `页签「${spec.tabs[a]}」与「${spec.tabs[b]}」的面板标题集合完全相同 —— ` +
              `两个页签显示的是同一块面板`
          ]
        })
      }
    }
  }

  await stopRenderLoop()
}

const rows = []

if (selfTest) {
  // ------------------------------ 自证模式 ------------------------------
  // 页面现在默认要登录，会话由上面的 newLoggedInPage 注入（见 lib/session.mjs）

  // ---- 第一段：首页「产量统计」注入超高图表 ----
  const TARGET = '产量统计'
  await settle('/')
  const pick = (list, title) => list.find((r) => r.title === title)

  const clean = pick(await measurePanels(page), TARGET)
  const cleanIssues = issuesOf(clean)
  console.log(`【注入前】${TARGET}：body ${clean.body}，图表未溢出`)
  console.log(`  判据命中：${cleanIssues.length ? cleanIssues.join('；') : '无（期望无）'}`)

  // 注入缺陷：等价于把源码里的 height="100%" 写回一个够大的像素值。
  // 高度按实测 body 的 2 倍算 —— 写死数字会随布局变化失去杀伤力（见文件头注释）。
  const injectHeight = Math.round(clean.bodyHeight * 2)
  await page.evaluate(
    ({ t, h }) => {
      const box = [...document.querySelectorAll('.panel-box')].find(
        (b) => b.querySelector('.panel-box__title')?.textContent.trim() === t
      )
      box.querySelector('.echart-box').style.height = `${h}px`
    },
    { t: TARGET, h: injectHeight }
  )
  await page.waitForTimeout(1500)

  const dirty = pick(await measurePanels(page), TARGET)
  const dirtyIssues = issuesOf(dirty)
  console.log(`\n【注入后】${TARGET} 的图表容器写死 ${injectHeight}px（body 的 2 倍），body 仍是 ${dirty.body}`)
  console.log(`  判据命中：${dirtyIssues.length ? dirtyIssues.join('；') : '无（期望报警）'}`)

  // ---- 第二段：数字孪生页的非默认页签 ----
  // 这一段才是「页签遍历有分辨力」的证据：若遍历只量默认态，下面第一步就会失败
  const spec = TAB_PAGES[0]
  await settle(spec.path)
  // 顺序：**先等场景建完，再停渲染循环**（与常规体检那条路径 runTabPage 一致）。
  // 理由与那次超时无关 —— 那次超时是谓词写错（见下面 waitForFunction 的注释），
  // 不是这里漏了等待。改成现在这样是为了对齐已跑通的路径，外加一个独立成立的
  // 理由：瓦片与几何都是在渲染循环里加载的，场景没建完就置
  // useDefaultRenderLoop = false，等于把建造过程冻在半路。
  // settle() 只等 9s，而 SwiftShader 下实体要到 ~29s 才齐（探针实测）。
  const tLayers = Date.now()
  const layersReady = await waitForLayers(spec.layerGroups)
  console.log(`\n【页签自证】等三维图层：${layersReady ? '齐了' : '**没等到**'}（${Date.now() - tLayers}ms）`)
  if (!layersReady) {
    // 场景建不出来时，页签断言会以「超时」形式失败，看起来像页签坏了 ——
    // 那种红是误导。明说清楚是哪一步没成立。
    rows.push({
      path: spec.path,
      title: '(页签自证)',
      issues: ['三维图层 240s 内没建出来，页签自证这一步没能执行（不是通过）']
    })
  }
  await stopRenderLoop()

  // 先切到第 2 个页签（非默认态）
  const tClick = Date.now()
  await page.locator(spec.tabSelector).nth(1).click({ timeout: 10000 })
  try {
    // ⚠️ `spec.expect[i]` 是**标题数组**，不是单个标题：必须 `every` 逐一比。
    // 这里曾经写成 `some((el) => el.textContent.trim() === t)` 而把整个数组当 t，
    // 于是 `'三类安全风险四色分布' === ['三类安全风险四色分布']` 恒为 false ——
    // **判据永远不成立**，页签明明切对了也一路等到超时。
    await page.waitForFunction(
      (want) =>
        want.every((t) =>
          [...document.querySelectorAll('.panel-box__title')].some(
            (el) => el.textContent.trim() === t
          )
        ),
      spec.expect[1],
      { timeout: 60000, ...POLL }
    )
  } catch {
    // 超时不该只丢一句 stack：把「点了没反应」与「等不到」当场分开。
    // 这条是被两次误诊逼出来的 —— 前两轮都停在 20s/60s 超时上，
    // 而真正的状态（页签有没有换、面板标题是什么）当时一个字都没打出来。
    const st = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.twin__tab')]
      return {
        active: tabs.map((t) => /active|on|checked/.test(t.className)),
        titles: [...document.querySelectorAll('.panel-box__title')].map((e) => e.textContent.trim()),
        ent: window.__cesiumViewer?.entities.values.length ?? -1
      }
    })
    console.log(`  ✗ 切「${spec.tabs[1]}」后 ${Date.now() - tClick}ms 仍未出现标题 ${JSON.stringify(spec.expect[1])}`)
    console.log(`    现场：页签 active=${JSON.stringify(st.active)}　面板标题=${JSON.stringify(st.titles)}　实体 ${st.ent}`)
    throw new Error('页签切换后等不到期望面板标题（现场见上）')
  }

  const tabPanels = await measurePanels(page)
  const tabTitles = tabPanels.map((p) => p.title)
  // 默认态的面板必须已经不在 DOM 里。还在 ⇒ 页签压根没切，
  // 下面量到的仍然是默认态，遍历等于没做。
  const defaultGone = !tabTitles.includes(spec.expect[0])
  console.log(`\n【页签自证】切到「${spec.tabs[1]}」后 DOM 里面板：${JSON.stringify(tabTitles)}`)
  console.log(`  默认态面板「${spec.expect[0]}」已消失：${defaultGone ? '是（期望是）' : '否（期望是）'}`)

  const tabCleanIssues = tabPanels.flatMap(issuesOf)
  console.log(`  判据命中：${tabCleanIssues.length ? tabCleanIssues.join('；') : '无（期望无）'}`)

  const tabInject = Math.round((tabPanels[0]?.bodyHeight ?? 300) * 2)
  await page.evaluate(
    ({ h }) => {
      const el = document.querySelector('.panel-box .echart-box')
      if (el) el.style.height = `${h}px`
    },
    { h: tabInject }
  )
  await page.waitForTimeout(1500)

  const tabDirtyPanels = await measurePanels(page)
  const tabDirtyIssues = tabDirtyPanels.flatMap(issuesOf)
  console.log(`\n【页签注入】「${spec.tabs[1]}」的图表容器写死 ${tabInject}px（body 的 2 倍）`)
  console.log(`  判据命中：${tabDirtyIssues.length ? tabDirtyIssues.join('；') : '无（期望报警）'}`)

  // ---- 第三段：分析决策页的四维切换 ----
  // 这一段要证三件事：成本效益维与硬编码规格一致；切到别的维后它真的从 DOM 消失；
  // 在非默认维注入缺陷会红（否则「只量了默认维」也会全绿）。
  const dspec = TAB_PAGES[1]
  await settle(dspec.path)

  // 顶栏插槽有没有吃掉内容高度 —— 这是「成本效益维的面板矩形与本页改造前一致」的
  // 结构性前提：面板容器必须仍从 84px（顶栏高）开始，且正好 996px 高。
  const geom = await page.evaluate(() => {
    const r = document.querySelector('.decision__main')?.getBoundingClientRect()
    return r ? { top: Math.round(r.top), height: Math.round(r.height) } : null
  })
  const geomOk = !!geom && geom.top === 84 && geom.height === 996

  const costPanels = await measurePanels(page)
  const costTitles = costPanels.map((p) => p.title)
  const costSpecOk =
    [...costTitles].sort().join('|') === [...dspec.expect[0]].sort().join('|')
  console.log(
    `\n【四维自证】成本效益维面板容器 top ${geom?.top} 高 ${geom?.height}（期望 84 / 996）` +
      `　面板 ${costTitles.length} 块，与硬编码规格一致：${costSpecOk ? '是' : '否'}`
  )

  // 切到最后一个维度（离默认态最远）
  const k = dspec.tabs.length - 1
  await page.locator(dspec.tabSelector).nth(k).click({ timeout: 10000 })
  await page.waitForFunction(
    (want) =>
      want.every((t) =>
        [...document.querySelectorAll('.panel-box__title')].some(
          (el) => el.textContent.trim() === t
        )
      ),
    dspec.expect[k],
    { timeout: 20000, ...POLL }
  )

  const dimPanels = await measurePanels(page)
  const dimTitles = dimPanels.map((p) => p.title)
  // 默认维的面板必须已经不在 DOM 里。还在 ⇒ 用的是 v-show，隐藏面板量出来是全 0，
  // 三条判据会全部平凡为真，报告里出现一排 body 0×0 的绿灯行。
  const costGone = !dimTitles.some((t) => dspec.expect[0].includes(t))
  const dimCleanIssues = dimPanels.flatMap(issuesOf)
  // 每一块都真占了面积 —— 有 body 高 0 的面板，说明它是被隐藏而不是被卸载，
  // 那种面板的三条判据会全部平凡为真（这是一条独立的、比标题比对更硬的判据）
  const minBody = Math.min(...dimPanels.map((p) => p.bodyHeight ?? 0))
  const allSized = dimPanels.length > 0 && minBody > 0
  console.log(`\n【四维自证】切到「${dspec.tabs[k]}」后 DOM 里面板：${JSON.stringify(dimTitles)}`)
  console.log(`  成本效益维的面板已消失：${costGone ? '是（期望是）' : '否（期望是）'}`)
  console.log(`  最小 body 高 ${minBody}px（> 0 才说明面板真的渲染出来了，不是被隐藏）`)
  console.log(`  判据命中：${dimCleanIssues.length ? dimCleanIssues.join('；') : '无（期望无）'}`)

  const dimInject = Math.round((dimPanels[0]?.bodyHeight ?? 300) * 2)
  await page.evaluate(
    ({ h }) => {
      const el = document.querySelector('.panel-box .echart-box')
      if (el) el.style.height = `${h}px`
    },
    { h: dimInject }
  )
  await page.waitForTimeout(1500)

  const dimDirtyIssues = (await measurePanels(page)).flatMap(issuesOf)
  console.log(`\n【四维注入】「${dspec.tabs[k]}」的图表容器写死 ${dimInject}px（body 的 2 倍）`)
  console.log(`  判据命中：${dimDirtyIssues.length ? dimDirtyIssues.join('；') : '无（期望报警）'}`)

  await browser.close()

  console.log('\n' + '='.repeat(64))
  const checks = [
    ['首页干净状态不误报', cleanIssues.length === 0],
    ['首页注入缺陷后确实报警', dirtyIssues.length > 0],
    ['页签确实切换了（默认态面板已消失）', defaultGone],
    ['非默认页签干净状态不误报', tabCleanIssues.length === 0],
    ['非默认页签注入缺陷后确实报警 —— 遍历不是空转', tabDirtyIssues.length > 0],
    ['分析决策页顶栏插槽没吃掉内容高度（top 84 / 高 996）', geomOk],
    ['成本效益维的 8 块面板与硬编码规格一致（「一字不动」的守门人）', costSpecOk],
    ['四维切换卸载了默认维（不是 v-show 隐藏）', costGone],
    ['非默认维度的每块面板都真占了面积（body 高 > 0）', allSized],
    ['非默认维度干净状态不误报', dimCleanIssues.length === 0],
    ['非默认维度注入缺陷后确实报警', dimDirtyIssues.length > 0]
  ]
  for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`)
  console.log('='.repeat(64))
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
}

// ------------------------------ 常规体检 ------------------------------
for (const path of PAGES) {
  await settle(path)
  const panels = await measurePanels(page)

  console.log(`\n### ${path}  （${panels.length} 块面板）`)
  for (const p of panels) {
    const issues = issuesOf(p)
    rows.push({ path, title: p.title, issues })
    console.log(
      `  ${issues.length ? '✗' : '✓'} ${p.title.padEnd(12, '　')} body ${p.body.padEnd(10)} canvas ${p.charts}` +
        (issues.length ? `  → ${issues.join('；')}` : '')
    )
  }
  await stopRenderLoop()
}

for (const spec of TAB_PAGES) {
  await runTabPage(spec)
}

await browser.close()

const broken = rows.filter((r) => r.issues.length)
console.log('\n' + '='.repeat(64))
if (broken.length) {
  console.error(`✗ ${broken.length}/${rows.length} 处问题：`)
  for (const r of broken) console.error(`   ${r.path} 「${r.title}」：${r.issues.join('，')}`)
} else {
  console.log(`✓ ${rows.length} 项全部无撑破、无溢出、无重叠，页签遍历与图层联动一致`)
}
process.exit(broken.length ? 1 : 0)
