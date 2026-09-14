/**
 * 统一请求层。
 *
 * 直接用 fetch 而不是再引一层请求库：接口数量有限，自己实现能完全掌控超时、
 * 降级与错误语义，也不必为这一件事增加依赖。
 *
 * 与后端约定的边界：
 * - 请求头统一带 `Accept: application/json`，写操作再带 `Content-Type`
 * - 已登录时带 `Authorization: Bearer <token>`
 * - 非 2xx 与网络异常统一抛 HttpError，调用方只 catch 一种错误类型
 *
 * ## 鉴权是「注入」的，不是「依赖」的
 *
 * 本模块**不 import 任何 store**。取 token 与「401 之后干什么」都由外部通过
 * `setAuthHandlers` 注入（`main.ts` 里接上用户 store）。这样请求层保持零依赖、
 * 可单独测，也避免 `store → api → store` 的循环引用。
 *
 * 401 仍然是**不可降级的 4xx**（和 400/403 一样直接抛给调用方），
 * 区别只在于它会额外触发一次「会话失效」回调把用户送回登录页。
 * 登录接口本身的 401 不算会话失效 —— 那是口令错了，见 `request()` 里的判断。
 */

/** 后端地址：部署时用 VITE_API_BASE_URL 覆盖，默认走同源 /api */
const BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api'

/** 大屏部署在矿区网络，链路不稳时不能让请求一直挂着 */
const TIMEOUT = 15000

/**
 * 接口不可用时是否允许降级到内置 mock 数据。
 *
 * 平台前端先行，后端可能只有部分接口就绪；4xx 参数错误之外，
 * 其余失败都按「接口未就绪」处理，让页面用内置数据照常渲染。
 * 生产环境可通过环境变量关掉。
 */
const ALLOW_MOCK_FALLBACK: boolean =
  (import.meta.env.VITE_ALLOW_MOCK_FALLBACK as string | undefined) !== 'false'

/**
 * 已确认不可用的**接口路径**（会话级缓存）。
 *
 * 一旦某个路径确认接口不可用，后续对它的请求直接给内置数据，
 * 不再各自白等一次超时。后端恢复后刷新页面即可重新尝试。
 *
 * ## 为什么是「一组路径」而不是「一个布尔」
 *
 * 原来是一个模块级布尔 `degraded`，**一旦置位就全站降级**。那在
 * 「所有接口都没实现」的年代没问题，但现在是**一部分接口有后端、一部分没有**：
 * 平台 74 个接口里只有 5 个接了库，其余仍走内置数据。全局布尔会这样失控 ——
 * 任意一个未实现接口的 404 把标志置位，**连已经接上数据库的那 5 个也一起
 * 退回内置数据**，界面上完全看不出库其实是通的，变成「接了数据库却还在看
 * 演示数据」。
 *
 * 更隐蔽的是入库接口和没入库的接口**混在同一个模块前缀下**：
 * `/production/quality-records` 接了库，同前缀的 `/production/metrics` 没接。
 * 所以粒度必须是**完整路径**，按 `/production` 记账一样会被毒掉。
 */
const degradedPaths = new Set<string>()

/**
 * 路径归一化，作为上面那个集合的键。
 *
 * 把纯数字的一段换成 `:id`，让 `/emergency/hazards/3/status` 与
 * `/emergency/hazards/7/status` 共用一条降级记录。
 *
 * 只处理数字段是有意的：**只有在降级路径上（`requestWithFallback`）出现的
 * 动态接口才需要归并**，而这样的接口全平台只有一个（隐患状态推进）。
 * `spare_parts` 那种以字符串编码作主键的路径走的是 `http.put/delete`，
 * 压根不参与降级记账，逐个记也无所谓、更不会记错。
 */
function degradationKey(path: string): string {
  return path
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) ? ':id' : seg))
    .join('/')
}

/** 当前是否有任何接口处于降级（顶栏「数据源」角标与巡检脚本都看它） */
export function isUsingMockData(): boolean {
  return degradedPaths.size > 0
}

