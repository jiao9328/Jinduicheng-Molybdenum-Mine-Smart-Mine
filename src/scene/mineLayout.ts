/**
 * 矿区地物坐标 —— **三维场景的唯一坐标数据源**。
 *
 * 单独成文件而不是留在 `buildMineScene.ts` 里，有两个原因：
 *
 * 1. 这些数字不是「画图参数」，是**从离线卫星影像与 DEM 上量出来的实测位置**，
 *    它们需要能被独立核对。核对手段：
 *      - `scripts/overlay-check.mjs`   把本文件的足迹按真实经纬度叠回影像，看偏了多少米
 *      - `scripts/detect-buildings.mjs` 从影像里自动提取屋顶面，给出实测中心与尺寸
 *      - `scripts/analyze-dem.mjs`      从 DEM 里量采坑、平地、水体
 *    脚本按 Node 类型剥离直接读本文件，不跑 vite，所以这里**不能 import Cesium**。
 * 2. 建场景的代码（材质、几何、高程采样）和「东西在哪」（本文件）是两件事，
 *    改一个不该牵动另一个。
 *
 * 颜色不在这里定义：本文件只回答「在哪、多大」，具体用什么色由 sceneConfig 决定。
 *
 * ---------------------------------------------------------------------------
 * 采坑的坐标来历（2026-09 重新实测）
 * ---------------------------------------------------------------------------
 * 矿区中心 (109.9561, 34.3281) 与公开资料一致：
 *   金堆城钼矿，陕西省渭南市华州区金堆镇，东经 109°57′22″、北纬 34°19′41″。
 * 底图为 `public/map-tiles/imagery`（ArcGIS World Imagery 离线瓦片，z17 约 1m/px），
 * Cesium 里 `baseLayer: false` + `OfflineTileImageryProvider`，**看的和量的就是同一份图**。
 *
 * 坐标改动的正确姿势：先跑 `node scripts/overlay-check.mjs`，
 * 看着影像上的偏移量改，**不要凭感觉调**。
 *
 * ⚠️ **厂区（选矿厂）是唯一的例外，它的坐标不是实测的。** 见下面「选矿厂」一节。
 */

/** 经纬度点 */
export type LonLat = [number, number]

/** 局部平面直角坐标（米），用于多边形内缩等几何运算 */
export interface Pt {
  x: number
  y: number
}

/** 屋顶用色（语义名，实际色值见 sceneConfig.SCENE_COLORS） */
export type RoofKind = 'roof' | 'blue'

// ---------------------------------------------------------------------------
// 米与度的换算
// ---------------------------------------------------------------------------
//
// ⚠️ **这两个必须留在文件最前面。** 下面的「选矿厂」一节在**模块求值期**
// 就调 `plantPt()` 把局部坐标批量折算成经纬度，而 `plantPt` 要读
// `METERS_PER_LAT`。它原先声明在文件末尾，于是 `const` 的暂时性死区
// （TDZ）在浏览器里炸成 `ReferenceError: Cannot access 'd' before
// initialization`——**构建、类型检查全绿**，只有打开页面才白屏。
// 移动这两个常量前，先确认没有模块级的调用点在它们上面。

/** 每度经度对应的米数（按给定纬度） */
export function metersPerLon(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180)
}

/** 每度纬度对应的米数 */
export const METERS_PER_LAT = 110540

// ---------------------------------------------------------------------------
// 采坑
// ---------------------------------------------------------------------------

/**
 * 露天采坑。
 *
 * 中心由两条独立证据共同确定，彼此吻合：
 *   - DEM（AWS Terrarium，z14）在以 (109.954, 34.328) 为参考、半径 1.8km 内
 *     的最低点为 **1028m，位于 (109.95399, 34.33096)**，即坑底
 *   - 影像判读在该处可见同心台阶状的采矿痕迹
 * 原先配置的中心 (109.9540, 34.3280) 落在坑沿上，比坑底偏南约 220m。
 * 这里直接取坑底所在点 (109.9538, 34.3308) 作坑心，并让椭圆略向西北外扩，
 * 因为影像判读显示台阶场在西北方向延伸得更远。
 *
 * 尺寸说明：DEM 在该处只解析出 213×126m 的坑底范围（z14 约 7.9m/px，
 * 会把密集台阶抹平），而公示资料称「现状边坡最高 410m」，两者对不上。
 * 这里的 rx/ry 取影像上可见台阶场的量级，属于**判读值而非测量值**，
 * 若后续拿到矿区总平面图应以此为准。
 */
