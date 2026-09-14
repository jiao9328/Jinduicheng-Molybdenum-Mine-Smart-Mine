/**
 * 设备管理页 Mock 数据
 * 表格与图表数值与参考截图「3.设备管理.jpg」一致。
 *
 * 文件下半部分是 docx §03（设备管理）五条要求的数据：
 *   台账/一机一码 → `deviceArchives`
 *   IoT 四参数 + 多级报警 → `deviceArchives[].iot`
 *   故障诱因分析 → `deviceArchives[].causes` / `.advice`
 *   定制化维护计划与工单 → `maintenanceOrders`
 *   备件全流程与缺货预警 → `spareParts`
 */

/** 顶部 5 张指标卡 */
export interface EquipmentMetric {
  label: string
  value: number
  unit: string
  chain: number
  yoy: number
  color: string
}

export const equipmentMetrics: EquipmentMetric[] = [
  { label: '设备平均诊断分数', value: 96, unit: '分', chain: -2.1, yoy: 2.26, color: '#00e5ff' },
  { label: '设备最高诊断分数', value: 100, unit: '分', chain: -2.1, yoy: 2.26, color: '#00ff9d' },
  { label: '设备最低诊断分数', value: 86, unit: '分', chain: -2.1, yoy: 2.26, color: '#ffd60a' },
  { label: '运行中设备数量', value: 12, unit: '台', chain: -2.1, yoy: 2.26, color: '#1890ff' },
  { label: '设备总数', value: 16, unit: '台', chain: -2.1, yoy: 2.26, color: '#b388ff' }
]

/** 单体设备评分表 */
export interface DeviceScore {
  id: number
  name: string
  /** 评分 */
  score: number
  /** 记录时间 */
  time: string
}

export const deviceScores: DeviceScore[] = [
  { id: 1, name: '破碎一', score: 89, time: '2023-07-26' },
  { id: 2, name: '破碎二', score: 93, time: '2023-07-26' },
  { id: 3, name: '皮带一', score: 90, time: '2023-07-26' },
  { id: 4, name: '皮带二', score: 97, time: '2023-07-26' },
  { id: 5, name: '球磨机', score: 94, time: '2023-07-26' },
  { id: 6, name: '提升机', score: 92, time: '2023-07-26' }
]

/** 设备类别状态趋势预判 —— 1:00~8:00 多折线 */
export const deviceTrend = {
  hours: ['1:00', '2:00', '3:00', '4:00', '5:00', '6:00', '7:00', '8:00'],
  series: [
    { name: '破碎系统', data: [22, 31, 45, 38, 28, 33, 41, 36] },
    { name: '皮带系统', data: [18, 26, 39, 50, 42, 30, 24, 29] },
    { name: '变电系统', data: [30, 24, 19, 26, 35, 44, 38, 31] }
  ]
}

/** 设备状态评分（权重设置）—— 横向条形 */
export const deviceWeights = [
  { name: '破碎系统', value: 20 },
  { name: '变电系统', value: 30 },
  { name: '皮带系统', value: 30 },
  { name: '供水系统', value: 20 }
]

/** 设备状态周内数据图（最高值）—— 星期 × 时刻气泡矩阵 */
export const weeklyBubble = (() => {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const hours = [
    '12a', '1a', '2a', '3a', '4a', '5a', '6a', '7a', '8a', '9a', '10a', '11a',
    '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '10p', '11p'
  ]
  const data: [number, number, number][] = []

  days.forEach((_, di) => {
    hours.forEach((_, hi) => {
      // 白天数值高、夜间低，叠加确定性噪声
      const daytime = hi >= 8 && hi <= 18 ? 1 : 0.35
      const noise = Math.abs((Math.sin(di * 7.13 + hi * 3.71) * 10000) % 1)
      const value = Math.round((daytime * 0.6 + noise * 0.4) * 100)
      data.push([hi, di, value])
    })
  })

  return { days, hours, data }
})()

/** 设备告警 / 维保提醒 */
export interface DeviceAlert {
  device: string
  type: string
  level: string
  time: string
}

export const deviceAlerts: DeviceAlert[] = [
  { device: '破碎一', type: '振动超限', level: '高', time: '07-26 14:20' },
  { device: '皮带二', type: '轴承温度偏高', level: '中', time: '07-26 11:05' },
  { device: '球磨机', type: '润滑油位低', level: '中', time: '07-26 09:42' },
  { device: '提升机', type: '维保到期', level: '低', time: '07-25 17:30' }
]

// ---------------------------------------------------------------------------
// §03-5 备件库存台账
// ---------------------------------------------------------------------------

