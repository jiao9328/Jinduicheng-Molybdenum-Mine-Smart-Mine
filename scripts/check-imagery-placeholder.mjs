/**
 * 离线底图占位瓦片巡检：**透明占位图**与 `hasAlphaChannel` 声明必须自洽。
 *
 * ── 为什么要它 ──
 * `OfflineTileImageryProvider` 对「没缓存」的瓦片返回的是一张**全透明** PNG
 * （`TRANSPARENT_PNG`，256×256 RGBA，每个字节都是 0）。Cesium 是按
 * `hasAlphaChannel` 选纹理格式的：
 *   `pixelFormat: this._imageryProvider.hasAlphaChannel ? RGBA : RGB`
 *   （`@cesium/engine/Source/Scene/ImageryLayer.js:1214`）
 * 声明 `false` 时这张图按 **RGB** 上传，alpha 被丢掉，占位像素 (0,0,0,0)
 * 就成了**不透明纯黑**。后果不是「有一块没底图」，而是：
 *   · 视图一高（需要的影像层级落到没缓存的那几级），整屏铺满 (0,0,0)；
 *   · `globe.baseColor`（`createViewer` 里特意设的深空色兜底 `#07182b`）
 *     永远透不出来——因为占位图不透明，把地球整个盖住了；
 *   · 关掉影像图层，同一片区域立刻变成兜底色 ⇒ 一眼能看出「黑是影像给的」。
 * 所以这两处必须一起看：占位图透明 ⇔ `hasAlphaChannel` 必须为 true。
 *
 * ── 判据（期望值写死在脚本里，不读被测代码的常量）──
 * ① 占位图必须是 **256×256**（尺寸不一致会让 Cesium 在 GlobeSurfaceTile 里
 *    算出 undefined 矩形并中止渲染循环——这是代码注释里记着的旧坑，这里守住）；
 * ② 占位图必须是 **8 位 RGBA**（颜色类型 6）——RGB 图没有 alpha，「透明」无从谈起；
 * ③ 占位图**全透明**（每个像素 alpha 恒为 0）且 `hasAlphaChannel: false` ⇒ 报错；
 * ④ 占位图**不透明**时不算错，只在备注里报出它的颜色，提醒「它会盖住
 *    `globe.baseColor`，确认这就是想要的兜底色」。
 * ⑤ 找不到占位图常量或找不到 `hasAlphaChannel` 声明 ⇒ 报错，**不静默通过**。
 *
 * ── 它抓不到什么（如实写在这里，免得下次高估它）──
 * 1. 真实瓦片的颜色/内容（脚本只读占位图那一张）。
 * 2. 「没缓存」的层级范围是否够用——那是瓦片集覆盖问题，归 `check-terrain-levels`
 *    和抓取脚本管：高度越高需要的层级越粗，缺哪一级就会露出兜底色。
 * 3. 运行时的实际纹理格式（要真跑起来看，静态脚本看不到）。
 *
 * 用法：node scripts/check-imagery-placeholder.mjs [--self-test]
 */
import { readFileSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'

/** 被测文件；找不到即报错，不静默通过 */
const 底图源 = 'src/scene/localImagery.ts'

/** 期望值写死在这里（不读被测代码的常量） */
const 期望边长 = 256
const 期望颜色类型 = 6 // PNG 颜色类型 6 = RGBA
const 期望位深 = 8

// ---------------------------------------------------------------------------
// 最小 PNG 解码：够用即止——8 位、无隔行交错，5 种行滤波都实现
// ---------------------------------------------------------------------------
const 通道数 = (颜色类型) => (颜色类型 === 6 ? 4 : 颜色类型 === 2 ? 3 : 颜色类型 === 0 ? 1 : 0)

export function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

/** 把像素数据封成一张 PNG（自证用；解码器要能被它来回验证） */
export function 封PNG(宽, 高, 像素, 颜色类型 = 6, 位深 = 8, 滤波 = 0) {
  const 通道 = 通道数(颜色类型)
  const 行字节 = 宽 * 通道
  const 原始 = Buffer.alloc((行字节 + 1) * 高)
  for (let y = 0; y < 高; y++) {
    原始[y * (行字节 + 1)] = 滤波
    像素.copy(原始, y * (行字节 + 1) + 1, y * 行字节, (y + 1) * 行字节)
  }
  const 块 = (名, 数据) => {
    const t = Buffer.alloc(8 + 数据.length + 4)
    t.writeUInt32BE(数据.length, 0)
    t.write(名, 4, 'ascii')
    数据.copy(t, 8)
    t.writeUInt32BE(crc32(t.subarray(4, 8 + 数据.length)), 8 + 数据.length)
    return t
  }
  const IHDR = Buffer.alloc(13)
  IHDR.writeUInt32BE(宽, 0)
  IHDR.writeUInt32BE(高, 4)
  IHDR[8] = 位深
  IHDR[9] = 颜色类型
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    块('IHDR', IHDR),
    块('IDAT', deflateSync(原始)),
    块('IEND', Buffer.alloc(0))
  ])
}

