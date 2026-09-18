/**
 * 场景总线 —— 补上全站缺的那个「全局 viewer 句柄」。
 *
 * ## 为什么非要新加这么一层
 *
 * 墩儿的面板挂在 `App.vue` 上（要跟着 1920×1080 一起缩放），
 * 而 Cesium 的 viewer 在 `MapScene.vue` **组件实例内部**（`useCesium.ts:62`
 * 的 `shallowRef`，没有任何模块级单例）。两者不在同一棵子树里，
 * 面板**够不到任何 viewer**，也就没法驱动相机。
 *
 * 探索过但否掉的几条路：
 *
 * - **再挂一个隐藏的 MapScene**：`useCesium` 的容器 id 默认写死
 *   `'cesium-container'`，一个页面上两个 MapScene 会抢同一个 DOM id。
 * - **靠 `window.__cesiumViewer`**：那是诊断入口，页面切走就 `delete`，
 *   而且它是"最后一个建好的 viewer"，不代表当前页面的那个。
 * - **按实体 id 前缀去 `viewer.entities.values` 里捞图层**：
 *   `twinLayer.ts:247-251` 明确警告过前缀匹配会顺手吞掉别的图层。
 *
 * 所以：谁有 viewer 谁登记，谁有图层开关谁登记。**注册是纯增量的** ——
 * 没有登记时一切命令如实回「当前页面没有可操作的三维场景」，
 * 而不是假装成功。
 *
 * ## 两层是分开的：相机 vs 图层
 *
 * 相机只有 `MapScene.vue` 有，所以 `registerScene` 写在它里面，
 * **九个页面一次性全都有导航能力**，不用挨个改。
 * 图层开关是各页面自己的状态（数字孪生的 Tab 单选、应急救援的 checkbox），
 * 由那两个页面各自 `registerLayers`。
 *
 * ## 同一时刻只有一个场景活着
 *
 * 路由切换时 Vue 的顺序是"新的先挂载、旧的后卸载"，所以旧页面的
 * `unregister` 可能发生在新页面 `register` 之后。注销时**必须比对 id**，
 * 不然一次路由切换会把刚登记好的新场景顺手注销掉 —— 表现是
 * "切到另一页之后墩儿就不认路了"，且只在**切页之后**才出现。
 */

import type { SceneWaypoint } from '@/scene/sceneConfig'

/** 相机能力。由 `MapScene.vue` 登记，页面切换时自动注销 */
export interface SceneHandle {
  /** 唯一标识，注销时比对用（用组件实例的 uid） */
  id: string
  /** 拿 viewer。可能为 null（建场景要好几秒，期间还没就绪） */
  viewer(): unknown
  /** 飞过去。失败要如实抛，不要吞 */
  flyTo(wp: SceneWaypoint, duration?: number): Promise<void>
}

/**
 * 图层操作的结果。
 *
 * 为什么不返回布尔：**这一页为什么做不到**是必须说出去的信息。
 * 数字孪生页的三组图层是三选一的，用户说「关掉设备图层」时那句话
 * 在当前设计下**没法照做** —— 回一句「这一页三组互斥，请直接切到要看的那组」
 * 他立刻明白；回一句「操作失败」他只会以为是自己说错了。
 */
export interface LayerOpResult {
  ok: boolean
  /** 给用户看的一句话。成功时也要有（「已切到风险分布」） */
  note: string
}

/** 图层能力。只有真的有图层开关的页面才登记 */
export interface LayerHandle {
  id: string
  /** 开/关。这一页没有这个图层、或按它的设计做不到时，如实说明 */
  set(name: string, visible: boolean): LayerOpResult
  /** 只留这几个，其余关闭 */
  isolate(names: string[]): LayerOpResult
  /** 当前各图层开关状态 */
  list(): { name: string; visible: boolean }[]
}

/** 只有数字孪生页能做的动作 */
export interface SimHandle {
  id: string
  startSim(site: string, speed: number): LayerOpResult
}

let scene: SceneHandle | null = null
let layers: LayerHandle | null = null
let sim: SimHandle | null = null

export function registerScene(h: SceneHandle): void {
  scene = h
}

export function unregisterScene(id: string): void {
  if (scene?.id === id) scene = null
}

export function registerLayers(h: LayerHandle): void {
  layers = h
}

export function unregisterLayers(id: string): void {
  if (layers?.id === id) layers = null
}

export function registerSim(h: SimHandle): void {
  sim = h
}

export function unregisterSim(id: string): void {
  if (sim?.id === id) sim = null
}

export const currentScene = (): SceneHandle | null => scene
export const currentLayers = (): LayerHandle | null => layers
export const currentSim = (): SimHandle | null => sim

/** 给自检脚本与排障用的一句话现状 —— 面板上也要显示它 */
export function sceneStatus(): { scene: boolean; layers: boolean; sim: boolean } {
  return { scene: Boolean(scene), layers: Boolean(layers), sim: Boolean(sim) }
}
