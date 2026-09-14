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
