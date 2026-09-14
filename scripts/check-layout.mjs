/**
 * 布局体检：在各分辨率下检查大屏是否居中、有无空白与裁切。
 *
 * 判据在 `判()` 里（纯函数，`--self-test` 直接喂合成量测）：画布必须存在，
 * 四边不许出窗口，上下留白不许超过 8px。**有退出码**——原来这份脚本把
 * `issues` 算出来只打印、从不 `process.exit(1)`，无论多离谱都是绿，
 * 与第十三节第 23 条那具「永远绿的壳」同一种毛病。
 *
 * 用法：node scripts/check-layout.mjs [url] [--self-test]
 */
import { chromium } from 'playwright'

/** 上下留白上限（px）。原判据就是 `> 8`，这里只是给它一个名字。 */
export const 留白上限 = 8

/**
 * 判据（纯函数）。`量` = { win: [W,H], scaled: {top,left,w,h} | null }
 * 返回违规说明数组，空数组 = 通过。
 *
 * 「画布找不到」判违规是**防假绿**：原来的写法是 `if (r.scaled) { …判四边… }`，
 * 画布没了就没有任何一条判据被求值，这一档分辨率**静默判绿**——
 * 大屏整个没挂上的时候，恰恰是这个检查最该红的时候。
 */
export function 判(量) {
  const 违规 = []
  const [vw, vh] = 量.win || [0, 0]
  if (!量.scaled) {
    违规.push('找不到 .scale-screen__canvas——大屏画布没挂上，这一档等于没量')
    return 违规
  }
  const { top, left, w, h } = 量.scaled
  const bottom = top + h
  const right = left + w
  if (top < -0.5) 违规.push(`顶部裁切 ${-top}px`)
  if (bottom > vh + 0.5) 违规.push(`底部裁切 ${Math.round(bottom - vh)}px`)
  if (left < -0.5) 违规.push(`左侧裁切 ${-left}px`)
  if (right > vw + 0.5) 违规.push(`右侧裁切 ${Math.round(right - vw)}px`)
  const 留白 = Math.round(top) + Math.round(vh - bottom)
  if (留白 > 留白上限) 违规.push(`上下留白共 ${留白}px`)
  return 违规
}

// ---------------------------------------------------------------------------
// 自证：合成的量测（不连浏览器）
// ---------------------------------------------------------------------------
/** 画布铺满整窗的合成量测 */
const 铺满 = (W, H) => ({ win: [W, H], scaled: { top: 0, left: 0, w: W, h: H } })

export const 自证样本 = [
  { name: '正例·1920×1080 恰好铺满', 量: 铺满(1920, 1080), 应报: 0 },
  {
    // 阈值本身就是判据：8px 是允许的，9px 才报——写反了这里会先红
    name: '反例·上下留白正好 8px（阈值内，不许报）',
    量: { win: [1920, 1080], scaled: { top: 4, left: 0, w: 1920, h: 1072 } },
    应报: 0
  },
  {
    name: '正例·上下留白 30px',
    量: { win: [1920, 1080], scaled: { top: 15, left: 0, w: 1920, h: 1050 } },
    应报: 1
  },
  {
    name: '正例·顶部裁切',
    量: { win: [1920, 1080], scaled: { top: -40, left: 0, w: 1920, h: 1180 } },
    应报: 1
  },
  {
    name: '正例·底部裁切',
    量: { win: [1920, 1080], scaled: { top: 0, left: 0, w: 1920, h: 1200 } },
    应报: 1
  },
  {
    name: '正例·左侧裁切',
    量: { win: [1920, 1080], scaled: { top: 0, left: -12, w: 1932, h: 1080 } },
    应报: 1
  },
  {
    name: '正例·右侧裁切',
    量: { win: [1920, 1080], scaled: { top: 0, left: 0, w: 1950, h: 1080 } },
    应报: 1
  },
  {
    // 防假绿守卫：画布整个没挂上时，四边判据一条都不会被求值
    name: '正例·画布缺失（原来会静默判绿）',
    量: { win: [1920, 1080], scaled: null },
    应报: 1
  },
  {
    // 超宽拼接屏：画布按高度铺满、左右留黑边是设计内的，只卡上下
    name: '反例·3840×1080 超宽屏居中（左右黑边不算问题）',
    量: { win: [3840, 1080], scaled: { top: 0, left: 960, w: 1920, h: 1080 } },
    应报: 0
  }
]

