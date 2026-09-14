// 台地选址：在任意厂址上量谷轴纵剖面与四级台地足迹内的地形，
// 用来定「厂址选在哪一段、台地半宽取多少、平台标高怎么递减」。
//
// **不启浏览器**（直接读离线 DEM），一次几秒，所以能连着试十几个方案——
// 而「改代码 → 等 45s 建场景 → 看日志」一轮就几分钟。
//
// 用法：
//   node scripts/analyze-bench-site.mjs
//   node scripts/analyze-bench-site.mjs 109.96772,34.33450 33.7 625 -625
//   node scripts/analyze-bench-site.mjs 109.96772,34.33450 33.7 625 -625 \
//        "450:625:50:50,0:300:100:80,-310:-25:120:100,-650:-345:120:80"
//     参数：原点(lon,lat) 谷轴方位角 上游端y 下游端y [四级 y0:y1:cx:半宽，逗号分隔]
//
// 为什么要量：台地标高原先取「足迹内实测最高点 + 1.5」，结果每级各够自己
// 那片坡的最高处，实测 1380.6/1331.9/1338.5/1309.3 —— T3 比 T2 还高，
// 级差 -6.7m，矿石要往上流。改成「单调下降」之后，剩下的问题是**选址**：
// 台地跨在陡坡上时，再怎么调标高也削不平（T1 实测足迹沿谷轴落差 88m）。
// 这个脚本就是把「哪一段谷底是平的、能放台地」量出来。
//
// 后记：本场地的谷底**是弯的**（四级的中泓分别在 x≈+60/+170/+250/+70）。
// 修一条直的中心线要削 20m 的坡，所以这里把中心线与半宽做成参数，
// 在离线把台阶标高算出来，省掉「改代码→等 45s 建场景→看日志」那一轮。
import { readFileSync, existsSync } from 'node:fs'
import { PNG } from 'pngjs'

const Z = 14
const LON_TO_X = (lon) => ((lon + 180) / 360) * Math.pow(2, Z)
const LAT_TO_Y = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, Z)
}
const cache = new Map()
const tile = (tx, ty) => {
  const k = `${tx}/${ty}`
  if (!cache.has(k)) {
    const f = `public/map-tiles/heights/${Z}/${tx}/${ty}.png`
    cache.set(k, existsSync(f) ? PNG.sync.read(readFileSync(f)) : null)
  }
  return cache.get(k)
}
function h(lon, lat) {
  const px = LON_TO_X(lon),
    py = LAT_TO_Y(lat)
  const tx = Math.floor(px),
    ty = Math.floor(py)
  const png = tile(tx, ty)
  if (!png) return null
  const ix = Math.min(255, Math.max(0, Math.round((px - tx) * 256 - 0.5)))
  const iy = Math.min(255, Math.max(0, Math.round((py - ty) * 256 - 0.5)))
  const o = (iy * 256 + ix) * 4
  const v = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768
  return v < 300 || v > 3000 ? null : v
}

// ---- 与 mineLayout 保持一致的厂区局部坐标系 ----
// （坐标换算公式硬编码是有意的：规格不从被测对象读，否则被测对象改错了
//   探针会跟着一起错，那就等于没量。原点与方位角走参数，因为要拿来试选址。）
const ORIGIN = (process.argv[2] || '109.96772,34.33450').split(',').map(Number)
const AXIS_DEG = process.argv[3] !== undefined ? Number(process.argv[3]) : 33.7
const Y_UP = process.argv[4] !== undefined ? Number(process.argv[4]) : 625
const Y_DOWN = process.argv[5] !== undefined ? Number(process.argv[5]) : -625
const CX = process.argv[6] !== undefined ? Number(process.argv[6]) : 120
const HW = process.argv[7] !== undefined ? Number(process.argv[7]) : 100
const SPAN = Y_UP - Y_DOWN
const METERS_PER_LAT = 110540
const metersPerLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180)
function plantPt(x, y) {
  const a = (AXIS_DEG * Math.PI) / 180
  const east = x * Math.cos(a) + y * Math.sin(a)
  const north = -x * Math.sin(a) + y * Math.cos(a)
  return [ORIGIN[0] + east / metersPerLon(ORIGIN[1]), ORIGIN[1] + north / METERS_PER_LAT]
}

// 四级台地。默认沿谷轴均分（各级之间留 15m 缝，与 mineLayout 同构）；
// 也可以整组覆盖：argv[6] = "y0:y1:cx:hw,y0:y1:cx:hw,..."（四组，上游在前）。
// 之所以要能逐级给，是因为实测谷里有一道**从东北伸进来的山嘴**在 y≈320~400
// 卡住谷宽，四级等长均分必然让 T1 跨在它上面（实测足迹极差 55m）。
// 真实厂区也是各级按内容定尺寸、各切各的台，不是等分。
const GAP = 15
const KEYS = ['T1', 'T2', 'T3', 'T4']
const custom = process.argv[6] && process.argv[6].includes(':')
const YS = custom
  ? process.argv[6].split(',').map((s, i) => {
      const [y0, y1, cx, hw] = s.split(':').map(Number)
      return { key: KEYS[i], y0, y1, cx, hw }
    })
  : KEYS.map((key, i) => {
      const y1 = Y_UP - (i * (SPAN + GAP * 3)) / 4
      return { key, y1, y0: y1 - (SPAN - GAP * 3) / 4, cx: CX, hw: HW }
    })

