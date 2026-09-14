/**
 * 数字孪生页 Mock 数据 —— 对应《项目文档》「数字孪生」模块与指导文档 §8.2。
 *
 * 四条能力里三条有数据：
 *   §8.2-2 设备定位与作业效率 —— twinDevices
 *   §8.2-3 三类安全风险四色分布 —— twinRiskZones + TWIN_RISK_LEVELS
 *   §8.2-4 边坡位移监测与动态模拟 —— twinSlopeSites + twinSlopeTrend
 *
 * §8.2-1「地质模型自动更新」**没有数据，也不装作有**。这条要后端地质建模服务
 * 持续反演，前端没有任何可展示的真实内容；放一个空数组或假进度条只会让评审
 * 以为它做完了。页面改为在三维区打一条静态说明如实写「未接入」。
 *
 * ---------------------------------------------------------------------------
 * 两条硬约束（都踩过坑）
 * ---------------------------------------------------------------------------
 * ⚠️ 一、坐标只写「以采坑中心为原点的米制偏移」eastM / northM，**不写经纬度**。
 *   坑内的东西只有这一种表达是稳的：采坑中心是按离线影像 + DEM 实测校正过的
 *   （见 scene/mineLayout.ts），硬写经纬度会在采坑一改之后整片偏到坑外面去，
 *   而且不报错——三维场景照建，只是所有点位莫名其妙地落在坑外。
 *   转经纬度是三维图层的事（pitOffset），数据层不碰坐标系。
 *
 * ⚠️ 二、**没有高程字段**。点位高度一律由 twinLayer 运行时从三维底座采样。
 *   理由与 mock/safety.ts 里那段相同：项目先后用过三种底座（离线 DEM 地形 /
 *   在线实景三维 / 程序化场景），各自的地面标高差别很大，任何写死的绝对高度
 *   在其中一种下必然是错的——那边就写死过一次 100~120，接上真实地形后
 *   整片埋进山里。
 *
 * ---------------------------------------------------------------------------
 * 一条防错设计：能算的不要存
 * ---------------------------------------------------------------------------
 * 三类风险的四色**计数不在本文件里存**，由 twinRiskZones 现算（见 DigitalTwinView），
 * 边坡状态也由 `slopeStatus()` 从累计位移现推。存一份就等于同一件事有两个说法：
 * 改了源数据忘了改汇总，面板和三维就会对不上，而两边单独看都「正常」。
 * 同类问题本项目已经出过一次——emergency.ts 顶部注释自称数值与参考图一致，
 * 实际 45.45 与文档写的 43.46 对不上，且没人发现。
 */

// ---------------------------------------------------------------------------
// §8.2-2 设备定位与作业效率
// ---------------------------------------------------------------------------

/** 设备类型。文档点名的是这三种 */
export type TwinDeviceKind = '钻机' | '卡车' | '铲车'

/** 设备状态。检修是离线检修，不是「掉线」，所以与待机区分开 */
export type TwinDeviceStatus = '作业中' | '待机' | '检修'

export interface TwinDevice {
  id: string
  name: string
  kind: TwinDeviceKind
  /** 相对采坑中心的东向偏移（米），正值向东 */
  eastM: number
  /** 相对采坑中心的北向偏移（米），正值向北 */
  northM: number
  /** 所在位置，写人话不写坐标——面板表格里的「位置」列 */
  area: string
  status: TwinDeviceStatus
  /** 当班作业效率（%） */
  efficiency: number
  /** 最近一次定位上报，演示用的相对时间 */
  lastReport: string
}

/**
 * 采场内 8 台主要移动设备。
 *
 * 位置全部落在采坑椭圆内（东西半轴 365m、南北半轴 315m），并按「钻机在台阶面、
 * 卡车在运输道、铲车在装载点」分配，与三维场景里画出来的采剥台阶对得上。
 * 这些是**示意性摆放**，不是实测 GPS——设备位置本来就是实时上报的，
 * 静态看板里给一组形态合理的数据即可。
 */
