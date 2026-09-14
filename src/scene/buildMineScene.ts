import * as Cesium from 'cesium'
import { MINE_ELEVATION, PIT_COLORS, SCENE_COLORS, TERRAIN_COLORS } from './sceneConfig'
import { sampleGroundHeights } from './localTerrain'
import { buildBenches, buildPlant } from './buildPlant'
import { beltPolygon, ellipsePoints, flatPolygon, insetRing, makeRng, ribbonRing, toLocal, toLonLat } from './geometry'
import { installTerrainClip, registerModelSurface } from './terrainClip'
import {
  DUMPS,
  METERS_PER_LAT,
  PIT,
  PIT_WATER_INSET,
  ROADS,
  TAILINGS,
  TREE_ZONES,
  metersPerLon
} from './mineLayout'
import type { LonLat } from './mineLayout'

/**
 * 金堆城钼矿程序化场景——**矿区尺度**的那一半。
 *
 * 在拿到真实倾斜摄影 3D Tiles 之前，用几何体搭出可用的矿区三维场景。
 *
 * 与 `buildPlant` 的分工：本文件建**随地形走的地物**（露天采坑、排土场、
 * 尾矿库、矿区道路、绿化），`buildPlant` 建**人工削出来的选矿厂**
 * （分级台地、厂房、筒仓、浓密池、皮带廊、装车站）。
 * 分野就是「地形决定它，还是它决定地形」。
 *
 * 本文件只负责「怎么建」——几何、材质、高程采样；
 * 「东西在哪」全部来自 `./mineLayout`。
 *
 * 三维物体的高度不写死：建场景前先用 `sampleGroundHeights` 把每个关键点
 * 的高程从离线 DEM 瓦片上采出来，贴合真实地形。
 * 金堆城在秦岭北麓，沟谷高差数百米，写死高度会整片穿模。
 * （不要改用 `Cesium.sampleTerrainMostDetailed`，原因写在
 * `sampleOnePoint` 的注释里。）
 *
 * **唯一例外是选矿厂**：厂区的标高来自台地平台，不走地形采样——
 * 真实选矿厂就是削平台地之后把设备装上去的，理由写在 `buildPlant.ts` 头部。
 *
 * 接入真实模型后本文件可整体替换。
 */

interface TreeSpec {
  lon: number
  lat: number
  /** 总高（米） */
  height: number
  /** 冠幅（米） */
  crown: number
  kind: 'conifer' | 'broadleaf'
  /** 冠色，从深绿到黄绿之间取值 */
  color: Cesium.Color
}

function generateTrees(): TreeSpec[] {
  const rng = makeRng(20260911)
  const trees: TreeSpec[] = []

  for (const zone of TREE_ZONES) {
    const mx = metersPerLon(zone.lat)
    for (let i = 0; i < zone.count; i++) {
      // 在椭圆片区内取点：半径开方保证面内均匀，不然会往中心堆
      const a = rng() * Math.PI * 2
      const r = Math.sqrt(rng())
      const lon = zone.lon + (Math.cos(a) * r * zone.rx) / mx
      const lat = zone.lat + (Math.sin(a) * r * zone.ry) / METERS_PER_LAT

      // 尺寸拉开档次，成片同款最容易看出是程序生成的
      const scale = 0.65 + rng() * 0.75
      const height = zone.kind === 'conifer' ? 26 * scale : 18 * scale
      const crown = zone.kind === 'conifer' ? 7.5 * scale : 11 * scale

      // 冠色在深绿与黄绿之间抖动
      const t = rng()
      trees.push({
        lon,
        lat,
        height,
        crown,
        kind: zone.kind,
        color: Cesium.Color.fromHsl(
          0.26 + t * 0.08,
          0.42 + t * 0.2,
          0.24 + t * 0.14
        )
      })
    }
  }
  return trees
}

const TREES = generateTrees()

