/**
 * 地形细分深度巡检：把相机压到坑底上方 60m，量**Cesium 实际问到的最深瓦片层级**，
 * 断言它没有越过 `traversalQuadsByLevel` 的数组上限——越过了就是当初那类黑屏。
 *
 * ── 为什么要它 ──
 * 崩溃机理（`src/scene/localTerrain.ts:189-216` 记着全流程）：
 * `getLevelMaximumGeometricError` 曾经写成「超过最深缓存层级就返回 `levelZeroError`」，
 * 方向刚好反了：误差从 14 级的 9.5m 跳回 156543m，屏幕空间误差放大一万六千倍
 * → 每一帧都要求继续细分 → 四叉树无限下钻 → 层级越过 31 时
 * Cesium 的 `traversalQuadsByLevel[level]`（数组长 31，下标 0~30）取到 undefined，
 * 读它的 `.southwest` 抛「Cannot read properties of undefined」。
 * 要命的是抛出位置：在 `scene.render()` 的瓦片筛选里，不是从我们的 `await` 处抛，
 * 调用方 try/catch 拦不住，异常直接触发 `scene.renderError` → **Cesium 停止渲染，
 * 三维区永久黑屏**。只在相机贴地时才复现（飞到天上不需要那么深的细分）。
 *
 * ── 判据（四条，全部要过）──
 * ① **打桩确实被调用过**（`最深被问层级 >= 0`）。这条看着多余，其实是防假绿：
 *    打桩没生效时后面三条会全部通过，检查变成一具空壳。
 * ② `最深被问层级 <= 最深缓存层 + 1`——**余量一级是实测出来的**：压到坑底上方 60m 时
 *    Cesium 会问到 15 级，而缓存只到 14 级（`seen` 里 14 级、15 级的误差都是 0，
 *    细分就停在这一步）。没有这个余量，这条判据会对着健康的实现误红。
 *    **最深缓存层不是手抄的**，运行时从 provider 读（`maxCachedLevel`，退到 manifest 层级键）。
 *    读不到就是违规——那说明 manifest 或 provider 换了形状，检查的前提没了。
 * ③ `最深被问层级 <= 30`——Cesium 数组的硬上限。写死，因为它是 Cesium 的事实，
 *    不是本项目的常量（README 第 13 节第 17 条：判据不许从被测代码里读期望值）。
 * ④ `scene.renderError` 计数为 **0**。层级越界是它的成因之一，但不止那一种，
 *    这条把「渲染已经停了」直接抓住，不管什么原因。
 *
 * ── 俯冲点是**从场景里推的**，不手抄经纬度 ──
 * 取 `pit-bottom` 实体（`buildMineScene.ts:218`）的多边形顶点 → 经纬度 + 坑底标高
 * → 目的地 = 坑底上方 60m。这个文件原先写死 `109.954, 34.328, 1272 + 60`，
 * 而 README 第 13 节第 17 条记的就是「手抄坐标过时之后不报错」——
 * 搬一次家它照旧打印一堆像模像样的数字。**取不到 `pit-bottom` 直接判失败**，
 * 不静默跳过：那说明场景不是我们以为的那个场景。
 *
 * ── 它抓不到什么（如实写在这里，免得下次高估它）──
 * 1. **只在这一次俯冲上量**：判的是「压到坑底上方 60m 没越界」，
 *    不是「任何机位都不越界」。别的页面、别的俯冲角度它没量。
 * 2. **层级不越界 ≠ 地形是对的**：瓦片缺失、兜底平面被大量使用它都看不出来
 *    （那由实景截图与 `check-all-pages.mjs` 兜着）。
 * 3. **SwiftShader 软渲染**：判据只读层级与错误计数，与帧率无关；
 *    但一次跑要 2~3 分钟，浏览器起不来会超时失败（那就修环境，不是放宽判据）。
 *
 * 用法：node scripts/check-terrain-levels.mjs [url] [--self-test]
 * 默认 http://localhost:4173
 */
import { chromium } from 'playwright'

