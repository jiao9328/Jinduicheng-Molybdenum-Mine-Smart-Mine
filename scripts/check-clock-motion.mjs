/**
 * 场景时钟流动检查：证明避灾路线上的「流动光带」**真的在动**。
 *
 * 这条检查为一个从未被发现过的规格违背而建：`createViewer` 里时钟写死
 * `shouldAnimate: false`，而光带的相位取自 `secondsOfDay(clock.currentTime)`
 * （见 `layers/flowMaterial.ts`），于是指导文档 §7.1 要求的「路线沿线动态流动光效」
 * 一直是一张静态图。它不报错、不告警，光看截图也看不出来——静态截图上光带是在的，
 * 只是永远停在同一相位。
 *
 * ⚠️⚠️ **本脚本绝对不能停 Cesium 的渲染循环。**
 * 其余所有巡检脚本为了截图稳定都会设 `useDefaultRenderLoop = false`，
 * 但 `clock.tick()` 是**由渲染循环每帧驱动**的，停掉渲染循环等于把时钟一起冻住，
 * 于是这个脚本会「永远测出光带不动」——测的是自己刚踩下的刹车。
 * 别照着其它脚本抄。
 *
 * ── 三条断言组 ──
 * A. 时钟在走：`shouldAnimate === true`，且 4 秒内 `currentTime` 前进 ≥ 2 秒
 * B. 画面在变：同一块区域隔 4 秒截两张图，sha1 **必须不同**
 * C. （**自证 + 噪声控制**）运行时把 `shouldAnimate` 置回 false，然后要求
 *    A、B 双双翻转：时钟不再前进、画面**完全一致**。
 *
 * C 是这条检查成立的前提，不是锦上添花：
 * 软件渲染（SwiftShader）+ FXAA 的抗锯齿本身可能逐帧抖动，瓦片也可能还在流式加载，
 * 两者都会让「两张图不同」轻松为真——那样 B 就是**恒真**的，测了等于没测。
 * 只有 C 证明「画面静止时两张图真的逐像素相同」，B 的差异才能归因到光带在动。
 *
 * 探针区域不写死坐标：从 `route-flow-*` 实体的折线顶点正投影算屏幕包围盒，
 * 取面积最大的那条。写死坐标的做法在相机一改就失效，而且失效时**依然全绿**。
 *
 * 用法：node scripts/check-clock-motion.mjs [baseUrl]
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'
import { createHash } from 'node:crypto'

const base = process.argv[2] || 'http://localhost:8787'
const sha = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 12)

const session = await login(base)

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--js-flags=--max-old-space-size=3072'
  ]
})
const page = await newLoggedInPage(browser, session, { viewport: { width: 1920, height: 1080 } })

const checks = []

await page.goto(base + '/#/emergency', { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.__cesiumViewer, null, { timeout: 240000 })
// 建场景 + 采样地形 + 等瓦片落地。软件渲染下这一步很慢，宁可多等。
await page.waitForTimeout(30000)

/**
 * 找流动线在屏幕上的包围盒。
 *
 * `SceneTransforms.worldToWindowCoordinates` 返回的是**相对 canvas** 的 CSS 像素，
 * 所以要补上 canvas 自身的页面偏移才是截图 clip 用的坐标。
 */
const probe = await page.evaluate(() => {
  const v = window.__cesiumViewer
  const C = window.__cesiumNS
  if (!v || !C) return { error: '未拿到 viewer / Cesium 命名空间' }

  const rect = v.canvas.getBoundingClientRect()
  const now = v.clock.currentTime

  let best = null
  let seen = 0
  let hidden = 0

  for (const ent of v.entities.values) {
    if (typeof ent.id !== 'string' || !ent.id.startsWith('route-flow-')) continue
    seen++
    if (ent.show === false) {
      hidden++
      continue
    }
    const prop = ent.polyline?.positions
    const positions = prop?.getValue ? prop.getValue(now) : null
    if (!positions?.length) continue

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of positions) {
      const w = C.SceneTransforms.worldToWindowCoordinates(v.scene, p)
      if (!w) continue
      const x = rect.left + w.x
      const y = rect.top + w.y
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    if (!Number.isFinite(minX)) continue

    // 裁到视口内，再留 14px 边距把线宽整个包进去
    const pad = 14
    const x = Math.max(0, minX - pad)
    const y = Math.max(0, minY - pad)
    const right = Math.min(window.innerWidth, maxX + pad)
    const bottom = Math.min(window.innerHeight, maxY + pad)
    const width = Math.floor(right - x)
    const height = Math.floor(bottom - y)
    if (width < 1 || height < 1) continue

    const area = width * height
    if (!best || area > best.area) best = { id: ent.id, x, y, width, height, area }
  }

  return { seen, hidden, best, shouldAnimate: v.clock.shouldAnimate }
})

console.log(`探针：route-flow-* 实体 ${probe.seen} 条（其中 show=false ${probe.hidden} 条）`)
if (probe.error) {
  console.log(`✗ ${probe.error}`)
  await browser.close()
  process.exit(1)
}
if (!probe.best) {
  console.log('✗ 没有一条可见的流动路线能算出屏幕包围盒 —— 探针不成立，本检查无法进行')
  await browser.close()
  process.exit(1)
}

