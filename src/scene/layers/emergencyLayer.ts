import * as Cesium from 'cesium'
import { createFlowMaterial } from './flowMaterial'
import { MINE_ELEVATION } from '../sceneConfig'
import { sampleGroundHeights } from '../localTerrain'
import { METERS_PER_LAT, metersPerLon, pitOffset } from '../mineLayout'
import type {
  BaseStation,
  DisasterRoute,
  PersonnelPosition,
  PersonnelTrack
} from '@/api/emergency'

/**
 * 应急救援图层：撤离路线（流动光效）+ 采场作业人员/基站定位 + 人员轨迹。
 *
 * 场景是**露天矿**，所以这里画的是采剥作业面与台阶运输道路，
 * 而不是需求文档示例里的井下巷道——露天采场没有巷道，
 * 生搬「运输大巷」会与三维场景完全对不上。
 *
 * **高度全部靠采样**：路线沿线的每个点都从三维底座取真实地面高程，
 * 再抬起一个固定量。这样路线天然贴着地形走——坑内的点低、坑外的点高，
 * 「从坑底爬升到坑外」的走势是地形自己给的，不需要手工编造高度曲线。
 */

/** 采剥作业面的网格色 */
const WORKFACE_COLOR = Cesium.Color.fromCssColorString('#ffd60a')
/** 台阶运输道路的颜色 */
const HAUL_ROAD_COLOR = Cesium.Color.fromCssColorString('#1890ff').withAlpha(0.55)
/** 在线人员的点位色 */
const PERSON_ONLINE_COLOR = Cesium.Color.fromCssColorString('#00ff9d')
/** 离线人员的点位色：灰掉，一眼能看出终端掉线 */
const PERSON_OFFLINE_COLOR = Cesium.Color.fromCssColorString('#7a8b99')
/** 基站覆盖圈的颜色 */
const STATION_COLOR = Cesium.Color.fromCssColorString('#b388ff')

/** 各类线要素相对地面的抬升高度（米），避免被地形与建筑遮住 */
const ROUTE_LIFT = 14
const ROAD_LIFT = 6
const GRID_LIFT = 6
const TRACK_LIFT = 10
const STATION_LIFT = 18
const PERSON_LIFT = 16

/** 点标注的统一样式参数（人员与基站共用，避免两处字体字号走偏） */
const LABEL_FONT = '11px PingFang SC, Microsoft YaHei, sans-serif'
const LABEL_FILL = Cesium.Color.fromCssColorString('#e8f4ff')

/** 把一条经纬度折线采样成贴地的 Cartesian 序列 */
async function liftPath(
  path: [number, number][],
  prefix: string,
  lift: number
): Promise<Cesium.Cartesian3[]> {
  const ground = await sampleGroundHeights(
    path.map(([lon, lat], i) => ({ key: `${prefix}-${i}`, lon, lat })),
    MINE_ELEVATION
  )
  return path.map(([lon, lat], i) =>
    Cesium.Cartesian3.fromDegrees(lon, lat, (ground[`${prefix}-${i}`] ?? MINE_ELEVATION) + lift)
  )
}

/**
 * 撤离路线：底部衬线 + 流动光带。
 *
 * 路线贴着采样到的地面走，因此天然呈现「从坑底沿台阶爬上坑外」的走势。
 */
export async function buildDisasterRoutes(
  viewer: Cesium.Viewer,
  routes: DisasterRoute[]
): Promise<Map<string, Cesium.Entity[]>> {
  const grouped = new Map<string, Cesium.Entity[]>()

  for (const route of routes) {
    const positions = await liftPath(route.path, `route-${route.key}`, ROUTE_LIFT)
    const color = Cesium.Color.fromCssColorString(route.color)
    const entities: Cesium.Entity[] = []

    // 底色线：稍粗、半透明，勾勒出线路走向
    entities.push(
      viewer.entities.add({
        id: `route-base-${route.key}`,
        name: route.label,
        show: route.visible,
        polyline: {
          positions,
          width: 6,
          material: color.withAlpha(0.28),
          clampToGround: false
        }
      })
    )

    // 流动光带：贴在同一条路径上，稍细，带循环流光
    entities.push(
      viewer.entities.add({
        id: `route-flow-${route.key}`,
        name: `${route.label}（流向）`,
        show: route.visible,
        polyline: {
          positions,
          width: 3.5,
          material: createFlowMaterial(route.color, route.flowSpeed),
          clampToGround: false
        }
      })
    )

    grouped.set(route.key, entities)
  }

  return grouped
}

