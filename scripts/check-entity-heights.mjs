/**
 * 面实体高程巡检：`src/` 与 `scripts/` 里每个 `polygon` / `ellipse` / `wall` 块，
 * 都必须**显式声明自己落在哪个高程上**——`polygon` / `ellipse` 用 `height`、
 * `perPositionHeight` 或 `heightReference`（或走登记在册的封装函数），
 * `wall` 用 `minimumHeights`（下沿）。
 *
 * ── 为什么要它 ──
 * Cesium 把「高程没写」这件事**默认成了海拔 0**，一声不响：
 *   `PolygonGeometry` 构造函数第一句就是 `let height = options.height ?? 0.0`
 *   （`@cesium/engine/Source/Core/PolygonGeometry.js:701`）
 * 而 `perPositionHeight` 默认 false——于是环上带的高程**整段被忽略**，
 * 面建在海拔 0，也就是采场底下 1300 多米。
 * 还有一处更绕的：`PolygonGeometryUpdater` 里
 *   `if (defined(extrudedHeightValue) && !defined(heightValue)) heightValue = 0`
 * 只写 `extrudedHeight` 的块体会从**海拔 0** 挤到 extrudedHeight 那么高，
 * 顶面比台地低出上百米。
 * `wall` 是同一个坑的另一张脸：只写 `positions` 时下沿被补成 0.0——
 *   `cleanedBottomHeights[0] = 0.0`（`@cesium/engine/Source/Core/WallGeometryLibrary.js:51-52`，
 *    没给 `minimumHeights` 的分支）
 * 于是每面墙都从椭球面拉到自己的高程，多出上千米埋在地下的面。
 * 它们都不报错、不告警，`entities.getById()` 照拿不误，
 * 渲染出来看着「有东西」，只是东西在地下——这就是「模型跑到底图下面去了」。
 *
 * ── 判据（全部写死在脚本里，不读被测代码的常量）──
 * ① `polygon` 块必须有 `height` 或 `perPositionHeight` 或 `heightReference`；
 * ② 有 `extrudedHeight` 时同样必须有上面三者之一（否则被补成 height=0）；
 * ③ 只写 `perPositionHeight: true`、没有 `extrudedHeight` 的，走的是
 *    `CoplanarPolygonGeometry`——那条路把环投影到拟合平面上再摊平，
 *    非共面的环（沿山坡起伏的皮带廊、溜槽、坑内道路）会**被摊歪且不报错**；
 * ④ `ellipse` 块必须有 `height` 或 `heightReference`
 *    （贴地椭圆靠 `CLAMP_TO_GROUND` 才算落在地表上）；
 * ⑤ `wall` 块必须有 `minimumHeights`——它是下沿，缺了就落到海拔 0（见上）。
 *
 * ── 豁免与登记 ──
 * 1. `height-scan:ignore` 出现在行内则整行跳过，且每次运行都会报出豁免了几行。
 * 2. `OK_HELPERS`：把「必须显式给高程」这条规矩封装好的构造函数。写新封装
 *    就来这里登记一行——**登记即承诺**：函数体里确实给足了上述三个字段之一。
 *
 * ── 它抓不到什么（如实写在这里，免得下次高估它）──
 * 1. 高程值算错（比如本该 1375 写成 0）：它只管「有没有显式声明」，不管数值对不对。
 *    数值要靠 `check-terrain-levels` / 实景量测那一路去对。
 * 2. 封装函数体里的实现：`flatPolygon` 内部如果哪天不写 height 了，这里看不出来。
 *    它管的是调用点。
 * 3. 注释与字符串里的 `polygon: {`：整段抹平后不参与匹配——**这是故意的**，
 *    本文件头部就写着 `polygon: {` 字样。
 *
 * 用法：node scripts/check-entity-heights.mjs [--self-test]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 把「显式高程」封装好的构造函数：见到它们就算过（见文件头「登记」） */
const OK_HELPERS = ['flatPolygon', 'beltPolygon']

/** 判定用的关键字。**必须带 `:`**——`extrudedHeight:` 里的 `Height` 不能算数 */
const KEY_HEIGHT = /\bheight\s*:/
const KEY_PERPOS = /\bperPositionHeight\s*:/
const KEY_REF = /\bheightReference\s*:/
const KEY_EXTRUDE = /\bextrudedHeight\s*:/
const PERPOS_TRUE = /\bperPositionHeight\s*:\s*true\b/
const KEY_MIN_H = /\bminimumHeights\s*:/

// ---------------------------------------------------------------------------
// 扫描：先把注释与字符串抹平（保持字符偏移不变），再按括号配对取块
// ---------------------------------------------------------------------------
export function mask(text) {
  const out = [...text]
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/') {
      const e = text.indexOf('\n', i)
      const to = e === -1 ? text.length : e
      blank(i, to)
      i = to
      continue
    }
    if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2)
      const to = e === -1 ? text.length : e + 2
      blank(i, to)
      i = to
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === c) break
        j++
      }
      blank(i, Math.min(j + 1, text.length))
      i = j + 1
      continue
    }
    i++
  }
  return out.join('')
}