export const PIT = {
  lon: 109.9538,
  lat: 34.3308,
  /** 东西向半轴（米） */
  rx: 365,
  /** 南北向半轴（米） */
  ry: 315,
  /** 台阶高度（米） */
  benchHeight: 25,
  /** 安全平台宽度（米） */
  bermWidth: 16,
  /** 坡面水平投影（米）：与台阶高度一起决定帮坡角，25/22 ≈ 49° */
  faceWidth: 22,
  /** 台阶数：7 × 25m = 175m 深 */
  benches: 7
}

/**
 * 坑底积水从坑底环再内缩这个距离得到（米）。
 *
 * 以前这里是固定的椭圆半轴（90×70 米）——比坑底本身还大：坑底是
 * 外沿内缩 7×38=266 米缩出来的，只剩约 99×49 米。椭圆顶出坑壁，
 * 水面会斜插进帮坡、一部分悬在半空。现在形状随坑底走，内缩多少都出不去。
 */
export const PIT_WATER_INSET = 6

// ---------------------------------------------------------------------------
// 选矿厂：谷底分级台地
// ---------------------------------------------------------------------------

/**
 * ## 厂址是怎么定下来的（第三次，也是最后一次）
 *
 * 采坑南侧有一条山谷，甲方明确选矿厂建**在谷底**，场坪做**分级台地**
 * 而不是一块大平场。厂址换过两次，两次都是因为**地形放不下**：
 *
 *   1. 第一处（lon 109.956 一带，1280m）：谷底纵向坡度 28%，一级台地
 *      自己就跨 88m 落差，再怎么调标高也削不平，整级埋进山里；
 *   2. 第二处：谷底只有 80~120m 宽，而磨浮主厂房长 150m —— 跨谷摆不下，
 *      顺谷摆又要转 90°，与「顺着谷走」自相矛盾。
 *
 * 第三次由使用者用 `#/coord-picker` 在底图上**自选**，上游端点（粗碎站）
 * `109.971489, 34.339203`、下游端点（精矿库）`109.963950, 34.329806`，
 * 相距 1249m，走向 33.7°。这两点定出 `PLANT_AXIS_DEG` 与厂区长度，
 * 原点取两点中点。这条谷**纵坡只有 2.6%**（1250m 落 32m），可用。
 *
 * 谷底的两件事必须记住，四级台地的尺寸就是照着它们定的
 * （数据来自 `scripts/analyze-bench-site.mjs` 对离线 DEM 的实测）：
 *
 *   - **谷底是弯的**：四级的中泓分别在 x ≈ +60 / +170 / +250 / +70，
 *     横向摆开近 190m。所以四条台地**各切各的台**，中心线 `cx` 逐级不同；
 *     硬修一条直中心线会削出 20m 的坡。
 *   - **有一道山嘴**从东北伸进来，在 y ≈ 320~400 卡住谷宽：那里 x ≥ 140
 *     的高程从 1387 直窜到 1424。T1 因此**不按等分截取**，在上游收窄到
 *     x 0~100，把这道山嘴整个让出去。等分四级的话 T1 足迹极差 55m。
 *
 * ⚠️ 平**面**位置是按 DEM 实测地形设计的**设计值**，不是卫星影像判读值。
 * `overlay-check.mjs` 对厂区**不再有意义**（叠上去本来就对不齐），
 * 它现在只对采坑、排土场、尾矿库这几个真实地物有效。
 *
 * ## 局部坐标系
 *
 * 厂区顺谷轴呈**带状**铺开，全部几何用一套局部米制坐标描述：
 * `x` 横向（约当东，+x 指向谷的东南侧），`y` 纵向**沿谷轴向北**——
 * `+y` 就是**上游**，即粗碎站那一头，这段方位角恰为 `PLANT_AXIS_DEG`。
 * 由 `plantPt` 统一换算成经纬度，**「谷轴偏了 33.7°」只存在于一个常量里**。
 *
 * ⚠️ 厂房的长边一律走 `width` → 局部 **y**（顺谷），`depth` → 局部 x（跨谷）。
 * 谷底只有 ~120m 宽，长边跨谷是摆不下的；这个映射写在 `buildPlant`
 * 的 `buildBuilding` 里，改的时候两处要一起改。
 */
export const PLANT_ORIGIN: LonLat = [109.96772, 34.3345]

/**
 * 厂区主轴方位角（度，自正北顺时针）。使用者实测两点：上游 → 下游 213.7°，
 * 取其反向 33.7° 即为 **+y（上游）方向**。
 *
 * 导出是必需的：`buildPlant` 要按同一个角做逆变换（经纬度 → 局部），
 * 两边各写一份 33.7 迟早会漏改一处，表现是皮带廊支腿整片偏移。
 */