export const twinDevices: TwinDevice[] = [
  { id: 'DR-01', name: '1# 牙轮钻机', kind: '钻机', eastM: -150, northM: 150, area: '北帮 3 台阶', status: '作业中', efficiency: 92, lastReport: '2 秒前' },
  { id: 'DR-02', name: '2# 牙轮钻机', kind: '钻机', eastM: -62, northM: 205, area: '北帮 5 台阶', status: '作业中', efficiency: 88, lastReport: '4 秒前' },
  { id: 'DR-03', name: '3# 牙轮钻机', kind: '钻机', eastM: 34, northM: 172, area: '北帮 4 台阶', status: '检修', efficiency: 0, lastReport: '3 分钟前' },
  { id: 'TR-11', name: '1# 矿用卡车', kind: '卡车', eastM: -8, northM: -124, area: '南帮运输道', status: '作业中', efficiency: 95, lastReport: '1 秒前' },
  { id: 'TR-12', name: '2# 矿用卡车', kind: '卡车', eastM: 66, northM: -46, area: '东帮运输道', status: '作业中', efficiency: 91, lastReport: '1 秒前' },
  { id: 'TR-13', name: '3# 矿用卡车', kind: '卡车', eastM: 138, northM: 58, area: '东帮运输道', status: '待机', efficiency: 46, lastReport: '58 秒前' },
  { id: 'LD-21', name: '1# 前装机', kind: '铲车', eastM: -178, northM: 84, area: '北帮装载点', status: '作业中', efficiency: 84, lastReport: '3 秒前' },
  { id: 'LD-22', name: '2# 前装机', kind: '铲车', eastM: 92, northM: 128, area: '北帮装载点', status: '待机', efficiency: 52, lastReport: '2 分钟前' }
]

/** 设备状态色 —— 三维点位与面板状态列共用，避免两处各写一份色值 */
export const TWIN_DEVICE_STATUS_COLORS: Record<TwinDeviceStatus, string> = {
  作业中: '#00ff9d',
  待机: '#ffd60a',
  检修: '#7a8b99'
}

// ---------------------------------------------------------------------------
// §8.2-3 三类安全风险四色分布
// ---------------------------------------------------------------------------

/**
 * 四色分级：红 → 橙 → 黄 → 蓝，由重到轻。
 * 三维风险圆与面板图表共用这一份，顺序即严重度降序。
 */
export const TWIN_RISK_LEVELS = [
  { level: '重大', color: '#ff4d4f' },
  { level: '较大', color: '#ff9f1c' },
  { level: '一般', color: '#ffd60a' },
  { level: '低', color: '#1890ff' }
] as const

export type TwinRiskLevel = (typeof TWIN_RISK_LEVELS)[number]['level']

/** 三类安全风险。与《项目文档》「边坡 / 爆破 / 运输」三条对应 */
export type TwinRiskCategory = '边坡' | '爆破' | '运输'

export interface TwinRiskZone {
  id: string
  name: string
  category: TwinRiskCategory
  level: TwinRiskLevel
  eastM: number
  northM: number
  /** 风险区半径（米） */
  radius: number
  /** 主要风险描述，面板列里显示 */
  detail: string
}

/**
 * 风险区布点沿采坑**边坡与运输道口**展开——风险本来就集中在帮坡和道路交汇处，
 * 铺在坑底反而看不出「分布」。半径按大屏可读性取 62~105m，属于判读值。
 *
 * 相邻风险区**允许重叠**（比如北帮边坡压住北帮爆破区一角），这是真实情况，
 * 不必为了画面上圆与圆不相交去挪位置。
 */
export const twinRiskZones: TwinRiskZone[] = [
  { id: 'RZ-01', name: '北帮边坡', category: '边坡', level: '重大', eastM: 0, northM: 258, radius: 105, detail: '台阶面见张拉裂缝，SL-01 累计位移超阈值' },
  { id: 'RZ-02', name: '东帮边坡', category: '边坡', level: '重大', eastM: 298, northM: -22, radius: 95, detail: '东帮 5 台阶局部剥落，位移速率上升' },
  { id: 'RZ-03', name: '南帮边坡', category: '边坡', level: '一般', eastM: -26, northM: -257, radius: 90, detail: '南帮帮坡角偏陡，雨季需加密观测' },
  { id: 'RZ-04', name: '西帮爆破区', category: '爆破', level: '较大', eastM: -294, northM: 45, radius: 80, detail: '临近西帮运输道，需控制单响药量' },
  { id: 'RZ-05', name: '北帮爆破区', category: '爆破', level: '较大', eastM: -150, northM: 223, radius: 72, detail: '距选矿厂区较近，爆破振动需监测' },
  { id: 'RZ-06', name: '东帮运输道口', category: '运输', level: '一般', eastM: 218, northM: -128, radius: 76, detail: '重车下坡汇入点，需限速与分流' },
  { id: 'RZ-07', name: '南帮运输道', category: '运输', level: '低', eastM: -172, northM: -211, radius: 62, detail: '道路平整度良好，常规巡检' }
]

