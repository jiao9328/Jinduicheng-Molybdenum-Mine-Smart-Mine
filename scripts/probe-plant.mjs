/**
 * 选矿厂专拍：飞到厂址（谷内分级台地）拍三张图，并回收建场景时
 * `buildBenches` 打印的台地标高日志。
 *
 * 用法：node scripts/probe-plant.mjs [url]
 *
 * 厂区搬过两次家。手抄机位的写法**踩过一次**：搬家后镜头还对着旧谷，
 * 那里现在是空的，出来的截图只有面板没有三维，看着像「场景没建出来」，把人带偏。
 * 所以这个脚本的机位改成**从场景里的台地实体推**（怎么推写在下面 shots 之前）——
 * 搬家、改台地尺寸、改谷轴，它都自己跟着走。
 *
 * 机位 `height` 是**注视点海拔**，推的是台地实体自身的标高；
 * 写 0 会让相机的 ENU 参考面落到地下 1.3km，整个构图全错。
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const url = process.argv[2] || 'http://localhost:4173/#/'
const OUT = "_out"
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist'
  ]
})
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })

const logs = []
// **一条都不许过滤。** 上一版这里按 /台地|选矿厂|…/ 过滤，结果整站白屏时
// 探针自己把唯一那行报错吞了，打印出来的是一份「什么也没发生」的报告。
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 500)}`))
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + (e.stack || e.message).slice(0, 800)))
page.on('requestfailed', (r) => logs.push(`REQFAIL: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`))

await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 })

// 轮询等场景就绪（SwiftShader 下 30~45s）。就绪即走，不等满——
// 站挂了的话 50s 定点等待纯属白等，白屏诊断 20s 就该出结果。
const deadline = Date.now() + 60000
let ready = false
while (Date.now() < deadline) {
  ready = await page.evaluate(() => !!window.__cesiumNS)
  if (ready) break
  await page.waitForTimeout(2000)
}

const diag = await page.evaluate(() => ({
  globals: Object.keys(window).filter((k) => k.startsWith('__')),
  text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
  appHtml: document.getElementById('app')?.innerHTML.length ?? -1,
  hash: location.hash
}))
console.log('[诊断]', JSON.stringify(diag, null, 0))
console.log('--- 控制台全文 ---')
logs.forEach((l) => console.log(l))
if (!diag.globals.includes('__cesiumNS')) {
  await page.screenshot({ path: `${OUT}/_debug.png` })
  await browser.close()
  process.exit(1)
}

/** 与 sceneConfig.waypointToFlyTo 同一套 ENU 算法，保证构图可预期 */
async function lookAt(wp) {
  await page.evaluate((w) => {
    const v = window.__cesiumViewer
    const C = window.__cesiumNS
    const target = C.Cartesian3.fromDegrees(w.lon, w.lat, w.height)
    const heading = C.Math.toRadians(w.heading)
    const pitch = C.Math.toRadians(w.pitch)
    const r = w.range
    const offset = new C.Cartesian3(
      -r * Math.cos(pitch) * Math.sin(heading),
      -r * Math.cos(pitch) * Math.cos(heading),
      -r * Math.sin(pitch)
    )
    const enu = C.Transforms.eastNorthUpToFixedFrame(target)
    const dest = C.Matrix4.multiplyByPoint(enu, offset, new C.Cartesian3())
    v.camera.setView({ destination: dest, orientation: { heading, pitch, roll: 0 } })
  }, wp)
  await page.waitForTimeout(6000)
}

/**
 * 等台地标注出现并读出它们的位置。
 *
 * 轮询是必需的：台地是异步建的（要先采地形才能定标高），
 * 而上面只等到 `__cesiumNS`——那个在 `createViewer` 里就有了，比实体早得多。
 * 不轮询就会「台地还没建出来 → 列表是空的 → 拿默认机位拍三张空景」。
 */
async function 取台地() {
  const deadline = Date.now() + 90000
  let 列表 = []
  while (Date.now() < deadline) {
    列表 = await page.evaluate(() => {
      const v = window.__cesiumViewer
      if (!v) return []
      const C = window.__cesiumNS
      const t = v.clock.currentTime
      const 出 = []
      for (const e of v.entities.values) {
        const m = /^bench-(.+)-label$/.exec(e.id)
        if (!m) continue
        const p = e.position?.getValue?.(t)
        if (!p) continue
        const c = C.Cartographic.fromCartesian(p)
        if (!c) continue
        const 块 = v.entities.getById(`bench-${m[1]}`)
        const 顶面 = 块?.polygon?.extrudedHeight?.getValue?.(t)
        出.push({
          key: m[1],
          经度: C.Math.toDegrees(c.longitude),
          纬度: C.Math.toDegrees(c.latitude),
          标注高: Math.round(c.height),
          台地顶: typeof 顶面 === 'number' ? Math.round(顶面) : null
        })
      }
      return 出
    })
    if (列表.length >= 2) break
    await page.waitForTimeout(2000)
  }
  return 列表
}

