import { requestWithFallback } from './http'
import * as mock from '@/mock/overview'

/**
 * 综合管控平台接口。
 *
 * 每个函数都带着内置的降级数据，后端未就绪时页面照常渲染，
 * 接口就绪后返回值自动切换为真实数据，调用方无需改动。
 *
 * 类型从 mock 透出，组件只 import 这一层，不再直接依赖 `@/mock/*`。
 */
export type { WeatherInfo } from '@/mock/overview'

export const fetchPersonnelDistribution = () =>
  requestWithFallback('/overview/personnel-distribution', () => mock.personnelDistribution)

export const fetchHazardMonitor = () =>
  requestWithFallback('/overview/hazard-monitor', () => mock.hazardMonitor)

export const fetchOutputStatistic = () =>
  requestWithFallback('/overview/output-statistic', () => mock.outputStatistic)

export const fetchCostMonitor = () =>
  requestWithFallback('/overview/cost-monitor', () => mock.costMonitor)

export const fetchSafetyGauges = () =>
  requestWithFallback('/overview/safety-gauges', () => mock.safetyGauges)

export const fetchVideoChannels = () =>
  requestWithFallback('/overview/video-channels', () => mock.videoChannels)

export const fetchUnitConsumption = () =>
  requestWithFallback('/overview/unit-consumption', () => mock.unitConsumption)

export const fetchMajorEquipment = () =>
  requestWithFallback('/overview/major-equipment', () => mock.majorEquipment)

export const fetchInventoryStat = () =>
  requestWithFallback('/overview/inventory-stat', () => mock.inventoryStat)

/** 顶栏天气 —— 由全局 AppHeader 消费，与页面面板数据同走这一层 */
export const fetchWeather = () => requestWithFallback('/overview/weather', () => mock.weather)
