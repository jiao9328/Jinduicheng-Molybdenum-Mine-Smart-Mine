/**
 * 建模 vs 底图 叠加核验。
 *
 * 把 `src/scene/mineLayout.ts` 里的三维物体足迹，按真实经纬度绘制到离线卫星影像上，
 * 输出一张对比图。用于回答一个问题：**模型到底压在影像的哪个位置、偏了多少米**。
 *
 * 与 `_verify.mjs` 的区别：那个是把模型投影回三维场景截图，
 * 受相机姿态与地形起伏影响；这个是纯二维影像叠加，没有透视误差，
 * 偏移量可以按像素直接读出来。
 *
 * 用法：
 *   node scripts/overlay-check.mjs                     # 默认看选矿厂区
 *   node scripts/overlay-check.mjs 109.955 34.328 109.978 34.345
 *   node scripts/overlay-check.mjs --pit               # 看采坑
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = resolve(root, 'public')
const Z = 17 // 最高缓存层级，约 1.17 m/px

/**
 * 页面必须落地成 public/ 下的真实文件再 goto。
 * 用 `setContent` 注入的话文档来源是 about:blank，
 * 即使给了 file:// 的 <base>，Chromium 也不允许它读 file:// 子资源，
 * 瓦片会全部加载失败（表现为整片黑）。
 */
const TMP_HTML = resolve(publicDir, '__overlay-check.html')

/**
 * 预设视野。
 *
 * ⚠️ `plant` 这一档**只用来出图给人看**，不是判据。
 * 厂区的平面位置是按「谷底 + 分级台地」设计的**设计值**，不是影像判读值，
 * 叠在卫星底图上本来就对不齐（理由写在 `mineLayout` 的厂址注释里）。
 * 真正有效的判据只有采坑、排土场、尾矿库这三个**真实地物**。
 * 边界按新厂址算（台地占局部坐标 x 0~220、y -650~625）。
 */
const VIEWS = {
  plant: { lon0: 109.9638, lat0: 34.3285, lon1: 109.9735, lat1: 34.3392, label: '选矿厂区（设计值）' },
  pit: { lon0: 109.9445, lat0: 34.3225, lon1: 109.9645, lat1: 34.3385, label: '露天采坑' },
  dump: { lon0: 109.9305, lat0: 34.3175, lon1: 109.9505, lat1: 34.3345, label: '排土场 / 尾矿库' }
}

// ---------------------------------------------------------------------------
// Web Mercator 换算
// ---------------------------------------------------------------------------
const lonToPx = (lon) => ((lon + 180) / 360) * Math.pow(2, Z) * 256
const latToPx = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, Z) * 256
}
const pxToLon = (px) => (px / (Math.pow(2, Z) * 256)) * 360 - 180
const pxToLat = (py) => {
  const n = Math.PI - (2 * Math.PI * py) / (Math.pow(2, Z) * 256)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

/** 某纬度上 1 度经度对应的米数 */
const metersPerLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180)
const METERS_PER_LAT = 110540

// ---------------------------------------------------------------------------
// 解析 mineLayout.ts —— 单一数据源，避免坐标在脚本里再抄一份而漂移
// ---------------------------------------------------------------------------
const layout = await import('../src/scene/mineLayout.ts')

// ---------------------------------------------------------------------------
// 组装页面
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
/** 去掉 `--xxx` 开关后剩下的是四个数值参数 */
const nums = args.filter((a) => !a.startsWith('--'))
const presetKey = args.includes('--pit') ? 'pit' : args.includes('--dump') ? 'dump' : 'plant'
const view =
  nums.length >= 4
    ? { lon0: +nums[0], lat0: +nums[1], lon1: +nums[2], lat1: +nums[3], label: '自定义' }
    : VIEWS[presetKey]

const x0 = lonToPx(view.lon0)
const x1 = lonToPx(view.lon1)
const y0 = latToPx(view.lat1) // 北在上
const y1 = latToPx(view.lat0)
const W = Math.round(x1 - x0)
const H = Math.round(y1 - y0)

/** 经纬度 → 图内像素 */
const px = (lon, lat) => [lonToPx(lon) - x0, latToPx(lat) - y0]

const tx0 = Math.floor(x0 / 256)
const tx1 = Math.floor((x1 - 1) / 256)
const ty0 = Math.floor(y0 / 256)
const ty1 = Math.floor((y1 - 1) / 256)

const tiles = []
let missing = 0
for (let tx = tx0; tx <= tx1; tx++) {
  for (let ty = ty0; ty <= ty1; ty++) {
    const left = tx * 256 - x0
    const top = ty * 256 - y0
    const rel = `map-tiles/imagery/${Z}/${tx}/${ty}.jpg`
    tiles.push(
      `<img src="${rel}" style="position:absolute;left:${left}px;top:${top}px;width:256px;height:256px" onerror="window.__missing=(window.__missing||0)+1;this.style.display='none'">`
    )
  }
}

/** 画一个矩形足迹（按米给出宽深），中心在 lon/lat */
function rect(lon, lat, widthM, depthM, stroke, name, fill = 'transparent') {
  const [cx, cy] = px(lon, lat)
  const w = widthM / metersPerLon(lat) / 360 * Math.pow(2, Z) * 256
  const h = depthM / METERS_PER_LAT / 360 * Math.pow(2, Z) * 256
  return `
    <rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}"
          fill="${fill}" stroke="${stroke}" stroke-width="2"/>
    <line x1="${cx - 9}" y1="${cy}" x2="${cx + 9}" y2="${cy}" stroke="${stroke}" stroke-width="1.5"/>
    <line x1="${cx}" y1="${cy - 9}" x2="${cx}" y2="${cy + 9}" stroke="${stroke}" stroke-width="1.5"/>
    <text x="${cx + 5}" y="${cy - 6}" fill="${stroke}" font-size="13"
          style="paint-order:stroke;stroke:#000;stroke-width:3px">${name}</text>`
}