/** Cesium `traversalQuadsByLevel` 数组长 31，合法下标 0~30。写死——这是 Cesium 的事实。 */
export const 层级硬上限 = 30
/** 相对「最深缓存层」允许的余量（Cesium 可能提前询问上一级的几何误差） */
export const 层级余量 = 1

/**
 * 判据（纯函数，`--self-test` 直接喂合成样本）。
 * `测得` = { 最深被问层级, 最深缓存层, 渲染错误数 }
 * 返回违规说明数组，空数组 = 通过。
 */
export function 判(测得) {
  const 违规 = []
  const max = 测得.最深被问层级
  const 缓存 = 测得.最深缓存层

  if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) {
    违规.push(
      `打桩一次都没被调用（最深被问层级 = ${max}）——` +
        '后面的判据会全部通过，检查是假的'
    )
  }
  if (typeof 缓存 !== 'number' || !Number.isFinite(缓存) || 缓存 < 0) {
    违规.push(
      `读不到地形 provider 的最深缓存层（值 = ${缓存}）——` +
        '判据②失去参照，检查的前提没了'
    )
  } else if (typeof max === 'number' && Number.isFinite(max) && max > 缓存 + 层级余量) {
    违规.push(
      `最深被问层级 ${max} 超过了「最深缓存层 ${缓存} + 余量 ${层级余量}」` +
        '——四叉树在往没有数据的地方下钻'
    )
  }
  if (typeof max === 'number' && max > 层级硬上限) {
    违规.push(
      `最深被问层级 ${max} 越过了 Cesium 数组上限 ${层级硬上限}` +
        '——`traversalQuadsByLevel[level].southwest` 会抛错，三维区黑屏'
    )
  }
  if (测得.渲染错误数 > 0) {
    违规.push(`scene.renderError 触发了 ${测得.渲染错误数} 次——渲染已经停了`)
  }
  return 违规
}

// ---------------------------------------------------------------------------
// 自证：合成的量测结果（不连浏览器）
// ---------------------------------------------------------------------------
export const 自证样本 = [
  {
    name: '正例·健康（缓存 14 级，问到 14 级）',
    测得: { 最深被问层级: 14, 最深缓存层: 14, 渲染错误数: 0 },
    应报: 0
  },
  {
    name: '正例·用掉一级余量（问到 15 级，合法）',
    测得: { 最深被问层级: 15, 最深缓存层: 14, 渲染错误数: 0 },
    应报: 0
  },
  {
    name: '反例·只问到 0 级（高空远看，数字小但合法，不许报）',
    测得: { 最深被问层级: 0, 最深缓存层: 14, 渲染错误数: 0 },
    应报: 0
  },
  {
    name: '正例·越过数组上限（当初黑屏那类）',
    测得: { 最深被问层级: 31, 最深缓存层: 14, 渲染错误数: 0 },
    应报: 1
  },
  {
    name: '正例·无限下钻（层级已经跑到几百）',
    测得: { 最深被问层级: 999, 最深缓存层: 14, 渲染错误数: 0 },
    应报: 1
  },
  {
    name: '正例·下钻超过缓存层一级余量（缓存被人改深了没同步）',
    测得: { 最深被问层级: 20, 最深缓存层: 14, 渲染错误数: 0 },
    应报: 1
  },
  {
    // 这一条是**只有判据③抓得到**的：缓存层被人改到 40 时②会放过（41 ≤ 40+1），
    // 越过 Cesium 数组上限的只有③。少了它，判据③整个是死的也测不出来。
    name: '正例·缓存层本身被改到 40（②会放过，只有③抓得到）',
    测得: { 最深被问层级: 41, 最深缓存层: 40, 渲染错误数: 0 },
    应报: 1
  },
  {
    name: '正例·renderError 非零（渲染已经停了）',
    测得: { 最深被问层级: 14, 最深缓存层: 14, 渲染错误数: 1 },
    应报: 1
  },
  {
    name: '正例·打桩没生效（-1，会让判据全绿，必须抓）',
    测得: { 最深被问层级: -1, 最深缓存层: 14, 渲染错误数: 0 },
    应报: 1
  },
  {
    name: '正例·读不到最深缓存层（undefined，判据②没了参照）',
    测得: { 最深被问层级: 14, 最深缓存层: undefined, 渲染错误数: 0 },
    应报: 1
  }
]

