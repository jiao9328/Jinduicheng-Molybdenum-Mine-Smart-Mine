import { http } from './http'

/**
 * 四张台账的写接口 —— 数据管理页专用。
 *
 * ## 写接口一律**不降级**
 *
 * 这里刻意全用 `http.post/put/delete` 而不是 `requestWithFallback`。
 * 降级对查询接口是合理的（后端没起也能看演示数据），对写操作则是**危险的**：
 * 它会让「保存失败」在界面上表现为「保存成功」，用户以为改好了，刷新全没了。
 * 写操作只有两种结果 —— 真写进去了，或者报错。
 *
 * 这一点与既有的 `updateHazardStatus` 一脉相承：那个写接口当年在降级时返回
 * `false`（意思是「后端未就绪，本次未落库」），而不是伪造一个成功值。
 *
 * ## 路径与查询接口完全一致
 *
 * `RESOURCE_PATHS` 里的四个路径和 `api/production|equipment|emergency` 里
 * 读接口用的**是同一个**。后端 `server/routes.mjs` 由同一份资源定义生成
 * 读与写的路由，所以这里不可能与那边错开。
 */
export type ResourceKey = 'quality' | 'duty' | 'spare' | 'hazard'

export const RESOURCE_PATHS: Record<ResourceKey, string> = {
  quality: '/production/quality-records',
  duty: '/production/duty-schedule',
  spare: '/equipment/spare-parts',
  hazard: '/emergency/hazard-disposals'
}

/**
 * 读这张表的全部行 —— **同样不降级**，与上面写接口一个道理。
 *
 * 管理页尤其不能降级：后端没起时若退回内置 mock，管理员会看到一屏
 * 「看起来正常的记录」，改一条又报错，且**没有任何迹象表明他看到的是假数据**。
 * 宁可这里明确报「连不上后端」。
 *
 * 注意别和 `api/production|equipment|emergency` 里那些读接口搞混 ——
 * 那些是给展示页用的，**会**降级到 mock，这是它们该有的行为。
 */
export const listRecords = <T>(key: ResourceKey) => http.get<T[]>(RESOURCE_PATHS[key])

export const createRecord = <T>(key: ResourceKey, body: Record<string, unknown>) =>
  http.post<T>(RESOURCE_PATHS[key], body)

export const updateRecord = <T>(key: ResourceKey, id: string | number, body: Record<string, unknown>) =>
  http.put<T>(`${RESOURCE_PATHS[key]}/${encodeURIComponent(id)}`, body)

export const deleteRecord = (key: ResourceKey, id: string | number) =>
  http.delete<{ ok: boolean; deleted: unknown }>(
    `${RESOURCE_PATHS[key]}/${encodeURIComponent(id)}`
  )