/** `{` 与其配对 `}` 之间的块内文本（masked 已抹平注释/字符串，括号保证配平） */
function blockBody(masked, openIdx) {
  let depth = 0
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === '{') depth++
    else if (masked[i] === '}') {
      depth--
      if (depth === 0) return masked.slice(openIdx + 1, i)
    }
  }
  return masked.slice(openIdx + 1)
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

/**
 * 扫一段源码，返回 { hits, 面实体数, 豁免行数 }。
 * 每个 hit：{ line, kind, why, snippet }
 */
export function scanText(text) {
  const masked = mask(text)
  const rawLines = text.split('\n')
  const hits = []
  let 面实体数 = 0
  let 豁免 = 0
  const re = /\b(polygon|ellipse|wall)\s*:\s*\{/g
  let m
  while ((m = re.exec(masked))) {
    const kind = m[1]
    const line = lineOf(text, m.index)
    if ((rawLines[line - 1] ?? '').includes('height-scan:ignore')) {
      豁免++
      continue
    }
    面实体数++
    const body = blockBody(masked, re.lastIndex - 1)
    const 走了封装 = OK_HELPERS.some((h) => body.includes(`${h}(`))
    const 有高 = KEY_HEIGHT.test(body) || KEY_PERPOS.test(body) || KEY_REF.test(body)
    const 有挤出 = KEY_EXTRUDE.test(body)
    const snippet = (rawLines[line - 1] ?? '').trim().slice(0, 90)

    if (kind === 'wall') {
      if (!KEY_MIN_H.test(body)) {
        hits.push({
          line,
          kind,
          why: 'wall 没写 minimumHeights —— 下沿被补成 0.0（椭球面），整面墙从海拔 0 拉上来',
          snippet
        })
      }
      continue
    }

    if (kind === 'ellipse') {
      if (!KEY_HEIGHT.test(body) && !KEY_REF.test(body)) {
        hits.push({
          line,
          kind,
          why: 'ellipse 既没有 height 也没有 heightReference —— 会平铺在海拔 0',
          snippet
        })
      }
      continue
    }

    if (!有高 && !走了封装) {
      hits.push({
        line,
        kind,
        why: 有挤出
          ? 'polygon 只写了 extrudedHeight：更新器会把 height 补成 0，块体从海拔 0 起挤 —— 顶面比该在的位置低上百米'
          : 'polygon 既没有 height 也没有 perPositionHeight —— 环上的高程被忽略，面建在海拔 0',
        snippet
      })
      continue
    }
    if (!走了封装 && !KEY_EXTRUDE.test(body) && PERPOS_TRUE.test(body)) {
      hits.push({
        line,
        kind,
        why: 'polygon 只写 perPositionHeight（无 extrudedHeight）会走 CoplanarPolygonGeometry，非共面的环被摊平且不报错 —— 沿坡起伏的长条请用 beltPolygon',
        snippet
      })
    }
  }
  return { hits, 面实体数, 豁免 }
}

// ---------------------------------------------------------------------------
// 自证：合成样本。样本以字符串形式写在本文件里，而 mask() 会把字符串抹平，
// 所以这些样本不会被本脚本自己扫出来（不需要豁免标记）。
// ---------------------------------------------------------------------------
const SELF_TEST_CASES = [
  {
    name: '正例①·裸 polygon（环上带高程但没写 height）',
    text: 'polygon: {\n  hierarchy: new Cesium.PolygonHierarchy(ringAt(outline, 1370))\n}',
    expect: 1
  },
  {
    name: '正例②·只写 extrudedHeight',
    text: 'polygon: {\n  hierarchy: h,\n  extrudedHeight: bottom\n}',
    expect: 1
  },
  {
    name: '正例③·只写 perPositionHeight 的带状面',
    text: 'polygon: {\n  hierarchy: ribbonRing(path, 5, hs),\n  perPositionHeight: true\n}',
    expect: 1
  },
  {
    name: '正例④·ellipse 没写高程',
    text: 'ellipse: {\n  semiMajorAxis: 400,\n  semiMinorAxis: 400,\n  material: Cesium.Color.RED\n}',
    expect: 1
  },
  {
    name: '反例①·写了 height',
    text: 'polygon: {\n  hierarchy: h,\n  height: 1370\n}',
    expect: 0
  },
  {
    name: '反例②·height + extrudedHeight 成对出现',
    text: 'polygon: {\n  hierarchy: h,\n  height: bottom,\n  extrudedHeight: top\n}',
    expect: 0
  },
  {
    name: '反例③·走登记过的封装',
    text: 'polygon: {\n  ...flatPolygon(outline, top + 0.12),\n  material: x\n}',
    expect: 0
  },
  {
    name: '反例④·实测逐点高度 + 挤出（beltPolygon 的展开式）',
    text: 'polygon: {\n  hierarchy: h,\n  perPositionHeight: true,\n  extrudedHeight: 1200\n}',
    expect: 0
  },
  {
    name: '反例⑤·贴地椭圆',
    text: 'ellipse: {\n  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND\n}',
    expect: 0
  },
  {
    name: '反例⑥·注释与文档里的写法不该被当成代码',
    text: '// polygon: { hierarchy: h }\n/**\n * polygon: {\n *   perPositionHeight: true\n * }\n */\nconst ok = 1',
    expect: 0
  },
  {
    name: '反例⑦·extrudedHeight 里的 Height 不算 height（词边界要管住）',
    text: 'polygon: {\n  extrudedHeight: 1200,\n  heightReference: Cesium.HeightReference.NONE\n}',
    expect: 0
  },
  {
    name: '正例⑤·名字像封装但没登记的函数不该放过',
    text: 'polygon: {\n  ...someOtherPolygon(outline, 1370)\n}',
    expect: 1
  },
  {
    name: '正例⑥·wall 只写 positions（下沿被补成 0）',
    text: 'wall: {\n  positions: [a, b, c, d],\n  material: m\n}',
    expect: 1
  },
  {
    name: '正例⑦·wall 只写 maximumHeights（没写 minimumHeights，下沿仍是 0）',
    text: 'wall: {\n  positions: ps,\n  maximumHeights: tops\n}',
    expect: 1
  },
  {
    name: '反例⑧·wall 写了 minimumHeights',
    text: 'wall: {\n  positions: ps,\n  minimumHeights: bots,\n  maximumHeights: tops\n}',
    expect: 0
  },
  {
    name: '反例⑨·wall 带豁免标记的整行跳过',
    text: 'wall: {   // height-scan:ignore 下沿本来就是椭球面\n  positions: ps\n}',
    expect: 0
  }
]

function selfTest() {
  let bad = 0
  console.log('=== 自证：合成样本 ===')
  for (const c of SELF_TEST_CASES) {
    const got = scanText(c.text).hits.length
    const ok = got === c.expect
    if (!ok) bad++
    console.log(`  ${ok ? '✓' : '✗'} ${c.name}`)
    if (!ok) console.log(`      期望报 ${c.expect} 处，实际报 ${got} 处：${scanText(c.text).hits.map((h) => h.why).join(' / ')}`)
  }
  console.log(bad ? `\n✗ 自证 ${bad}/${SELF_TEST_CASES.length} 项不通过` : `\n✓ 自证 ${SELF_TEST_CASES.length} 项全过`)
  return bad
}

// ---------------------------------------------------------------------------
if (process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 1 : 0)
}

