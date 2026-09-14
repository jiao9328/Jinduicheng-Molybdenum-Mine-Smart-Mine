import type { Router } from 'vue-router'
import { useUserStore } from '@/stores/user'

/**
 * 路由守卫 —— 进系统先登录。
 *
 * ## 默认关，例外开（fail-closed）
 *
 * 判定写成「**除非路由显式标了 `meta.public`，否则一律要求登录**」，而不是
 * 「标了 `requiresAuth` 的才要求登录」。两种写法对今天的 8 条路由结果一样，
 * 但以后加页面时差别就出来了：默认开的话，**忘了加标记 = 悄悄放出去一个
 * 不需要登录的页面**，而且不会有任何报错；默认关的话，忘了加标记最多是
 * 多要一次登录，一眼就能看出不对。前者是安全问题，后者只是体验问题。
 *
 * ## 这里不是权限边界
 *
 * 守卫只决定「能不能进这个页面的界面」。真正的权限判定在后端 —— 见
 * `server/routes.mjs` 的 `requireAdmin`。改掉 localStorage 里的 role 能骗过
 * 这个守卫进到数据管理页，但页面里每一个写操作照样会被后端 403 挡回来。
 * 这与 README §13 第 4 条立的规矩一致。
 */
export function setupRouterGuard(router: Router): void {
  router.beforeEach((to) => {
    const store = useUserStore()

    // 登录页本身是唯一的例外，不拦
    if (to.meta.public === true) {
      // 已经登录了就别再停在登录页
      return store.isLoggedIn ? { path: '/' } : true
    }

    if (!store.isLoggedIn) {
      // 记下原目标，登录后跳回去。
      // 首页不记 —— 它是绝大多数会话的起点，`/login?redirect=/` 这种地址很难看
      const redirect = to.fullPath === '/' ? undefined : to.fullPath
      return { path: '/login', query: redirect ? { redirect } : undefined }
    }

    // 角色不够就退回首页。这里**不回 403 页**：全站只有「数据管理」一个
    // 受限页面，为它单建一个错误页不值得，退回首页 + 顶栏里不显示那个入口
    // 已经足够清楚
    if (to.meta.roles && (!store.user || !to.meta.roles.includes(store.user.role))) {
      return { path: '/' }
    }

    return true
  })
}
