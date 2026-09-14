/**
 * 在卫星底图上叠加经纬网格，便于人工/视觉判读地物的真实坐标。
 *
 * 关键点：网格线必须用 Cesium 自己的投影来画——屏幕像素与经纬度是透视关系，
 * 用等分像素的方式画网格会得到错误的坐标。
 *
 * 用法：node scripts/probe-grid.mjs [url] [输出文件名]
 */
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { readFileSync, writeFileSync } from 'node:fs'

const url = process.argv[2] || 'http://localhost:4173/#/coord-picker'
const outName = process.argv[3] || 'grid.png'

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=3072']
})
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(20000)

// 在页面里算出「若干条经纬线各自通过哪些屏幕点」，回传后由 Node 侧画上去
const lines = await page.evaluate(() => {
  const v = window.__cesiumViewer
  const C = window.__cesiumNS
  const scene = v.scene
  const canvas = scene.canvas
  const W = canvas.clientWidth
  const H = canvas.clientHeight

  const toScreen = (lon, lat) => {
    const win = C.SceneTransforms.worldToWindowCoordinates(
      scene,
      C.Cartesian3.fromDegrees(lon, lat, 0)
    )
    return win ? [Math.round(win.x), Math.round(win.y)] : null
  }

  // 取画面中心与四角，估出经纬度范围
  const toLonLat = (x, y) => {
    const ray = v.camera.getPickRay(new C.Cartesian2(x, y))
    const pos = ray ? scene.globe.pick(ray, scene) : null
    if (!pos) return null
    const c = C.Cartographic.fromCartesian(pos)
    return [C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude)]
  }

  const corners = [
    toLonLat(0, 0),
    toLonLat(W - 1, 0),
    toLonLat(0, H - 1),
    toLonLat(W - 1, H - 1),
    toLonLat(W / 2, H / 2)
  ].filter(Boolean)

  if (corners.length < 3) return { error: '无法投影，相机可能未对准地表' }

  const lons = corners.map((c) => c[0])
  const lats = corners.map((c) => c[1])
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)

  /** 按固定步长生成刻度值 */
  const ticks = (min, max, step) => {
    const out = []
    const start = Math.ceil(min / step) * step
    for (let v = start; v <= max; v += step) out.push(Number(v.toFixed(6)))
    return out
  }

  // 屏幕 1400px 大约对应 0.02 度，取 0.002 度一格（约 200m）便于判读
  const lonTicks = ticks(minLon, maxLon, 0.002)
  const latTicks = ticks(minLat, maxLat, 0.002)

  const lonLines = lonTicks.map((lon) => ({
    value: lon,
    points: Array.from({ length: 21 }, (_, i) => toScreen(lon, minLat + ((maxLat - minLat) * i) / 20)).filter(Boolean)
  }))

  const latLines = latTicks.map((lat) => ({
    value: lat,
    points: Array.from({ length: 21 }, (_, i) => toScreen(minLon + ((maxLon - minLon) * i) / 20, lat)).filter(Boolean)
  }))

  return { W, H, minLon, maxLon, minLat, maxLat, lonLines, latLines }
})

if (lines.error) {
  console.log('失败:', lines.error)
  await browser.close()
  process.exit(1)
}

console.log(`经纬范围: ${lines.minLon.toFixed(5)}~${lines.maxLon.toFixed(5)} / ${lines.minLat.toFixed(5)}~${lines.maxLat.toFixed(5)}`)
console.log(`经线 ${lines.lonLines.length} 条，纬线 ${lines.latLines.length} 条`)

await page.screenshot({ path: `.snapshots/_${outName}` })

// 用 Node 侧画网格：这里不依赖 canvas 库，直接改像素
const png = PNG.sync.read(readFileSync(`.snapshots/_${outName}`))
const { width: W, height: H, data } = png

const put = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const o = (y * W + x) * 4
  data[o] = r
  data[o + 1] = g
  data[o + 2] = b
  data[o + 3] = 255
}

const drawLine = (points, r, g, b) => {
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    for (let s = 0; s <= steps; s++) {
      put(Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps), r, g, b)
    }
  }
}

// 每 5 条线画一条粗一点的，方便数格子
lines.lonLines.forEach((l, i) => drawLine(l.points, ...(i % 5 === 0 ? [255, 60, 60] : [255, 200, 60])))
lines.latLines.forEach((l, i) => drawLine(l.points, ...(i % 5 === 0 ? [255, 60, 60] : [255, 200, 60])))

writeFileSync(`.snapshots/${outName}`, PNG.sync.write(png))
console.log(`已保存 .snapshots/${outName}`)
console.log('经线刻度:', lines.lonLines.filter((_, i) => i % 5 === 0).map((l) => l.value.toFixed(4)).join(' '))
console.log('纬线刻度:', lines.latLines.filter((_, i) => i % 5 === 0).map((l) => l.value.toFixed(4)).join(' '))

await browser.close()
