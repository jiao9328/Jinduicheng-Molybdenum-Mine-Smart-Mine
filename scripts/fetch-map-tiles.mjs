/**
 * 矿区离线底图抓取。
 *
 * 数据源（均为免 key 的公开服务）：
 *   影像  ArcGIS World Imagery
 *         https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer
 *   高程  AWS Terrarium（Mapzen 整理的公开 DEM，编码在 PNG 的 RGB 通道里）
 *         https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *
 * 抓下来的瓦片按标准 XYZ 目录放在 public/map-tiles/ 下，
 * 由 src/scene/localImagery.ts 提供离线访问，矿区断网也能出图。
 *
 * 用法：
 *   node scripts/fetch-map-tiles.mjs             # 抓默认配置
 *   node scripts/fetch-map-tiles.mjs --force     # 忽略已存在的瓦片重抓
 *   node scripts/fetch-map-tiles.mjs --heights-only
 *   node scripts/fetch-map-tiles.mjs --imagery-only
 */
import { mkdir, readdir, writeFile, access } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 配置：矿区位置与各级缩放需要覆盖的范围
// ---------------------------------------------------------------------------

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 矿区中心（与 src/scene/sceneConfig.ts 保持一致）
 *
 * 金堆城钼矿（陕西省渭南市华州区金堆镇），秦岭北麓，西安东南约 155km。
 * 亚洲第一、世界第二的钼矿，露天开采，现状最高边坡 410m，
 * 设计产能 1320 万吨/年。影像上可见层层阶梯的露天采坑、
 * 蓝色屋顶的选矿厂房群、皮带廊、排土场与尾矿库。
 *
 * 坐标取矿床中心（东经 109°57′22″，北纬 34°19′41″，海拔 1211m）。
 */
export const CENTER = { lon: 109.9561, lat: 34.3281 }

/**
 * 需要抓取的层级与半径（以瓦片为单位）。
 * 半径按矿区尺度递增：低层级用大范围看全局，高层级用小范围看细节。
 *
 * 露天采坑与工业场地跨度约 3~4km，比井工矿的地表设施更集中。各层级瓦片边长：
 *   z14 ≈ 2.0km、z15 ≈ 1.0km、z16 ≈ 500m、z17 ≈ 250m
 */
export const IMAGERY_LEVELS = [
  { z: 12, radius: 3 },
  { z: 13, radius: 4 },
  { z: 14, radius: 5 },
  { z: 15, radius: 7 },
  { z: 16, radius: 11 },
  { z: 17, radius: 18 }
]

/** 高程用到 z14 即可，地形起伏不需要更高精度 */
export const HEIGHT_LEVELS = [
  { z: 11, radius: 3 },
  { z: 12, radius: 3 },
  { z: 13, radius: 4 },
  { z: 14, radius: 6 }
]

export const SOURCES = {
  imagery: {
    name: 'ArcGIS World Imagery',
    dir: 'public/map-tiles/imagery',
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    levels: IMAGERY_LEVELS,
    ext: 'jpg'
  },
  heights: {
    name: 'AWS Terrarium DEM',
    dir: 'public/map-tiles/heights',
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    levels: HEIGHT_LEVELS,
    ext: 'png'
  }
}

// ---------------------------------------------------------------------------
// Web Mercator 换算
// ---------------------------------------------------------------------------

export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z))
}

export function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z)
  )
}

const exists = (p) =>
  access(p).then(
    () => true,
    () => false
  )

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const force = args.includes('--force')
const onlyImagery = args.includes('--imagery-only')
const onlyHeights = args.includes('--heights-only')

async function fetchTile(url, dest) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'smart-mine-platform/0.1 (offline map cache)' }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 100) throw new Error(`内容过小 (${buf.length}b)`)
  await writeFile(dest, buf)
  return buf.length
}

