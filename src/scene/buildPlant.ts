import * as Cesium from 'cesium'
import { MINE_ELEVATION, PLANT_COLORS, SCENE_COLORS } from './sceneConfig'
import { sampleGroundHeights } from './localTerrain'
import { beltPolygon, flatPolygon, offsetPath, ribbonRing, ringAt } from './geometry'
import {
  BENCHES,
  CONVEYORS,
  METERS_PER_LAT,
  PLANT_AXIS_DEG,
  PLANT_BUILDINGS,
  PLANT_DOMES,
  PLANT_LOADERS,
  PLANT_ORIGIN,
  PLANT_SILOS,
  PLANT_TANKS,
  PLANT_THICKENERS,
  plantPt,
  metersPerLon
} from './mineLayout'
import { registerModelSurface } from './terrainClip'
import type {
  BenchKey,
  DomeSpec,
  LonLat,
  PlantBuilding,
  Pt,
  SiloSite,
  TankSpec,
  ThickenerSpec
} from './mineLayout'

/**
 * 选矿厂：谷底分级台地的几何构建。
 *
 * 与 `buildMineScene` 的分工：那个文件建**矿区尺度的地物**（采坑、排土场、
 * 尾矿库、道路、绿化），本文件建**选矿厂**。厂区的东西多、形状碎，
 * 混在一起会把 `buildMineScene` 撑到两千行。
 *
 * ## 两条硬约束
 *
 * 1. **厂区的平面坐标一律用局部坐标**（`mineLayout.plantPt`）。
 *    谷轴是斜的（`PLANT_AXIS_DEG`），在经纬度上直接摆正矩形，整片厂房会与山谷拧着。
 * 2. **标高一律来自台地平台，不各自采样地形**。真实选矿厂是削平台地之后
 *    把设备装在平台上；各自采样会让筒仓比平台低 30m ——
 *    离线 DEM 与真实表面本来就有差，而平台是人工削出来的，它与地形无关。
 */

/** 台地代号 → 平台绝对高程（米）。建厂房时按 `bench` 查。 */
export type BenchElevations = Record<string, number>

/** 场坪每边比台地轮廓内缩多少米（米），让巡检道留在硬化面上 */
const BENCH_INSET = 6

/**
 * 相邻两级的**设计级差**（米）。
 * GB50197-2015：台阶高度宜为 3～6m；GB50187-2012：不宜高于 4m。
 * 取中值 5m。
 */
const BENCH_STEP = 5

/** 平台至少高出本级足迹内谷底多少米。低于它，平台就等于埋进山体里。 */
const BENCH_LIFT = 2

/**
 * 估计「本级足迹内的谷底」所取的分位数。
 * 取 min 会被单点噪声带跑（DEM 在陡壁上本来就有毛刺），取中位数又偏到坡上，
 * 低分位最接近「这一段的沟底在哪」。
 */
const FLOOR_QUANTILE = 0.2

/**
 * 分级台地。
 *
 * 每一级做成**挤出的实体块**（`extrudedHeight` → `height`），而不是一张平面：
 * 平面在谷底只有一头贴地，另一头悬空几十米，从侧面看是一张飘着的纸。
 * 实体块的侧面正好就是削坡／挡墙，这才是台地该有的样子。
 *
 * ## 平台标高怎么定
 *
 * 平台标高是**设计值**，不是「本级足迹里的最高点」。
 *
 * 原先取 `max(足迹) + 1.5`，出发点是「宁肯多挖方也不要悬空」，但它是**逐级独立**
 * 算的：每级各自去够自己那片坡的最高处。实测结果是
 * `1380.6 / 1331.9 / 1338.5 / 1309.3`，级差 `48.8 / **-6.7** / 29.2` ——
 * **T3 比 T2 还高**，矿石要往上流，而「分级台地」的全部意义就是让物料自流。
 * 那不是削台地，那是把四块板各自贴在山坡上。
 *
 * 现在的做法，两条约束按顺序压：
 *   1. `平台 ≤ 本级谷底 + BENCH_LIFT` —— 不高出地面太多，挖填都省；
 *   2. `平台 ≤ 上一级平台 − BENCH_STEP` —— **单调下降，这一条无例外**。
 *
 * 第 2 条压过第 1 条时，平台就切进山体里（挖方），那一截正是挡土墙；
 * 反过来平台落在谷底附近时，下一级靠自然坡降，土方最省。
 * 两条都不满足的情况不存在——单调性是硬约束。
 *
 * ⚠️ 级差远大于 BENCH_STEP（比如几十米）**不是算法出错，是厂址太陡**：
 * 谷轴在这段降得太快，说明台地跨在了一条山洪沟上。`[台地] 诊断` 那行会
 * 把每级足迹自身的纵向落差打出来，超过 15m 就是选址问题，不是标高问题。
 *
 * 返回值交给调用方，厂区里所有设施都坐在各自的平台上。
 */
