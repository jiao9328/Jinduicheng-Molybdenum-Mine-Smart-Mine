import { DUMPS, TAILINGS, plantPt, pitOffset } from './mineLayout'
import type { SceneWaypoint } from './sceneConfig'

/**
 * 「三维实体 → 业务对象」的解析层 —— 双向联动的地基。
 *
 * 面板点图表要飞到某台设备、点三维地物要查出它是谁，两边都要先把
 * Cesium 实体 id（`twin-device-DR-01` 这种）还原成业务键（`DR-01`）。
 * 这个文件就是那把尺子。
 *
 * ---------------------------------------------------------------------------
 * 为什么解析 id 前缀，而不是给实体加 `properties`
 * ---------------------------------------------------------------------------
 * 加 `properties` 是 Cesium 里更「正统」的做法，但要给**已有的 5 个图层文件**
 * 逐个补字段，而它们的 id 早就是 `前缀-业务键` 的形状了（这是全库一致的既有约定，
 * 不是这次为了联动才发明的）。解析前缀**一行既有图层代码都不用改**，
 * 风险为零；等哪天 id 约定撑不住了再谈迁移。
 *
 * ⚠️ 前缀表**顺序有意义，必须长的在前**：`twin-risk-label-RZ-01` 若先撞上
 * `twin-risk-`，业务键会解析成 `label-RZ-01`，页面上查不到东西、
 * 还不会报错——静默失效正是本项目反复踩的那类坑。表尾有一条自检兜底。
 *
 * 本文件是**纯函数 + 纯坐标**：不 import 任何 mock/api 的数据。
 * `src/scene/` 下所有文件都只从 `@/api/*` 取**类型**，数据一律由页面传进来，
 * 这条分层规矩不能破（破了三维层就会跟演示数据缠在一起，换真数据时要动两处）。
 */

/** 三维里可被拾取的地物种类 */
export type TargetKind =
  | 'device'
  | 'risk'
  | 'slope'
  | 'safety'
  | 'person'
  | 'station'
  | 'track'
  | 'route'
  | 'workface'
  | 'haulRoad'
  | 'building'
  | 'silo'
  | 'thickener'
  | 'dome'
  | 'loader'
  | 'tank'
  | 'conveyor'
  | 'bench'
  | 'pit'
  | 'dump'
  | 'road'
  | 'tree'
  | 'tailings'
  /** 成本归属地标注（成本管理页）—— 业务键是成本项名，不是地物名 */
  | 'cost'
  /** 区域统计标注（统计报表页）—— 业务键是区域名（`北帮采剥面`） */
  | 'area'

export interface TargetRef {
  kind: TargetKind
  /**
   * 业务键 —— **本模块原样透出，不做任何解释**。
   *
   * 它是什么取决于 kind：`device` 是 `twinDevices[].id`（`DR-01`），
   * `building` 是 `PLANT_BUILDINGS` 的**数组下标字符串**（`'3'`），
   * `bench` 是台地代号（`T1`）。页面自己按 kind 去查对应的业务数组。
   */
  key: string
}

/**
 * 前缀表 —— 顺序即匹配优先级，**长的必须排在短的前面**。
 *
 * 第三列的 `'rest'` / `'first'` 是取键方式，两者必须分开：
 *   - `rest`  —— 业务键含连字符，要取前缀之后的**整段**
 *                （`person-P-1024` → `P-1024`；取首段会得到 `P`）
 *   - `first` —— 业务键是**单个 token**，后面跟的是部件名，只取首段
 *                （`bld-0-roof-3` → `0`；取整段会得到 `0-roof-3`）
 *
 * 这张表是对着 `src/scene/` 下**全部** `id:` 模板逐个核出来的
 * （`grep -rn 'id: \`' src/scene/` 共 56 条模板），不是照着记忆写的。
 */