function 自证() {
  let 坏 = 0
  console.log('=== 自证：合成的量测 ===')
  for (const c of 自证样本) {
    const 违规 = 判(c.量)
    const 报了几条 = 违规.length
    const ok = c.应报 === 0 ? 报了几条 === 0 : 报了几条 > 0
    if (!ok) 坏++
    console.log(`  ${ok ? '✓' : '✗'} ${c.name}`)
    if (!ok) {
      console.log(
        `      期望${c.应报 === 0 ? '不报' : '报红'}，实际报出 ${报了几条} 条：${违规.join('；') || '（无）'}`
      )
    }
  }
  console.log(坏 ? `\n✗ 自证 ${坏}/${自证样本.length} 项不通过` : `\n✓ 自证 ${自证样本.length} 项全过`)
  return 坏
}

if (process.argv.includes('--self-test')) {
  process.exit(自证() ? 1 : 0)
}

// ---------------------------------------------------------------------------
const base = (process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] || 'http://localhost:4173').replace(/\/$/, '')

const SIZES = [
  [1920, 1080, '设计稿尺寸'],
  [1600, 900, '16:9 小屏'],
  [2560, 1440, '16:9 大屏'],
  [1920, 950, '矮屏（浏览器工具栏占位）'],
  [1366, 768, '笔记本'],
  [3840, 1080, '超宽拼接屏']
]

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=3072']
})

const 全部违规 = []

for (const [W, H, label] of SIZES) {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  // 本平台没有登录，直接进页面（登录 + 权限体系已移除，见 README §13）
  await page.goto(base + '/#/', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(14000)

  const r = await page.evaluate(() => {
    const q = (sel) => {
      const e = document.querySelector(sel)
      if (!e) return null
      const b = e.getBoundingClientRect()
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }
    }
    const canvas = document.querySelector('.scale-screen__canvas')
    const cr = canvas?.getBoundingClientRect()
    return {
      win: [window.innerWidth, window.innerHeight],
      scaled: cr ? { top: Math.round(cr.top), left: Math.round(cr.left), w: Math.round(cr.width), h: Math.round(cr.height) } : null,
      header: q('.app-header'),
      plan: q('.overview__plan'),
      minis: q('.overview__minis'),
      sideLeft: q('.overview__side--left'),
      sideRight: q('.overview__side--right'),
      docOverflow: document.documentElement.scrollHeight - window.innerHeight
    }
  })

  const issues = 判(r)

  console.log(
    `${label} ${W}x${H}: ` +
      `画布 ${r.scaled ? `${Math.round(r.scaled.w)}x${Math.round(r.scaled.h)} @(${r.scaled.left},${r.scaled.top})` : '缺失'} | ` +
      `计划卡 ${r.plan ? `top=${r.plan.top}` : '缺失'} | ` +
      `底部图表 ${r.minis ? `bottom=${r.minis.bottom}` : '缺失'} | ` +
      (issues.length ? `⚠ ${issues.join('，')}` : '正常')
  )

  for (const m of issues) 全部违规.push(`${label} ${W}x${H}：${m}`)

  // 截图只留设计稿尺寸那一档。原来写的是 `W === 1920`，把「矮屏 1920×950」
  // 也算进去了，两档写同一个文件、后一张覆盖前一张。
  if (label === '设计稿尺寸') {
    await page.screenshot({ path: '.snapshots/_layout_1920x1080.png' })
  }
  await page.close()
}

await browser.close()

if (全部违规.length) {
  console.error(`\n✗ ${全部违规.length} 处布局问题：`)
  for (const m of 全部违规) console.error(`   ${m}`)
  process.exit(1)
}
console.log(`\n✓ ${SIZES.length} 档分辨率全部正常`)