export async function buildBenches(
  viewer: Cesium.Viewer,
  entities: Cesium.EntityCollection
): Promise<BenchElevations> {
  // ---- 采样：每级台地取 5×7 个点，够了（台地是矩形，地形起伏是低频的）----
  const keys: Record<string, LonLat> = {}
  for (const b of BENCHES) {
    for (let i = 0; i <= 6; i++) {
      for (let j = 0; j <= 4; j++) {
        const x = b.cx - b.halfWidth + (j / 4) * b.halfWidth * 2
        const y = b.y0 + (i / 6) * (b.y1 - b.y0)
        keys[`${b.key}-${i}-${j}`] = plantPt(x, y)
      }
    }
  }

  // ---- 足迹边界密排采样（每 ~20m 一点）----
  //
  // 这一串点有两个用途，**必须是同一串**：底图挖洞的边界，和削坡崖面的顶边。
  // 用同一串经纬度采出来的高程，洞沿和崖顶才会落在同一个点上，不留缝。
  const EDGE_STEP = 20
  const edgeRing: Record<string, LonLat[]> = {}
  for (const b of BENCHES) {
    const w = b.halfWidth * 2
    const h = b.y1 - b.y0
    const nx = Math.max(2, Math.round(w / EDGE_STEP))
    const ny = Math.max(2, Math.round(h / EDGE_STEP))
    const local: Pt[] = []
    for (let j = 0; j <= nx; j++) local.push({ x: b.cx - b.halfWidth + (j / nx) * w, y: b.y0 })
    for (let i = 1; i <= ny; i++) local.push({ x: b.cx + b.halfWidth, y: b.y0 + (i / ny) * h })
    for (let j = nx - 1; j >= 0; j--) local.push({ x: b.cx - b.halfWidth + (j / nx) * w, y: b.y1 })
    for (let i = ny - 1; i >= 1; i--) local.push({ x: b.cx - b.halfWidth, y: b.y0 + (i / ny) * h })
    edgeRing[b.key] = local.map((p) => plantPt(p.x, p.y))
    edgeRing[b.key].forEach((p, k) => (keys[`${b.key}-edge-${k}`] = p))
  }
  const ground = await sampleGroundHeights(
    Object.entries(keys).map(([key, [lon, lat]]) => ({ key, lon, lat })),
    MINE_ELEVATION
  )

  const elevations: BenchElevations = {}

  // ---- 先定各级平台标高：单调下降的级联，见函数头 ----
  const floors: Record<string, number> = {} // 本级足迹内的谷底估计
  const lows: Record<string, number> = {} // 本级足迹内的实测最低点（挤出块的底）
  const spans: Record<string, number> = {} // 本级足迹**自身沿谷轴**的落差，选址是否过陡看它
  for (const b of BENCHES) {
    const vals: number[] = []
    for (let i = 0; i <= 6; i++) {
      for (let j = 0; j <= 4; j++) {
        const v = ground[`${b.key}-${i}-${j}`]
        if (v !== undefined) vals.push(v)
      }
    }
    vals.sort((p, q) => p - q)
    floors[b.key] = vals[Math.floor(vals.length * FLOOR_QUANTILE)]
    lows[b.key] = vals[0]
    // 只用中轴那一列，量的是「谷底沿程降得多快」，不含两侧坡
    const axis: number[] = []
    for (let i = 0; i <= 6; i++) {
      const v = ground[`${b.key}-${i}-2`]
      if (v !== undefined) axis.push(v)
    }
    spans[b.key] = axis.length ? Math.max(...axis) - Math.min(...axis) : 0
  }

  let prevTop: number | null = null
  for (const b of BENCHES) {
    const want = floors[b.key] + BENCH_LIFT
    // 标注类型是必需的：top 又用来回写 prevTop，不标就成自引用推断
    const top: number = prevTop === null ? want : Math.min(prevTop - BENCH_STEP, want)
    elevations[b.key] = top
    prevTop = top
  }

  for (const b of BENCHES) {
    const top = elevations[b.key]
    // 底面下到足迹最低点以下 25m，保证不会从侧面露出缝
    const bottom = Math.min(lows[b.key], top) - 25

    // 台地轮廓（局部坐标 → 经纬度）。中心线是 b.cx 不是 0——
    // 四级各切各的台，谷底是弯的（见 mineLayout 的 BENCHES 注释）
    const outline: LonLat[] = [
      plantPt(b.cx - b.halfWidth, b.y0),
      plantPt(b.cx + b.halfWidth, b.y0),
      plantPt(b.cx + b.halfWidth, b.y1),
      plantPt(b.cx - b.halfWidth, b.y1)
    ]

    // ---- 台地实体块：侧面即削坡与挡墙 ----
    entities.add({
      id: `bench-${b.key}`,
      name: b.name,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(ringAt(outline, top)),
        // 块体从底面 `bottom` 挤到顶面 `top`，**两个高度不能写反、也不能只写一个**：
        // 只写 extrudedHeight 的话，`PolygonGeometryUpdater` 会把 height 补成 0
        // （`extrudedHeightValue` 有值而 `heightValue` 没有 → `heightValue = 0`），
        // 块体就成了海拔 0 到 bottom 的一根柱子，顶面比平台低出上百米。
        height: bottom,
        extrudedHeight: top,
        material: Cesium.Color.fromCssColorString(PLANT_COLORS.benchSide),
        outline: true,
        outlineColor: SCENE_COLORS.primary.withAlpha(0.3)
      }
    })

    // ---- 削坡：足迹边界从平台顶砌到自然地面 ----
    //
    // 底图在足迹内被挖掉之后，上坡侧的自然地面高于平台，洞口上方会露一条缝
    // （能看到块体背面）。这圈崖面把缝封上——顺带补上了真实台地本来就有、
    // 而原先靠底图山坡冒充的那道人工削坡。
    // 下坡侧自然地面低于平台，取 max 后这圈退化成零高，不会和块体侧壁打架。
    const edge = edgeRing[b.key]
    const ring = [...edge, edge[0]]
    const cutTop = ring.map((_, k) => {
      const g = ground[`${b.key}-edge-${k % edge.length}`]
      return Math.max(g ?? top, top)
    })
    entities.add({
      id: `bench-${b.key}-cut`,
      name: `${b.name}削坡`,
      wall: {
        positions: ring.map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1], 0)),
        minimumHeights: ring.map(() => top),
        maximumHeights: cutTop,
        material: Cesium.Color.fromCssColorString(PLANT_COLORS.benchSide),
        outline: false
      }
    })
    registerModelSurface(edge)

    // ---- 硬化面：比实体块高 0.12m 贴一层，做出「铺装」与「挡墙」的色差 ----
    entities.add({
      id: `bench-${b.key}-paved`,
      name: `${b.name}硬化面`,
      polygon: {
        ...flatPolygon(outline, top + 0.12),
        material: Cesium.Color.fromCssColorString(PLANT_COLORS.benchTop).withAlpha(0.95),
        outline: false
      }
    })

    // ---- 台地名称标注 ----
    const [clon, clat] = plantPt(0, (b.y0 + b.y1) / 2)
    entities.add({
      id: `bench-${b.key}-label`,
      name: b.name,
      position: Cesium.Cartesian3.fromDegrees(clon, clat, top + 60),
      label: {
        text: b.name,
        font: '15px PingFang SC, Microsoft YaHei, sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#ffe9a8'),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0a2233').withAlpha(0.8),
        backgroundPadding: new Cesium.Cartesian2(9, 5),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(900, 1.0, 6000, 0.55)
      }
    })
  }

  // ---- 台地之间的挡土墙 ----
  // 相邻两级之间留 15m 净距，那一段不能空着：不砌墙的话从空中看是两道
  // 平行崖壁夹一条沟，像工地不像厂区。墙从下一级的平台顶到上一级平台之上。
  const byKey = Object.fromEntries(BENCHES.map((b) => [b.key, b])) as Record<BenchKey, (typeof BENCHES)[number]>
  const pairs: [BenchKey, BenchKey][] = [
    ['T1', 'T2'],
    ['T2', 'T3'],
    ['T3', 'T4']
  ]
  for (const [upper, lower] of pairs) {
    const u = byKey[upper]
    const l = byKey[lower]
    const yFace = (u.y0 + l.y1) / 2
    // 墙只砌在**两级足迹的重叠段**上：四级中心线不同（cx 50/100/120/120），
    // 取各自的 ±halfWidth 会把墙伸到上一级台地之外，从空中看像一堵飞墙
    const x0 = Math.max(u.cx - u.halfWidth, l.cx - l.halfWidth)
    const x1 = Math.min(u.cx + u.halfWidth, l.cx + l.halfWidth)
    const face = [plantPt(x0, yFace), plantPt(x1, yFace)]
    // 墙底取「下一级平台顶 − 8m」，是个**保守值**：墙砌在两级之间的净距里，
    // 那道缝的地面在两级平台之间，实测墙体沿线埋进去 13.5~26.6m（加密到 15m
    // 一点量过，整条边都没露缝）。怕「两端落地、中段悬空」的话，量那一段而不是
    // 改这里——把墙底改浅才会真的悬空。
    entities.add({
      id: `bench-wall-${upper}-${lower}`,
      name: `${byKey[upper].name}挡土墙`,
      wall: {
        positions: ringAt(face, 0),
        minimumHeights: [elevations[lower] - 8, elevations[lower] - 8],
        maximumHeights: [elevations[upper] + 1.4, elevations[upper] + 1.4],
        material: Cesium.Color.fromCssColorString(PLANT_COLORS.benchSide)
      }
    })
  }

  // 把实测平台标高打出来：这是「分级台地是否真的逐级下降」的唯一证据，
  // 靠肉眼看截图是看不出来的（改坏了只会像「墙矮了点」）
  console.log(
    '[台地] 平台标高（米）：' +
      BENCHES.map((b) => `${b.key} ${b.name}=${elevations[b.key].toFixed(1)}`).join('  ')
  )
  const drops = pairs.map(([u, l]) => elevations[u] - elevations[l])
  console.log(
    '[台地] 级差（米，应为正＝上一级更高，矿石才能自流）：' +
      drops.map((d, i) => `${pairs[i][0]}→${pairs[i][1]} ${d.toFixed(1)}`).join('  ')
  )

  // 分级差只能说明「约束 2 生效了」，说明不了「这个厂址行不行」。
  // 足迹自身的纵向落差才是选址指标：>15m 表示这一级跨在了陡坡上，
  // 再怎么调标高也削不平——那时该挪台地，不是改数字。
  console.log(
    '[台地] 诊断（每级足迹内：谷底估计 / 平台高出谷底 / 自身纵向落差）：' +
      BENCHES.map(
        (b) =>
          `${b.key} ${floors[b.key].toFixed(0)}/${(elevations[b.key] - floors[b.key]).toFixed(1)}/${spans[b.key].toFixed(0)}m`
      ).join('  ')
  )
  const steep = BENCHES.filter((b) => spans[b.key] > 15)
  if (steep.length) {
    console.log(
      `[台地] ⚠ 选址告警：${steep.map((b) => b.key).join('/')} 的足迹沿谷轴落差超过 15m，` +
        '该级跨在陡坡上，标高削不平，应挪动台地或缩短其沿谷长度'
    )
  }
  const buried = BENCHES.filter((b) => elevations[b.key] < lows[b.key])
  if (buried.length) {
    console.log(
      `[台地] ⚠ 选址告警：${buried.map((b) => b.key).join('/')} 的平台低于本级最低点，` +
        '整级埋在山体里，屏幕上会看不到这一级'
    )
  }

  return elevations
}

