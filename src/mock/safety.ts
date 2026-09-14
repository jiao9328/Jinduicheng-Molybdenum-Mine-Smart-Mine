/**
 * 安全管理页 Mock 数据
 * 数值与参考截图「1.安全管理.jpg」「安全分析系统」面板一致。
 */

/** 安全监控实时数据 —— 两个大数字 */
export const safetyRealtime = {
  updateTime: '2023/05/30 22:01',
  majorRisks: 2,
  existingRisks: 5
}

/** 存在安全风险项列表 —— 表格 */
export type RiskLevel = '低' | '中' | '高'

export interface RiskItem {
  id: number
  /** 监测点 */
  point: string
  /** 监控类型 */
  type: string
  /** 安全等级 */
  level: RiskLevel
  /** 告警详情 */
  detail: string
}

export const riskList: RiskItem[] = [
  { id: 1, point: '监测点1', type: '重点区域监控', level: '低', detail: '监测到异常人员' },
  { id: 2, point: '监测点2', type: '边坡稳定监控', level: '低', detail: '边坡位移' },
  { id: 3, point: '监测点3', type: '重点区域监控', level: '低', detail: '监测到异常人员' },
  { id: 4, point: '监测点4', type: '厂区沉降监控', level: '中', detail: '沉降速率超阈值' },
  { id: 5, point: '监测点5', type: '地压监测', level: '中', detail: '应力集中异常' }
]

/**
 * 存在安全风险趋势分析 —— 1~6 月分组柱状。
 *
 * 指导文档 4.1 与参考图都是「1~6 月、三组分类并排」：
 * 每组一条曲线，所以这里存的是三组各自的月度数量，而不是一条总量曲线。
 * 「边坡稳定」那一组沿用参考图里最高的那条曲线（3 月 4.9 起，全年高点）；
 * 另外两组只按它们在参考图里与最高那条的相对高低估读，没有逐柱标定。
 */
export const riskTrend = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月'],
  series: [
    { name: '边坡稳定', data: [2.83, 2.17, 4.9, 1.5, 2.1, 1.0] },
    { name: '重点区域', data: [1.9, 1.5, 3.2, 1.1, 1.6, 0.8] },
    { name: '厂区沉降', data: [1.2, 0.9, 1.8, 0.7, 0.9, 0.5] }
  ],
  unit: '起'
}

/** 本周存在安全风险项类型分布 —— 环形图 */
export const riskTypeDistribution = [
  { name: '边坡稳定', value: 45, color: '#ff4d4f' },
  { name: '重点区域', value: 33, color: '#ff9f1c' },
  { name: '厂区沉降', value: 22, color: '#ffd60a' }
]

/**
 * 三维场景中的安全标注点。
 *
 * **这里没有高度字段，是刻意的。** 标注的高度不写死在数据里，
 * 而是由 `safetyLayer.ts` 在运行时从三维底座采样地面高程，
 * 再按几何关系抬起。
 *
 * 原因：项目先后用过三种底座（离线 DEM 地形 / Google 实景三维 / 程序化场景），
 * 各自的地面标高并不相同；任何写死的绝对高度在其中一种下都必然是错的
 *（旧代码就在离线 DEM 上写着 100~120，接上真实地形后整片埋进了山里）。
 */
export interface SafetyMarker {
  id: string
  name: string
  lon: number
  lat: number
  /** 风险等级，决定标注颜色 */
  level: RiskLevel
  /** 是否显示风险范围圆圈 */
  circle?: { radius: number; color: string; label: string }
}

import { BUILDINGS, plantPt } from '@/scene/mineLayout'

/**
 * 按名字取厂房经纬度。
 *
 * **找不到就抛，不要写 `!`。** 厂区搬进山谷时「选矿主厂房」改名成了「磨浮主厂房」，
 * `find(...)!` 会悄悄变成 `undefined`，紧接着 `.lon` 在**模块求值期**抛错、整个
 * bundle 跑不起来（全站白屏、CSS 正常、控制台只有一行读属性失败）。
 * 抛一句带名字的错，至少把「哪个名字对不上」直接写出来。
 */
function named(name: string): { lon: number; lat: number } {
  const b = BUILDINGS.find((x) => x.name === name)
  if (!b) throw new Error(`safety.ts: mineLayout 里没有名为「${name}」的厂房`)
  return b
}

/** 厂区局部坐标 (x, y) → `{ lon, lat }` */
const at = (x: number, y: number) => {
  const [lon, lat] = plantPt(x, y)
  return { lon, lat }
}

/**
 * 位置与 `buildMineScene.ts` 里的地物一一对应。
 *
 * 采坑、边坡、排土场是**真实地物**，坐标实测，直接写。
 * ⚠️ **厂区那四条不能手写经纬度**——厂区搬过一次家（旧谷 → 使用者拾取的新谷，
 * 见 `mineLayout` 的厂址一节），手抄的坐标会留在旧谷里，标记照常渲染、
 * 不报任何错，只是在一条已经没有厂区的沟上方飘着几个「厂区沉降点」。
 * 所以一律从 `mineLayout` 按名字取，厂区再搬它自己会跟着走。
 * （`src/mock/emergency.ts` 是同一套做法。）
 */
export const safetyMarkers: SafetyMarker[] = [
  {
    id: 'abnormal-person',
    name: '重点区域',
    lon: 109.9530,
    lat: 34.3320,
    level: '高',
    circle: { radius: 180, color: '#ff4d4f', label: '监测到异常人员 2023-07-25 12:00' }
  },
  { id: 'slope', name: '边坡监测点', lon: 109.9592, lat: 34.3312, level: '中' },
  // 沉降点取 T3 磨浮台地西侧空地（局部坐标 (60, -180)）：监测点通常布在平台空地上，不压厂房
  { id: 'subsidence', name: '厂区沉降点', ...at(60, -180), level: '低' },
  { id: 'transfer', name: '粗碎站', ...named('粗碎站'), level: '低' },
  { id: 'warehouse', name: '精矿库', ...named('精矿库'), level: '低' },
  { id: 'dump', name: '排土场', lon: 109.9436, lat: 34.3316, level: '低' },
  { id: 'plant', name: '厂区设备', ...named('磨浮主厂房'), level: '低' }
]

/** 安全培训与资质 —— 对应指导文档 4.2「在线安全培训与 VR 事故体验」「特种作业人员资质管理」 */
export interface SafetyTraining {
  /** 本月 VR 事故体验场次 */
  vrSessions: number
  /** 在线安全课程门数 */
  onlineCourses: number
  /** 持证作业人员 */
  certifiedWorkers: number
  /** 无证上岗告警人数 */
  uncertified: number
}

export const safetyTraining: SafetyTraining = {
  vrSessions: 12,
  onlineCourses: 26,
  certifiedWorkers: 218,
  uncertified: 3
}

/** 隐患整改闭环统计 —— 对应指导文档 4.2「隐患上报、整改工单派发、闭环跟踪」，四个环节依次收窄 */
export interface HazardClosedLoop {
  /** 上报 */
  reported: number
  /** 派单 */
  assigned: number
  /** 整改完成 */
  rectified: number
  /** 复核验收 */
  verified: number
}

export const hazardClosedLoop: HazardClosedLoop = {
  reported: 48,
  assigned: 46,
  rectified: 41,
  verified: 39
}