/**
 * 采剥作业面与台阶运输道路。
 *
 * 对应需求文档里「黄色网格工作面 + 管线」的视觉效果，
 * 但落在露天采场的语境上：网格铺在北帮的活动台阶，
 * 道路沿采场各台阶盘旋。
 */
export async function buildBenchFramework(viewer: Cesium.Viewer): Promise<void> {
  // 作业面：北帮正在采剥的台阶（与 mock 里「北帮采剥面」的人员点位同一处）
  const [workLon, workLat] = pitOffset(-120, 180)
  const cells = 9
  // 网格尺寸按米给，再换算成经纬度跨度：直接写经纬度的话，
  // 东西与南北方向的比例是错的（这个纬度上 1° 经度只有 1° 纬度的六成）
  const spanLon = 200 / metersPerLon(workLat)
  const spanLat = 155 / METERS_PER_LAT

  // 网格铺在采样到的台阶面上
  const centerGround = await sampleGroundHeights(
    [{ key: 'workface', lon: workLon, lat: workLat }],
    MINE_ELEVATION
  )
  const gridHeight = (centerGround.workface ?? MINE_ELEVATION) + GRID_LIFT

  for (let i = 0; i <= cells; i++) {
    const t = i / cells
    viewer.entities.add({
      id: `workface-h-${i}`,
      name: '采剥作业面',
      polyline: {
        positions: [
          Cesium.Cartesian3.fromDegrees(
            workLon - spanLon / 2,
            workLat - spanLat / 2 + spanLat * t,
            gridHeight
          ),
          Cesium.Cartesian3.fromDegrees(
            workLon + spanLon / 2,
            workLat - spanLat / 2 + spanLat * t,
            gridHeight
          )
        ],
        width: 1.4,
        material: WORKFACE_COLOR.withAlpha(0.55)
      }
    })

    viewer.entities.add({
      id: `workface-v-${i}`,
      name: '采剥作业面',
      polyline: {
        positions: [
          Cesium.Cartesian3.fromDegrees(
            workLon - spanLon / 2 + spanLon * t,
            workLat - spanLat / 2,
            gridHeight
          ),
          Cesium.Cartesian3.fromDegrees(
            workLon - spanLon / 2 + spanLon * t,
            workLat + spanLat / 2,
            gridHeight
          )
        ],
        width: 1.4,
        material: WORKFACE_COLOR.withAlpha(0.55)
      }
    })
  }

  // 台阶运输道路：从坑内通到坑外，高度同样贴采样到的地面。
  // 走向用相对采坑中心的米制偏移书写，与撤离路线同一套基准。
  const haulRoadOffsets: [number, number][][] = [
    // 北侧主运输道路：纵贯采坑南北，出坑后接北侧进场道路
    [
      [18, -199],
      [-18, 0],
      [18, 199],
      [74, 398],
      [129, 619]
    ],
    // 东侧联络道路：沿东帮出坑，通往选矿厂
    [
      [276, -221],
      [478, -88],
      [662, 88],
      [809, 287],
      [919, 486]
    ]
  ]

  for (const [i, offsets] of haulRoadOffsets.entries()) {
    const road = offsets.map(([e, n]) => pitOffset(e, n))
    const positions = await liftPath(road, `haul-${i}`, ROAD_LIFT)
    viewer.entities.add({
      id: `haul-road-${i}`,
      name: '台阶运输道路',
      polyline: { positions, width: 4, material: HAUL_ROAD_COLOR }
    })
  }
}

/**
 * 采场作业人员定位。
 *
 * 返回建出来的实体数组，交给页面按「人员」图层统一显隐——
 * 之前这里返回 void，页面拿不到句柄，工具栏上的「人员」按钮就只能空点。
 */
export async function buildPersonnelLayer(
  viewer: Cesium.Viewer,
  people: PersonnelPosition[]
): Promise<Cesium.Entity[]> {
  const ground = await sampleGroundHeights(
    people.map((p) => ({ key: p.id, lon: p.lon, lat: p.lat })),
    MINE_ELEVATION
  )

  return people.map((p) => {
    const color = p.online ? PERSON_ONLINE_COLOR : PERSON_OFFLINE_COLOR
    return viewer.entities.add({
      id: `person-${p.id}`,
      name: `${p.name} · ${p.area}`,
      // 抬到采样到的地面之上，避免点位被地形与建筑挡住
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, (ground[p.id] ?? MINE_ELEVATION) + PERSON_LIFT),
      point: {
        pixelSize: 9,
        color,
        outlineColor: Cesium.Color.fromCssColorString('#ffffff'),
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        text: p.online ? p.name : `${p.name}（离线）`,
        font: LABEL_FONT,
        fillColor: LABEL_FILL,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#00321f').withAlpha(0.8),
        backgroundPadding: new Cesium.Cartesian2(5, 3),
        pixelOffset: new Cesium.Cartesian2(0, -20),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(300, 1.0, 2500, 0.6)
      }
    })
  })
}

