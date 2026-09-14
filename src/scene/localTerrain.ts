import * as Cesium from 'cesium'
import { loadTileManifest, type TileManifest } from './localImagery'

/**
 * 离线真实高程地形。
 *
 * 瓦片由 scripts/fetch-map-tiles.mjs 抓取到 public/map-tiles/heights/，
 * 数据源是 AWS Terrarium DEM（Mapzen 整理的公开高程，编码在 PNG 的 RGB 通道里）。
 *
 * 在此之前场景用的是 `EllipsoidTerrainProvider`——一个完全平坦的椭球，
 * 矿区的地形起伏全靠手搓的「山体」椭球假装。接入真实 DEM 后，
 * 秦岭北麓的沟谷山脊、以及露天采坑本身的凹陷都是真实测量出来的。
 *
 * ## 为什么不用 `extends Cesium.TerrainProvider`
 *
 * Cesium 的 `TerrainProvider` 是个不可实例化的抽象基类：
 * 构造函数体直接 `DeveloperError.throwInstantiationError()`，
 * 且 `tilingScheme` / `availability` / `errorEvent` 等成员都是原型上
 * `get: throwInstantiationError` 的取值器。`extends` 它的话 `super()` 第一步就抛。
 *
 * Cesium 自身也不对着它做 `instanceof` 检查（全仓库检索无命中），
 * 运行时只按鸭子类型访问下面这些成员，所以这里直接提供一个形状匹配的对象。
 */

/** Terrarium 高程解码：height = (R * 256 + G + B / 256) - 32768（单位：米） */
const TERRARIUM_OFFSET = 32768

/** 实测瓦片边长，Terrarium 固定 256 */
const TILE_SIZE = 256

/**
 * 兜底地形的网格边长。
 *
 * 用 16×16 而不是 256×256：缓存范围之外的地球表面会请求大量瓦片，
 * 每块都按 256×256 去三角化会白白吃掉可观的 CPU。
 * Cesium 自带的 `EllipsoidTerrainProvider` 也正是用 16×16 兜底的。
 */
const FALLBACK_GRID = 16

/** 高程瓦片基础路径 */
const TERRAIN_BASE_URL = 'map-tiles/heights'

/**
 * 兜底地形的高程（米）。
 *
 * 缓存范围之外没有实测数据，用同一高度的平面填充，
 * 这样地球整体依然完整可渲染，不会出现空洞。
 * 取值贴近矿区地面标高，避免缓存边界处出现突兀的断崖——
 * 金堆城钼矿地面标高约 1211m。
 */
const DEFAULT_FALLBACK_ELEVATION = 1200

/** Float32 高程数组的结构描述：每元素 1 个高度值，不做额外缩放 */
const FLOAT_STRUCTURE = {
  heightScale: 1,
  heightOffset: 0,
  elementsPerHeight: 1,
  stride: 1,
  elementMultiplier: 1,
  isBigEndian: false
} as const

/**
 * 读取已缓存的高程瓦片清单，无缓存时返回 null。
 *
 * 直接复用影像那套 manifest 结构（层级 → 瓦片列表 + 范围），
 * 抓取脚本对两个数据源产出的格式是一样的。
 *
 * 默认目录的那一份**只真正请求一次**：预热与建场景都要用它，
 * 各取一次就是两次网络往返（响应头是 `no-cache`，浏览器不会替我们省）。
 */
export function loadTerrainManifest(
  baseUrl = TERRAIN_BASE_URL
): Promise<TileManifest | null> {
  if (baseUrl !== TERRAIN_BASE_URL) return loadTileManifest(baseUrl)
  if (!terrainManifestPromise) terrainManifestPromise = loadTileManifest(baseUrl)
  return terrainManifestPromise
}

/** 默认目录清单的共享 Promise，避免重复请求 */
let terrainManifestPromise: Promise<TileManifest | null> | null = null

