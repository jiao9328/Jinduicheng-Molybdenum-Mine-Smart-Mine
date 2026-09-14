import { http } from './http'

/**
 * 鉴权与系统状态接口。
 *
 * 与业务接口不同，这几个**一律不走 `requestWithFallback`**：
 * 「后端没起时给一份内置数据」在鉴权上是荒谬的 —— 内置一个「已登录」等于
 * 后门，内置一个「登录失败」则会让后端没起时谁也进不去、页面全白。
 * 所以它们直接抛错，由调用方决定怎么办（`stores/user.ts` 已经定好了：
 * 登出照清、校验失败即未登录）。
 *
 * 同理，`/api/auth/*` 之外的写接口也都不降级 —— 见 `dataAdmin.ts`。
 */

export type UserRole = 'admin' | 'user'

export interface SessionUser {
  id: number
  username: string
  role: UserRole
  displayName: string
}

export interface LoginResult {
  token: string
  user: SessionUser
}

/** 各表条数 —— 顶栏「数据源」角标据此判断库是否真的通了 */
export interface HealthInfo {
  ok: boolean
  database: string
  tables: Record<string, number>
  accounts: { username: string; role: UserRole; displayName: string }[]
}

export const login = (username: string, password: string) =>
  http.post<LoginResult>('/auth/login', { username, password })

export const logout = () => http.post<{ ok: boolean }>('/auth/logout')

export const fetchMe = () => http.get<{ user: SessionUser }>('/auth/me')

/**
 * 健康检查。**不要求登录**（后端刻意放开的探针），所以未登录时也能调，
 * 顶栏用它区分「数据库已连接」与「演示数据」。
 */
export const fetchHealth = () => http.get<HealthInfo>('/health')
