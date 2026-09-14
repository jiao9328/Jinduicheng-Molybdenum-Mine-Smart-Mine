import { requestWithFallback } from './http'
import * as mock from '@/mock/equipment'

/**
 * 设备管理接口。
 *
 * 每个函数都带着内置的降级数据，后端未就绪时页面照常渲染，
 * 接口就绪后返回值自动切换为真实数据，调用方无需改动。
 *
 * 类型从 mock 透出，页面只 import 这一层，不再直接依赖 `@/mock/*`。
 */
export type {
  DeviceAlert,
  DeviceArchive,
  DeviceScore,
  EquipmentMetric,
  IotParam,
  MaintenanceOrder,
  SparePart
} from '@/mock/equipment'

export const fetchEquipmentMetrics = () =>
  requestWithFallback('/equipment/metrics', () => mock.equipmentMetrics)

export const fetchDeviceScores = () =>
  requestWithFallback('/equipment/device-scores', () => mock.deviceScores)

export const fetchDeviceTrend = () =>
  requestWithFallback('/equipment/device-trend', () => mock.deviceTrend)

export const fetchDeviceWeights = () =>
  requestWithFallback('/equipment/device-weights', () => mock.deviceWeights)

export const fetchWeeklyBubble = () =>
  requestWithFallback('/equipment/weekly-bubble', () => mock.weeklyBubble)

export const fetchDeviceAlerts = () =>
  requestWithFallback('/equipment/device-alerts', () => mock.deviceAlerts)

/** §03-5 备件库存台账（缺货与否由页面按 stock < minStock 现算） */
export const fetchSpareParts = () =>
  requestWithFallback('/equipment/spare-parts', () => mock.spareParts)

/** §03-4 维保工单 */
export const fetchMaintenanceOrders = () =>
  requestWithFallback('/equipment/maintenance-orders', () => mock.maintenanceOrders)

/** §03-1/-2/-3 设备档案（一机一码 / IoT 参数 / 故障诱因） */
export const fetchDeviceArchives = () =>
  requestWithFallback('/equipment/device-archives', () => mock.deviceArchives)