/**
 * 备件库存（docx：「备件采购、入库、出库、消耗全流程管控，
 * 库存低于阈值时自动触发缺货预警」）。
 *
 * ⚠️ `stock` 必须满足 **入库 − 出库 = 库存**（采购入库、出库消耗、余量）。
 * 这不是随手填的三个数：台账类数据一旦三者对不上，看的人一眼就会发现，
 * 而这类错误在页面上**不报任何错**，只能靠数据本身自洽。
 * 检查脚本对每条都验这个等式。
 *
 * 「是否缺货」**不在这里存**：它是 `stock < minStock` 现算的。
 * 存一个 `low: true` 出来，改了库存忘了改标志，预警就会和数字对不上。
 */
export interface SparePart {
  /** 备件编码 */
  code: string
  name: string
  /** 适用设备 */
  device: string
  /** 累计入库 */
  inbound: number
  /** 累计出库 */
  outbound: number
  /** 当前库存 */
  stock: number
  /** 缺货阈值：库存低于此值即触发预警 */
  minStock: number
  unit: string
}

export const spareParts: SparePart[] = [
  { code: 'SP-1001', name: '颚板', device: '破碎一', inbound: 24, outbound: 18, stock: 6, minStock: 8, unit: '件' },
  { code: 'SP-1002', name: '圆锥衬板', device: '破碎二', inbound: 16, outbound: 11, stock: 5, minStock: 4, unit: '件' },
  { code: 'SP-1003', name: '偏心轴轴承', device: '破碎一', inbound: 10, outbound: 6, stock: 4, minStock: 3, unit: '套' },
  { code: 'SP-2001', name: '输送带', device: '皮带一', inbound: 40, outbound: 31, stock: 9, minStock: 6, unit: '米' },
  { code: 'SP-2002', name: '托辊', device: '皮带二', inbound: 120, outbound: 96, stock: 24, minStock: 20, unit: '个' },
  { code: 'SP-3001', name: '磨机衬板', device: '球磨机', inbound: 32, outbound: 26, stock: 6, minStock: 10, unit: '件' },
  { code: 'SP-4001', name: '钢丝绳', device: '提升机', inbound: 12, outbound: 7, stock: 5, minStock: 3, unit: '根' },
  { code: 'SP-4002', name: '制动闸瓦', device: '提升机', inbound: 20, outbound: 16, stock: 4, minStock: 4, unit: '块' }
]

// ---------------------------------------------------------------------------
// §03-4 维保计划与工单
// ---------------------------------------------------------------------------

/**
 * 维保工单（docx：「根据设备运行时长与状态自动生成定制化维护计划，
 * 到期自动推送工单至维修人员」）。
 *
 * `basis`（生成依据）是本条最有信息量的字段：docx 说的是「根据运行时长与状态」
 * 生成，只写一个「维保到期」等于把这句话丢了。所以每条都写明依据什么生成的。
 */
export interface MaintenanceOrder {
  id: string
  device: string
  /** 维护计划名称 */
  plan: string
  /** 计划到期日 */
  due: string
  /** 工单是否已推送给维修人员 */
  status: '已推送' | '待推送'
  /** 责任人 */
  owner: string
  /** 生成依据：运行时长 / 状态 */
  basis: string
}

export const maintenanceOrders: MaintenanceOrder[] = [
  { id: 'WO-2401', device: '破碎一', plan: '振动超标专项检修', due: '2023-07-27', status: '已推送', owner: '王建国', basis: '振动连续 3 次超预警值' },
  { id: 'WO-2402', device: '球磨机', plan: '润滑油位补加与油质化验', due: '2023-07-27', status: '已推送', owner: '张海涛', basis: '油位低于下限' },
  { id: 'WO-2403', device: '皮带二', plan: '轴承润滑与温控检查', due: '2023-07-28', status: '已推送', owner: '李振华', basis: '累计运行 1 860 小时' },
  { id: 'WO-2404', device: '皮带一', plan: '输送带接头检查', due: '2023-08-01', status: '待推送', owner: '李振华', basis: '累计运行 1 520 小时' },
  { id: 'WO-2405', device: '提升机', plan: '季度定期维保', due: '2023-08-02', status: '待推送', owner: '赵明远', basis: '投运满 90 天' },
  { id: 'WO-2406', device: '破碎二', plan: '衬板磨损量测量', due: '2023-08-05', status: '待推送', owner: '王建国', basis: '衬板累计运行 1 100 小时' }
]

// ---------------------------------------------------------------------------
// §03-1/-2/-3 设备档案（一机一码 + IoT 参数 + 故障诱因）
// ---------------------------------------------------------------------------

/** IoT 运行参数及其**三级阈值**（docx §03-2「多级报警」） */
export interface IotParam {
  key: '温度' | '振动' | '电流' | '油耗'
  value: number
  unit: string
  /** 预警阈值：value ≥ warn 即预警 */
  warn: number
  /** 报警阈值：value ≥ alarm 即报警。必须 > warn */
  alarm: number
}