export class OfflineTerrariumTerrainProvider {
  /**
   * Terrarium 是标准 XYZ 切片，与 Cesium 的 Web Mercator 方案同源：
   * 原点都在西北角，y 向南递增，编号可以直接对应。
   */
  readonly tilingScheme = new Cesium.WebMercatorTilingScheme()

  /** Cesium 会往这里挂错误监听，必须是个真实例 */
  readonly errorEvent = new Cesium.Event()

  /** 高程数据来源署名 */
  readonly credit = new Cesium.Credit('地形：AWS Terrarium DEM（Mapzen 整理）')

  readonly hasWaterMask = false
  readonly hasVertexNormals = false
  readonly ready = true

  /**
   * 瓦片可用性四叉树。
   *
   * 必须提供，不能省：Cesium 的全球表面细分要靠它判断哪一级有数据，
   * 拿不到会抛「requires a terrain provider that has tile availability」，
   * 地形整个建不起来。
   *
   * `getTileDataAvailable` 仍然保留：它负责逐块回答「这块瓦片有没有数据」，
   * 返回 false 时 Cesium 会把瓦片标记为 FAILED 并从父级上采样。
   * 两者职责不同，缺一不可。
   */
  readonly availability: Cesium.TileAvailability

  private readonly manifest: TileManifest
  private readonly baseUrl: string
  private readonly fallbackElevation: number
  private readonly levelZeroError: number

  /** 兜底平面：所有缺失瓦片共用，内容只读 */
  private fallbackTile: Cesium.HeightmapTerrainData | null = null

  constructor(options: {
    baseUrl?: string
    manifest: TileManifest
    /** 缓存范围外兜底平面的高程（米） */
    fallbackElevation?: number
  }) {
    this.manifest = options.manifest
    this.baseUrl = options.baseUrl ?? TERRAIN_BASE_URL
    this.fallbackElevation = options.fallbackElevation ?? DEFAULT_FALLBACK_ELEVATION

    this.levelZeroError =
      Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
        this.tilingScheme.ellipsoid,
        TILE_SIZE,
        this.tilingScheme.getNumberOfXTilesAtLevel(0)
      )

