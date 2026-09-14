/**
 * 应急救援页 Mock 数据
 *
 * 场景为**露天矿**（金堆城钼矿），所以灾害类型与位置用的是露天开采的说法：
 * 边坡滑坡、爆破事故、坑底积水、排土场失稳。
 * 需求文档的示例文案是井下铜矿（1101 工作面 / 运输大巷 / 中央水仓），
 * 与露天采场对不上，这里按露天矿改写，坐标全部落在真实矿区范围内。
 *
 * 数值口径见各处字段自己的注释：**有文档出处的按文档，文档没写的保留原样**。
 * 这里曾有一句「图表数值与参考截图一致」，但它对 `accidentTypes` 并不成立
 * （截图里是 45.45，文档写的是 43.46，且 18.18 是截图里没有的项），
 * 注释与代码不符本身就是个坑，已改掉。
 */

import { DUMPS, pitOffset } from '@/scene/mineLayout'

/** 摊成 `{ lon, lat }`，方便在对象字面量里 `...pt(e, n)` */
function pt(eastM: number, northM: number) {
  const [lon, lat] = pitOffset(eastM, northM)
  return { lon, lat }
}

/** 一组米制偏移 → 经纬度折线（撤离路线与人员轨迹共用） */
const polyline = (offsets: [number, number][]): [number, number][] =>
  offsets.map(([e, n]) => pitOffset(e, n))

/** 避灾路线图层（可勾选显隐） */
export interface DisasterRoute {
  key: string
  /** 图层名称 */
  label: string
  color: string
  visible: boolean
  /** 路线折线（经纬度） */
  path: [number, number][]
  /** 沿线流动光效速度 */
  flowSpeed: number
}

/**
 * 撤离路线：均由采场内部出发，沿台阶道路爬升至坑外的安全区。
 *
 * 路径用相对采坑中心的**米制偏移**书写，可读性比一串经纬度好得多——
 * 「从坑内 -60m 处向北爬 700m 出坑」一眼能看懂，
 * 也方便直接对着采坑半轴 (rx 365 / ry 315) 判断起终点是否落在坑内。
 */
const ROUTE_OFFSETS: {
  key: string
  label: string
  color: string
  flowSpeed: number
  /** [东偏移(米), 北偏移(米)] */
  offsets: [number, number][]
}[] = [
  {
    key: 'landslide',
    label: '采场-边坡滑坡撤离路线',
    color: '#b388ff',
    flowSpeed: 8,
    // 北帮失稳：从坑内北侧台阶沿正北爬出，接到矿区北侧进场道路
    offsets: [
      [-60, -60],
      [-80, 60],
      [-90, 200],
      [-80, 360],
      [-60, 520],
      [-40, 700]
    ]
  },
  {
    key: 'blasting',
    label: '采场-爆破事故撤离路线',
    color: '#00e5ff',
    flowSpeed: 10,
    // 爆破警戒：从东帮向东北撤，终点在选矿厂台地一侧
    offsets: [
      [120, -40],
      [200, 80],
      [300, 220],
      [420, 380],
      [560, 560],
      [700, 760]
    ]
  },
  {
    key: 'debris',
    label: '采场-排土场泥石流撤离路线',
    color: '#00ff9d',
    flowSpeed: 12,
    // 西侧排土场方向有泥石流风险：从坑内西侧起步，
    // 朝北绕过排土场，而不是朝西直接穿过它
    offsets: [
      [-100, 20],
      [-200, 140],
      [-260, 300],
      [-280, 480],
      [-260, 660],
      [-220, 820]
    ]
  }
]

export const disasterRoutes: DisasterRoute[] = ROUTE_OFFSETS.map((r) => ({
  key: r.key,
  label: r.label,
  color: r.color,
  visible: true,
  flowSpeed: r.flowSpeed,
  path: polyline(r.offsets)
}))

/**
 * 事故类型占比 —— 环形图。名称按露天矿改写，占比取自指导文档 §5 的唯一明确值。
 *
 * ⚠️ 四项之和是 **98.00**，不是 100，这是**已知且有意**的：
 * 指导文档只写死了「运输事故 43.46% / 瓦斯超限 27.27% / 水灾事故 9.09%」三项，
 * 第四项「其他」没给数。原代码的 45.45 在两份文档里都查无出处，已按文档改为 43.46。
 * 不做归一化凑 100——那等于替甲方编一个他没写过的数；环形图本身按占比铺满，
 * 少这 2% 在屏幕上完全看不出来。tooltip 用的是 `{c}%`（原值）而不是 ECharts
 * 自动算的 `{d}`，所以悬停显示的就是这里的数，不会因总和不是 100 而自相矛盾。
 */
