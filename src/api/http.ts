/**
 * 统一请求层。
 *
 * 直接用 fetch 而不是再引一层请求库：接口数量有限，自己实现能完全掌控超时、
 * 降级与错误语义，也不必为这一件事增加依赖。
 *
 * 与后端约定的边界：
 * - 请求头统一带 `Accept: application/json`，写操作再带 `Content-Type`
 * - 非 2xx 与网络异常统一抛 HttpError，调用方只 catch 一种错误类型
 *
 * **本平台没有登录，请求层不带任何鉴权**：曾经这里会读 localStorage 里的 token
 * 拼 `Authorization` 头、并把 401 当会话失效清本地状态跳登录页。登录 + 权限体系
 * 已整体移除（理由见 README §13），401 现在退化成**普通的不可降级 4xx**
 * ——和 400/403 一样直接抛给调用方，不做任何跳转。
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
 * 当前是否处于降级模式（接口不可用，页面走内置数据）。
 *
 * **会话级**：一旦确认接口不可用就置位，之后所有请求直接给内置数据，
 * 不再各自白等一次超时。没有反向的重置入口——曾经有一个 `resetDegraded()`
 * 挂在「重新登录」上，登录体系移除后它成了死代码，一并删除。
 * 后端恢复后刷新页面即可重新尝试真实接口。
 */
let degraded = false

export function isUsingMockData(): boolean {
  return degraded
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
    // 404 视同「这个接口还没实现」、5xx 视同「后端有问题」，都可降级；
    // 其余 4xx 是请求本身不合法（参数错误等），必须暴露出来。
    // 401/403 也走这一支：本平台没有登录，它们就是普通的拒绝，不做任何跳转。
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

  // 已经确认接口不可用，直接给内置数据，不再浪费一次超时等待
  if (degraded && ALLOW_MOCK_FALLBACK) return resolveMock()

  try {
    return await request<T>(config.method ?? 'GET', path, config)
  } catch (err) {
    if (err instanceof HttpError && err.degradable && ALLOW_MOCK_FALLBACK) {
      degraded = true
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
