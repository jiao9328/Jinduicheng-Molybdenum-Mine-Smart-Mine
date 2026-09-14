<template>
  <header class="app-header">
    <!-- 左侧导航 -->
    <nav v-if="showNav" class="app-header__nav app-header__nav--left">
      <button
        v-for="item in HEADER_NAV_LEFT"
        :key="item.label"
        class="app-header__tab"
        :class="{ 'is-active': isActive(item) }"
        type="button"
        @click="go(item)"
      >
        {{ item.label }}
      </button>
    </nav>

    <!-- 标题区 -->
    <div class="app-header__center">
      <h1 class="app-header__title">{{ resolvedTitle }}</h1>
      <div v-if="showNav" class="app-header__meta">
        <span class="app-header__meta-item">
          <span class="app-header__meta-icon">◷</span>
          {{ clock }}
        </span>
        <span class="app-header__meta-divider" />
        <span class="app-header__meta-item">{{ weather.text }} {{ weather.temp }}</span>
      </div>
    </div>

    <!-- 右侧导航 -->
    <nav v-if="showNav" class="app-header__nav app-header__nav--right">
      <button
        v-for="item in HEADER_NAV_RIGHT"
        :key="item.label"
        class="app-header__tab"
        :class="{ 'is-active': isActive(item) }"
        type="button"
        @click="go(item)"
      >
        {{ item.label }}
      </button>
    </nav>

    <!--
      页面级操作区 —— 调用方用 #extra 往顶栏里塞控件（06 分析决策页的四维切换条走这里）。

      放顶栏而不是页面内容区，是为了**不占内容区高度**：页面 grid 的行高是精算过的
      （见 check-panel-overflow），多插一行会把所有面板挤矮 40px 并可能触发溢出告警。
      顶栏这 84px 是固定高度，塞在这里对 grid 零影响。

      只在真的传了 #extra 时才渲染 ⇒ 其余页面顶栏与加这个槽之前**完全一致**。
    -->
    <div v-if="$slots.extra" class="app-header__actions">
      <slot name="extra" />
    </div>

    <!--
      账号区 —— 当前用户 + 数据源 + 退出。

      **不做成 #extra 槽的内容**：顶栏是每个页面各自渲染的（6 个视图各写一次
      <AppHeader>），塞进槽里就要改 6 个文件，而且新页面一定会漏。
      这里直接由顶栏自己渲染，所有页面自动都有。

      用户名与角色来自本地会话（`stores/user.ts`），**它只是显示**；
      「数据管理」入口按角色显示，但也只是不让人白点 —— 真正的拦截在后端
      （README §13 第 4 条）。
    -->
    <div class="app-header__user">
      <!-- 数据源角标：库通了显示「数据库 + 各表条数」，没通显示「演示数据」。
           加它的原因见 api/http.ts 里 degradedPaths 那段说明 ——
           「接了数据库却还在看演示数据」是这套结构最容易出的错，得让它可见 -->
      <span class="app-header__source" :class="{ 'is-demo': !dbConnected }" :title="sourceTitle">
        {{ dbConnected ? '数据库' : '演示数据' }}
      </span>

      <span class="app-header__account">
        <span class="app-header__account-name">{{ userStore.displayName }}</span>
        <span class="app-header__account-role">{{ roleLabel }}</span>
      </span>

      <button
        v-if="userStore.isAdmin"
        class="app-header__user-btn"
        type="button"
        @click="router.push('/data-admin')"
      >
        数据管理
      </button>
      <button class="app-header__user-btn" type="button" @click="onLogout">退出</button>
    </div>

    <!-- 子页面：返回首页（用 !showNav 而不是 v-else：上面插了一个 div，相邻关系断了） -->
    <button v-if="!showNav" class="app-header__home" type="button" @click="router.push('/')">
      <span class="app-header__home-icon">⌂</span>
      <span>返回首页</span>
    </button>

    <!--
      顶栏第二行左右两侧的系统分组标题：纯静态展示，不是导航项。
      放在最后是为了不打乱上面「右导航 v-if ↔ 返回按钮 v-else」的相邻关系。
      绝对定位，DOM 顺序不影响落点。
    -->
    <template v-if="showNav">
      <span class="app-header__group app-header__group--left">{{ GROUP_TITLES.left }}</span>
      <span class="app-header__group app-header__group--right">{{ GROUP_TITLES.right }}</span>
    </template>
  </header>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  HEADER_GROUP_TITLES as GROUP_TITLES,
  HEADER_NAV_LEFT,
  HEADER_NAV_RIGHT,
  PAGE_TITLES,
  type NavItem
} from '@/config/nav'
import { formatDate } from '@/utils/format'
import { useAsyncData } from '@/hooks/useAsyncData'
import { fetchWeather, type WeatherInfo } from '@/api/overview'
import { fetchHealth, type HealthInfo } from '@/api/auth'
import { useUserStore } from '@/stores/user'