    this.availability = this.buildAvailability()
  }

  /** 已缓存的最深层级，超过它就不再细分 */
  private get maxCachedLevel(): number {
    const levels = Object.keys(this.manifest)
      .map(Number)
      .filter(Number.isFinite)
    return levels.length ? Math.max(...levels) : 0
  }

  /**
   * 用已缓存的瓦片构建可用性四叉树。
   *
   * 逐张登记而不是用 min/max 包围盒：包围盒会把中间没抓到的瓦片
   * 也标成可用，那些位置就会在真实地形里露出等高平面的补丁。
   */
  private buildAvailability(): Cesium.TileAvailability {
    const scheme = this.tilingScheme
    const tree = new Cesium.TileAvailability(scheme, this.maxCachedLevel)

    // 必须先铺满 0 级。`addAvailableTileRange` 是把范围挂到已有根节点上的，
    // rootNodes 为空时后续所有调用都会被静默丢弃，整棵树是空的。
    const zeroX = scheme.getNumberOfXTilesAtLevel(0) - 1
    const zeroY = scheme.getNumberOfYTilesAtLevel(0) - 1
    tree.addAvailableTileRange(0, 0, 0, zeroX, zeroY)

    for (const [levelKey, entry] of Object.entries(this.manifest)) {
      const level = Number(levelKey)
      if (!Number.isInteger(level)) continue
      for (const tile of entry.tiles) {
        const [x, y] = tile.split('/').map(Number)
        if (!Number.isInteger(x) || !Number.isInteger(y)) continue
        tree.addAvailableTileRange(level, x, y, x, y)
      }
    }

    return tree
  }

  /**
   * 这块瓦片有没有实测数据。
   *
   * 必须返回确定的布尔值，不能返回 undefined：
   * `GlobeSurfaceTileProvider.canRefine` 用 `!== undefined` 判断能否继续细分，
   * 返回 undefined 会让瓦片树停止细分。
   *
   * 返回 false 时 Cesium 会把该瓦片标记为 FAILED，转而从父级上采样——
   * 正是缓存范围之外想要的效果：0 级兜底平面往下一路铺开。
   */
  getTileDataAvailable(x: number, y: number, level: number): boolean {
    // 0 级必须可用：它是整棵瓦片树的根，也是缓存范围外的上采样来源
    if (level === 0) return true

    const entry = this.manifest[String(level)]
    if (!entry) return false
    return entry.tiles.includes(`${x}/${y}`)
  }

  /**
   * 该层级瓦片的最大几何误差（米）。
   *
   * Cesium 拿它算屏幕空间误差：`误差 × 屏幕高 / (距离 × 视锥系数)`，
   * **大于** `maximumScreenSpaceError`（默认 2 像素）就再细分一级。
   * 所以这个值必须随层级**单调不增**——变小才停止细分。
   *
   * 这里踩过一个坑，代价是整个三维区黑屏：曾经写成「超过最深缓存层级就返回
   * `levelZeroError`」，想让 Cesium 别再细分，方向刚好反了。
   * 14 级（缓存最深处）是 `levelZeroError / 2¹⁴ ≈ 9.5` 米，15 级一下子跳回
   * `levelZeroError ≈ 156543` 米，误差放大一万六千倍 → 每一帧都在要求继续细分
   * → 四叉树无限下钻 → 层级越过 31 时 Cesium 的 `traversalQuadsByLevel[level]`
   * 取到 undefined，读它的 `.southwest` 抛
   * 「Cannot read properties of undefined (reading 'southwest')」。
   * 致命之处在于**抛出的位置**：它发生在 `scene.render()` 的瓦片筛选里，
   * 不是从我们的 `await` 处抛出，调用方 try/catch 拦不住，
   * 异常直接触发 `scene.renderError` → **Cesium 停止渲染，三维区永久黑屏**。
   * 只在「定位」时复现：相机贴到地面才需要那么深的细分。
   *
   * 正确做法是到最深处直接给 0：屏幕空间误差恒为 0，细分天然停在
   * 我们真正有数据的那一级，也不会再去请求更深层的瓦片。
   */
  getLevelMaximumGeometricError(level: number): number {
    if (level >= this.maxCachedLevel) return 0
    // 用 2 ** level 而不是 1 << level：JS 的位运算是 32 位，
    // `1 << 31` 是负数，这里必须撑得住任意深的层级
    return this.levelZeroError / 2 ** level
  }

  requestTileGeometry(
    x: number,
    y: number,
    level: number,
    request?: Cesium.Request
  ): Promise<Cesium.TerrainData> {
    if (!this.getTileDataAvailable(x, y, level)) {
      return Promise.resolve(this.getFallbackTile())
    }
    return this.fetchAndDecode(x, y, level, request)
  }

  /** 取兜底平面（首次调用时创建；16×16 的浮点高度，仅 1KB） */
  private getFallbackTile(): Cesium.HeightmapTerrainData {
    if (!this.fallbackTile) {
      const buffer = new Float32Array(FALLBACK_GRID * FALLBACK_GRID)
      buffer.fill(this.fallbackElevation)
      this.fallbackTile = new Cesium.HeightmapTerrainData({
        buffer,
        width: FALLBACK_GRID,
        height: FALLBACK_GRID,
        childTileMask: 0,
        structure: FLOAT_STRUCTURE
      })
    }
    return this.fallbackTile
  }

  private async fetchAndDecode(
    x: number,
    y: number,
    level: number,
    request?: Cesium.Request
  ): Promise<Cesium.TerrainData> {
    const heights = await loadTerrariumHeights(x, y, level, this.baseUrl, request)
    if (!heights) return this.getFallbackTile()

    return new Cesium.HeightmapTerrainData({
      buffer: heights,
      width: TILE_SIZE,
      height: TILE_SIZE,
      structure: FLOAT_STRUCTURE
    })
  }
}

