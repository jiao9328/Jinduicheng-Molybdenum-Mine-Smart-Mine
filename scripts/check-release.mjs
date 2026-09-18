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

/* ---------- 自证：先证明 D 组那条判据有分辨力，再谈它是不是绿的 ---------- */
if (process.argv.includes('--self-test')) {
  /* 造一个**形状与长度都像**真令牌的假 JWT。刻意不读 .env：没配 .env 的人
     也得能跑自证，而且自证本身不该碰真凭据。 */
  const FAKE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.self-test-not-a-real-token-'.padEnd(96, 'A')
  const ABSENT = 'a-value-that-is-in-no-sample-'.padEnd(64, 'B')
  const dir = mkdtempSync(join(tmpdir(), 'mine-release-selftest-'))
  writeFileSync(join(dir, 'leaked.js'), `const token = "${FAKE}"`)
  writeFileSync(join(dir, 'clean.js'), 'const token = ""')
  writeFileSync(join(dir, 'image.png'), FAKE) // 二进制：按设计不扫

  const found = findLeaks(walk(dir), [
    ['.env 的假令牌', FAKE],
    ['.env 里不存在的串', ABSENT]
  ])
  const hit = (label) => found.some((l) => l.label === label)

  const cases = [
    ['正例 令牌原样在 .js 里 → 必须报', hit('.env 的假令牌')],
    ['反例 同一个令牌只在 .png 里 → 不许报（二进制不在扫描范围）', !found.some((l) => l.file.endsWith('.png'))],
    ['反例 干净文件不许报', !found.some((l) => l.file.endsWith('clean.js'))],
    ['反例 样本里根本没有的值不许报（防乱报）', !hit('.env 里不存在的串')]
  ]

  rmSync(dir, { recursive: true, force: true })

  console.log('='.repeat(64))
  for (const [name, ok] of cases) console.log(`${ok ? '✓' : '✗'} ${name}`)
  console.log('='.repeat(64))
  const bad = cases.filter(([, ok]) => !ok)
  if (bad.length) {
    console.log('\n✗ 自证失败：凭据扫描的判据没有分辨力')
    process.exit(1)
  }
  console.log(`\n✓ 自证通过：${cases.length} 条样本该报的报、该放行的放行`)
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
/* `.env` 里的值就是「用户说了不能上传的东西」的全部。太短的（如 `false`）会到处
   误命中，所以设一个长度门槛；剩下的逐个在产物里搜原文。 */
const secrets = []
for (const file of ['.env', '.env.local']) {
  const p = join(ROOT, file)
  if (!existsSync(p)) continue
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const [, name, value] = m
    if (value.length >= 16) secrets.push([`${file} 的 ${name}`, value])
  }
}

const files = walk(DIST)
const leaks = findLeaks(files, secrets)
check(
  `D .env 里的 ${secrets.length} 个值都没进 dist/（扫了 ${files.length} 个文本产物）`,
  leaks.length === 0,
  `这些值被内联进产物了，提交上去等于公开：\n      ${leaks
    .map((l) => `${l.label} → ${l.file.slice(ROOT.length)}`)
    .join('\n      ')}\n` +
    '      修法：`VITE_CESIUM_ION_TOKEN= npm run build`（进程环境变量优先于 .env 文件），' +
    '或临时把 .env 移开再构建'
)

const envTracked = git(['ls-files', '--', '.env', '.env.local'])
check('D .env 没有被 git 跟踪', envTracked === '', `已被跟踪：${envTracked}`)

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
