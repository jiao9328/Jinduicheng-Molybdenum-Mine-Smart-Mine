/** 顶部导航项 */
export interface NavItem {
  /** 显示文案 */
  label: string
  /**
   * 对应路由，**必填**。
   *
   * 顶栏每个 Tab 都必须点得动：给不出 `path` 的项会被做成「指针手型 + hover 高亮
   * 但点下去什么都不发生」的假按钮，评审时会被当成页面坏了。
   * 所以没有真实页面的模块**不进这个数组**，见下面 `HEADER_NAV_LEFT` 的说明。
   */
  path: string
}

/**
 * 首页顶栏左侧导航 Tab —— **5 项**。
 *
 * 这是「顶栏只放**有页面**的模块」这条规则的落地：
 * 数组里的每一项都指向一个功能完整的真实页面，不存在占位页、空壳页。
 *
 * 历史沿革（两份补充件把名单改来改去，最终由用户指令收敛到这一版）：
 * - 补充件第 1 号曾按指导文档 3.1 列出「运输调度」「生产计划调度」两个 Tab，
 *   但它们在任何参考资料里都没有需求描述、也没有页面设计；
 * - 补充件第 3 号 §3 追加的「设备管理」是**另一回事**——页面 `/equipment`
 *   早就存在且功能完整，缺的只是顶栏入口，所以它是真 Tab；
 * - 2026-09-12 用户指令「比《项目文档.docx》多了的功能、数据等删除」，
 *   上述两个只有名字的 Tab 连同它们的占位页一并移除。
 *
 * ⚠️ 这次移除**覆盖了《补充件·第 3 号》§2.2「冻结顶栏名单」**。
 * 补充件是内部裁决记录、不是甲方文档，用户指令优先；已在 README §13 如实记录，
 * 最终确认权在甲方。
 */
export const HEADER_NAV_LEFT: NavItem[] = [
  { label: '数字孪生', path: '/digital-twin' },
  { label: '智能监控', path: '/production' },
  { label: 'AI视频分析', path: '/emergency' },
  { label: '安全管理', path: '/safety' },
  { label: '设备管理', path: '/equipment' }
]

/**
 * 首页顶栏右侧导航 Tab —— **3 项**。
 *
 * 同样只放有页面的模块。补充件第 2 号列出的「基础管理」「人员管理」「销售管理」
 * 三个 Tab（该件自身也标注为中置信度）已按用户指令移除，理由同左栏。
 *
 * 「决策指挥」与「成本管理」共用 `/decision`：两页内容本就是同一块分析决策页，
 * 硬拆成两个路由只会多出一个空壳。这是**有意为之**，不是漏改。
 */
export const HEADER_NAV_RIGHT: NavItem[] = [
  { label: '决策指挥', path: '/decision' },
  { label: '成本管理', path: '/decision' },
  { label: '统计报表', path: '/production' }
]

/**
 * 顶栏第二行的系统分组标题。
 *
 * **不是导航，不可点击**——补充件第 1 号裁定：参考截图里这两个词在顶行导航的**下方**，
 * 左右各一个，字号比导航 Tab 大，只作静态展示。
 * （1920 宽的截图缩到 1080 后再 OCR，一直把它们误读成导航项，这是当初挂错的根因。）
 *
 * 放在这里而不是写死在组件里：补充件 2.2 要求「甲方要调整名单只改 nav.ts 一个文件」。
 */
export const HEADER_GROUP_TITLES = {
  left: '智慧生产系统',
  right: '智慧经营系统'
} as const

/** 首页顶部悬浮的生产计划进度卡（见文档 3.1，数值来自参考截图） */
export interface PlanProgress {
  label: string
  current: number
  total: number
  unit: string
}

export const PRODUCTION_PLANS: PlanProgress[] = [
  { label: '生产计划', current: 1080, total: 1200, unit: '万吨' },
  { label: '掘进计划', current: 1280, total: 1600, unit: '米' },
  { label: '采矿计划', current: 420, total: 800, unit: '万吨' },
  { label: '运输计划', current: 600, total: 800, unit: '万车' }
]

/** 各模块页面标题（子页面顶栏用） */
export const PAGE_TITLES: Record<string, { title: string; subtitle: string }> = {
  '/': { title: '智慧矿山管理平台', subtitle: 'SMART MINE MANAGEMENT PLATFORM' },
  '/safety': { title: '安全分析系统', subtitle: 'SAFETY ANALYSIS SYSTEM' },
  '/production': { title: '生产管理系统', subtitle: 'PRODUCTION MANAGEMENT' },
  '/equipment': { title: '智能统计分析', subtitle: 'EQUIPMENT INTELLIGENT ANALYSIS' },
  '/emergency': { title: '应急救援指挥', subtitle: 'EMERGENCY RESCUE COMMAND' },
  '/digital-twin': { title: '数字孪生', subtitle: 'DIGITAL TWIN' },
  '/decision': { title: '分析决策', subtitle: 'ANALYSIS & DECISION' }
}