/**
 * 取一张 Terrarium 瓦片并解码成米制高程，失败返回 null。
 *
 * 地形提供器与 `sampleGroundHeights` 共用这一段——两边的取瓦片方式
 * 必须完全一致，否则「贴在地形上的地物」和「地形本身」会来自不同数据。
 */
async function loadTerrariumHeights(
  x: number,
  y: number,
  level: number,
  baseUrl: string,
  request?: Cesium.Request
): Promise<Float32Array | null> {
  // ---- 采样路径走缓存 ----
  //
  // 必须缓存，而且缓存的是**解码后的 Float32Array**，不是「已 fetch」：
  // `sampleGroundHeights` 是按点逐个调的，而几百个采样点往往挤在**同一张** DEM 瓦片里
  // （皮带廊按 20m 加密后，主廊 1.8km 一条就是 90 个点）。
  // 没有这层缓存时，每个点都把同一张 PNG 重新 fetch 一遍、再 decode 一遍
  // （256×256 = 65536 次循环）——实测量到同一张 `14/13195/6526.png`
  // 每 3.7 秒被重取一次、永不停止，建场景流程几分钟走不完。
  //
  // **带 `request` 的调用不进缓存**：那是 Cesium 地球在渲染地形瓦片，
  // 相机移动时会给 `request.cancelFunction` 挂取消回调。
  // 把可能被取消的 Promise 缓存下来，之后所有调用都会拿到那个 null。
  // 而且地球那条路 Cesium 自己就有瓦片缓存，本来也不会重复请求同一张。
  if (!request) {
    // 键里带上 baseUrl：换了瓦片目录后旧缓存不该被复用
    const key = `${baseUrl}|${level}/${x}/${y}`
    let pending = decodedTiles.get(key)
    if (!pending) {
      tileFetchCount++
      pending = fetchAndDecodeTile(x, y, level, baseUrl, undefined).then((result) => {
        // **失败不进缓存。** 缓存的是「这次取瓦片的结果」，一次瞬时网络抖动
        // 要是被记住，之后每次采样都会拿到那个 null，那一块地形就永远缺着
        // ——而且没有任何报错，只是地物高度悄悄回落到兜底值。
        // 删掉条目，下次调用自然会重试。
        if (!result) decodedTiles.delete(key)
        return result
      })
      decodedTiles.set(key, pending)
      // 有界淘汰：FIFO 丢掉最早插入的那张。
      // 单张 256×256 的 Float32 是 256KB，不设上限的话长时间跑会一直涨。
      if (decodedTiles.size > MAX_CACHED_TILES) {
        const oldest = decodedTiles.keys().next().value
        if (oldest !== undefined) decodedTiles.delete(oldest)
      }
    }
    return pending
  }

  return fetchAndDecodeTile(x, y, level, baseUrl, request)
}

/**
 * 已解码的 DEM 瓦片：key = `层级/瓦片X/瓦片Y`。
 *
 * 存的是 **Promise** 而不是结果，这样「同一张瓦片被并发请求多次」也只跑一遍
 * 网络 + 解码——皮带廊的采样点完全可能同时命中同一张瓦片。
 */
const decodedTiles = new Map<string, Promise<Float32Array | null>>()

/**
 * 缓存上限（张）。按 256KB/张算，384 张约 96MB 封顶。
 *
 * 实际工作集远小于它：矿区那一带 12~17 级一共几百张，一次采样通常只碰几十张。
 * 设这个上限只是为了「跑久了内存不会无限涨」。
 */
const MAX_CACHED_TILES = 384

/**
 * 采样路径**真正去取瓦片**的累计次数（缓存命中不计）。
 *
 * 只用来给 `sampleGroundHeights` 出一行可信的读数。
 * 之前那行日志写的是 `decodedTiles.size`，那是**缓存总大小**，
 * 不是「本次采样碰了几张」——预热一开，它就从 4 变成 22，
 * 看起来像「采样变重了」，其实正相反。读数误导比没有读数更糟。
 */
