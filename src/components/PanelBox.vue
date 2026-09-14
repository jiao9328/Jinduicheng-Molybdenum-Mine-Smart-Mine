<template>
  <section class="panel-box" :class="{ 'is-plain': plain }" :style="{ height: height || undefined }">
    <header v-if="title" class="panel-box__head">
      <span class="panel-box__bar" />
      <h3 class="panel-box__title">{{ title }}</h3>
      <span v-if="subtitle" class="panel-box__subtitle">{{ subtitle }}</span>
      <div class="panel-box__extra">
        <slot name="extra" />
      </div>
    </header>
    <div class="panel-box__body" :style="{ padding: bodyPadding }">
      <slot />
    </div>
    <!--
      可选底栏。只在调用方真的写了 #footer 时才渲染（$slots 判定），
      不写就与加这个槽之前**完全一致**——高度、边框、留白都不变。
      底栏不参与 body 的滚动：body 是 flex:1 + overflow:hidden，
      底栏 flex-shrink:0，所以正文再长也是正文自己滚，按钮永远钉在底部。
    -->
    <footer v-if="$slots.footer" class="panel-box__foot">
      <slot name="footer" />
    </footer>
  </section>
</template>

<script setup lang="ts">
/**
 * 科技边框面板 —— 四角切角 + 发光描边 + 标题栏
 * 大屏里所有数据模块的外壳，统一视觉。
 */
withDefaults(
  defineProps<{
    /** 中文标题 */
    title?: string
    /** 英文副标题，小字灰色 */
    subtitle?: string
    /** 面板高度，不传则由内容撑开 */
    height?: string | number
    /** 去掉内边距，图表类模块常需要贴边 */
    plain?: boolean
    /** 覆盖默认内边距 */
    bodyPadding?: string
  }>(),
  {
    title: '',
    subtitle: '',
    height: '',
    plain: false,
    bodyPadding: ''
  }
)
</script>

<style lang="scss" scoped>
.panel-box {
  @include panel-surface;
  @include corner-brackets(12px, 2px, $primary);
  display: flex;
  flex-direction: column;
  min-height: 0;

  &.is-plain {
    background: transparent;
    border: none;
    backdrop-filter: none;

    &::before,
    &::after {
      display: none;
    }
  }
}

.panel-box__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-shrink: 0;
  height: 38px;
  padding: 0 12px;
  border-bottom: 1px solid $border-soft;
  background: linear-gradient(180deg, rgba(0, 229, 255, 0.08) 0%, transparent 100%);
}

.panel-box__bar {
  align-self: center;
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: linear-gradient(180deg, $primary 0%, $primary-dim 100%);
  box-shadow: 0 0 6px rgba($primary, 0.8);
}

.panel-box__title {
  font-size: $fs-title - 4px;
  font-weight: 600;
  color: $text-primary;
  letter-spacing: 1px;
}

.panel-box__subtitle {
  font-size: $fs-subtitle;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 1px;
  @include ellipsis;
}

.panel-box__extra {
  margin-left: auto;
  align-self: center;
  font-size: $fs-small;
  color: $text-secondary;
}

.panel-box__body {
  flex: 1;
  min-height: 0;
  padding: 10px 12px;
  /*
   * 补充件第 2 号 §3.2 定的规范：面板内图表一律 height:100% 自适应，
   * 这里再兜一道 overflow: hidden。
   * 图表都是百分比高度的计算容器，正常不会溢出；加这一条是防止
   * 某个页面写死高度或数据把轴标签撑长时，内容**压到相邻面板上**——
   * 大屏上那种「两块面板叠字」极难排查，裁掉比糊在一起好定位。
   */
  overflow: hidden;
}

.panel-box__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 12px;
  border-top: 1px solid $border-soft;
  background: linear-gradient(0deg, rgba(0, 229, 255, 0.06) 0%, transparent 100%);
}
</style>