/** 当前降级的接口路径列表 —— 排查「为什么看到的是演示数据」时把它打出来 */
export function degradedPathList(): string[] {
  return [...degradedPaths].sort()
}

/**
 * 清空降级记录。**登录成功后必须调**，否则上一次会话里记下的
 * 「后端没起」会把这次登录后的所有请求直接短路成内置数据 ——
 * 用户会看到「登录成功了但数据是假的」。
 */
export function resetDegraded(): void {
  degradedPaths.clear()
}

// ---------------------------------------------------------------------------
// 鉴权回调（由 main.ts 注入，见文件头）
// ---------------------------------------------------------------------------

let tokenProvider: () => string | null = () => null
let unauthorizedHandler: (() => void) | null = null

export function setAuthHandlers(handlers: {
  /** 取当前会话 token，没有则返回 null */
  getToken: () => string | null
  /** 收到 401（且不是登录接口本身）时调用，通常用来清会话跳登录页 */
  onUnauthorized: () => void
}): void {
  tokenProvider = handlers.getToken
  unauthorizedHandler = handlers.onUnauthorized
}

export class HttpError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码；0 表示没拿到响应（断网 / 超时 / 跨域） */
    readonly status: number,
    /** 后端返回的原始错误体，便于按业务码细分处理 */
    readonly data?: unknown,
    /**
     * 是否属于「接口未就绪」，即 requestWithFallback 可以吞掉并改用内置数据。
     *
     * 网络层失败 / 404 / 5xx / 2xx 但非 JSON 都算未就绪；
     * 其余 4xx（参数错误等）是请求本身不合法，必须抛给调用方。
     *
     * 注意这个参数必须显式声明：漏掉它时这里只会静默丢弃实参，
     * 降级判定恒为 false，整套 mock 兜底会全部失效。
     */
    readonly degradable = false
  ) {
    super(message)
    this.name = 'HttpError'
  }

  /** 网络层失败：这类错误重试或降级才有意义 */
  get isNetworkError(): boolean {
    return this.status === 0
  }
}

export type QueryValue = string | number | boolean | null | undefined
export type QueryParams = Record<string, QueryValue>

export interface RequestOptions {
  /** 额外请求头，同名时覆盖默认值 */
  headers?: Record<string, string>
  /** 覆盖默认超时（毫秒） */
  timeout?: number
  /** 调用方取消（组件卸载、重复提交打断上一次请求） */
  signal?: AbortSignal
}

interface RequestConfig extends RequestOptions {
  params?: QueryParams
  body?: unknown
  /**
   * 请求方法，默认 GET。
   *
   * `requestWithFallback` 原先写死 GET，只能承载查询；
   * 加了写操作（隐患处置、报表导出）之后需要区分，
   * 否则「后端就绪后页面不用改」这个承诺对写接口就落空了。
   */
  method?: string
}

/** 空响应体与非法 JSON 的哨兵值，用来区分「后端返回了空」和「后端根本没就绪」 */
const EMPTY_BODY = Symbol('empty-body')
const INVALID_BODY = Symbol('invalid-body')

function buildUrl(path: string, params?: QueryParams): string {
  const url = `${BASE_URL}${path}`
  if (!params) return url

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    // undefined / null 表示「不传该参数」，而不是传字符串 "undefined"
    if (value === undefined || value === null) continue
    search.append(key, String(value))
  }

  const query = search.toString()
  if (!query) return url
  return `${url}${url.includes('?') ? '&' : '?'}${query}`
}

/** 尽力解析响应体：网关返回的 HTML 错误页等非 JSON 内容不在这里抛错 */
async function readPayload(res: Response): Promise<unknown | typeof EMPTY_BODY | typeof INVALID_BODY> {
  if (res.status === 204) return EMPTY_BODY

  const text = await res.text().catch(() => '')
  if (!text.trim()) return EMPTY_BODY

  try {
    return JSON.parse(text)
  } catch {
    return INVALID_BODY
  }
}

/** 后端常用 message / msg / error 传业务错误文案 */
function extractMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined

  const record = payload as Record<string, unknown>
  for (const key of ['message', 'msg', 'error']) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