export const PLANT_AXIS_DEG = 33.7

/** 厂区局部坐标（米）→ 经纬度 */
export function plantPt(x: number, y: number): LonLat {
  const a = (PLANT_AXIS_DEG * Math.PI) / 180
  const east = x * Math.cos(a) + y * Math.sin(a)
  const north = -x * Math.sin(a) + y * Math.cos(a)
  return [
    PLANT_ORIGIN[0] + east / metersPerLon(PLANT_ORIGIN[1]),
    PLANT_ORIGIN[1] + north / METERS_PER_LAT
  ]
}

/** 台地代号 */
export type BenchKey = 'T1' | 'T2' | 'T3' | 'T4'

/**
 * 分级台地。
 *
 * 山地选矿厂不做成一块大平场，而是**顺谷分级削填**：一级比一级低，
 * 矿石靠重力自流，从最上一级的粗碎一路走到最下一级的精矿装车。
 * 这是选矿厂总平面布置的通行做法，也是「粗碎在高、磨浮在低」的原因——
 * 少一次提升就少一份能耗，整套流程因此天然是「顺着山谷往下走」的。
 *
 * 纵向范围是局部坐标的 y（沿谷轴，负值在下游）。
 * 相邻台地留 15m 净距，那一段是挡土墙与边坡，不做硬化。
 *
 * ⚠️ **四级不是等长的。** 按谷长均分的话 T1 会跨在那道东北山嘴上
 * （足迹极差实测 55m），所以逐级按「这一级要放什么」定尺寸，
 * 也让开山嘴：T1 只有 175m 长且收窄到 100m 宽，T2~T4 各约 300m。
 *
 * ⚠️ **设计标高不在这里写死。** 谷底不是一个平面，写死必然一头埋进山、
 * 一头悬在空中。建场景时按每个台地的足迹采样地形再逐级递推，
 * 实测值由 `buildBenches` 打印出来（含选址诊断）。
 *
 * 本级尺寸的定法：`analyze-bench-site.mjs` 在离线 DEM 上把足迹内的 7×5 网格
 * 打出来，反复试到「足迹沿谷落差 < 15m 且平台不低于本级最低点」为止。
 * 实测结果（平台标高 / 级差）：1374.2 / 1369.2（5.0）/ 1361.5（7.7）/
 * 1349.0（12.6），全厂累计 25.3m，落在 GB50187 四级 15~25m 的经验区间上。
 */
export interface BenchSpec {
  key: BenchKey
  name: string
  /** 沿谷轴向北的起点（米） */
  y0: number
  /** 沿谷轴向北的终点（米） */
  y1: number
  /** 台地中心线的横向位置（米）。四级各切各的台，所以逐级不同 */
  cx: number
  /** 横向半宽（米）。足迹即 x ∈ [cx-halfWidth, cx+halfWidth] */
  halfWidth: number
  /** 这一级上放什么 */
  usage: string
}

export const BENCHES: BenchSpec[] = [
  // T1 让开 y≈320~400 那道山嘴：不往下游伸，横向也只到 x=100
  { key: 'T1', name: '粗碎台地', y0: 450, y1: 625, cx: 50, halfWidth: 50, usage: '卸矿平台 · 粗碎站 · 原矿仓' },
  { key: 'T2', name: '中细碎台地', y0: 0, y1: 300, cx: 100, halfWidth: 80, usage: '中细碎 · 筛分 · 选前矿仓' },
  { key: 'T3', name: '磨浮台地', y0: -310, y1: -25, cx: 120, halfWidth: 100, usage: '磨浮主厂房 · 浓密池' },
  { key: 'T4', name: '精矿台地', y0: -650, y1: -345, cx: 120, halfWidth: 80, usage: '精矿脱水 · 精矿库 · 装车站' }
]

// ---------------------------------------------------------------------------
// 建筑
// ---------------------------------------------------------------------------

export interface BuildingSpec {
  lon: number
  lat: number
  /** 顺谷向尺寸（米）＝局部坐标 y 方向。厂房长边走这里 */
  width: number
  /** 跨谷向尺寸（米）＝局部坐标 x 方向 */
  depth: number
  /** 檐口高度（米） */
  height: number
  /** 屋脊高出檐口的高度（米），0 表示平屋顶 */
  roofHeight: number
  roof: RoofKind
  name: string
}