// ---------------------------------------------------------------------------
// 几何工具
// ---------------------------------------------------------------------------
//
// 通用的那几件（`toLocal` / `toLonLat` / `insetRing` / `ringAt` /
// `ellipsePoints` / `makeRng`）已经抽到 `./geometry`：`buildPlant` 也要用，
// 留在这里会让两个文件互相 import 成环。下面只剩矿区专有的。

/**
 * 生成近椭圆的采坑轮廓。
 *
 * 叠两个低次谐波，避免出现标准椭圆那种一眼假的规整感——
 * 真实采坑边界是顺着矿体走向起伏的。
 */
function pitOutline(segments = 48): LonLat[] {
  const pts: LonLat[] = []
  const mx = metersPerLon(PIT.lat)
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const wobble = 1 + 0.075 * Math.sin(3 * a + 0.7) + 0.045 * Math.cos(5 * a)
    pts.push([
      PIT.lon + (Math.cos(a) * PIT.rx * wobble) / mx,
      PIT.lat + (Math.sin(a) * PIT.ry * wobble) / METERS_PER_LAT
    ])
  }
  return pts
}

/** 把 {key: [lon, lat]} 转成采样函数要的点列表 */
function toSamplePoints(keys: Record<string, LonLat>) {
  return Object.entries(keys).map(([key, [lon, lat]]) => ({ key, lon, lat }))
}

// ---------------------------------------------------------------------------
// 构建器
// ---------------------------------------------------------------------------

/**
 * 露天采坑。
 *
 * 按「安全平台 + 坡面」交替生成：平台是水平环形面，坡面是近乎垂直的阶梯壁。
 * 这样才有真实露天矿层层台阶的观感，而不是一个光滑的漏斗。
 */
