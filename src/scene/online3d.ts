import * as Cesium from 'cesium'

/**
 * 在线实景三维（Google Photorealistic 3D Tiles）。
 *
 * 通过 Cesium Ion 的资产 2275207 接入，得到目标区域的**真实倾斜摄影三维**——
 * 采坑台阶、厂房、地形都是实拍重建的，不是程序化几何体。
 *
 * ## 默认关闭，是有意的
 *
 * 1. **需要外网**。项目的前提是矿区现场常常没有外网，底图与地形都做了离线缓存；
 *    在线实景三维没有这个能力，所以只能作为可选项。
 * 2. **授权**。Cesium Ion 对该资产的授权提示是 "Upgrade for commercial use"，
 *    正式交付前必须确认商用许可，否则只能用于演示。
 * 3. **数据量**。实测单个视点会遍历约 1.7 万块瓦片，对显卡和带宽都有要求。
 *
 * 打开方式：`.env` 里设 `VITE_USE_ONLINE_3D=true`。
 * 加载失败（断网、令牌失效、无商用授权）会自动退回程序化场景，不会让页面空掉。
 */

/** 是否启用在线实景三维 */
export const ONLINE_3D_ENABLED =
  (import.meta.env.VITE_USE_ONLINE_3D as string | undefined) === 'true'

export interface Online3DResult {
  /** 是否成功加载 */
  loaded: boolean
  /** 失败原因，用于界面提示与日志 */
  reason?: string
  /** 加载到的对象，供调用方等待瓦片就绪后采样高度 */
  tileset?: Cesium.Cesium3DTileset
}

/**
 * 取根瓦片的等待上限（毫秒）。
 *
 * 这个上限不是「优化」，是**必需**：外网不通时 `Cesium3DTileset.fromUrl`
 * 会一直挂着——丢包而不是拒绝连接，fetch 既不 resolve 也不 reject。
 * 没有上限的话整个建场景流程就停在这一行：相机不定位、程序化场景不构建，
 * 三维区永远空白，而且控制台只有一条 Google geocoder 的警告，看不出卡在哪。
 * 实测（断网环境）挂起时间超过 35s 仍无结果。
 */
const ONLINE_3D_TIMEOUT_MS = 15000

/**
 * 给可能永不落地的 Promise 加一个上限，超时返回 null。
 *
 * 超时后原 Promise 若仍然后续返回，那个 tileset 要销毁掉，否则
 * 它会在后台继续拉瓦片、占着 viewer 之外的资源。
 */
function withTimeout<T extends { destroy(): void }>(
  p: Promise<T>,
  ms: number
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      resolve(null)
    }, ms)

    p.then(
      (value) => {
        if (timedOut) {
          try {
            value.destroy()
          } catch {
            /* 还没初始化完就销毁会抛，忽略即可 */
          }
          return
        }
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (timedOut) return
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 等待 3D Tiles **把当前视野的瓦片加载完**。
 *
 * 目前没有调用方——设施的高度改由离线 DEM + 场坪统一给（见 sampleGroundHeights
 * 的注释），不再向实景瓦片求交，所以不需要等它加载。
 *
 * 保留在这里是给后续「按实景表面摆放」的需求备用的：
 * 判据必须用 `tilesLoaded`（Cesium 对「当前视野该加载的都加载了」的定义）
 * 而不是瓦片计数——只等「有一批瓦片」时相机附近往往还是低层级，
 * 求交拿到的是粗糙表面，实测能差出 40 多米。
 */
export async function waitForTilesetContent(
  tileset: Cesium.Cesium3DTileset,
  timeoutMs = 30000
): Promise<boolean> {
  // `statistics` 运行时存在（Cesium3DTilesetStatistics），但没写进类型定义，
  // 这里收窄成一个最小接口，避免整段退化成 any
  const stats = (
    tileset as unknown as {
      statistics: { numberOfTilesWithContentReady: number }
    }
  ).statistics

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // 既要当前视野加载完，也要确实有内容（防止空 tileset 直接判定就绪）
    if (tileset.tilesLoaded && (stats?.numberOfTilesWithContentReady ?? 0) > 0) {
      return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/**
 * 加载在线实景三维。
 *
 * 与 `loadMineTileset` 的定位一致：成功就用它替代程序化场景，
 * 失败则什么都不做，交给调用方回退。
 */
export async function loadOnlinePhotorealistic3D(
  viewer: Cesium.Viewer
): Promise<Online3DResult> {
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN
  if (!token) {
    return { loaded: false, reason: '未配置 VITE_CESIUM_ION_TOKEN，跳过在线实景三维' }
  }

  let tileset: Cesium.Cesium3DTileset | null = null
  try {
    tileset = await withTimeout(
      Cesium.createGooglePhotorealistic3DTileset(),
      ONLINE_3D_TIMEOUT_MS
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn('[online3d] 实景三维加载失败，回退程序化场景：', reason)
    return { loaded: false, reason }
  }

  if (!tileset) {
    const reason = `等待 ${ONLINE_3D_TIMEOUT_MS / 1000}s 仍未取到实景三维根瓦片（外网不通），回退程序化场景`
    console.warn(`[online3d] ${reason}`)
    return { loaded: false, reason }
  }

  // 实景三维自带几何与贴图，底下的地球与离线影像只会互相打架
  if (viewer.scene.globe) viewer.scene.globe.show = false

  viewer.scene.primitives.add(tileset)

  return { loaded: true, tileset }
}