// ---------------------------------------------------------------------------
// 厂房
// ---------------------------------------------------------------------------

/**
 * 厂房矩形上的一个点 → 经纬度。
 *
 * `du` 是沿**长边**（`width`）的偏移，`dv` 是沿**短边**（`depth`）的偏移。
 *
 * ⚠️ **长边走局部 y（顺谷），短边走局部 x（跨谷）**，也就是这里的
 * `plantPt(x + dv, y + du)` 两个参数是**反着**放的。别顺手改成
 * `(x + du, y + dv)` —— 谷底只有 ~120m 宽，长边一跨谷就甩出谷外，
 * 而且不会报错，只会看到厂房横着戳进山体。
 * 这条映射与 `mineLayout.BENCHES`「顺谷成带」是同一件事的两面，改必须同改。
 */
function rectPt(b: { x: number; y: number }, du: number, dv: number): LonLat {
  return plantPt(b.x + dv, b.y + du)
}

/**
 * 厂房。
 *
 * 与厂区其他构筑物一样按**局部坐标**摆：先算出矩形四个角在局部坐标里的位置，
 * 再整体换算成经纬度，矩形因此天然与谷轴对齐。
 *
 * 朝向只有轴对齐一种——真实厂区的厂房也是正交排的，不做任意角度旋转。
 */
