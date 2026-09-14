<template>
  <!--
    全屏遮罩浮层 —— 03 设备档案 / 04 操作指引 / 05 图层详情三处共用。

    ⚠️ **绝对不要给它加 teleport / append-to-body。**
    整站跑在 ScaleScreen 的 `transform: scale()` 里，浮层一旦被 teleport 到
    `<body>` 下就跳出了那个 transform，**不随大屏等比缩放**：在 1920 的屏上看着正常，
    换到别的分辨率立刻错位。原地渲染时 `.app-modal` 的绝对定位包含块是
    ScaleScreen 那个 1920×1080 的画布，缩放跟着一起走，这才是对的。

    ⚠️ **调用方必须把 <AppModal> 放在「内容区」的直接子节点位置，也就是 `.xxx__main`。**
    它的包含块决定浮层铺多大：

      `.xxx`（页面根，flex column）= AppHeader(84) + `.xxx__main`(996)
        └─ 放这里 ⇒ 包含块 1920×**1080**，浮层会连标题栏一起盖住；
      `.xxx__main`（position: relative，无内边距，正好是内容区）
        └─ 放这里 ⇒ 包含块 1920×**996**，压在 AppHeader 下方 ✓
      `.xxx__content`（有 16px 内边距）
        └─ 放这里 ⇒ 四周内缩一圈，看起来像没对齐，但**不报任何错** ✗

    三种都「能跑」、都不报错，所以这一条只能靠写清楚。页面根看起来更「像」
    浮层该挂的地方（它就叫「根」），但它多了 84px 的标题栏——**别挂在那里**。

    不加「点遮罩关闭」：大屏演示时误点一下就关掉了，讲的人还不知道为什么。
    关闭只有两个入口 —— 右上角 × 和底部按钮（或调用方自己的按钮）。
  -->
  <div v-if="modelValue" class="app-modal" role="dialog" aria-modal="true">
    <PanelBox
      class="app-modal__panel"
      :title="title"
      :subtitle="subtitle"
      :height="height"
      :style="{ width: `${width}px` }"
      body-padding="0"
    >
      <template #extra>
        <button class="app-modal__x" type="button" title="关闭" @click="close">×</button>
      </template>

      <div class="app-modal__body">
        <slot />
      </div>

      <!--
        底栏只在调用方真的写了 #footer 时才透传。
        无条件透传会让 PanelBox 永远渲染一条空底栏（它是按 $slots.footer 判定的），
        白白吃掉 40px 内容高度。
      -->
      <template v-if="$slots.footer" #footer>
        <slot name="footer" />
      </template>
    </PanelBox>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import PanelBox from '@/components/PanelBox.vue'

const props = withDefaults(
  defineProps<{
    /** 开关，配合 v-model 使用 */
    modelValue: boolean
    /** 面板标题，必填 —— 没有标题 PanelBox 就不渲染标题栏，右上角的关闭按钮会一起消失 */
    title: string
    /** 英文副标题 */
    subtitle?: string
    /** 面板宽度（px） */
    width?: number
    /** 面板高度（px）。内容超出时由正文区自己滚，标题栏与底栏不动 */
    height?: number
  }>(),
  { subtitle: '', width: 960, height: 640 }
)

const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

function close() {
  emit('update:modelValue', false)
}

/**
 * Esc 关闭。
 *
 * 挂在 window 而不是浮层自己身上：浮层里没有任何可聚焦元素，
 * 不给它加 tabindex 的话键盘事件根本落不到它头上。
 * 监听只在打开期间挂着，且**先摘后挂**，避免多次开关后叠出一堆监听器。
 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

function bind() {
  window.addEventListener('keydown', onKeydown)
}
function unbind() {
  window.removeEventListener('keydown', onKeydown)
}

watch(
  () => props.modelValue,
  (open) => (open ? bind() : unbind())
)

onMounted(() => {
  if (props.modelValue) bind()
})
// 组件在「打开着」的状态下被卸载（比如整页切走）时必须摘掉，
// 否则那个监听器会一直活着，下一次按 Esc 会去改一个已经不存在的组件
onBeforeUnmount(unbind)
</script>

<style lang="scss" scoped>
.app-modal {
  position: absolute;
  inset: 0;
  z-index: $z-modal;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4, 11, 26, 0.72);
  backdrop-filter: blur(2px);
}

.app-modal__panel {
  max-width: 100%;
  max-height: 100%;
}

.app-modal__x {
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
  color: $text-secondary;
  background: transparent;
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;

  &:hover {
    color: $primary;
    border-color: $border-panel;
  }
}

// 正文区自己滚，标题栏与底栏固定。
// PanelBox 的 body 是 flex:1 + overflow:hidden，所以这里必须显式 height:100%
// 才能把滚动条交给自己，而不是被外层裁掉。
.app-modal__body {
  height: 100%;
  padding: 14px 16px;
  overflow-y: auto;
  @include thin-scrollbar;
}
</style>