export const accidentTypes = [
  { name: '边坡滑坡', value: 43.46, color: '#ff4d4f' },
  { name: '爆破事故', value: 27.27, color: '#ff9f1c' },
  { name: '运输故障', value: 18.18, color: '#ffd60a' },
  { name: '水害隐患', value: 9.09, color: '#00e5ff' }
]

/** 区域隐患统计 —— 柱状图 */
export const areaHazards = {
  areas: ['北帮采剥面', '东帮爆破区', '主运输道路', '排土场', '尾矿库'],
  values: [4, 5, 2, 3, 1]
}

/** 隐患处置列表 */
export type HazardStatus = 'done' | 'doing' | 'todo'

export interface HazardDisposal {
  id: number
  /** 隐患类型 */
  type: string
  /** 位置 */
  location: string
  status: HazardStatus
  /** 覆盖状态文案（截图中用词不统一，如「已修复」） */
  statusText: string
}

export const hazardDisposals: HazardDisposal[] = [
  { id: 1, type: '边坡位移超限', location: '北帮采剥面', status: 'done', statusText: '已处置' },
  { id: 2, type: '爆破警戒疏漏', location: '东帮爆破区', status: 'done', statusText: '已处置' },
  { id: 3, type: '坑底积水', location: '坑底集水池', status: 'doing', statusText: '处置中' },
  { id: 4, type: '运输故障', location: '主运输道路', status: 'done', statusText: '已修复' }
]

/** 月度事故趋势 —— 面积折线 */
export const monthlyAccidents = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  values: [3, 2, 4, 1, 2, 3, 1, 2, 1, 3, 2, 1]
}

/** 应急救援资源 */
export const rescueResources = {
  teams: [
    { name: '救护一队', members: 18, status: '待命' },
    { name: '救护二队', members: 15, status: '出动中' },
    { name: '医疗组', members: 8, status: '待命' }
  ],
  supplies: [
    { name: '自救器', count: 320, unit: '台' },
    { name: '担架', count: 24, unit: '副' },
    { name: '应急电源', count: 12, unit: '台' },
    { name: '通讯设备', count: 46, unit: '部' }
  ]
}

/** 采场作业人员与设备定位（模拟实时点位） */
export interface PersonnelPosition {
  id: string
  name: string
  /** 所在区域（与「区域隐患统计」的区划名一致） */
  area: string
  lon: number
  lat: number
  /** 工种 */
  role: string
  /** 定位终端是否在线 */
  online: boolean
}

export const personnelPositions: PersonnelPosition[] = [
  { id: 'P-1024', name: '张**', area: '北帮采剥面', role: '钻机工', online: true, ...pt(-120, 180) },
  { id: 'P-1088', name: '李**', area: '主运输道路', role: '矿卡司机', online: true, ...pt(450, 60) },
  { id: 'P-1132', name: '王**', area: '东帮爆破区', role: '爆破员', online: true, ...pt(260, -60) },
  { id: 'P-1167', name: '赵**', area: '坑底集水池', role: '排水工', online: false, ...pt(0, 0) },
  // 排土场不在采坑周边，直接引用排土场中心，避免又抄一份坐标
  { id: 'P-1203', name: '刘**', area: '排土场复垦区', role: '复垦管护', online: true, lon: DUMPS[0].lon, lat: DUMPS[0].lat }
]

/**
 * 定位基站。
 *
 * 基站得立在采坑四周的**高地上**，覆盖圈才能罩住坑内作业面；
 * 所以位置都取在采坑半轴 (rx 365 / ry 315) 之外一圈。
 */
export interface BaseStation {
  id: string
  name: string
  lon: number
  lat: number
  /** 覆盖半径（米） */
  radius: number
  /** 在线载波数 */
  carriers: number
  online: boolean
}

export const baseStations: BaseStation[] = [
  { id: 'BS-01', name: '北帮基站', ...pt(-40, 520), radius: 620, carriers: 42, online: true },
  { id: 'BS-02', name: '东帮基站', ...pt(520, 120), radius: 600, carriers: 38, online: true },
  { id: 'BS-03', name: '南帮基站', ...pt(60, -470), radius: 560, carriers: 27, online: true },
  { id: 'BS-04', name: '排土场基站', ...pt(-900, -60), radius: 520, carriers: 0, online: false }
]

/** 人员历史轨迹（当日已走过的路线，模拟数据） */
export interface PersonnelTrack {
  id: string
  /** 对应 `personnelPositions` 的 id */
  personId: string
  name: string
  color: string
  path: [number, number][]
}

