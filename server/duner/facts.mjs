/**
 * 业务事实来源 —— 让墩儿说的数字与页面上的数字**是同一个**。
 *
 * ## 为什么不在这里另写一份数据
 *
 * 最省事的做法是在后端手抄一份"今日产量 27.8 吨"之类。那是错的：
 * 页面读 `src/mock/production.ts`，墩儿读另一份，两边**迟早对不上**，
 * 而"大屏上说 27.8、助手说 26.5"这种不一致在演示现场是致命的，
 * 且没有任何检查脚本会发现它（两边的判据各自都是自洽的）。
 *
 * 所以这里**直接打包前端的 mock 模块**，用法与 `scripts/seed-db.mjs`
 * 的 `loadMock()` 完全一致（esbuild + `@` 别名指向 `src/`）——
 * 本仓库既有的先例，不是新发明。
 *
 * ## 三个刻意的取舍
 *
 * 1. **懒加载 + 缓存。** 打包要走一次 esbuild（几十毫秒），放在服务启动
 *    路径上会拖慢每一次 `npm run serve`。改成第一次查询时再打，打一次记住。
 *
 * 2. **失败不致命。** esbuild 不在、`src/mock` 改了结构、打包报错 ——
 *    任何一种都只让 `loadFacts()` 返回 `null`，查询工具据此回
 *    「该数据源不可用」，**不抛异常**。墩儿少答一类问题，
 *    不该让整个后端起不来。
 *
 * 3. **用命名空间导出避免重名。** `productionMetrics` 在 `mock/production.ts`
 *    与 `mock/decision.ts` 里**各有一个**（值不同、含义也不同）。
 *    平铺导出会静默互相覆盖 —— 用 `export * as ns` 隔开。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** 要打包的 mock 模块。键名就是 `facts.<键>.<导出名>` */
const MODULES = [
  ['production', 'production'],
  ['safety', 'safety'],
  ['equipment', 'equipment'],
  ['decision', 'decision'],
  ['overview', 'overview'],
  ['twin', 'digitalTwin'],
  ['emergency', 'emergency']
]

let cache = null
let inflight = null

/**
 * 取业务事实。第一次调用会打包，之后走缓存。
 * @returns {Promise<object|null>} 打包失败返回 null
 */
export function loadFacts() {
  if (cache) return Promise.resolve(cache)
  if (inflight) return inflight

  inflight = (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duner-facts-'))
    try {
      const esbuild = await import('esbuild')
      const entry = join(dir, 'entry.ts')
      writeFileSync(
        entry,
        MODULES.map(([ns, mod]) => `export * as ${ns} from '@/mock/${mod}'`).join('\n') + '\n'
      )
      const outfile = join(dir, 'bundle.mjs')
      await esbuild.build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        alias: { '@': join(ROOT, 'src') },
        logLevel: 'error'
      })
      cache = await import(pathToFileURL(outfile).href)
      return cache
    } catch (err) {
      console.warn('[duner] 业务数据打包失败，查询类工具将不可用：', err?.message ?? err)
      return null
    } finally {
      inflight = null
      rmSync(dir, { recursive: true, force: true })
    }
  })()

  return inflight
}

/** 仅供检查脚本/自证使用：清掉缓存，逼下一次重新打包 */
export function resetFactsCache() {
  cache = null
}
