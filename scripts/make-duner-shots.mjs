/**
 * 墩儿（自然语言指挥层）的界面截图，输出到 `screenshots/`，供 README 展示区引用。
 *
 * 用法：node scripts/make-duner-shots.mjs [baseUrl]
 *      默认 baseUrl = http://localhost:8787（先 `npm run serve`）
 *
 * ## 为什么不并进 `make-screenshots.mjs`
 *
 * 那个脚本的模型是「导航一次 → 截一张」，而这两张要**先把对话框驱动起来**：
 * 点右下角按钮 → 往输入框里发一句话 → 等墩儿回话 → 再截。
 * 通用流程表达不了「驱动一个交互组件」；并进去还会连带重渲其余 12 张，
 * 让一次局部更新变成整仓截图 churn。
 *
 * ## 两张图各证明什么
 *
 *   `duner-chat.png`    入口按钮 + 对话框本体：一句话下去，**相机真的飞了**
 *                       （脚本取飞前/飞后的相机 ECEF 坐标，位移随图一起打出来）
 *   `duner-confirm.png` 写操作回来的是**确认卡**（对象 / 原因 / 建议措施 / 责任人 / 紧急度五行），
 *                       而不是直接建单
 *
 * ## 它不是纯截图工具：自己带两条判据
 *
 * ① **三维区不能是空地球** —— 判据与量法照抄 `make-screenshots.mjs` 的
 *    `baseColorShare`（0.25 上限）。软件渲染下「瓦片没上来」截出来的图
 *    满屏是 `globe.baseColor`，而深蓝本来就是这块大屏的底色，肉眼看着正常。
 *    同一把尺子量同一件事，不另起一套。
 * ② **截图这一步不许改动库** —— 截确认卡时统计 `/api/duner/confirm` 的请求数，
 *    并拿另一条路由查一遍"那张单子没被建出来"。
 *    「一个截图脚本顺手往库里写了张工单」是最不该发生、又最难发现的事。
 *
 * 截图前的固定动作与其余脚本一致：先 `viewer.render()` 再停渲染循环、等 800ms。
 * 唯一不这么干的是确认卡那一张 —— 卡上有倒计时（`DUNER_CONFIRM_TTL_MS`，默认 60s），
 * 停循环省下的那几秒可能刚好让它在图里变成「已取消」，所以那张**不停循环、立刻截**。
 */
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { login, newLoggedInPage } from './lib/session.mjs'
import { clickAt } from './lib/click.mjs'

const base = process.argv[2] || 'http://localhost:8787'
const OUT = 'screenshots'

/** 拍这两张的宿主页：三维居中 + 两侧浮面板，且让位后对话框不压右栏（见 `src/duner/corner.ts`） */
const HOST = '/monitoring'

/** 三维区里 `globe.baseColor` 占比超过这个数 ⇒ 底图没上来，图不能进 README */
const BLANK_3D_LIMIT = 0.25

/** 一句话 → 相机飞过去（要能从回话与会话里对得上） */
const 问她 = '带我去选矿厂'

/** 写操作 → 应回来一张确认卡（事由写成这句，好拿它去库里反查"到底写没写"） */
const 事由 = '截图脚本不该建单'
const 写话 = `生成处置工单，对象尾矿库，事由${事由}，责任人王建国`

mkdirSync(OUT, { recursive: true })

const fail = []
const note = (s) => console.log(`    ${s}`)

/** 等这一页的三维落定（照抄 make-screenshots.mjs 的顺序：先等 viewer，再等瓦片） */
async function settle3d(page, ms = 12000) {
  const has3d = await page
    .waitForFunction(() => !!window.__cesiumViewer, null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false)
  if (!has3d) return false
  await page
    .waitForFunction(() => window.__cesiumViewer?.scene?.globe?.tilesLoaded === true, null, {
      timeout: 120000
    })
    .catch(() => {})
  await page.waitForTimeout(ms)
  return true
}

/** 取画布矩形与 globe.baseColor（截图时现读，不写死） */
const globeProbe = (page) =>
  page.evaluate(() => {
    const v = window.__cesiumViewer
    if (!v) return null
    const r = v.canvas.getBoundingClientRect()
    const c = v.scene.globe.baseColor
    return {
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      },
      rgb: [Math.round(c.red * 255), Math.round(c.green * 255), Math.round(c.blue * 255)].join(',')
    }
  })