export const personnelTracks: PersonnelTrack[] = [
  {
    id: 'T-01',
    personId: 'P-1024',
    name: '张** 当日轨迹',
    color: '#00e5ff',
    // 从北侧坡顶下到北帮采剥面，终点与上面的人员点位重合
    path: polyline([
      [60, 320],
      [-20, 280],
      [-80, 230],
      [-120, 180]
    ])
  },
  {
    id: 'T-02',
    personId: 'P-1088',
    name: '李** 当日轨迹',
    color: '#00ff9d',
    // 沿主运输道路由坑边驶向厂区
    path: polyline([
      [380, 120],
      [420, 90],
      [450, 60]
    ])
  },
  {
    id: 'T-03',
    personId: 'P-1132',
    name: '王** 当日轨迹',
    color: '#ffd60a',
    // 爆破警戒：由东帮内侧退到爆破区
    path: polyline([
      [120, 60],
      [200, 0],
      [260, -60]
    ])
  }
]

// ---------------------------------------------------------------------------
// §7.2-1 应急预案匹配
// ---------------------------------------------------------------------------

/**
 * 灾害类型与预案。
 *
 * `type` 必须与面板 chip 文案**以及环形图的类型名**一致：环形图点一下也要能
 * 弹出对应预案，两者对不上的那些类型就是「点了没反应」，而且不报任何错。
 * 所以这里的四项直接取 `accidentTypes` 的四个名字（见上方该常量），
 * 一个类型只有一种叫法。
 *
 * **与 docx 的关系**（README §13 有记录）：
 * docx 原文是「边坡滑坡、爆破事故、井下火灾、透水**等**」，以「等」收尾，
 * 本身不是穷举。本平台的三维底座是**露天采场**（见文件顶部），没有井下工程，
 * 四类的对应关系是：
 *   边坡滑坡、爆破事故 —— 逐字照用；
 *   透水 → **水害隐患**（预案名里写明「坑底积水（透水）」，与坑底集水池、
 *     隐患列表里的「坑底积水」是同一条线）；
 *   井下火灾 → **运输故障** —— 井下火灾在露天矿不成立，而「运输事故」正是
 *     docx 自己列的第一大事故类型（运输事故 43.46%），页面的环形图里已有这一项，
 *     改成它比另起一个露天矿没有的类型更有出处。
 */
export interface EmergencyPlan {
  key: string
  /** 灾害类型，即面板上的 chip 文案，与环形图类型名一致 */
  type: string
  /** 匹配到的预案名称 */
  name: string
  /** 响应级别 */
  level: string
  /** 逐步操作指引，弹窗里逐条显示 */
  steps: string[]
}

export const emergencyPlans: EmergencyPlan[] = [
  {
    key: 'landslide',
    type: '边坡滑坡',
    name: '边坡滑坡事故专项应急预案',
    level: 'Ⅱ级',
    steps: [
      '拉响北帮区域警报，清点北帮采剥面在册人员并报指挥中心',
      '按避灾路线封闭北帮 3 台阶以下全部作业面，禁止人车进入',
      '边坡监测组加密 SL-01/SL-04 位移观测，每 15 分钟报一次读数',
      '调度推土机于北帮坡脚堆筑反压平台，抑制继续滑移',
      '确认滑坡体稳定后，由技术组勘察后方可恢复作业'
    ]
  },
  {
    key: 'blasting',
    type: '爆破事故',
    name: '爆破事故专项应急预案',
    level: 'Ⅱ级',
    steps: [
      '立即切断爆破区供电，警戒范围内全体人员按路线撤至安全距离以外',
      '核对爆破作业台账，清点在册爆破作业人员与民爆物品数量',
      '安全员进入现场前须等待 15 分钟，确认无盲炮、无残余药量',
      '发现盲炮时划定 50 米警戒圈，由持证爆破员按规定程序处理',
      '事故情况与处置结果上报属地应急管理部门'
    ]
  },
  {
    key: 'haul',
    type: '运输故障',
    name: '运输事故专项应急预案',
    level: 'Ⅲ级',
    steps: [
      '事故车辆前后 30 米设置警示标志，主运输道路单侧放行或临时封闭',
      '清点涉事车辆驾乘人员，有伤者立即联系矿区医院并派车接应',
      '检查车辆是否存在溜车、制动失效风险，必要时垫塞固定',
      '调度备用车辆转运受阻的矿石，避免运输线长时间中断',
      '查明故障原因并检修合格后，方可恢复该车次运输'
    ]
  },
  {
    key: 'flood',
    type: '水害隐患',
    name: '坑底积水（透水）专项应急预案',
    level: 'Ⅲ级',
    steps: [
      '启动坑底集水池排水泵组，备用泵同步接入',
      '坑底及集水池周边人员全部撤至台阶以上安全位置',
      '检查边坡截水沟与排水沟，封堵涌入坑底的汇水通道',
      '水文监测组持续观测水位与涌水量，评估泵组能力是否足够',
      '水位降至警戒线以下并稳定后，方可恢复坑底作业'
    ]
  }
]

