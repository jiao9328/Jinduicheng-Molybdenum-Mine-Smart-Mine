import * as Cesium from 'cesium'
import { BUILDINGS, DUMPS, PIT, TAILINGS, plantPt } from './mineLayout'
import type { BuildingSpec } from './mineLayout'

/**
 * 场景全局配置
 * 坐标系、初始相机、配色都集中在这里，方便按真实矿区替换。
 *
 * 「地物在哪」不在这里，见 `./mineLayout`；这里只放机身与相机相关的配置。
 */

/**
 * 矿区中心
 *
 * 金堆城钼矿（陕西省渭南市华州区金堆镇），秦岭北麓，西安东南约 155km。
 * 亚洲第一、世界第二的钼矿，露天开采，现状最高边坡 410m。
 *
 * 该坐标用于对齐本地的离线卫星底图，改动时必须同步更新
 * scripts/fetch-map-tiles.mjs 里的 CENTER，否则三维物体会与影像错位。
 */
export const MINE_CENTER = Cesium.Cartesian3.fromDegrees(109.9561, 34.3281, 0)

/**
 * 相机机位。
 *
 * 用「看向哪个点 + 从多远看 + 从哪个方向看」描述，而不是直接写相机坐标——
 * 直接写 destination 很容易因为俯角与高度不匹配，把目标挤出屏幕。
 */
export interface SceneWaypoint {
  key: string
  label: string
  /** 相机注视点 */
  lon: number
  lat: number
  height: number
  /** 方位角（度），0 为正北 */
  heading: number
  /** 俯角（度），负值表示向下看 */
  pitch: number
  /** 相机与注视点的距离（米） */
  range: number
}

/**
 * 主视图机位：南侧俯瞰整个矿区。
 *
 * range 取值需让矿区落在左右面板之间的可视区（约 1100px）内，
 * 太小会顶到屏幕两侧被面板遮挡，太大会显得空旷。
 *
 * height 是**注视点的海拔**，不是离地高度。金堆城在秦岭北麓，
 * 矿区地面标高约 1300m，写 0 会让相机的 ENU 参考面落到地下 1.3km，
 * 整个构图全错。各机位的 height 均取自 DEM 实测（scripts/_sample-heights.mjs）。
 */
/** 全厂注视点：厂区局部坐标 (100, 0)，即 T2/T3 之间的谷底 */
const plantMid = plantPt(100, 0)

export const HOME_WAYPOINT: SceneWaypoint = {
  key: 'home',
  label: '全局',
  // 注视点取**新厂址谷底**，不再用采坑南侧的旧谷——厂区搬走后那里的画面里
  // 只剩采坑，而 range 3200 把厂区甩到了视野边上。
  //
  // 经纬度**由 `plantPt` 算，不手抄**（原先写的字面量与 (100, 0) 只差 2.5m，
  // 是「对的」，但下一次搬厂它就会变成一个安静的错误——和 `verify-alignment.mjs`
  // 里那套写死在旧矿的坐标同一类问题）。
  lon: plantMid[0],
  lat: plantMid[1],
  height: 1372,
  heading: 61,
  pitch: -40,
  range: 3200
}

/**
 * 数字孪生页底部 Tab 对应的机位
 * 见开发指导文档 8.1：点击 Tab 后 flyTo 到对应位置
 *
 * 注视点的经纬度**从 `mineLayout` 推导**，不在这里另写一份——
 * 这些机位原先各自硬编码了一份坐标，`mineLayout` 按影像实测校正后
 * 它们不会跟着动，点 Tab 就会飞到旧位置上去。
 * 这里只保留「从哪个方向、多远、什么俯角看」这类纯相机参数。
 */
/**
 * 按名称取建筑。
 *
 * **找不到就抛，不要写 `!`。** 厂区搬进山谷时「选矿主厂房」改名成了
 * 「磨浮主厂房」，这里原来的 `find(...)!` 悄悄变成 `undefined`，
 * 紧接着下面 `.lon` 在**模块求值期**抛错，整个 bundle 都没跑起来——
 * 症状是全站白屏、CSS 正常、控制台只有一行读属性失败，排查方向会被带偏。
 * 抛一句带名字的错，至少把「是哪个名字对不上」直接写出来。
 */
function namedBuilding(name: string): BuildingSpec {
  const b = BUILDINGS.find((x) => x.name === name)
  if (!b) throw new Error(`sceneConfig: mineLayout 里没有名为「${name}」的建筑，机位无法定位`)
  return b
}

const plantCenter = namedBuilding('磨浮主厂房')
const crusher = namedBuilding('粗碎站')

export const SCENE_WAYPOINTS: SceneWaypoint[] = [
  {
    key: 'pit',
    label: '露天采坑',
    lon: PIT.lon,
    lat: PIT.lat,
    height: 1345,
    heading: 25,
    pitch: -30,
    range: 1500
  },
  {
    key: 'crusher',
    label: '粗碎站',
    lon: crusher.lon,
    lat: crusher.lat,
    // 粗碎站坐在 T1（平台 1374.2），注视点取厂房半高
    height: 1386,
    heading: 241,
    pitch: -18,
    range: 320
  },
  {
    key: 'plant',
    label: '选矿厂',
    lon: plantCenter.lon,
    lat: plantCenter.lat,
    // 磨浮主厂房坐在 T3（平台 1361.5）
    height: 1374,
    heading: 256,
    pitch: -26,
    range: 620
  },
  {
    key: 'conveyor',
    label: '皮带廊',
    // 两点中点落在 T2 中段（平台 1369.2），那里正好是
    // 原矿仓→中细碎→筛分 这一串廊道最密的一段
    lon: (plantCenter.lon + crusher.lon) / 2,
    lat: (plantCenter.lat + crusher.lat) / 2,
    height: 1384,
    heading: 111,
    pitch: -20,
    range: 420
  },
  {
    key: 'dump',
    label: '排土场',
    lon: DUMPS[0].lon,
    lat: DUMPS[0].lat,
    height: 1417,
    heading: 80,
    pitch: -28,
    range: 850
  },
  {
    key: 'tailings',
    label: '尾矿库',
    lon: TAILINGS.lon,
    lat: TAILINGS.lat,
    height: 1545,
    heading: 0,
    pitch: -30,
    range: 780
  }
]

