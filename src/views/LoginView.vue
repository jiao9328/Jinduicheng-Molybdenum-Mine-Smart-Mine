<template>
  <div class="login">
    <form class="login__card" @submit.prevent="onSubmit">
      <header class="login__head">
        <h1 class="login__title">智慧矿山管理平台</h1>
        <p class="login__subtitle">INTEGRATED MANAGEMENT PLATFORM FOR SMART MINES</p>
      </header>

      <label class="login__field">
        <span class="login__label">用户名</span>
        <input
          v-model.trim="username"
          class="login__input"
          type="text"
          name="username"
          autocomplete="username"
          autofocus
          placeholder="请输入用户名"
        />
      </label>

      <label class="login__field">
        <span class="login__label">口令</span>
        <input
          v-model="password"
          class="login__input"
          type="password"
          name="password"
          autocomplete="current-password"
          placeholder="请输入口令"
        />
      </label>

      <!--
        错误就地显示在按钮上方，不用 toast/弹窗：登录失败是**用户当下就要看、
        而且要看清楚**的信息（口令错 / 后端没起），飘一下就没的提示很容易被错过。
        role="alert" 让读屏软件也能念出来。
      -->
      <p v-if="errorText" class="login__error" role="alert">{{ errorText }}</p>

      <button class="login__submit" type="submit" :disabled="!canSubmit">
        {{ store.loading ? '登录中…' : '登 录' }}
      </button>

      <!--
        演示口令直接印在页面上。

        当年删掉登录墙的理由之一是「演示定位下登录墙只会挡住评审」（README §13
        第 4 条），把口令写在页面上正好化解这个顾虑：评审零成本进入，
        而管理员/普通用户的权限差异仍然真实存在。

        ⚠️ 这两行必须与 `server/auth.mjs` 的 `DEMO_ACCOUNTS` 保持一致。
        靠 `scripts/check-auth.mjs` 比对两边源码来防漂移 ——
        改了服务端忘了改这里，自检会红。
      -->
      <footer class="login__demo">
        <span class="login__demo-title">演示账号</span>
        <ul class="login__demo-list">
          <li v-for="account in DEMO_ACCOUNTS" :key="account.username">
            <button class="login__demo-item" type="button" @click="fill(account)">
              <span class="login__demo-user">{{ account.username }} / {{ account.password }}</span>
              <span class="login__demo-role">{{ account.role }}</span>
            </button>
          </li>
        </ul>
        <span class="login__demo-hint">点一下即可填入</span>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { HttpError } from '@/api/http'

/**
 * 登录页。
 *
 * 走 `meta.fullscreen: true`（见 `router/index.ts`）跳过 `ScaleScreen` 的
 * 1920×1080 等比缩放 —— 登录页要铺满真实窗口。**这一条不能少**：套在缩放
 * 容器里的话，窗口比 1920 窄时整页会被缩得很小、输入框跟着变形，而
 * 登录页恰恰是最可能在小窗口里被打开的一个（评审第一次进来就是它）。
 *
 * 表单控件是手写的 `<input>`/`<button>` 而**不是 `el-input`/`el-button`**：
 * 全库此前从未用过这两个组件（只用过 `el-table`），暗色表现没验证过；
 * 而本仓库对按钮/输入一律是手写样式（见 `.app-header__tab`、
 * `.production__export`）。沿用同一套变量与写法，视觉天然一致，
 * 也少一处没验证过的依赖。
 */
const route = useRoute()
const router = useRouter()
const store = useUserStore()

const username = ref('')
const password = ref('')
const errorText = ref('')

const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'admin123', role: '管理员 · 可增删改查' },
  { username: 'user', password: 'user123', role: '普通用户 · 只读' }
]

const canSubmit = computed(
  () => Boolean(username.value && password.value) && !store.loading
)

function fill(account: { username: string; password: string }) {
  username.value = account.username
  password.value = account.password
  errorText.value = ''
}

async function onSubmit() {
  if (!canSubmit.value) return
  errorText.value = ''

  try {
    await store.login(username.value, password.value)
  } catch (err) {
    // 口令错是 401（后端给了明确文案）；后端没起是网络错误。
    // 两者都要说人话，别把 HttpError 直接糊到界面上
    if (err instanceof HttpError) {
      errorText.value = err.status === 0 ? '无法连接服务器，请确认后端已启动（npm run serve）' : err.message
    } else {
      errorText.value = '登录失败，请重试'
    }
    return
  }

  // 登录前想去哪就回哪去。`redirect` 由守卫写入（见 guard.ts），
  // 它只会是站内路径 —— 这里仍只取 path，避免把整串 query 带进来
  const redirect = route.query.redirect
  const target = typeof redirect === 'string' && redirect.startsWith('/') ? redirect : '/'
  await router.replace(target)
}
</script>

<style lang="scss" scoped>
.login {
  // 这一页在 ScaleScreen 之外，铺满真实窗口
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(ellipse at 50% 0%, rgba(0, 229, 255, 0.12) 0%, transparent 60%),
    linear-gradient(180deg, $bg-deep 0%, $bg-base 100%);
  overflow: auto;
}

.login__card {
  @include panel-surface;
  @include corner-brackets(14px, 2px, $primary);
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 380px;
  max-width: calc(100vw - 32px);
  padding: 30px 32px 22px;
}

.login__head {
  text-align: center;
  margin-bottom: 4px;
}

.login__title {
  font-family: $font-title;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 4px;
  color: $text-primary;
  text-shadow: 0 0 16px rgba($primary, 0.6);
}

.login__subtitle {
  margin-top: 6px;
  font-size: $fs-subtitle;
  letter-spacing: 1px;
  color: $text-muted;
}

.login__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.login__label {
  font-size: $fs-small;
  letter-spacing: 1px;
  color: $text-secondary;
}

.login__input {
  height: 38px;
  padding: 0 12px;
  font-family: inherit;
  font-size: $fs-body;
  color: $text-primary;
  background: $bg-panel-soft;
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;

  &::placeholder {
    color: $text-muted;
  }

  &:focus {
    border-color: $border-panel;
    box-shadow: 0 0 10px rgba($primary, 0.25);
  }
}

.login__error {
  display: flex;
  align-items: center;
  min-height: 30px;
  padding: 0 10px;
  font-size: $fs-small;
  color: #ff7875;
  background: rgba(255, 77, 79, 0.12);
  border: 1px solid rgba(255, 77, 79, 0.4);
  border-radius: $radius-sm;
}

.login__submit {
  height: 40px;
  font-family: $font-title;
  font-size: 15px;
  letter-spacing: 4px;
  color: $bg-deep;
  background: linear-gradient(180deg, $primary 0%, $primary-dim 100%);
  border: none;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: filter 0.2s, opacity 0.2s;

  &:hover:not(:disabled) {
    filter: brightness(1.15);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

// ---------- 演示账号 ----------
.login__demo {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
  padding-top: 14px;
  border-top: 1px solid $border-soft;
}

.login__demo-title {
  font-size: $fs-small;
  letter-spacing: 1px;
  color: $text-muted;
}

.login__demo-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.login__demo-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  font-family: inherit;
  font-size: $fs-small;
  color: $text-body;
  background: $bg-hover;
  border: 1px solid transparent;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;

  &:hover {
    border-color: $border-panel;
    background: rgba(0, 229, 255, 0.16);
  }
}

.login__demo-user {
  color: $primary;
  letter-spacing: 1px;
}

.login__demo-role {
  color: $text-muted;
}

.login__demo-hint {
  font-size: $fs-small;
  color: $text-secondary;
}
</style>
