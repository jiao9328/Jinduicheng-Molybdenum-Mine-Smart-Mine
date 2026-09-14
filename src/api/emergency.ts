import { requestWithFallback } from './http'
import * as mock from '@/mock/emergency'

/**
 * 应急救援接口。
 *
 * 每个函数都带着内置的降级数据，后端未就绪时页面照常渲染，
 * 接口就绪后返回值自动切换为真实数据，调用方无需改动。
 *
 * 类型从 mock 透出，页面只 import 这一层，不再直接依赖 `@/mock/*`。
 */
// 下面那组 export type 是纯转发，不会把名字带进本模块作用域；
// updateHazardStatus 的签名要用 HazardStatus，所以这里单独 import 一次
import type { HazardStatus } from '@/mock/emergency'

export type {
  BaseStation,
  CommandChannel,
  DisasterRoute,
  DispatchPlan,
  EmergencyPlan,
  HazardDisposal,
  HazardStatus,
  PersonnelPosition,
  PersonnelTrack,
  VideoSource
} from '@/mock/emergency'

/** 常量与纯数据从 mock 透出，页面不直接依赖 `@/mock/*`（全库一致的约定） */
export { COMMAND_BATCHES, COMMAND_TEXT } from '@/mock/emergency'

export const fetchDisasterRoutes = () =>
  requestWithFallback('/emergency/disaster-routes', () => mock.disasterRoutes)

export const fetchAccidentTypes = () =>
  requestWithFallback('/emergency/accident-types', () => mock.accidentTypes)

export const fetchAreaHazards = () =>
  requestWithFallback('/emergency/area-hazards', () => mock.areaHazards)

export const fetchHazardDisposals = () =>
  requestWithFallback('/emergency/hazard-disposals', () => mock.hazardDisposals)

export const fetchMonthlyAccidents = () =>
  requestWithFallback('/emergency/monthly-accidents', () => mock.monthlyAccidents)

export const fetchRescueResources = () =>
  requestWithFallback('/emergency/rescue-resources', () => mock.rescueResources)

/** §7.2-1 灾害类型 → 应急预案（含逐步操作指引） */
export const fetchEmergencyPlans = () =>
  requestWithFallback('/emergency/plans', () => mock.emergencyPlans)

/** §7.2-5 一键指令下发的三条通道 */
export const fetchCommandChannels = () =>
  requestWithFallback('/emergency/command-channels', () => mock.commandChannels)

/** §7.2-3 最优调配方案 */
export const fetchDispatchPlans = () =>
  requestWithFallback('/emergency/dispatch-plans', () => mock.dispatchPlans)

/** §7.2-4 多源画面点位（无真实视频流，见 mock 里的说明） */
export const fetchVideoSources = () =>
  requestWithFallback('/emergency/video-sources', () => mock.videoSources)

export const fetchPersonnelPositions = () =>
  requestWithFallback('/emergency/personnel-positions', () => mock.personnelPositions)

export const fetchBaseStations = () =>
  requestWithFallback('/emergency/base-stations', () => mock.baseStations)

export const fetchPersonnelTracks = () =>
  requestWithFallback('/emergency/personnel-tracks', () => mock.personnelTracks)

/**
 * 处置隐患：把一条隐患的状态推进一格（未处理 → 处置中 → 已处置）。
 *
 * **这是本项目第一个写接口**，语义与上面的查询接口不同，值得说明：
 *
 * 查询接口的降级是「返回一份内置数据」，写接口没有这个选项——
 * 不能凭空造一个「已处置」出来。所以降级时返回 `false`，
 * 含义是「后端未就绪，本次未真正落库」，由调用方决定怎么呈现。
 *
 * 页面采用**乐观更新**：先把本地状态改掉让按钮立刻有反馈，
 * 再调这个接口落库；接口回来 `false` 就保持乐观值（演示环境），
 * 真接口上线后返回 `true`，页面代码一行都不用动。
 *
 * @param status 推进后的状态，由调用方按当前状态算好
 */
export const updateHazardStatus = (id: number, status: HazardStatus) =>
  requestWithFallback<boolean>(
    `/emergency/hazards/${id}/status`,
    () => false,
    { method: 'PUT', body: { status } }
  )