let tileFetchCount = 0

/** 真正去取瓦片并解码的那一段（缓冲区、色彩管理、损坏拦截详见下面注释） */
async function fetchAndDecodeTile(
  x: number,
  y: number,
  level: number,
  baseUrl: string,
  request?: Cesium.Request
): Promise<Float32Array | null> {
  const url = `${baseUrl}/${level}/${x}/${y}.png`

  // Cesium 取消请求时会调用 cancelFunction，接上以免相机移动时白白解码
  const controller = new AbortController()
  if (request && typeof request.cancelFunction === 'function') {
    request.cancelFunction = () => controller.abort()
  }

  let response: Response
  try {
    response = await fetch(url, { signal: controller.signal })
  } catch {
    // 离线环境或瓦片缺失：退回兜底，不让整块地形崩掉
    return null
  }

  if (!response.ok) return null

  // 只有真是图片才解码。
  //
  // 不能只靠 `response.ok` 判断瓦片是否存在：dev / preview 是 SPA 服务，
  // 请求一个不存在的 .png 会走前端路由兜底，返回 **200 + index.html**。
  // 这时 ok 是真的，接着 createImageBitmap 会因为拿到 HTML 而抛
  // 「InvalidStateError: The source image could not be decoded」。
  //
  // 这个错误后果极严重，不是「少一块地形」：0 级瓦片是整棵四叉树的根
  //（getTileDataAvailable 对它固定返回 true），根本解码失败 → 0 级被标记成
  // FAILED → 整棵瓦片树停止细分 → **所有影像都停在 0 级**（我们的缓存从 12 级起，
  // 0 级一律拿到透明占位图）→ 地球整片全黑，三维模型悬在空处。
  // 实测控制台只有一行 terrain 报错，很容易被当成无害噪声忽略。
  const type = response.headers.get('content-type') ?? ''
  if (!type.startsWith('image/')) return null

  let bitmap: ImageBitmap
  try {
    const blob = await response.blob()
    // 关键：必须禁用色彩空间转换。Terrarium 把高程编码在 RGB 三个通道里，
    // 浏览器默认会对 PNG 做 sRGB 转换，哪怕只差 1 个色阶，
    // 换算成高程就是几十米的误差。
    bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' })
  } catch {
    // 拦下截断 / 损坏的瓦片：宁可这块用兜底，也不能让整棵地形树停在这一块上
    return null
  }

  try {
    return decodeTerrarium(bitmap)
  } finally {
    bitmap.close()
  }
}

/**
 * 把 Terrarium PNG 解码成米制高程。
 *
 * 走 canvas 取像素，所以取像素前不能有任何色彩管理介入
 *（见 `createImageBitmap` 处的说明）。
 */
function decodeTerrarium(bitmap: ImageBitmap): Float32Array {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return new Float32Array(bitmap.width * bitmap.height)

  ctx.drawImage(bitmap, 0, 0)
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)

  const heights = new Float32Array(bitmap.width * bitmap.height)
  for (let i = 0; i < heights.length; i++) {
    const p = i << 2
    heights[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - TERRARIUM_OFFSET
  }
  return heights
}

/**
 * 创建离线地形提供器；失败时返回 null，调用方回退到椭球地形。
 *
 * 返回值按 `Cesium.TerrainProvider` 交给 Viewer —— 运行时是鸭子类型，
 * 类型上用一次断言把这层「Cesium 抽象基类不可实例化」的事实说明白。
 */
export function createOfflineTerrainProvider(
  manifest: TileManifest,
  options: { baseUrl?: string; fallbackElevation?: number } = {}
): Cesium.TerrainProvider | null {
  try {
    const provider = new OfflineTerrariumTerrainProvider({ ...options, manifest })
    return provider as unknown as Cesium.TerrainProvider
  } catch (err) {
    console.warn('[terrain] 离线地形创建失败，回退到椭球地形', err)
    return null
  }
}

