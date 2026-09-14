import * as Cesium from 'cesium'

/**
 * 倾斜摄影 3D Tiles 接入。
 *
 * 真实矿区模型接入流程：
 *   1. 把倾斜摄影成果（OSGB / OBJ 等）用 Cesiumlab、3DTilesRenderer 等工具
 *      转成 3D Tiles 目录，放到 `public/models/mine-tileset/`
 *   2. 确认目录里有 `tileset.json`，且引用的 b3dm / pnts / glb 路径相对它正确
 *   3. 页面会自动检测并加载；没有这个目录时保持程序化示意场景，不影响其它功能
 *
 * 也可以直接指向外部发布的 3D Tiles 服务地址（见 MINE_TILESET_URL 的说明）。
 */

/** 3D Tiles 数据源，相对项目根目录 */
export const MINE_TILESET_URL = 'models/mine-tileset/tileset.json'

/** 模型加载结果 */
export interface TilesetLoadResult {
  /** 是否成功加载到真实模型 */
  loaded: boolean
  /** 加载失败或被跳过时的原因，用于界面提示与日志 */
  reason?: string
  /** 加载到的对象，供调用方调整样式或做点位查询 */
  tileset?: Cesium.Cesium3DTileset
}

/**
 * 检测并加载矿区 3D Tiles。
 *
 * 先发一个 HEAD 请求探测文件是否存在，避免控制台出现 404 报错——
 * 未接入模型是这个阶段的常态，不该在控制台留下噪声。
 */
export async function loadMineTileset(
  viewer: Cesium.Viewer,
  url: string = MINE_TILESET_URL
): Promise<TilesetLoadResult> {
  const exists = await resourceExists(url)
  if (!exists) {
    return {
      loaded: false,
      reason: `未找到 3D Tiles（${url}），使用程序化示意场景`
    }
  }

  try {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
      // 大屏上不需要阴影，省下可观的开销
      shadows: Cesium.ShadowMode.DISABLED,
      // 控制可见距离，避免远处瓦片白白加载
      maximumScreenSpaceError: 16,
      // 模型自身的动态范围压缩会偏灰，这里关掉保持原色
      dynamicScreenSpaceError: false
      // 注：不要在这里传 enableLighting —— Cesium 1.140 的 Cesium3DTileset
      // 既没有这个构造项也没有这个实例属性（同名属性只属于 Globe），
      // 传进来会被静默忽略，写了反而误以为已经生效。
    })

    // 先校验再挂载：没做地理配准的成果一律当「没有模型」处理。
    //
    // 这里踩过一次坑：目录里曾放着一个演示用的 tileset，包围盒中心在**地心**。
    // 探测到 tileset.json 存在就当成「有真实模型」，于是整个程序化场景被跳过，
    // 而那个模型渲染在地心里根本看不见——页面上只剩空场景，
    // 控制台还一片干净，极难排查。
    if (!isGeoreferenced(tileset)) {
      tileset.destroy()
      return {
        loaded: false,
        reason:
          `3D Tiles（${url}）没有地理坐标（包围球中心在地心附近），已按无模型处理，` +
          `改用程序化场景。倾斜摄影成果通常是地方坐标系，需要用控制点做配准。`
      }
    }

    viewer.scene.primitives.add(tileset)

    // 与影像底图对齐时，模型不需要额外的贴地偏移
    tileset.style = new Cesium.Cesium3DTileStyle({
      color: 'color("#ffffff", 1.0)'
    })

    return { loaded: true, tileset }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn('[tileset] 3D Tiles 加载失败，回退到程序化场景：', reason)
    return { loaded: false, reason }
  }
}

/**
 * 判断一份 3D Tiles 是否带地理坐标。
 *
 * 判据是包围球中心到地心的距离：配准过的成果贴在地表，
 * 距离约等于地球半径；没配准的成果往往落在原点（地心）附近。
 *
 * 允许 0.9~1.1 倍地球半径——模型高出或低于地表都在这个范围内。
 */
function isGeoreferenced(tileset: Cesium.Cesium3DTileset): boolean {
  const center = tileset.boundingSphere?.center
  if (!center) return false
  const distance = Cesium.Cartesian3.magnitude(center)
  const R = Cesium.Ellipsoid.WGS84.maximumRadius
  return distance > R * 0.9 && distance < R * 1.1
}

/** 探测资源是否存在。用 HEAD 请求，失败一律当作不存在。 */
async function resourceExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 把相机飞到模型范围。
 * 加载完真实模型后调用，避免用户看到一个偏离的视角。
 */
export function flyToTileset(viewer: Cesium.Viewer, tileset: Cesium.Cesium3DTileset) {
  viewer.camera.flyTo({
    destination: viewer.camera.positionWC,
    duration: 0
  })
  viewer.zoomTo(tileset, new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-40), 0))
}