function buildBuilding(
  entities: Cesium.EntityCollection,
  b: PlantBuilding,
  baseH: number,
  index: number
): void {
  const hw = b.width / 2 // 顺谷半长
  const hd = b.depth / 2 // 跨谷半宽
  const eave = baseH + b.height

  // 角点顺序：(-u,-v) → (+u,-v) → (+u,+v) → (-u,+v)，即沿矩形逆时针一圈。
  // 屋面三角化的下标就是照这个顺序编的，别改动这里的次序
  const corners: LonLat[] = [
    rectPt(b, -hw, -hd),
    rectPt(b, +hw, -hd),
    rectPt(b, +hw, +hd),
    rectPt(b, -hw, +hd)
  ]
  const bottom = ringAt(corners, baseH)
  const top = ringAt(corners, eave)

  // ---- 四面墙 ----
  //
  // 下沿（`minimumHeights`）必须写。`wall` 只给 positions 时 Cesium 把下沿
  // **补成 0.0**（`cleanedBottomHeights[0] = 0.0`，
  // `@cesium/engine/Source/Core/WallGeometryLibrary.js:51-52`），
  // 于是这四面墙各自从海拔 0 拉到檐口——多出 1300 多米埋在地下的面。
  // 四个点的顺序是 [底s, 底n, 顶n, 顶s]，下沿统一取底标高 baseH：
  // 后两点（顶）撑出底→檐口这块面，前两点自然退化掉。
  for (let s = 0; s < 4; s++) {
    const n = (s + 1) % 4
    entities.add({
      id: `bld-${index}-wall-${s}`,
      name: b.name,
      wall: {
        positions: [bottom[s], bottom[n], top[n], top[s]],
        minimumHeights: [baseH, baseH, baseH, baseH],
        material: SCENE_COLORS.wall.withAlpha(0.96),
        outline: true,
        outlineColor: SCENE_COLORS.primary.withAlpha(0.45)
      }
    })
  }

  // ---- 窗带：贴在四面墙上的一道深色横带，檐口下方约一半层高处 ----
  const bandLow = baseH + b.height * 0.52
  const bandHigh = baseH + b.height * 0.74
  const inset = 0.6
  const bandCorners: LonLat[] = [
    rectPt(b, -hw + inset, -hd + inset),
    rectPt(b, +hw - inset, -hd + inset),
    rectPt(b, +hw - inset, +hd - inset),
    rectPt(b, -hw + inset, +hd - inset)
  ]
  const bandLo = ringAt(bandCorners, bandLow)
  const bandHi = ringAt(bandCorners, bandHigh)
  for (let s = 0; s < 4; s++) {
    const n = (s + 1) % 4
    entities.add({
      id: `bld-${index}-band-${s}`,
      name: `${b.name}窗带`,
      wall: {
        positions: [bandLo[s], bandLo[n], bandHi[n], bandHi[s]],
        // 同上：不写下沿就会被补成海拔 0，窗带会从地底一直拉上来
        minimumHeights: [bandLow, bandLow, bandLow, bandLow],
        material: Cesium.Color.fromCssColorString('#1b3448').withAlpha(0.9),
        outline: false
      }
    })
  }

  const roofColor = b.roof === 'blue' ? Cesium.Color.fromCssColorString(PLANT_COLORS.roofBlue) : SCENE_COLORS.roof

  // ---- 屋面 ----
  if (b.roofHeight > 0) {
    const ridgeHeight = eave + b.roofHeight
    // 脊线沿长边。`longFirst` = 脊线在 u 方向（顺谷）上，这是常态；
    // 只有进深反而更长时才翻到 v 方向。两个分支的三角化下标不同，见下
    const longFirst = b.width >= b.depth
    const ridgeA = longFirst ? rectPt(b, -hw, 0) : rectPt(b, 0, -hd)
    const ridgeB = longFirst ? rectPt(b, +hw, 0) : rectPt(b, 0, +hd)

    const rA = Cesium.Cartesian3.fromDegrees(ridgeA[0], ridgeA[1], ridgeHeight)
    const rB = Cesium.Cartesian3.fromDegrees(ridgeB[0], ridgeB[1], ridgeHeight)
    const topCorners = ringAt(corners, eave)
    const rebuild = (idxs: number[]) =>
      idxs.map((i) => (i < 4 ? topCorners[i] : i === 4 ? rA : rB))
    const faceIdx: number[][] = longFirst
      ? [
          [0, 1, 5, 4],
          [2, 3, 4, 5],
          [0, 4, 3],
          [1, 2, 5]
        ]
      : [
          [1, 2, 5, 4],
          [3, 0, 4, 5],
          [0, 1, 5],
          [2, 3, 4]
        ]

    faceIdx.forEach((idxs, fi) => {
      entities.add({
        id: `bld-${index}-roof-${fi}`,
        name: `${b.name}屋面`,
        polygon: {
          // 坡屋面：檐口四个角与脊线两端不同高，是**非共面**的环，
          // 走 beltPolygon（逐点高度 + 一层板厚），摊平会把屋面摊歪
          ...beltPolygon(rebuild(idxs), 0.25),
          material: roofColor,
          outline: true,
          outlineColor: SCENE_COLORS.primary.withAlpha(0.7),
          outlineWidth: 1.2
        }
      })
    })

    // 屋脊亮线：远景里靠它读出体量
    entities.add({
      id: `bld-${index}-ridge`,
      name: `${b.name}屋脊`,
      polyline: {
        positions: [rA, rB],
        width: 2,
        material: SCENE_COLORS.primary.withAlpha(0.75)
      }
    })
  } else {
    entities.add({
      id: `bld-${index}-roof-flat`,
      name: `${b.name}屋面`,
      polygon: {
        // 平屋面压在四面墙顶（墙顶也在 eave）上，抬 6cm 免得与墙顶共面闪烁
        ...flatPolygon(corners, eave + 0.06),
        material: roofColor,
        outline: true,
        outlineColor: SCENE_COLORS.primary.withAlpha(0.7)
      }
    })
  }

  // ---- 名称标注 ----
  entities.add({
    id: `bld-${index}-label`,
    name: b.name,
    position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, eave + b.roofHeight + 14),
    label: {
      text: b.name,
      font: '13px PingFang SC, Microsoft YaHei, sans-serif',
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#001a2e').withAlpha(0.75),
      backgroundPadding: new Cesium.Cartesian2(7, 4),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(600, 1.0, 5000, 0.6)
    }
  })
}

