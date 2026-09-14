/**
 * 离线 DEM 分析：把高程读成数，定位采坑、场坪、排土场。
 *
 * 为什么不用影像判读：影像上的屋顶、堆场、水体需要「看懂」，
 * 而高程是**数值**——露天采坑是个几百米深的洼地，在 DEM 上藏不住。
 * 金堆城钼矿公示的边坡最高 410m，采坑范围必然是一块显著的封闭低洼区。
 *
 * 数据源：`public/map-tiles/heights/<z>/<x>/<y>.png`（AWS Terrarium 编码）
 *   高程 = (R * 256 + G + B / 256) - 32768
 *
 * 用法：
 *   node scripts/analyze-dem.mjs                     # 默认矿区范围
 *   node scripts/analyze-dem.mjs 109.90 34.28 110.02 34.38
 */
import { chromium } from 'playwright'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = resolve(root, 'public')
const DEM_Z = 14 // 缓存中最高的 DEM 层级
const TMP_HTML = resolve(publicDir, '__analyze-dem.html')

const args = process.argv.slice(2)
const box =
  args.length >= 4
    ? { lon0: +args[0], lat0: +args[1], lon1: +args[2], lat1: +args[3] }
    : { lon0: 109.9, lat0: 34.29, lon1: 110.0, lat1: 34.37 }

const lonToPx = (lon, z) => ((lon + 180) / 360) * Math.pow(2, z) * 256
const latToPx = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z) * 256
}

const x0 = lonToPx(box.lon0, DEM_Z)
const x1 = lonToPx(box.lon1, DEM_Z)
const y0 = latToPx(box.lat1, DEM_Z)
const y1 = latToPx(box.lat0, DEM_Z)
const W = Math.round(x1 - x0)
const H = Math.round(y1 - y0)

const tx0 = Math.floor(x0 / 256)
const tx1 = Math.floor((x1 - 1) / 256)
const ty0 = Math.floor(y0 / 256)
const ty1 = Math.floor((y1 - 1) / 256)