export interface DeviceArchive {
  /** 与 `deviceScores` 的 name 一一对应（点击评分表的行就是按它查档案） */
  name: string
  /** 一机一码 */
  code: string
  model: string
  category: string
  location: string
  commissioned: string
  /** 图纸/资料清单 */
  drawings: string[]
  /** 备件清单：`code` 必须能在 `spareParts` 里找到 */
  parts: { code: string; name: string; qty: number }[]
  /** 维保记录 */
  records: { date: string; item: string; crew: string }[]
  iot: IotParam[]
  /** 历史故障诱因排序（次数降序）与对应问题部件 */
  causes: { cause: string; count: number; part: string }[]
  /** 维修方案建议 */
  advice: string[]
}

export const deviceArchives: DeviceArchive[] = [
  {
    name: '破碎一',
    code: 'M-0101',
    model: 'PE-900×1200',
    category: '破碎设备',
    location: '破碎站一层',
    commissioned: '2019-04-12',
    drawings: ['总体装配图 PE900-00', '颚板零件图 PE900-01-03', '电气原理图 PE900-EL-02'],
    parts: [
      { code: 'SP-1001', name: '颚板', qty: 2 },
      { code: 'SP-1003', name: '偏心轴轴承', qty: 1 }
    ],
    records: [
      { date: '2023-05-18', item: '颚板更换', crew: '王建国' },
      { date: '2023-03-06', item: '偏心轴轴承润滑', crew: '王建国' },
      { date: '2022-12-21', item: '地脚螺栓复紧', crew: '刘志强' }
    ],
    iot: [
      { key: '温度', value: 62, unit: '℃', warn: 60, alarm: 75 },
      { key: '振动', value: 12.4, unit: 'mm/s', warn: 8, alarm: 11 },
      { key: '电流', value: 148, unit: 'A', warn: 160, alarm: 190 },
      { key: '油耗', value: 3.2, unit: 'L/h', warn: 4, alarm: 5 }
    ],
    causes: [
      { cause: '振动超标', count: 6, part: '偏心轴轴承' },
      { cause: '颚板磨损', count: 4, part: '颚板' },
      { cause: '紧固件松动', count: 2, part: '地脚螺栓' }
    ],
    advice: [
      '更换偏心轴轴承，复测空载振动应 ≤ 8 mm/s',
      '颚板剩余厚度 28mm，低于 30mm 更换线，与本单同批更换',
      '复紧地脚螺栓至规定扭矩并做防松标记'
    ]
  },
  {
    name: '破碎二',
    code: 'M-0102',
    model: 'PYB-1750',
    category: '破碎设备',
    location: '破碎站二层',
    commissioned: '2019-06-20',
    drawings: ['圆锥破碎机总图 PYB1750-00', '液压站原理图 PYB1750-HY-01'],
    parts: [{ code: 'SP-1002', name: '圆锥衬板', qty: 2 }],
    records: [
      { date: '2023-04-27', item: '圆锥衬板更换', crew: '刘志强' },
      { date: '2023-01-15', item: '液压油更换', crew: '张海涛' }
    ],
    iot: [
      { key: '温度', value: 58, unit: '℃', warn: 60, alarm: 75 },
      { key: '振动', value: 6.8, unit: 'mm/s', warn: 8, alarm: 11 },
      { key: '电流', value: 162, unit: 'A', warn: 160, alarm: 190 },
      { key: '油耗', value: 3.6, unit: 'L/h', warn: 4, alarm: 5 }
    ],
    causes: [
      { cause: '液压系统渗漏', count: 3, part: '液压油泵' },
      { cause: '衬板磨损不均', count: 3, part: '圆锥衬板' }
    ],
    advice: ['更换液压油泵密封组件并保压试验', '测量衬板磨损量，超差则成对更换']
  },
  {
    name: '皮带一',
    code: 'M-0201',
    model: 'DTII-1200',
    category: '输送设备',
    location: '1# 转运站',
    commissioned: '2020-09-01',
    drawings: ['输送机总图 DTII1200-00', '驱动装置装配图 DTII1200-DR-02'],
    parts: [{ code: 'SP-2001', name: '输送带', qty: 1 }],
    records: [
      { date: '2023-06-09', item: '输送带接头硫化', crew: '李振华' },
      { date: '2023-02-18', item: '滚筒轴承润滑', crew: '李振华' }
    ],
    iot: [
      { key: '温度', value: 64, unit: '℃', warn: 60, alarm: 75 },
      { key: '振动', value: 5.2, unit: 'mm/s', warn: 8, alarm: 11 },
      { key: '电流', value: 96, unit: 'A', warn: 120, alarm: 150 },
      { key: '油耗', value: 1.8, unit: 'L/h', warn: 2.5, alarm: 3.5 }
    ],
    causes: [
      { cause: '输送带跑偏', count: 5, part: '滚筒' },
      { cause: '托辊卡阻', count: 3, part: '托辊' }
    ],
    advice: ['调整滚筒轴线与机架中心线垂直度，复紧跑偏开关', '更换卡阻托辊（库存 24 个，可满足）']
  },
  {
    name: '皮带二',
    code: 'M-0202',
    model: 'DTII-1000',
    category: '输送设备',
    location: '2# 转运站',
    commissioned: '2020-09-01',
    drawings: ['输送机总图 DTII1000-00', '驱动装置装配图 DTII1000-DR-02'],
    parts: [{ code: 'SP-2002', name: '托辊', qty: 4 }],
    records: [
      { date: '2023-06-22', item: '托辊更换 4 组', crew: '李振华' },
      { date: '2023-03-11', item: '减速机油位检查', crew: '李振华' }
    ],
    iot: [
      { key: '温度', value: 71, unit: '℃', warn: 60, alarm: 75 },
      { key: '振动', value: 7.4, unit: 'mm/s', warn: 8, alarm: 11 },
      { key: '电流', value: 88, unit: 'A', warn: 120, alarm: 150 },
      { key: '油耗', value: 2.0, unit: 'L/h', warn: 2.5, alarm: 3.5 }
    ],
    causes: [
      { cause: '轴承温升偏高', count: 4, part: '滚筒轴承' },
      { cause: '托辊卡阻', count: 2, part: '托辊' }
    ],
    advice: ['补充 2# 滚筒轴承锂基脂并复测温升', '检查减速机油位与油质，必要时换油']
  },
  {
    name: '球磨机',
    code: 'M-0301',
    model: 'MQY-2136',
    category: '磨矿设备',
    location: '磨矿车间',
    commissioned: '2018-11-05',
    drawings: ['球磨机总图 MQY2136-00', '主轴承装配图 MQY2136-BR-01', '润滑站原理图 MQY2136-LB-03'],
    parts: [{ code: 'SP-3001', name: '磨机衬板', qty: 8 }],
    records: [
      { date: '2023-05-30', item: '衬板磨损测量', crew: '张海涛' },
      { date: '2023-02-14', item: '主轴承瓦检查', crew: '张海涛' }
    ],
    iot: [
      { key: '温度', value: 66, unit: '℃', warn: 65, alarm: 80 },
      { key: '振动', value: 9.1, unit: 'mm/s', warn: 8, alarm: 11 },
      { key: '电流', value: 210, unit: 'A', warn: 200, alarm: 240 },
      { key: '油耗', value: 6.4, unit: 'L/h', warn: 6, alarm: 7.5 }
    ],
    causes: [
      { cause: '润滑油位低', count: 5, part: '润滑站' },
      { cause: '衬板磨损', count: 3, part: '磨机衬板' }
    ],
    advice: [
      '补加润滑油至油标中线，并做油质化验（含水率与粘度）',
      '衬板库存 6 件低于阈值，采购计划需提前下达'
    ]
  },
  {
    name: '提升机',
    code: 'M-0401',
    model: 'JKM-2.8×4',
    category: '提升设备',
    location: '主井井口',
    commissioned: '2017-08-16',
    drawings: ['提升机总图 JKM28-00', '制动系统装配图 JKM28-BK-02', '电控系统图 JKM28-EL-01'],
    parts: [
      { code: 'SP-4001', name: '钢丝绳', qty: 1 },
      { code: 'SP-4002', name: '制动闸瓦', qty: 2 }
    ],
    records: [
      { date: '2023-06-30', item: '钢丝绳探伤', crew: '赵明远' },
      { date: '2023-04-08', item: '制动间隙调整', crew: '赵明远' }
    ],
    iot: [
      { key: '温度', value: 55, unit: '℃', warn: 60, alarm: 75 },
      { key: '振动', value: 4.6, unit: 'mm/s', warn: 8, alarm: 11 },
      { key: '电流', value: 132, unit: 'A', warn: 150, alarm: 180 },
      { key: '油耗', value: 2.2, unit: 'L/h', warn: 2.5, alarm: 3.5 }
    ],
    causes: [
      { cause: '制动间隙偏大', count: 3, part: '制动闸瓦' },
      { cause: '钢丝绳磨损', count: 2, part: '钢丝绳' }
    ],
    advice: ['调整制动闸瓦间隙至 1.0~1.5mm 并做制动试验', '钢丝绳断丝率接近 5%，安排在下次检修更换']
  }
]