/**
 * 厂房。
 *
 * `x / y` 是厂区局部坐标（米），`lon / lat` 由它换算而来，**两者都留着**：
 * 建场景要局部坐标才能把矩形转成「与谷轴对齐」的形状
 * （经纬度上直接摆正矩形会与谷轴拧一个方位角），
 * 而机位注视点、overlay 脚本要的是经纬度。
 * 由 `plantPt` 单向生成，不会漂移。
 */
export interface PlantBuilding extends BuildingSpec {
  bench: BenchKey
  x: number
  y: number
}

/**
 * 厂房清单（局部坐标）。`x` 跨谷（+x 为谷的东南侧），`y` 顺谷（+y 为上游）。
 *
 * 布置原则是**工艺流程**，不是好看：矿石从 T1 卸矿、粗碎，经 T2 中细碎与筛分，
 * 到 T3 磨矿浮选，最后在 T4 脱水、入库、装车。每一级的产物都直接喂给下一级，
 * 皮带廊因此全是**顺着谷往下走**的——这是「重力流」，也是这套布局成立的理由。
 *
 * 每级内部也是**沿谷排成一条工艺线**：受料 → 破碎 → 筛分 → 储运，
 * 长边（`width`）一律顺谷，辅助设施（机修、变电、办公）甩到跨谷方向的一侧。
 * 谷底只有 ~120m 宽，横着摆长边根本放不下。
 *
 * 体量按选矿厂的常见量级取（磨浮主厂房最大，长 150m、跨 58m；
 * 粗碎站最高，因为要容下旋回破碎机的受料口），**不是实测尺寸**。
 */
const BUILDINGS_LOCAL: (Omit<BuildingSpec, 'lon' | 'lat'> & {
  x: number
  y: number
  bench: BenchKey
})[] = [
  // ---- T1 粗碎台地（x 0~100, y 450~625）：卸矿在最上游，往下依次粗碎、储仓 ----
  { x: 55, y: 530, width: 42, depth: 34, height: 24, roofHeight: 6, roof: 'blue', name: '粗碎站', bench: 'T1' },
  { x: 25, y: 600, width: 30, depth: 22, height: 10, roofHeight: 3, roof: 'roof', name: '机修间', bench: 'T1' },
  { x: 22, y: 470, width: 22, depth: 18, height: 9, roofHeight: 0, roof: 'roof', name: '空压站', bench: 'T1' },
  // ---- T2 中细碎台地（x 20~180, y 0~300）：破碎筛分在中间，仓在东、堆棚在西 ----
  { x: 80, y: 240, width: 62, depth: 38, height: 22, roofHeight: 7, roof: 'blue', name: '中细碎车间', bench: 'T2' },
  { x: 80, y: 150, width: 46, depth: 30, height: 18, roofHeight: 5, roof: 'blue', name: '筛分车间', bench: 'T2' },
  { x: 35, y: 60, width: 30, depth: 20, height: 10, roofHeight: 3, roof: 'blue', name: '变电所', bench: 'T2' },
  { x: 165, y: 285, width: 24, depth: 15, height: 9, roofHeight: 0, roof: 'roof', name: '化验室', bench: 'T2' },
  // ---- T3 磨浮台地（x 20~220, y -310~-25）：全场最大单体在这 ----
  { x: 100, y: -175, width: 150, depth: 58, height: 24, roofHeight: 8, roof: 'blue', name: '磨浮主厂房', bench: 'T3' },
  { x: 175, y: -50, width: 30, depth: 16, height: 8, roofHeight: 0, roof: 'roof', name: '药剂库', bench: 'T3' },
  { x: 45, y: -50, width: 40, depth: 18, height: 13, roofHeight: 3, roof: 'blue', name: '综合办公楼', bench: 'T3' },
  // ---- T4 精矿台地（x 40~200, y -650~-345）：产物出口 ----
  { x: 110, y: -420, width: 60, depth: 36, height: 18, roofHeight: 5, roof: 'blue', name: '精矿脱水车间', bench: 'T4' },
  { x: 115, y: -545, width: 110, depth: 44, height: 17, roofHeight: 6, roof: 'blue', name: '精矿库', bench: 'T4' }
]

export const PLANT_BUILDINGS: PlantBuilding[] = BUILDINGS_LOCAL.map((b) => {
  const [lon, lat] = plantPt(b.x, b.y)
  return { ...b, lon, lat }
})

