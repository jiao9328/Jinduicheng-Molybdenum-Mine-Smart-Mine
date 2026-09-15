import * as Cesium from 'cesium'
import { MINE_ELEVATION } from '../sceneConfig'
import { sampleGroundHeights } from '../localTerrain'

/**
 * 区域标注图层 —— 「把一排数放回它发生的地方」。
 *
 * 成本管理页用它标成本归属地（钱花在哪片区域），统计报表页用它标区域统计
 * （哪个区域的数是多少）。两页要的**几何完全一样**：方块点 + 「名字 / 副行」
 * 两行标签。所以只有这一个图层文件，页面各传各的 `prefix` 与数据 ——
 * 两个页面各写一份同款绘制代码正是本项目零容忍的那种重复
 * （渲染参数一旦要调，两处必然只改一处）。
 *
 * ⚠️ 本文件**只管画**，不管「这些点是怎么来的」。
 * 谁都不是从区域数据里读到的经纬度：成本页的归属地由实测设备点位推导 +
 * 展示口径兜底（见 CostView 里 `COST_SITES` 那一段），统计报表页直接用
 * `AREA_ANCHORS` 里既有的地名表。**这些口径由页面负责如实告诉用户**，
 * 图层不猜也不编。
 *
 * 本文件是**纯图层**：不 import 任何 `@/mock/*` 或 `@/api/*` 的数据，
 * 点位由页面算好传进来（`src/scene/` 下所有文件的共同规矩）。
 */

/** 标注点位抬升（米）。与 twinLayer 的 DEVICE_LIFT 同一量级 */
const MARK_LIFT = 16

/** 标注统一样式，与 twinLayer / safetyLayer / emergencyLayer 保持一致 */
const LABEL_FONT = '11px PingFang SC, Microsoft YaHei, sans-serif'
const LABEL_FILL = Cesium.Color.fromCssColorString('#e8f4ff')

/** 一个区域标注 */
export interface AreaMark {
  /** 业务键 —— 页面据此做「点标注 ↔ 面板条目」的双向映射 */
  key: string
  /** 标注标题，如「采坑（北帮）」 */
  name: string
  /** 标注副行，如「128.6 元/吨」 */
  caption: string
  lon: number
  lat: number
  color: string
}

/**
 * 建区域标注层：彩色方块点 + 「区域 + 数值」标签。
 *
 * 高度照旧**一律采样**（`sampleGroundHeights`），不写绝对高度 ——
 * 理由见 mock/digitalTwin.ts 顶部：写死绝对高度在换底座时必然整片埋进山里，
 * 而且不报错。设备点位与厂区锚点可能落在建筑/台阶上，采样加抬升最稳。
 *
 * @param prefix 实体 id 前缀，**必须与 `sceneTargets.PREFIXES` 里的一条对得上**，
 *               否则页面拾取时解析不出业务键（那种失效不报错，只表现为点了没反应）
 */
export async function buildAreaMarkLayer(
  viewer: Cesium.Viewer,
  marks: AreaMark[],
  options: { prefix: string }
): Promise<Cesium.Entity[]> {
  const ground = await sampleGroundHeights(
    marks.map((m) => ({ key: m.key, lon: m.lon, lat: m.lat })),
    MINE_ELEVATION
  )

  return marks.map((m) => {
    const color = Cesium.Color.fromCssColorString(m.color)

    return viewer.entities.add({
      id: `${options.prefix}-${m.key}`,
      name: `${m.name} · ${m.caption}`,
      position: Cesium.Cartesian3.fromDegrees(
        m.lon,
        m.lat,
        (ground[m.key] ?? MINE_ELEVATION) + MARK_LIFT
      ),
      point: {
        pixelSize: 11,
        // 方块点：区域标注说的是「一片区域」，形状上与设备圆点区分开，
        // 一眼能看出这两层说的不是一回事
        color,
        outlineColor: Cesium.Color.fromCssColorString('#ffffff'),
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        // 换行不用空格：几个标注并列时，「名字」和「数值」这行小字
        // 得分成两行才读得出层级，挤成一行会糊成一串
        text: `${m.name}\n${m.caption}`,
        font: LABEL_FONT,
        fillColor: LABEL_FILL,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0b2136').withAlpha(0.82),
        backgroundPadding: new Cesium.Cartesian2(5, 3),
        pixelOffset: new Cesium.Cartesian2(0, -20),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // 标签订得太远会糊成一片，按距离缩一档
        scaleByDistance: new Cesium.NearFarScalar(300, 1.0, 3000, 0.6)
      }
    })
  })
}