// ---------------------------------------------------------------------------
// 构筑物
// ---------------------------------------------------------------------------

/** 筒仓：圆柱仓体 + 锥形卸料斗 + 仓顶 */
function buildSilo(
  entities: Cesium.EntityCollection,
  s: SiloSite,
  baseH: number,
  index: number
): void {
  const hopper = s.radius * 1.1
  const at = (lift: number) => Cesium.Cartesian3.fromDegrees(s.lon, s.lat, baseH + lift)

  entities.add({
    id: `silo-${index}-hopper`,
    name: `${s.name}卸料斗`,
    position: at(hopper / 2),
    cylinder: {
      length: hopper,
      topRadius: s.radius,
      bottomRadius: s.radius * 0.35,
      material: Cesium.Color.fromCssColorString('#8fa6b8'),
      outline: true,
      outlineColor: SCENE_COLORS.primaryTransparent
    }
  })

  entities.add({
    id: `silo-${index}-body`,
    name: s.name,
    position: at(hopper + s.height / 2),
    cylinder: {
      length: s.height,
      topRadius: s.radius,
      bottomRadius: s.radius,
      material: Cesium.Color.fromCssColorString('#c3d4e2'),
      outline: true,
      outlineColor: SCENE_COLORS.primary.withAlpha(0.6),
      numberOfVerticalLines: 20
    }
  })

  entities.add({
    id: `silo-${index}-cap`,
    name: `${s.name}仓顶`,
    position: at(hopper + s.height + 1),
    cylinder: {
      length: 2,
      topRadius: s.radius * 1.04,
      bottomRadius: s.radius * 1.04,
      material: Cesium.Color.fromCssColorString('#7f96a9')
    }
  })
}

/**
 * 穹顶料仓 / 料棚。
 *
 * 半球是把椭球**中心摆在地坪标高**上做出来的：露出地坪的正好是上半球，
 * 下半球沉在台地实体块里，被台地面挡掉。比用 polyline 一圈圈堆半边球便宜得多，
 * 而且轮廓是真的光滑。
 */
function buildDome(
  entities: Cesium.EntityCollection,
  d: DomeSpec,
  baseH: number,
  index: number
): void {
  const isShed = d.kind === 'shed'

  entities.add({
    id: `dome-${index}-body`,
    name: d.name,
    position: Cesium.Cartesian3.fromDegrees(d.lon, d.lat, baseH),
    ellipsoid: {
      radii: new Cesium.Cartesian3(d.radius, d.radius, d.height),
      material: Cesium.Color.fromCssColorString(isShed ? PLANT_COLORS.shed : PLANT_COLORS.dome)
        .withAlpha(0.94),
      outline: true,
      outlineColor: SCENE_COLORS.primary.withAlpha(0.55)
    }
  })

  // 脚圈：地坪处一圈矮墙，让穹顶「坐」在场地上而不是浮着
  entities.add({
    id: `dome-${index}-ring`,
    name: `${d.name}脚圈`,
    position: Cesium.Cartesian3.fromDegrees(d.lon, d.lat, baseH + 0.9),
    cylinder: {
      length: 1.8,
      topRadius: d.radius * 1.02,
      bottomRadius: d.radius * 1.02,
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.concrete),
      outline: false
    }
  })

  entities.add({
    id: `dome-${index}-label`,
    name: d.name,
    position: Cesium.Cartesian3.fromDegrees(d.lon, d.lat, baseH + d.height + 12),
    label: {
      text: d.name,
      font: '12px PingFang SC, Microsoft YaHei, sans-serif',
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#001a2e').withAlpha(0.75),
      backgroundPadding: new Cesium.Cartesian2(6, 3),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(700, 1.0, 5000, 0.6)
    }
  })
}

/**
 * 浓密池（浓缩机）。
 *
 * 池壁 + 池面 + 中心柱 + 走桥。走桥是它最好认的地方：
 * 从池心跨到池边的一条窄桥，空拍图上就是圆池中间那根横杠。
 */