/**
 * 定位基站：覆盖圈 + 站点标注。
 *
 * ⚠️ 覆盖圈曾经**从来没有画出来过**，而且有两个各自独立、各自致命、都不报错的原因
 * （两条都核对过 CesiumUnminified 源码）。改这块之前请先把下面两个注释读完。
 *
 * 覆盖圈用**低透明度填充**而不是只画轮廓：半径六百米的实心圆会盖住采场影像，
 * 但 alpha 压到 0.12 之后它是一层色晕而不是一块实心——既看得出覆盖范围，
 * 又不会把坑糊掉。要画成「环形带」（外圆挖内圆）得用带洞的贴地 polygon，
 * 而洞的绕向与贴地图元对洞的支持都需要另行验证，不在这次修复的范围内。
 */
export async function buildBaseStationLayer(
  viewer: Cesium.Viewer,
  stations: BaseStation[]
): Promise<Cesium.Entity[]> {
  const ground = await sampleGroundHeights(
    stations.map((s) => ({ key: s.id, lon: s.lon, lat: s.lat })),
    MINE_ELEVATION
  )

  const entities: Cesium.Entity[] = []
  for (const s of stations) {
    const color = s.online ? STATION_COLOR : PERSON_OFFLINE_COLOR

    entities.push(
      viewer.entities.add({
        id: `station-ring-${s.id}`,
        name: `${s.name}覆盖范围`,
        // ⚠️ 坑①：**必须有 position。**
        // `EllipseGeometryUpdater.prototype._isHidden` 第一句就是
        // `!defined(entity.position) → true`，而它不抛错、不告警：实体照建、
        // `entities.getById()` 照能拿到、`show` 照能读写，只是永远不渲染。
        // 贴地几何本身用不到这个高度，但更新器要拿它做可见性判断。
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
        // 贴地铺开，圈才不会被采坑的台阶面切掉
        ellipse: {
          semiMajorAxis: s.radius,
          semiMinorAxis: s.radius,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          // ⚠️ 坑②：**贴地几何不能只画轮廓。**
          // `GeometryUpdater` 构造函数里：
          //   if (outlineEnabled && onTerrain) { oneTimeWarning(...); outlineEnabled = false }
          // ——轮廓被强制关掉（控制台只留一条一次性告警）。
          // 于是 `fill: false` + `outline: true` 的净效果是**一个几何体都不建**。
          // 这条与坑①独立：只补 position 的话，结构性审计会变绿，圈**仍然看不见**。
          material: color.withAlpha(0.12)
        }
      })
    )

    entities.push(
      viewer.entities.add({
        id: `station-${s.id}`,
        name: s.name,
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, (ground[s.id] ?? MINE_ELEVATION) + STATION_LIFT),
        point: {
          pixelSize: 11,
          color,
          outlineColor: Cesium.Color.fromCssColorString('#ffffff'),
          outlineWidth: 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: s.online ? `${s.name} · ${s.carriers}载波` : `${s.name} · 离线`,
          font: LABEL_FONT,
          fillColor: LABEL_FILL,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#1b0f33').withAlpha(0.85),
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          pixelOffset: new Cesium.Cartesian2(0, -20),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(300, 1.0, 2500, 0.6)
        }
      })
    )
  }

  return entities
}

/** 人员当日轨迹：虚线折线，高度贴采样地面后抬高 */
export async function buildTrackLayer(
  viewer: Cesium.Viewer,
  tracks: PersonnelTrack[]
): Promise<Cesium.Entity[]> {
  const entities: Cesium.Entity[] = []

  for (const t of tracks) {
    const positions = await liftPath(t.path, `track-${t.id}`, TRACK_LIFT)
    entities.push(
      viewer.entities.add({
        id: `track-${t.id}`,
        name: t.name,
        polyline: {
          positions,
          width: 3,
          // 虚线，与实线的撤离路线区分开
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString(t.color),
            dashLength: 16
          })
        }
      })
    )
  }

  return entities
}
