import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import type { UserRole } from '@/api/auth'

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
    /** 免登录页面。只有登录页标了它 —— 其余页面**默认都要求登录**（见 guard.ts） */
    public?: boolean
    /** 允许访问的角色。不写即「登录即可」，写了就按角色拦（见 guard.ts） */
    roles?: UserRole[]
  }
}

/**
 * 路由结构见开发指导文档第 10 节
 * 使用 hash 模式：大屏常以静态文件方式部署，无需服务端 rewrite
 *
 * **进系统先登录**：除登录页外所有路由都要求已登录，由 `router/guard.ts`
 * 在导航前拦一道。这里不写 `requiresAuth` 之类的字段是**有意的** ——
 * 守卫按「默认要求登录、标了 `public` 才放开」判定（fail-closed），
 * 新增路由忘了加标记只会多要一次登录，而不是悄悄放出一个人人可进的页面。
 * 「数据管理」额外限制为管理员：`roles: ['admin']`。
 *
 * 登录 + 权限体系曾按用户指令整体移除过（README §13 第 4 条），本次按新指令
 * 加回来，与那条的关系记在 §13 第 30 条。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    // fullscreen：登录页要做满整个窗口，不能套在 1920×1080 的等比缩放容器里
    meta: { title: '登录', fullscreen: true, public: true }
  },
  {
    path: '/',
    name: 'overview',
    component: () => import('@/views/OverviewView.vue'),
    meta: { title: '综合管控平台' }
  },
  {
    // 数据管理：四张台账的增删改查。**只有管理员进得来**，
    // 且真正的拦截在后端写接口上（前端这道只是不让人白点）
    path: '/data-admin',
    name: 'dataAdmin',
    component: () => import('@/views/DataAdminView.vue'),
    meta: { title: '数据管理', roles: ['admin'] }
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