export function 解PNG(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null
  const 宽 = buf.readUInt32BE(16)
  const 高 = buf.readUInt32BE(20)
  const 位深 = buf[24]
  const 颜色类型 = buf[25]
  let off = 8
  const idat = []
  while (off + 12 <= buf.length) {
    const 长 = buf.readUInt32BE(off)
    const 名 = buf.toString('ascii', off + 4, off + 8)
    if (名 === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + 长))
    off += 12 + 长
  }
  const 通道 = 通道数(颜色类型)
  if (!通道 || 位深 !== 8) return { 宽, 高, 位深, 颜色类型, 通道, 像素: null }

  const 原始 = inflateSync(Buffer.concat(idat))
  const 行字节 = 宽 * 通道
  const 像素 = Buffer.alloc(行字节 * 高)
  for (let y = 0; y < 高; y++) {
    const 滤 = 原始[y * (行字节 + 1)]
    const 当前 = 像素.subarray(y * 行字节, (y + 1) * 行字节)
    原始.copy(当前, 0, y * (行字节 + 1) + 1, y * (行字节 + 1) + 1 + 行字节)
    const 上行 = y ? 像素.subarray((y - 1) * 行字节, y * 行字节) : null
    for (let i = 0; i < 行字节; i++) {
      const a = i >= 通道 ? 当前[i - 通道] : 0
      const b = 上行 ? 上行[i] : 0
      const c = 上行 && i >= 通道 ? 上行[i - 通道] : 0
      let v = 当前[i]
      if (滤 === 1) v += a
      else if (滤 === 2) v += b
      else if (滤 === 3) v += (a + b) >> 1
      else if (滤 === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      当前[i] = v & 255
    }
  }
  return { 宽, 高, 位深, 颜色类型, 通道, 像素 }
}

// ---------------------------------------------------------------------------
// 判据（纯函数，自证直接调它）
// ---------------------------------------------------------------------------
export function 判定({ 图, hasAlpha }) {
  const hits = []
  const 备注 = []
  if (!图) return { hits: ['占位图不是能解析的 PNG'], 备注 }

  if (图.宽 !== 期望边长 || 图.高 !== 期望边长) {
    hits.push(
      `占位图是 ${图.宽}×${图.高}，必须是 ${期望边长}×${期望边长} ——` +
        `尺寸对不上时 Cesium 会算出 undefined 的矩形并中止整个渲染循环`
    )
  }
  if (图.颜色类型 !== 期望颜色类型 || 图.位深 !== 期望位深) {
    hits.push(
      `占位图是位深 ${图.位深} / 颜色类型 ${图.颜色类型}，必须是 ${期望位深} 位 RGBA（颜色类型 ${期望颜色类型}）——` +
        `没有 alpha 通道就谈不上「透明占位」`
    )
  }
  if (!图.像素) return { hits, 备注 }

  let 全透明 = true
  let 不透明个数 = 0
  let 首色 = null
  for (let i = 0; i + 图.通道 <= 图.像素.length; i += 图.通道) {
    if (首色 === null) 首色 = [图.像素[i], 图.像素[i + 1], 图.像素[i + 2]]
    if (图.像素[i + 3] !== 0) {
      全透明 = false
      不透明个数++
    }
  }

  if (全透明 && hasAlpha === false) {
    hits.push(
      '占位图全透明，但 hasAlphaChannel 写的是 false —— ' +
        'Cesium 会按 RGB 建纹理（ImageryLayer.js:1214），透明像素 (0,0,0,0) 上传成不透明纯黑，' +
        '未覆盖区域整片发黑且 globe.baseColor 透不出来'
    )
  }
  if (!全透明) {
    备注.push(
      `占位图不是全透明的（首像素 RGB ${首色}，非透明像素 ${不透明个数} 个）——` +
        `它会盖住 globe.baseColor，确认这个颜色就是要的兜底色；` +
        `若是想要「透出兜底色」，占位图应改回全透明`
    )
  }
  if (hasAlpha === undefined) {
    备注.push('源码里没写 hasAlphaChannel（Cesium 默认 true，与透明占位图相容）')
  }
  return { hits, 备注 }
}

// ---------------------------------------------------------------------------
// 自证：合成样本。判据是纯函数，样本不经过被测文件，因此不受被测代码影响。
// ---------------------------------------------------------------------------
const 透明像素 = (宽, 高) => Buffer.alloc(宽 * 高 * 4)
const 不透明像素 = (宽, 高, rgb = [7, 24, 43]) => {
  const b = Buffer.alloc(宽 * 高 * 4)
  for (let i = 0; i < b.length; i += 4) {
    b[i] = rgb[0]
    b[i + 1] = rgb[1]
    b[i + 2] = rgb[2]
    b[i + 3] = 255
  }
  return b
}