function buildPit(
  entities: Cesium.EntityCollection,
  rimHeight: number,
  edgeGround: number[]
): void {
  const outline = pitOutline()
  const origin: LonLat = [PIT.lon, PIT.lat]
  const base = toLocal(outline, origin)

  const step = PIT.bermWidth + PIT.faceWidth
  const bottomHeight = rimHeight - PIT.benches * PIT.benchHeight
  // 坑底环：外沿一圈圈内缩到最后一级。积水也由它内缩得到，见下
  const bottomRing = insetRing(base, PIT.benches * step)

  for (let k = 0; k < PIT.benches; k++) {
    const levelHeight = rimHeight - k * PIT.benchHeight

    // 安全平台：从外沿内缩 k*step，宽度 bermWidth
    const bermOuter = insetRing(base, k * step)
    const bermInner = insetRing(base, k * step + PIT.bermWidth)
    // 台阶面是环形的：外沿一圈 + 反向的内沿一圈拼成**一个**环（keyhole），整圈同高
    const bermRing: LonLat[] = [
      ...toLonLat(bermOuter, origin),
      ...toLonLat(bermInner, origin).reverse()
    ]

    entities.add({
      id: `pit-berm-${k}`,
      name: `采坑平台 ${k + 1}`,
      polygon: {
        ...flatPolygon(bermRing, levelHeight),
        material:
          k % 2 === 0
            ? Cesium.Color.fromCssColorString(PIT_COLORS.stepA)
            : Cesium.Color.fromCssColorString(PIT_COLORS.stepB),
        outline: true,
        outlineColor: SCENE_COLORS.primaryTransparent,
        outlineWidth: 1
      }
    })

    // 坡面：从本层平台内沿下到下一层平台外沿
    const faceBottom = insetRing(base, (k + 1) * step)
    const top = toLonLat(bermInner, origin)
    const bot = toLonLat(faceBottom, origin)
    const positions: Cesium.Cartesian3[] = []
    for (let i = 0; i < top.length; i++) {
      const j = (i + 1) % top.length
      // 每段拆成两个三角形，保证绕序一致、面朝坑内
      positions.push(
        Cesium.Cartesian3.fromDegrees(top[j][0], top[j][1], levelHeight),
        Cesium.Cartesian3.fromDegrees(top[i][0], top[i][1], levelHeight),
        Cesium.Cartesian3.fromDegrees(bot[i][0], bot[i][1], levelHeight - PIT.benchHeight)
      )
      positions.push(
        Cesium.Cartesian3.fromDegrees(bot[i][0], bot[i][1], levelHeight - PIT.benchHeight),
        Cesium.Cartesian3.fromDegrees(bot[j][0], bot[j][1], levelHeight - PIT.benchHeight),
        Cesium.Cartesian3.fromDegrees(top[j][0], top[j][1], levelHeight)
      )
    }

    entities.add({
      id: `pit-face-${k}`,
      name: `采坑帮坡 ${k + 1}`,
      wall: {
        positions,
        // 下沿必须显式写。`wall` 只给 positions 时，Cesium 把下沿**补成 0.0**
        // ——也就是椭球面：
        //   `cleanedBottomHeights[0] = 0.0`（`WallGeometryLibrary.js:51-52`，
        //    没给 minimumHeights 的分支）
        // 于是这面帮坡从海拔 0 一路拉到本层平台，多出 1200 多米埋在地下的面。
        // 本层帮坡的下沿就是下一层平台（`levelHeight - benchHeight`）。
        minimumHeights: positions.map(() => levelHeight - PIT.benchHeight),
        material: Cesium.Color.fromCssColorString(PIT_COLORS.face).withAlpha(0.98),
        outline: false
      }
    })
  }

  // 坑底
  entities.add({
    id: 'pit-bottom',
    name: '采坑底部',
    polygon: {
      ...flatPolygon(toLonLat(bottomRing, origin), bottomHeight),
      material: Cesium.Color.fromCssColorString(PIT_COLORS.bottom),
      outline: true,
      outlineColor: SCENE_COLORS.primaryTransparent
    }
  })

  // 坑底积水：形状随坑底环走（再内缩 PIT_WATER_INSET 米），不会顶出帮坡
  entities.add({
    id: 'pit-water',
    name: '坑底积水',
    polygon: {
      ...flatPolygon(
        toLonLat(insetRing(bottomRing, PIT_WATER_INSET), origin),
        bottomHeight + 1.5
      ),
      material: Cesium.Color.fromCssColorString('#1d5f7a').withAlpha(0.85)
    }
  })

  // 坑沿：坑口一圈从自然地面砌到坑沿标高。
  //
  // 底图在坑口范围内被挖掉（见 `terrainClip`），洞口边界就是自然地面；
  // 而模型的坑沿取的是「一圈采样最大值 + 8m」，比坑口各点的自然地面只高不低，
  // 不砌这圈崖面，坑沿就会浮在洞口上方露一圈缝。
  const rimRing = [...outline, outline[0]]
  entities.add({
    id: 'pit-rim-skirt',
    name: '采坑坑沿',
    wall: {
      positions: rimRing.map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1], 0)),
      minimumHeights: rimRing.map((_, i) => Math.min(edgeGround[i % outline.length] ?? rimHeight, rimHeight)),
      maximumHeights: rimRing.map((_, i) => Math.max(edgeGround[i % outline.length] ?? rimHeight, rimHeight)),
      material: Cesium.Color.fromCssColorString(PIT_COLORS.face).withAlpha(0.98),
      outline: false
    }
  })
  registerModelSurface(outline)

  // 运输坡道：沿各层平台盘旋而下。
  //
  // 路径必须**跟着坑口轮廓走**（`pitOutline` 那圈谐波抖动），不能自己算一个椭圆。
  // 坑口轮廓带 ±12% 的抖动（`pitOutline` 里的 wobble：0.075·sin3a + 0.045·cos5a），
  // 而原先这里按 `PIT.rx - dist` 算纯椭圆，于是：
  //   - 抖动 < 1 的方向（轮廓收进来）→ 坡道**戳到洞外**。洞外没被 `terrainClip`
  //     挖掉，自然地面比坡道高出上百米，坡道在那里整段埋进山里；
  //   - 抖动 > 1 的方向（轮廓鼓出去）→ 坡道离坑沿四十多米，落到下一层平台上，
  //     悬空一层台阶。
  // 现在按**同一串点**内缩（`insetRing` 与采坑平台用的是同一个函数）：
  // 每个采样点都落在本层安全平台的正中间（内缩 k*step + bermWidth/2），
  // 洞沿、帮坡、坡道三者永远对得上。
  const rampPath: LonLat[] = []
  const rampHeights: number[] = []
  const turns = 2.2
  const RAMP_STEPS = 180
  // 每层一条「平台中线」环：就是 `base`（坑口轮廓的局部坐标）内缩到平台中间，
  // 与上面 `pit-berm-*` 用的是同一个 `insetRing`
  const midBermRings = Array.from({ length: PIT.benches }, (_, k) =>
    toLonLat(insetRing(base, k * step + PIT.bermWidth / 2), origin)
  )

  for (let i = 0; i <= RAMP_STEPS; i++) {
    const t = i / RAMP_STEPS
    const k = Math.min(PIT.benches - 1, Math.floor(t * PIT.benches))
    const h = rimHeight - k * PIT.benchHeight
    const angle = t * Math.PI * 2 * turns

    // 在本层的中线环上按角度取点：环上的顶点就是按角度等分生成的，
    // 所以角度 → 顶点下标是线性的，中间线性插值即可
    const ring = midBermRings[k]
    const n = ring.length
    const idx = (((angle / (Math.PI * 2)) % 1) + 1) % 1
    const fi = idx * n
    const i0 = Math.floor(fi) % n
    const i1 = (i0 + 1) % n
    const f = fi - Math.floor(fi)

    rampPath.push([
      ring[i0][0] + (ring[i1][0] - ring[i0][0]) * f,
      ring[i0][1] + (ring[i1][1] - ring[i0][1]) * f
    ])
    rampHeights.push(h + 1)
  }

  entities.add({
    id: 'pit-haul-road',
    name: '采坑运输道路',
    polygon: {
      ...beltPolygon(ribbonRing(rampPath, 11, rampHeights)),
      material: Cesium.Color.fromCssColorString(TERRAIN_COLORS.road).withAlpha(0.9)
    }
  })
}