/**
 * 批量采样地物所在位置的地面高度。
 *
 * 直接读离线 DEM 瓦片，**不经过 Cesium 的地形采样 API**——
 * 原因见 `sampleOnePoint` 的注释，简言之：那条路会以异常结束整个渲染循环。
 *
 * 拿不到高度的点回落到 `fallback`（矿区地面标高），并打一条日志——
 * 静默回落会让标注莫名其妙地浮在半空，很难排查。
 */

export async function sampleGroundHeights(
  points: { key: string; lon: number; lat: number }[],
  fallback: number
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const p of points) out[p.key] = fallback
  if (!points.length) return out

  const manifest = await getTerrainManifest()
  if (!manifest) {
    console.info(`[terrain] 无高程瓦片缓存，${points.length} 个点全部按 ${fallback}m 摆放`)
    return out
  }

  // 由深到浅：优先用最精细的一级，那一级没有这块瓦片就退到上一级
  const levels = Object.keys(manifest)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => b - a)

  const startedAt = performance.now()
  const fetchesBefore = tileFetchCount

  // **并发**采样，不再一个一个 await。
  //
  // 原先是严格串行的：一个点要走「fetch → 解码 → 插值」才轮到下一个点，
  // 十几个不同的瓦片就成了十几倍的等待。而瓦片之间互不依赖，
  // 串行只是让网络往返白白排队。
  //
  // 并发度压在 8：再多不会更快（瓶颈是同一台机器的瓦片服务），
  // 但会同时占住更多解码用的 canvas。
  let miss = 0
  let next = 0
  const worker = async () => {
    while (next < points.length) {
      const p = points[next++]
      const h = await sampleOnePoint(p.lon, p.lat, manifest, levels)
      if (h === null) miss++
      else out[p.key] = h
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SAMPLE_CONCURRENCY, points.length) }, worker)
  )

  // 一行读数：点有多少、这次**真的去取**了几张瓦片、用时多少。
  //
  // 「新取几张」是判断缓存有没有生效的唯一信号：它不该随点数增长，
  // 也不该在第二次采样时还大于 0。缓存全热时它应当是 0，
  // 用时也随之掉到几十毫秒——这就是「提前缓存」要拿到的数。
  const fetched = tileFetchCount - fetchesBefore
  console.info(
    `[terrain] 采样 ${points.length} 点：新取瓦片 ${fetched} 张，` +
      `缓存共 ${decodedTiles.size} 张，用时 ${Math.round(performance.now() - startedAt)}ms`
  )

  if (miss) {
    console.info(`[terrain] ${miss}/${points.length} 个点未采到高度，回落到 ${fallback}m`)
  }
  return out
}

/**
 * 采样并发度。
 *
 * 取 8 是实测的折中：瓦片服务就在本机 / 内网，再多也不更快，
 * 徒增同时开着的解码 canvas。够把「十几个瓦片串行等」压成一批。
 */
const SAMPLE_CONCURRENCY = 8

/**
 * 取默认目录的高程清单。
 * 复用的缓存在 `loadTerrainManifest` 里（那里是唯一的真相），这里只是本模块内的简称。
 */
function getTerrainManifest(): Promise<TileManifest | null> {
  return loadTerrainManifest()
}

// ---------------------------------------------------------------------------
// 提前缓存（预热）
// ---------------------------------------------------------------------------

/**
 * 预热窗口半径（瓦片）。±1 即 3×3。
 *
 * 实测建场景那 410 个点只落在 4 张瓦片里，±1 的 9 张有富余；
 * 而预热完这 9 张之后，采样自己**一张都不用再取**（读数是 `新取瓦片 0 张`），
 * 说明这个窗口够。窗口再放大只会拖长预热本身，换不来更多命中。
 */
