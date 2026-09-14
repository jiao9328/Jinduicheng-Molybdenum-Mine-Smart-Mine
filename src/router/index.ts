import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

/**
 * 路由 meta 类型扩展。
 * 顶栏与 `App.vue` 都要读这些字段，集中声明可以让它们保持 string/boolean 类型
 * 而不是 unknown，免得每处都写 as 断言。
 */
declare module 'vue-router' {
  interface RouteMeta {
    /** 顶栏与浏览器标题 */
    title?: string
    /** 开发工具页：需要填满真实窗口，跳过 1920×1080 等比缩放容器（见 App.vue） */
    fullscreen?: boolean
  }
}

/**
 * 路由结构见开发指导文档第 10 节
 * 使用 hash 模式：大屏常以静态文件方式部署，无需服务端 rewrite
 *
 * **本平台没有登录，也没有权限校验**：路由整体开放，打开任意地址都能直接看到页面。
 * 曾经每条业务路由都带 `requiresAuth: true` 与 `permission: '<权限码>'`，
 * 由 `router/guard.ts` 在导航前拦一道、不通过跳 `/login` 或 `/403`。
 * 登录 + 权限体系已整体移除（理由与记录见 README §13），meta 里那两个字段随之删除。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'overview',
    component: () => import('@/views/OverviewView.vue'),
    meta: { title: '综合管控平台' }
  },
  {
    path: '/safety',
    name: 'safety',
    component: () => import('@/views/SafetyView.vue'),
    meta: { title: '安全管理' }
  },
  {
    path: '/production',
    name: 'production',
    component: () => import('@/views/ProductionView.vue'),
    meta: { title: '生产管理' }
  },
  {
    path: '/equipment',
    name: 'equipment',
    component: () => import('@/views/EquipmentView.vue'),
    meta: { title: '设备管理' }
  },
  {
    path: '/emergency',
    name: 'emergency',
    component: () => import('@/views/EmergencyView.vue'),
    meta: { title: '应急救援' }
  },
  {
    path: '/digital-twin',
    name: 'digitalTwin',
    component: () => import('@/views/DigitalTwinView.vue'),
    meta: { title: '数字孪生' }
  },
  {
    path: '/decision',
    name: 'decision',
    component: () => import('@/views/DecisionView.vue'),
    meta: { title: '分析决策' }
  },
  {
    // 开发工具：把三维模型对齐到底图真实地物的坐标拾取页。
    // 不是业务页面，不进顶栏、不进巡检清单，但**保留**——它调模型时用得上。
    path: '/coord-picker',
    name: 'coordPicker',
    component: () => import('@/views/CoordPickerView.vue'),
    meta: { title: '坐标拾取', fullscreen: true }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/'
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach((to) => {
  // 每条路由都自带 meta.title，直接用它。
  // 曾经这里还有一条「按路径回查 nav 配置」的兜底，那是给共用一个路由记录的
  // 占位页（`/module/:key`）用的——占位页已随「规划中」Tab 一起移除，兜底跟着删。
  const title = (to.meta?.title as string | undefined) ?? '智慧矿山管理平台'
  document.title = `${title} - 智慧矿山管理平台`
})

export default router
