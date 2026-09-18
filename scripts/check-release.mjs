/**
 * 发布前自检 —— 守住「下载解压就能跑」与「凭据不跟着产物上网」。
 *
 * ## 为什么需要一个脚本，而不是靠人记得
 *
 * 这两件事**都不会自己报错**，本地也看着一切正常：
 *
 * ── 一、产物与源码脱节 ──
 * `dist/` 现在随仓库分发（README「方式一：不装任何东西，直接跑」靠的就是它），
 * 但它是一张**快照**。改了 `src/` 不重新构建，别人下到的还是旧界面；更阴的是
 * vite 的产物文件名带内容哈希 —— 旧 `index.html` 指着旧 chunk，页面不是
 * 「少个功能」，而是以各种对不上号的方式坏掉，而**本地因为跑的是 dev 服务
 * 或新构建，一切正常**。
 *
 * ── 二、凭据被内联进产物 ──
 * vite 会把 `VITE_*` **构建时内联进产物**，而 `.env` 里就有
 * `VITE_CESIUM_ION_TOKEN`。于是「提交 dist/」与「提交 .env」在结果上是同一件事：
 * 本仓库第一次把构建产物纳入版本库时就真踩了这个坑 —— 令牌进了
 * `assets/cesium-*.js` 与 `assets/createViewer-*.js`。它没有报错、没有告警、
 * 肉眼也看不出来（那是个 300 字符的 JWT），只能逐个值去搜。
 *
 * ── 那次是事故，现在是决定 ──
 * 2026-09-18 起，`VITE_CESIUM_ION_TOKEN` **刻意**随包发布：Cesium Ion 令牌
 * 本来就是浏览器里用的（访客打开 devtools 就能读到），真正的防护是 Ion 后台的
 * **域名白名单**，不是把它藏起来。发布它是为了让下载者开箱就有实景三维。
 *
 * 所以这一组不再是「什么都不许进」，而是「**只有清单上的那个可以进**」——
 * 允许清单见 PUBLIC_BY_DESIGN。它只许装「供浏览器直接使用、且已在服务方后台
 * 做了来源限制」的令牌；`DUNER_LLM_KEY` 这种服务端密钥永远不许进去。
 * 这两条都有正向对照：漏了令牌 → 在线三维**静默**退回程序化场景（兜底是设计如此，
 * 所以不会报错，只会悄悄变差）；混进密钥 → 直接判红。
 *
 * ## 为什么检查「dist 过没过期」不用文件时间戳
 *
 * 时间戳在**新克隆的仓库里不可信**：git 按索引顺序逐个写文件，`dist/` 排在
 * `src/` 前面，于是刚 clone 下来 `src` 永远比 `dist` 「新」，一跑就误报。
 * 这里改用 git 自己的记录（见 C 组）：源码最后一次提交比产物新、或者
 * 源码有未提交改动而产物没有 —— 这两种才是真的脱节。
 *
 * ## 断言分组
 *
 *   A 下载者需要的东西齐不齐（缺一项就得先 npm install，路子一就废了）
 *   B `.gitignore` 有没有把它们挡在库外（本仓库自己就踩过：注释改成「入库」了，
 *     规则却还留着 `dist/`，一提交才发现什么都没进去）
 *   C dist 与源码有没有脱节
 *   D 凭据有没有混进产物（判据见下面的 findLeaks，带 --self-test）
 *   E 真起一次服务：零依赖起得来、种子自动就位、演示账号能登录
 *
 * 用法：
 *   node scripts/check-release.mjs              常规自检
 *   node scripts/check-release.mjs --self-test  只验 D 组的判据有没有分辨力
 *
 * 刻意**不依赖 node_modules、不依赖网络** —— 它检查的正是「一个没装依赖、
 * 没联网的人拿到这份仓库能不能跑起来」，自己当然不能靠它们。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

/* ---------- 共用小工具 ---------- */

/** 会被当成文本打进产物的几类扩展名。图片里塞不进 JWT，
   而 base64 内联进 JS 的那种也在 JS 里就被搜到了。 */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.svg', '.txt', '.map'])

const walk = (dir, out = []) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (TEXT_EXT.has(extname(e.name).toLowerCase())) out.push(p)
  }
  return out
}

/**
 * 在一批文本产物里找出被原样内联进去的凭据值。
 *
 * 抽成纯函数是为了能自证（`--self-test`）：喂合成样本进去，看它认不认得出来 ——
 * 一条「永远绿」的扫描和一个真的扫描，在正常仓库里长得一模一样。
 */
