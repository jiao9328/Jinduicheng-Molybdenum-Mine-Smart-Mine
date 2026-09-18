/**
 * 建场景加载与底图存活检查 —— 守住两个「沉默失效」型的坑。
 *
 * 这两条都在同一个位置（`useCesium` / `createViewer` 的启动时序）出现过，
 * 而且**都不报错**：一个只是慢到永远建不完，一个是底图被悄悄删掉。
 * 靠肉眼看截图分辨不出来，所以各立一条判据。
 *
 * ── 断言组 A：提前缓存真的把瓦片抢在 Cesium 前面取回来了 ──
 *
 * 病根：`loadTerrariumHeights` 没有缓存，410 个采样点各自重取同一张 DEM 瓦片；
 * 修掉缓存之后仍有 4.3 秒，因为那一刻 Cesium 建地球已经开出几百个瓦片请求，
 * 采样的请求被挤在同域连接队尾。同一批 9 张瓦片：**空闲时 19ms，抢连接时 4269ms**。
 *
 * 所以 A2（`新取瓦片 0 张`）是这条检查的核心，它测的是**机制**而不是速度：
 * 无论机器快慢，只要预热覆盖到了采样真正要的瓦片，采样就一张都不该再取。
 * 这条一红，说明预热白做了（窗口偏了 / 没 await / 被删了），
 * 而 A3 的耗时在快机器上可能**依然是绿的**。
 *
 * ── 断言组 B：滚轮缩放之后底图不许消失 ──
 *
 * 病根：`createViewer` 里有个从 viewer **创建**起算 12 秒的兜底，
 * 到点若 `loadedTileCount === 0` 就 `imageryLayers.removeAll(true)` +
 * `globe.show = false`——**不可恢复**。而那 12 秒正是主线程被建场景占满的时刻，
 * 影像请求根本排不上，于是兜底在正常机器上稳定误触发。
 * 用户看到的就是「滚一下滚轮底图就没了」。
 *
 * B 必须在**建完场景之后、且跨过 12 秒**再断言，否则测不到那个窗口。
 * 判据从「结构」上取（图层还在不在、地球还显不显、请求还在不在发），
 * 不从像素取：缩得远时瓦片本来就不覆盖，`baseColor` 会正常露出来，
 * 拿像素判断会把「正常露底色」误判成「底图没了」。
 *
 * 用法：node scripts/check-scene-load.mjs [baseUrl]
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'

const base = process.argv[2] || 'http://localhost:8787'

/**
 * A3 的耗时上限（ms）。
 *
 * 原值 20000，理由是「实测 1.1s，留足余量够抓『永远建不完』」。
 * 2026-09-18 起默认打开在线实景三维（见 .env.example），它给建场景加了一个
 * **确定的** 15 秒：该资产的数据托管在 `tile.googleapis.com`（Google），
 * 国内网络连不上，要等 `ONLINE_3D_TIMEOUT_MS` 到点才回退程序化场景。
 * 实测 17851ms —— 离 20000 只剩 2.1 秒余量，机器稍慢就会假红。
 *
 * 放宽到 30000 **不是为了让某一次变绿**：A3 抓的是「永远建不完」（曾经的病根是
 * 410 个采样点各自重取同一张瓦片，96 秒时实体仍是 0 个），那是个无限的过程，
 * 30 秒和 20 秒一样抓得到。真正量「预热有没有生效」的是 A2（新取瓦片 0 张），
 * 那条**一个字没动**。
 */
const BUILD_BUDGET_MS = 30000
/** 原破坏性兜底的触发窗口（ms）。必须跨过它再验 B，否则测不到 */
const FALLBACK_WINDOW_MS = 12000

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

// 收集建场景期间的关键日志
const terrainLogs = []
page.on('console', (m) => {
  const t = m.text()
  if (t.startsWith('[terrain]')) terrainLogs.push(t)
})
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)))

const checks = []

