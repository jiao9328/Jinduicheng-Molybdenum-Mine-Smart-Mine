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
 *（设备效率 / 边坡监测）、`/decision` 要出三张（三个维度），
 * 一个页签一次导航的话就是五次加载、白白多等两三分钟。
 * 所以同一个路由只 `goto` 一次，之后靠点页签换态。
 *
 * ## 截图前的固定动作
 *
 * 先 `viewer.render()` 再 `useDefaultRenderLoop = false` 把渲染循环停掉，
 * 等 800ms 让合成落地，然后截图 —— 这是本仓库所有巡检脚本用惯的做法，
 * 停下来是为了截到稳定的一帧（唯一不能停的是 `check-clock-motion.mjs`，
 * 那个要测时钟在走；这里是静态展示图，停掉正合适）。
 *
 * 用法：node scripts/make-screenshots.mjs [baseUrl]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const base = process.argv[2] || 'http://localhost:4173'
const OUT = 'screenshots'

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
  { path: '/production', name: '智能监控', shots: [{ file: 'monitoring' }] },
  { path: '/emergency', name: 'AI视频分析', shots: [{ file: 'video-analysis' }] },
  { path: '/safety', name: '安全管理', shots: [{ file: 'safety' }] },
  { path: '/equipment', name: '设备管理', shots: [{ file: 'equipment' }] },
  {
    path: '/decision',
    name: '决策指挥',
    tabSelector: '.decision__dim',
    shots: [
      { file: 'decision-cost', tab: 0 },
      { file: 'decision-production', tab: 1 },
      { file: 'decision-energy', tab: 3 }
    ]
  }
]

mkdirSync(OUT, { recursive: true })

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

for (const group of GROUPS) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
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
    // `globe.tilesLoaded` 在一次跳机位后的瞬间就是 true（队列还空），
    // 所以要连着稳定若干帧才算数——这里退一步，只等一个固定沉降时间，
    // 反正软件渲染下截图本身就要几十秒。
    const has3d = await page.evaluate(() => !!window.__cesiumViewer)
    await page.waitForTimeout(has3d ? 25000 : 6000)

    for (const shot of group.shots) {
      if (shot.tab !== undefined) {
        await page.locator(group.tabSelector).nth(shot.tab).click()
        // 切态后等面板重排 + 三维图层跟着换
        await page.waitForTimeout(has3d ? 6000 : 2500)
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

      await page.screenshot({ path: `${OUT}/${shot.file}.png`, timeout: 120000 })

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

const bad = failed || emptyShots.length || sameState.length
process.exit(bad ? 1 : 0)
