import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  fetchMe,
  login as loginRequest,
  logout as logoutRequest,
  type SessionUser
} from '@/api/auth'
import { resetDegraded } from '@/api/http'

/**
 * 会话状态 —— 本仓库**第一个** Pinia store。
 *
 * 之前没有 store 是因为全站没有跨页面的共享状态：每个页面的数据都由
 * `useAsyncData` 自己拿、自己用完就扔。登录态是第一个**必须横跨所有页面**
 * 的东西（顶栏要显示当前用户、路由守卫要判角色、请求层要取 token），
 * 所以从这里开始用 store。
 *
 * ## 存 localStorage 的东西是「体验」不是「权限」
 *
 * token 与用户名持久化只是为了刷新页面不用重新登录。**它不构成任何安全
 * 保证** —— 用户随手就能改 localStorage 把自己扮成 admin。真正的拦截在
 * 后端：`server/routes.mjs` 里每个写接口都单独校验 `role === 'admin'`，
 * 越权一律 403。前端这份状态只用来决定「显示什么」。
 *
 * 这与 README §13 第 4 条立的规矩一致：**前端裁剪界面从来不是安全边界**。
 */
const STORAGE_KEY = 'smart-mine.session'

/** localStorage 在隐私模式 / 禁用 Cookie 时会直接抛异常，不能裸调 */
function readStored(): { token: string; user: SessionUser } | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.token === 'string' && parsed?.user?.username) {
      return { token: parsed.token, user: parsed.user as SessionUser }
    }
    return null
  } catch {
    return null
  }
}

function writeStored(value: { token: string; user: SessionUser } | null): void {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 存不下就只影响「刷新后要重新登录」，不该让整站崩掉
  }
}

export const useUserStore = defineStore('user', () => {
  const token = ref('')
  const user = ref<SessionUser | null>(null)
  /** 正在登录 —— 登录按钮据此禁用，防重复提交 */
  const loading = ref(false)

  const isLoggedIn = computed(() => Boolean(token.value && user.value))
  const isAdmin = computed(() => user.value?.role === 'admin')
  const displayName = computed(() => user.value?.displayName || user.value?.username || '')

  /** 从 localStorage 恢复。在 `main.ts` 里、路由守卫之前调一次 */
  function restore(): void {
    const stored = readStored()
    if (!stored) return
    token.value = stored.token
    user.value = stored.user
  }

  function setSession(nextToken: string, nextUser: SessionUser): void {
    token.value = nextToken
    user.value = nextUser
    writeStored({ token: nextToken, user: nextUser })

    // **必须清降级记录**：上一次会话里若记下过「后端没起」，不清的话
    // 这次登录后所有请求会被直接短路成内置数据 ——
    // 用户会看到「登录成功了，但数据全是演示数据」
    resetDegraded()
  }

  function clear(): void {
    token.value = ''
    user.value = null
    writeStored(null)
  }

  /**
   * 登录。失败时把后端的文案抛出去（「用户名或口令不正确」），
   * 由页面决定怎么显示 —— store 不碰视图。
   */
  async function login(username: string, password: string): Promise<void> {
    loading.value = true
    try {
      const { token: nextToken, user: nextUser } = await loginRequest(username, password)
      setSession(nextToken, nextUser)
    } finally {
      loading.value = false
    }
  }

  /** 登出。**无论后端是否成功都清本地** —— 否则后端一挂就退不出登录 */
  async function logout(): Promise<void> {
    try {
      await logoutRequest()
    } catch (err) {
      console.warn('[auth] 登出接口失败，仍清空本地会话：', err)
    }
    clear()
  }

  /**
   * 拿服务端的当前用户，用来确认本地 token 还没失效。
   * 失败一律返回 false 并清会话，不抛错 —— 调用方只关心「这个 token 还能用吗」。
   */
  async function verify(): Promise<boolean> {
    if (!token.value) return false
    try {
      const { user: fresh } = await fetchMe()
      user.value = fresh
      writeStored({ token: token.value, user: fresh })
      return true
    } catch {
      clear()
      return false
    }
  }

  return {
    token,
    user,
    loading,
    isLoggedIn,
    isAdmin,
    displayName,
    restore,
    setSession,
    clear,
    login,
    logout,
    verify
  }
})
