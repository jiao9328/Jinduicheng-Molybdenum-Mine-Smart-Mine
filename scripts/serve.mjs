#!/usr/bin/env node
/**
 * 一键启动：`npm run serve`
 *
 *   1) 确保 dist/ 存在、且不比源码旧（缺失或过期就先跑一次 vite build）
 *   2) 起后端：**同一个进程、同一个端口**同时托管 dist/ 静态页与 /api
 *
 * 为什么要有这一层，而不是直接 `node server/index.mjs`：
 * dist/ 不入版本库，新克隆的仓库里没有它，直接起后端只会在访问 `/` 时
 * 返回一行「dist/ 不存在，先执行 npm run build」的纯文本——对「一键启动」
 * 来说这就是失败。本脚本把构建补上，并且**只在真的过期时才构建**，
 * 日常重复启动仍然是秒开。
 *
 * 构建走 node_modules 里的 vite，不经过 `npm run build`：那会先跑
 * vue-tsc 全量类型检查（慢，且类型错就起不来）。一键启动的目标是跑得起来，
 * 类型门禁仍然交给 `npm run build`。
 *
 * 命令行参数原样透传给后端，例如：
 *   npm run serve -- --port 9000
 *   npm run serve -- --db server/data/another.db
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

/* 参与「是否过期」比较的源头。public/ 必须在内：它是 Vite 的静态资源目录，
   内容在构建时原样拷进 dist/，改了瓦片或 Cesium 资源不重建就到不了产物里。
   .env / .env.local 也在内：Vite 构建时就把 VITE_* 内联进产物了。 */
const SOURCES = ['src', 'public', 'index.html', 'vite.config.ts', 'package.json', '.env', '.env.local']

/* 跳过的目录。public/cesium 是从 node_modules/cesium 拷来的（npm install 的
   postinstall 负责），版本对不上时该重跑的是 npm run cesium:assets，不是重建前端；
   而且它有几千个文件，进遍历会白白拖慢每次启动。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'cesium'])

/** 递归取目录树里最新的修改时间；读不到就返回 0（当作不存在） */
function newestMtime(target) {
  let newest = 0
  const walk = (p) => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      let entries
      try {
        entries = readdirSync(p)
      } catch {
        return
      }
      for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue
        walk(join(p, name))
      }
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs
    }
  }
  walk(target)
  return newest
}

/* ---------- 1) 依赖预检：没装依赖时给中文提示，而不是 'vite' 不是内部或外部命令 ---------- */
if (!existsSync(VITE)) {
  console.error(
    '\n[serve] 未安装依赖：找不到 node_modules/vite。\n' +
      '        仓库刻意不含 node_modules，首次运行请先安装：\n' +
      '            npm install\n' +
      '        装好后重新执行 npm run serve。\n'
  )
  process.exit(1)
}

/* ---------- 2) dist 是否缺失/过期 ---------- */
let staleReason = ''
if (!existsSync(join(DIST, 'index.html'))) {
  staleReason = 'dist/ 尚未构建'
} else {
  const builtAt = statSync(join(DIST, 'index.html')).mtimeMs
  for (const rel of SOURCES) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue
    if (newestMtime(abs) > builtAt) {
      staleReason = `${rel} 比 dist/ 新`
      break
    }
  }
}

if (staleReason) {
  console.log(`\n[serve] ${staleReason} → 先构建前端…\n`)
  const r = spawnSync(process.execPath, [VITE, 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(
      '\n[serve] 前端构建失败，已中止（报错见上方）。\n' +
        '        只想起后端接口、前端另跑 npm run dev：node server/index.mjs\n'
    )
    process.exit(1)
  }
} else {
  console.log('[serve] dist/ 已是最新，跳过构建（改了 src/ 后重跑本命令会自动重建）')
}

/* ---------- 3) 起后端 ----------
   用动态 import 而不是再 spawn 一个进程：少一层进程，Ctrl+C 一次就干净退出。
   后端在模块顶层读 process.argv.slice(2)，所以上面的 `-- --port 9000`
   这类参数会被它原样接住，不必在这里转发。 */
await import('../server/index.mjs')
