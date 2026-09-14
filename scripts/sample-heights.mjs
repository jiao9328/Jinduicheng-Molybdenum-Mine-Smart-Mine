/**
 * 临时工具：从离线 DEM 采样指定经纬度的高程，用于确定机位高度。
 *
 * 经度/纬度以 "名称=lon,lat" 形式作为参数传入。
 */
import { readFileSync, existsSync } from 'node:fs'
import { PNG } from 'pngjs'

const Z = 14
const LON_TO_X = (lon) => ((lon + 180) / 360) * Math.pow(2, Z)
const LAT_TO_Y = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, Z)
}
const X_TO_LON = (x) => (x / Math.pow(2, Z)) * 360 - 180
const Y_TO_LAT = (y) => {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, Z)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

/** 按需读取并缓存瓦片 */
const cache = new Map()
function tile(tx, ty) {
  const key = `${tx}/${ty}`
  if (cache.has(key)) return cache.get(key)
  const f = `public/map-tiles/heights/${Z}/${tx}/${ty}.png`
  const png = existsSync(f) ? PNG.sync.read(readFileSync(f)) : null
  cache.set(key, png)
  return png
}

function heightAt(lon, lat) {
  const fx = LON_TO_X(lon)
  const fy = LAT_TO_Y(lat)
  const tx = Math.floor(fx)
  const ty = Math.floor(fy)
  const png = tile(tx, ty)
  if (!png) return null
  const px = Math.min(png.width - 1, Math.floor((fx - tx) * png.width))
  const py = Math.min(png.height - 1, Math.floor((fy - ty) * png.height))
  const p = (png.width * py + px) << 2
  return png.data[p] * 256 + png.data[p + 1] + png.data[p + 2] / 256 - 32768
}

// 默认采样点：矿区各关键地物。
//
// ⚠️ 厂区那几个点**从 `mineLayout` 的局部坐标算出来，不手抄经纬度**。
// 厂址搬过一次（旧谷 → 使用者拾取的新谷），手抄的坐标全留在旧谷里，
// `sceneConfig` 的机位 height 会跟着一起错，而那里恰恰写着
// 「height 均取自 _sample-heights.mjs」——一个抄错的数会被当成实测值。
// 采坑 / 排土场 / 尾矿库是**真实地物**，不随厂址走，保持原值。
const { plantPt } = await import('../src/scene/mineLayout.ts')

/** 局部坐标 (x, y) → [lon, lat]，与厂区几何同一个换算 */
const at = (x, y) => plantPt(x, y)

const DEFAULT_POINTS = {
  采坑中心: [109.954, 34.328],
  采坑北沿: [109.9546, 34.3332],
  采坑东沿: [109.9592, 34.3312],
  粗碎站_T1: at(55, 530),
  原矿仓_T1: at(82, 548),
  中细碎车间_T2: at(80, 240),
  筛分车间_T2: at(80, 150),
  磨浮主厂房_T3: at(100, -175),
  精矿脱水车间_T4: at(110, -420),
  精矿库_T4: at(115, -545),
  尾矿库: [109.9512, 34.3224],
  排土场1: [109.9436, 34.3316],
  排土场2: [109.9416, 34.3268],
  全局中心: at(100, 0)
}

const points = DEFAULT_POINTS

console.log('采样点高程（DEM z14）：')
const out = {}
for (const [name, [lon, lat]] of Object.entries(points)) {
  const h = heightAt(lon, lat)
  out[name] = h
  console.log(`  ${name.padEnd(12)} ${lon.toFixed(4)}, ${lat.toFixed(4)}  →  ${h === null ? '无数据' : h.toFixed(0) + ' m'}`)
}