const props = withDefaults(
  defineProps<{
    /** 是否展示左右导航 Tab（首页展示，子页面只留标题 + 返回） */
    showNav?: boolean
    /** 覆盖标题，不传按当前路由取 */
    title?: string
  }>(),
  { showNav: true, title: '' }
)

const route = useRoute()
const router = useRouter()

const resolvedTitle = computed(
  () => props.title || PAGE_TITLES[route.path]?.title || PAGE_TITLES['/'].title
)

// ---------- 实时时钟 ----------
const clock = ref(formatDate(new Date()))
let timer: number | undefined

onMounted(() => {
  timer = window.setInterval(() => {
    clock.value = formatDate(new Date())
  }, 1000)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

// ---------- 天气 ----------
/**
 * 与页面数据一样走接口层，后端未就绪时由 requestWithFallback 降级到内置数据。
 * 顶栏在每个页面都渲染，初始值给字段齐全的空结构，避免加载完成前模板读到 undefined。
 */
const { data: weather } = useAsyncData(fetchWeather, { text: '', temp: '' } as WeatherInfo)

// ---------- 会话与数据源 ----------
const userStore = useUserStore()

const ROLE_LABELS: Record<string, string> = { admin: '管理员', user: '普通用户' }
const roleLabel = computed(() => ROLE_LABELS[userStore.user?.role ?? ''] ?? '')

/**
 * 后端健康检查。
 *
 * 这里**自己吞掉错误**（`.catch(() => null)`）：后端没起是这个平台的正常用法
 * 之一（纯前端演示），而 `fetchHealth` 刻意不降级、会抛错。不吞的话
 * `useAsyncData` 会在每个页面的控制台各刷一条「数据加载失败」，
 * 把真正该看的错误淹掉。
 */
const { data: health } = useAsyncData(() => fetchHealth().catch(() => null), null as HealthInfo | null)

const dbConnected = computed(() => health.value?.ok === true)

/** 悬停提示：各表条数。这比一个孤零零的「数据库」字样有用得多 */
const sourceTitle = computed(() => {
  if (!dbConnected.value) {
    return '未连接后端，页面数据来自内置演示数据。执行 npm run serve 启动后端（8787）'
  }
  const labels: Record<string, string> = {
    quality_records: '质检记录',
    duty_schedule: '值班与交接班',
    spare_parts: '备件台账',
    hazard_disposals: '隐患处置'
  }
  const lines = Object.entries(health.value?.tables ?? {}).map(
    ([table, n]) => `${labels[table] ?? table}：${n} 条`
  )
  return `已连接后端数据库\n${lines.join('\n')}`
})

async function onLogout() {
  await userStore.logout()
  await router.replace('/login')
}

// ---------- 导航 ----------
// 顶栏数组里的每一项都指向真实页面，所以这里只有「高亮当前项」和「跳转」两件事。
// 曾经还有一套「规划中」标记（黄点 + 悬停提示），随那几个只有名字的 Tab 一起删了。

function isActive(item: NavItem) {
  return route.path === item.path
}

function go(item: NavItem) {
  if (route.path === item.path) return
  router.push(item.path)
}
</script>

<style lang="scss" scoped>
.app-header {
  position: relative;
  display: flex;
  align-items: center;
  height: $header-height;
  padding: 0 24px;
  background: url('@/assets/header-bg.svg') center bottom / 100% 100% no-repeat;
}

// ---------- 标题 ----------
.app-header__center {
  position: absolute;
  left: 50%;
  top: 8px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}

.app-header__title {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 4px;
  color: #ffffff;
  background: linear-gradient(180deg, #ffffff 30%, $primary 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 0 12px rgba($primary, 0.7));
}

.app-header__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 2px;
  font-size: $fs-small;
  color: $text-secondary;
}

.app-header__meta-icon {
  margin-right: 4px;
  color: $primary;
}

.app-header__meta-divider {
  width: 1px;
  height: 10px;
  background: $border-panel;
}

// ---------- 导航 Tab ----------
.app-header__nav {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  height: 100%;

  &--right {
    justify-content: flex-end;
  }
}

.app-header__tab {
  position: relative;
  flex-shrink: 0;
  height: 28px;
  padding: 0 10px;
  font-family: $font-title;
  font-size: $fs-small;
  color: $text-secondary;
  background: transparent;
  border: 1px solid transparent;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: color 0.2s, background 0.2s, border-color 0.2s;

  &:hover {
    color: $primary;
    background: $bg-hover;
  }

  &.is-active {
    color: $primary;
    border-color: $border-panel;
    background: linear-gradient(180deg, rgba(0, 229, 255, 0.22) 0%, rgba(0, 229, 255, 0.06) 100%);
    @include glow-text($primary, 6px);
  }
}

// ---------- 第二行：系统分组标题 ----------
// 与顶栏左右内边距对齐（.app-header 的 padding: 0 24px），所以这里写死 24px。
// 字号 14px 对比导航 Tab 的 12px，对应「分组标题字号更大」。
// pointer-events: none 是双保险：即便将来布局变化压到导航上，也不会挡掉点击。
.app-header__group {
  position: absolute;
  bottom: 6px;
  font-family: $font-title;
  font-size: 14px;
  letter-spacing: 3px;
  color: $text-secondary;
  pointer-events: none;

  &--left {
    left: 24px;
  }

  &--right {
    right: 24px;
  }
}

// ---------- 页面级操作区（#extra） ----------
// margin-left: auto 把它连同它右边的一切推到最右；
// 与下面的返回按钮并排时，两个 auto 会**平分**剩余空间，
// 于是两者之间裂开一道缝——所以紧跟在它后面的返回按钮要交回 auto，
// 让整组靠右贴合（见下一条规则）。
.app-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.app-header__actions + .app-header__home {
  margin-left: 0;
}

// ---------- 账号区 ----------
// 右对齐仍然只靠**一个** margin-left: auto：这个块自己吃 auto，
// 排在它前后（#extra / 返回按钮）的块统统交回 0。
// 两个 auto 会平分剩余空间，中间裂开一道缝 —— 这正是上面 `.actions + .home`
// 那条规则存在的原因，这里把它扩展到三个元素的任意相邻组合。
.app-header__user {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: auto;
}

.app-header__actions + .app-header__user,
.app-header__user + .app-header__home {
  margin-left: 0;
}

// 数据源角标：库通了是青色，没通是橙色 —— 颜色别只做装饰，
// 「正在看演示数据」这件事值得一眼看出来
.app-header__source {
  padding: 2px 8px;
  font-size: $fs-subtitle;
  letter-spacing: 1px;
  color: $primary;
  background: rgba(0, 229, 255, 0.1);
  border: 1px solid $border-panel;
  border-radius: 9px;
  cursor: help;

  &.is-demo {
    color: #ff9f1c;
    background: rgba(255, 159, 28, 0.1);
    border-color: rgba(255, 159, 28, 0.45);
  }
}

.app-header__account {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: $fs-small;
}

.app-header__account-name {
  color: $text-primary;
}

.app-header__account-role {
  color: $text-muted;
}

.app-header__user-btn {
  height: 24px;
  padding: 0 10px;
  font-family: $font-title;
  font-size: $fs-small;
  color: $text-secondary;
  background: transparent;
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: color 0.2s, border-color 0.2s, background 0.2s;

  &:hover {
    color: $primary;
    border-color: $border-panel;
    background: $bg-hover;
  }
}

// ---------- 子页面返回按钮 ----------
.app-header__home {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  height: 30px;
  padding: 0 14px;
  font-family: $font-title;
  font-size: $fs-small;
  color: $primary;
  background: rgba(0, 229, 255, 0.08);
  border: 1px solid $border-panel;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: background 0.2s;

  &:hover {
    background: rgba(0, 229, 255, 0.2);
  }
}

.app-header__home-icon {
  font-size: 15px;
}
</style>