/** 单并发池，避免把公开服务打爆 */
async function pool(items, worker, concurrency = 6) {
  let index = 0
  let done = 0
  const results = []

  async function run() {
    while (index < items.length) {
      const i = index++
      try {
        results[i] = { ok: true, value: await worker(items[i], i) }
      } catch (err) {
        results[i] = { ok: false, error: err.message, item: items[i] }
      }
      done++
      if (done % 25 === 0 || done === items.length) {
        process.stdout.write(`\r  进度 ${done}/${items.length}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  process.stdout.write('\n')
  return results
}

async function fetchSource(source) {
  console.log(`\n=== ${source.name} → ${source.dir} ===`)

  const tasks = []
  for (const level of source.levels) {
    const cx = lonToTileX(CENTER.lon, level.z)
    const cy = latToTileY(CENTER.lat, level.z)
    const max = Math.pow(2, level.z) - 1

    let count = 0
    for (let dx = -level.radius; dx <= level.radius; dx++) {
      for (let dy = -level.radius; dy <= level.radius; dy++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x > max || y > max) continue
        tasks.push({ z: level.z, x, y })
        count++
      }
    }
    console.log(`  z${level.z}: 中心 ${cx}/${cy}，${count} 张`)
  }

  const dir = join(root, source.dir)
  const results = await pool(
    tasks,
    async (t) => {
      const dest = join(dir, String(t.z), String(t.x), `${t.y}.${source.ext}`)
      if (!force && (await exists(dest))) return { skipped: true }

      await mkdir(dirname(dest), { recursive: true })
      const bytes = await fetchTile(source.url(t.z, t.x, t.y), dest)
      return { bytes }
    },
    source.name.includes('Imagery') ? 4 : 6
  )

  const skipped = results.filter((r) => r.ok && r.value?.skipped).length
  const failed = results.filter((r) => !r.ok)
  const bytes = results
    .filter((r) => r.ok && r.value?.bytes)
    .reduce((sum, r) => sum + r.value.bytes, 0)

  console.log(
    `  完成：新增 ${results.length - skipped - failed.length}，已存在 ${skipped}，失败 ${failed.length}，` +
      `新增体积 ${(bytes / 1024 / 1024).toFixed(1)}MB`
  )
  for (const f of failed.slice(0, 5)) {
    console.log(`   ! ${f.item.z}/${f.item.x}/${f.item.y}: ${f.error}`)
  }

  // 产出瓦片清单。
  // 运行时靠它判断「某层级有没有缓存、具体有哪些瓦片」——
  // 不能凭配置的半径去推断，否则请求到没抓的瓦片会一片白。
  await writeManifest(source)
  return { total: results.length, failed: failed.length }
}

/** 扫描磁盘上实际存在的瓦片，写成清单 */
export async function writeManifest(source) {
  const dir = join(root, source.dir)
  const manifest = {}

  for (const level of source.levels) {
    let xDirs = []
    try {
      xDirs = await readdir(join(dir, String(level.z)))
    } catch {
      continue
    }

    const tiles = []
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    for (const xName of xDirs) {
      const x = Number(xName)
      if (!Number.isInteger(x)) continue

      let yFiles = []
      try {
        yFiles = await readdir(join(dir, String(level.z), xName))
      } catch {
        continue
      }

      for (const yName of yFiles) {
        if (!yName.endsWith(`.${source.ext}`)) continue
        const y = Number(yName.slice(0, -(source.ext.length + 1)))
        if (!Number.isInteger(y)) continue

        tiles.push(`${x}/${y}`)
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }

    if (tiles.length) {
      manifest[level.z] = { tiles, minX, maxX, minY, maxY, count: tiles.length }
    }
  }

  const manifestPath = join(dir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest))
  console.log(`  清单已写入 ${source.dir}/manifest.json（${Object.keys(manifest).join(', ')} 层级）`)
}

async function main() {
  const summary = []
  if (!onlyHeights) summary.push(await fetchSource(SOURCES.imagery))
  if (!onlyImagery) summary.push(await fetchSource(SOURCES.heights))

  const failed = summary.reduce((n, s) => n + s.failed, 0)
  console.log(`\n全部完成，共失败 ${failed} 张`)
  if (failed) console.log('可重复执行本脚本补齐（已存在的瓦片会跳过）')
}

// 仅在直接执行本文件时抓取。
// prune-map-tiles.mjs 会 import 上面的 CENTER / LEVELS 配置，
// 不加这层判断的话，一导入就会顺带跑一次全量抓取。
const isDirectRun =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  main().catch((err) => {
    console.error('抓取失败：', err)
    process.exit(1)
  })
}
