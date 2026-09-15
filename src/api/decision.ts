import { requestWithFallback } from './http'
import * as mock from '@/mock/decision'

/**
 * 分析决策页接口。
 *
 * 每个函数都带着内置的降级数据，后端未就绪时页面照常渲染，
 * 接口就绪后返回值自动切换为真实数据，调用方无需改动。
 */

/** 页面所需的类型从这里统一透出，调用方不必再直接依赖 mock 模块 */
export type { CostMetric, TopExpense, MonthlyTrend, AnalysisMetric } from '@/mock/decision'

export const fetchCostMetrics = () =>
  requestWithFallback('/decision/cost-metrics', () => mock.costMetrics)

export const fetchAnnualCostCompare = () =>
  requestWithFallback('/decision/annual-cost-compare', () => mock.annualCostCompare)

export const fetchTopExpenses = () =>
  requestWithFallback('/decision/top-expenses', () => mock.topExpenses)

export const fetchCostDistribution = () =>
  requestWithFallback('/decision/cost-distribution', () => mock.costDistribution)

export const fetchMonthlyTrends = () =>
  requestWithFallback('/decision/monthly-trends', () => mock.monthlyTrends)

export const fetchBenefitAnalysis = () =>
  requestWithFallback('/decision/benefit-analysis', () => mock.benefitAnalysis)

export const fetchDecisionSuggestions = () =>
  requestWithFallback('/decision/suggestions', () => mock.decisionSuggestions)

// -----------------------------------------------------------------------------
// 下面三个维度的接口（《项目文档.docx》§06 的「生产分析 / 安全分析 / 能耗单耗」）
// -----------------------------------------------------------------------------

// §9.2-1 生产分析 —— 四块图 + 5 张卡
export const fetchProductionOutput = () =>
  requestWithFallback('/decision/production-output', () => mock.productionOutput)

export const fetchEquipmentUtilization = () =>
  requestWithFallback('/decision/equipment-utilization', () => mock.equipmentUtilization)

export const fetchProcessEfficiency = () =>
  requestWithFallback('/decision/process-efficiency', () => mock.processEfficiency)

export const fetchLossDilution = () =>
  requestWithFallback('/decision/loss-dilution', () => mock.lossDilution)

export const fetchProductionMetrics = () =>
  requestWithFallback('/decision/production-metrics', () => mock.productionMetrics)

// §9.2-2 安全分析
export const fetchHazardTypeDistribution = () =>
  requestWithFallback('/decision/hazard-types', () => mock.hazardTypeDistribution)

export const fetchViolationStats = () =>
  requestWithFallback('/decision/violations', () => mock.violationStats)

export const fetchAccidentTrend = () =>
  requestWithFallback('/decision/accident-trend', () => mock.accidentTrend)

export const fetchSafetyMetrics = () =>
  requestWithFallback('/decision/safety-metrics', () => mock.safetyMetrics)

// §9.2-3 能耗单耗
export const fetchTariffUsage = () =>
  requestWithFallback('/decision/tariff-usage', () => mock.tariffUsage)

export const fetchEnergyMix = () =>
  requestWithFallback('/decision/energy-mix', () => mock.energyMix)

export const fetchWaterUsage = () =>
  requestWithFallback('/decision/water-usage', () => mock.waterUsage)

export const fetchUnitConsumption = () =>
  requestWithFallback('/decision/unit-consumption', () => mock.unitConsumption)

export const fetchEnergyMetrics = () =>
  requestWithFallback('/decision/energy-metrics', () => mock.energyMetrics)

export const fetchTonCostBreakdown = () =>
  requestWithFallback('/decision/ton-cost-breakdown', () => mock.tonCostBreakdown)

export const fetchMachineCost = () =>
  requestWithFallback('/decision/machine-cost', () => mock.machineCost)

// ---------------------------------------------------------------------------
// 决策工单 —— 建议采纳后生成的待办，本项目第二个真写接口
// ---------------------------------------------------------------------------

/** 工单紧急度。必须与 `server/db.mjs` 的 `DECISION_LEVELS` 一致 */
export type DecisionLevel = 'high' | 'mid' | 'low'

/** 工单状态机。与 `server/db.mjs` 的 `ORDER_STATUS`、`StatusTag` 的取值三处一致 */
export type OrderStatus = 'todo' | 'doing' | 'done'

/**
 * 一条决策工单。
 *
 * ⚠️ 这几个类型**没有**放进 `src/mock/decision.ts`，是全库唯一一处例外：
 * 工单是「采纳建议」这个动作在库里生成的真记录，**没有 mock 数据可降级**
 * —— 页面绝不凭空显示一条不存在的工单。mock 里既然没有它的位置，
 * 类型就跟着接口走，与 `api/auth.ts` 的 `UserRole` 同一个道理。
 *
 * `createdAt` 是**服务端填的**（建表语句的 SQL DEFAULT），前端不传也不该传。
 */
export interface DecisionOrder {
  id: number
  /** 来源建议类型（生产计划优化 / 设备维保时机 / …） */
  suggestion: string
  /** 建议正文的快照 —— 采纳那一刻抄下来的，之后建议文案改了工单也不跟着变 */
  content: string
  level: DecisionLevel
  owner: string
  status: OrderStatus
  /** 要求完成时间 */
  due: string
  /** 建单时间，服务端 ISO 串 */
  createdAt: string
}

/**
 * 读：工单列表。
 *
 * 降级值是**空数组**：后端没起来时页面显示「暂无工单」，
 * 而不是显示几条编出来的工单。空数组正是这句话的诚实表达。
 */
export const fetchDecisionOrders = () =>
  requestWithFallback<DecisionOrder[]>('/decision/orders', () => [])

/**
 * 写：采纳一条建议 → 生成工单。
 *
 * ⚠️ 降级值 `null` 的含义是「**后端未就绪，本次没有落库**」，
 * 与 `emergencyApi.updateHazardStatus` 返回 `false` 是同一个约定。
 * 页面据此把这条工单标成「未落库（演示）」，**绝不显示成保存成功**。
 *
 * 这里用 `requestWithFallback` 而不是 `http.post`，与既有的那个写接口保持
 * 一致：**真正的不变式是「写失败绝不能表现为成功」，而不是「不许用降级」**。
 * 降级只发生在 404 / 5xx / 连不上 —— 401 与 403 照旧抛出来给页面回滚，
 * 400 也抛（参数错就是参数错，不能吞）。
 *
 * 返回值**可能**是 `null`，调用方必须判。
 */
export const createDecisionOrder = (order: {
  suggestion: string
  content: string
  level: DecisionLevel
  owner: string
  due: string
}) =>
  requestWithFallback<DecisionOrder | null>('/decision/orders', () => null, {
    method: 'POST',
    body: { ...order, status: 'todo' }
  })

/**
 * 写：推进工单状态（待处理 → 处理中 → 已完成）。
 *
 * 走 PATCH 而不是 `PUT /:id/status`：后端那套资源路由对 PATCH 与 PUT
 * 是同一个处理器，而 PATCH 才是「只改一个字段」的正确语义。隐患那条
 * 之所以有专门的 `/status` 子路由，是因为它还要**联动写 `statusText`**，
 * 工单没有这一列（文案由页面从 status 推），所以不需要多一条路由。
 */
export const updateOrderStatus = (id: number, status: OrderStatus) =>
  requestWithFallback<DecisionOrder | null>(`/decision/orders/${id}`, () => null, {
    method: 'PATCH',
    body: { status }
  })
