/**
 * 生产管理页 Mock 数据
 * 顶部指标卡数值与参考截图「2.生产管理.jpg」一致。
 */

/** 顶部 5 张指标卡 */
export interface ProductionMetric {
  label: string
  value: number
  unit: string
  decimals?: number
  chain: number
  yoy: number
  color: string
}

export const productionMetrics: ProductionMetric[] = [
  { label: '今日生产量', value: 27.8, unit: '吨', decimals: 1, chain: -2.1, yoy: 2.26, color: '#00e5ff' },
  { label: '生产车数', value: 12, unit: '万元', chain: -2.1, yoy: 2.26, color: '#1890ff' },
  { label: '检验率', value: 93, unit: '%', chain: -2.1, yoy: 2.26, color: '#00ff9d' },
  { label: '合格率', value: 90.2, unit: '%', decimals: 1, chain: -2.1, yoy: 2.26, color: '#ffd60a' },
  { label: '补修率', value: 98.82, unit: '万元', decimals: 2, chain: -2.1, yoy: 2.26, color: '#ff9f1c' }
]

/** 质量活动 —— 2019~2023 分组柱状 */
export const qualityActivity = {
  years: ['2019', '2020', '2021', '2022', '2023'],
  series: [
    { name: '质量检验', data: [1200, 1680, 1450, 2100, 2480] },
    { name: '质量改进', data: [860, 1020, 1180, 1420, 1660] },
    { name: '质量培训', data: [420, 560, 640, 780, 920] }
  ]
}

/** 质检记录 —— 表格 */
export interface QualityRecord {
  id: number
  time: string
  /** 质检异常情况 */
  issue: string
  /** 处理措施 */
  action: string
  /** 负责人（脱敏） */
  owner: string
}

export const qualityRecords: QualityRecord[] = [
  { id: 1, time: '2023-6-26 16:57', issue: '无异常', action: '—', owner: '何**' },
  { id: 2, time: '2023-6-26 14:20', issue: '无异常', action: '—', owner: '何**' },
  { id: 3, time: '2023-6-26 11:05', issue: '粒度偏粗', action: '调整破碎间隙', owner: '李**' },
  { id: 4, time: '2023-6-26 09:42', issue: '无异常', action: '—', owner: '王**' },
  { id: 5, time: '2023-6-25 21:18', issue: '含水率偏高', action: '延长脱水时间', owner: '张**' },
  { id: 6, time: '2023-6-25 18:36', issue: '无异常', action: '—', owner: '何**' }
]

/** 今日生产类型分布 —— 彩色饼图 */
export const productionTypeDistribution = [
  { name: '类型1', value: 18, color: '#ff4d4f' },
  { name: '类型2', value: 16, color: '#ff9f1c' },
  { name: '类型3', value: 15, color: '#ffd60a' },
  { name: '类型4', value: 14, color: '#00ff9d' },
  { name: '类型5', value: 12, color: '#00e5ff' },
  { name: '类型6', value: 10, color: '#1890ff' },
  { name: '类型7', value: 8, color: '#b388ff' },
  { name: '类型8', value: 7, color: '#ff7ab6' }
]

/** 生产量趋势 —— 柱状 + 同比折线双轴 */
export const outputTrend = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月'],
  /** 左轴：日产量（吨） */
  output: [420, 380, 560, 640, 520, 610],
  /** 右轴：同比（%） */
  yoy: [-12, -33, 18, 90, -53, 24]
}

/** 年度生产数据 —— 日历热力图，12 个月 × 每日 */
export const annualHeatmap = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  days: 31,
  /** 值域 0~10000，用于色阶映射 */
  max: 10000,
  /** 用确定性伪随机生成，保证每次渲染一致 */
  values: (() => {
    const data: [number, number, number][] = []
    for (let m = 0; m < 12; m++) {
      const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m]
      for (let d = 0; d < daysInMonth; d++) {
        // 季节性 + 伪随机扰动，夏季产量高
        const seasonal = 0.55 + 0.4 * Math.sin(((m - 2) / 12) * Math.PI * 2)
        const noise = (Math.sin(m * 12.9898 + d * 78.233) * 43758.5453) % 1
        const value = Math.max(0, Math.min(1, seasonal * 0.7 + Math.abs(noise) * 0.5))
        data.push([d, m, Math.round(value * 10000)])
      }
    }
    return data
  })()
}

/** 掘进进尺与计划对比 */
export const drillingProgress = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月'],
  plan: [1200, 1300, 1400, 1500, 1500, 1600],
  actual: [1180, 1280, 1420, 1460, 1520, 1580]
}

/** 调度值班 */
export const dutySchedule = [
  { shift: '早班', time: '08:00-16:00', leader: '赵**', crew: '掘进一队', status: '在岗' },
  { shift: '中班', time: '16:00-00:00', leader: '钱**', crew: '采煤二队', status: '在岗' },
  { shift: '夜班', time: '00:00-08:00', leader: '孙**', crew: '运输队', status: '交接中' }
]