const PREWARM_RADIUS = 1

/** 预热并发度。比采样低一档，别把启动阶段的连接池和带宽全占了 */
const PREWARM_CONCURRENCY = 6

/**
 * 提前把矿区那一带的 DEM 瓦片取回来、解码好，落进 `decodedTiles`。
 *
 * ## 为什么需要它 —— 两个数量级，全在「抢连接」上
 *
 * 同一批 9 张瓦片，实测两次：
 *
 * | 时机 | 用时 |
 * | --- | --- |
 * | 空闲（`createViewer` 之前） | **19ms** |
 * | 建场景采样时（Cesium 已建好地球） | **4269ms** |
 *
 * 差 225 倍的不是解码，是**同域连接**：Cesium 建地球会一次开出几百个
 * 瓦片请求，浏览器对同域的并发连接数有上限，采样的请求只能排在后面，
 * 而且是成批地、几秒一波地回来。单张瓦片本身只要 15~50ms。
 *
 * 所以在 `useCesium` 刚挂载、**还没 `createViewer`** 的时候先取回来：
 * 那一刻连接池是空的，9 张瓦片 19ms 就全落地了。`decodedTiles` 存的是
 * Promise，等建场景真去采样时命中的就是同一份，等于白拿。
 *
 * ⚠️ **发出去还不够，必须等它落地再 `createViewer`。**
 * 一开始这里只 `void prewarm(...)` 不 await，想「并行更快」——结果预热自己
 * 也被 Cesium 挤到队尾，跟要救的采样一起饿着，末尾那行日志迟迟打不出来
 *（当时被当成「日志丢了」，其实是它根本没跑完）。
 * 现在由调用方 `await`，但**带 `PREWARM_BUDGET_MS` 上限**：
 * 预热只是加速，瓦片服务慢时到点就放行，绝不能变成新的卡点。
 *
 * ## 预热哪几张
 *
 * **最深一级缓存层里、矿区那一小块**。不写死经纬度：manifest 每层都带
 * `minX/maxX/minY/maxY`，那一块的中点就是矿区，取中点周围 ±`PREWARM_RADIUS`
 * 圈的瓦片即可——将来矿区范围怎么调，这里自己跟着走，不会失效。
 *
 * 只预热**最深一级**就够：`sampleOnePoint` 是从深到浅找的，矿区内的点
 * 必定落在最深那一级上（浅层只在最深一级缺瓦片时才会用到）。
 *
 * 失败静默：预热只是加速，不该影响任何流程，也不该在控制台留下噪声
 * ——真取不到时建场景那边的采样会照常自己去取。
 */
export async function prewarmTerrainTiles(baseUrl = TERRAIN_BASE_URL): Promise<void> {
  try {
    const manifest = await getTerrainManifest()
    if (!manifest) return

    const deepest = Object.keys(manifest)
      .map(Number)
      .filter(Number.isInteger)
      .sort((a, b) => b - a)[0]
    if (deepest === undefined) return

    const entry = manifest[String(deepest)]
    if (!entry) return

    const cx = Math.round((entry.minX + entry.maxX) / 2)
    const cy = Math.round((entry.minY + entry.maxY) / 2)

    const targets: { x: number; y: number }[] = []
    for (let dx = -PREWARM_RADIUS; dx <= PREWARM_RADIUS; dx++) {
      for (let dy = -PREWARM_RADIUS; dy <= PREWARM_RADIUS; dy++) {
        const x = cx + dx
        const y = cy + dy
        if (x < entry.minX || x > entry.maxX || y < entry.minY || y > entry.maxY) continue
        // 逐张核对，别把范围里没抓到的瓦片也算进来（那些会白等一轮）
        if (!entry.tiles.includes(`${x}/${y}`)) continue
        targets.push({ x, y })
      }
    }
    if (!targets.length) return

    const startedAt = performance.now()
    let next = 0
    let ok = 0
    const worker = async () => {
      while (next < targets.length) {
        const t = targets[next++]
        const heights = await loadTerrariumHeights(t.x, t.y, deepest, baseUrl)
        if (heights) ok++
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(PREWARM_CONCURRENCY, targets.length) }, worker)
    )

    console.info(
      `[terrain] 预热第${deepest}级瓦片 ${ok}/${targets.length} 张，` +
        `用时 ${Math.round(performance.now() - startedAt)}ms`
    )
  } catch {
    /* 预热失败不影响任何流程 */
  }
}

