/**
 * 单页运行时探查：打开**你给的那一个** URL，把控制台报错、warning、
 * 失败请求、WebGL 上下文与画布尺寸摊出来，并截一张图。
 *
 * 用法：
 *   node scripts/probe-runtime.mjs [url] [outDir]
 * 默认 url=http://localhost:4173/，outDir=./.snapshots
 *
 * ── 它是 probe，不是 check（第 11 节的约定）──
 * `check-*` 判死：带退出码与自证用例；`probe-*` **给人看图/读数，不断言也不该断言**。
 * 这个脚本 2026-09-14 之前叫 `check-runtime.mjs`，但正文从头到尾没有一句断言、
 * 永远 exit 0——正是第 13 节第 23 条那具「挂着 check 名字做 probe 的事」的壳，
 * 只换了个文件。它又与 `check-all-pages.mjs` 大面积重叠（那个跑固定 7 条业务路由、
 * 逐页出结论、带退出码），于是按约定**归位成探针**：留在这儿当一个随手可用的读数工具，
 * 判定交给 `check-all-pages.mjs`。**别再给它补断言**——第 11 节那句
 * 「扶正 ≠ 加断言」是这个方向上的同一条规矩。
 *
 * 它比 `check-all-pages.mjs` 多读三样（这才是留着它的理由）：
 * **WebGL 上下文真的建起来没**（`gl.getParameter(gl.VERSION)`）、画布的**实际像素尺寸**
 * （0×0 说明三维区塌了，而画布元素还在）、以及控制台 **warning**（那边只收 error）。
 *
 * ── 读数怎么用 ──
 * warning 与失败请求**只摊开不判定**：离线 `tileset.json`、「3D Tiles 加载失败，
 * 回退到程序化场景」这类都会落进那两个桶，噪声基线没有实测出来之前，
 * 任何阈值都是猜的。给人看的读数，比一个恒红的判据有用。
 *
 * 目标页要是有三维底座的页面（默认首页即是）。
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const 位置参数 = process.argv.slice(2)
const url = 位置参数[0] || 'http://localhost:4173/'
const outDir = 位置参数[1] || '.snapshots'

await mkdir(outDir, { recursive: true })

const browser = await chromium.launch({
  args: [
    // 无头环境跑 WebGL 需要 SwiftShader 软件渲染
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist'
  ]
})

const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })

const 真错误 = []
const 接口未就绪 = []
const warnings = []
const failed = []

page.on('console', (msg) => {
  const type = msg.type()
  const text = msg.text()
  if (type === 'warning') {
    warnings.push(text)
  } else if (type === 'error') {
    // 与 check-all-pages.mjs 同一套口径：后端未就绪时的接口失败是预期行为（请求层会降级）
    if (text.includes('404') || text.includes('/api/')) 接口未就绪.push(text)
    else 真错误.push({ type, text })
  }
})
page.on('pageerror', (err) => 真错误.push({ type: 'pageerror', text: String(err?.stack || err) }))
page.on('requestfailed', (req) => failed.push(`${req.url()} — ${req.failure()?.errorText}`))

// 唯一一处非零退出：**页面打不开，探针就取不到任何读数**。
// 这说的是「工具跑不动」，不是「被测对象不合格」——后者是 check-* 的事。
let 导航失败 = null
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
} catch (err) {
  导航失败 = String(err.message || err).replace(/\s+/g, ' ').slice(0, 200)
}
if (导航失败) {
  console.error(`✗ 打不开 ${url}：${导航失败}\n（这是探针自己没跑起来，不是页面的判定）`)
  await browser.close()
  process.exit(1)
}
// 给 Cesium 初始化 + 首帧渲染留时间
await page.waitForTimeout(6000)

const probe = await page.evaluate(() => {
  const canvas = document.querySelector('#cesium-container canvas')
  const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl')
  return {
    title: document.title,
    hasCanvas: !!canvas,
    canvasSize: canvas ? `${canvas.width}x${canvas.height}` : null,
    renderer: gl ? gl.getParameter(gl.VERSION) : null,
    panels: document.querySelectorAll('.panel-box').length,
    charts: document.querySelectorAll('.echart-box canvas').length,
    bodyText: document.body.innerText.slice(0, 400)
  }
})

await page.screenshot({ path: `${outDir}/smoke.png` })
await browser.close()

console.log(
  JSON.stringify(
    {
      url,
      probe,
      warningCount: warnings.length,
      warnings: warnings.slice(0, 15),
      failedRequests: failed
    },
    null,
    2
  )
)

// ---- 读数（给人看的，不是断言）----
console.log('\n' + '='.repeat(64))
console.log(`读数　页面标题：${probe.title || '（空）'}`)
console.log(`读数　正文读得到：${probe.bodyText.trim().length > 0 ? '是' : '否（白屏？）'}`)
console.log(
  `读数　画布：${probe.canvasSize ?? '三维容器里没有画布'}` +
    '　（期望非 0×0；0×0 = 元素在但三维区塌了）'
)
console.log(`读数　WebGL renderer：${probe.renderer ?? '（空，软渲染没起来或上下文丢了）'}`)
console.log(`读数　面板 ${probe.panels} 块 / 图表 ${probe.charts} 个`)
console.log(`读数　真错误 ${真错误.length} 条（接口未就绪 ${接口未就绪.length} 条已单列）`)
console.log(`读数　warning ${warnings.length} 条 / 请求失败 ${failed.length} 条（都不判定，仅摊开）`)
console.log('='.repeat(64))
console.log('以上是**读数**，不是断言——这个脚本不判成败（判定在 `check-all-pages.mjs`）')
console.log(`截图：${outDir}/smoke.png`)

if (真错误.length) {
  console.log('\n真错误明细：')
  for (const e of 真错误.slice(0, 10)) console.log(`   [${e.type}] ${e.text.slice(0, 160)}`)
}