// 台地内取 7×5 网格，与 buildPlant 的采样同构
const ROWS = 7,
  COLS = 5
function grid(bench, cx, hw) {
  const g = []
  for (let i = 0; i <= ROWS; i++) {
    const row = []
    const y = bench.y0 + (i / ROWS) * (bench.y1 - bench.y0)
    for (let j = 0; j <= COLS; j++) {
      const x = cx - hw + (j / COLS) * hw * 2
      row.push(h(...plantPt(x, y)))
    }
    g.push(row)
  }
  return g
}
const flat = (g) => g.flat().filter((v) => v !== null)

console.log(
  `厂址 原点=${ORIGIN.join(',')} 轴=${AXIS_DEG}°  沿谷 y ${Y_UP} → ${Y_DOWN}（${SPAN}m）`
)
console.log(
  YS.map((b) => `  ${b.key} y ${b.y1} → ${b.y0}（${b.y1 - b.y0}m） 中心线 x=${b.cx} 半宽=${b.hw}（x ${b.cx - b.hw} … ${b.cx + b.hw}）`).join('\n')
)

console.log('\n=== 各级台地足迹内的地形（每格为米，列为 x，行为 y）===')
for (const b of YS) {
  const g = grid(b, b.cx, b.hw)
  console.log(
    `\n${b.key}  y ${b.y1.toFixed(0)} → ${b.y0.toFixed(0)}  ` +
      `x ${b.cx - b.hw} → ${b.cx + b.hw}`
  )
  const xs = []
  for (let j = 0; j <= COLS; j++) xs.push(String(b.cx - b.hw + (j / COLS) * b.hw * 2).padStart(5))
  console.log('  y\\x  ' + xs.join(''))
  g.forEach((row, i) => {
    const y = b.y1 - (i / ROWS) * (b.y1 - b.y0)
    console.log(`  ${String(y.toFixed(0)).padStart(4)} ` + row.map((v) => (v === null ? '   --' : v.toFixed(0).padStart(5))).join(''))
  })
  const v = flat(g).sort((p, q) => p - q)
  const q = (f) => v[Math.min(v.length - 1, Math.floor(v.length * f))]
  console.log(
    `  低 ${v[0].toFixed(1)}  0.2分位 ${q(0.2).toFixed(1)}  中位 ${q(0.5).toFixed(1)}  高 ${v[v.length - 1].toFixed(1)}` +
      `  极差 ${(v[v.length - 1] - v[0]).toFixed(1)}m`
  )
}

// ---- 复算 buildPlant 的标高级联，看会不会触诊断告警 ----
console.log('\n=== 标高级联复算（与 buildPlant 同式：top=min(上一级-5, 谷底+2)）===')
const BENCH_STEP = 5,
  BENCH_LIFT = 2,
  FLOOR_QUANTILE = 0.2
let prevTop = null
const rows = []
for (const b of YS) {
  const g = grid(b, b.cx, b.hw)
  const v = flat(g).sort((p, q) => p - q)
  const floor = v[Math.floor(v.length * FLOOR_QUANTILE)]
  const low = v[0]
  const axis = []
  for (let i = 0; i <= ROWS; i++) {
    const mid = g[i][Math.round(COLS / 2)]
    if (mid !== null) axis.push(mid)
  }
  const span = Math.max(...axis) - Math.min(...axis)
  const want = floor + BENCH_LIFT
  const top = prevTop === null ? want : Math.min(prevTop - BENCH_STEP, want)
  prevTop = top
  rows.push({ key: b.key, floor, low, span, top, relief: v[v.length - 1] - v[0] })
}
console.log(
  '  级    平台标高   谷底0.2分位   平台高出谷底   本级纵向落差   足迹极差'
)
rows.forEach((r, i) => {
  const drop = i === 0 ? '  --' : (rows[i - 1].top - r.top).toFixed(1)
  console.log(
    `  ${r.key}  ${r.top.toFixed(1).padStart(9)}  ${r.floor.toFixed(1).padStart(11)}  ` +
      `${(r.top - r.floor).toFixed(1).padStart(11)}  ${r.span.toFixed(1).padStart(11)}  ${r.relief.toFixed(1).padStart(9)}   级差 ${drop}`
  )
})
const total = rows[0].top - rows[3].top
console.log(`  全厂累计高差 ${total.toFixed(1)}m（GB50187 经验值：四～五级 15~25m）`)
for (const r of rows) {
  if (r.span > 15) console.log(`  ⚠ ${r.key} 足迹沿谷轴落差 ${r.span.toFixed(1)}m > 15m：这一级跨在陡坡上`)
  if (r.top < r.low) console.log(`  ⚠ ${r.key} 平台低于本级最低点：整级埋在山里`)
}
