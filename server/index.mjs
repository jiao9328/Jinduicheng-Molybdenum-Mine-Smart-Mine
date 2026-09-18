/**
 * 后端服务：一个进程同时托管 `dist/` 与 `/api`。
 *
 * ## 为什么同源托管而不是两个进程
 *
 * 前端 `http.ts` 的 `BASE_URL` 默认就是同源 `/api`，同源托管意味着：
 * 没有跨域、没有 CORS 预检、**登录态不必操心 cookie 的 SameSite**，
 * 而且现有那十几个巡检脚本把 baseUrl 从 `:4173` 换成 `:8787` 就能直接用，
 * 不必再配一层反向代理。部署时也只有一个进程要起。
 *
 * ## 静态服务是手写的
 *
 * 与 `scripts/ws-stub.mjs` 同一个理由：`node:http` + `node:fs` 就够用，
 * 为此引 express/koa 不划算。手写要自己操心的是**路径穿越**
 *（`/../../.env`）与 **Range 请求**，两者都在下面各有一小段。
 * Range 不是可选项：Cesium 加载静态地形/影像时用得上，缺了会莫名其妙地
 * 加载失败。安全上只放行单区间 `bytes=a-b`，多区间（`bytes=0-1,5-6`）
 * 直接按 200 全量返回 —— 那是给下载器用的，这里没有场景。
 *
 * 用法：node server/index.mjs [--port 8787] [--db <path>]
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, DB_PATH } from './db.mjs'
import { ensureDemoUsers, currentUser, bearerToken } from './auth.mjs'
import { handleRequest } from './routes.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = join(ROOT, 'dist')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const PORT = Number(argOf('--port', process.env.PORT ?? 8787))
const DB_FILE = argOf('--db', DB_PATH)

/** 请求体上限。四张台账都是几十字节一行，1MB 已经宽得离谱了 */
const MAX_BODY = 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.terrain': 'application/octet-stream'
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // 这份 JSON 是登录响应与台账内容，别让浏览器去猜类型
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        rejectPromise(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolvePromise(undefined)
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        rejectPromise(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', rejectPromise)
  })
}

/**
 * 把 URL 解析成 dist 内的绝对路径。
 *
 * **路径穿越就拦在这里**：拼完之后必须仍以 `DIST` 开头（连分隔符一起比，
 * 否则 `dist-evil` 这种同前缀目录会漏过去）。返回 `null` 表示不合法。
 */
function resolveStatic(pathname) {
  const decoded = decodeURIComponent(pathname)
  const target = resolve(join(DIST, normalize(decoded)))
  if (target !== DIST && !target.startsWith(DIST + sep)) return null
  return target
}

function serveFile(req, res, file) {
  const stat = statSync(file)
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const base = {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    // 产物文件名带 hash，但 index.html 不带 —— 每次都回源，免得改完
    // 重新构建后浏览器还拿旧页面（巡检脚本会被这个坑掉）
    'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600'
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim())
  if (range) {
    const start = range[1] ? Number(range[1]) : 0
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
    if (start <= end && start < stat.size) {
      res.writeHead(206, {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes'
      })
      createReadStream(file, { start, end }).pipe(res)
      return
    }
  }

  res.writeHead(200, { ...base, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' })
  createReadStream(file).pipe(res)
}

const db = openDb(DB_FILE)
ensureDemoUsers(db)

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const { pathname } = url

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    try {
      const ctx = {
        db,
        method: req.method,
        // 去掉 /api 前缀交给路由表；路由表里的路径与前端 requestWithFallback
        // 的第一段参数一一对应（如 /production/quality-records）
        path: pathname.slice(4) || '/',
        query: Object.fromEntries(url.searchParams),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req),
        bearer: bearerToken(req),
        user: currentUser(db, req)
      }
      // ⚠️ `await` 不能省。墩儿的对话路由是**异步**的（要调模型、要等超时），
      // 少了这个 await 拿到的是 Promise 而不是 `{status, body}`，
      // 于是 `result.status` 是 undefined，`res.writeHead(undefined, …)` 抛
      // ERR_HTTP_INVALID_STATUS_CODE —— 而它只在真正走到 AI 那条路时才出现。
      // 既有的同步路由不受影响：await 一个非 Promise 值原样返回。
      const result = await handleRequest(ctx)
      sendJson(res, result.status, result.body)
    } catch (err) {
      const status = err?.status ?? 500
      if (status >= 500) console.error('[api] 处理失败：', err)
      sendJson(res, status, { message: err?.message ?? '服务器内部错误' })
    }
    return
  }

  if (!existsSync(DIST)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('dist/ 不存在。先执行 npm run build，或只起接口：node server/index.mjs（前端另跑 npm run dev）\n')
    return
  }

  // 目录请求补 index.html
  let file = resolveStatic(pathname)
  if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')

  // SPA 兜底：未知路径交回 index.html，由前端路由自己决定去哪
  if (!file || !existsSync(file)) file = join(DIST, 'index.html')

  try {
    serveFile(req, res, file)
  } catch (err) {
    console.error('[static] 读取失败：', err)
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('静态资源读取失败\n')
  }
})

server.listen(PORT, () => {
  const where = DB_FILE === ':memory:' ? '内存库' : DB_FILE
  console.log(`矿山管控平台后端已启动：http://localhost:${PORT}`)
  console.log(`  静态目录：${existsSync(DIST) ? DIST : '(dist 尚未构建)'}`)
  console.log(`  数据库：  ${where}`)
  console.log(`  预置账号：admin / admin123（管理员）、user / user123（普通用户）`)
})
