/**
 * 分析决策页 Mock 数据
 * 顶部指标卡数值与参考截图「6.分析决策.jpg」一致。
 */
import { monthlyAccidents } from './emergency'
import { hazardClosedLoop } from './safety'

/** 顶部 5 张成本指标卡 */
export interface CostMetric {
  label: string
  value: number
  unit: string
  decimals?: number
  chain: number
  yoy: number
  color: string
}

export const costMetrics: CostMetric[] = [
  { label: '用水用电成本', value: 27.8, unit: '万元', decimals: 1, chain: -2.1, yoy: 2.26, color: '#00e5ff' },
  { label: '人力成本', value: 429.29, unit: '万元', decimals: 2, chain: -2.1, yoy: 2.26, color: '#1890ff' },
  { label: '易损成本', value: 92.36, unit: '万元', decimals: 2, chain: -2.1, yoy: 2.26, color: '#ff9f1c' },
  { label: '维护成本', value: 24.6, unit: '万元', decimals: 2, chain: -2.1, yoy: 2.26, color: '#ffd60a' },
  { label: '其他业务成本', value: 49.32, unit: '万元', decimals: 2, chain: -2.1, yoy: 2.26, color: '#b388ff' }
]

/** 年度成本对比 —— 2019~2023 分组柱状 */
export const annualCostCompare = {
  years: ['2019', '2020', '2021', '2022', '2023'],
  series: [
    { name: '材料成本', data: [1180, 1420, 1660, 1980, 2240] },
    { name: '人力成本', data: [860, 940, 1080, 1220, 1380] },
    { name: '能耗成本', data: [420, 480, 560, 640, 720] }
  ]
}

/** 前 5 大支出项 —— 表格 */
export interface TopExpense {
  id: number
  item: string
  amount: number
  /** 支出日期 */
  date: string
}

export const topExpenses: TopExpense[] = [
  { id: 1, item: '工资发放', amount: 391, date: '2023-06-10' },
  { id: 2, item: '设备采购', amount: 268, date: '2023-06-08' },
  { id: 3, item: '电费结算', amount: 156, date: '2023-06-05' },
  { id: 4, item: '炸药采购', amount: 118, date: '2023-06-03' },
  { id: 5, item: '备件采购', amount: 86, date: '2023-06-01' }
]

/** 各类型成本分布 —— 彩色饼图 */
export const costDistribution = [
  { name: '类型1', value: 20, color: '#ff4d4f' },
  { name: '类型2', value: 17, color: '#ff9f1c' },
  { name: '类型3', value: 15, color: '#ffd60a' },
  { name: '类型4', value: 13, color: '#00ff9d' },
  { name: '类型5', value: 12, color: '#00e5ff' },
  { name: '类型6', value: 10, color: '#1890ff' },
  { name: '类型7', value: 8, color: '#b388ff' },
  { name: '类型8', value: 5, color: '#ff7ab6' }
]

/** 底部三组月度趋势（均为柱状 + 同比折线双轴） */
export interface MonthlyTrend {
  key: string
  title: string
  months: string[]
  values: number[]
  yoy: number[]
}

export const monthlyTrends: MonthlyTrend[] = [
  {
    key: 'maintenance',
    title: '维护成本月度趋势',
    months: ['1月', '2月', '3月', '4月', '5月', '6月'],
    values: [320, 180, 460, 520, 390, 680],
    yoy: [-18, -42, 12, 36, -25, 102]
  },
  {
    key: 'utility',
    title: '用水用电成本月度趋势',
    months: ['1月', '2月', '3月', '4月', '5月', '6月'],
    values: [280, 240, 350, 500, 420, 380],
    yoy: [8, -14, 26, 243, 52, -9]
  },
  {
    key: 'labor',
    title: '人力成本月度趋势',
    months: ['1月', '2月', '3月', '4月', '5月', '6月'],
    values: [420, 380, 450, 490, 560, 600],
    yoy: [3, -9, 18, 24, 32, 32]
  }
]

