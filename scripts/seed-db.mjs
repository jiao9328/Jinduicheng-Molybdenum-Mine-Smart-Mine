/**
 * 把 `src/mock/*.ts` 里的四类台账灌进 SQLite。**幂等：每次都先清空再灌**。
 *
 * 库里一共五张业务表：四张有种子（质检记录 / 值班交接班 / 备件台账 / 隐患处置），
 * 第五张「决策工单」没有种子，但同样会被清空 —— 见下面 `PLAN` 里那条注释。
 *
 * ## 为什么要绕 esbuild 一圈
 *
 * 种子数据就在 `src/mock/*.ts` 里，那是 TypeScript，Node 直接 import 不了；
 * 而 `emergency.ts` 还 `import { DUMPS, pitOffset } from '@/scene/mineLayout'`，
 * 带着 `@` 别名 —— Node 的 type stripping 解不开这个别名。
 *
 * 绕法：把要用的四个数组写成一个临时入口文件，用 esbuild（Vite 自带的依赖，
 * 不必新装）按 `alias: {'@': src}` 打成一份纯 ESM 到临时目录，再 import。
 * 这样**不需要把 mock 数据复制一份到 JSON** —— 复制就意味着两处事实来源，
 * 以后改了 mock 忘了改 JSON，页面（走 mock）和库（走 JSON）会长期不一致，
 * 而且谁都不会报错。
 *
 * ## 保留原 id
 *
 * `qualityRecords` / `hazardDisposals` 在 mock 里带 `id`，灌库时**原样保留**。
 * 重新编号会让页面上的顺序变掉、也会让巡检脚本里按 id 写的断言失效。
 * `dutySchedule` 没有 id（是「早/中/夜班」三条固定记录），交给自增；
 * `spareParts` 用业务主键 `code`。
 *
 * ## 先清空再灌 — 会**丢掉手工新增的记录**
 *
 * 这是种子脚本的定义使然（要能反复跑、每次都得到同一个基线）。
 * 演示前想恢复干净状态就重跑；想留着改过的数据就别跑。
 *
 * 用法：node scripts/seed-db.mjs [--db <path>]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { openDb, DB_PATH, RESOURCES, pickFields, insertRow, tableCounts } from '../server/db.mjs'
import { ensureDemoUsers } from '../server/auth.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const DB_FILE = argOf('--db', DB_PATH)

/**
 * 表 ↔ mock 数组的对应关系。与 `server/db.mjs` 的 `RESOURCES` 键一一对应，
 * 那边少一张表这边就会在下面 `RESOURCES[key]` 处报错，不会静默漏灌。
 *
 * `mockName: null` = **只清空、不灌数据**。决策工单属于这一类：
 * 它不是一张外部台账，而是页面上「采纳建议」这个动作生成的，没有种子可言。
 * 但它**必须进这张表** —— 脚本向用户承诺的是「重跑一次就回到干净基线」，
 * 漏清这张表的话，演示前重跑一次，上一轮点出来的工单还挂在右列。
 */
const PLAN = [
  { key: 'production/quality-records', mockName: 'qualityRecords' },
  { key: 'production/duty-schedule', mockName: 'dutySchedule' },
  { key: 'equipment/spare-parts', mockName: 'spareParts' },
  { key: 'emergency/hazard-disposals', mockName: 'hazardDisposals' },
  { key: 'decision/orders', mockName: null }
]

/** 需要灌种子的那几条（`mockName` 非空的），入口文件只打包它们 */
const SEEDED = PLAN.filter((p) => p.mockName)

/** 把要灌的几组数组打包出来。返回 `{ qualityRecords, dutySchedule, ... }` */
async function loadMock() {
  const esbuild = await import('esbuild')
  const dir = mkdtempSync(join(tmpdir(), 'mine-seed-'))
  try {
    const entry = join(dir, 'entry.ts')
    writeFileSync(
      entry,
      SEEDED.map(({ key, mockName }) => {
        const mod = key.split('/')[0]
        return `export { ${mockName} } from '@/mock/${mod}'`
      }).join('\n') + '\n'
    )

    const outfile = join(dir, 'bundle.mjs')
    await esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      alias: { '@': join(ROOT, 'src') },
      logLevel: 'warning'
    })
    return await import(pathToFileURL(outfile).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 一行 mock 记录 → 可入库的对象。声明过的字段之外，保留主键原值 */
function rowToValues(resource, row) {
  const values = pickFields(resource, row)
  if (resource.autoKey && row[resource.key] !== undefined) {
    const id = Number(row[resource.key])
    if (!Number.isInteger(id)) {
      throw new Error(`mock 里出现了非整数主键 ${resource.key}=${row[resource.key]}`)
    }
    values[resource.key] = id
  }
  return values
}

const mock = await loadMock()
const db = openDb(DB_FILE)
ensureDemoUsers(db)

console.log(`数据库：${DB_FILE === ':memory:' ? '(内存)' : DB_FILE}\n`)

let total = 0
for (const { key, mockName } of PLAN) {
  const resource = RESOURCES[key]
  db.exec(`DELETE FROM "${resource.table}"`)

  if (!mockName) {
    console.log(`  – ${resource.label.padEnd(8, '　')} ${resource.table.padEnd(18)} 已清空（无种子）`)
    continue
  }

  const rows = mock[mockName]
  if (!Array.isArray(rows)) {
    throw new Error(`mock 里没有导出 ${mockName}（${key} 的种子缺失）`)
  }

  for (const row of rows) insertRow(db, resource, rowToValues(resource, row))

  total += rows.length
  console.log(`  ✓ ${resource.label.padEnd(8, '　')} ${resource.table.padEnd(18)} ${rows.length} 条`)
}

console.log(`\n合计 ${total} 条。账号：admin / admin123（管理员）、user / user123（普通用户）`)
console.log('各表条数：', JSON.stringify(tableCounts(db)))
db.close()