const box = {
  x: probe.best.x,
  y: probe.best.y,
  width: probe.best.width,
  height: probe.best.height
}
console.log(`探针：取「${probe.best.id}」，屏幕区域 ${box.width}×${box.height} @ (${box.x}, ${box.y})`)

// 包围盒太小说明这条线在屏幕上只是一小段，像素差异可能被抗锯齿吃掉，
// 那样 B 会变成假阴性。宁可在这里明说「测不了」，也不要给一个可能是绿的假象。
if (box.width < 40 || box.height < 20) {
  console.log(`✗ 探针区域只有 ${box.width}×${box.height}，太小不足以可靠地判「画面在变」，本检查无法进行`)
  await browser.close()
  process.exit(1)
}

/** 当前时钟读数，换算成连续秒数（JulianDate 的两个字段都是公开的，不用再引 API） */
const clockSeconds = () =>
  page.evaluate(() => {
    const t = window.__cesiumViewer.clock.currentTime
    return t.dayNumber * 86400 + t.secondsOfDay
  })

const shoot = () => page.screenshot({ clip: box, timeout: 120000 })

const WINDOW_MS = 4000
const WINDOW_S = WINDOW_MS / 1000

/**
 * 时钟前进量的观测窗口。
 *
 * ⚠️ **窗口里绝不能夹截图。** 软件渲染下 `page.screenshot()` 一次要十几二十秒，
 * 而且它期间渲染循环是停的；把截图夹在两次读时钟中间，`a1 - a0` 量到的就是
 * 「4 秒等待 + 二十秒截图」，标签写着「4s 内前进」而数字是 24.66 —— 数字本身没错，
 * 但**它证明的不是标签说的那件事**，而且 24.66 会把「≥2s」这个阈值衬托得毫无约束力。
 * 所以时钟断言只量时钟，画面断言只量画面，两件事各自的窗口互不掺和。
 */
async function clockAdvance() {
  const t0 = await clockSeconds()
  await page.waitForTimeout(WINDOW_MS)
  const t1 = await clockSeconds()
  return t1 - t0
}

/** 同一块区域隔 WINDOW_MS 截两张图，返回两个 sha1 */
async function framePair() {
  const s0 = await shoot()
  await page.waitForTimeout(WINDOW_MS)
  const s1 = await shoot()
  return [sha(s0), sha(s1)]
}

// ---------- 断言组 A / B：时钟在走，画面在变 ----------
const animating = await page.evaluate(() => window.__cesiumViewer.clock.shouldAnimate === true)
const advanced = await clockAdvance()
const [hA0, hA1] = await framePair()

checks.push([`时钟在动画状态（shouldAnimate = ${animating}）`, animating === true])
// 双侧判定：`multiplier` 是 1 且 clockStep 是 SYSTEM_CLOCK_MULTIPLIER，
// 所以「时钟前进量 ≈ 墙上时间」是可预期的。只卡下界的话，有人把 multiplier
// 调成 8 让光带飞起来，这条照样绿——而那已经不是「按真实时间走」了。
checks.push([
  `${WINDOW_S}s 窗口内时钟前进 ${advanced.toFixed(2)}s（要求 ${WINDOW_S * 0.5}~${WINDOW_S * 2}s）`,
  advanced >= WINDOW_S * 0.5 && advanced <= WINDOW_S * 2
])
checks.push([`画面在变（${hA0} → ${hA1}）`, hA0 !== hA1])

// ---------- 断言组 C：自证 + 噪声控制 ----------
// 置回 false 之后必须**双双翻转**。若画面仍然在变，说明变化来自别处
// （抗锯齿抖动 / 瓦片还在加载 / 相机微动），上面那条 B 就不是光带的证据。
await page.evaluate(() => {
  window.__cesiumViewer.clock.shouldAnimate = false
})
// 等一帧稳定：刚置位那一瞬间可能还有上一帧的光带残留
await page.waitForTimeout(1500)

const frozenFor = await clockAdvance()
const [hC0, hC1] = await framePair()

checks.push([`[自证] 冻结后时钟停住（前进 ${frozenFor.toFixed(2)}s）`, frozenFor === 0])
checks.push([
  `[自证] 冻结后画面逐像素一致（${hC0} ${hC0 === hC1 ? '=' : '≠'} ${hC1}）`,
  hC0 === hC1
])

await browser.close()

console.log('\n' + '='.repeat(64))
for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`)
console.log('='.repeat(64))

if (hC0 !== hC1) {
  console.log(
    '\n✗ 噪声底太高：把时钟冻住之后画面**依然**在变，' +
      '说明截图差异来自抗锯齿抖动/瓦片加载，而不是光带。\n' +
      '  上面那条「画面在变」因此不构成证据，本次结果不可采信。'
  )
}

const failed = checks.filter(([, ok]) => !ok)
if (failed.length) console.log(`\n✗ ${failed.length}/${checks.length} 项不通过`)
else console.log(`\n✓ ${checks.length} 项全部通过 —— 光带确实在动，且这条判据有分辨力`)
process.exit(failed.length ? 1 : 0)
