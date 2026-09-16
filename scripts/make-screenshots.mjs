/**
 * 生成 README 用的系统截图，输出到 `screenshots/`。
 *
 * 这不是检查脚本（不断言、退出码只表示「有没有截出来」），
 * 是像 `fetch-map-tiles.mjs` 那样的**产出型工具**：跑一次，给仓库留下可展示的图。
 * 界面改了想更新截图，重跑本脚本即可，不用手截。
 *
 * ## 为什么要按路由分组
 *
 * 三维页在软件渲染下**每次导航要 30~45 秒**。`/digital-twin` 要出两张图
 *（设备效率 / 边坡监测），一个页签一次导航的话就是两次加载、白白多等半分钟。
 * 所以同一个路由只 `goto` 一次，之后靠点页签换态。
 * （`/decision` 曾经也是这样：三个维度共用一条路由、点三次页签出三张图。
 *   现在它和 `/cost` 是两条独立路由，各出一张，页签分组这一层已经不需要了。）
 *
 * ## 截图前的固定动作
 *
 * 先 `viewer.render()` 再 `useDefaultRenderLoop = false` 把渲染循环停掉，
 * 等 800ms 让合成落地，然后截图 —— 这是本仓库所有巡检脚本用惯的做法，
 * 停下来是为了截到稳定的一帧（唯一不能停的是 `check-clock-motion.mjs`，
 * 那个要测时钟在走；这里是静态展示图，停掉正合适）。
 *
 * ## 「三维区是不是空的」要自己量（2026-09-14 补）
 *
 * 这脚本一度把十张图都截得「看着正常」、其实三维区是**空地球**：它在
 * `.panel-box` 出现的瞬间问「这一页有没有三维」，而那是静态骨架（0.5s 就出来），
 * viewer 要 1.1s 之后才挂上 —— 答成 false，三维页就只等 6 秒，瓦片没到就截图。
 * 满屏深蓝本来就是这个大屏的底色，所以十张图逐张看都「挺正常」。
 *
 * 现在两头都堵上：先等 viewer 再判定（`settle3d`），截完再按像素量一次
 * 三维区里 `globe.baseColor` 占多少（`baseColorShare`），超了就报错、退出码非零。
 * 教训与 §13 那条一样：**「看着正常」不是判据，量出来的才是**。
 *
 * ## 登录（2026-09-14 加）
 *
 * 页面现在默认要登录，所以本脚本先登一次再把会话注入每个页面
 *（`lib/session.mjs`）。**唯一的例外是登录页自己的那张图** ——
 * 带着会话去开 `#/login` 会被守卫弹回首页，截出来就成首页了，
 * 所以那一张用一个不带会话的新页面单独截。
 *
 * 用法：node scripts/make-screenshots.mjs [baseUrl]
 *      默认 baseUrl = http://localhost:8787（先 `npm run serve`，它按需自动构建）
 */
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { login, newLoggedInPage } from './lib/session.mjs'

const base = process.argv[2] || 'http://localhost:8787'
const OUT = 'screenshots'

/**
 * 三维页「瓦片落定」的固定沉降时间（毫秒）。
 *
 * 6 秒不够。`.panel-box` 是**静态骨架**、0.5s 就出来了，而 `window.__cesiumViewer`
 * 要 1.1s 之后才挂上（实测见 `_probe-has3d`）。早先这里是在骨架出现的瞬间就问
 * 「这一页有没有三维」，于是答 false → 三维页只等 6 秒 → **瓦片还没到就把空地球
 * 截了下来**：底图整片是 `globe.baseColor`（#07182b）。
 *
 * 这种图特别容易被骗过去 —— 满屏深蓝本来就是这个大屏的底色，
 * 十张图逐张看都「挺正常」，只有跟现场对照才会发现三维区是空的。
 * 25 秒是实测够用的值；文件末尾的「底图自检」就是防它再犯。
 */
const SETTLE_MS = 25000

/** 三维画布里 baseColor 占比超过这个数，就认为「底图根本没上来」 */
const BLANK_3D_LIMIT = 0.25

/**
 * 截图清单：**按路由分组**，同组只导航一次。
 *
 * `tab` 是页签下标（不填即默认态）。选择器与 `check-panel-overflow.mjs`
 * 的 `TAB_PAGES` 保持一致 —— 那边在下标与标题的对应关系上已经有断言守着，
 * 这里跟着用同一套下标，页签顺序改了会一起失效、不会各错各的。
 */
