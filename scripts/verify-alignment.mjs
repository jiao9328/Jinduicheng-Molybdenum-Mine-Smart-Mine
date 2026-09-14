/**
 * 坐标对齐核验：把厂区地物的**地面位置**投影回屏幕，叠上米制网格，出图供人判读。
 *
 * 判据是人眼比对——青十字是「坐标说它在哪」，看得见的三维体是「实际画在哪」。
 * 十字一律按 **height 0** 投影，而厂房坐在 ~1370m 的台地上，所以两者**本该不重合**：
 * 落差正是判读对象。这个脚本没有断言，也不该有——`overlay-check.mjs` 才是能自动判死的那个。
 *
 * ⚠️ 本脚本原先把相机、网格原点、标记点**全部写死在 (109.9485, 35.1990)**，
 * 那是另一座矿的坐标（北纬 35.2，与金堆城的 34.33 差了一个纬度带）。
 * 在本地图上六个十字一个都投不到屏幕上，网格也整片落在视野外，
 * 出图是一张干净的底图——「什么都没标出来」看起来和「对齐得很好」一模一样。
 * 现在改为从 `mineLayout` 取，**不再手抄坐标**。
 *
 * ⚠️ 厂区坐标是**设计值不是实测值**（见 `mineLayout` 的厂址一节），
 * 所以青十字与影像上的真实地物本来就不该对齐，这里只验「模型画在它自己声称的位置上」。
 */
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { readFileSync, writeFileSync } from 'node:fs'
// 只取「在哪」；米制换算写在 page.evaluate 里（Node 作用域进不去浏览器）
import { BUILDINGS, SILOS, plantPt } from '../src/scene/mineLayout.ts'

const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--js-flags=--max-old-space-size=3072']})
const p = await b.newPage({viewport:{width:1400,height:900}})
await p.goto('http://localhost:4173/#/coord-picker', {waitUntil:'domcontentloaded', timeout:90000})
await p.waitForTimeout(20000)

/** 网格原点：厂区中部（局部坐标 (120, -150)，落在 T3 磨浮台地上） */
const C0 = plantPt(120, -150)
/** 相机高度：台地标高 1370 + 1600m 离地高，与原脚本的离地高一致 */
const CAM_HEIGHT = 1370 + 1600

// 相机对准厂房群，拉近看细节
const cam = await p.evaluate(({ c0, camHeight, marks }) => {
  const v = window.__cesiumViewer, C = window.__cesiumNS, scene = v.scene
  if (v.entities) v.entities.show = false
  const hud = document.querySelector('.picker__hud'); if (hud) hud.style.display = 'none'
  v.camera.setView({ destination: C.Cartesian3.fromDegrees(c0[0], c0[1], camHeight),
    orientation: { heading: 0, pitch: C.Math.toRadians(-82), roll: 0 } })
  const toScreen = (lon, lat) => {
    const w = C.SceneTransforms.worldToWindowCoordinates(scene, C.Cartesian3.fromDegrees(lon, lat, 0))
    return w ? [Math.round(w.x), Math.round(w.y)] : null
  }
  // 以厂区中部为原点，每隔 200m 画一条经纬线
  const mLon = 1 / (111320 * Math.cos(c0[1] * Math.PI / 180))
  const mLat = 1 / 110540
  const lines = { lon: [], lat: [] }
  for (let i = -8; i <= 8; i++) {
    const dLon = i * 200 * mLon
    lines.lon.push({ meters: i * 200, points: Array.from({length: 21}, (_, k) => {
      const lat = c0[1] + ((k / 20) - 0.5) * 1600 * mLat
      return toScreen(c0[0] + dLon, lat)
    }).filter(Boolean) })
    const dLat = i * 200 * mLat
    lines.lat.push({ meters: i * 200, points: Array.from({length: 21}, (_, k) => {
      const lon = c0[0] + ((k / 20) - 0.5) * 1600 * mLon
      return toScreen(lon, c0[1] + dLat)
    }).filter(Boolean) })
  }
  const out = {}
  for (const [k, [lon, lat]] of Object.entries(marks)) out[k] = toScreen(lon, lat)
  return { lines, marks: out, viewport: [scene.canvas.clientWidth, scene.canvas.clientHeight] }
}, {
  c0: C0,
  camHeight: CAM_HEIGHT,
  marks: Object.fromEntries([
    ...BUILDINGS.map((x) => [x.name, [x.lon, x.lat]]),
    ['筒仓群', [SILOS[0].lon, SILOS[0].lat]]
  ])
})
console.log('视口:', cam.viewport)
console.log('标记点屏幕坐标:', JSON.stringify(cam.marks))

await p.waitForTimeout(13000)
await p.screenshot({path:'.snapshots/_geo3.png'})

const png = PNG.sync.read(readFileSync('.snapshots/_geo3.png'))
const { width: W, height: H, data } = png
const put=(x,y,r,g,bb)=>{ if(x<0||y<0||x>=W||y>=H)return; const o=(y*W+x)*4; data[o]=r;data[o+1]=g;data[o+2]=bb;data[o+3]=255 }
const line=(pts,r,g,bb,w=1)=>{ for(let i=1;i<pts.length;i++){ const [x0,y0]=pts[i-1],[x1,y1]=pts[i]
  const n=Math.max(Math.abs(x1-x0),Math.abs(y1-y0)); for(let s=0;s<=n;s++){ const x=Math.round(x0+(x1-x0)*s/n), y=Math.round(y0+(y1-y0)*s/n)
    for(let d=-w;d<=w;d++){ put(x+d,y,r,g,bb); put(x,y+d,r,g,bb) } } } }

// 主网格（每 1000m）红线，次网格（每 200m）黄线
cam.lines.lon.forEach(l => line(l.points, ...(l.meters % 1000 === 0 ? [255,60,60] : [255,210,80]), l.meters % 1000 === 0 ? 2 : 1))
cam.lines.lat.forEach(l => line(l.points, ...(l.meters % 1000 === 0 ? [255,60,60] : [255,210,80]), l.meters % 1000 === 0 ? 2 : 1))

// 标记十字：青色
for (const [k, pt] of Object.entries(cam.marks)) {
  if (!pt) continue
  const [x, y] = pt
  for (let d = -14; d <= 14; d++) { put(x + d, y, 0, 255, 255); put(x, y + d, 0, 255, 255) }
}

writeFileSync('.snapshots/geo-grid.png', PNG.sync.write(png))
console.log('已保存 .snapshots/geo-grid.png（红线=1000m，黄线=200m，青色十字=模型位置）')
await b.close(); process.exit(0)
