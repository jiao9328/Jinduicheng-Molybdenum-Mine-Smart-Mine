import { requestWithFallback } from './http'
import * as mock from '@/mock/safety'

/**
 * 安全管理接口。
 *
 * 每个函数都带着内置的降级数据，后端未就绪时页面照常渲染，
 * 接口就绪后返回值自动切换为真实数据，调用方无需改动。
 *
 * 类型从 mock 透出，页面与三维图层只 import 这一层，不再直接依赖 `@/mock/*`。
 */
export type {
  RiskLevel,
  RiskItem,
  SafetyMarker,
  SafetyTraining,
  HazardClosedLoop
} from '@/mock/safety'

export const fetchSafetyRealtime = () =>
  requestWithFallback('/safety/realtime', () => mock.safetyRealtime)

export const fetchRiskList = () => requestWithFallback('/safety/risk-list', () => mock.riskList)

export const fetchRiskTrend = () => requestWithFallback('/safety/risk-trend', () => mock.riskTrend)

export const fetchRiskTypeDistribution = () =>
  requestWithFallback('/safety/risk-type-distribution', () => mock.riskTypeDistribution)

/**
 * 三维场景的安全标注点。
 *
 * 与其它接口不同，这份数据是在建三维图层时被消费的（`buildSafetyLayer`），
 * 不是渲染到面板上，所以由页面在场景构建器里 await，而不是走 useAsyncData。
 */
export const fetchSafetyMarkers = () =>
  requestWithFallback('/safety/markers', () => mock.safetyMarkers)

/** 安全培训与资质 —— 对应指导文档 4.2「在线安全培训与 VR 事故体验」「特种作业人员资质管理」 */
export const fetchSafetyTraining = () =>
  requestWithFallback('/safety/training', () => mock.safetyTraining)

/** 隐患整改闭环统计 —— 对应指导文档 4.2「隐患上报、整改工单派发、闭环跟踪」 */
export const fetchHazardClosedLoop = () =>
  requestWithFallback('/safety/hazard-loop', () => mock.hazardClosedLoop)