const tiles = []
for (let tx = tx0; tx <= tx1; tx++) {
  for (let ty = ty0; ty <= ty1; ty++) {
    tiles.push({ x: tx * 256 - x0, y: ty * 256 - y0, src: `map-tiles/heights/${DEM_Z}/${tx}/${ty}.png` })
  }
}

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const TILES = ${JSON.stringify(tiles)};
const W = ${W}, H = ${H};
const c = document.getElementById('c');
const ctx = c.getContext('2d', { willReadFrequently: true });
window.__ready = (async () => {
  let bad = 0;
  await Promise.all(TILES.map(t => new Promise(res => {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, t.x, t.y, 256, 256); res(); };
    img.onerror = () => { bad++; res(); };
    img.src = t.src;
  })));
  window.__bad = bad;
  return true;
})();
window.__heights = () => {
  const d = ctx.getImageData(0, 0, W, H).data;
  const h = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    h[i] = (d[p] * 256 + d[p + 1] + d[p + 2] / 256) - 32768;
  }
  return Array.from(h);
};
</script></body></html>`

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
writeFileSync(TMP_HTML, html, 'utf8')
await page.goto(pathToFileURL(TMP_HTML).href, { waitUntil: 'load' })
await page.evaluate(() => window.__ready)
const bad = await page.evaluate(() => window.__bad)
const h = await page.evaluate(() => window.__heights())
await browser.close()
rmSync(TMP_HTML, { force: true })

if (bad) console.log(`⚠ ${bad}/${tiles.length} 张 DEM 瓦片缺失`)

const pxToLon = (px) => (px / (Math.pow(2, DEM_Z) * 256)) * 360 - 180
const pxToLat = (py) => {
  const n = Math.PI - (2 * Math.PI * py) / (Math.pow(2, DEM_Z) * 256)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}
/** 图内像素 → 经纬度 */
const at = (ix, iy) => [pxToLon(ix + x0), pxToLat(iy + y0)]
const metersPerLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180)
const METERS_PER_LAT = 110540
const mppLat = (156543.03392 * Math.cos((34.33 * Math.PI) / 180)) / Math.pow(2, DEM_Z)

// ---- 全局统计 ----
// Terrarium 瓦片里夹着无效像素（实测到 -5538m，本区地面在 1000m 以上），
// 不滤掉的话最小值会落在坏点上，后面所有分析跟着跑偏。
// 金堆城在秦岭山区，不存在低于 500m 的地面，用它当有效性下限。
const NODATA_FLOOR = 500
let min = Infinity
let max = -Infinity
let minIdx = 0
let nodata = 0
for (let i = 0; i < h.length; i++) {
  if (!(h[i] > NODATA_FLOOR) || h[i] > 9000) { nodata++; continue }
  if (h[i] < min) { min = h[i]; minIdx = i }
  if (h[i] > max) max = h[i]
}
if (nodata) console.log(`⚠ 滤掉 ${nodata} 个无效高程像素（${((nodata / h.length) * 100).toFixed(2)}%）`)
const [minLon, minLat] = at(minIdx % W, (minIdx / W) | 0)
console.log(`\n范围 lon ${box.lon0}~${box.lon1}  lat ${box.lat0}~${box.lat1}`)
console.log(`DEM z${DEM_Z}，约 ${mppLat.toFixed(1)} m/px，${W}×${H}px`)
console.log(`高程范围 ${min.toFixed(0)} ~ ${max.toFixed(0)} m`)
console.log(`最低点 (${minLon.toFixed(5)}, ${minLat.toFixed(5)}) = ${min.toFixed(0)} m  ← 采坑底候选`)

// ---- 采坑：在参考点附近做「局部最低洼地」的连通域 ----
// 不能用全局最低点：本区南侧山沟可低至 600m 级，全局最低会落到矿区外的河谷里。
// 采坑是**被高帮围住的封闭洼地**，只能在矿区范围内找。
const PIT_REF = [109.954, 34.328] // 公示的矿区中心
const SEARCH_R = 1800 // 搜索半径（米）
const THRESH = 90 // 从局部最低点起算的深度

const refIx = Math.round(lonToPx(PIT_REF[0], DEM_Z) - x0)
const refIy = Math.round(latToPx(PIT_REF[1], DEM_Z) - y0)
const rr = Math.round(SEARCH_R / mppLat)
let localMin = Infinity
let localMinIdx = -1
for (let dy = -rr; dy <= rr; dy++) {
  for (let dx = -rr; dx <= rr; dx++) {
    if (dx * dx + dy * dy > rr * rr) continue
    const ix = refIx + dx
    const iy = refIy + dy
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue
    const idx = iy * W + ix
    const v = h[idx]
    if (!(v > NODATA_FLOOR) || v > 9000) continue
    if (v < localMin) { localMin = v; localMinIdx = idx }
  }
}

const seen = new Uint8Array(W * H)
const stack = new Int32Array(W * H)
let sp = 0
stack[sp++] = localMinIdx
seen[localMinIdx] = 1
let n = 0, sx = 0, sy = 0, minX = W, maxX = -1, minY = H, maxY = -1
while (sp > 0) {
  const idx = stack[--sp]
  const x = idx % W, y = (idx / W) | 0
  n++; sx += x; sy += y
  if (x < minX) minX = x; if (x > maxX) maxX = x
  if (y < minY) minY = y; if (y > maxY) maxY = y
  const nb = [x > 0 ? idx - 1 : -1, x < W - 1 ? idx + 1 : -1, y > 0 ? idx - W : -1, y < H - 1 ? idx + W : -1]
  for (const j of nb) {
    if (j >= 0 && !seen[j] && h[j] <= localMin + THRESH && h[j] > NODATA_FLOOR) { seen[j] = 1; stack[sp++] = j }
  }
}
const cLon = pxToLon(sx / n + x0)
const cLat = pxToLat(sy / n + y0)
const pitW = (maxX - minX + 1) * mppLat
const pitH = (maxY - minY + 1) * mppLat
const [bLonMin, bLatMin] = at(minX, maxY)
const [bLonMax, bLatMax] = at(maxX, minY)
console.log(`\n采坑（以 (${PIT_REF[0]}, ${PIT_REF[1]}) 为参考、半径 ${SEARCH_R}m 内的局部洼地）：`)
console.log(`  坑底最低 ${localMin.toFixed(0)} m @ (${pxToLon((localMinIdx % W) + x0).toFixed(5)}, ${pxToLat(((localMinIdx / W) | 0) + y0).toFixed(5)})`)
console.log(`  ≤ ${(localMin + THRESH).toFixed(0)}m 连通域：质心 (${cLon.toFixed(5)}, ${cLat.toFixed(5)})`)
console.log(`  范围 ${n} px ≈ ${((n * mppLat * mppLat) / 1e4).toFixed(1)} 公顷，外接盒 ${Math.round(pitW)}×${Math.round(pitH)} m → rx=${Math.round(pitW / 2)} ry=${Math.round(pitH / 2)}`)
console.log(`  外接盒经纬度 lon ${bLonMin.toFixed(5)}~${bLonMax.toFixed(5)}  lat ${bLatMin.toFixed(5)}~${bLatMax.toFixed(5)}`)

// 坑口（帮顶）比坑底大得多，按不同标高各量一次，用来定 rx/ry
console.log(`\n采坑在各标高上的范围（以坑底最低点为中心）：`)
console.log('  标高(m)   外接盒(米)      rx   ry    面积(公顷)')
console.log('  ' + '-'.repeat(50))
for (const lvl of [50, 90, 150, 220, 300]) {
  const thr = localMin + lvl
  const s2 = new Uint8Array(W * H)
  const st2 = new Int32Array(W * H)
  let sp3 = 0
  st2[sp3++] = localMinIdx
  s2[localMinIdx] = 1
  let c2 = 0, mnX2 = W, mxX2 = -1, mnY2 = H, mxY2 = -1
  while (sp3 > 0) {
    const idx = st2[--sp3]
    const x = idx % W, y = (idx / W) | 0
    c2++
    if (x < mnX2) mnX2 = x; if (x > mxX2) mxX2 = x
    if (y < mnY2) mnY2 = y; if (y > mxY2) mxY2 = y
    const nb = [x > 0 ? idx - 1 : -1, x < W - 1 ? idx + 1 : -1, y > 0 ? idx - W : -1, y < H - 1 ? idx + W : -1]
    for (const j of nb) {
      if (j >= 0 && !s2[j] && h[j] <= thr && h[j] > NODATA_FLOOR) { s2[j] = 1; st2[sp3++] = j }
    }
  }
  const w2 = (mxX2 - mnX2 + 1) * mppLat
  const h2 = (mxY2 - mnY2 + 1) * mppLat
  console.log(
    `  ${String(Math.round(thr)).padStart(6)}   ${String(Math.round(w2)).padStart(5)}×${String(Math.round(h2)).padStart(5)}   ` +
      `${String(Math.round(w2 / 2)).padStart(4)} ${String(Math.round(h2 / 2)).padStart(4)}   ${((c2 * mppLat * mppLat) / 1e4).toFixed(1).padStart(8)}`
  )
}
console.log('  （标高再抬高，连通域会翻过帮顶扩散到整片流域，不再是坑体，故只量到这里）')

// ---- ASCII 高程图：直接读，不依赖识图 ----
const COLS = 100
const ROWS = Math.max(20, Math.round((COLS * H) / W / 2))
const RAMP = ' .:-=+*#%@'
console.log(`\n高程图（北在上，${COLS}×${ROWS}，每格约 ${Math.round(((box.lon1 - box.lon0) / COLS) * metersPerLon(34.33))}m）。`)
console.log(`暗=低（采坑）  亮=高。P=采坑质心  * =配置的采坑中心  o=配置的厂房中心`)
console.log()
const pitMarkX = Math.round(((lonToPx(cLon, DEM_Z) - x0) / W) * COLS)
const pitMarkY = Math.round(((latToPx(cLat, DEM_Z) - y0) / H) * ROWS)
// ⚠️ 采坑与厂区坐标从 `mineLayout` 取，**不在这里手抄**。
// 厂区搬家过一次（见 mineLayout 的厂址一节），手抄的 (109.9668, 34.3362) 是**旧谷**的位置：
// 图上那个 `o` 会落进一条已经没厂区的沟，而本脚本不会报任何错。
const { PIT, plantPt } = await import('../src/scene/mineLayout.ts')
const cfgPitLon = PIT.lon, cfgPitLat = PIT.lat
const cfgPitX = Math.round(((lonToPx(cfgPitLon, DEM_Z) - x0) / W) * COLS)
const cfgPitY = Math.round(((latToPx(cfgPitLat, DEM_Z) - y0) / H) * ROWS)
/** 厂区中部：局部坐标 (120, -150)，落在 T3 磨浮台地上 */
const [plantLon, plantLat] = plantPt(120, -150)
const plantX = Math.round(((lonToPx(plantLon, DEM_Z) - x0) / W) * COLS)
const plantY = Math.round(((latToPx(plantLat, DEM_Z) - y0) / H) * ROWS)
for (let r = 0; r < ROWS; r++) {
  let line = ''
  for (let cIdx = 0; cIdx < COLS; cIdx++) {
    const ix = Math.min(W - 1, Math.floor(((cIdx + 0.5) / COLS) * W))
    const iy = Math.min(H - 1, Math.floor(((r + 0.5) / ROWS) * H))
    const v = h[iy * W + ix]
    const t = v > NODATA_FLOOR ? (v - min) / Math.max(1, max - min) : 0
    let ch = RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))]
    if (cIdx === pitMarkX && r === pitMarkY) ch = 'P'
    else if (cIdx === cfgPitX && r === cfgPitY) ch = '*'
    else if (cIdx === plantX && r === plantY) ch = 'o'
    line += ch
  }
  console.log(line)
}
console.log(`\nP = DEM 实测采坑质心 (${cLon.toFixed(5)}, ${cLat.toFixed(5)})`)
console.log(`* = 配置的采坑中心 (${cfgPitLon}, ${cfgPitLat})`)
console.log(`o = 厂区中部（T3 磨浮台地）(${plantLon.toFixed(5)}, ${plantLat.toFixed(5)})\n`)

// ---------------------------------------------------------------------------
// 按配置坐标查高程
// ---------------------------------------------------------------------------
/** 取某经纬度处的高程（最近邻） */
const elevAt = (lon, lat) => {
  const ix = Math.round(lonToPx(lon, DEM_Z) - x0)
  const iy = Math.round(latToPx(lat, DEM_Z) - y0)
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return null
  return h[iy * W + ix]
}
/** 某点周围 radiusM 米内的高程极值，用于判断「是不是洼地/平地」 */
const relief = (lon, lat, radiusM = 250) => {
  const r = Math.round(radiusM / mppLat)
  const ix0 = Math.round(lonToPx(lon, DEM_Z) - x0)
  const iy0 = Math.round(latToPx(lat, DEM_Z) - y0)
  let lo = Infinity
  let hi = -Infinity
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const ix = ix0 + dx
      const iy = iy0 + dy
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue
      const v = h[iy * W + ix]
      if (!(v > NODATA_FLOOR) || v > 9000) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  return { lo, hi, drop: hi - lo }
}

const layout = await import('../src/scene/mineLayout.ts')
const rows = [
  ['MINE_CENTER(sceneConfig)', 109.9561, 34.3281],
  ['PIT 配置中心', layout.PIT.lon, layout.PIT.lat],
  ...layout.BUILDINGS.map((b) => [`建筑 ${b.name}`, b.lon, b.lat]),
  ['TAILINGS 尾矿库', layout.TAILINGS.lon, layout.TAILINGS.lat],
  ...layout.DUMPS.map((d, i) => [`DUMPS 排土场${i + 1}`, d.lon, d.lat])
]
console.log('配置坐标处的 DEM 高程（周边 250m 起伏可判断是否落在洼地/陡坡上）：\n')
console.log('  对象                       高程(m)   周边250m最低  最高   起伏(m)')
console.log('  ' + '-'.repeat(70))
for (const [name, lon, lat] of rows) {
  const e = elevAt(lon, lat)
  const r = relief(lon, lat)
  console.log(
    `  ${name.padEnd(24)} ${e === null ? '  越界' : String(Math.round(e)).padStart(7)}   ` +
      `${String(Math.round(r.lo)).padStart(9)}  ${String(Math.round(r.hi)).padStart(6)}  ${String(Math.round(r.drop)).padStart(7)}`
  )
}
console.log()

// ---------------------------------------------------------------------------
// 局部放大高程图：把矿区核心区按更高分辨率打出来看
// ---------------------------------------------------------------------------
const ZOOM_CENTER = [109.9561, 34.3281]
const ZOOM_R = 2000 // 半径（米）
const ZC = 110
const ZR = 55
const zx0 = lonToPx(ZOOM_CENTER[0], DEM_Z) - x0 - ZOOM_R / mppLat
const zx1 = lonToPx(ZOOM_CENTER[0], DEM_Z) - x0 + ZOOM_R / mppLat
const zy0 = latToPx(ZOOM_CENTER[1], DEM_Z) - y0 - ZOOM_R / mppLat
const zy1 = latToPx(ZOOM_CENTER[1], DEM_Z) - y0 + ZOOM_R / mppLat
let zmin = Infinity
let zmax = -Infinity
for (let iy = Math.max(0, Math.floor(zy0)); iy < Math.min(H, Math.ceil(zy1)); iy++) {
  for (let ix = Math.max(0, Math.floor(zx0)); ix < Math.min(W, Math.ceil(zx1)); ix++) {
    const v = h[iy * W + ix]
    if (!(v > NODATA_FLOOR) || v > 9000) continue
    if (v < zmin) zmin = v
    if (v > zmax) zmax = v
  }
}
console.log(`\n矿区核心区放大（中心 ${ZOOM_CENTER[0]}, ${ZOOM_CENTER[1]}，半径 ${ZOOM_R}m，每格约 ${Math.round((2 * ZOOM_R) / ZC)}m）`)
console.log(`本区高程 ${zmin.toFixed(0)} ~ ${zmax.toFixed(0)} m\n`)
for (let r = 0; r < ZR; r++) {
  let line = ''
  for (let cIdx = 0; cIdx < ZC; cIdx++) {
    const ix = Math.min(W - 1, Math.max(0, Math.floor(zx0 + ((cIdx + 0.5) / ZC) * (zx1 - zx0))))
    const iy = Math.min(H - 1, Math.max(0, Math.floor(zy0 + ((r + 0.5) / ZR) * (zy1 - zy0))))
    const v = h[iy * W + ix]
    const t = v > NODATA_FLOOR ? (v - zmin) / Math.max(1, zmax - zmin) : 0
    line += RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))]
  }
  console.log(line)
}
console.log(`\n（核心区约 ${(2 * ZOOM_R) / 1000}km 见方，暗处为低洼）\n`)

// ---------------------------------------------------------------------------
// 平地检测：选矿厂、排土场顶面、尾矿库坝顶都建在**平整过的场地**上
// ---------------------------------------------------------------------------
// 做法：对每个像素算「半径 R 窗口内的高差」。天然山坡高差大，
// 削平填筑出来的场地高差小。这是不需要识图就能定位工业场地的判据。
const FLAT_R = 150 // 窗口半径（米）
const FLAT_DROP = 12 // 高差阈值（米）
const fr = Math.round(FLAT_R / mppLat)

/**
 * 可分离的滑动窗口极值：先按行、再按列各做一次一维滑窗，
 * 复杂度 O(W·H·r)，对本图（1165×1129, r=19）约几秒，够用。
 */
function slidingExtreme(src, w, h, r, isMax) {
  const tmp = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const base = y * w
    for (let x = 0; x < w; x++) {
      let best = src[base + x]
      const lo = Math.max(0, x - r)
      const hi = Math.min(w - 1, x + r)
      for (let k = lo; k <= hi; k++) {
        const v = src[base + k]
        if (isMax ? v > best : v < best) best = v
      }
      tmp[base + x] = best
    }
  }
  const out = new Float32Array(w * h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let best = tmp[y * w + x]
      const lo = Math.max(0, y - r)
      const hi = Math.min(h - 1, y + r)
      for (let k = lo; k <= hi; k++) {
        const v = tmp[k * w + x]
        if (isMax ? v > best : v < best) best = v
      }
      out[y * w + x] = best
    }
  }
  return out
}

// 先用一个哨兵替换无效值，避免坏像素污染窗口
const clean = new Float32Array(h.length)
for (let i = 0; i < h.length; i++) clean[i] = h[i] > NODATA_FLOOR && h[i] < 9000 ? h[i] : 1300
const wmax = slidingExtreme(clean, W, H, fr, true)
const wmin = slidingExtreme(clean, W, H, fr, false)

const flat = new Uint8Array(W * H)
for (let i = 0; i < W * H; i++) if (wmax[i] - wmin[i] <= FLAT_DROP) flat[i] = 1

// 连通域
const fSeen = new Uint8Array(W * H)
const fStack = new Int32Array(W * H)
const flats = []
for (let start = 0; start < W * H; start++) {
  if (!flat[start] || fSeen[start]) continue
  let sp2 = 0
  fStack[sp2++] = start
  fSeen[start] = 1
  let cnt = 0, sx2 = 0, sy2 = 0, mnX = W, mxX = -1, mnY = H, mxY = -1, sumH = 0
  while (sp2 > 0) {
    const idx = fStack[--sp2]
    const x = idx % W, y = (idx / W) | 0
    cnt++; sx2 += x; sy2 += y; sumH += clean[idx]
    if (x < mnX) mnX = x; if (x > mxX) mxX = x
    if (y < mnY) mnY = y; if (y > mxY) mxY = y
    const nb = [x > 0 ? idx - 1 : -1, x < W - 1 ? idx + 1 : -1, y > 0 ? idx - W : -1, y < H - 1 ? idx + W : -1]
    for (const j of nb) if (j >= 0 && flat[j] && !fSeen[j]) { fSeen[j] = 1; fStack[sp2++] = j }
  }
  flats.push({
    cnt, lon: pxToLon(sx2 / cnt + x0), lat: pxToLat(sy2 / cnt + y0),
    w: (mxX - mnX + 1) * mppLat, h: (mxY - mnY + 1) * mppLat,
    elev: sumH / cnt,
    fill: cnt / ((mxX - mnX + 1) * (mxY - mnY + 1))
  })
}
flats.sort((a, b) => b.cnt - a.cnt)

const mPerLon = metersPerLon(34.33)
console.log(`\n平整场地（窗口 ${FLAT_R}m 内高差 ≤ ${FLAT_DROP}m），取前 15 处：\n`)
console.log('  #   质心经度      质心纬度     均高(m)  外接盒(米)   面积(公顷) 填充率  距矿区中心(米)')
console.log('  ' + '-'.repeat(88))
flats.slice(0, 15).forEach((p, i) => {
  const d = Math.hypot((p.lon - 109.9561) * mPerLon, (p.lat - 34.3281) * METERS_PER_LAT)
  console.log(
    `  ${String(i + 1).padStart(2)}  ${p.lon.toFixed(5)}   ${p.lat.toFixed(5)}   ${String(Math.round(p.elev)).padStart(6)}   ` +
      `${String(Math.round(p.w)).padStart(4)}×${String(Math.round(p.h)).padStart(4)}   ${((p.cnt * mppLat * mppLat) / 1e4).toFixed(1).padStart(8)}   ` +
      `${p.fill.toFixed(2)}   ${Math.round(d)}`
  )
})
console.log()