const PREFIXES: ReadonlyArray<readonly [string, TargetKind, 'rest' | 'first']> = [
  // --- 长前缀优先：这两条一旦落后，键就会多带一段 ---
  ['twin-risk-label-', 'risk', 'rest'],
  ['twin-device-', 'device', 'rest'],
  // 成本归属地（成本管理页）。业务键是成本项名（`钻机` / `能耗`），故用 'rest'
  ['cost-site-', 'cost', 'rest'],
  // 区域统计标注（统计报表页）。业务键是区域名（`北帮采剥面`）—— 含中文但不含连字符，
  // 用 'rest' 是为了跟同族的 cost-site 一个取法，将来区域名里出现连字符也不用改
  ['stat-area-', 'area', 'rest'],
  ['twin-risk-', 'risk', 'rest'],
  ['station-ring-', 'station', 'rest'],
  ['safety-facility-', 'safety', 'rest'],
  ['safety-label-', 'safety', 'rest'],
  ['safety-circle-', 'safety', 'rest'],
  ['safety-alert-', 'safety', 'rest'],
  ['slope-base-', 'slope', 'rest'],
  ['slope-trace-', 'slope', 'rest'],
  ['slope-site-', 'slope', 'rest'],
  ['route-base-', 'route', 'rest'],
  ['route-flow-', 'route', 'rest'],
  ['workface-h-', 'workface', 'first'],
  ['workface-v-', 'workface', 'first'],
  ['haul-road-', 'haulRoad', 'rest'],
  ['bench-wall-', 'bench', 'first'],
  ['pit-berm-', 'pit', 'first'],
  ['pit-face-', 'pit', 'first'],
  ['conveyor-', 'conveyor', 'first'],
  ['station-', 'station', 'rest'],
  ['person-', 'person', 'rest'],
  ['track-', 'track', 'rest'],
  ['bench-', 'bench', 'first'],
  ['bld-', 'building', 'first'],
  ['silo-', 'silo', 'first'],
  ['thick-', 'thickener', 'first'],
  ['dome-', 'dome', 'first'],
  ['loader-', 'loader', 'first'],
  ['tank-', 'tank', 'first'],
  ['dump-', 'dump', 'first'],
  ['road-', 'road', 'first'],
  ['tree-', 'tree', 'first']
]

/**
 * 把一个 Cesium 实体 id 解析成业务引用。
 *
 * **认不出就返回 `null`，由调用方决定怎么办**（页面统一按「点了空地」处理，
 * 清掉选中态）。返回 null 是常态而非异常：实景三维倾斜摄影的瓦片被点中时
 * 也会走到这里，那种命中本来就没有业务含义。
 *
 * ⚠️ 但「前缀认识、键取不出来」是**另一回事**，那种情况会打一条 `console.info`
 * 把原始 id 写出来。本项目已经因为「名字对不上却静默返回 undefined」
 * 白屏过一次（见 `sceneConfig.ts:92-96` 的 `namedBuilding`），
 * 所以这里宁可留个可查的痕迹，也不让它安静地消失。
 */
export function parseEntityId(id: string | null | undefined): TargetRef | null {
  if (!id) return null

  for (const [prefix, kind, mode] of PREFIXES) {
    if (!id.startsWith(prefix)) continue

    const rest = id.slice(prefix.length)
    if (!rest) {
      console.info(`[sceneTargets] 实体 id「${id}」只有前缀没有业务键，无法解析`)
      return null
    }

    // 'first' 取到第一个连字符为止；'rest' 原样保留（业务键本身含连字符）
    const key = mode === 'first' ? rest.split('-')[0] : rest
    if (!key) {
      console.info(`[sceneTargets] 实体 id「${id}」取不出业务键，无法解析`)
      return null
    }

    return { kind, key }
  }

  return null
}