/**
 * 厂房清单（经纬度）。
 *
 * **保留这个导出名是有意的**：`sceneConfig` 的机位注视点、`overlay-check.mjs`
 * 与 `detect-buildings.mjs` 都按这个名字读。改名要连带改三处，不值当。
 */
export const BUILDINGS: BuildingSpec[] = PLANT_BUILDINGS

// ---------------------------------------------------------------------------
// 选矿厂：构筑物
// ---------------------------------------------------------------------------

/** 储矿筒仓 */
export interface SiloSite {
  lon: number
  lat: number
  height: number
  radius: number
  bench: BenchKey
  name: string
}

const SILOS_LOCAL: (Omit<SiloSite, 'lon' | 'lat'> & { x: number; y: number })[] = [
  // T1 原矿仓：卸矿后的缓冲，粗碎机不能停等卡车。紧贴粗碎站东侧
  { x: 82, y: 575, height: 26, radius: 9, bench: 'T1', name: '原矿仓 1' },
  { x: 82, y: 520, height: 26, radius: 9, bench: 'T1', name: '原矿仓 2' },
  // T2 选前矿仓：一列六座顺谷排开，磨浮的「料斗」，磨机吃料靠它稳。
  // 摆在破碎筛分线的东侧（x=145），既不挡工艺线，又离下游的 T3 最近
  { x: 145, y: 250, height: 30, radius: 8, bench: 'T2', name: '选前矿仓 1' },
  { x: 145, y: 210, height: 30, radius: 8, bench: 'T2', name: '选前矿仓 2' },
  { x: 145, y: 170, height: 28, radius: 7.5, bench: 'T2', name: '选前矿仓 3' },
  { x: 145, y: 130, height: 28, radius: 7.5, bench: 'T2', name: '选前矿仓 4' },
  { x: 145, y: 90, height: 28, radius: 7.5, bench: 'T2', name: '选前矿仓 5' },
  { x: 145, y: 50, height: 26, radius: 7, bench: 'T2', name: '选前矿仓 6' }
]

export const PLANT_SILOS: SiloSite[] = SILOS_LOCAL.map(({ x, y, ...rest }) => {
  const [lon, lat] = plantPt(x, y)
  return { ...rest, lon, lat }
})

/** 储矿筒仓（经纬度）。同样保留导出名给 `overlay-check.mjs`。 */
export const SILOS: SiloSite[] = PLANT_SILOS

/**
 * 浓密池（浓缩机）。
 *
 * 浮选精矿浆在这里脱水：圆形池 + 中心传动 + 走桥，是选矿厂最好认的构筑物。
 * T3 磨浮台地上两座，一精一尾。
 */
export interface ThickenerSpec {
  lon: number
  lat: number
  radius: number
  /** 池壁高（米） */
  rimHeight: number
  bench: BenchKey
  name: string
}

const THICKENERS_LOCAL: (Omit<ThickenerSpec, 'lon' | 'lat'> & { x: number; y: number })[] = [
  // 都甩在磨浮主厂房东侧（x=172）：磨浮占 x 71~129，浓密池占 150~194，互不压
  { x: 172, y: -120, radius: 22, rimHeight: 4.5, bench: 'T3', name: '精矿浓密池' },
  { x: 172, y: -215, radius: 17, rimHeight: 4, bench: 'T3', name: '尾矿浓密池' }
]

export const PLANT_THICKENERS: ThickenerSpec[] = THICKENERS_LOCAL.map(({ x, y, ...rest }) => {
  const [lon, lat] = plantPt(x, y)
  return { ...rest, lon, lat }
})

/**
 * 穹顶储料仓 / 料棚。
 *
 * 颜色分两种，与实景一致：
 *   - `dome` 蓝色半球 —— 精矿仓，封闭防雨，配中心卸料
 *   - `shed` 米色椭球 —— 中矿堆场，只是罩起来挡尘，不承压
 * 切半球的做法：把椭球**中心摆在地坪标高上**，露出来的正好是上半球。
 */
export interface DomeSpec {
  lon: number
  lat: number
  radius: number
  /** 半球高度（米） */
  height: number
  kind: 'dome' | 'shed'
  bench: BenchKey
  name: string
}

const DOMES_LOCAL: (Omit<DomeSpec, 'lon' | 'lat'> & { x: number; y: number })[] = [
  // T2 中矿堆棚（米色椭球）：甩在破碎筛分线西侧（x=40，占 22~58），让开 x≥61 的厂房
  { x: 40, y: 210, radius: 18, height: 13, kind: 'shed', bench: 'T2', name: '中矿堆棚 1' },
  { x: 40, y: 150, radius: 18, height: 13, kind: 'shed', bench: 'T2', name: '中矿堆棚 2' },
  // T4 精矿仓（蓝色半球）：在精矿库西侧（库占 x 93~137）
  { x: 65, y: -520, radius: 18, height: 15, kind: 'dome', bench: 'T4', name: '精矿仓 1' },
  { x: 65, y: -575, radius: 18, height: 15, kind: 'dome', bench: 'T4', name: '精矿仓 2' }
]

