/**
 * 底图崩溃诊断：对比「地球开启」与「地球关闭只留图层」两种情况下缓存增长速度。
 * 用法：node scripts/diagnose-imagery.mjs [url]
 */
import { chromium } from 'playwright'

const url = process.argv[2] || 'http://localhost:4173/#/'

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=3072']
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().replace(/\s+/g, ' ').slice(0, 130)) })

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(5000)

async function trial(label, { minLevel, globeShow }) {
  const r = await page.evaluate(async (cfg) => {
    const v = window.__cesiumViewer
    const C = window.__cesiumNS
    v.imageryLayers.removeAll(true)

    const provider = new C.UrlTemplateImageryProvider({
      url: 'map-tiles/imagery/{z}/{x}/{y}.jpg',
      minimumLevel: cfg.minLevel, maximumLevel: 17,
      tileWidth: 256, tileHeight: 256, hasAlphaChannel: false
    })
    const layer = new C.ImageryLayer(provider)
    v.imageryLayers.add(layer)
    v.scene.globe.show = cfg.globeShow

    window.__probe = { layer, n: 0, byLevel: {} }
    const orig = layer.getImageryFromCache
    layer.getImageryFromCache = function (x, y, level, rect) {
      window.__probe.n++
      window.__probe.byLevel[level] = (window.__probe.byLevel[level] || 0) + 1
      return orig.call(this, x, y, level, rect)
    }

    return { minLevel: cfg.minLevel, globeShow: cfg.globeShow }
  }, { minLevel, globeShow })

  // 逐秒采样
  const seq = []
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1000)
    const s = await page.evaluate(() => ({ n: window.__probe?.n || 0 })).catch(() => null)
    if (!s) break
    seq.push(s.n)
    if (s.n > 900000) break
  }

  const levels = await page.evaluate(() => window.__probe?.byLevel || {}).catch(() => ({}))
  const panel = await page.evaluate(() => {
    const e = document.querySelector('.cesium-widget-errorPanel')
    return e ? getComputedStyle(e).display !== 'none' : false
  }).catch(() => false)

  console.log(`${label}`)
  console.log(`  每分钟增长序列: ${seq.join(' → ')}`)
  console.log(`  层级分布: ${JSON.stringify(levels)}`)
  console.log(`  错误面板: ${panel ? '崩溃' : '正常'}`)
  console.log('')
}

await trial('A 地球开启 + minimumLevel=12', { minLevel: 12, globeShow: true })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)
await trial('B 地球开启 + minimumLevel=0', { minLevel: 0, globeShow: true })

console.log('错误:', errs.length ? [...new Set(errs)].slice(0, 2) : 'none')
await browser.close()
