import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import * as Cesium from 'cesium'
import type { Viewer } from 'cesium'
import { createViewer, destroyViewer } from './createViewer'
import { buildMineScene } from './buildMineScene'
import { flyToWaypoint, setWaypoint } from './camera'
import { loadTileManifest } from './localImagery'
import { loadTerrainManifest, prewarmTerrainTiles } from './localTerrain'
import { loadMineTileset } from './tileset'
import { loadOnlinePhotorealistic3D, ONLINE_3D_ENABLED } from './online3d'
import { HOME_WAYPOINT, type SceneWaypoint } from './sceneConfig'

/**
 * 场景构建回调：拿到 viewer 后往里加业务图层。
 *
 * 允许返回 Promise —— 业务图层的高度要从三维底座采样，
 * 采样是异步的，图层必须建完才能算数。
 */
export type SceneBuilder = (viewer: Viewer) => void | Promise<void>

export interface UseCesiumOptions {
  containerId?: string
  /**
   * 业务图层构建器：在底图场景之上叠加本页自己的内容
   *（安全标注、避灾路线、设备点位等）。
   *
   * 底图场景（3D Tiles 或程序化矿区）由本 hook 统一负责，
   * 这里不需要再调 buildMineScene。
   */
  build?: SceneBuilder | null
  /** 初始机位，默认俯瞰全矿区 */
  home?: SceneWaypoint
  /**
   * 是否尝试加载倾斜摄影 3D Tiles。
   * 加载成功时用它替代程序化场景；没有模型目录时自动退回程序化场景。
   */
  useTileset?: boolean
}

/**
 * 在组件里挂载一个 Cesium Viewer。
 * 组件挂载后自动创建 + 建场景 + 定位相机，卸载自动销毁。
 */