/** 量画布里有多少像素还是 `globe.baseColor`（= 底图没上来的面积） */
function baseColorShare(file, probe) {
  if (!probe) return null
  const png = PNG.sync.read(readFileSync(file))
  const X0 = Math.max(0, probe.rect.x)
  const Y0 = Math.max(0, probe.rect.y)
  const X1 = Math.min(png.width, probe.rect.x + probe.rect.width)
  const Y1 = Math.min(png.height, probe.rect.y + probe.rect.height)
  let n = 0
  let hit = 0
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const i = (png.width * y + x) << 2
      if (`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}` === probe.rgb) hit++
      n++
    }
  }
  return n ? hit / n : null
}

/** 相机 ECEF 坐标（用来证明"相机真的动了"，不是只有回话） */
const cameraAt = (page) =>
  page.evaluate(() => {
    const p = window.__cesiumViewer?.camera?.position
    return p ? { x: p.x, y: p.y, z: p.z } : null
  })
const dist = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : NaN)

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

/** 这一轮到底发出过几次"兑换"（确认执行）请求 —— 截完要它仍是 0 */
let 兑换请求 = 0
page.on('request', (r) => {
  if (r.url().includes('/api/duner/confirm')) 兑换请求++
})

/** 冻结一帧再截（确认卡那张走 freeze=false：卡上有倒计时，先省时间） */
async function shoot(file, { freeze = true } = {}) {
  if (freeze) {
    await page.evaluate(() => {
      const v = window.__cesiumViewer
      if (v) {
        v.render()
        v.useDefaultRenderLoop = false
      }
    })
    await page.waitForTimeout(800)
  }
  const probe = await globeProbe(page)
  await page.screenshot({ path: `${OUT}/${file}`, timeout: 120000 })
  if (freeze) {
    await page.evaluate(() => {
      const v = window.__cesiumViewer
      if (v) v.useDefaultRenderLoop = true
    })
  }
  const blank = baseColorShare(`${OUT}/${file}`, probe)
  return blank
}

/**
 * 保证对话框开着。**按钮是开合切换的** —— 开着的时候再点一下会把它关掉，
 * 所以第二句话不能无脑点按钮（这是写本脚本时真踩到的一处：
 * 第一版每次都点，第二张图直接截在关着的状态上）。
 */
async function openDock() {
  const 开着 = await page.evaluate(() =>
    Boolean(document.querySelector('[data-duner-dock] .duner__input'))
  )
  if (开着) return
  await clickAt(page, '[data-duner-dock] .duner__fab')
  await page.waitForSelector('[data-duner-dock] .duner__input', { timeout: 20000 })
}

/** 往对话框里说一句话（输入框只在开着的时候存在，见 DunerDock.vue 的 v-if） */
async function say(text) {
  await openDock()
  const before = await page.evaluate(() => document.querySelectorAll('.duner__msg').length)
  const ok = await page.evaluate((t) => {
    const el = document.querySelector('.duner__input')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, t)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value === t
  }, text)
  if (!ok) throw new Error('输入框没吃下这串字')
  const clicked = await clickAt(page, '.duner__send')
  if (!clicked.ok) throw new Error(`点不动发送键：${clicked.reason}`)
  await page.waitForFunction(
    (n) => {
      const msgs = document.querySelectorAll('.duner__msg')
      return msgs.length > n + 1 && msgs[msgs.length - 1].classList.contains('is-bot')
    },
    before,
    { timeout: 40000 }
  )
  return page.evaluate(
    () =>
      [...document.querySelectorAll('.duner__msg.is-bot .duner__text')].pop()?.textContent?.trim() ??
      ''
  )
}

