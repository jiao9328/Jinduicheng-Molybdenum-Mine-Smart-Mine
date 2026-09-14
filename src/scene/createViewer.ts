import * as Cesium from 'cesium'
import { createOfflineImageryLayer, OFFLINE_IMAGERY_ENABLED, type TileManifest } from './localImagery'
import { createOfflineTerrainProvider } from './localTerrain'

export const CESIUM_CONTAINER_ID = 'cesium-container'

export interface CreateViewerOptions {
  /** 离线底图瓦片清单；不传则用纯色地球 */
  imageryManifest?: TileManifest | null
  /** 底图瓦片目录，默认 map-tiles/imagery */
  imageryBaseUrl?: string
  /** 离线高程瓦片清单；不传则退回平坦椭球地形 */
  terrainManifest?: TileManifest | null
  /** 高程瓦片目录，默认 map-tiles/heights */
  terrainBaseUrl?: string
}

/** Viewer 基础配置：关闭所有默认控件，适合大屏嵌入 */
function viewerOptions(
  terrainProvider: Cesium.TerrainProvider
): Cesium.Viewer.ConstructorOptions {
  return {
    // 默认控件全部关闭，导航自己接管
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    scene3DOnly: true,
    // 大屏透明背景，露出页面渐变底色
    contextOptions: {
      webgl: {
        alpha: true
      }
    },
    // 底图由离线瓦片自行接管，这里不建默认图层，避免依赖 Cesium Ion
    baseLayer: false as unknown as Cesium.ImageryLayer,
    terrainProvider,
    requestRenderMode: false
  }
}

/**
 * 创建 Viewer 并应用大屏视觉配置。
 *
 * 底图优先使用本地离线瓦片（矿区内网环境常见），
 * 没有缓存数据时回退到纯色地球，界面依然可用。
 */
