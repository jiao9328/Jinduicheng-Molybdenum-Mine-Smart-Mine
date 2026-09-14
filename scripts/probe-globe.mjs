/**
 * 底图诊断：单独看地球影像，排除程序化实体的干扰。
 * 用法：node scripts/probe-globe.mjs [url]
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'
import { writeFileSync } from 'node:fs'

const url = process.argv[2] || 'http://localhost:8787/#/'

const session = await login(new URL(url).origin)

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
})
const page = await newLoggedInPage(browser, session, { viewport: { width: 1280, height: 720 } })

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(8000)

const info = await page.evaluate(async () => {
  const v = window.__cesiumViewer
  const C = window.__cesiumNS
  const scene = v.scene
  const globe = scene.globe

  // 隐藏所有实体，只留地球
  v.entities.show = false

  const layer = v.imageryLayers.get(0)
  const provider = layer?.imageryProvider

  const rect = provider?.rectangle
  const fmt = (r) =>
    r
      ? [
          C.Math.toDegrees(r.west).toFixed(4),
          C.Math.toDegrees(r.south).toFixed(4),
          C.Math.toDegrees(r.east).toFixed(4),
          C.Math.toDegrees(r.north).toFixed(4)
        ].join(', ')
      : 'undefined'

  // 相机是否落在图层覆盖范围内
  const cam = v.camera.positionCartographic
  const camLon = C.Math.toDegrees(cam.longitude)
  const camLat = C.Math.toDegrees(cam.latitude)
  const inRect =
    rect &&
    camLon >= C.Math.toDegrees(rect.west) &&
    camLon <= C.Math.toDegrees(rect.east) &&
    camLat >= C.Math.toDegrees(rect.south) &&
    camLat <= C.Math.toDegrees(rect.north)

  return {
    globeShow: globe.show,
    globeBaseColor: globe.baseColor?.toCssColorString?.(),
    globeImageryLayers: globe.imageryLayers?.length,
    layerCount: v.imageryLayers.length,
    layerShow: layer?.show,
    layerAlpha: layer?.alpha,
    layerReady: layer?.ready,
    providerReady: provider?.ready,
    providerClass: provider?.constructor?.name,
    providerRect: fmt(rect),
    providerLevels: `${provider?.minimumLevel}~${provider?.maximumLevel}`,
    providerTiling: provider?.tilingScheme?.constructor?.name,
    camera: `${camLon.toFixed(4)}, ${camLat.toFixed(4)}, h=${Math.round(cam.height)}`,
    cameraInRect: inRect
  }
})

console.log(JSON.stringify(info, null, 2))

await page.waitForTimeout(20000)

const shot = await page.evaluate(() => {
  const s = window.__cesiumViewer.scene
  return new Promise((res) => {
    const once = () => {
      s.postRender.removeEventListener(once)
      res(s.canvas.toDataURL('image/png'))
    }
    s.postRender.addEventListener(once)
  })
})
writeFileSync('.snapshots/globe-only.png', Buffer.from(shot.split(',')[1], 'base64'))
console.log('已保存 .snapshots/globe-only.png')

await browser.close()
