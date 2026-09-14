import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { setupRouterGuard } from './router/guard'
import { setAuthHandlers } from './api/http'
import { useUserStore } from './stores/user'

import 'element-plus/theme-chalk/dark/css-vars.css'
// Cesium 的控件样式必须全局引入：它定义了 .cesium-viewer / canvas 的尺寸，
// 缺了会导致画布塌成浏览器默认的 300×150
import 'cesium/Build/Cesium/Widgets/widgets.css'
import '@/styles/global.scss'

// Cesium 的 Worker / Assets / Widgets 是运行时按此路径动态加载的静态资源，
// 由 scripts/copy-cesium-assets.mjs 从 node_modules/cesium/Build/Cesium 拷贝到 public/cesium。
// 必须在任何 Cesium 代码执行前设置好。
;(window as any).CESIUM_BASE_URL = 'cesium/'

const app = createApp(App)

app.use(createPinia())

// 装会话状态与守卫。**顺序要紧**：
// 1. 先 restore()，让守卫第一次跑的时候就能看到「上次登录过」；
// 2. setAuthHandlers 要在任何接口调用之前接上（顶栏的天气请求马上就发）；
// 3. setupRouterGuard 要在 app.use(router) 之前 —— use(router) 会立刻开始
//    首次导航，守卫挂晚了第一次导航就不受管辖。
const userStore = useUserStore()
userStore.restore()

setAuthHandlers({
  getToken: () => userStore.token || null,
  onUnauthorized: () => {
    // 会话失效（令牌过期 / 后端重启清了会话）：清本地并回登录页。
    // 用 location.hash 而不是 router.push：请求层不依赖 router，
    // 且此刻正在导航中的可能性存在，直接改 hash 最不容易打架
    userStore.clear()
    if (!window.location.hash.startsWith('#/login')) {
      window.location.hash = '#/login'
    }
  }
})

setupRouterGuard(router)
app.use(router)

app.mount('#app')