/**
 * 区域锚点 —— **中文地名 → 坐标**。
 *
 * 为什么需要它：隐患清单里的「位置」是个中文地名（`北帮采剥面`），
 * 三维里却没有对应的实体可飞——那些地方本来就没画东西。
 * 「点告警 → 飞到现场」要成立，就得有一张地名到坐标的表。
 *
 * ⚠️ **坐标不是这里发明的，是从既有数据反推的**：
 * 前 5 条的偏移量取自 `mock/emergency.ts` 里同名的作业人员点位
 * （那里用 `pt(e, n)`＝`pitOffset(e, n)` 写死），两处必须一致；
 * `check-linkage.mjs` 会断言这一点，改了一边忘了另一边会红。
 * 后 3 条直接引用 `mineLayout` 的地物中心，不另抄坐标。
 *
 * `height` 是**相机注视点海拔**，取自 `sceneConfig.SCENE_WAYPOINTS`
 * 里同类地物的实测值（采坑 1345 / 排土场 1417 / 尾矿库 1545）。
 * 不写 0：这个矿区地面就在 1300m 以上，写 0 会让构图整体沉到地下。
 */
export interface AreaAnchor {
  /** 展示名，浮层标题用 */
  label: string
  lon: number
  lat: number
  height: number
}

const pitPoint = (eastM: number, northM: number, label: string): AreaAnchor => {
  const [lon, lat] = pitOffset(eastM, northM)
  return { label, lon, lat, height: 1345 }
}

const plantPoint = (x: number, y: number, label: string): AreaAnchor => {
  const [lon, lat] = plantPt(x, y)
  // 厂区台地标高 T1~T4 实测 1374.2 / 1369.2 / 1361.5 / 1349.0，
  // 注视点取中段 T2 偏上，一个值对全厂都够用
  return { label, lon, lat, height: 1374 }
}

export const AREA_ANCHORS: Record<string, AreaAnchor> = {
  // -- 与 mock/emergency.ts 的人员点位同源（pt(...) 的实参逐个对齐）--
  北帮采剥面: pitPoint(-120, 180, '北帮采剥面'),
  主运输道路: pitPoint(450, 60, '主运输道路'),
  东帮爆破区: pitPoint(260, -60, '东帮爆破区'),
  坑底集水池: pitPoint(0, 0, '坑底集水池'),
  排土场复垦区: { label: '排土场复垦区', lon: DUMPS[0].lon, lat: DUMPS[0].lat, height: 1417 },

  // -- 与「区域隐患统计」的区划名对齐（areaHazards.areas 里还有「排土场」「尾矿库」）--
  排土场: { label: '排土场', lon: DUMPS[0].lon, lat: DUMPS[0].lat, height: 1417 },
  尾矿库: { label: '尾矿库', lon: TAILINGS.lon, lat: TAILINGS.lat, height: 1545 },

  // -- 厂区 --
  厂区: plantPoint(100, 0, '选矿厂'),
  选矿厂: plantPoint(100, 0, '选矿厂')
}

/** 取锚点；没有对应地名时返回 null，**不要退化成「飞到矿区中心」了事** */
export function areaAnchor(name: string | null | undefined): AreaAnchor | null {
  if (!name) return null
  return AREA_ANCHORS[name] ?? null
}

/**
 * 各类型地物的机位距离（米）。
 *
 * 一档一类，不做「智能算距离」——这里要的是**每次点同一类东西，
 * 画面变化是可预期的**，而不是把构图交给一个会随数据飘的公式。
 */
const RANGE_OF: Record<TargetKind, number> = {
  device: 260,
  person: 180,
  slope: 220,
  station: 400,
  track: 300,
  risk: 900,
  safety: 320,
  route: 700,
  workface: 500,
  haulRoad: 500,
  building: 340,
  silo: 260,
  thickener: 300,
  dome: 260,
  loader: 300,
  tank: 260,
  conveyor: 420,
  bench: 700,
  pit: 1500,
  dump: 850,
  road: 600,
  tree: 260,
  tailings: 780,
  // 成本归属地跨采坑与厂区，机位要能看到整片矿区才读得出「钱分布在哪」
  cost: 1200,
  // 区域统计标注跨采坑、排土场与尾矿库，同上：要一眼看全才读得出「哪个区域多少」
  area: 1200
}

