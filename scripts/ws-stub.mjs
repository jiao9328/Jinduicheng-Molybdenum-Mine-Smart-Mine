/**
 * 最小 WebSocket 服务端 —— 只为验证前端实时链路。
 *
 * 为什么手写而不是装 `ws`：这个服务端只有测试用得到，而它是**一次性的**——
 * 后端就绪后连同本文件一起删掉。为一次性的东西往 package.json 里加一条
 * 依赖，代价是以后每个人 npm i 都要为它买单。握手和帧格式都很简单，
 * 手写的成本就是这 100 行。
 *
 * 用法：
 *   node scripts/ws-stub.mjs [--port 8765] [--interval 3000] [--count 3]
 *
 * 行为：客户端订阅 `device.status` 后，每隔 interval 毫秒推一条设备告警。
 * 会把收到的每一帧打印出来——**订阅消息能打出来，才证明前端真的建连并发出了订阅**，
 * 而不是订阅登记在册、socket 却是 null。
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : fallback
}

const PORT = arg('--port', 8765)
const INTERVAL = arg('--interval', 3000)
/** 每个连接最多推几条；0 表示不限 */
const COUNT = arg('--count', 3)

/** 推送用的告警模板，字段与前端 `DeviceAlert` 一致 */
const TEMPLATES = [
  { device: '破碎一', type: '振动幅值超限', level: '高' },
  { device: '皮带二', type: '轴承温度 78℃', level: '中' },
  { device: '球磨机', type: '电流波动异常', level: '中' },
  { device: '提升机', type: '润滑油位低', level: '低' },
  { device: '通风机', type: '振动超限', level: '高' }
]

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 服务端发出的帧不加掩码（协议规定只有客户端→服务端需要掩码） */
function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), payload])
  if (len < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(len), 2)
  return Buffer.concat([header, payload])
}

/** 解析客户端帧（必然带掩码）。可能一次收到半帧或粘帧，返回未消费的尾巴 */
function decodeFrames(buf) {
  const frames = []
  let offset = 0

  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f
    const masked = (buf[offset + 1] & 0x80) === 0x80
    let len = buf[offset + 1] & 0x7f
    let p = offset + 2

    if (len === 126) {
      if (p + 2 > buf.length) break
      len = buf.readUInt16BE(p)
      p += 2
    } else if (len === 127) {
      if (p + 8 > buf.length) break
      len = Number(buf.readBigUInt64BE(p))
      p += 8
    }

    let mask = null
    if (masked) {
      if (p + 4 > buf.length) break
      mask = buf.subarray(p, p + 4)
      p += 4
    }

    if (p + len > buf.length) break

    const payload = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]

    frames.push({ opcode, payload })
    offset = p + len
  }

  return { frames, rest: buf.subarray(offset) }
}

const server = createServer((req, res) => {
  // 普通 HTTP 请求：给个提示，方便用浏览器直接打开确认服务活着
  res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('这是 WebSocket 端点，请用 ws:// 连接\n')
})

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }

  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64')

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  )

  console.log(`[stub] 客户端已连接（${req.url}）`)

  let buffer = Buffer.alloc(0)
  let timer = null
  let sent = 0
  const subscribed = new Set()

  const push = () => {
    const tpl = TEMPLATES[sent % TEMPLATES.length]
    const data = { ...tpl, time: stamp() }
    // 推送格式与 dispatch() 的期望一致：{ topic, data }
    socket.write(encodeFrame(JSON.stringify({ topic: 'device.status', data })))
    sent++
    console.log(`[stub] → 推送 #${sent} ${data.device} ${data.type} ${data.time}`)
    if (COUNT && sent >= COUNT) {
      clearInterval(timer)
      timer = null
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    const { frames, rest } = decodeFrames(buffer)
    buffer = rest

    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        console.log('[stub] 客户端关闭连接')
        socket.end()
        return
      }
      if (frame.opcode === 0x9) {
        // ping → pong（0x8A = FIN + pong）
        socket.write(Buffer.from([0x8a, 0]))
        continue
      }
      if (frame.opcode !== 0x1) continue

      const text = frame.payload.toString('utf8')
      console.log('[stub] ← 收到:', text)

      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        continue
      }

      if (msg.type === 'subscribe' && msg.topic === 'device.status') {
        subscribed.add(msg.topic)
        // 收到订阅才开始推——这样「前端有没有真的建连并发订阅」就直接决定了
        // 后面有没有推送，测试不会因为服务端主动推而得到假阳性
        if (!timer && (!COUNT || sent < COUNT)) {
          console.log(`[stub] 订阅确认，每 ${INTERVAL}ms 推一条`)
          timer = setInterval(push, INTERVAL)
        }
      }

      if (msg.type === 'unsubscribe' && msg.topic === 'device.status') {
        subscribed.delete(msg.topic)
        if (timer) {
          clearInterval(timer)
          timer = null
          console.log('[stub] 已退订，停止推送')
        }
      }
    }
  })

  socket.on('close', () => {
    if (timer) clearInterval(timer)
    console.log('[stub] 连接已断开')
  })

  socket.on('error', (err) => {
    console.warn('[stub] socket 错误：', err.message)
  })
})

server.listen(PORT, () => {
  console.log(`[stub] WebSocket 桩服务已启动：ws://localhost:${PORT}/ws`)
  console.log(`[stub] 推送间隔 ${INTERVAL}ms，每个连接最多 ${COUNT || '不限'} 条`)
})