function 自证() {
  let 坏 = 0
  console.log('=== 自证：合成的量测结果 ===')
  for (const c of 自证样本) {
    const 违规 = 判(c.测得)
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
  console.log(
    坏 ? `\n✗ 自证 ${坏}/${自证样本.length} 项不通过` : `\n✓ 自证 ${自证样本.length} 项全过`
  )
  return 坏
}

// ---------------------------------------------------------------------------
if (process.argv.includes('--self-test')) {
  process.exit(自证() ? 1 : 0)
}

const base = process.argv[2] || 'http://localhost:4173'
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const 页面错 = []
page.on('pageerror', (e) => 页面错.push(String(e.stack || e).replace(/\s+/g, ' ').slice(0, 300)))

// 这个页面有三维底座 + 应急救援叠加层；黑屏那个缺陷当初就是在贴地机位复现的
await page.goto(base + '/#/emergency', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForFunction(() => !!window.__cesiumViewer, null, { timeout: 180000 })
log('viewer 就绪')

// 打桩：记录 Cesium 实际问到的最深层级 + 渲染错误。**必须在俯冲之前装**。
// `probe.max` 初值 -1 是有意的：没被调用过就停在 -1，由判据①抓。
const 装好 = await page.evaluate(() => {
  const v = window.__cesiumViewer
  window.__renderErrs = []
  v.scene.renderError.addEventListener((scene, err) => {
    window.__renderErrs.push(String((err && err.message) || err))
  })

  const p = v.terrainProvider
  window.__levelProbe = { max: -1, seen: {} }
  const orig = p.getLevelMaximumGeometricError.bind(p)
  p.getLevelMaximumGeometricError = function (level) {
    const r = orig(level)
    const probe = window.__levelProbe
    if (typeof level === 'number') {
      probe.seen[level] = r
      if (level > probe.max) probe.max = level
    }
    return r
  }
  return { 有打桩: typeof p.getLevelMaximumGeometricError === 'function' }
})
log('打桩：', JSON.stringify(装好))

// 等画面落定。`globe.tilesLoaded` 刚跳完机位时立即是 true（队列还空），
// 所以 true 之后再等一会儿，别把「队列空」读成「画完了」（README 第 13 节第 20 条）。
await page.waitForFunction(() => window.__cesiumViewer.scene.globe.tilesLoaded, null, {
  timeout: 180000
})
await page.waitForTimeout(10000)

/** 俯冲点从场景里取：`pit-bottom` 的顶点 → 经纬度 + 坑底标高 */
const 俯冲点 = await page.evaluate(() => {
  const v = window.__cesiumViewer
  const C = window.__cesiumNS
  const t = v.clock.currentTime
  const e = v.entities.getById('pit-bottom')
  if (!e || !e.polygon) return { 错: '场景里找不到 pit-bottom 实体，俯冲点无从推导' }
  const hier = e.polygon.hierarchy.getValue(t)
  const 顶点 = hier?.positions?.[0]
  if (!顶点) return { 错: 'pit-bottom 的多边形没有顶点' }
  const c = C.Cartographic.fromCartesian(顶点)
  if (!c) return { 错: 'pit-bottom 的顶点转不成经纬度' }
  return {
    经度: C.Math.toDegrees(c.longitude),
    纬度: C.Math.toDegrees(c.latitude),
    坑底标高: Math.round(c.height)
  }
})
if (俯冲点.错) {
  log('✗', 俯冲点.错)
  await browser.close()
  process.exit(1)
}
log(
  `俯冲点（从场景推的）：${俯冲点.经度.toFixed(5)}, ${俯冲点.纬度.toFixed(5)}` +
    `　坑底标高 ${俯冲点.坑底标高}m　→ 目的地 = 上方 60m`
)

const 量 = () =>
  page.evaluate(() => {
    const v = window.__cesiumViewer
    const c = v && !v.isDestroyed() ? v.camera.positionCartographic : null
    const surface = v && !v.isDestroyed() ? v.scene.globe._surface : null
    const levels = surface?._tilesToRender?.map((t) => t.level) ?? []
    return {
      相机高: c ? Math.round(c.height) : null,
      画面最深层级: levels.length ? Math.max(...levels) : null,
      渲染错误数: (window.__renderErrs || []).length,
      最深被问层级: window.__levelProbe?.max ?? -1,
      // 判据②的参照：provider 自己的「最深缓存层」。
      // ⚠️ 别指望 `terrainProvider.availability.maximumLevel`——Cesium 1.140 的
      // `TileAvailability` **没有**这个公开字段（它只是构造参数，查过 `Cesium.d.ts`；
      // 第一版就是这么写的，实跑时报出「读不到」，见 README 第 13 节第 23 条）。
      // `maxCachedLevel` 是 `localTerrain.ts:134` 的 TS-private getter——TS 的 private
      // 只在编译期，运行时读得到；读不到就退到 manifest 的层级键，两个都读不到返
      // undefined，由判据②当违规报出来（provider 换了形状，这里要跟着改）。
      最深缓存层: (() => {
        const p = v?.terrainProvider
        if (!p) return undefined
        if (typeof p.maxCachedLevel === 'number') return p.maxCachedLevel
        const 层级键 = Object.keys(p.manifest ?? {}).map(Number).filter(Number.isFinite)
        return 层级键.length ? Math.max(...层级键) : undefined
      })()
    }
  })

log('基线：', JSON.stringify(await 量()))

/** 在页面里把相机往地面怼 */
async function 俯冲(times, label) {
  await page.evaluate(async (n) => {
    const v = window.__cesiumViewer
    for (let i = 0; i < n; i++) {
      v.camera.zoomIn(300)
      await new Promise((r) => requestAnimationFrame(r))
    }
  }, times)
  await page.waitForTimeout(5000)
  log(`【${label}】`, JSON.stringify(await 量()))
}

await 俯冲(10, 'zoomIn ×10')
await 俯冲(20, 'zoomIn ×30')

// 直接贴到坑底上方 60m——逼出最深细分，就是当初黑屏那个机位
await page.evaluate(({ 经度, 纬度, 坑底标高 }) => {
  const v = window.__cesiumViewer
  const C = window.__cesiumNS
  v.camera.flyTo({
    destination: C.Cartesian3.fromDegrees(经度, 纬度, 坑底标高 + 60),
    duration: 0
  })
}, 俯冲点)
await page.waitForTimeout(8000)
log('【压到坑底上方60m】', JSON.stringify(await 量()))
await page.waitForTimeout(8000)

const 终 = await 量()
const 探针 = await page.evaluate(() => ({ ...window.__levelProbe }))
log('【再等 8s】', JSON.stringify(终))
log('被问到的最深层级 =', 探针.max)
log(
  '逐级几何误差 =',
  JSON.stringify(
    Object.fromEntries(
      Object.entries(探针.seen).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, r]) => [k, Number(r.toFixed(2))])
    )
  )
)

const 违规 = 判(终)
console.log('')
console.log(`判据：① 打桩被调用过　② 最深被问层级 ≤ 最深缓存层 ${终.最深缓存层} + ${层级余量}　③ ≤ ${层级硬上限}　④ renderError = 0`)
if (终.最深被问层级 > 终.最深缓存层) {
  console.log(
    `最深缓存层是 ${终.最深缓存层}，最深被问到 ${终.最深被问层级}——` +
      '往更深处要过数据，但 `getLevelMaximumGeometricError` 到缓存层就返 0，细分停住了'
  )
}
if (违规.length) {
  console.log('')
  违规.forEach((m) => console.log('✗ ' + m))
  if (页面错.length) {
    console.log('')
    页面错.forEach((m) => console.log('  [页面报错] ' + m))
  }
  console.log(
    '\n✗ 地形细分越界。修法见 `src/scene/localTerrain.ts:189-216`：' +
      '`getLevelMaximumGeometricError` 到最深缓存层级必须**返 0**（返 `levelZeroError` 会让它无限下钻）。'
  )
  await browser.close()
  process.exit(1)
}
console.log('')
console.log('✓ 地形细分停在有数据的那一级：没有越过数组上限，renderError 一次都没触发')
await browser.close()