export function createViewer(
  container: HTMLElement | string,
  options: CreateViewerOptions = {}
): Cesium.Viewer {
  // 时钟必须在构造前设好，否则首帧会按系统时间算光照。
  //
  // ⚠️ **这几个参数是一组，动其中一个之前先看完这段。**
  //
  // 避灾路线上的「流动光带」不是动画组件画的，是 `flowMaterial` 的 GLSL 拿
  // `secondsOfDay(clock.currentTime)` 当相位算出来的（见 layers/flowMaterial.ts）。
  // 也就是说：**时钟不走，光带就是静止的**。
  // 原代码写死 `shouldAnimate: false`，指导文档 §7.1 要求的路线上动态流动光效
  // 一直是一张静态图，两年没人发现——因为它不报错、不告警、截图上看不出来。
  //
  // 三条设定各解决一个问题：
  // - `shouldAnimate: true` —— 时钟得真的走，缺了它下面两条都没意义。
  // - `clockRange: UNBOUNDED` —— **不能用 CLAMPED**。Cesium 的 Clock 构造函数在
  //   `startTime` 缺省时会把它 Clone 成 `currentTime`，`stopTime` 再缺省成
  //   `startTime + 1 天`；于是 CLAMPED 下时钟**走到「次日的同一时刻」就被钉死**，
  //   现象是「演示当场好好的，挂了一夜第二天不动了」，比一开始就不动更难查。
  //   注意 CLAMPED 只是把 currentTime 拉回边界，**并不会**把 shouldAnimate 置回
  //   false（我核对过 Cesium 源码 `Clock.prototype.tick`），所以它会安安静静停在
  //   边界上，控制台没有半句提示——这类「沉默的失效」正是要避开的。
  // - `startTime === currentTime` —— 两者不等时首帧的 secondsOfDay 会跳一次，
  //   光带相位跟着突跳一帧。写成同一个值，起手就是连续的。
  //
  // 副作用已逐条核过，全空：`sun`/`moon`/`skyAtmosphere.show` 都是 false、
  // `globe.enableLighting` 是 false、`animation`/`timeline` 控件没开；
  // 全库**没有任何** `SampledPositionProperty` / `CallbackProperty` 这类随时钟变化的
  // Property（唯一例外就是上面那条材质），也没有第二处读 `viewer.clock` 的代码。
  // 所以「让时钟走起来」只影响光带，不会让任何物体移动、任何光照变化。
  //
  // `SYSTEM_CLOCK_MULTIPLIER` + `multiplier: 1` 是 Cesium 的默认组合，这里显式写出
  // 是为了让人看得见：时钟按真实时间 1:1 走，光带约 6.25 秒走完一段（推导见 flowMaterial）。
  //
  // ⚠️ 这套机制依赖**渲染循环每帧都调 `clock.tick()`**，而 `requestRenderMode` 是 false
  // （见 viewerOptions），本来就每帧重绘。任何把渲染循环停掉的代码都会连带冻住光带——
  // 各巡检脚本为了截图都会停渲染循环，唯独 scripts/check-clock-motion.mjs **绝不能停**。
  const CLOCK_START = Cesium.JulianDate.fromIso8601('2025-06-21T12:00:00+08:00')
  const clock = new Cesium.Clock({
    startTime: CLOCK_START.clone(),
    currentTime: CLOCK_START.clone(),
    // 十年足够长，配 UNBOUNDED 只是为了让 stopTime > startTime 这个断言不炸
    stopTime: Cesium.JulianDate.addDays(CLOCK_START, 3650, new Cesium.JulianDate()),
    clockRange: Cesium.ClockRange.UNBOUNDED,
    shouldAnimate: true
  })

  // 地形要在 Viewer 构造时定下来，之后无法整体替换
  const terrainProvider =
    options.terrainManifest && OFFLINE_IMAGERY_ENABLED
      ? createOfflineTerrainProvider(options.terrainManifest, {
          baseUrl: options.terrainBaseUrl
        })
      : null

  // 必须经 ClockViewModel 传入：Viewer 的构造函数只读 clockViewModel，
  // 直接传 clock 会被静默忽略，时钟退回系统时间（ClockViewModel 即其适配器）
  const viewer = new Cesium.Viewer(container, {
    ...viewerOptions(terrainProvider ?? new Cesium.EllipsoidTerrainProvider()),
    clockViewModel: new Cesium.ClockViewModel(clock)
  })

  // 默认场景仍走离线瓦片（矿区现场常常没有外网），Ion 只是备选。
  // 令牌从 .env 读，没配就维持「不依赖 Ion」的原状。
  Cesium.Ion.defaultAccessToken = (import.meta.env.VITE_CESIUM_ION_TOKEN ?? '') as string

  // ---- 离线卫星底图 ----
  let imageryAttached = false
  if (options.imageryManifest && OFFLINE_IMAGERY_ENABLED) {
    const layer = createOfflineImageryLayer(
      options.imageryManifest,
      options.imageryBaseUrl
    )
    if (layer) {
      viewer.imageryLayers.add(layer)
      viewer.imageryLayers.lowerToBottom(layer)
      imageryAttached = true
    }
  }

  const scene = viewer.scene

  // ---- 大屏视觉 ----
  scene.backgroundColor = Cesium.Color.fromCssColorString('#040b1a')
  scene.fog.enabled = false
  scene.highDynamicRange = false
  scene.screenSpaceCameraController.enableCollisionDetection = false

  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = false
  }
  if (scene.moon) {
    scene.moon.show = false
  }
  // 保留平行光但压暗，让建筑有明暗面，不至于死黑
  if (scene.sun) {
    scene.sun.show = false
  }
  if (scene.light) {
    scene.light.intensity = 1.35
  }

  if (scene.globe) {
    // 底图未覆盖的区域（矿区之外）用深空色兜底，避免出现纯白地球
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#07182b')
    scene.globe.showGroundAtmosphere = false

    // 有离线影像时必须让地球参与渲染，否则影像图层无处可贴；
    // 接了真实地形时同理——地形也要贴在地球上。
    // 两者都没有才隐藏地球，退回深空背景 + 程序化场景。
    scene.globe.show = imageryAttached || terrainProvider !== null

    // 影像本身是白天实拍，关闭地形光照计算以免整体发灰
    scene.globe.enableLighting = false

    // 影像层级越深瓦片越多，屏幕空间误差放宽一些，
    // 避免在弱显卡机器上为了追求细节把瓦片队列堆爆。
    scene.globe.maximumScreenSpaceError = 4
  }

  // 地球已加载但迟迟没有瓦片落地（弱显卡 / 瓦片服务不可达）时，
  // 自动退回不依赖影像的呈现方式，保证三维区不会是空的。
  if (imageryAttached) {
    watchImageryFallback(viewer)
  }

  // 开发期诊断入口（与 useCesium 里的一致，便于在任意页面拿到实例）
  Object.assign(window as never, { __cesiumViewer: viewer, __cesiumNS: Cesium })

  // 关闭抗锯齿以换取大屏流畅度；需要更锐利可打开
  scene.postProcessStages.fxaa.enabled = true

  return viewer
}