/**
 * 采样单个点的高程。
 *
 * ## 为什么不用 `Cesium.sampleTerrainMostDetailed`
 *
 * 它确实是 Cesium 给的标准做法，但**结果不确定**：内部按四叉树递归下钻、
 * 向已加载的实景三维求交，问到哪个值取决于「问的那一刻瓦片加载到第几级」。
 * 对 `sampleHeightMostDetailed` 尤其明显——实测同一位置两次能差 40 多米，
 * 地物会忽高忽低。
 *
 * 而且它对地形提供器还有额外前提（`terrainProvider.availability` 的节点
 * 结构要完整），递归到不存在的瓦片上就会读 `tile.rectangle.southwest` 抛异常；
 * 该异常由 `deferPromiseUntilPostRender` 推迟到 postRender 里兑现，
 * 因此会从 `scene.render()` 穿出来，调用方的 try/catch 拦不住。
 *
 * 直接读同一批离线 DEM 瓦片则完全确定：不走四叉树、不依赖加载状态，
 * 拿到的高程与地形底座就是同一份数据，同一个点问多少次都是同一个值。
 */
async function sampleOnePoint(
  lon: number,
  lat: number,
  manifest: TileManifest,
  levels: number[]
): Promise<number | null> {
  for (const level of levels) {
    const entry = manifest[String(level)]
    if (!entry) continue

    const fxTotal = lonToTileX(lon, level)
    const fyTotal = latToTileY(lat, level)
    const tx = Math.floor(fxTotal)
    const ty = Math.floor(fyTotal)
    if (!entry.tiles.includes(`${tx}/${ty}`)) continue

    const heights = await loadTerrariumHeights(tx, ty, level, TERRAIN_BASE_URL)
    if (!heights) continue

    // 双线性插值：块内归一化坐标（原点在瓦片西北角，y 向南增大）
    const px = (fxTotal - tx) * (TILE_SIZE - 1)
    const py = (fyTotal - ty) * (TILE_SIZE - 1)
    const x0 = Math.min(Math.max(Math.floor(px), 0), TILE_SIZE - 1)
    const y0 = Math.min(Math.max(Math.floor(py), 0), TILE_SIZE - 1)
    const x1 = Math.min(x0 + 1, TILE_SIZE - 1)
    const y1 = Math.min(y0 + 1, TILE_SIZE - 1)
    const dx = px - x0
    const dy = py - y0

    const at = (cx: number, cy: number) => heights[cy * TILE_SIZE + cx] ?? 0
    const top = at(x0, y0) * (1 - dx) + at(x1, y0) * dx
    const bottom = at(x0, y1) * (1 - dx) + at(x1, y1) * dx
    const value = top * (1 - dy) + bottom * dy

    if (Number.isFinite(value)) return value
  }
  return null
}

// ---------------------------------------------------------------------------
// Web Mercator 瓦片坐标
// ---------------------------------------------------------------------------

/** 经度 → 该层级下的瓦片 X（含小数，整数部分是瓦片号） */
function lonToTileX(lon: number, level: number): number {
  return ((lon + 180) / 360) * 2 ** level
}

/**
 * 纬度 → 该层级下的瓦片 Y（含小数，整数部分是瓦片号）。
 * 用的是标准 Web Mercator 反算，与 Cesium 的 `WebMercatorTilingScheme` 一致。
 */
function latToTileY(lat: number, level: number): number {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** level
}
