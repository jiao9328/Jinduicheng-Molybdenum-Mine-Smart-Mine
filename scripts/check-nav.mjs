/**
 * 顶栏导航巡检：确认**每一个** Tab 点下去都真的会跳转。
 *
 * 这条检查是为一个具体缺陷立的：规划中的 Tab 曾经没有 `path`，
 * 而点击处理是「没 path 就 return」——按钮看着可点（指针手型 + hover 高亮），
 * 点下去什么都不发生，也不报任何错，评审时会被当成页面坏了。
 * 现在 `NavItem.path` 已是必填（类型系统挡一道），但补页面时抄错地址
 * 仍然会退化成「跳到未登记模块」，所以把行为固化成回归检查。
 *
 * 期望值是**在脚本里写死**的，不是从 `config/nav.ts` 读的：
 * 前者是「顶栏应该长什么样」的规格，后者是被测代码。
 * 从被测代码反推期望值，改坏了也照样绿。
 *
 * 跑得快的原因：只等顶栏出现就开始点，不等三维场景渲染完
 * （那是 check-all-pages 的活）。每个 Tab 一次往返，8 个约二十秒。
 *
 * 用法：
 *   node scripts/check-nav.mjs [baseUrl]
 *   node scripts/check-nav.mjs --self-test      # 自证：故意写错规格，必须条条判红
 *
 * `--self-test` 的必要性见《补充件 3》§1.3：**一个从没见过它变红的检查不算证据**。
 * 自证模式把上面那份硬编码规格换成两条**必然错**的条目（一个不存在的 Tab 名、
 * 一个故意写错的目标路由），然后要求它们**全部判红**。只要有一条绿，
 * 就说明对应断言没有分辨力（例如「存在」检查退化成了恒真），脚本即失败。
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'

const SELF_TEST = process.argv.includes('--self-test')
const base = process.argv.filter((a) => !a.startsWith('--'))[2] || 'http://localhost:8787'

/**
 * [Tab 文案, 期望路由] —— 与 `config/nav.ts` 的 `HEADER_NAV_LEFT` / `HEADER_NAV_RIGHT`
 * 左右拼接后**逐项、按序**对应（脚本按 `.app-header__tab` 的 DOM 顺序取，不排序）。
 *
 * 名单沿革：补充件第 1、2 号曾按参考截图列出 13 项，其中 5 项在任何参考资料里
 * 都没有需求描述与页面设计。2026-09-12 用户指令「比《项目文档.docx》多了的
 * 功能、数据等删除」，这 5 项连同它们的占位页一并移除，顶栏收敛为 8 项，
 * **每一项都指向真实页面**。这覆盖了《补充件·第 3 号》§2.2 的「冻结」，
 * 理由与记录见 README §13。
 *
 * 左 5 + 右 3，顺序不能调换——脚本靠顺序对齐 DOM。
 */
const TABS = [
  // ---- 左：智慧生产系统 ----
  ['数字孪生', '/digital-twin'],
  ['智能监控', '/monitoring'],
  ['AI视频分析', '/emergency'],
  ['安全管理', '/safety'],
  ['设备管理', '/equipment'],
  // ---- 右：智慧经营系统 ----
  // 这四条曾经只指向两条路由（决策指挥与成本管理都写 /decision，
  // 统计报表与左栏的智能监控都写 /production），点进去是同一个页面。
  // 现在按「实时 / 历史 / 决策 / 成本」四分，各指一条独立路由。
  ['决策指挥', '/decision'],
  ['成本管理', '/cost'],
  ['统计报表', '/reports']
]

/** 顶栏第二行的静态分组标题：必须在、必须不可点 */
const GROUP_TITLES = ['智慧生产系统', '智慧经营系统']

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
// 页面现在默认要登录，会话由上面的 newLoggedInPage 注入（见 lib/session.mjs）