// ---------------------------------------------------------------------------
// §8.2-4 边坡位移监测与动态模拟
// ---------------------------------------------------------------------------

/** 边坡位移统一预警阈值（mm）。报警取 1.0 倍，预警取 0.7 倍 */
export const TWIN_SLOPE_THRESHOLD = 20

export type TwinSlopeStatus = '报警' | '预警' | '正常'

/**
 * 由累计位移推状态 —— **不存进数据里**。
 *
 * 三维点位配色与面板状态列共用这一个函数，两边不可能对不上。
 * 存一个 status 字段的话，改了 displacement 忘了改 status，三维红着、
 * 面板写着「正常」，而且两处各自看都「正常」。
 */
export function slopeStatus(displacement: number): TwinSlopeStatus {
  if (displacement >= TWIN_SLOPE_THRESHOLD) return '报警'
  if (displacement >= TWIN_SLOPE_THRESHOLD * 0.7) return '预警'
  return '正常'
}

/** 状态色（三维与面板共用） */
export const TWIN_SLOPE_STATUS_COLORS: Record<TwinSlopeStatus, string> = {
  报警: '#ff4d4f',
  预警: '#ff9f1c',
  正常: '#00ff9d'
}

/**
 * 位移量的**显示放大倍数**。
 *
 * 累计位移是毫米级的（最大 26.4mm ≈ 2.6cm），照原尺寸画在大屏上等于没动。
 * ×200 之后 26.4mm 显示成 5.3m，一眼能看出「往哪个方向滑」。
 *
 * ⚠️ 这个倍数**必须写在面板上**。不写的话，看图的人会把屏幕上的几米
 * 当成真实位移，那比不放大更糟——放大是为了看得见，不是为了让人误读。
 */
export const TWIN_SLOPE_EXAGGERATION = 200

export interface TwinSlopeSite {
  id: string
  name: string
  eastM: number
  northM: number
  /** 累计位移（mm） */
  displacement: number
  /** 位移速率（mm/d） */
  rate: number
  /** 位移主方向（度，0 为正北，顺时针增大）—— 动态模拟沿此方向滑动 */
  azimuth: number
}

/**
 * 5 个边坡位移监测站。位置取自采坑四周的帮坡台阶，与上面 RZ-01/02/03 三个边坡
 * 风险区同处一片坡面（风险区是结论，监测点是依据，两者本就该挨着）。
 */
export const twinSlopeSites: TwinSlopeSite[] = [
  { id: 'SL-01', name: '北帮 3 台阶', eastM: 0, northM: 258, displacement: 26.4, rate: 1.8, azimuth: 175 },
  { id: 'SL-02', name: '东帮 5 台阶', eastM: 298, northM: -22, displacement: 15.2, rate: 0.9, azimuth: 250 },
  { id: 'SL-03', name: '南帮 2 台阶', eastM: -26, northM: -257, displacement: 8.6, rate: 0.4, azimuth: 5 },
  { id: 'SL-04', name: '西帮 4 台阶', eastM: -294, northM: 45, displacement: 19.1, rate: 1.4, azimuth: 95 },
  { id: 'SL-05', name: '北帮 6 台阶', eastM: -150, northM: 223, displacement: 4.2, rate: 0.2, azimuth: 205 }
]

/**
 * 累计位移趋势（mm）—— 只列了 3 个位移较大的站，图上三条线好读。
 *
 * ⚠️ **每条的最后一个值必须等于 `twinSlopeSites` 里同名站的 `displacement`。**
 * 两者是同一件事的「趋势」与「当前值」两种说法，对不上就是数字自相矛盾。
 * 改任何一边都要同时改另一边——本项目的检查脚本会断言这一条。
 */
export const twinSlopeTrend = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月'],
  series: [
    { name: 'SL-01', data: [14.2, 16.8, 19.1, 21.6, 24.0, 26.4] },
    { name: 'SL-04', data: [11.6, 13.2, 14.9, 16.4, 17.8, 19.1] },
    { name: 'SL-02', data: [10.1, 11.0, 12.2, 13.4, 14.3, 15.2] }
  ],
  unit: 'mm'
}
