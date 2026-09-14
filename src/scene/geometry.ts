import * as Cesium from 'cesium'
import { METERS_PER_LAT, metersPerLon } from './mineLayout'
import type { LonLat, Pt } from './mineLayout'

/**
 * 纯几何工具：经纬度与局部米制坐标互转、多边形内缩、按高程成环。
 *
 * **单独成文件是为了打断循环依赖**：`buildMineScene`（矿区全域）与
 * `buildPlant`（选矿厂）都要用这些函数，若把它们留在 `buildMineScene` 里
 * 再让 `buildPlant` 去 import，就会形成
 * `buildMineScene → buildPlant → buildMineScene` 的环。
 * 抽到这里两边各自 import，没有环，也没有谁「拥有」谁的问题。
 *
 * 本文件不含任何坐标数据——「东西在哪」一律来自 `./mineLayout`。
 */

/** 经纬度 → 以 origin 为原点的局部米制坐标 */
export function toLocal(points: LonLat[], origin: LonLat): Pt[] {
  const mx = metersPerLon(origin[1])
  return points.map(([lon, lat]) => ({
    x: (lon - origin[0]) * mx,
    y: (lat - origin[1]) * METERS_PER_LAT
  }))
}

/** 局部米制坐标 → 经纬度 */
export function toLonLat(points: Pt[], origin: LonLat): LonLat[] {
  const mx = metersPerLon(origin[1])
  return points.map((p) => [
    origin[0] + p.x / mx,
    origin[1] + p.y / METERS_PER_LAT
  ])
}

/**
 * 环**沿半径方向**内缩 d 米（各点朝 center 走 d 米），不会自交。
 *
 * 采坑的各级平台、坡面、坑底都是这么一圈圈缩出来的。**别改成逐边等距内缩**：
 * 那种做法在内缩量接近短半轴时，相邻两条平移边的交点会翻到环的另一侧，
 * 环就自交了。实测内缩 190m/228m/266m 三圈分别有 15/16/4 处自交，
 * 三角化随之失败——以前底图还在，坏掉的环被底图挡着看不出来；
 * 现在底图在坑口范围内被挖掉（见 `terrainClip`），那里就直接露出天空。
 */
export function insetRing(ring: Pt[], d: number, center: Pt = { x: 0, y: 0 }): Pt[] {
  return ring.map((p) => {
    const dx = p.x - center.x
    const dy = p.y - center.y
    const r = Math.hypot(dx, dy) || 1
    const k = Math.max(r - d, 1) / r
    return { x: center.x + dx * k, y: center.y + dy * k }
  })
}

/** 把一圈经纬度点提到指定高程 */
export function ringAt(points: LonLat[], height: number): Cesium.Cartesian3[] {
  return points.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, height))
}

/**
 * 平置多边形：经纬度环 + 该环所在高程。
 *
 * **`height` 必须显式给，环上带的高程不算数。** `PolygonGeometry` 构造函数里是
 * `let height = options.height ?? 0.0`（`@cesium/engine/Source/Core/PolygonGeometry.js:701`），
 * 而 `perPositionHeight` 默认 false——也就是说一个只写了 `hierarchy` 的 polygon
 * 一律建在**海拔 0**，即采场底下 1300 多米。它不报错、不告警，
 * `entities.getById()` 照样拿得到，只是「模型跑到 cesium 底图下面去了」。
 */
export function flatPolygon(
  points: LonLat[],
  height: number
): { hierarchy: Cesium.PolygonHierarchy; height: number } {
  return { hierarchy: new Cesium.PolygonHierarchy(ringAt(points, height)), height }
}

