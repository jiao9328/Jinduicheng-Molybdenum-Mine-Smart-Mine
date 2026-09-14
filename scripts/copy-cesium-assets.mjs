/**
 * 把 Cesium 运行时静态资源拷到 public/cesium/。
 *
 * 原因：Cesium 的 Worker / Assets（贴图、字体、WebAssembly）在运行时按
 * `window.CESIUM_BASE_URL` 拼路径动态加载，不参与 Vite 打包，必须原样产出。
 *
 * 触发：npm install 之后自动执行（postinstall），也可手动 `node scripts/copy-cesium-assets.mjs`
 */
import { cp, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', 'cesium', 'Build', 'Cesium')
const dest = join(root, 'public', 'cesium')

/** 需要随包发布的子目录 */
const DIRS = ['Workers', 'Assets', 'Widgets', 'ThirdParty']

async function main() {
  if (!existsSync(src)) {
    console.error(`[cesium] 未找到 ${src}，请先执行 npm install`)
    process.exit(1)
  }

  // 先清干净，避免旧版本残留文件混入
  await rm(dest, { recursive: true, force: true })

  for (const dir of DIRS) {
    const from = join(src, dir)
    if (!existsSync(from)) {
      console.warn(`[cesium] 跳过不存在的目录 ${dir}`)
      continue
    }
    await cp(from, join(dest, dir), { recursive: true })
  }

  const { size } = await stat(dest)
  console.log(`[cesium] 静态资源已就绪 → public/cesium（${DIRS.join(', ')}）`)
  void size
}

main().catch((err) => {
  console.error('[cesium] 拷贝失败：', err)
  process.exit(1)
})