function findLeaks(files, secrets) {
  const leaks = []
  for (const [label, value] of secrets) {
    for (const f of files) {
      let text
      try {
        text = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      if (text.includes(value)) {
        leaks.push({ label, file: f })
        break
      }
    }
  }
  return leaks
}

/**
 * 允许随产物公开发布的变量 —— **白名单，只许装这一个**。
 *
 * `VITE_CESIUM_ION_TOKEN` 是 Cesium Ion 的访问令牌，浏览器里用，设计上就藏不住：
 * 它被内联进前端 bundle，任何访客打开 devtools 都能读到。正确的防护是在
 * Ion 后台给它配**域名白名单**（这样别人抄走也用不了），而不是假装它不存在。
 *
 * 本仓库从 2026-09-18 起刻意发布它，好让下载者 `node server/index.mjs`
 * 就有 Google 实景三维。要换成自己的，改 `.env` 即可。
 *
 * ⚠️ 往这个集合里加东西之前先问一句：**这个值被全世界看到，会怎样？**
 * 答不上来就别加。`DUNER_LLM_KEY` 就是反例 —— 它进了包等于公开，
 * 而且不会有任何报错：墩儿只是不再调用模型、静默退回规则引擎，
 * 功能"看着还是好的"。
 */
const PUBLIC_BY_DESIGN = new Set(['VITE_CESIUM_ION_TOKEN'])

/**
 * 把一份 `.env` 文本分成「可公开」与「必须保密」两类。
 *
 * 抽成纯函数是为了能自证：允许清单写错（比如手滑把 `DUNER_LLM_KEY` 也放进去）时，
 * 常规自检**照样全绿** —— 它只是少报一个泄漏而已。只有喂合成样本才看得出来。
 *
 * 短值（长度 < 16）一律丢弃：`true` / `/api` 这种满仓库都是，留着只会误报。
 */
function classifyEnv(text) {
  const secrets = []
  const publicValues = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const [, name, value] = m
    if (value.length < 16) continue
    ;(PUBLIC_BY_DESIGN.has(name) ? publicValues : secrets).push([name, value])
  }
  return { secrets, publicValues }
}

/* ---------- 自证：先证明 D 组的判据有分辨力，再谈它是不是绿的 ---------- */
if (process.argv.includes('--self-test')) {
  /* 造**形状与长度都像**真凭据的假值。刻意不读 .env：没配 .env 的人也得能跑自证，
     而且自证本身不该碰真凭据。 */
  const FAKE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.self-test-not-a-real-token-'.padEnd(96, 'A')
  const KEY = ('sk-' + 'self-test-not-a-real-key-'.repeat(3)).slice(0, 48)
  const ABSENT = 'a-value-that-is-in-no-sample-'.padEnd(64, 'B')

  /* ── 第一段：分类。这一段是这轮新加的 —— 允许清单是**新的失效方式**：
     清单里多一个名字，常规自检照样全绿，只是从此不再报那个值。 ── */
  const ENV_SAMPLE = [
    '# DUNER_LLM_KEY=' + KEY, // 注释掉的：不许被当成配置读进来
    'VITE_CESIUM_ION_TOKEN=' + FAKE,
    'DUNER_LLM_KEY=' + KEY,
    'VITE_SOMETHING_NEW=' + ABSENT, // 没见过的变量：默认按保密处理
    'VITE_USE_ONLINE_3D=true', // 短值：会被长度门槛滤掉
    'VITE_API_BASE_URL=/api', // 同上
    ''
  ].join('\n')
  const { secrets, publicValues } = classifyEnv(ENV_SAMPLE)
  const names = (list) => list.map(([n]) => n)

  /* ── 第二段：扫描。 ── */
  const dir = mkdtempSync(join(tmpdir(), 'mine-release-selftest-'))
  writeFileSync(join(dir, 'leaked.js'), `const key = "${KEY}"`) // 真该报的
  writeFileSync(join(dir, 'published.js'), `const token = "${FAKE}"`) // 已公开的，不该报
  writeFileSync(join(dir, 'clean.js'), 'const token = ""')
  writeFileSync(join(dir, 'image.png'), KEY) // 二进制：按设计不扫

  /* 只把「必须保密」那一类喂进去 —— 正是 D 组的接法 */
  const found = findLeaks(walk(dir), [...secrets, ['样本里没有的值', ABSENT]])
  const hitName = (n) => found.some((l) => l.label === n)

  const cases = [
    ['分类 正例 没见过的变量默认归入保密（默认保密，不是默认公开）', names(secrets).includes('VITE_SOMETHING_NEW')],
    ['分类 正例 DUNER_LLM_KEY 归入保密', names(secrets).includes('DUNER_LLM_KEY')],
    ['分类 正例 VITE_CESIUM_ION_TOKEN 归入可公开', names(publicValues).includes('VITE_CESIUM_ION_TOKEN')],
    ['分类 反例 注释行里的赋值不算配置', secrets.filter(([, v]) => v === KEY).length === 1],
    [
      '分类 反例 短值（true / /api）不许进任何清单，否则到处误命中',
      ![names(secrets), names(publicValues)].flat().some((n) => n === 'VITE_USE_ONLINE_3D' || n === 'VITE_API_BASE_URL')
    ],
    ['扫描 正例 保密值原样在 .js 里 → 必须报', hitName('DUNER_LLM_KEY')],
    ['扫描 反例 已公开的令牌在 .js 里 → 不许报（允许清单真的生效了）', !hitName('VITE_CESIUM_ION_TOKEN')],
    ['扫描 反例 同一个值只在 .png 里 → 不许报（二进制不在扫描范围）', !found.some((l) => l.file.endsWith('.png'))],
    ['扫描 反例 干净文件不许报', !found.some((l) => l.file.endsWith('clean.js'))],
    ['扫描 反例 样本里根本没有的值不许报（防乱报）', !hitName('样本里没有的值')]
  ]

  rmSync(dir, { recursive: true, force: true })

  console.log('='.repeat(64))
  for (const [name, ok] of cases) console.log(`${ok ? '✓' : '✗'} ${name}`)
  console.log('='.repeat(64))
  const bad = cases.filter(([, ok]) => !ok)
  if (bad.length) {
    console.log('\n✗ 自证失败：分类或扫描的判据没有分辨力')
    process.exit(1)
  }
  console.log(`\n✓ 自证通过：${cases.length} 条样本，该报的报、该放行的放行、该保密的没被放进公开清单`)
  process.exit(0)
}