/** 效益分析指标 */
export const benefitAnalysis = [
  { label: '投入产出比', value: 1.86, unit: '', trend: 'up' as const },
  { label: '利润率', value: 22.4, unit: '%', trend: 'up' as const },
  { label: '吨成本', value: 128.6, unit: '元/吨', trend: 'down' as const },
  { label: '投资回报周期', value: 4.2, unit: '年', trend: 'down' as const }
]

/** 智能辅助决策建议 —— 由大数据模型产出 */
export const decisionSuggestions = [
  {
    id: 1,
    type: '生产计划优化',
    level: 'high',
    content: '5 号采区品位下降 8%，建议将计划产量下调 5%，转投 3 号采区'
  },
  {
    id: 2,
    type: '设备维保时机',
    level: 'mid',
    content: '破碎一振动趋势上行，建议在 7 日内安排轴承检查，避免非计划停机'
  },
  {
    id: 3,
    type: '库存周转',
    level: 'mid',
    content: '备件库存周转天数升至 62 天，建议暂缓三季度备件采购'
  },
  {
    // 第 4 条原来是「能耗优化」，但《项目文档.docx》§06 列举的四类建议是
    // 「生产计划优化、设备维保时机、库存周转、**定价策略**」——能耗不在其中，
    // 而定价策略一条都没有。前三条已逐条对上，这里改成它。
    id: 4,
    type: '定价策略',
    level: 'low',
    content: '钼精矿现货价环比下行 4.2%，建议将长协销售比例由 60% 提至 75%，锁定当前价位'
  }
]

// =============================================================================
// 下面三组数据供《项目文档.docx》§06 的另外三个维度使用
//   §9.2-1 生产分析：产量趋势 / 设备利用率 / 工序效率 / 损失贫化率
//   §9.2-2 安全分析：隐患类型分布 /「三违」行为统计 / 事故率趋势
//   §9.2-3 成本分析里的能耗与水耗：峰谷平电费 / 水消耗 / 单耗
// 单耗与电价按采矿工程常识取值（吨矿电耗 24.6 kWh/t、峰谷平 1.02/0.65/0.38 元/kWh），
// 与本页成本效益维那 5 张指标卡**不在同一量级**——那 5 个数来自参考截图、
// 甲方要求一字不动。两者永远不在同一屏，改一处会连带动另一维，故如实记录在 README §13。
// =============================================================================

/**
 * 指标卡通用形状 —— 与 `CostMetric` 完全同形，直接复用不另立一份，
 * 免得两个接口字段不一致时页面要写两套渲染逻辑。
 */
export type AnalysisMetric = CostMetric

// ---------- §9.2-1 生产分析 ----------
/** 产量趋势：计划 vs 实际（万吨/月） */
export const productionOutput = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月'],
  plan: [42.0, 43.5, 45.0, 44.0, 45.5, 46.0],
  actual: [41.2, 44.1, 43.6, 45.3, 44.8, 46.9],
  unit: '万吨'
}

/** 设备利用率（%）—— 按设备类别 */
export const equipmentUtilization = [
  { name: '钻机', value: 82.4 },
  { name: '挖掘机', value: 76.8 },
  { name: '矿用卡车', value: 88.1 },
  { name: '破碎机', value: 91.5 },
  { name: '皮带机', value: 94.2 }
]

/** 工序效率：实际作业效率相对设计能力的达成率（%） */
export const processEfficiency = [
  { name: '穿孔', actual: 92, design: 100 },
  { name: '爆破', actual: 88, design: 100 },
  { name: '铲装', actual: 96, design: 100 },
  { name: '运输', actual: 84, design: 100 },
  { name: '破碎', actual: 97, design: 100 }
]

/** 损失贫化率（%）趋势 —— 两个指标都是「越低越好」 */
export const lossDilution = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月'],
  series: [
    { name: '矿石损失率', data: [6.8, 6.2, 5.9, 5.4, 5.1, 4.8] },
    { name: '矿石贫化率', data: [8.2, 8.6, 8.1, 7.6, 7.4, 7.0] }
  ],
  unit: '%'
}