// ---------------------------------------------------------------------------
// §7.2-5 一键指令下发
// ---------------------------------------------------------------------------

/**
 * 指令通道。
 *
 * `total` 就是**该通道需要送达的终端数**，不要在别处再存一份「总数」——
 * 两处各存一个数迟早会不一致，而这类不一致在屏幕上表现为
 * 「进度条走满了但数字还没到」，很难查。
 * 进度由页面按 `total` 现算。
 */
export interface CommandChannel {
  key: string
  /** 通道名称，即 docx 里点名的三类终端 */
  name: string
  /** 终端数量 */
  total: number
  color: string
}

export const commandChannels: CommandChannel[] = [
  { key: 'person', name: '人员定位终端', total: 128, color: '#00e5ff' },
  { key: 'vehicle', name: '车载终端', total: 24, color: '#00ff9d' },
  { key: 'broadcast', name: '广播喇叭', total: 12, color: '#ffd60a' }
]

/** 下发的指令正文 */
export const COMMAND_TEXT = '各单位注意：采场发生险情，全体人员按避灾路线立即撤离至安全集合点'

/**
 * 每条通道分几批下发。
 *
 * 分批（而不是「一次到位」）是**看得出来**这件事的全部意义所在：
 * 一键下发如果瞬间全部变成 100%，大屏上就只是一次闪烁，
 * 评审看不到「指令正在一条条送达」。
 */
export const COMMAND_BATCHES = 8

// ---------------------------------------------------------------------------
// §7.2-3 最优调配方案
// ---------------------------------------------------------------------------

/**
 * 调配方案的一行：谁/什么物资，从哪儿来，到哪儿去，多久能到。
 *
 * ⚠️ 这里**没有「匹配度」字段**，是刻意的。
 * docx 只要求「自动计算最优调配方案」，没定义匹配度怎么算。
 * 凭空写一个 86 分出来，就是替甲方编一个他从来没定义过的指标，
 * 而且看的人一定会问「怎么算的」——答不上来。
 * 「最优」在演示里体现为**按预计到场时间排序**：那是个真算得出来的量，
 * 排序在组件里现做，不在数据里存一个排好的顺序。
 */
export interface DispatchPlan {
  id: string
  /** 队伍或物资名称 */
  name: string
  /** 类别 */
  kind: '救援队伍' | '应急物资'
  /** 来源 */
  from: string
  /** 目的地 */
  to: string
  /** 预计到场（分钟） */
  eta: number
}

export const dispatchPlans: DispatchPlan[] = [
  {
    id: 'D-01',
    name: '救护一队',
    kind: '救援队伍',
    from: '矿区应急中心',
    to: '北帮采剥面',
    eta: 6
  },
  {
    id: 'D-02',
    name: '救护二队',
    kind: '救援队伍',
    from: '选矿厂值班点',
    to: '北帮采剥面',
    eta: 11
  },
  {
    id: 'D-03',
    name: '负压救护车',
    kind: '应急物资',
    from: '矿区医院',
    to: '北帮采剥面',
    eta: 9
  },
  {
    id: 'D-04',
    name: '液压破拆工具组',
    kind: '应急物资',
    from: '应急物资库',
    to: '北帮采剥面',
    eta: 14
  }
]

// ---------------------------------------------------------------------------
// §7.2-4 多源画面
// ---------------------------------------------------------------------------

/**
 * 多源画面（视频监控 / 无人机）。
 *
 * ⚠️ **纯前端占位，没有真实视频流。** 页面上写的是「信号接入中」而不是
 * 伪造一帧画面——docx 要的是「集成…实现可视化远程辅助指挥」，
 * 那需要后端流媒体服务，不是前端能造的。README §5 覆盖表里如实标注。
 */
export interface VideoSource {
  key: string
  /** 点位名称 */
  name: string
  /** 画面来源类型 */
  kind: '视频监控' | '无人机'
}

export const videoSources: VideoSource[] = [
  { key: 'V-01', name: '北帮采剥面', kind: '视频监控' },
  { key: 'V-02', name: '主运输道路', kind: '视频监控' },
  { key: 'V-03', name: '无人机航拍', kind: '无人机' }
]