/**
 * 排土场：台阶式堆弃体，顶面平整、边坡外扩。
 *
 * 三段几何缺一不可——只建台阶面的话，这个堆体是「一摞悬空的盘」：
 * 底图没挖掉时，靠自然地面把盘与盘之间的缝和盘底下的空档挡住；
 * 一旦按用户要求**把模型自己当那片地的地表**（`registerModelSurface`），
 * 那些缝就直通虚空，越看越像穿帮。
 *
 *  1. 台阶面 `dump-<i>-berm-<k>`：一圈平置的环（外沿 + 反向内沿）；
 *  2. 台阶立壁 `dump-<i>-step-<k>`：把本层内沿与上一层外沿用墙封住。
 *     **两层环必须共用同一串点**——所以内缩量取正好一个台阶宽 `benchW`，
 *     上一层的外沿就是本层的内沿（原先内缩 0.9×benchW，中间留 2.6m 的缝）；
 *  3. 落地崖面 `dump-<i>-skirt`：最外圈从台面砌到**实测自然地面**。
 *     下坡侧补出坡脚，上坡侧就是开挖面，两个方向都靠 min/max 一条墙搞定。
 */
function buildDump(
  entities: Cesium.EntityCollection,
  dump: { lon: number; lat: number; rx: number; ry: number; height: number; benches: number },
  groundHeight: number,
  edgeGround: number[],
  index: number
): void {
  const benchH = dump.height / dump.benches
  const benchW = 26

  // 各层外沿：内缩量正好一个台阶宽，层与层共用同一串点
  const outer: LonLat[][] = []
  const tops: number[] = []
  for (let k = 0; k < dump.benches; k++) {
    const rx = dump.rx - k * benchW
    const ry = dump.ry - k * benchW
    if (rx < 20 || ry < 20) break
    outer.push(ellipsePoints(dump.lon, dump.lat, rx, ry))
    tops.push(groundHeight + (k + 1) * benchH)
  }
  if (!outer.length) return

  const topRing = ellipsePoints(
    dump.lon,
    dump.lat,
    Math.max(dump.rx - outer.length * benchW, 15),
    Math.max(dump.ry - outer.length * benchW, 15)
  )

  // ---- 台阶面：外沿 + 反向内沿拼成一个环（内沿即上一层外沿）----
  for (let k = 0; k < outer.length; k++) {
    const inner = outer[k + 1] ?? topRing
    const bermRing: LonLat[] = [...outer[k], ...[...inner].reverse()]

    entities.add({
      id: `dump-${index}-berm-${k}`,
      name: '排土场台阶',
      polygon: {
        ...flatPolygon(bermRing, tops[k]),
        material: Cesium.Color.fromCssColorString(PIT_COLORS.stepB).withAlpha(0.95),
        outline: true,
        outlineColor: SCENE_COLORS.primaryTransparent
      }
    })
  }

  // ---- 台阶立壁：共用环上从本层台面砌到上一层台面 ----
  for (let k = 0; k + 1 < outer.length; k++) {
    const ring = [...outer[k + 1], outer[k + 1][0]]
    entities.add({
      id: `dump-${index}-step-${k}`,
      name: '排土场边坡',
      wall: {
        positions: ring.map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1], 0)),
        minimumHeights: ring.map(() => tops[k]),
        maximumHeights: ring.map(() => tops[k + 1]),
        material: Cesium.Color.fromCssColorString(PIT_COLORS.face).withAlpha(0.98),
        outline: false
      }
    })
  }

  // ---- 顶面（与最上一层台阶面等高，拼成一个整圆盘）----
  entities.add({
    id: `dump-${index}-top`,
    name: '排土场顶部',
    polygon: {
      ...flatPolygon(topRing, tops[tops.length - 1]),
      material: Cesium.Color.fromCssColorString(PIT_COLORS.stepA).withAlpha(0.95)
    }
  })

  // ---- 落地崖面：最外圈从台面砌到实测自然地面 ----
  // 与采坑坑沿同一套路（见 `pit-rim-skirt`）：逐点取 min/max，
  // 自然地面高于台面的地方是开挖面，低于台面的地方是坡脚，一条墙两个方向都封住。
  const foot = outer[0]
  const skirtRing = [...foot, foot[0]]
  const skirtGround = skirtRing.map((_, i) => edgeGround[i % foot.length] ?? tops[0])
  entities.add({
    id: `dump-${index}-skirt`,
    name: '排土场坡脚',
    wall: {
      positions: skirtRing.map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1], 0)),
      minimumHeights: skirtRing.map((_, i) => Math.min(skirtGround[i], tops[0])),
      maximumHeights: skirtRing.map((_, i) => Math.max(skirtGround[i], tops[0])),
      material: Cesium.Color.fromCssColorString(PIT_COLORS.face).withAlpha(0.98),
      outline: false
    }
  })

  // 登记足迹：挖掉底图之后，这片地的地表就是上面这个堆体本身
  registerModelSurface(foot)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export interface BuildMineSceneOptions {
  /**
   * 是否构建**地形底座**（采坑开挖、排土场、尾矿库）。
   *
   * 用在线实景三维或甲方的倾斜摄影成果时传 `false`：
   * 真实的采坑、排土场、尾矿库已经在实景模型里了，
   * 再挖一个程序化的假坑只会和真地形打架。
   *
   * **设施部分（厂房、筒仓、皮带廊、道路、场地工程、绿化）始终构建**——
   * 参考图就是这么做的：真实地形做底，风格化的设施叠在上面。
   * 两者共存才是这个项目该有的形态，早期把它们做成互斥是设计错误。
   */
  withTerrainBase?: boolean
}