/**
 * 生产分析指标卡（5 张）。
 *
 * **每个值都能由上面的序列算出来，不是另写一套数**（检查脚本逐条核对）：
 *   本月产量   = actual 最后一点
 *   计划完成率 = actual / plan 最后一点
 *   综合利用率 = equipmentUtilization 的平均
 *   损失率/贫化率 = 各自序列的最后一点
 */
export const productionMetrics: AnalysisMetric[] = [
  { label: '本月产量', value: 46.9, unit: '万吨', decimals: 1, chain: 4.69, yoy: 8.31, color: '#00e5ff' },
  { label: '计划完成率', value: 101.96, unit: '%', decimals: 2, chain: 1.96, yoy: 0.84, color: '#00ff9d' },
  { label: '设备综合利用率', value: 86.6, unit: '%', decimals: 1, chain: 1.2, yoy: 2.4, color: '#1890ff' },
  { label: '矿石损失率', value: 4.8, unit: '%', decimals: 1, chain: -5.88, yoy: -12.7, color: '#ffd60a' },
  { label: '矿石贫化率', value: 7.0, unit: '%', decimals: 1, chain: -5.41, yoy: -9.1, color: '#ff9f1c' }
]

// ---------- §9.2-2 安全分析 ----------
/**
 * 隐患类型分布。
 *
 * 类型名取自 `mock/emergency.ts` 的隐患处置列表（**同一份隐患记录**，
 * 不在这里另造一套叫法），各类型件数之和**必须等于**
 * `mock/safety.ts` 里隐患闭环的「上报」数 48 —— 三个页面说的是同一批隐患。
 * 这个等式写进了检查脚本，改一边不改另一边会当场判红。
 */
export const hazardTypeDistribution = [
  { name: '边坡位移超限', value: 16, color: '#ff4d4f' },
  { name: '爆破警戒疏漏', value: 12, color: '#ff9f1c' },
  { name: '运输故障', value: 11, color: '#ffd60a' },
  { name: '坑底积水', value: 9, color: '#00e5ff' }
]

/** 「三违」行为统计：按行为类别 + 按区队，两边总数必须相等（同一批行为两种切法） */
export const violationStats = {
  byType: [
    { name: '违章操作', value: 23 },
    { name: '违反劳动纪律', value: 14 },
    { name: '违章指挥', value: 5 }
  ],
  byTeam: [
    { name: '采矿一队', value: 12 },
    { name: '采矿二队', value: 9 },
    { name: '运输队', value: 8 },
    { name: '爆破队', value: 7 },
    { name: '维修队', value: 6 }
  ],
  /** 本月合计（= 上面两组各自的和，页面不另算） */
  total: 42,
  /** 环比 */
  chain: -12.5,
  unit: '次'
}

/** 在册职工数 —— 千人负伤率的分母，写出来才能被核对 */
export const ACCIDENT_HEADCOUNT = 2400

/**
 * 事故率趋势：事故起数与千人负伤率。
 *
 * 起数**直接引用** `mock/emergency.ts` 的月度事故趋势 —— 不抄一遍数字，
 * 引用才不会随时间漂移（抄的话改了应急页、这里还是老曲线，且没人会发现）。
 * 千人负伤率**由起数算出来**（起数 ÷ 在册职工数 × 1000，保留两位），
 * 也不是另编一条曲线 —— 检查脚本会拿它跟起数逐月核对。
 */
export const accidentTrend = {
  months: monthlyAccidents.months,
  counts: monthlyAccidents.values,
  headcount: ACCIDENT_HEADCOUNT,
  /** 千人负伤率（‰） */
  ratePerThousand: monthlyAccidents.values.map((n) =>
    Number(((n / ACCIDENT_HEADCOUNT) * 1000).toFixed(2))
  )
}