// ── 机位从场景里的台地实体推，一个经纬度字面量都不写 ──
//
// 2026-09-13 改。原先是三个手抄的机位（109.9683/34.3335 那一组），文件头却写着
// 「跟着 PLANT_ORIGIN / PLANT_AXIS_DEG 走」——**说的和做的不是一回事**：
// 它并不会跟着搬家走，只会安静地对着旧谷拍照（README 第 13 节第 17 条那类缺陷，
// 表现是「截图里只有面板没有三维」，看着像场景没建出来）。
//
// 现在推的是**注视点**，推导源是场景里真实存在的实体：
//   - 台地中心线：`bench-<key>-label` 的 position 落在 `plantPt(0, (y0+y1)/2)`，
//     也就是谷轴中线上（`buildPlant.ts:246`），四级各取一点 → 连线即谷轴；
//   - 注视点海拔：`bench-<key>` 是「底 height → 顶 extrudedHeight」的块体，
//     顶面就是台地标高（`buildPlant.ts:193-205`）。取不到就退到标注高 − 60
//     （标注浮在台地顶面上方 60m）；
//   - 谷轴方位：**由「最低一级 → 最高一级」定方向**。方向不能随便取：
//     `mineLayout` 里 +y 是**上游**、恰好等于 `PLANT_AXIS_DEG`（33.7°），
//     而台地沿 y 逐级降低，所以「最低 → 最高」就是谷轴正向（不是反向）。
//     取反会让相机站到对面坡上，画面左右颠倒。
//
// `heading` 仍按构图写：`轴 + 90` = 垂直于谷轴，相机站在西北坡上，
// 四级台地从左到右依次降低，级差一眼可见；谷口全景取 `轴 + 27`。
// pitch / range 是纯构图参数，与坐标无关，不会过时。
const 台地 = await 取台地()
if (台地.length < 2) {
  console.log(`[失败] 场景里只找到 ${台地.length} 个台地标注实体（bench-*-label），推不出谷轴。`)
  console.log('       机位是从台地实体推的，推不出来就不拍——不退回手抄坐标。')
  await browser.close()
  process.exit(1)
}

const 顶 = (b) => (typeof b.台地顶 === 'number' ? b.台地顶 : b.标注高 - 60)
const 最高 = 台地.reduce((a, b) => (顶(a) >= 顶(b) ? a : b))
const 最低 = 台地.reduce((a, b) => (顶(a) <= 顶(b) ? a : b))
const 中心 = {
  lon: 台地.reduce((n, b) => n + b.经度, 0) / 台地.length,
  lat: 台地.reduce((n, b) => n + b.纬度, 0) / 台地.length,
  h: 台地.reduce((n, b) => n + 顶(b), 0) / 台地.length
}
// 谷轴：最低台地 → 最高台地（+y 是上游，见上）。
// ⚠️ 必须先把「度」换成**米**再求方位角：经度一度只有纬度的 cos(lat) 倍（这里约 0.83），
// 直接拿 Δ经度当米用，方位角会偏 5°（实测 38.7° vs 真值 33.7°）。
// 换算用的常数与 `mineLayout.plantPt` 同一套（`metersPerLon` / `METERS_PER_LAT`）。
const 米每经度 = 111320 * Math.cos((中心.lat * Math.PI) / 180)
const 米每纬度 = 110574
const 轴 =
  (Math.atan2(
    (最高.经度 - 最低.经度) * 米每经度,
    (最高.纬度 - 最低.纬度) * 米每纬度
  ) *
    180) /
  Math.PI
const 轴度 = (轴 + 360) % 360
const 垂直 = (轴度 + 90) % 360

console.log(
  `[机位] 从 ${台地.length} 个台地实体推：谷轴 ${轴度.toFixed(1)}°（+y 上游）　` +
    `垂直谷轴 ${垂直.toFixed(1)}°`
)
// 交叉验证（给人的，不是断言）：推出来的谷轴应当与 `mineLayout.PLANT_AXIS_DEG` 一致，
// 注视点应当落在 `PLANT_ORIGIN` 附近。对不上就是推导公式或台地布局变了——
// 值不在这里再抄一份（抄了就会过时，见 README 第 13 节第 17 条），去源文件看。
console.log('       交叉验证：谷轴 vs mineLayout.PLANT_AXIS_DEG、注视点 vs PLANT_ORIGIN')
console.log(
  `       注视点 厂址中心 ${中心.lon.toFixed(5)},${中心.lat.toFixed(5)} 标高 ${Math.round(中心.h)}m` +
    `　最低一级 ${最低.key} ${顶(最低)}m`
)

const shots = [
  // 全厂俯瞰
  { name: 'plant-overview', lon: 中心.lon, lat: 中心.lat, height: 中心.h, heading: 垂直, pitch: -35, range: 1500 },
  // 台地近景：看清四级平台与级差
  { name: 'plant-bench', lon: 最低.经度, lat: 最低.纬度, height: 顶(最低), heading: 垂直, pitch: -28, range: 800 },
  // 谷口全景：厂区与两侧山体、与采坑的相对位置（斜对谷轴，取 轴+27 的构图）
  { name: 'valley-wide', lon: 中心.lon, lat: 中心.lat, height: 中心.h, heading: (轴度 + 27) % 360, pitch: -38, range: 5000 }
]

for (const s of shots) {
  await lookAt(s)
  await page.screenshot({ path: `${OUT}/${s.name}.png` })
  console.log(`[截图] ${OUT}/${s.name}.png`)
}

console.log('\n--- 建场景日志 ---')
logs.forEach((l) => console.log(l))

await browser.close()