export function useCesium(options: UseCesiumOptions | string = {}) {
  const opts: UseCesiumOptions = typeof options === 'string' ? { containerId: options } : options
  const containerId = opts.containerId ?? 'cesium-container'
  /**
   * 页面自定义的业务图层构建器。
   *
   * 默认**不挂任何东西**——基础场景（实景三维 / 本地 3D Tiles / 程序化场景）
   * 统一由下面的优先级链负责，页面传进来的 build 只用来叠加自己的标注。
   *
   * 这里曾经默认成 `buildMineScene`，导致不传 build 的页面（首页）
   * 会被调用两次：一次是优先级链里的显式调用，一次是这里的兜底。
   * 以前没有真实模型，两次建的场景互相覆盖、看不出异常；
   * 接上在线实景三维后就露馅了——程序化场景会和实景三维重叠在一起。
   */
  const builder = opts.build ?? null
  const home = opts.home ?? HOME_WAYPOINT
  const useTileset = opts.useTileset ?? true

  const viewer = shallowRef<Viewer | null>(null)
  const ready = ref(false)
  /** 是否用上了真实的 3D Tiles 模型 */
  const hasRealModel = ref(false)

  /**
   * 建好但**还没走完构建流程**的 viewer 引用。
   *
   * `viewer.value` 是在整条异步链末尾才赋值的（建场景要好几秒），
   * 在此之前组件被卸载的话，`onBeforeUnmount` 里的 `destroyViewer(viewer.value)`
   * 拿到的是 null —— viewer 和它的 WebGL 上下文就永远漏掉了。
   * 漏几个之后浏览器就不再给新的 WebGL 上下文，表现为三维区整片空白，
   * 而且刷新才好，极难排查。所以创建后立刻用局部引用记下来。
   */
  let pendingViewer: Viewer | null = null
  /** 组件是否还挂着；每个 await 之后都要复查，卸载了就停止往下建 */
  let alive = true

  onMounted(async () => {
    // ---- 提前缓存：先把矿区那一带的 DEM 瓦片取回来 ----
    //
    // 必须赶在 `createViewer` **之前**落地。
    //
    // 建场景那 410 个采样点只落在 4 张 DEM 瓦片上，可是实测要 5.3 秒才取回来
    // ——单张瓦片空闲时只要 15~50ms，那 5.3 秒全花在**跟 Cesium 抢同域连接**上
    //（建地球会一次开几百个瓦片请求，把它们挤到队尾）。而这里、`createViewer`
    // 还没调用的这一刻，连接池是空的，几张瓦片一两百毫秒就回来。
    //
    // 所以先把它发出去（不 await，好和下面的清单请求并行），
    // 取完清单再回过头等它 —— 见下面的 `PREWARM_BUDGET_MS`。
    //
    // 放在 `useCesium` 里而不是应用启动处：只有真的要用三维的页面才会走到这，
    // 纯数据页（生产管理 / 分析决策等）不该白下载几 MB 地形瓦片。
    const prewarm = prewarmTerrainTiles()

    // 等一帧，确保容器已完成布局，避免拿到 0 尺寸
    await nextFrame()

    const el = document.getElementById(containerId)
    if (!el) {
      console.warn(`[cesium] 未找到容器 #${containerId}`)
      return
    }

    // 先取离线底图与高程清单，再建 Viewer ——
    // 影像图层与地形提供器都必须在构造时就能确定层级范围。
    // 高程清单与预热共用同一份缓存（见 `loadTerrainManifest`），不会重复请求。
    const [imageryManifest, terrainManifest] = await Promise.all([
      loadTileManifest(),
      loadTerrainManifest()
    ])

    // 取清单期间也可能被卸载
    if (!alive) return

    // 等预热落地 —— **但有上限**。
    //
    // 预热是纯加速，绝不能变成新的卡点：瓦片服务慢或不可达时，
    // 到点就往下走，让建场景自己去取（那只是回到优化前的耗时，不是故障）。
    const warmed = await Promise.race([
      prewarm.then(() => true),
      delay(PREWARM_BUDGET_MS).then(() => false)
    ])
    if (!warmed) {
      console.info(`[terrain] 预热 ${PREWARM_BUDGET_MS}ms 未完成，不再等，继续建场景`)
    }

    // 等预热的这段时间里也可能被卸载
    if (!alive) return

    const v = createViewer(el, { imageryManifest, terrainManifest })
    pendingViewer = v

    // 相机先就位，**优先于任何底座加载**。
    //
    // 曾经把它放在下面的底座优先级链之后，结果在线实景三维断网挂起时，
    // 相机停在西半球默认视角、程序化场景也没建，三维区一片黑——
    // 定位相机不该依赖「用哪个底座」，底座加载失败更不该连累它。
    //
    // 机位同样要早于 buildMineScene：场景是异步建出来的，
    // 用户先看到的应该是矿区全景，而不是建构过程中的空白地球。
    setWaypoint(v, home)

    // 三维底座的优先级：
    //   1. 在线实景三维（真实倾斜摄影，需外网 + 商用授权，见 online3d.ts）
    //   2. 本地倾斜摄影 3D Tiles（甲方提供的成果）
    //   3. 程序化示意场景（离线可用，兜底）
    let realModelLoaded = false
    let realTileset: Cesium.Cesium3DTileset | undefined

    if (ONLINE_3D_ENABLED) {
      const online = await loadOnlinePhotorealistic3D(v)
      realModelLoaded = online.loaded
      realTileset = online.tileset
      if (!online.loaded && online.reason) {
        console.info(`[online3d] ${online.reason}`)
      }
    }

    if (!realModelLoaded && useTileset) {
      const result = await loadMineTileset(v)
      realModelLoaded = result.loaded
      realTileset = result.tileset
      if (!result.loaded && result.reason) {
        console.info(`[tileset] ${result.reason}`)
      }
    }

    // 底座加载也要等好几秒，卸载了就不必再建场景
    if (!alive) return

    hasRealModel.value = realModelLoaded

    // 底图场景统一由这里负责：
    // 有真实模型就直接用，没有才搭程序化示意场景。
    // 各页面通过 build 传进来的回调只负责叠加自己的业务图层。
    //
    // 设施部分始终构建，实景三维只替代**地形底座**（采坑 / 排土场 / 尾矿库）。
    // 参考图就是这个形态：真实地形做底，风格化的厂房、筒仓、皮带廊叠在上面。
    await buildMineScene(v, { withTerrainBase: !realModelLoaded })

    // 建场景是最长的一段，之后再复查一次
    if (!alive) return

    await builder?.(v)

    if (!alive) return

    viewer.value = v
    ready.value = true

    // 诊断入口：build 产物也要能被检查脚本读到。
    // 注意不能挂到 window.Cesium —— Cesium 命名空间对象禁止赋值。
    Object.assign(window as never, { __cesiumViewer: v, __cesiumNS: Cesium })
  })

  onBeforeUnmount(() => {
    alive = false

    // 无论构建走到哪一步，都要把已经创建出来的 viewer 销毁掉。
    // pendingViewer 和 viewer.value 可能是同一个（正常情况），
    // destroyViewer 自带 isDestroyed 判断，重复调用是安全的。
    destroyViewer(pendingViewer)
    destroyViewer(viewer.value)
    pendingViewer = null
    viewer.value = null
    ready.value = false

    // 清掉诊断入口：留着会指向一个已销毁的实例。
    // 检查脚本读到的会是「有 viewer、但 entities 为 0、相机在默认位置」
    // 这种极具迷惑性的状态——排查时会被带偏很久。
    const w = window as never as { __cesiumViewer?: Viewer }
    if (w.__cesiumViewer && w.__cesiumViewer.isDestroyed()) {
      delete w.__cesiumViewer
    }
  })

  /** 飞到指定机位（数字孪生页底部 Tab 用） */
  function flyTo(wp: SceneWaypoint, duration = 2.5) {
    if (!viewer.value) return Promise.resolve()
    return flyToWaypoint(viewer.value, wp, duration)
  }

  return { viewer, ready, flyTo }
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

/**
 * 等预热的上限（毫秒）。
 *
 * 取 2500 的依据：预热 9 张瓦片、并发 6，空闲时单张 15~50ms，
 * 两轮就完事，实测在 200ms 量级 —— 留了十倍余量。
 * 真到点了说明瓦片服务这会儿不正常，多等的每一毫秒都是白等，
 * 不如把主线程让给建场景。
 */
const PREWARM_BUDGET_MS = 2500

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
}