export const PLANT_DOMES: DomeSpec[] = DOMES_LOCAL.map(({ x, y, ...rest }) => {
  const [lon, lat] = plantPt(x, y)
  return { ...rest, lon, lat }
})

/**
 * 装车站（汽车装车仓）。
 *
 * 精矿库出来的精矿在这里装车外运。一座装车站 = 一个仓体 + 一条**斜向伸出的
 * 装车溜槽**，溜槽下停一辆重卡。这是全厂辨识度最高的一组构筑物：
 * 从空中看下去，一排斜臂整整齐齐，一眼就知道是装车点。
 */
export interface LoaderSpec {
  lon: number
  lat: number
  bench: BenchKey
  name: string
  /** 厂区局部坐标（米）。装车臂要朝台地外侧伸，需要知道它在局部坐标里的位置 */
  x: number
  y: number
}

const LOADERS_LOCAL: (Omit<LoaderSpec, 'lon' | 'lat'> & { x: number; y: number })[] = [
  // 一列四座沿谷排开，装车臂朝台地外侧（东）伸——溜槽下才是重卡停的位置。
  // 摆在精矿库下游侧，重型车流不用回头穿过库区
  { x: 172, y: -485, bench: 'T4', name: '装车站 1' },
  { x: 172, y: -530, bench: 'T4', name: '装车站 2' },
  { x: 172, y: -575, bench: 'T4', name: '装车站 3' },
  { x: 172, y: -620, bench: 'T4', name: '装车站 4' }
]

export const PLANT_LOADERS: LoaderSpec[] = LOADERS_LOCAL.map((b) => {
  const [lon, lat] = plantPt(b.x, b.y)
  return { ...b, lon, lat }
})

/** 圆形储罐（清水池 / 药剂罐 / 水泵房），散布在 T3、T4 台地边缘 */
export interface TankSpec {
  lon: number
  lat: number
  radius: number
  height: number
  bench: BenchKey
  name: string
}

const TANKS_LOCAL: (Omit<TankSpec, 'lon' | 'lat'> & { x: number; y: number })[] = [
  // T3 东边缘（台地到 x=220，罐占 191~209），紧挨药剂库与浓密池，管线最短
  { x: 200, y: -290, radius: 9, height: 11, bench: 'T3', name: '清水池' },
  { x: 200, y: -262, radius: 7, height: 9, bench: 'T3', name: '药剂罐' },
  // T4 西侧（台地自 x=40 起）
  { x: 55, y: -400, radius: 8, height: 10, bench: 'T4', name: '循环水泵房' }
]

export const PLANT_TANKS: TankSpec[] = TANKS_LOCAL.map(({ x, y, ...rest }) => {
  const [lon, lat] = plantPt(x, y)
  return { ...rest, lon, lat }
})

// ---------------------------------------------------------------------------
// 线状地物
// ---------------------------------------------------------------------------

function localPath(pts: [number, number][]): LonLat[] {
  return pts.map(([x, y]) => plantPt(x, y))
}

/**
 * 皮带廊。
 *
 * **每一条都是「上一道工序 → 下一道工序」，方向一致地顺谷下行**，
 * 这不是为了好看：真实选矿厂能靠重力流就绝不加一次提升，
 * 所以皮带廊的走向图基本就是工艺流程图。
 *
 * 第一条（采坑 → 粗碎站）是全场最长的一条，从坑口沿谷壁盘下来，
 * 落差两百多米，在三维里是最能读出「这条谷有多深」的一根线。
 */