const ROOTS = ['src', 'scripts']
const EXT_RE = /\.(ts|vue|mjs|js)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', '.snapshots', '.git'])

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(join(dir, e.name), out)
    } else if (EXT_RE.test(e.name)) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

const files = ROOTS.flatMap((r) => {
  try {
    return statSync(r).isDirectory() ? walk(r) : []
  } catch {
    return []
  }
})

const scanned = files.map((f) => ({ f, ...scanText(readFileSync(f, 'utf8')) }))
const hits = scanned.flatMap((s) => s.hits.map((h) => ({ f: s.f, ...h })))
const 总数 = scanned.reduce((n, s) => n + s.面实体数, 0)
const 豁免 = scanned.reduce((n, s) => n + s.豁免, 0)

console.log(`扫描 ${files.length} 个文件（${ROOTS.join('/')}，跳过 node_modules/dist/.snapshots）`)
console.log(
  `判据：polygon / ellipse 显式落在某个高程上（height / perPositionHeight / heightReference，或走 ` +
    `${OK_HELPERS.join(' / ')}）；wall 必须写 minimumHeights`
)
console.log(`共查到面实体与墙 ${总数} 个；height-scan:ignore 豁免 ${豁免} 行`)
console.log('')

if (!hits.length) {
  console.log('✓ 没有「没写高程、默认落在海拔 0」的面实体与墙')
  process.exit(0)
}

for (const h of hits) {
  console.log(`✗ ${h.f}:${h.line}　${h.why}`)
  console.log(`    ${h.snippet}`)
}
console.log(
  `\n✗ ${hits.length} 处面实体/墙的高程没交代清楚。` +
    `\n  修法不是随手补个 0，而是照它的用途选一个：` +
    `\n  ① 平置的面（台地硬化面、坑底、台阶面、水体）→ \`...flatPolygon(经纬度环, 高程)\`；` +
    `\n  ② 沿地形起伏的长条（皮带廊、溜槽、坑内道路、坡屋面）→ \`...beltPolygon(逐点高度的环)\`；` +
    `\n  ③ 从底面挤到顶面的块体（台地实体块）→ \`height: 底, extrudedHeight: 顶\`，两个都要写；` +
    `\n  ④ 墙与「用墙当四边形用」的面片 → \`minimumHeights: [下沿, ...]\`（每点一个，与 positions 等长）。` +
    `\n  （README 第 13 节第 20 条）`
)
process.exit(1)