function buildThickener(
  entities: Cesium.EntityCollection,
  t: ThickenerSpec,
  baseH: number,
  index: number
): void {
  const at = (lift: number) => Cesium.Cartesian3.fromDegrees(t.lon, t.lat, baseH + lift)

  // 池壁
  entities.add({
    id: `thick-${index}-rim`,
    name: `${t.name}池壁`,
    position: at(t.rimHeight / 2),
    cylinder: {
      length: t.rimHeight,
      topRadius: t.radius,
      bottomRadius: t.radius,
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.concrete),
      outline: true,
      outlineColor: SCENE_COLORS.primary.withAlpha(0.5),
      numberOfVerticalLines: 32
    }
  })

  // 池面（矿浆）
  entities.add({
    id: `thick-${index}-pool`,
    name: `${t.name}池面`,
    position: at(t.rimHeight - 0.4),
    cylinder: {
      length: 0.3,
      topRadius: t.radius * 0.97,
      bottomRadius: t.radius * 0.97,
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.slurry).withAlpha(0.95),
      outline: false
    }
  })

  // 中心柱 + 传动
  entities.add({
    id: `thick-${index}-drive`,
    name: `${t.name}中心传动`,
    position: at(t.rimHeight + 1.4),
    cylinder: {
      length: 3.6,
      topRadius: 2.2,
      bottomRadius: 2.6,
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.steel),
      outline: true,
      outlineColor: SCENE_COLORS.primary.withAlpha(0.5)
    }
  })

  // 走桥：从池心跨到池边。空拍图上就是圆池中间那根横杠，浓密池的招牌。
  // 方向取正东即可——池子是圆的，桥朝哪边在三维里没有区别。
  const mx = metersPerLon(t.lat)
  const walkH = baseH + t.rimHeight + 1.2
  entities.add({
    id: `thick-${index}-walk`,
    name: `${t.name}走桥`,
    polygon: {
      ...beltPolygon(
        ribbonRing(
          [
            [t.lon, t.lat],
            [t.lon + t.radius / mx, t.lat]
          ],
          2.4,
          [walkH, walkH]
        )
      ),
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.steel)
    }
  })
}

/** 圆形储罐 / 水池 */
function buildTank(
  entities: Cesium.EntityCollection,
  t: TankSpec,
  baseH: number,
  index: number
): void {
  entities.add({
    id: `tank-${index}-body`,
    name: t.name,
    position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, baseH + t.height / 2),
    cylinder: {
      length: t.height,
      topRadius: t.radius,
      bottomRadius: t.radius,
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.concrete).withAlpha(0.95),
      outline: true,
      outlineColor: SCENE_COLORS.primary.withAlpha(0.5),
      numberOfVerticalLines: 24
    }
  })
  entities.add({
    id: `tank-${index}-top`,
    name: `${t.name}顶`,
    position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, baseH + t.height + 0.4),
    cylinder: {
      length: 0.8,
      topRadius: t.radius * 1.03,
      bottomRadius: t.radius * 1.03,
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.steel)
    }
  })
}

/**
 * 装车站。
 *
 * 一座 = 仓体 + **斜向伸出的装车溜槽** + 溜槽下面一辆重卡。
 * 斜臂是全厂辨识度最高的形状，也是这一组构筑物存在的理由：
 * 精矿从仓里放下、经溜槽装进车厢，车装满就开走。
 *
 * 溜槽朝台地外侧（局部 +x 方向）伸，这样重车不用倒进厂区深处。
 */
function buildLoader(
  entities: Cesium.EntityCollection,
  l: { lon: number; lat: number; x: number; y: number; name: string },
  baseH: number,
  index: number
): void {
  const BIN = 9
  const H = 15
  const armOut = 17
  const armDrop = 7

  const at = (x: number, y: number, lift: number) => {
    const [lon, lat] = plantPt(x, y)
    return Cesium.Cartesian3.fromDegrees(lon, lat, baseH + lift)
  }

  // 仓体
  entities.add({
    id: `loader-${index}-bin`,
    name: l.name,
    position: at(l.x, l.y, H / 2),
    box: {
      dimensions: new Cesium.Cartesian3(BIN, BIN, H),
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.concrete),
      outline: true,
      outlineColor: SCENE_COLORS.primary.withAlpha(0.55)
    }
  })

  // 仓顶
  entities.add({
    id: `loader-${index}-cap`,
    name: `${l.name}仓顶`,
    position: at(l.x, l.y, H + 0.6),
    box: {
      dimensions: new Cesium.Cartesian3(BIN + 1.6, BIN + 1.6, 1.2),
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.roofBlue)
    }
  })

  // 装车溜槽：从仓体中部斜着伸出去再落下来
  const armPath: LonLat[] = [
    plantPt(l.x, l.y),
    plantPt(l.x + armOut * 0.55, l.y),
    plantPt(l.x + armOut, l.y)
  ]
  // 溜槽底与顶盖（顶盖抬高 1.6m）共用同一条中心线，只有标高差一层
  const armLift = (up: number) =>
    [H - 3 + up, H - 3 + up - armDrop * 0.5, H - 3 + up - armDrop].map((v) => baseH + v)

  entities.add({
    id: `loader-${index}-arm`,
    name: `${l.name}装车溜槽`,
    polygon: {
      ...beltPolygon(ribbonRing(armPath, 2.2, armLift(0))),
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.steel),
      outline: true,
      outlineColor: SCENE_COLORS.primary.withAlpha(0.5)
    }
  })
  entities.add({
    id: `loader-${index}-arm-top`,
    name: `${l.name}溜槽顶盖`,
    polygon: {
      ...beltPolygon(ribbonRing(armPath, 3.0, armLift(1.6))),
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.roofBlue).withAlpha(0.9)
    }
  })

  // 重卡：车斗 + 驾驶室，停在溜槽正下方
  const truckX = l.x + armOut * 0.86
  entities.add({
    id: `loader-${index}-truck-bed`,
    name: '矿用卡车',
    position: at(truckX - 2.4, l.y, 2.2),
    box: {
      dimensions: new Cesium.Cartesian3(7.5, 3.2, 2.6),
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.ore),
      outline: true,
      outlineColor: SCENE_COLORS.primary.withAlpha(0.4)
    }
  })
  entities.add({
    id: `loader-${index}-truck-cab`,
    name: '矿用卡车驾驶室',
    position: at(truckX + 3.0, l.y, 1.7),
    box: {
      dimensions: new Cesium.Cartesian3(2.2, 3.0, 3.0),
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.truck),
      outline: true,
      outlineColor: SCENE_COLORS.primary.withAlpha(0.4)
    }
  })
}