export const CONVEYORS: LonLat[][] = [
  // 采坑 → T1 粗碎站：长距离下山廊道，全场最长（约 1.8km），
  // 也是三维里最能读出「这条谷有多深」的一根线。
  // 采坑在厂区局部坐标的 (-837, -1050)，即**下游偏西**——矿体在这条谷的西侧，
  // 所以廊道从采坑东北侧爬上来、顺谷进入粗碎站，不是一条直线。
  localPath([
    [-790, -980],
    [-560, -620],
    [-330, -260],
    [-120, 60],
    [10, 330],
    [48, 452],
    [55, 500]
  ]),
  // 粗碎站 → 原矿仓（缓冲，粗碎机不能停等卡车）
  localPath([
    [70, 530],
    [82, 530],
    [82, 520]
  ]),
  // 原矿仓 → 中细碎车间：顺谷跨过 T1/T2 之间的挡墙
  localPath([
    [82, 560],
    [82, 330],
    [90, 300],
    [80, 272]
  ]),
  // 中细碎 → 筛分：**闭路，两条廊道**。一条送筛、一条把筛上返回再碎，
  // 这是「中细碎与筛分必须同台地」的原因，缺一条就不是闭路了
  localPath([
    [80, 209],
    [94, 191],
    [94, 173],
    [80, 173]
  ]),
  localPath([
    [80, 209],
    [66, 191],
    [66, 173],
    [80, 173]
  ]),
  // 筛分 → 选前矿仓
  localPath([
    [95, 140],
    [125, 140],
    [145, 132]
  ]),
  // 选前矿仓 → 磨浮主厂房：T2 → T3，磨机吃料全靠这六个仓稳
  localPath([
    [145, 45],
    [142, -40],
    [130, -80],
    [122, -102]
  ]),
  // 磨浮主厂房 → 精矿脱水车间：T3 → T4
  localPath([
    [112, -252],
    [114, -330],
    [110, -385],
    [110, -392]
  ]),
  // 精矿脱水 → 精矿库
  localPath([
    [110, -452],
    [112, -478],
    [115, -488]
  ]),
  // 精矿库 → 精矿仓（穹顶）
  localPath([
    [93, -520],
    [83, -520],
    [67, -520]
  ]),
  // 精矿库 → 装车站
  localPath([
    [137, -530],
    [155, -530],
    [172, -530]
  ])
]

/**
 * 道路。
 *
 * 山地厂区的道路是**盘**出来的，不是直连的：从采坑沿谷壁之字形下来，
 * 台地之间也靠短之字坡衔接（15m 一级的台地，直线连上去坡度太陡）。
 * 最后一级台地上一圈装车环道，重车掉头全靠它。
 */
export const ROADS: LonLat[][] = [
  // 采坑 → T1 卸矿平台：运矿主干道。采坑在厂区局部坐标的 (-838, -1050)
  // （下游偏西），所以这是一条**沿谷壁盘上来的长坡**，不是厂内道路，
  // 沿途的回头弯就是重车爬坡的之字线
  localPath([
    [-800, -1010],
    [-640, -760],
    [-700, -520],
    [-500, -300],
    [-560, -80],
    [-360, 120],
    [-400, 320],
    [-200, 400],
    [-80, 460],
    [10, 500],
    [30, 560],
    [20, 600]
  ]),
  // 以下四条是**台地之间的联络道**。四级台地各自比下一级高 5~13m，
  // 直线连上去纵坡过陡（主干道限 6%），所以每级之间都盘一个小之字。
  // 之字一律盘在台地的**西侧**（x 为负）：那里是削坡面，不占生产场地
  // T1 → T2
  localPath([
    [5, 455],
    [-45, 430],
    [-45, 380],
    [0, 350],
    [10, 310],
    [28, 298]
  ]),
  // T2 → T3
  localPath([
    [25, 5],
    [-35, -15],
    [-35, -60],
    [15, -80],
    [35, -30]
  ]),
  // T3 → T4
  localPath([
    [30, -315],
    [-30, -335],
    [-30, -380],
    [20, -400],
    [48, -412]
  ]),
  // T4 装车环道：重车掉头全靠它。圈住精矿库与四个装车站
  // （精矿库占 x 93~137，装车站一列在 x=172），西边让开精矿仓的两个穹顶（x 47~83）
  localPath([
    [88, -470],
    [150, -470],
    [192, -500],
    [192, -625],
    [150, -642],
    [88, -642],
    [85, -600],
    [85, -500],
    [88, -470]
  ])
]

// ---------------------------------------------------------------------------
// 面状地物
// ---------------------------------------------------------------------------

/**
 * 排土场：影像判读在采坑西侧沟谷。
 * 依据是 lon 109.939 一带几条东西向的浅色宽带（影像上 240~420m 长、63~74m 宽），
 * 形态与排土台阶/运输道路一致。中心由原先的 109.9436 西移到 109.9390。
 */
export const DUMPS = [
  { lon: 109.939, lat: 34.33, rx: 230, ry: 175, height: 48, benches: 3 },
  { lon: 109.9372, lat: 34.3252, rx: 185, ry: 145, height: 36, benches: 3 }
]

