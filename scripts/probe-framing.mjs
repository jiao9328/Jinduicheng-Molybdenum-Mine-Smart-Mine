/**
 * 构图量化诊断：把**场景里真实存在的实体**投影到屏幕，按 id 前缀分组算出占屏范围，
 * 用来客观判断「相机是否对准、场景是不是够大」，不依赖肉眼。
 *
 * ⚠️ 坐标一律**从应用里取**（`viewer.entities` 的 position 正投影），不手抄经纬度。
 *
 * 这个文件原先写死了某一版矿区的 4 个角点 + 5 个关键地物（113.1015 / 37.2015）。
 * 矿区换过一次、厂区又搬过一次，它照旧打印「采坑中心 (x, y)」这类数字——
 * **看着像模像样，其实全是无意义的**：投影的是一个 429km 外、画面上根本不存在的位置。
 * 手抄坐标的问题不是「会过时」，而是**过时之后不报错**（README 第 13 节第 17 条）。
 * `probe-*` 的解法是「让它少依赖手抄的坐标」（第 11 节），
 * 不是给它补一个它撑不住的断言——所以这里一个经纬度字面量都没有。
 *
 * ⚠️ 贴地几何（`heightReference: CLAMP_TO_GROUND`）的 position **没有高度**，
 * 投影结果会落到屏幕外好几百像素。那是**假象**，不代表它画错了位置——
 * 它的几何是贴着地形起伏铺开的，`position` 只用来定位，海拔 0 不影响渲染。
 * （2026-09-13 我就是把这个假象读成了「7 个风险区跑出了画面」，差点去动相机。）
 * 这类实体在这里单独计数、跳过投影；真要判它们画在哪儿，
 * 用 `check-twin-layers.mjs` 的像素判据。
 *
 * 分组规则：按 id 的第一段小写词分组，遇到第一个「非纯小写字母」的段就停。
 * 于是 `twin-device-DR-01` → `twin-device`、`bench-T1` → `bench`、
 * `slope-base-SL-01` → `slope-base`。规则由数据本身决定，不维护一张前缀表。
 *
 * 用法：node scripts/probe-framing.mjs [url]
 * 输出：① 分组占屏表　② 全场景并集范围与占比　③ `.snapshots/framing.png`
 *      （截图取的是 **Cesium canvas 层**，不含 HTML 面板——面板是 DOM，不在 canvas 里）
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const url = process.argv[2] || 'http://localhost:8787/#/'
mkdirSync('.snapshots', { recursive: true })

const session = await login(new URL(url).origin)

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist'
  ]
})
const page = await newLoggedInPage(browser, session, { viewport: { width: 1920, height: 1080 } })

// 日志一条都不许过滤：整站白屏时唯一那行报错就在这里（probe-plant.mjs 的教训）
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 500)}`))
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + (e.stack || e.message).slice(0, 800)))

await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 })

// 轮询等场景就绪（SwiftShader 下建场景 30~45s）。就绪即走，不等满。
const deadline = Date.now() + 90000
let ready = false
while (Date.now() < deadline) {
  ready = await page.evaluate(
    () => !!window.__cesiumViewer && window.__cesiumViewer.entities.values.length > 50
  )
  if (ready) break
  await page.waitForTimeout(2000)
}
if (!ready) {
  console.log('[失败] 90s 内没等到场景就绪。控制台全文：')
  logs.forEach((l) => console.log(l))
  await browser.close()
  process.exit(1)
}
// 场景建好了不等于画面落定：贴地几何要等地形瓦片，实测要 45~55s（README 第 5 节）
await page.waitForTimeout(15000)

const res = await page.evaluate(() => {
  const v = window.__cesiumViewer
  const C = window.__cesiumNS
  const scene = v.scene
  const t = v.clock.currentTime
  const W = scene.canvas.clientWidth
  const H = scene.canvas.clientHeight

  /** 贴地几何：position 没有高度，投影无意义 */
  const clampedKind = (e) => {
    for (const k of ['ellipse', 'polygon', 'rectangle', 'corridor', 'billboard', 'model', 'point']) {
      const g = e[k]
      if (!g) continue
      const hr = g.heightReference?.getValue?.(t)
      if (hr === C.HeightReference.CLAMP_TO_GROUND) return k
    }
    if (e.polyline?.clampToGround?.getValue?.(t)) return 'polyline'
    return null
  }

  /**
   * 投影有三种结局，都是**实测**出来的（2026-09-13，一次性试验件逐条量过）：
   *   ① 相机前方且在视锥内 → 正常的屏幕坐标；
   *   ② **相机后方** → 返回 `undefined`。**不是**爆炸值——`worldToWindowCoordinates`
   *      自己会挡掉（我原先在注释里写成「后方点给出爆炸值」，量过之后是错的）；
   *   ③ 相机前方但远在视锥外 → 返回**有限但巨大**的值（实测：正前方 1km、
   *      横向偏 5km → x≈9274）。这是透视外推。tree 分组那批 x=-41139 / y=816587
   *      出自这一类。
   *
   * ⚠️ 还有一种结局是**抛错**：把「相机自身所在的那个点」喂进去会抛，
   * 而报错信息在生产构建里被压成 `page.evaluate: C` 这种看不出所以然的东西
   * ——一次抛错会带走整段 evaluate（我为此白跑了两轮）。所以逐个 try/catch。
   *
   * 因为 ③，占屏范围只能由**画面内**的点给出，否则一个画外点就把范围撑到几万像素，
   * 整张表就没法读了。
   */
  const project = (pos) => {
    try {
      const w = C.SceneTransforms.worldToWindowCoordinates(scene, pos)
      return w ? { x: Math.round(w.x), y: Math.round(w.y) } : null
    } catch {
      return false // false = 抛错，与 null（投影为空）区分开
    }
  }

  /** 分组键：连续的纯小写词段，遇到第一个不是的全停 */
  const groupKey = (id) => {
    const seg = id.split('-')
    const i = seg.findIndex((s) => !/^[a-z]+$/.test(s))
    return (i === -1 ? seg : seg.slice(0, i)).join('-') || id
  }

  const groups = new Map()
  let clampedTotal = 0

  for (const e of v.entities.values) {
    const key = groupKey(e.id)
    if (!groups.has(key))
      groups.set(key, { key, pts: [], clamped: 0, noPos: 0, noProj: 0, throw: 0 })
    const g = groups.get(key)

    if (clampedKind(e)) {
      g.clamped++
      clampedTotal++
      continue
    }

    let pos = null
    try {
      pos = e.position?.getValue(t) ?? null
    } catch {
      pos = null
    }
    if (!pos) {
      g.noPos++
      continue
    }

    const w = project(pos)
    if (w === false) g.throw++
    else if (w === null) g.noProj++
    else g.pts.push(w)
  }

  const inView = (p) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H

  /** 占屏范围只由**在画面内**的点给出：画外的点会把范围撑成几万像素，那张表就没法读了 */
  const screenBox = (pts) => {
    const inb = pts.filter(inView)
    if (!inb.length) return null
    const xs = inb.map((p) => p.x)
    const ys = inb.map((p) => p.y)
    return {
      x: [Math.round(Math.min(...xs)), Math.round(Math.max(...xs))],
      y: [Math.round(Math.min(...ys)), Math.round(Math.max(...ys))]
    }
  }

  const rows = [...groups.values()]
    .filter((g) => g.pts.length || g.noProj || g.throw || g.clamped || g.noPos)
    .map((g) => ({
      key: g.key,
      有位置: g.pts.length + g.noProj + g.throw,
      在画面内: g.pts.filter(inView).length,
      相机后方: g.noProj,
      投影抛错: g.throw,
      贴地跳过: g.clamped,
      无position: g.noPos,
      占屏: screenBox(g.pts)
    }))
    .sort((a, b) => b.有位置 - a.有位置)

  const allPts = [...groups.values()].flatMap((g) => g.pts)
  const union = {
    占屏: screenBox(allPts),
    在画面内: allPts.filter(inView).length,
    可投影: allPts.length,
    实体总数: v.entities.values.length,
    贴地几何: clampedTotal,
    无position: [...groups.values()].reduce((n, g) => n + g.noPos, 0),
    投影抛错: [...groups.values()].reduce((n, g) => n + g.throw, 0)
  }

  // 右侧面板列（DOM，不在 canvas 里）：数据若压到这里就是被面板盖住了
  const panel = document.querySelector('.twin__panel, .decision__panel, .equipment__panel')
  const pr = panel ? panel.getBoundingClientRect() : null

  return {
    视口: `${W}x${H}`,
    实体总数: v.entities.values.length,
    贴地几何跳过: clampedTotal,
    面板列: pr ? [Math.round(pr.left), Math.round(pr.right)] : null,
    分组: rows,
    并集: union
  }
})

