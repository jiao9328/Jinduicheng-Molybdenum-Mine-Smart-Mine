import * as Cesium from 'cesium'
import { MINE_ELEVATION } from '../sceneConfig'
import { sampleGroundHeights } from '../localTerrain'
import { pitOffset } from '../mineLayout'
import {
  TWIN_DEVICE_STATUS_COLORS,
  TWIN_RISK_LEVELS,
  TWIN_SLOPE_EXAGGERATION,
  TWIN_SLOPE_STATUS_COLORS,
  slopeStatus,
  type TwinDevice,
  type TwinRiskZone,
  type TwinSlopeSite
} from '@/api/digitalTwin'

/**
 * 数字孪生页三维图层 —— 对应指导文档 §8.2 的四条能力（三条能建，见下）。
 *
 * 三组图层各自独立，由页面的 `layerGroups` + `entity.show` 机制统一显隐，
 * 与应急救援页同一套（那里已验证过）。
 *
 * **高度一律来自采样**：每个点位都先拿 `sampleGroundHeights` 从三维底座取真实
 * 地面高程，再抬一个固定的 lift。理由见 mock/digitalTwin.ts 顶部那段——
 * 写死绝对高度在换底座时必然错，而且是「整片埋进山里」这种不报错的错。
 *
 * §8.2-1「地质模型自动更新」在这里**没有对应函数**，因为它不是画出来的东西：
 * 要后端地质建模服务持续反演。页面用一条静态说明如实写「未接入」。
 */

/** 设备点位抬升（米）。与 emergencyLayer 的 PERSON_LIFT 同一量级 */
const DEVICE_LIFT = 14
/** 边坡监测点抬升（米） */
const SLOPE_LIFT = 12
/** 风险圈中心的标签抬升（米）。圈本身贴地，标签要浮起来才看得见 */
const RISK_LABEL_LIFT = 26

/** 点标注统一样式（与 safetyLayer / emergencyLayer 保持一致，避免三处字体走偏） */
const LABEL_FONT = '11px PingFang SC, Microsoft YaHei, sans-serif'
const LABEL_FILL = Cesium.Color.fromCssColorString('#e8f4ff')
/** 基准点（未位移时所在位置）的哑色，与「当前点」的鲜亮形成对照 */
const SLOPE_BASE_COLOR = Cesium.Color.fromCssColorString('#5c7a99')

/** 风险等级 → 颜色。四色由 TWIN_RISK_LEVELS 单点定义，这里只做一次索引 */
const RISK_COLOR_OF = new Map<string, Cesium.Color>(
  TWIN_RISK_LEVELS.map((l) => [l.level, Cesium.Color.fromCssColorString(l.color)])
)

// ---------------------------------------------------------------------------
// §8.2-2 设备定位与作业效率
// ---------------------------------------------------------------------------

/**
 * 采场移动设备点位：状态色圆点 + 名称/效率标签。
 *
 * 三维上区分的是**状态**（颜色），不是设备类型：文档要的「钻机/卡车/铲车」
 * 三类在名称与面板表格里写着，而 Cesium 的 `point` 没有形状参数，
 * 硬要按类型区分形状就得上图标资源（每个状态×类型一个 PNG），
 * 收益不抵成本，还会让「什么颜色代表什么」多一层记忆负担。
 *
 * 「在哪」由位置本身回答——点位都落在三维场景里真实画出来的台阶面与运输道上，
 * 每台设备还有一个文字标签指明所在位置（如「北帮 3 台阶」）。
 */