const SELF_TEST_CASES = [
  {
    name: '正例①·透明占位 + hasAlphaChannel:false（这次的 bug）',
    run: () => 判定({ 图: 解PNG(封PNG(256, 256, 透明像素(256, 256))), hasAlpha: false }),
    expect: 1
  },
  {
    name: '反例①·透明占位 + hasAlphaChannel:true（正确）',
    run: () => 判定({ 图: 解PNG(封PNG(256, 256, 透明像素(256, 256))), hasAlpha: true }),
    expect: 0
  },
  {
    name: '反例②·不透明占位 + false（不误报，只在备注里提醒）',
    run: () => 判定({ 图: 解PNG(封PNG(256, 256, 不透明像素(256, 256))), hasAlpha: false }),
    expect: 0
  },
  {
    name: '正例②·占位图尺寸 1×1',
    run: () => 判定({ 图: 解PNG(封PNG(1, 1, 透明像素(1, 1))), hasAlpha: true }),
    expect: 1
  },
  {
    name: '正例③·占位图是 RGB（颜色类型 2），没有 alpha 通道',
    run: () => 判定({ 图: 解PNG(封PNG(256, 256, Buffer.alloc(256 * 256 * 3), 2)), hasAlpha: true }),
    expect: 1
  },
  {
    name: '正例④·占位图不是 PNG',
    run: () => 判定({ 图: 解PNG(Buffer.from('not a png at all, but long enough to pass the length check')), hasAlpha: true }),
    expect: 1
  },
  {
    name: '正例⑤·一个像素不透明，就不算全透明（此时 false 也不算错）',
    run: () => {
      const px = 透明像素(256, 256)
      px[3] = 255
      return 判定({ 图: 解PNG(封PNG(256, 256, px)), hasAlpha: false })
    },
    expect: 0
  },
  {
    name: '反例③·行滤波 4（Paeth）也要能解出来，别把透明图读成不透明',
    run: () => 判定({ 图: 解PNG(封PNG(256, 256, 透明像素(256, 256), 6, 8, 4)), hasAlpha: true }),
    expect: 0
  }
]

function selfTest() {
  let bad = 0
  console.log('=== 自证：合成样本 ===')
  for (const c of SELF_TEST_CASES) {
    let got
    try {
      got = c.run().hits.length
    } catch (err) {
      got = `抛异常：${err.message}`
    }
    const ok = got === c.expect
    if (!ok) bad++
    console.log(`  ${ok ? '✓' : '✗'} ${c.name}`)
    if (!ok) console.log(`      期望报 ${c.expect} 处，实际 ${got}`)
  }
  console.log(bad ? `\n✗ 自证 ${bad}/${SELF_TEST_CASES.length} 项不通过` : `\n✓ 自证 ${SELF_TEST_CASES.length} 项全过`)
  return bad
}

// ---------------------------------------------------------------------------
if (process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 1 : 0)
}

// ---------------------------------------------------------------------------
// 扫被测文件：抹平注释，避免把注释里的字样当成代码
// ---------------------------------------------------------------------------
function 抹注释(text) {
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
    i++
  }
  return out.join('')
}

let 源码
try {
  源码 = readFileSync(底图源, 'utf8')
} catch {
  console.log(`✗ 读不到 ${底图源} —— 判据失去目标，不静默通过`)
  process.exit(1)
}

const 抹平 = 抹注释(源码)
const 图匹配 = /const\s+TRANSPARENT_PNG\s*=\s*'data:image\/png;base64,([A-Za-z0-9+/=]+)'/.exec(抹平)
const 声明匹配 = /\bhasAlphaChannel\s*:\s*(true|false)/.exec(抹平)
const hasAlpha = 声明匹配 ? 声明匹配[1] === 'true' : undefined

console.log(`检查 ${底图源}`)
console.log(`判据：占位图 ${期望边长}×${期望边长}、${期望位深} 位 RGBA；若全透明则 hasAlphaChannel 必须为 true`)
console.log('')

const hits = []
const 备注 = []

if (!图匹配) {
  hits.push('没找到 TRANSPARENT_PNG 常量 —— 判据失去目标，不静默通过')
} else {
  const buf = Buffer.from(图匹配[1], 'base64')
  const 图 = 解PNG(buf)
  const r = 判定({ 图, hasAlpha })
  hits.push(...r.hits)
  备注.push(...r.备注)
  if (图) {
    console.log(`占位图：${图.宽}×${图.高}，位深 ${图.位深}，颜色类型 ${图.颜色类型}${图.颜色类型 === 6 ? '（RGBA）' : ''}`)
  }
}
console.log(`hasAlphaChannel：${hasAlpha === undefined ? '（没写）' : hasAlpha}`)
console.log('')

if (备注.length) {
  for (const n of 备注) console.log(`· 备注：${n}`)
  console.log('')
}

if (!hits.length) {
  console.log('✓ 占位图与 hasAlphaChannel 声明自洽')
  process.exit(0)
}

for (const h of hits) console.log(`✗ ${h}`)
console.log(
  `\n✗ ${hits.length} 处不自洽。` +
    `\n  修法：让占位图与声明对上——想要「未覆盖区域透出 globe.baseColor」就写 ` +
    `hasAlphaChannel: true；` +
    `\n  想要「占位图自己就是兜底色」就把 TRANSPARENT_PNG 换成一张不透明的兜底色图（此时 false 也合规）。` +
    `\n  （README 第 13 节第 21 条）`
)
process.exit(1)