/**
 * 尾矿库：影像判读的一块**深青色水体**，
 * 中心 (109.9433, 34.3267)，外接盒约 192×211m，颜色 RGB(57,115,128)。
 * 判据是「暗且偏青」——自然阴影是中性灰，不会带青色偏移。
 * 原先配置在 (109.9512, 34.3224)，偏东南约 700m，那里影像上是山坡不是水面。
 */
export const TAILINGS = {
  lon: 109.9434,
  lat: 34.3268,
  rx: 155,
  ry: 150
}

// ---------------------------------------------------------------------------
// 绿化
// ---------------------------------------------------------------------------

/**
 * 绿化。
 *
 * 参考图里植被几乎占了一半画面，稀疏几棵树是撑不起来的。
 * 这里按「片区 + 数量」散布，用确定性随机数生成位置与尺寸——
 * 不用 Math.random 是为了每次构建结果一致，便于比对截图。
 *
 * 分区刻意避开采坑、厂区台地与尾矿库水面，只在坡地与外围散布。
 * 厂区搬进谷底后，谷口两侧坡地改成了重点绿化的位置：
 * 台地是削出来的，坡面没有植被的话会是一片刺眼的裸土。
 */
export interface TreeZone {
  lon: number
  lat: number
  rx: number
  ry: number
  count: number
  /** 针叶（塔形）还是阔叶（球形冠） */
  kind: 'conifer' | 'broadleaf'
}

export const TREE_ZONES: TreeZone[] = [
  // 厂区台地两侧的谷坡：挡土墙外是削坡面，必须绿化。
  // 坐标是按厂区局部坐标算的（台地占 x 0~220、y -650~625），
  // 不是硬写经纬度——厂址一挪这几个片区要跟着走，写死就会留在旧谷里
  { lon: 109.9692, lat: 34.3378, rx: 110, ry: 190, count: 22, kind: 'broadleaf' }, // T1/T2 西坡
  { lon: 109.9662, lat: 34.334, rx: 105, ry: 200, count: 22, kind: 'broadleaf' }, // T2/T3 西坡
  { lon: 109.9727, lat: 34.3359, rx: 130, ry: 190, count: 18, kind: 'conifer' }, // T1/T2 东坡
  { lon: 109.97, lat: 34.3319, rx: 130, ry: 200, count: 18, kind: 'conifer' }, // T2/T3 东坡
  { lon: 109.9642, lat: 34.331, rx: 100, ry: 170, count: 16, kind: 'conifer' }, // T4 西坡
  { lon: 109.9677, lat: 34.3293, rx: 120, ry: 160, count: 16, kind: 'broadleaf' }, // T4 东侧谷坡
  // 采坑与厂区之间的谷口两侧（两者相距约 1.8km，中间这一段是运矿道路）
  { lon: 109.961, lat: 34.333, rx: 140, ry: 130, count: 16, kind: 'broadleaf' },
  // T1 上游的谷源
  { lon: 109.9729, lat: 34.3399, rx: 120, ry: 110, count: 12, kind: 'conifer' },
  // 排土场复垦区：台阶面上成片
  { lon: 109.9392, lat: 34.3302, rx: 210, ry: 150, count: 20, kind: 'conifer' },
  { lon: 109.9374, lat: 34.3254, rx: 175, ry: 130, count: 15, kind: 'conifer' },
  // 尾矿库周边
  { lon: 109.9434, lat: 34.3268, rx: 230, ry: 160, count: 18, kind: 'broadleaf' },
  // 采坑北侧坡地
  { lon: 109.952, lat: 34.3372, rx: 240, ry: 120, count: 15, kind: 'conifer' },
  // 矿区西南外围
  { lon: 109.9462, lat: 34.3186, rx: 200, ry: 150, count: 14, kind: 'conifer' }
]

// ---------------------------------------------------------------------------
// 几何常量
// ---------------------------------------------------------------------------

/**
 * 以采坑中心为原点，按「东 +x / 北 +y 米」偏移出一个经纬度点。
 *
 * 与采场相关的位置（作业面、台阶道路、避灾路线、人员与基站点位）
 * 一律用它表达，不要再各写一份经纬度：采坑中心是按影像 + DEM 实测
 * 校正过的，硬编码坐标会在采坑一改之后整片偏到坑外面去。
 */
export function pitOffset(eastM: number, northM: number): LonLat {
  return [PIT.lon + eastM / metersPerLon(PIT.lat), PIT.lat + northM / METERS_PER_LAT]
}
