import * as Cesium from 'cesium'

/**
 * 离线卫星底图。
 *
 * 瓦片由 scripts/fetch-map-tiles.mjs 预先抓取到 public/map-tiles/imagery/，
 * 按标准 XYZ 目录存放，并附带 manifest.json 记录实际缓存了哪些层级和瓦片。
 *
 * 这样做的好处：矿区现场往往没有外网，底图必须能完全离线加载；
 * manifest 让运行时能准确知道「哪一层有、哪些瓦片有」，
 * 避免请求到没抓的瓦片导致一片空白。
 */

/** manifest.json 的结构：层级 → 该层已缓存的瓦片与范围 */
export interface TileManifest {
  [z: string]: {
    /** 形如 "52783/25914" 的瓦片坐标列表 */
    tiles: string[]
    minX: number
    maxX: number
    minY: number
    maxY: number
    count: number
  }
}

/**
 * 是否启用离线卫星底图。
 *
 * 默认开启。瓦片由 scripts/fetch-map-tiles.mjs 预先抓取到 public/map-tiles/imagery/，
 * 矿区现场通常没有外网，底图完全离线加载。
 * 没有瓦片目录时会自动跳过，退回程序化场景，不影响其它功能。
 */
export const OFFLINE_IMAGERY_ENABLED = true

/** 底图资源的基础路径（相对项目根，dev 与 build 产物都适用） */
const TILE_BASE_URL = 'map-tiles/imagery'

/**
 * 透明占位瓦片。
 *
 * 必须与真实瓦片同为 256×256 —— 尺寸不一致会让 Cesium 在
 * GlobeSurfaceTile 里算出 undefined 的矩形，进而抛
 * 「Expected rectangle to be typeof object」并中止整个渲染循环。
 * 这是排查了很久才定位到的坑，改动这里请保持尺寸为 256。
 */
const TILE_SIZE = 256
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAABFUlEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBPAAB2ClDBAAAAABJRU5ErkJggg=='

/** 读取已缓存的瓦片清单，无缓存时返回 null */
export async function loadTileManifest(
  baseUrl = TILE_BASE_URL
): Promise<TileManifest | null> {
  try {
    const res = await fetch(`${baseUrl}/manifest.json`)
    if (!res.ok) return null
    const manifest = (await res.json()) as TileManifest
    return Object.keys(manifest).length ? manifest : null
  } catch {
    return null
  }
}

/**
 * 基于离线瓦片的影像图层。
 *
 * 两个关键点：
 *
 * 1. **不要设置 rectangle**。Cesium 在 `_createTileImagerySkeletons` 里会算
 *    `Rectangle.intersection(imageryRectangle, imageryBounds)`，两个矩形不相交时
 *    它返回 undefined，紧接着就传给 `rectangleToNativeRectangle` 抛
 *    「Expected rectangle to be typeof object」并中止整个渲染循环。
 *    地球瓦片铺满全球，只要图层自身设了范围就必然出现不相交的瓦片。
 *
 * 2. **未缓存的瓦片返回同尺寸透明图**，而不是让它去请求一个不存在的文件。
 *    直接请求会拿到 HTML 错误页，Cesium 解析失败会在控制台刷屏。
 */
export class OfflineTileImageryProvider extends Cesium.UrlTemplateImageryProvider {
  private manifest: TileManifest
  /** 已缓存瓦片的实际覆盖矩形（弧度），用于快速判空 */
  private cover: Cesium.Rectangle

  /**
   * 已经**真正加载成功**的瓦片数（透明占位图不计）。
   *
   * 这是判断「底图链路通没通」的唯一可靠信号，给 `createViewer` 的
   * 底图兜底逻辑用。不能用 `scene.globe.tilesLoaded`：它的含义是
   * 「当前视野该加载的都加载完了」，首屏瓦片多、显卡慢时会长时间为 false——
   * 实测 134 张瓦片已经取回，它依然是 false，据此判定「底图挂了」
   * 会把好端端的影像图层整个删掉，比不兜底还糟。
   */
  loadedTileCount = 0

  /**
   * 已经**真正发出去**的瓦片请求数（不论成败，透明占位图不计）。
   *
   * 与 `loadedTileCount` 配对使用，给 `createViewer` 的底线判断用：
   * 只有「请求了很多、一张都没回来」才说明链路真的断了。
   * 单看 `loadedTileCount === 0` 分不出「瓦片服务坏了」和「还没轮到请求」
   * ——建场景期间主线程是满的，影像请求本来就排在后面。
   */
  requestedTileCount = 0