/**
 * 皮带廊：封闭廊道 + 桁架支架。
 *
 * 参考图里最醒目的构筑物——长距离架空、等间距立柱支撑，
 * 廊道本体是封闭的（走道 + 两侧壁 + 顶盖），不是一条薄线。
 *
 * 尺寸按实景取：走道离地 13m、净高 4.2m、宽 5.4m，
 * 支架每 34m 一榀，与真实输送廊道的柱距量级一致。
 *
 * ⚠️ 廊道**贴着地面走**而不是贴着台地：`heights` 传进来的是沿线各点的
 * 实际支撑高度（台地上取平台标高，台地外取地形），所以跨台地那一段
 * 会自然形成一个下坡，这正是重力流的样子。
 */
function buildConveyor(
  entities: Cesium.EntityCollection,
  path: LonLat[],
  index: number,
  heights: number[],
  grounds: number[]
): void {
  const DECK = 13
  const HEIGHT = 4.2
  const WIDTH = 5.4
  const BAY = 34

  const at = (lonlat: LonLat, lift: number) =>
    Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1], lift)

  const deckMin = path.map((_, i) => (heights[i] ?? 0) + DECK)
  const deckMax = path.map((_, i) => (heights[i] ?? 0) + DECK + HEIGHT)

  // ---- 走道底面 ----
  entities.add({
    id: `conveyor-${index}-deck`,
    name: '皮带廊走道',
    polygon: {
      ...beltPolygon(ribbonRing(path, WIDTH, deckMin)),
      material: Cesium.Color.fromCssColorString('#8ea4b8'),
      outline: true,
      outlineColor: SCENE_COLORS.primary.withAlpha(0.6),
      outlineWidth: 1
    }
  })

  // ---- 顶盖：比廊身略宽，形成出檐 ----
  entities.add({
    id: `conveyor-${index}-roof`,
    name: '皮带廊顶盖',
    polygon: {
      ...beltPolygon(ribbonRing(path, WIDTH + 1.0, deckMax)),
      material: Cesium.Color.fromCssColorString(PLANT_COLORS.roofBlue).withAlpha(0.96),
      outline: true,
      outlineColor: SCENE_COLORS.primary.withAlpha(0.5)
    }
  })

  // ---- 两侧壁 ----
  for (const side of [-1, 1]) {
    const edge = offsetPath(path, (side * WIDTH) / 2)
    entities.add({
      id: `conveyor-${index}-wall-${side}`,
      name: '皮带廊廊身',
      wall: {
        positions: edge.map((p) => at(p, 0)),
        minimumHeights: deckMin,
        maximumHeights: deckMax,
        material: Cesium.Color.fromCssColorString('#cfe1ef').withAlpha(0.92),
        outline: false
      }
    })
    entities.add({
      id: `conveyor-${index}-eave-${side}`,
      name: '皮带廊檐口',
      polyline: {
        positions: edge.map((p, i) => at(p, (heights[i] ?? 0) + DECK + HEIGHT)),
        width: 1.6,
        material: SCENE_COLORS.primary.withAlpha(0.55)
      }
    })
  }

  // ---- 桁架支架：等间距一榀，两柱一梁加斜撑 ----
  // 按累计弧长布柱，保证柱距均匀，而不是按顶点数均分
  const mx = metersPerLon(path[0][1])
  const cum: number[] = [0]
  for (let i = 1; i < path.length; i++) {
    const dx = (path[i][0] - path[i - 1][0]) * mx
    const dy = (path[i][1] - path[i - 1][1]) * METERS_PER_LAT
    cum.push(cum[i - 1] + Math.hypot(dx, dy))
  }
  const total = cum[cum.length - 1]

  /**
   * 弧长 s 处：走道支撑高程 `belt` 与**脚下的真实地面** `ground` 分开取。
   *
   * 两者不能混用：`belt` 是走道的设计高程（台地上是平台标高、台地外是实测地形），
   * 支腿的柱脚要落在 `ground` 上。原先只有一个插值值兼做两用，
   * 于是柱脚跟着走道走——走道离地多高，柱脚就悬多高（实测有 10m 以上）；
   * 走道插值到地面以下时，柱脚又整个埋进山里（实测 26m）。
   */
  const sampleAt = (s: number): { p: LonLat; belt: number; ground: number } => {
    let i = 1
    while (i < cum.length - 1 && cum[i] < s) i++
    const t = (s - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-6)
    const lon = path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t
    const lat = path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t
    const belt = (heights[i - 1] ?? 0) + ((heights[i] ?? 0) - (heights[i - 1] ?? 0)) * t
    const ground = (grounds[i - 1] ?? belt) + ((grounds[i] ?? belt) - (grounds[i - 1] ?? belt)) * t
    return { p: [lon, lat], belt, ground }
  }

  const bentCount = Math.max(2, Math.floor(total / BAY))
  for (let b = 0; b <= bentCount; b++) {
    const { p, belt, ground } = sampleAt((total * b) / bentCount)
    const left = offsetPath([p, p], (WIDTH + 1.4) / 2)[0]
    const right = offsetPath([p, p], -(WIDTH + 1.4) / 2)[0]
    // 柱顶跟着走道，柱脚落在自己脚下的地面；地面高出走道时（台地边缘那种折角）
    // 取更高的那个做柱脚，柱子退化成 0 高而不是倒插进地里
    const top = belt + DECK - 0.6
    const foot = Math.min(ground, top)

    // 立柱 + 横梁合成一条折线：左柱脚 → 左柱顶 → 右柱顶 → 右柱脚
    entities.add({
      id: `conveyor-${index}-bent-${b}`,
      name: '皮带廊支架',
      polyline: {
        positions: [at(left, foot), at(left, top), at(right, top), at(right, foot)],
        width: 3.2,
        material: Cesium.Color.fromCssColorString('#9aa9b6')
      }
    })

    entities.add({
      id: `conveyor-${index}-bent-${b}-brace`,
      name: '皮带廊支架斜撑',
      polyline: {
        positions: [at(left, foot), at(right, top), at(left, top), at(right, foot)],
        width: 1.5,
        material: Cesium.Color.fromCssColorString('#7f8f9d').withAlpha(0.85)
      }
    })
  }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