/** 画一个椭圆足迹（按米给出半径） */
function ellipse(lon, lat, rxM, ryM, stroke, name) {
  const [cx, cy] = px(lon, lat)
  const rx = (rxM / metersPerLon(lat) / 360) * Math.pow(2, Z) * 256
  const ry = (ryM / METERS_PER_LAT / 360) * Math.pow(2, Z) * 256
  return `
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${stroke}" stroke-width="2"/>
    <line x1="${cx - 9}" y1="${cy}" x2="${cx + 9}" y2="${cy}" stroke="${stroke}" stroke-width="1.5"/>
    <line x1="${cx}" y1="${cy - 9}" x2="${cx}" y2="${cy + 9}" stroke="${stroke}" stroke-width="1.5"/>
    <text x="${cx + 6}" y="${cy - 6}" fill="${stroke}" font-size="13"
          style="paint-order:stroke;stroke:#000;stroke-width:3px">${name}</text>`
}

/** `--plain` 只出影像，不画网格与足迹。用来把原始底图看干净，避免标记干扰判读。 */
const PLAIN = args.includes('--plain')

const marks = []
// 采坑
{
  const { lon, lat, rx, ry } = layout.PIT
  marks.push(ellipse(lon, lat, rx, ry, '#00e5ff', '采坑 PIT'))
}
// 建筑
for (const b of layout.BUILDINGS) {
  marks.push(rect(b.lon, b.lat, b.width, b.depth, '#ff4d4f', b.name))
}
// 筒仓
for (const [i, s] of layout.SILOS.entries()) {
  marks.push(ellipse(s.lon, s.lat, s.radius, s.radius, '#ffd60a', i === 0 ? '筒仓群' : ''))
}
// 排土场
for (const d of layout.DUMPS) {
  marks.push(ellipse(d.lon, d.lat, d.rx, d.ry, '#b388ff', '排土场'))
}
// 尾矿库
marks.push(ellipse(layout.TAILINGS.lon, layout.TAILINGS.lat, layout.TAILINGS.rx, layout.TAILINGS.ry, '#00ff9d', '尾矿库'))

/** 每 100m 一条的米制网格 + 图例，方便直接量偏移 */
const gridLines = []
{
  const latMid = (view.lat0 + view.lat1) / 2
  const stepLon = 100 / metersPerLon(latMid)
  const stepLat = 100 / METERS_PER_LAT
  for (let lon = Math.ceil(view.lon0 / stepLon) * stepLon; lon < view.lon1; lon += stepLon) {
    const [gx] = px(lon, latMid)
    const idx = Math.round(lon / stepLon)
    gridLines.push(
      `<line x1="${gx}" y1="0" x2="${gx}" y2="${H}" stroke="#ffffff" stroke-opacity="${idx % 5 === 0 ? 0.5 : 0.2}" stroke-width="${idx % 5 === 0 ? 1.4 : 0.8}"/>`
    )
  }
  for (let lat = Math.ceil(view.lat0 / stepLat) * stepLat; lat < view.lat1; lat += stepLat) {
    const [, gy] = px(view.lon0, lat)
    const idx = Math.round(lat / stepLat)
    gridLines.push(
      `<line x1="0" y1="${gy}" x2="${W}" y2="${gy}" stroke="#ffffff" stroke-opacity="${idx % 5 === 0 ? 0.5 : 0.2}" stroke-width="${idx % 5 === 0 ? 1.4 : 0.8}"/>`
    )
  }
}

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000}#stage{position:relative;width:${W}px;height:${H}px;overflow:hidden}</style>
</head><body>
<div id="stage">
${tiles.join('\n')}
<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0;pointer-events:none">
${PLAIN ? '' : gridLines.join('\n')}
${PLAIN ? '' : marks.join('\n')}
</svg>
<div style="position:absolute;left:8px;top:8px;color:#fff;font:14px/1.6 monospace;background:rgba(0,0,0,.75);padding:6px 10px">
${view.label} · z${Z} · 白色网格每 100m（粗线 500m）<br>
lon ${view.lon0}~${view.lon1} · lat ${view.lat0}~${view.lat1}<br>
红线=建筑足迹 黄圈=筒仓 青圈=采坑 紫=排土场 绿=尾矿库
</div></div></body></html>`

// 识图接口对图片体积有上限，大图需要缩一缩再送。
// SCALE=0.5 即按半分辨率截图；PLAIN 模式另存 JPEG 进一步压体积。
const SCALE = +(process.env.SCALE ?? 1)
const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: SCALE
})
writeFileSync(TMP_HTML, html, 'utf8')
await page.goto(pathToFileURL(TMP_HTML).href, { waitUntil: 'load' })
await page.waitForTimeout(2500)
const miss = await page.evaluate(() => window.__missing || 0)

mkdirSync(resolve(root, '.snapshots'), { recursive: true })
const out = resolve(root, `.snapshots/overlay-${presetKey}.${PLAIN ? 'jpg' : 'png'}`)
await page.screenshot(PLAIN ? { path: out, type: 'jpeg', quality: 82 } : { path: out })
await browser.close()
rmSync(TMP_HTML, { force: true })

console.log(`输出 ${out}  (${W}×${H}px, z${Z})`)
console.log(`网格：白线每 100m，粗白线每 500m`)
if (miss) console.log(`⚠ 有 ${miss} 张瓦片缺失（该处会显示为黑色）`)
