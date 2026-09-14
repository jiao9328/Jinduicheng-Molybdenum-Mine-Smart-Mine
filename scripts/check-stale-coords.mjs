/**
 * 陈旧坐标巡检：把 `src/` 与 `scripts/` 里所有经纬度字面量揪出来，
 * 凡是**离采坑中心 5km 以外**的一律点名。
 *
 * ── 为什么要它 ──
 * README 第 13 节第 17 条记了「换矿区会漏掉脚本里的坐标，而漏掉的样子和正常一样」，
 * 当时的搜法是手打一条 grep（`35.1[0-9]|35.2[0-9]|109.96[0-9][0-9]`）——
 * **它只能搜出一开始那个矿区的坐标**。
 * 2026-09-13 就抓到反例：`scripts/probe-framing.mjs` 写死在 (113.1015, 37.2015)，
 * 一个 429km 外、画面上根本不存在的位置，那条 grep 一个字都搜不到。
 * 它照旧打印「采坑中心 (x, y)」这类数字，**看着像模像样，其实全是无意义的**。
 *
 * 所以这里反过来判：不猜「可能是哪一套旧坐标」，而是要求
 * **所有坐标都必须落在当前矿区附近**。换矿区、搬厂区、复制别的项目的代码，
 * 三种情况都会在这里现形。
 *
 * ── 判据 ──
 * 采坑中心 `MINE_CENTER` 到 5km 以外 → 报红。
 * 采坑与厂址实测相距约 1.3km，5km 留了 3 倍余量：既不误报当前矿区，
 * 又能拦住「另一套坐标系统」——那种错误动辄几百公里。
 *
 * ── 它抓不到什么（如实写在这里，免得下次高估它）──
 * 1. **同一区域内写错的坐标**：厂址从谷东头挪到西头 200m，它照样放过。
 *    这类只能靠「从 `mineLayout` 推导」来防，防不了就靠人看——本脚本无分辨力。
 * 2. **注释行里的坐标**：以 `*` `//` `/*` `<!--` 开头的行整行跳过
 *    （`verify-alignment.mjs` 的注释里就留着澄城老矿的坐标当史料，那是**故意留的**）。
 *    代价是代码里跟在 `//` 后面的行尾注释也一并跳过。
 * 3. 经纬度**分处 ±2 行以内**才会被凑成一对；隔着三行以上写的坐标对搜不到。
 * 4. 只搜 `src/` 与 `scripts/`，不搜 README 与 `参考/`（那些地方本来就该写历史坐标）。
 *
 * ── 豁免 ──
 * 行内出现 `coord-scan:ignore` 的整行跳过。**只有一处合法用途**：
 * 本脚本自己的自证样本——那些样本**必须**写着旧坐标，否则没法证明它抓得到。
 * 豁免是显式的、可 grep 的，且每次运行都会报出「豁免了几行」，
 * 免得它慢慢变成一摞看不见的例外。写业务代码时想用它，先想清楚是不是在掩盖问题。
 *
 * ⚠️ `MINE_CENTER` 是**写死**的，不从 `src/` 读——脚本去读被测代码的常量，
 * 两边一起改就永远绿了（本项目的规矩）。换矿区时这一个常量要跟着改。
 *
 * 用法：node scripts/check-stale-coords.mjs [--self-test]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 采坑中心（与 `scene/mineLayout.ts` 的 `PIT` 同值，故意写死，见文件头） */
const MINE_CENTER = [109.9538, 34.3308]
const THRESHOLD_KM = 5
/** 经纬度相隔几行以内算「同一个坐标对」 */
const LINE_WINDOW = 2

const M_PER_LON = 111320 * Math.cos((MINE_CENTER[1] * Math.PI) / 180)
const M_PER_LAT = 110574

/** 经度候选：100~199.xx（中国经度 73~135，取一段足够宽的） */
const LON_RE = /\b(1[0-9]{2}\.[0-9]{2,})\b/g
/** 纬度候选：20~59.xx */
const LAT_RE = /\b([2-5][0-9]\.[0-9]{2,})\b/g

const distKm = (lon, lat) =>
  Math.hypot((lon - MINE_CENTER[0]) * M_PER_LON, (lat - MINE_CENTER[1]) * M_PER_LAT) / 1000

const COMMENT_RE = /^(\*|\/\/|\/\*|<!--)/
const isCommentLine = (ln) => COMMENT_RE.test(ln.trim())
const WAIVER_RE = /coord-scan:ignore/

/**
 * 扫一段文本，返回「离矿区 5km 以外」的坐标对，以及两类被跳过的行数。
 * 抽成独立函数是为了 `--self-test` 能拿合成样本喂它——不给它补一段它撑不住的断言，
 * 但也得能证明它**真的会红**（补充件 3 §1.3）。
 */
