/**
 * 三维场景诊断：读取相机、实体数量、光照与时钟状态。
 * 用法：node scripts/probe-scene.mjs [url]
 */
import { chromium } from 'playwright'

const url = process.argv[2] || 'http://localhost:4173/#/'

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
})
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })

const logs = []
page.on('console', (m) => logs.push(`${m.type()}: ${m.text().slice(0, 200)}`))

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(5000)

const probe = await page.evaluate(() => {
  const w = window
  const v = w.__cesiumViewer
  if (!v) return { found: false, keys: Object.keys(w).filter((k) => k.startsWith('__')) }

  const c = v.camera
  // Cesium 是 ESM，页面里没有全局 Cesium，这里用普通数学换算经纬高
  const p = c.positionWC
  const a = 6378137.0
  const e2 = 6.69437999014e-3
  const lon = Math.atan2(p.y, p.x)
  const r = Math.hypot(p.x, p.y)
  let lat = Math.atan2(p.z, r * (1 - e2))
  for (let i = 0; i < 5; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2)
    lat = Math.atan2(p.z + e2 * n * Math.sin(lat), r)
  }
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2)
  const carto = {
    longitude: lon,
    latitude: lat,
    height: r / Math.cos(lat) - n
  }

  return {
    found: true,
    entityCount: v.entities.values.length,
    entityIds: v.entities.values.slice(0, 12).map((e) => e.id),
    camera: {
      lon: (carto.longitude * 180 / Math.PI).toFixed(5),
      lat: (carto.latitude * 180 / Math.PI).toFixed(5),
      height: carto.height.toFixed(1),
      heading: (c.heading * 180 / Math.PI).toFixed(1),
      pitch: (c.pitch * 180 / Math.PI).toFixed(1)
    },
    globe: {
      show: v.scene.globe.show,
      baseColor: v.scene.globe.baseColor?.toCssColorString?.() ?? String(v.scene.globe.baseColor)
    },
    light: {
      intensity: v.scene.light?.intensity,
      sunShow: v.scene.sun?.show,
      clock: v.clock.currentTime.toString(),
      clockRunning: v.clock.shouldAnimate
    },
    scene: {
      backgroundColor: v.scene.backgroundColor?.toCssColorString?.(),
      sunPosition: v.scene.sun?.positionWC ? 'ok' : 'none',
      frameState: v.scene.frameState ? 'ok' : 'none'
    },
    atmosphere: v.scene.skyAtmosphere?.show
  }
})

await page.screenshot({ path: '.snapshots/probe.png' })
console.log(JSON.stringify(probe, null, 2))
console.log('--- console ---')
console.log(logs.slice(0, 25).join('\n'))

await browser.close()