export async function buildTwinDeviceLayer(
  viewer: Cesium.Viewer,
  devices: TwinDevice[]
): Promise<Cesium.Entity[]> {
  const marks = devices.map((d) => {
    const [lon, lat] = pitOffset(d.eastM, d.northM)
    return { key: d.id, lon, lat }
  })
  const ground = await sampleGroundHeights(marks, MINE_ELEVATION)

  return devices.map((d, i) => {
    const { lon, lat } = marks[i]
    const color = Cesium.Color.fromCssColorString(TWIN_DEVICE_STATUS_COLORS[d.status])

    return viewer.entities.add({
      id: `twin-device-${d.id}`,
      name: `${d.name} · ${d.area}`,
      position: Cesium.Cartesian3.fromDegrees(
        lon,
        lat,
        (ground[d.id] ?? MINE_ELEVATION) + DEVICE_LIFT
      ),
      point: {
        pixelSize: 10,
        color,
        outlineColor: Cesium.Color.fromCssColorString('#ffffff'),
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        // 效率写在标签上：文档 §8.2-2 要的「效率」，在三维上一眼就能读到，
        // 不用回面板表格里找
        text: `${d.name} ${d.efficiency}%`,
        font: LABEL_FONT,
        fillColor: LABEL_FILL,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0b2136').withAlpha(0.82),
        backgroundPadding: new Cesium.Cartesian2(5, 3),
        pixelOffset: new Cesium.Cartesian2(0, -20),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(300, 1.0, 3000, 0.6)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// §8.2-3 三类安全风险四色分布
// ---------------------------------------------------------------------------

/**
 * 风险区：贴地铺开的半透明四色圆 + 名称/等级标签。
 *
 * ⚠️ **`ellipse` 实体必须同时给 `position`，否则整块不渲染。**
 * 这不是猜测：Cesium 的 `EllipseGeometryUpdater.prototype._isHidden` 第一句就是
 * `!defined(entity.position) → true`（已核对 CesiumUnminified 源码），
 * 而它**不抛错、不告警**，实体照样能 `entities.getById()` 拿到、
 * `show` 属性也照样可读可写，只是画面上一片都没有。
 * 本仓库 `emergencyLayer.ts` 的定位基站覆盖圈（`station-ring-*`）正是这个写法，
 * 大概率一直没画出来——见 README §13 的记录。
 *
 * 圈**贴地**（`CLAMP_TO_GROUND`）而不是浮在采样高度上：半径上百米的平面圆
 * 在采坑边坡上必然一半埋进山体、一半悬空，贴地才是「覆盖了这片坡面」。
 *
 * 代价是**贴地几何根本没有轮廓**：`GeometryUpdater` 构造函数里
 * `if (outlineEnabled && onTerrain) { oneTimeWarning(...); outlineEnabled = false }`
 * ——轮廓被强制关掉（已核对源码）。所以这里**不写 `outline` / `outlineColor`**：
 * 写了也只是永不生效的死配置，让后来的人以为圈有一圈描边。
 * 四色分级只能靠**填充色**读，这是贴地的必然结果，不是取舍。
 */
export async function buildTwinRiskLayer(
  viewer: Cesium.Viewer,
  zones: TwinRiskZone[]
): Promise<Cesium.Entity[]> {
  const centers = zones.map((z) => {
    const [lon, lat] = pitOffset(z.eastM, z.northM)
    return { key: z.id, lon, lat }
  })
  const ground = await sampleGroundHeights(centers, MINE_ELEVATION)

  const entities: Cesium.Entity[] = []

  for (const [i, z] of zones.entries()) {
    const { lon, lat } = centers[i]
    const color = RISK_COLOR_OF.get(z.level) ?? Cesium.Color.WHITE

    entities.push(
      viewer.entities.add({
        id: `twin-risk-${z.id}`,
        name: `${z.name} · ${z.level}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: {
          semiMajorAxis: z.radius,
          semiMinorAxis: z.radius,
          // 贴地铺开，圈才不会被采坑的台阶面切掉
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          material: color.withAlpha(0.22)
        }
      })
    )

    // 标签单独一个实体：上面那个实体的 position 没有高度（贴地几何用不上），
    // 把 label 挂在它身上的话标签会落在椭球面（海拔 0）上，也就是埋在
    // 采场底下 1300 米——同样是不报错的静默失效。
    entities.push(
      viewer.entities.add({
        id: `twin-risk-label-${z.id}`,
        name: `${z.name}标签`,
        position: Cesium.Cartesian3.fromDegrees(
          lon,
          lat,
          (ground[z.id] ?? MINE_ELEVATION) + RISK_LABEL_LIFT
        ),
        label: {
          text: `${z.name} · ${z.level}`,
          font: LABEL_FONT,
          fillColor: color,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#0b2136').withAlpha(0.85),
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(500, 1.0, 4000, 0.6)
        }
      })
    )
  }

  return entities
}

// ---------------------------------------------------------------------------
// §8.2-4 边坡位移监测与动态模拟
// ---------------------------------------------------------------------------

/** 建好的边坡图层：实体句柄 + 一个把模拟进度推到任意位置的函数 */
export interface TwinSlopeLayer {
  /** 全部实体，交给页面的图层显隐机制统一 show/hide */
  entities: Cesium.Entity[]
  /** 把模拟进度推到 t（0 = 基准位置，1 = 当前实测位移） */
  setProgress(t: number): void
}

/** 每个监测站的三件套与插值端点 */
interface SlopeNode {
  site: TwinSlopeSite
  entity: Cesium.Entity
  base: Cesium.Cartesian3
  end: Cesium.Cartesian3
  /** 上次写进标签的毫米数，用来避免每帧都改 DOM 文本 */
  shownMm: number
}

/**
 * 边坡监测点图层。
 *
 * 每个站画三样：
 *   `slope-base-*`  基准点（哑色小点）—— 位移起算的位置
 *   `slope-trace-*` 基准点→终点的虚线 —— 位移方向，长度就是放大后的位移量
 *   `slope-site-*`  当前点（状态色）+ 实时毫米读数标签 —— 模拟时沿虚线滑动
 *
 * **虚线静态、只有点动**，是个刻意的取舍：Cesium 的点 / 标签走的是
 * `PointVisualizer` / `LabelVisualizer`，这两个是**逐帧读属性**的动态可视化器，
 * 每帧 `setValue` 很便宜；而 `polyline` 走 `GeometryVisualizer`，几何是静态的，
 * 每次属性变化都会**销毁重建一个 Primitive**。60fps 下重建 5 条折线，
 * 在软件渲染的巡检环境里会直接把帧率拖垮。
 * 所以移动的是点，线一次性画满——顺带还多了一个好处：虚线把「要滑到哪」
 * 提前摆在画面上，评审能先看懂再看动画。
 *
 * 状态色取的是**该站实测累计位移**判出来的等级，不随模拟进度变——
 * 动画演的是「这个位移是怎么积累起来的」，不是「滑到一半就没那么严重了」。
 */
export async function buildTwinSlopeLayer(
  viewer: Cesium.Viewer,
  sites: TwinSlopeSite[]
): Promise<TwinSlopeLayer> {
  // 基准点与终点的**地面高度都取基准点那一处**。
  // 放大 200 倍后位移也就几米，两端相距不到 10m，地面高差可忽略；
  // 各采各的反而会让终点相对基准点上下浮动，看着像在飘。
  const marks = sites.map((s) => {
    const [lon, lat] = pitOffset(s.eastM, s.northM)
    return { key: s.id, lon, lat }
  })
  const ground = await sampleGroundHeights(marks, MINE_ELEVATION)

  const nodes: SlopeNode[] = []
  // 显式收集句柄，不去 `viewer.entities.values` 里按 id 前缀捞：
  // 前缀匹配会顺手把别的图层里同前缀的实体也吞进来，而那两个页面
  // 用同一套 `slope-` 命名只是今天还没撞上而已。
  const entities: Cesium.Entity[] = []

  for (const [i, s] of sites.entries()) {
    const { lon, lat } = marks[i]
    const height = (ground[s.id] ?? MINE_ELEVATION) + SLOPE_LIFT

    // 方位角 0 为正北、顺时针增大 ⇒ 东西分量 sin、南北分量 cos
    const dist = (s.displacement / 1000) * TWIN_SLOPE_EXAGGERATION
    const rad = (s.azimuth * Math.PI) / 180
    const [endLon, endLat] = pitOffset(
      s.eastM + dist * Math.sin(rad),
      s.northM + dist * Math.cos(rad)
    )

    const base = Cesium.Cartesian3.fromDegrees(lon, lat, height)
    const end = Cesium.Cartesian3.fromDegrees(endLon, endLat, height)
    const status = slopeStatus(s.displacement)
    const color = Cesium.Color.fromCssColorString(TWIN_SLOPE_STATUS_COLORS[status])

    entities.push(
      viewer.entities.add({
        id: `slope-base-${s.id}`,
        name: `${s.id} 基准位置`,
        position: base.clone(),
        point: {
          pixelSize: 7,
          color: SLOPE_BASE_COLOR,
          outlineColor: Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.6),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      })
    )

    entities.push(
      viewer.entities.add({
        id: `slope-trace-${s.id}`,
        name: `${s.id} 位移方向`,
        polyline: {
          positions: [base.clone(), end.clone()],
          width: 2,
          material: new Cesium.PolylineDashMaterialProperty({
            color: color.withAlpha(0.6),
            dashLength: 12
          })
        }
      })
    )

    const entity = viewer.entities.add({
      id: `slope-site-${s.id}`,
      name: `${s.id} ${s.name}`,
      position: base.clone(),
      point: {
        pixelSize: 11,
        color,
        outlineColor: Cesium.Color.fromCssColorString('#ffffff'),
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        text: `${s.id} 0.0mm`,
        font: LABEL_FONT,
        fillColor: color,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0b2136').withAlpha(0.85),
        backgroundPadding: new Cesium.Cartesian2(5, 3),
        pixelOffset: new Cesium.Cartesian2(0, -20),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(300, 1.0, 3000, 0.6)
      }
    })
    entities.push(entity)

    nodes.push({ site: s, entity, base, end, shownMm: -1 })
  }

  /** 复用一个中间量；setValue 内部会立刻 clone 一份，串行复用是安全的 */
  const scratch = new Cesium.Cartesian3()

  return {
    entities,
    setProgress(t: number) {
      const p = Math.min(1, Math.max(0, t))

      for (const n of nodes) {
        Cesium.Cartesian3.lerp(n.base, n.end, p, scratch)
        ;(n.entity.position as Cesium.ConstantPositionProperty).setValue(scratch)

        const mm = Math.round(n.site.displacement * p * 10) / 10
        if (mm !== n.shownMm) {
          n.shownMm = mm
          ;(n.entity.label!.text as Cesium.ConstantProperty).setValue(
            `${n.site.id} ${mm.toFixed(1)}mm`
          )
        }
      }
    }
  }
}

/** 动态模拟控制器 */
export interface TwinSlopeAnimation {
  /** 从当前位置演到 1（已演完时再点一次＝从头演一遍） */
  play(): void
  pause(): void
  /** 单步推进 1/8 段，手动讲解用 */
  step(): void
  /** 回到基准位置 */
  reset(): void
  /** 当前进度 0~1 的快照。要显示到界面上请用 onProgress 回调 */
  progress(): number
  /** 停掉动画帧。页面 onBeforeUnmount 必须调 */
  dispose(): void
}

/** 演完一整段的时间（毫秒）。3 秒太快看不清滑移，8 秒讲解又会冷场 */
const SLOPE_DURATION = 6000
/** 单步的步数 */
const SLOPE_STEPS = 8

/**
 * 边坡位移动态模拟。
 *
 * 用组件侧的 `requestAnimationFrame` 直接改 `entity.position.setValue()`，
 * **不用 `CallbackProperty`**：后者的生命周期挂在这个实体的属性上，
 * 「谁在什么时候让它动起来、什么时候停」要靠读 Cesium 内部的属性求值过程才知道；
 * 而这里的 rAF 显式持有句柄，一行 `cancelAnimationFrame` 就停得干干净净。
 *
 * 也**不绑 `viewer.clock`**：这是演示节奏，不是世界时间。
 * 挂到时钟上的话，将来有人为了调避灾光带速度去动 `clock.multiplier`
 * （见 createViewer 里那段长注释），会连带把边坡模拟的速度一起改掉，
 * 而改动者根本不知道这里有第二处消费方。
 *
 * 走完自停——不停的话页面切走后还会每帧空跑。
 */
export function createSlopeAnimation(
  viewer: Cesium.Viewer,
  layer: TwinSlopeLayer,
  options: { duration?: number; onProgress?: (t: number) => void } = {}
): TwinSlopeAnimation {
  const duration = options.duration ?? SLOPE_DURATION

  let current = 0
  let raf = 0
  let startedAt = 0
  let fromProgress = 0
  /** 上一次报给界面的两位小数进度，用来把 DOM 刷新压到约 17 次/秒 */
  let reported = -1

  function stop() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  /**
   * 三维点位吃**精确进度**（逐帧平滑），界面只吃**两位小数**的进度。
   * 反过来做的话，进度条每帧重建一次 DOM 文本，6 秒里白跑 360 次。
   */
  function push(t: number, force = false) {
    layer.setProgress(t)
    const rounded = Math.round(t * 100) / 100
    if (force || rounded !== reported) {
      reported = rounded
      options.onProgress?.(rounded)
    }
  }

  function frame(now: number) {
    // 页面切走时 rAF 可能比 Viewer 的销毁晚一帧，销毁后再碰实体会抛错
    if (viewer.isDestroyed()) {
      stop()
      return
    }

    const t = Math.min(1, fromProgress + (now - startedAt) / duration)
    current = t
    push(t)

    if (t >= 1) {
      stop()
      return
    }
    raf = requestAnimationFrame(frame)
  }

  function play() {
    if (viewer.isDestroyed()) return
    stop()
    // 已经演到头的再点一次＝从头演一遍，演示时不用先复位
    if (current >= 1) current = 0
    fromProgress = current
    startedAt = performance.now()
    push(current, true)
    raf = requestAnimationFrame(frame)
  }

  function pause() {
    stop()
  }

  function step() {
    stop()
    current = Math.min(1, current + 1 / SLOPE_STEPS)
    push(current, true)
  }

  function reset() {
    stop()
    current = 0
    push(0, true)
  }

  function dispose() {
    stop()
  }

  return { play, pause, step, reset, progress: () => current, dispose }
}