export function scanText(text, file = '<sample>') {
  const lines = text.split(/\r?\n/)
  const lons = []
  const lats = []
  let skippedComment = 0
  let skippedWaiver = 0

  lines.forEach((ln, i) => {
    if (WAIVER_RE.test(ln)) {
      skippedWaiver++
      return
    }
    if (isCommentLine(ln)) {
      skippedComment++
      return
    }
    for (const m of ln.matchAll(LON_RE)) lons.push({ v: Number(m[1]), line: i })
    for (const m of ln.matchAll(LAT_RE)) lats.push({ v: Number(m[0]), line: i })
  })

  const hits = []
  const seen = new Set()
  for (const la of lats) {
    for (const lo of lons) {
      if (Math.abs(lo.line - la.line) > LINE_WINDOW) continue
      const km = distKm(lo.v, la.v)
      if (km <= THRESHOLD_KM) continue
      const key = `${lo.line}:${lo.v}|${la.line}:${la.v}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({
        file,
        line: Math.min(lo.line, la.line) + 1,
        lon: lo.v,
        lat: la.v,
        km,
        text: (lines[lo.line] ?? '').trim().slice(0, 100)
      })
    }
  }
  return { hits, skippedComment, skippedWaiver }
}

// ---------------------------------------------------------------------------
// 自证：合成的样本 + 对照组
// ---------------------------------------------------------------------------
/**
 * 样本里的旧坐标是**故意**写着的——不写就没法证明这个脚本抓得到它们。
 * 因此每一条相关样本都带 `coord-scan:ignore` 豁免标记，本文件扫自己时靠它过关。
 */
const SELF_TEST_CASES = [
  {
    name: '对照组·采坑中心（本矿区，不许报）',
    text: 'const PIT = { lon: 109.9538, lat: 34.3308 }',
    expect: []
  },
  {
    name: '对照组·新厂址（本矿区，不许报）',
    text: 'export const PLANT_ORIGIN = [109.96772, 34.3345]',
    expect: []
  },
  {
    name: '对照组·跨行的对象（本矿区，不许报）',
    text: 'const bp = {\n  lon: 109.9538,\n  lat: 34.3308\n}',
    expect: []
  },
  {
    name: '正例·第三套坐标（probe-framing 改前的实际值）',
    text: 'project(113.1015, 37.2015, 0)', // coord-scan:ignore
    expect: [113.1015]
  },
  {
    name: '正例·澄城老矿',
    text: 'const c = { lon: 109.9485, lat: 35.1990 }', // coord-scan:ignore
    expect: [109.9485]
  },
  {
    name: '正例·跨行写的旧坐标',
    text: 'const wp = {\n  lon: 113.1015,\n  lat: 37.2015\n}', // coord-scan:ignore
    expect: [113.1015]
  },
  {
    name: '反例·注释行里的旧坐标（史料理应放过）',
    text: ' * 原先全部写死在 (109.9485, 35.1990)，现已改为从 mineLayout 推导', // coord-scan:ignore
    expect: []
  },
  {
    name: '反例·隔了 5 行的两个数不该凑成一对',
    text: 'const a = 113.1015\n\n\n\n\nconst b = 37.2015', // coord-scan:ignore
    expect: []
  },
  {
    name: '反例·带豁免标记的行应当整行跳过',
    text: 'project(113.1015, 37.2015, 0) // coord-scan:ignore',
    expect: []
  }
]

function selfTest() {
  let bad = 0
  console.log('=== 自证：合成样本 ===')
  for (const c of SELF_TEST_CASES) {
    const got = scanText(c.text).hits.map((h) => h.lon).sort()
    const want = [...c.expect].sort()
    const ok = got.length === want.length && got.every((v, i) => v === want[i])
    if (!ok) bad++
    console.log(`  ${ok ? '✓' : '✗'} ${c.name}`)
    if (!ok) console.log(`      期望报出 [${want}]，实际报出 [${got}]`)
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

const scanned = files.map((f) => ({ f, ...scanText(readFileSync(f, 'utf8'), f) }))
const hits = scanned.flatMap((s) => s.hits)
const skippedComment = scanned.reduce((n, s) => n + s.skippedComment, 0)
const skippedWaiver = scanned.reduce((n, s) => n + s.skippedWaiver, 0)

console.log(`扫描 ${files.length} 个文件（${ROOTS.join('/')}，跳过 node_modules/dist/.snapshots）`)
console.log(`判据：与采坑中心 (${MINE_CENTER[0]}, ${MINE_CENTER[1]}) 相距 > ${THRESHOLD_KM}km`)
// 豁免与注释跳过都要报出来：例外一旦看不见，就会慢慢长成一摞
console.log(`跳过：注释行 ${skippedComment} 行、coord-scan:ignore 豁免 ${skippedWaiver} 行`)
console.log('')

if (!hits.length) {
  console.log(`✓ 没有离矿区 ${THRESHOLD_KM}km 以外的坐标字面量`)
  process.exit(0)
}

hits.sort((a, b) => b.km - a.km)
for (const h of hits) {
  console.log(`✗ ${h.file}:${h.line}　距采坑 ${h.km.toFixed(1)}km　(${h.lon}, ${h.lat})`)
  console.log(`    ${h.text}`)
}
console.log(
  `\n✗ ${hits.length} 处坐标离矿区 ${THRESHOLD_KM}km 以外。` +
    `\n  这通常意味着：① 换了矿区/搬了厂区，某处的坐标没跟着改；` +
    `\n  ② 从别的项目复制过来的代码带进了它自己的坐标。` +
    `\n  修法不是改成本矿区的新坐标，而是**让它从 mineLayout 推导**——` +
    `\n  这样下次搬家它会自己跟着走（README 第 13 节第 17、19 条）。`
)
process.exit(1)