try {
  await page.goto(base + '/#' + HOST, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.panel-box').length > 0, null, {
    timeout: 180000
  })
  const has3d = await settle3d(page)
  if (!has3d) throw new Error('这一页没有三维 viewer（宿主页选错了？）')
  note(`已进入 ${HOST}，三维落定`)

  // ---- 一张：一句话 → 相机真的飞了 --------------------------------------
  const 飞前 = await cameraAt(page)
  const 回话 = await say(问她)
  // 等缓动队列走空 + 瓦片补上，再截
  await page
    .waitForFunction(() => (window.__cesiumViewer?.scene?.tweens?.length ?? 0) === 0, null, {
      timeout: 60000
    })
    .catch(() => note('缓动队列 60 秒还没空，照截'))
  await page
    .waitForFunction(() => window.__cesiumViewer?.scene?.globe?.tilesLoaded === true, null, {
      timeout: 60000
    })
    .catch(() => {})
  await page.waitForTimeout(5000)
  const 飞后 = await cameraAt(page)
  const 位移 = dist(飞前, 飞后)

  const blankA = await shoot('duner-chat.png')
  console.log(`✓ ${OUT}/duner-chat.png  （${HOST} · 对话框开着）`)
  note(`回话：${回话 || '(空)'}`)
  note(`相机位移：${位移.toFixed(0)} m（"一句话驱动三维"的证据，不是只有回话）`)
  if (blankA !== null) note(`三维底图：baseColor 占 ${(blankA * 100).toFixed(1)}%`)
  if (!(位移 > 100)) fail.push(`相机几乎没动（${位移.toFixed(0)} m），这张图不能当"一句话飞过去"用`)
  if (blankA !== null && blankA > BLANK_3D_LIMIT) fail.push('duner-chat.png 的三维区基本是空的（底图没上来）')

  // ---- 二张：写操作先弹确认卡，且点之前一个字节都不写 --------------------
  兑换请求 = 0
  await say(写话)
  await page.waitForSelector('.duner__confirm', { timeout: 30000 })
  const 卡 = await page.evaluate(() => {
    const box = document.querySelector('.duner__confirm')
    return {
      title: box?.querySelector('.duner__card-title')?.textContent?.trim() ?? '',
      rows: [...(box?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent?.trim()),
      ttl: box?.querySelector('.duner__ttl')?.textContent?.trim() ?? '',
      text: box?.textContent ?? ''
    }
  })
  const blankB = await shoot('duner-confirm.png', { freeze: false })
  const ttl之后 = await page.evaluate(
    () => document.querySelector('.duner__confirm .duner__ttl')?.textContent?.trim() ?? ''
  )
  console.log(`✓ ${OUT}/duner-confirm.png  （写操作 → 确认卡）`)
  note(`卡面：${卡.title} · ${卡.rows.join(' / ')}`)
  note(`倒计时：截前「${卡.ttl}」→ 截后「${ttl之后}」`)
  if (blankB !== null) note(`三维底图：baseColor 占 ${(blankB * 100).toFixed(1)}%`)
  if (卡.title !== '生成处置工单' || !卡.rows.includes('对象')) {
    fail.push(`确认卡不对：标题「${卡.title}」· 行 ${卡.rows.join('/')}`)
  }
  if (!卡.text.includes(事由)) fail.push(`卡上没写我刚说的那个事由（${事由}）`)
  // 倒计时在截图期间清零的话，图里的卡会是"已取消"——那张图不能用
  if (卡.ttl.includes('已取消') || ttl之后.includes('已取消')) {
    fail.push(`确认卡在截图期间过期了（截前「${卡.ttl}」/ 截后「${ttl之后}」），这张图不能用`)
  }

  // 收尾：点「取消」，让这张卡作废 —— 全程不许有兑换请求、库里不许多出单子
  await clickAt(page, '.duner__confirm .duner__btn:not(.is-primary)')
  const 单 = await fetch(`${base}/api/decision/orders`, {
    headers: { Authorization: `Bearer ${session.token}` }
  })
    .then((r) => r.json())
    .then((rows) => (Array.isArray(rows) ? rows : (rows?.rows ?? [])))
    .then((rows) => rows.filter((o) => String(o.content ?? '').includes(事由)))
    .catch(() => null)
  note(`兑换请求：${兑换请求} 次 · 库里含「${事由}」的单：${单 === null ? '(查不到)' : 单.length} 条`)
  if (兑换请求 !== 0) fail.push(`截确认卡的路上发出了 ${兑换请求} 次兑换请求（不该有）`)
  if (单 === null) fail.push('查不到 /api/decision/orders，这条"没写库"的判据等于没跑')
  else if (单.length) fail.push(`库里凭空多出 ${单.length} 条单子（截图脚本改动了数据）`)
} catch (err) {
  fail.push(`截图失败：${String(err.message || err).slice(0, 200)}`)
} finally {
  await page.close()
  await browser.close()
}

if (fail.length) {
  console.error('\n✗ 有图不能进 README：')
  for (const f of fail) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\n完成：2 张（duner-chat / duner-confirm）')