const GROUPS = [
  { path: '/', name: '首页', shots: [{ file: 'overview' }] },
  {
    path: '/digital-twin',
    name: '数字孪生',
    tabSelector: '.twin__tab',
    shots: [
      { file: 'digital-twin', tab: 0 },
      { file: 'slope-monitor', tab: 2 }
    ]
  },
  { path: '/monitoring', name: '智能监控', shots: [{ file: 'monitoring' }] },
  { path: '/reports', name: '统计报表', shots: [{ file: 'reports' }] },
  { path: '/emergency', name: 'AI视频分析', shots: [{ file: 'video-analysis' }] },
  { path: '/safety', name: '安全管理', shots: [{ file: 'safety' }] },
  { path: '/equipment', name: '设备管理', shots: [{ file: 'equipment' }] },
  { path: '/data-admin', name: '数据管理', shots: [{ file: 'data-admin' }] },
  // 「决策指挥」与「成本管理」不再共用 /decision，也不再需要页签分组：
  // 拆成两个页面之后，一次导航出一张图，各是一张完整的大屏
  { path: '/decision', name: '决策指挥', shots: [{ file: 'decision' }] },
  { path: '/cost', name: '成本管理', shots: [{ file: 'cost' }] }
]

mkdirSync(OUT, { recursive: true })

/**
 * 等这一页的三维落定。返回「这一页到底有没有三维」。
 *
 * 顺序很重要：**先等 viewer 出现，再问有没有**。反过来问过一次，
 * 结果是三维页被当成二维页、只等 6 秒（见 `SETTLE_MS` 的说明）。
 */
async function settle3d(page, ms = SETTLE_MS) {
  const has3d = await page
    .waitForFunction(() => !!window.__cesiumViewer, null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false)
  if (!has3d) return false

  // `tilesLoaded` 在跳机位后的瞬间就是 true（队列还空），单看它不作准；
  // 这里只是「尽量等它不欠瓦片」，真正保底的是后面那段固定沉降。
  await page
    .waitForFunction(() => window.__cesiumViewer?.scene?.globe?.tilesLoaded === true, null, {
      timeout: 120000
    })
    .catch(() => {})
  await page.waitForTimeout(ms)
  return true
}

/** 取画布矩形与 globe.baseColor（都要在截图时现读，不能写死） */
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
      rgb: [
        Math.round(c.red * 255),
        Math.round(c.green * 255),
        Math.round(c.blue * 255)
      ].join(',')
    }
  })

/**
 * 量画布里有多少像素还是 `globe.baseColor` —— 也就是「底图没上来」的面积。
 *
 * 为什么用颜色而不是看图：三维区本来就是深蓝的，肉眼与识图都容易把
 * 「空地球」读成「正常的科技蓝」。baseColor 是精确值，骗不了人。
 */
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

const session = await login(base)

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--js-flags=--max-old-space-size=3072'
  ]
})

let done = 0
let failed = 0
/** 截出来一块面板都没有的图 —— 这种图不能进 README */
const emptyShots = []
/** 同一路由下多个态的面板标题集合两两相同的组 —— 说明页签压根没切 */
const sameState = []
/** 三维区大半是 globe.baseColor 的图 —— 说明底图没上来，截的是个空地球 */
const blank3d = []

