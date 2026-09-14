<template>
  <div ref="el" class="echart-box" :style="{ height: resolvedHeight }" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import type { EChartsOption, ECharts } from 'echarts'
import { withTheme } from '@/utils/chartTheme'

/**
 * ECharts 容器
 * - 自动注入深色主题
 * - 容器尺寸变化自动 resize（大屏缩放 / 面板折叠都依赖这个）
 * - 组件卸载自动销毁实例
 */
const props = withDefaults(
  defineProps<{
    /** 图表配置，会自动合并深色主题 */
    option: EChartsOption
    /** 高度，数字按 px 处理 */
    height?: string | number
    /** 是否主题合并，特殊图表可关掉 */
    themed?: boolean
    /** 是否监听点击事件 */
    clickable?: boolean
  }>(),
  {
    height: 200,
    themed: true,
    clickable: false
  }
)

const emit = defineEmits<{
  (e: 'click', params: any): void
}>()

const el = ref<HTMLDivElement>()
let chart: ECharts | null = null
let observer: ResizeObserver | null = null

const resolvedHeight = computed(() => {
  const h = props.height
  if (typeof h === 'number') return `${h}px`
  // 已经是百分比 / vh / calc 等合法 CSS 值时原样透传，只有纯数字字符串才补单位
  return /^\d+(\.\d+)?$/.test(h) ? `${h}px` : h
})

function buildOption(): EChartsOption {
  return props.themed ? withTheme(props.option as Record<string, any>) : props.option
}

function render() {
  if (!chart) return
  // notMerge=true：主题合并后每次全量替换，避免残留旧系列
  chart.setOption(buildOption(), true)
}

onMounted(() => {
  if (!el.value) return

  chart = echarts.init(el.value, undefined, { renderer: 'canvas' })
  render()

  if (props.clickable) {
    chart.on('click', (params) => emit('click', params))
  }

  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(el.value)
})

watch(
  () => props.option,
  () => render(),
  { deep: true }
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  chart?.dispose()
  chart = null
})

defineExpose({
  /** 拿到原生实例做特殊操作（如 dispatchAction） */
  getInstance: () => chart
})
</script>

<style lang="scss" scoped>
.echart-box {
  width: 100%;
}
</style>
