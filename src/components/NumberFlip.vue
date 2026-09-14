<template>
  <span class="number-flip">{{ display }}</span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

/**
 * 数字滚动动画
 * 数值变化时从旧值缓动到新值，缓出曲线，用于指标卡 / 大屏数字。
 */
const props = withDefaults(
  defineProps<{
    value: number
    /** 保留小数位 */
    decimals?: number
    /** 动画时长 ms */
    duration?: number
  }>(),
  {
    decimals: 0,
    duration: 1200
  }
)

const display = ref(format(props.value))
let raf = 0

function format(v: number) {
  return v.toFixed(props.decimals)
}

function animate(to: number, from: number) {
  if (raf) cancelAnimationFrame(raf)

  // 尊重用户的减少动效偏好
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduceMotion || props.duration <= 0) {
    display.value = format(to)
    return
  }

  const start = performance.now()
  const delta = to - from

  const tick = (now: number) => {
    const p = Math.min((now - start) / props.duration, 1)
    // easeOutCubic
    const eased = 1 - Math.pow(1 - p, 3)
    display.value = format(from + delta * eased)
    if (p < 1) {
      raf = requestAnimationFrame(tick)
    } else {
      display.value = format(to)
      raf = 0
    }
  }

  raf = requestAnimationFrame(tick)
}

watch(
  () => props.value,
  (to, from) => animate(to, from ?? 0)
)

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
})
</script>

<style lang="scss" scoped>
.number-flip {
  font-family: $font-number;
  font-variant-numeric: tabular-nums;
}
</style>