async function request<T>(method: string, path: string, config: RequestConfig = {}): Promise<T> {
  const { params, body, headers: extraHeaders, timeout = TIMEOUT, signal } = config

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  signal?.addEventListener('abort', () => controller.abort(), { once: true })

  const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  // 已登录就带上令牌。没登录时不带（登录接口自己就是这条路径）
  const token = tokenProvider()
  if (token) headers.Authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(buildUrl(path, params), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
  } catch (err) {
    // fetch 只在网络层失败时 reject：断网、跨域、以及被 abort 的超时
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    throw new HttpError(
      aborted ? `请求超时（${timeout}ms）` : '网络异常，无法连接服务器',
      0,
      undefined,
      true
    )
  } finally {
    window.clearTimeout(timer)
  }

  const payload = await readPayload(res)

  if (!res.ok) {
    const detail = payload === EMPTY_BODY || payload === INVALID_BODY ? undefined : payload

    // 401 = 会话失效（没登录 / 令牌过期 / 后端重启清了会话），送回登录页。
    // 但**登录接口自己的 401 要排除** —— 那是「口令不对」，触发跳转只会
    // 让用户输错一次密码就莫名其妙刷新一遍页面，看不到错误提示。
    // 403 不跳转：已登录但角色不够，页面就地提示才有信息量。
    if (res.status === 401 && !path.startsWith('/auth/login')) unauthorizedHandler?.()

    // 404 视同「这个接口还没实现」、5xx 视同「后端有问题」，都可降级；
    // 其余 4xx 是请求本身不合法（参数错误、没权限、没登录），必须暴露出来。
    const degradable = res.status === 404 || res.status >= 500
    throw new HttpError(
      extractMessage(detail) ?? `请求失败：${res.status} ${res.statusText}`,
      res.status,
      detail,
      degradable
    )
  }

  // 2xx 却不是 JSON：多半是反向代理把接口请求兜底成了 index.html（后端还没就绪）
  if (payload === INVALID_BODY) {
    throw new HttpError(
      `接口返回的不是 JSON（${BASE_URL}${path}），请确认后端已就绪`,
      res.status,
      undefined,
      true
    )
  }

  return (payload === EMPTY_BODY ? undefined : payload) as T
}

/**
 * 带降级的请求：接口不可用时返回内置 mock 数据。
 *
 * 各业务模块统一走这个函数，这样「后端没就绪」不会影响任何页面。
 *
 * @param path 接口路径
 * @param mock 降级数据。传函数可以每次返回新对象，避免共享同一份引用被改坏
 */
export async function requestWithFallback<T>(
  path: string,
  mock: T | (() => T),
  config: RequestConfig = {}
): Promise<T> {
  const resolveMock = () => (typeof mock === 'function' ? (mock as () => T)() : mock)
  const key = degradationKey(path)

  // 这个路径已经确认不可用了，直接给内置数据，不再浪费一次超时等待
  if (degradedPaths.has(key) && ALLOW_MOCK_FALLBACK) return resolveMock()

  try {
    return await request<T>(config.method ?? 'GET', path, config)
  } catch (err) {
    if (err instanceof HttpError && err.degradable && ALLOW_MOCK_FALLBACK) {
      // 只记这一个路径 —— 见 `degradedPaths` 上方关于「毒化」的说明
      degradedPaths.add(key)
      return resolveMock()
    }
    throw err
  }
}

/** 统一请求入口：get / post / put / delete，返回值按泛型 T 约束 */
export const http = {
  get<T>(path: string, params?: QueryParams, options?: RequestOptions): Promise<T> {
    return request<T>('GET', path, { ...options, params })
  },
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>('POST', path, { ...options, body })
  },
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>('PUT', path, { ...options, body })
  },
  delete<T>(path: string, params?: QueryParams, options?: RequestOptions): Promise<T> {
    return request<T>('DELETE', path, { ...options, params })
  },
  /** 接口未就绪时返回内置 mock 数据 */
  withFallback: requestWithFallback
}
