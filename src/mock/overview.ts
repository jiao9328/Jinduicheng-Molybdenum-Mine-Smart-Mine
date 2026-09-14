/**
 * 综合管控平台 Mock 数据
 * 数值取自参考截图与开发指导文档第 3 节。
 */

/** 顶栏天气 */
export interface WeatherInfo {
  /** 天气现象，如「小雨转小雨」 */
  text: string
  /** 温度区间，如「37°/28°」 */
  temp: string
}

export const weather: WeatherInfo = {
  text: '小雨转小雨',
  temp: '37°/28°'
}

/** 采区人员分布 —— 环形图 */
export const personnelDistribution = {
  total: 290,
  items: [
    { name: '采矿区', value: 68, color: '#00ff9d' },
    { name: '选矿区', value: 52, color: '#1890ff' },
    { name: '运输区', value: 44, color: '#ff9f1c' },
    { name: '设备维修区', value: 36, color: '#b388ff' },
    { name: '生活区', value: 30, color: '#ff7ab6' },
    { name: '办公区', value: 24, color: '#00e5ff' },
    { name: '仓储区', value: 20, color: '#ffd60a' },
    { name: '其他', value: 16, color: '#5c7a99' }
  ]
}

/** 重大危险源监控 —— 单点指标卡 */
export const hazardMonitor = [
  { label: '重大危险源', value: 736, unit: '项' },
  { label: '安全率', value: 1, unit: '' },
  { label: '隐患数', value: 0, unit: '项' }
]

/** 产量统计 —— 今日 / 昨日对比面积折线 */
export const outputStatistic = {
  hours: ['0:00', '2:00', '4:00', '6:00', '8:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'],
  today: [12, 18, 15, 26, 34, 41, 38, 52, 61, 58, 66, 72],
  yesterday: [10, 14, 17, 21, 28, 33, 35, 44, 49, 51, 55, 60]
}

/** 成本监控 —— 各月份分组柱状 */
export const costMonitor = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月'],
  series: [
    { name: '材料成本', data: [320, 420, 380, 510, 460, 580] },
    { name: '人工成本', data: [280, 310, 350, 330, 390, 420] },
    { name: '能耗成本', data: [180, 220, 240, 210, 260, 300] }
  ]
}

/** 安全监控 —— 三个环形仪表 */
export const safetyGauges = [
  { label: '安全评分', value: 96, max: 100, unit: '分', color: '#00ff9d' },
  { label: '风险隐患', value: 50, max: 100, unit: '个', color: '#ffd60a' },
  { label: '预警信息', value: 75, max: 100, unit: '个', color: '#ff9f1c' }
]

/** AI 视频监控 —— 2×2 摄像头位 */
export const videoChannels = [
  { id: 1, name: 'A区皮带机', status: 'online' as const },
  { id: 2, name: '破碎站入口', status: 'online' as const },
  { id: 3, name: '主运输道路', status: 'online' as const },
  { id: 4, name: '工业广场', status: 'offline' as const }
]

/** 底部迷你图表 —— 生产单耗控制 */
export const unitConsumption = {
  labels: ['电耗', '水耗', '油耗', '药耗', '钢耗'],
  values: [42, 68, 55, 33, 78]
}

/** 底部迷你图表 —— 大型设备生产 */
export const majorEquipment = {
  labels: ['破碎机', '皮带机', '钻机', '铲车', '卡车'],
  values: [86, 92, 74, 65, 81]
}

/** 底部迷你图表 —— 库存管理 */
export const inventoryStat = {
  labels: ['备件', '炸药', '油料', '钢材', '水泥'],
  values: [320, 180, 260, 410, 150]
}