/**
 * 构建金堆城钼矿场景。
 *
 * 异步：需要先把关键点的高程从三维底座采样出来，才能把地物摆到正确的高度。
 */
export async function buildMineScene(
  viewer: Cesium.Viewer,
  options: BuildMineSceneOptions = {}
): Promise<void> {
  const { withTerrainBase = true } = options
  const entities = viewer.entities

  // ---- 采集所有关键点的高程 ----
  //
  // 只采「随地形走」的四类：采坑、排土场、尾矿库、坑沿、树木。
  // **选矿厂不在这里**——它坐在人工削出来的分级台地上，平台标高由
  // `buildBenches` 单独采（理由见 `buildPlant.ts` 文件头）。把厂房一起采进来
  // 就等于把设备摆回原始坡面，谷底那几座会整片陷进山体。
  const sampleKeys: Record<string, LonLat> = { pit: [PIT.lon, PIT.lat] }
  DUMPS.forEach((d, i) => (sampleKeys[`dump-${i}`] = [d.lon, d.lat]))
  sampleKeys.tailings = [TAILINGS.lon, TAILINGS.lat]

  // 排土场坡脚与尾矿库库岸：这两圈既是「挖洞的边界」，又是「崖面的顶边」，
  // **必须与 buildDump / 尾矿库用的是同一串点**——同 `pitEdge` 的理由（见 terrainClip）：
  // 用同一串经纬度采出来的高程，洞沿与崖顶才落在同一个点上，不留缝。
  const dumpEdges = DUMPS.map((d) => ellipsePoints(d.lon, d.lat, d.rx, d.ry))
  dumpEdges.forEach((ring, i) => ring.forEach((p, k) => (sampleKeys[`dumpEdge-${i}-${k}`] = p)))
  const tailingsRing = ellipsePoints(TAILINGS.lon, TAILINGS.lat, TAILINGS.rx, TAILINGS.ry)
  tailingsRing.forEach((p, i) => (sampleKeys[`tailingsEdge-${i}`] = p))

  // 坑沿采样点：沿采坑外沿稍外扩一圈
  const rimOutline = ellipsePoints(PIT.lon, PIT.lat, PIT.rx * 1.06, PIT.ry * 1.06, 16)
  rimOutline.forEach((p, i) => (sampleKeys[`rim-${i}`] = p))

  // 坑口边界：底图挖洞的边界与坑沿崖顶共用这一串点（理由见 `terrainClip`）
  const pitEdge = pitOutline()
  pitEdge.forEach((p, i) => (sampleKeys[`pitEdge-${i}`] = p))

  // 树木一起采：原先它在末尾单独再 await 一次采样，纯粹是白等一轮网络往返
  TREES.forEach((t, i) => (sampleKeys[`tree-${i}`] = [t.lon, t.lat]))

  const ground = await sampleGroundHeights(
    toSamplePoints(sampleKeys),
    MINE_ELEVATION
  )

  // ---- 地形底座：采坑开挖 ----
  //
  // 用实景三维时跳过——真实的采坑已经在实景模型里（实测坑底 1284m），
  // 再挖一个程序化的假坑会和真地形互相穿插。
  if (withTerrainBase) {
    // 坑沿必须取「沿坑口一圈实测高程的最大值」：
    //   - 取厂区高程不行，选矿厂在 1km 外的台地上（1400m+），坑口会浮在半空；
    //   - 取坑心高程也不行，DEM 在坑内已被采空拉低（1303m），采坑会整个埋进山体。
    const rimHeight =
      Math.max(...rimOutline.map((_, i) => ground[`rim-${i}`] ?? 0)) + 8
    buildPit(
      entities,
      rimHeight,
      pitEdge.map((_, i) => ground[`pitEdge-${i}`])
    )
  }

  // ---- 选矿厂：分级台地 + 全厂设施 ----
  //
  // 顺序有讲究，**台地必须最先建**：它返回的四级平台标高是厂区里
  // 厂房、筒仓、浓密池、皮带廊支腿的统一基准。
  // 厂区平面布置用局部坐标（谷轴方位角见 `PLANT_AXIS_DEG`），标高用平台标高，
  // 两条规矩都封在 `buildPlant` 里，这里只管调用顺序。
  // `buildPlant` 是 async 的：台地之外那几段皮带廊要采真实地形当支撑高度。
  const benchH = await buildBenches(viewer, entities)
  await buildPlant(entities, benchH)

  // ---- 地形底座：排土场与尾矿库 ----
  // 同样是实景三维里已有的真实地物，用在线模型时跳过
  if (withTerrainBase) {
    DUMPS.forEach((d, i) =>
      buildDump(
        entities,
        d,
        ground[`dump-${i}`] ?? 0,
        dumpEdges[i].map((_, k) => ground[`dumpEdge-${i}-${k}`]),
        i
      )
    )

    // 尾矿库：库面 + 库岸。
    // 库面原先是一块**平铺在库心高程上的板**，四周起伏全靠自然地面兜着；
    // 登记成「模型即地表」之后必须自带一圈库岸（砌到实测自然地面），
    // 否则上坡侧是敞开的洞、下坡侧能看到板底。
    const tailingsH = (ground.tailings ?? 0) + 2
    entities.add({
      id: 'tailings-pond',
      name: '尾矿库',
      polygon: {
        ...flatPolygon(tailingsRing, tailingsH),
        material: Cesium.Color.fromCssColorString('#1f7a94').withAlpha(0.9),
        outline: true,
        outlineColor: SCENE_COLORS.primary.withAlpha(0.5)
      }
    })

    const bankRing = [...tailingsRing, tailingsRing[0]]
    const bankGround = bankRing.map(
      (_, i) => ground[`tailingsEdge-${i % tailingsRing.length}`] ?? tailingsH
    )
    entities.add({
      id: 'tailings-bank',
      name: '尾矿库岸',
      wall: {
        positions: bankRing.map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1], 0)),
        minimumHeights: bankRing.map((_, i) => Math.min(bankGround[i], tailingsH)),
        maximumHeights: bankRing.map((_, i) => Math.max(bankGround[i], tailingsH)),
        material: Cesium.Color.fromCssColorString(PIT_COLORS.face).withAlpha(0.98),
        outline: false
      }
    })
    registerModelSurface(tailingsRing)
  }

  // ---- 道路（贴地）----
  ROADS.forEach((road, i) => {
    entities.add({
      id: `road-${i}`,
      name: '矿区道路',
      polyline: {
        positions: road.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 0)),
        width: 7,
        material: Cesium.Color.fromCssColorString(TERRAIN_COLORS.road),
        clampToGround: true
      }
    })
  })

  // ---- 绿化 ----
  // 贴合地形采样，避免树冠浮在半空或埋进山里
  TREES.forEach((t, i) => {
    const base = ground[`tree-${i}`] ?? MINE_ELEVATION
    const trunkH = t.height * 0.3
    const pos = (lift: number) =>
      Cesium.Cartesian3.fromDegrees(t.lon, t.lat, base + lift)

    // 树干：所有树共用一套细圆柱
    entities.add({
      id: `tree-${i}-trunk`,
      name: '树木',
      position: pos(trunkH / 2),
      cylinder: {
        length: trunkH,
        topRadius: t.crown * 0.1,
        bottomRadius: t.crown * 0.16,
        material: Cesium.Color.fromCssColorString('#4a3b2a'),
        outline: false
      }
    })

    // 树冠：针叶用叠锥（塔形），阔叶用扁球
    if (t.kind === 'conifer') {
      entities.add({
        id: `tree-${i}-crown`,
        name: '树冠',
        position: pos(trunkH + (t.height - trunkH) / 2),
        cylinder: {
          length: t.height - trunkH,
          topRadius: 0,
          bottomRadius: t.crown,
          material: t.color,
          outline: false
        }
      })
    } else {
      entities.add({
        id: `tree-${i}-crown`,
        name: '树冠',
        position: pos(trunkH + t.crown * 0.8),
        ellipsoid: {
          radii: new Cesium.Cartesian3(t.crown, t.crown, t.crown * 0.86),
          material: t.color
        }
      })
    }
  })

  // ---- 底图裁剪：把模型自己就是地表的那几块地挖掉 ----
  // 必须最后做：采坑、台地都已经把边界登记进来（见 `terrainClip`）
  installTerrainClip(viewer)
}