console.log(`视口 ${res.视口}　实体 ${res.实体总数} 个　贴地几何跳过 ${res.贴地几何跳过} 个`)
if (res.面板列) console.log(`右侧面板列 x ∈ [${res.面板列[0]}, ${res.面板列[1]}]`)
console.log('')
console.log('分组'.padEnd(20) + '有位置  在画面内  后方  占屏范围')
for (const r of res.分组) {
  const box = r.占屏
  console.log(
    r.key.padEnd(20) +
      String(r.有位置).padStart(5) +
      String(r.在画面内).padStart(8) +
      String(r.相机后方).padStart(6) +
      '   ' +
      (box
        ? `x [${String(box.x[0]).padStart(4)},${String(box.x[1]).padStart(4)}]  y [${String(box.y[0]).padStart(4)},${String(box.y[1]).padStart(4)}]`
        : '（一个都没进画面）') +
      (r.贴地跳过 ? `  贴地 ${r.贴地跳过}` : '') +
      (r.无position ? `  无 position ${r.无position}` : '') +
      (r.投影抛错 ? `  投影抛错 ${r.投影抛错}` : '')
  )
}
if (res.并集?.占屏) {
  const u = res.并集
  const b = u.占屏
  const wPct = (((b.x[1] - b.x[0]) / 1920) * 100).toFixed(1)
  const hPct = (((b.y[1] - b.y[0]) / 1080) * 100).toFixed(1)
  console.log('')
  console.log(
    `占屏并集：x [${b.x[0]}, ${b.x[1]}]（${wPct}% 宽）　y [${b.y[0]}, ${b.y[1]}]（${hPct}% 高）`
  )
  console.log(
    `在画面内 ${u.在画面内}/${u.可投影} 个可投影实体` +
      `（实体共 ${u.实体总数} 个：贴地几何 ${u.贴地几何}、无 position ${u.无position}、投影抛错 ${u.投影抛错} 不参与投影）`
  )
}

const shot = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const scene = window.__cesiumViewer.scene
      const once = () => {
        scene.postRender.removeEventListener(once)
        resolve(scene.canvas.toDataURL('image/png'))
      }
      scene.postRender.addEventListener(once)
    })
)
writeFileSync('.snapshots/framing.png', Buffer.from(shot.split(',')[1], 'base64'))
console.log('\n[截图] .snapshots/framing.png（canvas 层，不含 HTML 面板）')

await browser.close()