/**
 * 观察离线底图有没有真的在工作，**只报诊断，不动画面**。
 *
 * ## 这里曾经是一个会「永久删掉底图」的兜底，已改成只警告
 *
 * 原实现是：从 viewer **创建**起计时 12 秒，到点若 `loadedTileCount` 还是 0，
 * 就 `imageryLayers.removeAll(true)` 再把 `globe.show = false`。
 *
 * 它踩的是**时序**：计时起点是 viewer 创建，而那正是主线程马上要被
 * `buildMineScene` 占满的时刻（建场景要采几百个点的高程，改前会卡几分钟）。
 * 影像瓦片的请求本来就排在场景构建后面，12 秒内一张都发不出去是常态。
 * 于是这个「兜底」在正常机器上稳定误触发，把**好端端的底图整个删掉且不可恢复**
 * ——用户看到的就是「滚轮缩放之后 Cesium 底图消失了」，刷新才好。
 * 实测复现：`globe.show=false`、`imageryLayers.length` 归 0，
 * 相机从 3429m 一路缩到 33880m 底图都不回来。
 *
 * ## 为什么改成「只警告」而不是「改个更准的判据」
 *
 * 因为**这个兜底本来就换不来任何东西**：断掉影像后 Cesium 会用
 * `globe.baseColor`（深空色）铺满球面，和 `globe.show=false` 露出的页面底色
 * （`$bg-deep`）几乎分辨不出——两种「没有底图」长得一样，
 * 但一个可恢复、一个不可恢复。删图层唯一的作用是让故障无法自愈。
 *
 * 真正需要防的是原注释里说的 `_imageryCache` 无限增长，
 * 那来自 `localImagery.ts` 里 `minimumLevel` 的旧写法（已修，见该文件长注释），
 * 与这里无关。
 *
 * 判据仍然保留，但只用来决定「要不要打这条警告」：
 * 必须「**请求发出了不少、却一张都没回来**」才算链路断了；
 * 只有 `loadedTileCount === 0` 分不出「服务坏了」和「还没轮到请求」。
 */
function watchImageryFallback(viewer: Cesium.Viewer) {
  const start = Date.now()
  const TIMEOUT = 12000
  /** 观察窗口的硬上限：到点无论结论如何都停，别留一个常驻的 1s 定时器 */
  const GIVE_UP = 60000

  /** 汇总所有图层的请求数与落地数 */
  const counters = () => {
    let requested = 0
    let loaded = 0
    const layers = viewer.imageryLayers
    for (let i = 0; i < layers.length; i++) {
      const provider = layers.get(i).imageryProvider as unknown as {
        loadedTileCount?: number
        requestedTileCount?: number
      }
      requested += provider?.requestedTileCount ?? 0
      loaded += provider?.loadedTileCount ?? 0
    }
    return { requested, loaded }
  }

  const check = () => {
    if (viewer.isDestroyed()) return

    const globe = viewer.scene.globe
    if (globe.tilesLoaded) return // 已加载出来，停止观察

    const { requested, loaded } = counters()
    if (loaded > 0) return // 链路是通的，剩下只是流式加载

    if (requested > 0 && Date.now() - start > TIMEOUT) {
      console.warn(
        '[cesium] 离线底图瓦片已请求 ' +
          `${requested} 张但一张都没落地，` +
          '底图链路可能不通。图层与地球保持挂载（不会移除），' +
          '请确认 public/map-tiles 下的瓦片完整、且显卡支持 WebGL2。'
      )
      return
    }

    if (Date.now() - start > GIVE_UP) return // 一直没轮到请求，静默收工
    window.setTimeout(check, 1000)
  }

  window.setTimeout(check, 1000)
}

/** 销毁 Viewer，释放 WebGL 上下文 */
export function destroyViewer(viewer: Cesium.Viewer | null | undefined) {
  if (!viewer || viewer.isDestroyed()) return
  viewer.destroy()
}