/**
 * 建整个选矿厂。
 *
 * 顺序有讲究：**台地必须最先建**，它返回的平台标高是后面所有东西的基准。
 * 厂房、筒仓、穹顶、浓密池、装车站全部坐在各自台地的平台上——
 * 不各自采样地形，理由见文件头。
 */
export async function buildPlant(
  entities: Cesium.EntityCollection,
  benchH: BenchElevations
): Promise<void> {
  const at = (k: BenchKey) => benchH[k] ?? MINE_ELEVATION

  // ---- 厂房 ----
  PLANT_BUILDINGS.forEach((b, i) => buildBuilding(entities, b, at(b.bench), i))

  // ---- 筒仓 ----
  PLANT_SILOS.forEach((s, i) => buildSilo(entities, s, at(s.bench), i))

  // ---- 穹顶料仓 / 料棚 ----
  PLANT_DOMES.forEach((d, i) => buildDome(entities, d, at(d.bench), i))

  // ---- 浓密池 ----
  PLANT_THICKENERS.forEach((t, i) => buildThickener(entities, t, at(t.bench), i))

  // ---- 装车站 ----
  PLANT_LOADERS.forEach((l, i) => buildLoader(entities, l, at(l.bench), i))

  // ---- 储罐 ----
  PLANT_TANKS.forEach((t, i) => buildTank(entities, t, at(t.bench), i))

  // ---- 皮带廊 ----
  // 支撑高度按「点在哪个台地上就用哪个台地的平台标高，台地外取**实测地形**」。
  // 廊道因此会在台地边上折一下，那一折就是重力流的落差。
  const benchAt = (x: number, y: number): number | null => {
    for (const b of BENCHES) {
      if (y >= b.y0 && y <= b.y1 && Math.abs(x - b.cx) <= b.halfWidth) return benchH[b.key] ?? null
    }
    return null
  }

  // ⚠️ 路径必须**加密**，不能只在折点上采地形。
  //
  // `CONVEYORS` 是工艺折线，折点间距最大 300 多米（采坑→粗碎站那条 1.8km 只有 7 个折点）。
  // 只在折点上采地形、中间按直线插值的话，山谷鼓出来的地方廊道就钻进去了：
  // 实测「采坑→粗碎站」有 8 个点在**自然地面以下 100 米**，支腿埋深 26m、
  // 另有几榀悬空 10m 以上——支腿的高程取的是走道插值高度，不是它自己脚下的地面。
  // 现在按 ~20m 加密，走道贴着谷壁走，支腿落在自己脚下的地面上。
  const CV_STEP = 20
  const densePaths = CONVEYORS.map((path) => {
    const out: LonLat[] = [path[0]]
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1]
      const [bx, by] = path[i]
      const dist = Math.hypot((bx - ax) * metersPerLon(ay), (by - ay) * METERS_PER_LAT)
      const n = Math.max(1, Math.round(dist / CV_STEP))
      for (let k = 1; k <= n; k++) {
        out.push([ax + (bx - ax) * (k / n), ay + (by - ay) * (k / n)])
      }
    }
    return out
  })
  const pathLocals = densePaths.map((path) => path.map(lonLatToPlant))

  // ⚠️ 台地外的点**必须采地形，不能取 0**。
  // `heights` 是绝对高程（走道 = heights + 13），谷底在 1350m 上下。
  // 取 0 的话走道落在 13m，比谷底低一千三百多米——整条廊道埋在山里，
  // 屏幕上什么都没有，却也不会报任何错。之前「采坑→粗碎站」那条最长的
  // 廊道就是这样消失的（注释写着「台地外取地形」，代码写的是 `?? 0`）。
  const needSample: { key: string; lon: number; lat: number }[] = []
  pathLocals.forEach((locals, i) =>
    locals.forEach(([x, y], j) => {
      if (benchAt(x, y) === null) {
        const p = densePaths[i][j]
        needSample.push({ key: `cv-${i}-${j}`, lon: p[0], lat: p[1] })
      }
    })
  )
  const terrain = await sampleGroundHeights(needSample, MINE_ELEVATION)

  densePaths.forEach((path, i) => {
    // 走道支撑高度：台地上取平台标高，台地外取实测地形
    const heights = pathLocals[i].map(
      ([x, y], j) => benchAt(x, y) ?? terrain[`cv-${i}-${j}`] ?? MINE_ELEVATION
    )
    // 支腿脚下的真实地面：台地外**必须是实测地形**（不是走道的插值高度）
    const grounds = pathLocals[i].map(([x, y], j) =>
      benchAt(x, y) !== null ? heights[j] : (terrain[`cv-${i}-${j}`] ?? MINE_ELEVATION)
    )
    buildConveyor(entities, path, i, heights, grounds)
  })
}

/**
 * 经纬度 → 厂区局部坐标（`plantPt` 的逆变换）。
 *
 * 只给「已知一个经纬度、想知道它落在哪级台地上」用（皮带廊支腿该插多高）。
 * 与 `plantPt` 是一对，**改一个必须改另一个**——所以方位角走
 * `PLANT_AXIS_DEG` 这个共享常量，不在两边各写一个方位角。
 */
function lonLatToPlant(p: LonLat): [number, number] {
  const mx = metersPerLon(PLANT_ORIGIN[1])
  const east = (p[0] - PLANT_ORIGIN[0]) * mx
  const north = (p[1] - PLANT_ORIGIN[1]) * METERS_PER_LAT
  // plantPt 的正变换是 [[cos, sin], [-sin, cos]]，行列式为 1，逆矩阵即转置
  const a = (PLANT_AXIS_DEG * Math.PI) / 180
  return [
    east * Math.cos(a) - north * Math.sin(a),
    east * Math.sin(a) + north * Math.cos(a)
  ]
}
