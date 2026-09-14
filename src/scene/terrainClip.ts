import * as Cesium from 'cesium'
import type { LonLat } from './mineLayout'

/**
 * 底图裁剪：把「模型自己就是地表」的那几块地，从 Cesium 底图上挖掉。
 *
 * ## 为什么要挖
 *
 * 底图（离线 DEM + 影像）是**实测数据**，它上面已经有一次采坑、一次排土场、
 * 一次厂区。我们的模型是**重新建**的，两者形状对不上：实测那版的山坡就压在
 * 模型台地上面。结果就是「建模埋在底图下面」——同一块地方有两个地表，
 * 谁高谁露出来。
 *
 * 挖掉之后，那片地的**唯一**地表就是模型本身，模型上的设备自然都站在地表上。
 *
 * ## 接口语义（Cesium 1.140）
 *
 * `globe.clippingPolygons` 是 `ClippingPolygonCollection`，默认
 * `inverse: false`，含义是「**多边形内部**不渲染」——正好是挖洞，
 * 而且连影像一起挖。多边形沿地心方向无限延伸，点的**高程不参与判断**。
 * 只支持 WebGL2（本项目的硬要求，见 `createViewer`）。
 *
 * ## 洞沿要封住
 *
 * 挖洞的边界是**底图自己的地表**，模型在边界上的表面未必落在同一个高度：
 * 模型的台地比自然地面低时，洞口上方就露出一条缝（能看到背面/天空）。
 * 所以每块挖掉的地都要配一圈**从模型表面砌到自然地面的崖面**
 * （见 `buildBenches` 的削坡、`buildPit` 的坑沿），而且这圈的顶点高程
 * 必须与底图在同一串经纬度上采出来——同一串点，洞沿和崖顶才会严丝合缝。
 */
const footprints: LonLat[][] = []

/**
 * 登记一块「模型即地表」的范围（经纬度环，不必首尾重复）。
 * 谁削了地表谁来登记，全部建完之后由 `installTerrainClip` 一次性挖掉。
 */
export function registerModelSurface(ring: LonLat[]): void {
  footprints.push(ring)
}

/** 把登记过的范围从底图上挖掉。装完即清空，重复进页面重建场景不会叠加。 */
export function installTerrainClip(viewer: Cesium.Viewer): void {
  if (footprints.length === 0) return
  const polygons = footprints.map(
    (ring) =>
      new Cesium.ClippingPolygon({
        positions: ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat))
      })
  )
  footprints.length = 0
  viewer.scene.globe.clippingPolygons = new Cesium.ClippingPolygonCollection({ polygons })
}
