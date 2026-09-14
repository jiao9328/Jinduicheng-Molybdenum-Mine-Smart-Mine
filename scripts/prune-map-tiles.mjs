/**
 * 清理超出当前配置范围的离线瓦片。
 *
 * 什么时候需要它：改了 `fetch-map-tiles.mjs` 里的 CENTER（矿区换位置）
 * 或缩小了某层级的 radius 之后，磁盘上会残留旧位置的瓦片。
 * 抓取脚本只负责「补」，不会删，残留瓦片会带来两个问题：
 *
 *   1. manifest 的范围被撑大，运行时以为那些地方有数据；
 *   2. dist/ 里白白多出几十 MB 打给用户。
 *
 * 本脚本按当前配置算出「应该存在」的瓦片集合，删掉集合之外的，
 * 再重建 manifest。配置直接 import 抓取脚本，避免两处各写一份而漂移。
 *
 * 用法：
 *   node scripts/prune-map-tiles.mjs --dry-run    # 只看会删多少，不动文件
 *   node scripts/prune-map-tiles.mjs              # 实际执行
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CENTER,
  SOURCES,
  IMAGERY_LEVELS,
  HEIGHT_LEVELS,
  lonToTileX,
  latToTileY,
  writeManifest
} from './fetch-map-tiles.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

/** 按配置算出某数据源应该存在的瓦片集合，key 为 "z/x/y" */
function expectedTiles(levels) {
  const expected = new Set()
  for (const level of levels) {
    const cx = lonToTileX(CENTER.lon, level.z)
    const cy = latToTileY(CENTER.lat, level.z)
    const max = Math.pow(2, level.z) - 1

    for (let dx = -level.radius; dx <= level.radius; dx++) {
      for (let dy = -level.radius; dy <= level.radius; dy++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x > max || y > max) continue
        expected.add(`${level.z}/${x}/${y}`)
      }
    }
  }
  return expected
}

const exists = (p) =>
  stat(p).then(
    () => true,
    () => false
  )

async function pruneSource(source, levels) {
  console.log(`\n=== ${source.name} → ${source.dir} ===`)
  const expected = expectedTiles(levels)
  const dir = join(root, source.dir)

  const removed = []
  let kept = 0

  let zDirs = []
  try {
    zDirs = await readdir(dir)
  } catch {
    console.log('  目录不存在，跳过')
    return { removed: 0, kept: 0 }
  }

  for (const zName of zDirs) {
    const z = Number(zName)
    if (!Number.isInteger(z)) continue // 跳过 manifest.json 等

    let xDirs = []
    try {
      xDirs = await readdir(join(dir, zName))
    } catch {
      continue
    }

    for (const xName of xDirs) {
      const x = Number(xName)
      if (!Number.isInteger(x)) continue

      let yFiles = []
      try {
        yFiles = await readdir(join(dir, zName, xName))
      } catch {
        continue
      }

      for (const yFile of yFiles) {
        if (!yFile.endsWith(`.${source.ext}`)) continue
        const y = Number(yFile.slice(0, -(source.ext.length + 1)))
        if (!Number.isInteger(y)) continue

        if (expected.has(`${z}/${x}/${y}`)) {
          kept++
        } else {
          removed.push(join(dir, zName, xName, yFile))
        }
      }
    }
  }

  console.log(`  应保留 ${kept} 张，待删除 ${removed.length} 张`)

  if (dryRun || !removed.length) return { removed: removed.length, kept }

  // 逐文件删除：Windows 上目录整体删除容易被正在监听的 dev server 挡住，
  // 文件级删除即使 Vite 在跑也能成功
  for (const file of removed) {
    await rm(file, { force: true })
  }

  // 清掉删空的目录，避免留下几千个空壳
  await pruneEmptyDirs(dir)

  return { removed: removed.length, kept }
}

/** 自底向上删掉空目录 */
async function pruneEmptyDirs(dir) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = join(dir, entry.name)
    await pruneEmptyDirs(child)
    const rest = await readdir(child).catch(() => [])
    if (rest.length === 0) await rm(child, { recursive: true, force: true })
  }
}

const summary = []
summary.push([
  SOURCES.imagery,
  await pruneSource(SOURCES.imagery, IMAGERY_LEVELS)
])
summary.push([
  SOURCES.heights,
  await pruneSource(SOURCES.heights, HEIGHT_LEVELS)
])

if (dryRun) {
  console.log('\n（--dry-run，未改动任何文件）')
} else {
  console.log('\n=== 重建清单 ===')
  for (const [source] of summary) await writeManifest(source)
  const total = summary.reduce((n, [, r]) => n + r.removed, 0)
  console.log(`\n完成，共删除 ${total} 张越界瓦片`)
}