  constructor(options: { baseUrl: string; manifest: TileManifest }) {
    const levels = Object.keys(options.manifest)
      .map(Number)
      .sort((a, b) => a - b)

    const baseLevel = levels[0] ?? 0
    const maxLevel = levels[levels.length - 1] ?? 0

    super({
      url: `${options.baseUrl}/{z}/{x}/{y}.jpg`,
      // minimumLevel 必须是 0，不能设成最低缓存层级。
      //
      // Cesium 为每块地球瓦片按「祖先链」逐级取影像：一块 17 级瓦片会依次
      // 向 16、15……0 级索要影像，用来填充尚未加载好的区域。
      // 若把 minimumLevel 设成 12，Cesium 就会为每个祖先层级都合成影像骨架，
      // _imageryCache 条目数呈指数增长（实测 2 → 8 → 29 → 105 → … → 629 万），
      // 数秒内触顶 V8 单对象属性上限，抛
      // 「RangeError: Too many properties to enumerate」并终止渲染循环。
      //
      // 设成 0 后，没有缓存的层级统一由 requestImage 返回透明占位图，
      // 缓存条目数立刻回落到百级并保持平稳。
      minimumLevel: 0,
      maximumLevel: maxLevel,
      tileWidth: 256,
      tileHeight: 256,
      // 必须声明「带透明通道」。
      //
      // 本 provider 对「没缓存」的瓦片返回的是**全透明占位图**（见 requestImage），
      // 而 Cesium 是按这个声明选纹理格式的：
      //   `pixelFormat: this._imageryProvider.hasAlphaChannel ? RGBA : RGB`
      //   （`@cesium/engine/Source/Scene/ImageryLayer.js:1214`）
      // 声明 false 时透明图按 RGB 上传，alpha 被丢掉，占位像素 (0,0,0,0)
      // 就成了**不透明纯黑**：高度一升、所需的层级落到未缓存的那几级，
      // 整屏铺满 (0,0,0)，`globe.baseColor`（深空色兜底）永远透不出来。
      // 实拍瓦片是 JPEG、alpha 恒为 1，声明 true 对它们没有影响。
      hasAlphaChannel: true
    })

    this.manifest = options.manifest

    // 由最低缓存层级推出覆盖区域。
    // 只用于快速判断「这个请求要不要走网络」，不作为 provider 的 rectangle
    // 暴露给 Cesium —— 那会触发上面注释里说的 intersection undefined 崩溃。
    const base = options.manifest[String(baseLevel)]
    this.cover = base
      ? Cesium.Rectangle.fromDegrees(
          ...tileRangeToDegrees(base.minX, base.maxX, base.minY, base.maxY, baseLevel)
        )
      : Cesium.Rectangle.MAX_VALUE
  }

  /** 该层级的瓦片坐标是否有可能已缓存（粗略判断，按覆盖矩形） */
  private covered(x: number, y: number, level: number): boolean {
    const n = Math.pow(2, level)
    // 瓦片在覆盖矩形内才可能命中缓存；用 ±1 的余量避免边界误判
    const west = (x / n) * 360 - 180
    const east = ((x + 1) / n) * 360 - 180
    const latOf = (yy: number) => {
      const t = Math.PI - (2 * Math.PI * yy) / n
      return Cesium.Math.toDegrees(Math.atan(Math.sinh(t)))
    }
    const north = latOf(y)
    const south = latOf(y + 1)

    const cw = Cesium.Math.toDegrees(this.cover.west)
    const ce = Cesium.Math.toDegrees(this.cover.east)
    const cn = Cesium.Math.toDegrees(this.cover.north)
    const cs = Cesium.Math.toDegrees(this.cover.south)

    return east > cw && west < ce && north > cs && south < cn
  }

  /**
   * 装饰父类的 requestImage，而不是整个替换掉。
   *
   * 必须保留父类的调用时序（返回值可能是 undefined 或 Promise），
   * 只在其解析为空时补一张透明占位图；否则 Cesium 生成
   * GlobeSurfaceTile 影像信息时会拿到不完整的矩形而崩掉渲染循环。
   */
  override requestImage(
    x: number,
    y: number,
    level: number,
    request?: Cesium.Request
  ): Promise<Cesium.ImageryTypes> | undefined {
    const entry = this.manifest[String(level)]

    // 该层级没缓存，或这张瓦片不在覆盖范围内：直接给透明图，不发起网络请求。
    // 先做廉价的矩形判断，避免对地球另一侧的瓦片做字符串查找。
    if (!entry || !this.covered(x, y, level) || !entry.tiles.includes(`${x}/${y}`)) {
      return Promise.resolve(transparentImage())
    }

    const result = super.requestImage(x, y, level, request)

    if (!result) return result

    this.requestedTileCount++

    return result.then(
      (image) => {
        if (image) this.loadedTileCount++
        return image ?? transparentImage()
      },
      () => transparentImage()
    )
  }
}

/**
 * 透明占位图。
 *
 * 只创建一次并复用 —— 每次 new Image() 都会触发一次解码，
 * 大批量瓦片缺失时会明显拖慢加载。
 */
let placeholder: HTMLImageElement | null = null

function transparentImage(): HTMLImageElement {
  if (!placeholder) {
    placeholder = new Image(TILE_SIZE, TILE_SIZE)
    placeholder.src = TRANSPARENT_PNG
  }
  return placeholder
}

/** 把瓦片坐标范围换算成经纬度矩形（西, 南, 东, 北） */
function tileRangeToDegrees(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  z: number
): [number, number, number, number] {
  const west = (minX / Math.pow(2, z)) * 360 - 180
  const east = ((maxX + 1) / Math.pow(2, z)) * 360 - 180

  const latOf = (y: number) => {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z)
    return Cesium.Math.toDegrees(Math.atan(Math.sinh(n)))
  }

  return [west, latOf(maxY + 1), east, latOf(minY)]
}

/**
 * 创建离线底图图层。
 * 没有缓存数据时返回 null，调用方应回退到纯色地球。
 */
export function createOfflineImageryLayer(
  manifest: TileManifest,
  baseUrl = TILE_BASE_URL
): Cesium.ImageryLayer | null {
  try {
    return new Cesium.ImageryLayer(
      new OfflineTileImageryProvider({ baseUrl, manifest })
    )
  } catch (err) {
    console.warn('[imagery] 离线底图创建失败，回退到纯色地球', err)
    return null
  }
}