/** 回首页并等顶栏出现。不等三维——顶栏是应用外壳的一部分，出来得很快。 */
async function home() {
  await page.goto(base + '/#/', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForSelector('.app-header__tab', { timeout: 30000 })
  // Vue 渲染是异步的，DOM 出现后 class 才算稳定
  await page.waitForTimeout(300)
}

await home()

// 先卡一遍 Tab 总数：少了说明有 Tab 没渲染出来（比如 label 重复触发了 key 冲突）
const rendered = await page.$$eval('.app-header__tab', (els) => els.map((el) => el.textContent.trim()))

const checks = []
// 这一行量的是真实 DOM，与规格是否被自证替换无关，所以两种模式下都用真规格的长度
checks.push([`顶栏渲染出 ${TABS.length} 个 Tab（实为 ${rendered.length}）`, rendered.length === TABS.length])

// ---------- 第二行的系统分组标题 ----------
// 补充件第 1 号裁定它们是**静态展示项**，不是导航。
// 两条都要卡：① 在不在（它们曾误挂成导航项）② 点不点得动
//   （如果哪天又被写成 button，说明「误当导航」这个错又犯了一次）
const groups = await page.$$eval('.app-header__group', (els) =>
  els.map((el) => ({
    text: el.textContent.trim(),
    tag: el.tagName.toLowerCase(),
    side: el.classList.contains('app-header__group--left') ? 'left' : 'right',
    box: (() => {
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()
  }))
)

checks.push([`渲染出 2 个分组标题（实为 ${groups.length}）`, groups.length === 2])

for (const [side, expect] of [['left', GROUP_TITLES[0]], ['right', GROUP_TITLES[1]]]) {
  const got = groups.find((g) => g.side === side)
  checks.push([
    `${side === 'left' ? '左' : '右'}侧分组标题为「${expect}」（实为「${got?.text ?? '无'}」）`,
    got?.text === expect
  ])
  // 不是 button / a 才谈得上「静态」
  checks.push([
    `「${expect}」不是可交互元素（实为 <${got?.tag ?? '?'}>）`,
    got !== undefined && !['button', 'a'].includes(got.tag)
  ])
}

// 真去点一下：坐标点击绕过可命中性检查，直接验证「点了不会跳转」
for (const g of groups) {
  const hashBefore = await page.evaluate(() => location.hash)
  await page.mouse.click(g.box.x, g.box.y)
  await page.waitForTimeout(500)
  const hashAfter = await page.evaluate(() => location.hash)
  checks.push([`点「${g.text}」不跳转（${hashBefore} → ${hashAfter}）`, hashBefore === hashAfter])
}

// 分组标题压在导航 Tab 上不算「静态展示」，那是布局事故。
// 顶栏只有 84px，第二行是硬挤出来的，最坏的情况就是和顶行的 Tab 叠在一起，
// 所以这里比一次矩形相交，不靠看截图。
const overlaps = await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.app-header__tab')].map((el) => el.getBoundingClientRect())
  const out = []
  for (const el of document.querySelectorAll('.app-header__group')) {
    const r = el.getBoundingClientRect()
    for (const t of tabs) {
      if (r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top) {
        out.push(el.textContent.trim())
        break
      }
    }
  }
  return out
})
checks.push([
  overlaps.length ? `分组标题与导航 Tab 重叠：「${overlaps.join('、')}」` : `分组标题与导航 Tab 无重叠`,
  overlaps.length === 0
])

// ---------- 逐个 Tab：点下去必须真的换路由 ----------
const tabCheckStart = checks.length

/**
 * 自证模式下换成两条**必然错**的规格。
 *
 * 注意它们不是「随便写两条」，而是分别打中两类断言的软肋：
 * - `phantom`     打「Tab 存在」——若找不到元素就 continue，断言是否真的记了红？
 * - `wrong-path`  打「跳转目标」——Tab 确实存在、也真的跳了，只是跳去了别处，
 *                 这一条才是「点了没反应」之外最容易漏判的退化（抄错地址）。
 */
const specTabs = SELF_TEST
  ? [
      ['不存在的模块', '/nowhere'],
      ['智能监控', '/digital-twin'] // 真实目标 /monitoring，故意写错
    ]
  : TABS

/** 每个 Tab 点完之后真的落在哪个地址上 —— 后面那条「互不相同」的判据要用 */
const navigated = []

for (const [label, expectedPath] of specTabs) {
  await home()

  const btn = page.locator('.app-header__tab', { hasText: label }).first()
  if ((await btn.count()) === 0) {
    checks.push([`「${label}」存在`, false])
    continue
  }

  // 关键：点下去必须真的换路由。「点了没反应」就是这个脚本要卡住的退化
  const before = await page.evaluate(() => location.hash)
  await btn.click()
  let moved = true
  try {
    await page.waitForFunction((p) => location.hash.replace(/^#/, '') === p, expectedPath, {
      timeout: 8000
    })
  } catch {
    moved = false
  }
  const after = await page.evaluate(() => location.hash)
  navigated.push({ label, after })

  checks.push([
    moved ? `「${label}」→ ${expectedPath}` : `「${label}」→ ${expectedPath}（点了没跳到，停在 ${after}）`,
    moved
  ])
}

/**
 * 八个 Tab 必须落到**八个互不相同**的地址上。
 *
 * 这一条是用户最初那句抱怨的回归判据：「智能监控和统计报表一模一样，
 * 决策指挥和成本管理一模一样」。根因不是一个页面抄了另一个页面的图，
 * 而是 `nav.ts` 里四条 Tab 只写了**两条** path —— 两个 Tab 点进去
 * 物理上就是同一个组件，而且顶栏高亮判的是 `route.path === item.path`，
 * 所以点「统计报表」时「智能监控」**会同时亮**。
 *
 * 上面那条逐 Tab 的断言只证明「点了会跳、跳到的地址对」；
 * 两条 Tab 写同一个 path 时它照样全绿（两边都「跳对了」）。
 * 所以这条判据**不能省**，它判的是「互不相同」这件事本身。
 */
const landed = navigated.map((n) => n.after).filter(Boolean)
const dupes = landed.filter((p, i) => landed.indexOf(p) !== i)
checks.push([
  dupes.length
    ? `有 Tab 落到了同一个路由：${[...new Set(dupes)].join('、')}（重复的 Tab 点进去是同一个页面）`
    : `${landed.length} 个 Tab 落到 ${new Set(landed).size} 个互不相同的路由`,
  landed.length > 0 && dupes.length === 0
])

await browser.close()

console.log('\n' + '='.repeat(64))
for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`)
console.log('='.repeat(64))

if (SELF_TEST) {
  // 自证模式退出码语义**与常规相反**：这里要的正是「判红」。
  // 如果这些故意写错的规格被判绿，说明断言本身没有分辨力——那才是失败。
  const tabChecks = checks.slice(tabCheckStart)
  const wronglyGreen = tabChecks.filter(([, ok]) => ok)
  if (!tabChecks.length) {
    console.log('\n✗ 自证失败：自证模式下一条 Tab 断言都没跑，断言组是空的')
    process.exit(1)
  }
  for (const [name] of wronglyGreen) console.log(`\n✗ 自证失败：故意写错的规格「${name}」被判绿，该断言没有分辨力`)
  if (wronglyGreen.length) process.exit(1)
  console.log(`\n✓ 自证通过：${tabChecks.length} 条故意写错的规格全部判红，Tab 断言有分辨力`)
  process.exit(0)
}

const failed = checks.filter(([, ok]) => !ok)
if (failed.length) console.log(`\n✗ ${failed.length}/${checks.length} 项不通过`)
else console.log(`\n✓ ${checks.length} 项全部通过`)
process.exit(failed.length ? 1 : 0)
