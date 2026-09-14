import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'

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
app.use(router)

// 曾经这里还要装两样东西：登录守卫（setupRouterGuard）与按钮级权限指令
// （setupPermissionDirective）。整套登录 + 权限体系已移除，页面直接可达，
// 理由与记录见 README §13。

app.mount('#app')