/**
 * 隐患整改率 —— 由 `mock/safety.ts` 的闭环四环节算出（整改完成 ÷ 上报）。
 * 不写死 85.42：写死就会出现「闭环图上写着 41/48，指标卡却写 85.42%」这种
 * 改了源头不改指标卡的分叉。
 */
const HAZARD_RECTIFIED_RATE = Number(
  ((hazardClosedLoop.rectified / hazardClosedLoop.reported) * 100).toFixed(2)
)

/** 安全分析指标卡（5 张，值同样由上面各表算出） */
export const safetyMetrics: AnalysisMetric[] = [
  // 上报数取自 safety.ts 的隐患闭环第一环 —— 与隐患类型分布各类型之和相等
  { label: '本月隐患上报', value: hazardClosedLoop.reported, unit: '项', chain: -8.2, yoy: -14.3, color: '#ff4d4f' },
  { label: '隐患整改率', value: HAZARD_RECTIFIED_RATE, unit: '%', decimals: 2, chain: 3.1, yoy: 5.6, color: '#00ff9d' },
  // 三违取 violationStats.total，两条统计口径的和都是它
  { label: '本月「三违」', value: violationStats.total, unit: '次', chain: -12.5, yoy: -18.4, color: '#ff9f1c' },
  { label: '本月事故起数', value: monthlyAccidents.values[monthlyAccidents.values.length - 1], unit: '起', chain: -50.0, yoy: -66.7, color: '#ffd60a' },
  { label: '千人负伤率', value: accidentTrend.ratePerThousand[accidentTrend.ratePerThousand.length - 1], unit: '‰', decimals: 2, chain: -50.0, yoy: -66.7, color: '#b388ff' }
]

// ---------- §9.2-3 能耗单耗 ----------
/**
 * 峰谷平电费（月度）。
 *
 * 三段电量按峰 26% / 平 43% / 谷 31% 分配，总量由**吨矿电耗 × 月产量**定：
 *   24.6 kWh/t × 46.9 万吨 = 1153.7 万 kWh
 * 电费 = Σ 电量 × 电价，这个等式也写进了检查脚本。
 */
export const tariffUsage = {
  periods: ['峰段', '平段', '谷段'],
  /** 电量（万 kWh） */
  energy: [300.0, 496.1, 357.6],
  /** 电价（元/kWh） */
  price: [1.02, 0.65, 0.38],
  /** 吨矿电耗（kWh/t）—— 与本表总量、生产分析的月产量三者自洽 */
  unitPower: 24.6,
  /** 参照的月产量（万吨），取自生产分析 6 月的实际产量 */
  outputFor: 46.9,
  unit: '万元'
}

/** 能耗构成（万元/月）—— 其中「电力」必须等于峰谷平三段电费之和 */
export const energyMix = [
  { name: '电力', value: 764.4, color: '#00e5ff' },
  { name: '柴油', value: 172.5, color: '#ff9f1c' },
  { name: '水', value: 49.3, color: '#1890ff' },
  { name: '其它', value: 38.2, color: '#5c7a99' }
]

/** 水消耗（万 m³/月）—— 与吨矿水耗 0.42 m³/t 自洽 */
export const waterUsage = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月'],
  values: [20.8, 21.3, 20.5, 19.9, 20.2, 19.7],
  unit: '万m³'
}

/** 单耗趋势（kWh/t 与 m³/t） */
export const unitConsumption = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月'],
  series: [
    { name: '吨矿电耗(kWh/t)', data: [27.1, 26.4, 25.8, 25.3, 24.9, 24.6] },
    { name: '吨矿水耗(m³/t)', data: [0.48, 0.47, 0.45, 0.44, 0.43, 0.42] }
  ]
}

// ---------- 下面几个量都从上面几张表算出来，不另写一遍数字 ----------
const round = (v: number, d: number) => Number(v.toFixed(d))