/**
 * 逐点高度的带状面（皮带廊、装车溜槽、坑内道路这类沿地形起伏的长条）。
 *
 * 只写 `perPositionHeight` 不够：`PolygonGeometryUpdater` 第一条分支是
 * 「`perPositionHeight` 且没有 `extrudedHeight`」→ 走 `CoplanarPolygonGeometry`，
 * 而那条路是把环**投影到拟合平面上**再摊平（`CoplanarPolygonGeometry.js:475`），
 * 只对共面的环成立，非共面的环不报错、直接摊歪。再挂一个 `extrudedHeight`
 * 就落进 `PolygonGeometry` 的 `perPositionHeightExtrude` 分支：顶面逐点取环上高程，
 * 侧壁落到 `extrudedHeight`（取环内最低点再低 `thickness`），顺带给廊身一层板厚。
 */
export function beltPolygon(
  positions: Cesium.Cartesian3[],
  thickness = 0.3
): {
  hierarchy: Cesium.PolygonHierarchy
  perPositionHeight: boolean
  extrudedHeight: number
} {
  const lowest = Math.min(...positions.map((p) => Cesium.Cartographic.fromCartesian(p).height))
  return {
    hierarchy: new Cesium.PolygonHierarchy(positions),
    perPositionHeight: true,
    extrudedHeight: lowest - thickness
  }
}

/** 椭圆的经纬度点集（排土场 / 水体用） */
export function ellipsePoints(
  lon: number,
  lat: number,
  rx: number,
  ry: number,
  segments = 40
): LonLat[] {
  const mx = metersPerLon(lat)
  const pts: LonLat[] = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    pts.push([lon + (Math.cos(a) * rx) / mx, lat + (Math.sin(a) * ry) / METERS_PER_LAT])
  }
  return pts
}

/**
 * 把折线沿法线方向平移若干米（正值在前进方向左侧）。
 *
 * 廊道侧壁、桁架弦杆都要靠它从中心线推出两条边线。
 */
export function offsetPath(path: LonLat[], offset: number): LonLat[] {
  const mx = metersPerLon(path[0][1])
  const out: LonLat[] = []
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)]
    const b = path[Math.min(path.length - 1, i + 1)]
    const dx = (b[0] - a[0]) * mx
    const dy = (b[1] - a[1]) * METERS_PER_LAT
    const len = Math.hypot(dx, dy) || 1
    // 左法线
    out.push([
      path[i][0] + ((-dy / len) * offset) / mx,
      path[i][1] + ((dx / len) * offset) / METERS_PER_LAT
    ])
  }
  return out
}

/**
 * 把一条中心线 + 逐点高度做成**带宽度的带状面**，返回值直接当
 * `polygon.hierarchy` 用（必须配 `perPositionHeight: true`）。
 *
 * ## 为什么不用 Cesium 的 `corridor`
 *
 * `CorridorGeometry.createGeometry` 的第一步是 `scaleToSurface()`：
 *
 * ```js
 * positions[i] = ellipsoid.scaleToGeodeticSurface(positions[i], positions[i])
 * ```
 *
 * 它把传进来的每个点**就地**投到椭球面上（海拔 0），再按 `corridor.height`
 * （默认 0）整条廊道铺平。也就是说 Entity 的 corridor **只认一个常数高度**，
 * 逐点高度会被它吃掉——皮带廊于是落在海拔 0，比矿区低 1300 多米，
 * 沉在底图下面。更坑的是它改的是**调用方的那个数组**，改坏了不报错。
 *
 * 带状多边形没有这个毛病：`perPositionHeight` 原样使用每个点的高程。
 *
 * 用法上它跟 corridor 一一对应：宽度用 `width`，高度用 `heights`（绝对标高，
 * 与 `heights[i]` 对齐）。
 */
export function ribbonRing(
  path: LonLat[],
  width: number,
  heights: number[]
): Cesium.Cartesian3[] {
  const left = offsetPath(path, width / 2)
  const right = offsetPath(path, -width / 2)
  const at = (pts: LonLat[]) =>
    pts.map(([lon, lat], i) => Cesium.Cartesian3.fromDegrees(lon, lat, heights[i] ?? 0))
  // 去程走左边、回程走右边，首尾相接就是一个闭合环
  return [...at(left), ...at(right).reverse()]
}

/** 确定性伪随机数（线性同余），保证每次构建结果一致 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