/* ---------- 常规自检 ---------- */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PUBLIC = join(ROOT, 'public')
const SEED = join(ROOT, 'server', 'data', 'mine.seed.db')

const checks = []
const check = (name, ok, hint = '') => checks.push([name, ok, hint])

/** 同步跑一条 git 命令，返回 stdout（失败返回空串） */
const git = (args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

// ---------------------------------------------------------------------------
// A 组：下载者需要的东西在不在
// ---------------------------------------------------------------------------
/* 顺序即「缺了它会发生什么」的严重程度：前三项缺一个，路子一直接跑不起来；
   种子库缺了则四张台账是空的（能跑，但没有数据）。 */
const REQUIRED = [
  ['dist/index.html', join(DIST, 'index.html')],
  ['dist/assets/（前端 JS/CSS 产物）', join(DIST, 'assets')],
  ['public/cesium/Workers（Cesium Worker，运行时动态加载）', join(PUBLIC, 'cesium', 'Workers')],
  ['public/cesium/Assets（Cesium 贴图与地形资源）', join(PUBLIC, 'cesium', 'Assets')],
  ['server/data/mine.seed.db（种子基线）', SEED]
]
for (const [label, p] of REQUIRED) {
  check(`A 存在 ${label}`, existsSync(p), `缺这个：${p}`)
}

/* index.html 引用的产物必须一个不少。prod 构建会按内容哈希改名，手工删过
   dist/ 里某个 chunk、或者构建中途失败，都会留下一个「打得开、白屏」的产物 */
if (existsSync(join(DIST, 'index.html'))) {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
  const missing = refs
    .filter((r) => r.startsWith('./') || r.startsWith('/'))
    .map((r) => join(DIST, r.replace(/^\.?\//, '')))
    .filter((p) => !existsSync(p))
  check(
    `A index.html 引用的 ${refs.length} 个资源都在`,
    missing.length === 0,
    `缺：${missing.map((p) => p.slice(ROOT.length)).join('、')}`
  )
}

/* 种子库必须真有种子。空库不会报错 —— 下载者打开四张空台账，会以为是 bug */
if (existsSync(SEED)) {
  const db = new DatabaseSync(SEED, { readOnly: true })
  const TABLES = ['quality_records', 'duty_schedule', 'spare_parts', 'hazard_disposals']
  const counts = TABLES.map((t) => db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c)
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c
  db.close()
  check(
    `A 种子库四张台账都有数据（${counts.join(' / ')}）`,
    counts.every((c) => c > 0),
    '某张表是空的：db:seed 只灌了一部分，或种子库是在半途生成的'
  )
  check(`A 种子库里有演示账号（${users} 个）`, users >= 2, '没有账号则下载者登录不了')
} else {
  check('A 种子库四张台账都有数据', false, '种子库不存在，上面已判红')
  check('A 种子库里有演示账号', false, '种子库不存在，上面已判红')
}

// ---------------------------------------------------------------------------
// B 组：这三样别被 .gitignore 挡回去
// ---------------------------------------------------------------------------
/* 「提交了 dist」和「dist 在版本库里」是两回事：规则还在的话 git add 会静默跳过。
   本仓库改这一块时就真发生过一次 —— 注释改成了「现在入库」，规则却还留着。 */
for (const p of ['dist/index.html', 'public/cesium/Workers', 'server/data/mine.seed.db']) {
  const ignored = spawnSync('git', ['check-ignore', '-q', p], { cwd: ROOT }).status === 0
  check(`B ${p} 没有被 .gitignore 挡下`, !ignored, '规则还在：git add 会静默跳过它')
}

// ---------------------------------------------------------------------------
// C 组：dist 与源码有没有脱节
// ---------------------------------------------------------------------------
const SRC_PATHS = ['src/', 'public/', 'index.html', 'vite.config.ts']

/* C1 源码有未提交改动、而产物没有 —— 十有八九是改了源码忘了重新构建 */
const dirtySrc = git(['status', '--porcelain', '--', ...SRC_PATHS])
const dirtyDist = git(['status', '--porcelain', '--', 'dist/'])
check(
  'C 源码没有「改了却没重建」的未提交改动',
  !(dirtySrc && !dirtyDist),
  'src/ 有未提交改动而 dist/ 没有：要么忘了 npm run build，要么忘了 git add dist/'
)

/* C2 源码最后一次提交比产物新 —— 补上 C1 漏掉的那半：
   「src 与 dist 都已经提交，但分在两次提交里」这种情况 C1 看不见 */
const srcAt = Number(git(['log', '-1', '--format=%ct', '--', ...SRC_PATHS]) || 0)
const distAt = Number(git(['log', '-1', '--format=%ct', '--', 'dist/']) || 0)
const fmt = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '从未提交')
check(
  `C 产物不比源码旧（源码 ${fmt(srcAt)} / 产物 ${fmt(distAt)}）`,
  distAt >= srcAt,
  '最后一次改源码的提交比最后一次改产物的提交新：重新 npm run build 并提交 dist/'
)

// ---------------------------------------------------------------------------
// D 组：凭据有没有混进产物
// ---------------------------------------------------------------------------
/* `.env` 里的值分两类（分类规则见 classifyEnv）：可公开的与必须保密的。 */
const secrets = []
const publicValues = []
for (const file of ['.env', '.env.local']) {
  const p = join(ROOT, file)
  if (!existsSync(p)) continue
  const c = classifyEnv(readFileSync(p, 'utf8'))
  for (const [name, value] of c.secrets) secrets.push([`${file} 的 ${name}`, value])
  for (const [name, value] of c.publicValues) publicValues.push([`${file} 的 ${name}`, value])
}

const files = walk(DIST)

/* D1 保密值一个都不许进产物 —— 「`.env` 不能传上去」这句话的全部内容 */
const leaks = findLeaks(files, secrets)
check(
  `D .env 里 ${secrets.length} 个保密值都没进 dist/（扫了 ${files.length} 个文本产物）`,
  leaks.length === 0,
  `这些值被内联进产物了，提交上去等于公开：\n      ${leaks
    .map((l) => `${l.label} → ${l.file.slice(ROOT.length)}`)
    .join('\n      ')}\n` +
    '      修法：把它从构建里去掉。确属「浏览器要用、且已在服务方后台做了来源限制」的' +
    '令牌，才加进 PUBLIC_BY_DESIGN 并写清理由 —— 别为了让这条变绿而放宽它'
)

/* D2 正向对照：公开令牌**必须**在产物里。
   缺了它不会报错：online3d 会静默退回程序化场景，功能「看着还是好的」，
   下载者打开页面才发现实景三维没了 —— 正是本仓库最防的那类「不报错的错」。 */
if (publicValues.length) {
  const present = findLeaks(files, publicValues)
  check(
    `D 公开令牌确实在产物里（${publicValues.map(([l]) => l.split(' 的 ')[1]).join('、')}）`,
    present.length === publicValues.length,
    '令牌没被内联进 dist/：构建时 .env 没被读到，或被空值覆盖了。' +
      '在线三维会静默退回程序化场景、不报错。重新 npm run build 并提交 dist/'
  )
}

/* D3 模板里也得带着它 —— 下载者 `cp .env.example .env` 之后重建才拿得到。
   这条防的是一个真空洞：模板里令牌为空时，对方构建出的产物没有令牌，而本脚本
   在**他的机器上**会因为 .env 里没有长值而跳过 D2，**照样判绿**。 */
const EXAMPLE = join(ROOT, '.env.example')
if (existsSync(EXAMPLE)) {
  check(
    'D .env.example 里带着公开令牌（别人 cp 之后重建才不会静默丢掉它）',
    classifyEnv(readFileSync(EXAMPLE, 'utf8')).publicValues.length > 0,
    '.env.example 里的 VITE_CESIUM_ION_TOKEN 是空的：别人 cp 出来重建，' +
      '产物里就没有令牌了，而那时 D2 会被跳过、判绿'
  )
}

/* D4 `.env` 本身仍不许入库 —— 它除了公开令牌，还有 DUNER_LLM_KEY。
   `.env.example` 是模板，带着公开令牌，那是要入库的。 */
const envTracked = git(['ls-files', '--', '.env', '.env.local'])
check('D .env 没有被 git 跟踪（.env.example 是模板，可以入库）', envTracked === '', `已被跟踪：${envTracked}`)

// ---------------------------------------------------------------------------
// E 组：真起一次服务 —— 零依赖、种子自动就位、演示账号能登录
// ---------------------------------------------------------------------------
/* 端口随机挑一个，免得撞上正在跑的服务；库落在临时目录里，
   而且**刻意不先创建** —— 要验的正是「库不存在时服务会用种子基线初始化它」。 */
const pickPort = async () => {
  for (let i = 0; i < 12; i++) {
    const port = 8900 + Math.floor(Math.random() * 99)
    const ok = await new Promise((res) => {
      const srv = createServer()
      srv.once('error', () => res(false))
      srv.once('listening', () => srv.close(() => res(true)))
      srv.listen(port, '127.0.0.1')
    })
    if (ok) return port
  }
  return 0
}

const tmp = mkdtempSync(join(tmpdir(), 'mine-release-'))
const dbFile = join(tmp, 'mine.db')
const port = await pickPort()
const base = `http://127.0.0.1:${port}`

let child = null
let log = ''
if (!port) {
  check('E 零依赖起得来（node server/index.mjs）', false, '找不到空闲端口')
} else {
  child = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs'), '--port', String(port), '--db', dbFile], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))

  /* 等就绪：轮询 /api/health。后端是同步启动的，正常 1 秒内就绪；
     上限 15s，慢机器也够。 */
  let up = false
  for (let i = 0; i < 75 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200))
    try {
      up = (await fetch(`${base}/api/health`)).ok
    } catch {
      /* 还没起来，继续等 */
    }
  }

  check(
    'E 零依赖起得来（node server/index.mjs）',
    up,
    `15 秒内 /api/health 没通。服务端输出：\n${log.slice(-600)}`
  )

  if (up) {
    const home = await fetch(`${base}/`)
    const html = await home.text()
    check(
      'E 首页回的是真的前端页面',
      home.ok && /<div id="app"/.test(html),
      'index.html 到了但内容不对：dist/ 可能是构建中途的半成品'
    )

    /* 这一条是路子一的命门：库本来不存在，服务起来后它应该已经被种子填上了 */
    let seeded = false
    if (existsSync(dbFile)) {
      const db = new DatabaseSync(dbFile, { readOnly: true })
      seeded = db.prepare('SELECT COUNT(*) c FROM "quality_records"').get().c > 0
      db.close()
    }
    check('E 首次启动自动用种子库初始化了工作库', seeded, '库没建出来，或建出来是空的：种子库可能缺失')

    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    })
    const body = await res.json().catch(() => ({}))
    check(
      'E 演示账号 admin/admin123 能登录',
      res.ok && typeof body.token === 'string',
      `登录失败（HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}）：种子库里的账号对不上`
    )
  }
}

if (child) {
  child.kill()
  await new Promise((r) => setTimeout(r, 300))
  if (!child.killed) child.kill('SIGKILL')
}
rmSync(tmp, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(64))
for (const [name, ok, hint] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && hint) console.log(`    ${hint.split('\n').join('\n    ')}`)
}
console.log('='.repeat(64))

const failed = checks.filter(([, ok]) => !ok)
if (failed.length) {
  console.log(`\n✗ ${failed.length}/${checks.length} 项不通过 —— 这份仓库现在要么别人下下来跑不起来，要么会把凭据带出去。`)
  process.exit(1)
}
console.log(`\n✓ ${checks.length} 项全部通过 —— 下载 → 解压 → node server/index.mjs 可以直接跑。`)