const t0 = Date.now()
await page.goto(base + '/#/', { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(
  () => (window.__cesiumViewer?.entities?.values?.length ?? 0) > 0,
  null,
  { timeout: 180000 }
)
const buildMs = Date.now() - t0

// ---------- 断言组 A ----------
console.log('--- 建场景日志 ---')
for (const line of terrainLogs) console.log('   ' + line)
console.log('')

const prewarmLine = terrainLogs.find((t) => t.includes('预热'))
// 预热读数形如「预热第14级瓦片 9/9 张，用时 19ms」
const prewarmMatch = prewarmLine?.match(/预热第(\d+)级瓦片\s+(\d+)\/(\d+)\s+张/)
checks.push(['[A1] 预热跑过了', !!prewarmMatch])
if (prewarmMatch) {
  const [, level, ok, total] = prewarmMatch
  checks.push([`[A1] 预热全部落地（第${level}级 ${ok}/${total} 张）`, ok === total])
}

// 核心判据：采样不该再自己取瓦片
const sampleLines = terrainLogs.filter((t) => t.includes('采样'))
const sampleFetches = sampleLines.map((t) => Number(t.match(/新取瓦片\s+(\d+)\s+张/)?.[1] ?? NaN))
checks.push(['[A2] 采样有读数', sampleLines.length > 0 && sampleFetches.every(Number.isFinite)])
if (sampleLines.length) {
  checks.push([
    `[A2] 采样一张瓦片都不用再取（逐次读数：${sampleFetches.join(', ')}）`,
    sampleFetches.every((n) => n === 0)
  ])
}

checks.push([`[A3] 建场景在 ${BUILD_BUDGET_MS}ms 内出实体（实测 ${buildMs}ms）`, buildMs <= BUILD_BUDGET_MS])

// ---------- 断言组 B ----------
//
// 先等过原兜底的触发窗口 —— 这一步不能省，省了就测在坑外面。
//
// 原兜底是**从 viewer 创建时刻**起算 12 秒，而 viewer 一定创建在实体出现之前，
// 所以「实体出现之后再等 12 秒」必然跨过那个窗口。
// （别用 `performance.now()` 当 viewer 年龄：那是从导航开始算的，比创建时刻早，
//   会让等待被跳过，于是整条 B 组测在坑外面还全绿 —— 正是这条检查要防的那种错。）
await page.waitForTimeout(FALLBACK_WINDOW_MS + 1500)

/** 取底图存活状态：地球显不显、图层在不在、请求还在不在发 */
const imageryState = () =>
  page.evaluate(() => {
    const v = window.__cesiumViewer
    if (!v || v.isDestroyed()) return { destroyed: true }
    let requested = 0
    let loaded = 0
    const layers = v.imageryLayers
    for (let i = 0; i < layers.length; i++) {
      const p = layers.get(i).imageryProvider
      requested += p?.requestedTileCount ?? 0
      loaded += p?.loadedTileCount ?? 0
    }
    return {
      destroyed: false,
      globeShow: v.scene.globe.show,
      layers: layers.length,
      requested,
      loaded,
      cameraHeight: Math.round(v.camera.positionCartographic.height)
    }
  })

const before = await imageryState()
checks.push([`[B1] 底图初始挂载完好（globe.show=${before.globeShow} 图层=${before.layers}）`,
  before.globeShow === true && before.layers >= 1])

// 真滚轮：缩出去再放大回来，模拟用户那条操作路径
const canvas = page.locator('canvas').first()

/* ⚠️ 这里**不要**用 `canvas.hover()`。它除了挪指针，还要做 Playwright 那套
   「可见且稳定」的可操作性检查，而那个检查由注入脚本的 rAF 驱动 —— 会被
   Cesium + SwiftShader 的全屏渲染循环饿死，卡满 30 秒超时。报错停在 hover 上，
   看着像页面坏了，其实元素好好的（同源的坑见 lib/click.mjs 头部与 §13 第 31 条）。
   实测 2026-09-18：默认打开在线三维之后，多出来的那 15 秒超时窗口让它稳定复现。

   这里需要的只是「把指针挪到画布上」，好让下面的 wheel 滚画布而不是滚页面。
   `page.mouse.move` 是原始输入、不做任何可操作性检查，正合适。 */
const box = await canvas.boundingBox()
if (!box) throw new Error('画布没有边界框：页面还没渲染出来就去滚轮了')
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.wheel(0, 2400) // 缩小
await page.waitForTimeout(1200)
const zoomedOut = await imageryState()
await page.mouse.wheel(0, -2400) // 放大回来
await page.waitForTimeout(1200)

const after = await imageryState()
console.log(
  `--- 滚轮前后 ---\n` +
    `   滚轮前   高度=${before.cameraHeight}m globe.show=${before.globeShow} 图层=${before.layers} 请求=${before.requested} 落地=${before.loaded}\n` +
    `   缩到最远 高度=${zoomedOut.cameraHeight}m globe.show=${zoomedOut.globeShow} 图层=${zoomedOut.layers}\n` +
    `   放大回来 高度=${after.cameraHeight}m globe.show=${after.globeShow} 图层=${after.layers} 请求=${after.requested} 落地=${after.loaded}\n`
)

checks.push([`[B2] 缩小后底图仍在（globe.show=${zoomedOut.globeShow} 图层=${zoomedOut.layers}）`,
  zoomedOut.globeShow === true && zoomedOut.layers >= 1])
checks.push([`[B3] 放大回来后底图仍在（globe.show=${after.globeShow} 图层=${after.layers}）`,
  after.globeShow === true && after.layers >= 1])
// 图层「挂在」还不够，得证明它是活的：请求真的发出去了
checks.push([`[B4] 底图图层是活的（累计请求 ${after.requested} 张）`, after.requested > 0])

// ---------- 自证：B 的判据有没有分辨力 ----------
//
// B 全绿也可能是因为这条判据根本测不出「图层被删」。
// 手动把图层删掉、把地球关掉，B1/B2/B3 的判据**必须同时翻转**——
// 翻不过来就说明它们没有分辨力，上面那几条绿不作数。
await page.evaluate(() => {
  const v = window.__cesiumViewer
  v.imageryLayers.removeAll(true)
  v.scene.globe.show = false
})
await page.waitForTimeout(500)
const killed = await imageryState()
checks.push([`[自证] 手动删图层后判据翻转（globe.show=${killed.globeShow} 图层=${killed.layers}）`,
  killed.globeShow !== true || killed.layers < 1])

await browser.close()

console.log('\n' + '='.repeat(64))
for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`)
console.log('='.repeat(64))

const failed = checks.filter(([, ok]) => !ok)
if (failed.length) {
  console.log(`\n✗ ${failed.length}/${checks.length} 项不通过`)
  if (!prewarmMatch) {
    console.log('  预热一行都没打出来 —— 提前缓存没有生效，详见 localTerrain.ts 的 prewarmTerrainTiles')
  } else if (sampleFetches.some((n) => n !== 0)) {
    console.log('  预热跑了，但采样仍在自己取瓦片 —— 预热窗口没盖住采样真正要的那几张')
  }
} else {
  console.log(`\n✓ ${checks.length} 项全部通过 —— 建场景 ${buildMs}ms 出实体，滚轮缩放后底图不消失`)
}
process.exit(failed.length ? 1 : 0)
