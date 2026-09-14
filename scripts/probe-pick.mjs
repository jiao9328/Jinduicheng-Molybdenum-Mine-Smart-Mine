/**
 * 拾取诊断：用 Cesium 的 pick / scene.screenshot，判断三维区到底渲染了什么。
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'
import { writeFileSync } from 'node:fs'

const url = process.argv[2] || 'http://localhost:8787/#/'

const session = await login(new URL(url).origin)

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
})
const page = await newLoggedInPage(browser, session, { viewport: { width: 1920, height: 1080 } })
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(6000)

const result = await page.evaluate(async () => {
  const v = window.__cesiumViewer
  if (!v) return { error: 'viewer not exposed' }
  const scene = v.scene
  const w = scene.canvas.clientWidth
  const h = scene.canvas.clientHeight

  // 1) 采样若干屏幕点的拾取结果
  const picks = []
  for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.35], [0.42, 0.6], [0.58, 0.62], [0.5, 0.72]]) {
    const x = Math.floor(w * fx)
    const y = Math.floor(h * fy)
    const picked = scene.pick(new (v.camera.positionWC.constructor)(x, y))
    const ray = v.camera.getPickRay(new (v.camera.positionWC.constructor)(x, y))
    const hit = ray ? scene.globe.pick(ray, scene) : null
    picks.push({
      at: `${fx},${fy}`,
      pickedId: picked?.id?.id ?? null,
      pickedType: picked?.primitive?.constructor?.name ?? null,
      globeHit: !!hit
    })
  }

  // 2) 用 Cesium 自己的截图能力（会强制重绘后读像素）
  let shotOk = false
  try {
    const shot = await new Promise((resolve) => {
      scene.postRender.addEventListener(function once() {
        scene.postRender.removeEventListener(once)
        resolve(scene.canvas.toDataURL('image/png'))
      })
    })
    if (typeof shot === 'string' && shot.length > 2000) {
      shotOk = true
      window.__shot = shot
    }
  } catch (e) {
    console.warn('screenshot failed', e)
  }

  return {
    canvasCss: `${w}x${h}`,
    canvasBuffer: `${scene.canvas.width}x${scene.canvas.height}`,
    drawingBufferWidth: scene.context.drawingBufferWidth,
    drawingBufferHeight: scene.context.drawingBufferHeight,
    devicePixelRatio: window.devicePixelRatio,
    picks,
    shotOk
  }
})

console.log(JSON.stringify({ ...result, __shot: undefined }, null, 2))

if (result?.shotOk) {
  const shot = await page.evaluate(() => window.__shot)
  writeFileSync('.snapshots/canvas-only.png', Buffer.from(shot.split(',')[1], 'base64'))
  console.log('已保存 .snapshots/canvas-only.png')
}

await browser.close()