// ---------------------------------------------------------------------------
// 登录页单独截：它必须**不带会话**，否则会被守卫弹回首页
// ---------------------------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  try {
    await page.goto(base + '/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForSelector('.login__card', { timeout: 30000 })
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${OUT}/login.png`, timeout: 120000 })

    // 自证「截到的确实是登录页」：读 DOM 而不是看图。
    // 守卫若把没会话的访问放行了，这里会截到首页而**图看着也正常**
    const title = await page.locator('.login__title').textContent().catch(() => '')
    const accounts = await page.locator('.login__demo-item').count()
    console.log(`✓ ${OUT}/login.png  （登录页）`)
    console.log(`    标题：${title?.trim() ?? '(无)'} · 演示账号 ${accounts} 个`)
    if (!title?.trim() || accounts === 0) {
      emptyShots.push('login（没截到登录卡片，可能被守卫弹走了）')
    }
    done++
  } catch (err) {
    console.error(`✗ 登录页截图失败：${String(err.message || err).slice(0, 200)}`)
    failed++
  }
  await page.close()
}

for (const group of GROUPS) {
  const page = await newLoggedInPage(browser, session, { viewport: { width: 1920, height: 1080 } })
  try {
    await page.goto(base + '/#' + group.path, {
      waitUntil: 'domcontentloaded',
      timeout: 120000
    })

    // 面板出来即认为这一页渲染完了。比固定等 22 秒可靠：
    // 慢机器上多等、快机器上少等，都不会截到半成品。
    await page.waitForFunction(
      () => document.querySelectorAll('.panel-box').length > 0,
      null,
      { timeout: 180000 }
    )

    // 有三维的页面再等瓦片流式加载落定；没有 viewer 的页面跳过。
    // 注意先等 viewer 出现再判定（见 `settle3d`）。
    const has3d = await settle3d(page)
    if (!has3d) await page.waitForTimeout(6000)

    for (const shot of group.shots) {
      if (shot.tab !== undefined) {
        await page.locator(group.tabSelector).nth(shot.tab).click()
        // 切态后等面板重排 + 三维图层跟着换。
        // 换态 = 换机位/换图层，等于重新加载一遍瓦片，所以走同一套落定等待。
        if (has3d) await settle3d(page)
        else await page.waitForTimeout(2500)
      }

      // 冻结一帧（见文件头说明）
      await page.evaluate(() => {
        const v = window.__cesiumViewer
        if (v) {
          v.render()
          v.useDefaultRenderLoop = false
        }
      })
      await page.waitForTimeout(800)

      // 截图前现读一次画布矩形与 baseColor，截完拿它量「底图是不是空的」
      const probe = has3d ? await globeProbe(page) : null
      await page.screenshot({ path: `${OUT}/${shot.file}.png`, timeout: 120000 })
      const blank = baseColorShare(`${OUT}/${shot.file}.png`, probe)
      if (blank !== null && blank > BLANK_3D_LIMIT) {
        blank3d.push(`${shot.file}（三维区 ${(blank * 100).toFixed(0)}% 是 baseColor）`)
      }

      // 顺手把这一帧的面板标题读出来。
      //
      // 必须读，不能靠看图：**页签点了没反应**是这类页面的已知失效方式
      //（本仓库在 `check-panel-overflow.mjs` 里就专门为它立过判据），
      // 而它截出来的图**看着完全正常**——只是内容还是上一个态的。
      // 拿肉眼或识图去核对标题，会把「没切过去」当成「切过去了」。
      const titles = await page.evaluate(() =>
        [...document.querySelectorAll('.panel-box__title')].map((e) => e.textContent.trim())
      )
      shot.titles = titles
      console.log(
        `✓ ${OUT}/${shot.file}.png  （${group.name}${shot.tab !== undefined ? ' · 第' + (shot.tab + 1) + '态' : ''}）`
      )
      console.log(`    面板：${titles.join(' / ') || '(一块都没有)'}`)
      if (blank !== null) console.log(`    三维底图：baseColor 占 ${(blank * 100).toFixed(1)}%`)
      if (!titles.length) emptyShots.push(shot.file)
      done++
    }

    // 同一路由出了多张图，各态的面板集合必须两两不同。
    // 相同就说明页签没切过去（点击落空 / 选择器过期），
    // 那样一个路由的三张图会是同一张画面，而每张单独看都「没问题」。
    const sets = group.shots.map((s) => [...(s.titles ?? [])].sort().join('|'))
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        if (group.shots[i].titles?.length && sets[i] === sets[j]) {
          sameState.push(`${group.shots[i].file} 与 ${group.shots[j].file}`)
        }
      }
    }
  } catch (err) {
    console.error(`✗ ${group.name}（${group.path}）截图失败：${String(err.message || err).slice(0, 200)}`)
    failed++
  }
  await page.close()
}

await browser.close()

console.log(`\n完成：${done} 张，失败 ${failed} 组`)

// 两类「图截出来了、但内容是错的」——比截图失败更隐蔽，必须自己报出来
if (emptyShots.length) {
  console.error(`✗ 这些图一块面板都没有，不能进 README：${emptyShots.join('、')}`)
}
if (sameState.length) {
  console.error(
    `✗ 同一个路由下这几张图的面板集合完全一样，说明页签没切过去：${sameState.join('；')}`
  )
}
if (blank3d.length) {
  console.error(`✗ 这些图的三维区基本是空的（底图没上来），不能进 README：${blank3d.join('、')}`)
}

const bad = failed || emptyShots.length || sameState.length || blank3d.length
process.exit(bad ? 1 : 0)