/** 三段电量合计（万 kWh）——「月用电量」卡片 */
const electricityTotal = round(
  tariffUsage.energy.reduce((s, v) => s + v, 0),
  1
)

/** 三段电费合计（万元）= Σ 电量 × 电价——「月电费」卡片，必须等于能耗构成里的「电力」 */
const tariffTotal = round(
  tariffUsage.energy.reduce((s, kwh, i) => s + kwh * tariffUsage.price[i], 0),
  1
)

/** 峰段电量占比（%） */
const peakShare = round((tariffUsage.energy[0] / electricityTotal) * 100, 1)

/** 吨矿电耗（kWh/t）= 月用电量 ÷ 月产量 —— 与单耗趋势曲线最后一点同值 */
const powerPerTon = round(electricityTotal / tariffUsage.outputFor, 1)

/** 能耗成本合计（万元/月）—— 能耗构成四项之和 */
const energyMixTotal = round(
  energyMix.reduce((s, i) => s + i.value, 0),
  1
)

/**
 * 吨成本的「能耗」项（元/吨）。
 * 万元 ÷ 万吨 = 元/吨，量纲正好抵消，不必再乘 10000。
 */
const energyCostPerTon = round(energyMixTotal / tariffUsage.outputFor, 2)

/** 能耗单耗指标卡（5 张） */
export const energyMetrics: AnalysisMetric[] = [
  { label: '月用电量', value: electricityTotal, unit: '万kWh', decimals: 1, chain: -2.4, yoy: -6.8, color: '#00e5ff' },
  { label: '月电费', value: tariffTotal, unit: '万元', decimals: 1, chain: -1.8, yoy: -5.2, color: '#1890ff' },
  { label: '峰段电量占比', value: peakShare, unit: '%', decimals: 1, chain: -1.1, yoy: -3.4, color: '#ffd60a' },
  { label: '月用水量', value: waterUsage.values[waterUsage.values.length - 1], unit: '万m³', decimals: 1, chain: -2.5, yoy: -7.1, color: '#b388ff' },
  { label: '吨矿电耗', value: powerPerTon, unit: 'kWh/t', decimals: 1, chain: -1.2, yoy: -9.2, color: '#00ff9d' }
]

/**
 * 吨成本拆解（元/吨）——《项目文档.docx》§06「成本分析精准拆解吨成本」。
 *
 * 两条硬约束（检查脚本逐条核对）：
 *   ① 五项之和 == `total` == 128.60，也就是**成本效益维「效益分析」里那个吨成本**，
 *      同一座矿的同一个指标，两个维度不能各写一个数；
 *   ② 「能耗」项 = `energyMix` 合计 ÷ 月产量 = 1024.4 ÷ 46.9 = 21.84 元/吨
 *      （万元 ÷ 万吨 正好得 元/吨，不用换算了）。
 */
export const tonCostBreakdown = {
  items: [
    { name: '材料', value: 45.2, color: '#00e5ff' },
    { name: '人力', value: 41.6, color: '#1890ff' },
    { name: '能耗', value: energyCostPerTon, color: '#ffd60a' },
    { name: '折旧', value: 11.66, color: '#b388ff' },
    { name: '其它', value: 8.3, color: '#5c7a99' }
  ],
  total: 128.6,
  unit: '元/吨'
}

/**
 * 单机月均成本（万元/台·月）——docx §06「单机成本」。
 * 与其它表没有可推导的等式关系（台数、开动率都不在本数据里），
 * 所以它就是一份独立台账，检查脚本只核对「台数与设备管理页的类别对得上」这一条弱约束。
 */
export const machineCost = {
  items: [
    { name: '钻机', value: 8.6, count: 6 },
    { name: '挖掘机', value: 12.4, count: 5 },
    { name: '矿用卡车', value: 9.8, count: 12 },
    { name: '破碎机', value: 6.2, count: 3 },
    { name: '皮带机', value: 3.4, count: 8 }
  ],
  unit: '万元/台·月'
}