/**
 * 由「注视点 + 地物类型」造一个机位。
 *
 * 方位角固定 0（正北）、俯角 -35：这两个参数在**看一眼某地物**这个动作上
 * 没有信息量，按类型给个稳定值就够；真正随点选变化的是注视点本身。
 * 俯角取 -35 而不是 -90（垂直下看）：俯视能同时看到地物和它周围的地形，
 * 垂直下看会让人失去方位感，不知道自己飞到哪了。
 */
export function waypointOfTarget(
  ref: TargetRef,
  at: { lon: number; lat: number; height: number },
  label?: string
): SceneWaypoint {
  return {
    key: `${ref.kind}-${ref.key}`,
    label: label ?? `${ref.kind} ${ref.key}`,
    lon: at.lon,
    lat: at.lat,
    height: at.height,
    heading: 0,
    pitch: -35,
    range: RANGE_OF[ref.kind]
  }
}

/**
 * 采坑内的注视点海拔，取自 `sceneConfig.SCENE_WAYPOINTS` 里 `pit` 那一档
 * （DEM 实测）。设备、人员、边坡、风险区都在坑内或坑沿，共用这一档。
 */
export const PIT_VIEW_HEIGHT = 1345

/**
 * 采坑内点位的机位 —— 给「点图表 → 飞到那台设备/那个人」用。
 *
 * 存在的意义是把 `pitOffset` 这一步收进来：调用点只拿得到业务数据里的
 * `eastM / northM`，**不该在页面里再手写一次坐标换算**（本项目对
 * 「同一件事有两个说法」零容忍，理由见 `mock/digitalTwin.ts` 顶部注释）。
 */
export function pitWaypoint(
  kind: TargetKind,
  key: string,
  eastM: number,
  northM: number,
  label?: string
): SceneWaypoint {
  const [lon, lat] = pitOffset(eastM, northM)
  return waypointOfTarget({ kind, key }, { lon, lat, height: PIT_VIEW_HEIGHT }, label)
}

/** 厂区内点位的机位 —— 厂区台地标高实测 T1~T4 为 1374.2 ~ 1349.0 */
export function plantWaypoint(
  kind: TargetKind,
  key: string,
  x: number,
  y: number,
  label?: string
): SceneWaypoint {
  const [lon, lat] = plantPt(x, y)
  return waypointOfTarget({ kind, key }, { lon, lat, height: 1374 }, label)
}

/**
 * 一次三维拾取的完整结果 —— `MapScene` 的 `pick` 事件载荷。
 *
 * 刻意**不含任何 Cesium 对象**：页面拿到它之后要么用 `entityId` 走
 * `parseEntityId`，要么用 `lonLat` 定位，都不需要再 import Cesium。
 * 把 Entity 直接抛出去会让页面和 Cesium 的生命周期绑在一起
 * （实体可能在下一次 `show` 切换后就不在场景里了）。
 */
export interface ScenePick {
  /** 命中实体的 id；没命中实体（含倾斜摄影瓦片、天空、地面）时为 null */
  entityId: string | null
  /** 命中实体的中文名；同上 */
  entityName: string | null
  /** 命中处的经纬高；连地球都没打中时为 null */
  lonLat: { lon: number; lat: number; height: number } | null
  /** 屏幕坐标，浮层定位用（相对三维容器） */
  screen: { x: number; y: number }
  /**
   * 命中的是**非实体**的东西 —— 实景三维倾斜摄影瓦片、程序化场景的 Primitive。
   * 这类命中没有 `entityId`，页面据此走「点了片地形」的分支而不是「点了空地」。
   */
  tileset: boolean
}
