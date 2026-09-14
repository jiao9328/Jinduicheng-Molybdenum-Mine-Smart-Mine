import { requestWithFallback } from './http'
import * as mock from '@/mock/digitalTwin'

/**
 * 数字孪生接口 —— 对应《项目文档》「数字孪生」模块，指导文档 §8.2。
 *
 * 每个函数都带着内置的降级数据，后端未就绪时页面照常渲染，
 * 接口就绪后返回值自动切换为真实数据，调用方无需改动。
 *
 * 类型、常量与纯函数一律从 mock 透出，页面与三维图层只 import 这一层，
 * 不直接依赖 `@/mock/*`（全库一致的约定，全库第一个孪生接口就从这里立规矩）。
 *
 * 注意这里**没有 §8.2-1「地质模型自动更新」的接口**，是刻意的：
 * 那条能力需要后端地质建模服务，前端没有任何可展示的真实内容，
 * 与其造一个永远返回假数据的端点，不如让页面上如实写「未接入」。
 * 页面里那条说明见 DigitalTwinView 的 `.twin__base-note`。
 */
export type {
  TwinDevice,
  TwinDeviceKind,
  TwinDeviceStatus,
  TwinRiskCategory,
  TwinRiskLevel,
  TwinRiskZone,
  TwinSlopeSite,
  TwinSlopeStatus
} from '@/mock/digitalTwin'

export {
  slopeStatus,
  TWIN_DEVICE_STATUS_COLORS,
  TWIN_RISK_LEVELS,
  TWIN_SLOPE_EXAGGERATION,
  TWIN_SLOPE_STATUS_COLORS,
  TWIN_SLOPE_THRESHOLD
} from '@/mock/digitalTwin'

/** 设备定位与作业效率（§8.2-2）。三维点位在本页构建场景时消费，不走 useAsyncData */
export const fetchTwinDevices = () =>
  requestWithFallback('/digital-twin/devices', () => mock.twinDevices)

/** 三类安全风险区四色分布（§8.2-3）。同上，三维风险圆与面板环形图共用这一份 */
export const fetchTwinRiskZones = () =>
  requestWithFallback('/digital-twin/risk-zones', () => mock.twinRiskZones)

/** 边坡位移监测站（§8.2-4）。三维监测点与动态模拟的数据源 */
export const fetchTwinSlopeSites = () =>
  requestWithFallback('/digital-twin/slope-sites', () => mock.twinSlopeSites)

/** 累计位移趋势（§8.2-4）。纯面板数据，走 useAsyncData */
export const fetchTwinSlopeTrend = () =>
  requestWithFallback('/digital-twin/slope-trend', () => mock.twinSlopeTrend)