/**
 * 把机位换算成 Camera.flyTo 的参数。
 *
 * 注意：flyTo 的 orientation 只接受 {heading, pitch, roll}，
 * 不能直接塞 HeadingPitchRange（那是 lookAt 的参数形式，混用会导致相机位置错误）。
 * 这里在注视点的 ENU 局部坐标系里按「距离 + 俯角 + 方位角」算出相机偏移量，
 * 再叠加到注视点上，得到相机世界坐标。
 *
 * pitch 为负表示向下看，此时相机在注视点的高处，偏移分量向上。
 */
export function waypointToFlyTo(wp: SceneWaypoint): {
  destination: Cesium.Cartesian3
  orientation: { heading: number; pitch: number; roll: number }
} {
  const target = Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.height)

  const heading = Cesium.Math.toRadians(wp.heading)
  const pitch = Cesium.Math.toRadians(wp.pitch)
  const { range } = wp

  // ENU 局部坐标系下的相机偏移量
  // -x：东向分量（heading 决定朝向）
  // -z：天向分量（pitch 决定高度，俯角为负 → 相机在上方）
  const offsetEnu = new Cesium.Cartesian3(
    -range * Math.cos(pitch) * Math.sin(heading),
    -range * Math.cos(pitch) * Math.cos(heading),
    -range * Math.sin(pitch)
  )

  const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(target)
  const destination = Cesium.Matrix4.multiplyByPoint(
    enuToFixed,
    offsetEnu,
    new Cesium.Cartesian3()
  )

  return {
    destination,
    orientation: { heading, pitch, roll: 0 }
  }
}

/**
 * 矿区地面标高（米）。
 *
 * 取自离线 DEM 实测：采坑一带约 1300m，选矿厂台地 1400~1490m。
 * **所有业务图层（安全标注、避灾路线、人员点位）的高度都必须以它为基准**——
 * 接了真实地形之后，写死 height: 10 这种绝对高度的标注会整片埋进山里，
 * 因为地表本身就在 1300m 以上。
 */
export const MINE_ELEVATION = 1300

/** 场景配色 —— 与主题变量保持一致 */
export const SCENE_COLORS = {
  primary: Cesium.Color.fromCssColorString('#00e5ff'),
  primaryTransparent: Cesium.Color.fromCssColorString('#00e5ff').withAlpha(0.25),
  green: Cesium.Color.fromCssColorString('#00ff9d'),
  yellow: Cesium.Color.fromCssColorString('#ffd60a'),
  orange: Cesium.Color.fromCssColorString('#ff9f1c'),
  red: Cesium.Color.fromCssColorString('#ff4d4f'),
  purple: Cesium.Color.fromCssColorString('#b388ff'),
  blue: Cesium.Color.fromCssColorString('#1890ff'),
  /** 建筑：厂房蓝顶 */
  roof: Cesium.Color.fromCssColorString('#2f8fd4'),
  wall: Cesium.Color.fromCssColorString('#dce7f2'),
  terrain: Cesium.Color.fromCssColorString('#6b5a42')
}

/** 露天采坑分层配色（由外到内逐层加深） */
export const PIT_COLORS = {
  ground: '#16324a', // 矿区地面
  plaza: '#24455f', // 工业广场硬化地面
  stepA: '#b08d5e', // 台阶亮面
  stepB: '#8f7048', // 台阶暗面
  face: '#7d6040', // 帮坡面（台阶之间的陡壁，比平台更暗）
  bottom: '#6b5436' // 坑底
}

/** 地形配色 */
export const TERRAIN_COLORS = {
  hill: '#1f4a30',
  road: '#5b7690'
}

/**
 * 选矿厂配色。
 *
 * 调子照着甲方给的效果图定的：**蓝色彩钢屋顶 + 浅灰墙面 + 石材灰挡墙**，
 * 大跨度厂房全是这个组合，从空中看下去整片是蓝的——这是选矿厂最好认的颜色特征。
 * 米色（`shed`）只给露天料棚，蓝穹顶只给封闭精矿仓，两种料仓不能混色，
 * 混了就看不出哪个是防雨的、哪个只是挡尘。
 */
export const PLANT_COLORS = {
  /** 台地硬化面（深蓝灰，与 PIT_COLORS.plaza 同调，不抢厂房的蓝） */
  benchTop: '#1d3d57',
  /** 台地侧面：削坡与挡土墙的石材灰 */
  benchSide: '#7d8b97',
  /** 厂房蓝顶（效果图的主色） */
  roofBlue: '#2f8fd4',
  /** 混凝土：装车仓、浓密池壁、储罐 */
  concrete: '#b9c4cd',
  /** 钢构：走桥、溜槽、罐顶 */
  steel: '#9aa9b6',
  /** 封闭精矿仓的蓝穹顶 */
  dome: '#2b7fd4',
  /** 露天料棚的米色椭球顶 */
  shed: '#ded3b4',
  /** 浓密池里的矿浆 */
  slurry: '#6f5a4a',
  /** 重卡车斗里的矿（与矿石同色） */
  ore: '#6b6255',
  /** 矿用卡车驾驶室 */
  truck: '#e8b23a'
}
