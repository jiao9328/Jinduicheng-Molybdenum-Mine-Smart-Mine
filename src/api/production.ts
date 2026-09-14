import { requestWithFallback } from './http'
import * as mock from '@/mock/production'

/**
 * 生产管理接口。
 *
 * 每个函数都带着内置的降级数据，后端未就绪时页面照常渲染，
 * 接口就绪后返回值自动切换为真实数据，调用方无需改动。
 *
 * 类型从 mock 透出，页面只 import 这一层，不再直接依赖 `@/mock/*`。
 */
export type { ProductionMetric, QualityRecord } from '@/mock/production'

export const fetchProductionMetrics = () =>
  requestWithFallback('/production/metrics', () => mock.productionMetrics)

export const fetchQualityActivity = () =>
  requestWithFallback('/production/quality-activity', () => mock.qualityActivity)

export const fetchQualityRecords = () =>
  requestWithFallback('/production/quality-records', () => mock.qualityRecords)

export const fetchTypeDistribution = () =>
  requestWithFallback('/production/type-distribution', () => mock.productionTypeDistribution)

export const fetchOutputTrend = () =>
  requestWithFallback('/production/output-trend', () => mock.outputTrend)

export const fetchAnnualHeatmap = () =>
  requestWithFallback('/production/annual-heatmap', () => mock.annualHeatmap)

/** 掘进进尺计划 vs 实际 —— 对应指导文档 5.2「计划 vs 实际多维对比」 */
export const fetchDrillingProgress = () =>
  requestWithFallback('/production/drilling-progress', () => mock.drillingProgress)

/** 调度值班与交接班记录 —— 对应指导文档 5.2「调度值班、交接班记录」 */
export const fetchDutySchedule = () =>
  requestWithFallback('/production/duty-schedule', () => mock.dutySchedule)
