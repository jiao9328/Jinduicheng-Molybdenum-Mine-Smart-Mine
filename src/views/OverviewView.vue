<template>
  <div class="overview">
    <AppHeader />

    <main class="overview__main">
      <!-- 中央三维场景 -->
      <div class="overview__map">
        <MapScene />
      </div>

      <!-- 顶部悬浮：生产计划进度 -->
      <div class="overview__plan">
        <PlanProgress :plans="PRODUCTION_PLANS" />
      </div>

      <!-- 左侧面板列 -->
      <div class="overview__side overview__side--left">
        <PanelBox title="采区人员分布" subtitle="PERSONNEL">
          <EchartBox :option="personnelOption" height="100%" />
        </PanelBox>

        <PanelBox title="班组运行状态" subtitle="TEAM STATUS">
          <EchartBox :option="teamOption" height="100%" />
        </PanelBox>

        <PanelBox title="重大危险源监控" subtitle="MAJOR HAZARD">
          <div class="overview__hazard">
            <div v-for="h in hazardMonitor" :key="h.label" class="overview__hazard-item">
              <span class="overview__hazard-value">{{ h.value }}</span>
              <span class="overview__hazard-label">{{ h.label }}</span>
            </div>
          </div>
        </PanelBox>
      </div>

      <!-- 右侧面板列 -->
      <div class="overview__side overview__side--right">
        <!--
          面板内图表一律 height="100%"（补充件第 2 号 §3.2），全项目已无写死像素高度的图表。
          这里曾写死 150：右侧栏是 flex 均分，补上「成本监控」由 3 块变 4 块后
          每块只剩约 195px，扣掉标题栏 38px 与内边距 20px 后图表可用约 137px，
          多出的 13px 会压到下一块面板上。百分比高度没有这个问题，
          以后再加面板也不用回头调数。
        -->
        <PanelBox title="产量统计" subtitle="OUTPUT">
          <EchartBox :option="outputOption" height="100%" />
        </PanelBox>

        <PanelBox title="成本监控" subtitle="COST">
          <EchartBox :option="costOption" height="100%" />
        </PanelBox>

        <PanelBox title="安全监控" subtitle="SAFETY">
          <div class="overview__gauges">
            <EchartBox
              v-for="g in safetyGauges"
              :key="g.label"
              :option="gaugeOption(g)"
              height="100%"
            />
          </div>
        </PanelBox>

        <PanelBox title="AI 视频监控" subtitle="AI VIDEO">
          <div class="overview__video">
            <div
              v-for="c in videoChannels"
              :key="c.id"
              class="overview__video-cell"
              :class="{ 'is-offline': c.status === 'offline' }"
            >
              <span class="overview__video-name">{{ c.name }}</span>
              <span class="overview__video-tag">{{ c.status === 'online' ? '在线' : '离线' }}</span>
            </div>
          </div>
        </PanelBox>
      </div>

      <!-- 底部迷你图表行 -->
      <div class="overview__minis">
        <PanelBox
          v-for="m in MINI_CHARTS"
          :key="m.key"
          :title="m.title"
          :subtitle="m.subtitle"
          class="overview__mini"
        >
          <EchartBox :option="miniOption(m)" height="100%" />
        </PanelBox>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { EChartsOption } from 'echarts'
import AppHeader from '@/components/AppHeader.vue'
import PanelBox from '@/components/PanelBox.vue'
import EchartBox from '@/components/EchartBox.vue'
import MapScene from '@/components/MapScene.vue'
import PlanProgress from '@/components/PlanProgress.vue'
import { PRODUCTION_PLANS } from '@/config/nav'
import { areaGradient, barGradient, CHART_COLORS, fadeColor } from '@/utils/chartTheme'
import { useAsyncData } from '@/hooks/useAsyncData'
import * as overviewApi from '@/api/overview'

/**
 * 数据来源统一走 API 层。
 *
 * 后端未就绪时 requestWithFallback 会自动返回内置的 mock 数据，
 * 页面不需要关心当前用的是哪一份，接口就绪后也无需改动这里。
 */
const { data: personnelDistribution } = useAsyncData(
  overviewApi.fetchPersonnelDistribution,
  { total: 0, items: [] as { name: string; value: number; color: string }[] }
)
const { data: outputStatistic } = useAsyncData(overviewApi.fetchOutputStatistic, {
  hours: [] as string[],
  today: [] as number[],
  yesterday: [] as number[]
})
const { data: costMonitor } = useAsyncData(overviewApi.fetchCostMonitor, {
  months: [] as string[],
  series: [] as { name: string; data: number[] }[]
})
const { data: safetyGauges } = useAsyncData(overviewApi.fetchSafetyGauges, [] as {
  label: string
  value: number
  max: number
  unit: string
  color: string
}[])
const { data: videoChannels } = useAsyncData(overviewApi.fetchVideoChannels, [] as {
  id: number
  name: string
  status: 'online' | 'offline'
}[])
const { data: hazardMonitor } = useAsyncData(overviewApi.fetchHazardMonitor, [] as {
  label: string
  value: number
  unit: string
}[])
const { data: unitConsumption } = useAsyncData(overviewApi.fetchUnitConsumption, {
  labels: [] as string[],
  values: [] as number[]
})
const { data: majorEquipment } = useAsyncData(overviewApi.fetchMajorEquipment, {
  labels: [] as string[],
  values: [] as number[]
})
const { data: inventoryStat } = useAsyncData(overviewApi.fetchInventoryStat, {
  labels: [] as string[],
  values: [] as number[]
})

// ---------- 底部迷你图表 ----------
// 用 computed 而不是静态数组：数据是异步来的，必须保持响应式
const MINI_CHARTS = computed(() => [
  { key: 'unit', title: '生产单耗控制', subtitle: 'CONSUMPTION', data: unitConsumption.value, color: CHART_COLORS[0] },
  { key: 'equip', title: '大型设备生产', subtitle: 'EQUIPMENT', data: majorEquipment.value, color: CHART_COLORS[2] },
  { key: 'stock', title: '库存管理', subtitle: 'INVENTORY', data: inventoryStat.value, color: CHART_COLORS[3] }
])

// computed 的元素类型要经 .value 取：直接 [number] 索引的是 ComputedRef 本身
type MiniChart = (typeof MINI_CHARTS)['value'][number]

/** 迷你柱状图：去掉坐标轴文字，只保留柱形走势 */
function miniOption(m: MiniChart): EChartsOption {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { top: 4, left: 0, right: 0, bottom: 14, containLabel: true },
    xAxis: {
      type: 'category',
      data: m.data.labels,
      axisLabel: { fontSize: 9, interval: 0 }
    },
    yAxis: { type: 'value', show: false },
    series: [
      {
        type: 'bar',
        barWidth: 12,
        itemStyle: {
          borderRadius: [2, 2, 0, 0],
          color: barGradient(m.color, 'rgba(0, 229, 255, 0.12)')
        },
        data: m.data.values
      }
    ]
  }
}

// ---------- 采区人员分布（环形图） ----------
const personnelOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {c} 人 ({d}%)' },
  legend: {
    type: 'scroll',
    orient: 'vertical',
    right: 0,
    top: 'center',
    itemWidth: 6,
    itemHeight: 6,
    textStyle: { fontSize: 10 }
  },
  series: [
    {
      type: 'pie',
      radius: ['48%', '70%'],
      center: ['34%', '50%'],
      avoidLabelOverlap: true,
      label: { show: false },
      labelLine: { show: false },
      data: personnelDistribution.value.items.map((i) => ({
        name: i.name,
        value: i.value,
        itemStyle: { color: i.color }
      }))
    }
  ],
  graphic: [
    {
      type: 'text',
      left: '27%',
      top: '42%',
      style: {
        text: `${personnelDistribution.value.total}\n总人数`,
        fill: '#ffffff',
        fontSize: 16,
        fontWeight: 'bold',
        align: 'center',
        lineHeight: 18
      }
    }
  ]
}))

// ---------- 班组运行状态（饼图） ----------
const teamOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {c}%' },
  legend: {
    orient: 'vertical',
    right: 0,
    top: 'center',
    itemWidth: 6,
    itemHeight: 6,
    textStyle: { fontSize: 10 }
  },
  series: [
    {
      type: 'pie',
      radius: '62%',
      center: ['34%', '50%'],
      label: { show: false },
      labelLine: { show: false },
      data: [
        { name: '机电队', value: 32, itemStyle: { color: CHART_COLORS[0] } },
        { name: '运输队', value: 26, itemStyle: { color: CHART_COLORS[1] } },
        { name: '掘进队', value: 24, itemStyle: { color: CHART_COLORS[2] } },
        { name: '采煤队', value: 18, itemStyle: { color: CHART_COLORS[3] } }
      ]
    }
  ]
}))

// ---------- 产量统计（面积折线，今日 / 昨日） ----------
const outputOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, right: 0, data: ['今日', '昨日'] },
  grid: { top: 24, left: 4, right: 4, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: outputStatistic.value.hours, boundaryGap: false },
  yAxis: { type: 'value', name: '吨', nameTextStyle: { color: '#5c7a99', fontSize: 10 } },
  series: [
    {
      name: '今日',
      type: 'line',
      smooth: true,
      showSymbol: false,
      areaStyle: { color: areaGradient('rgba(0, 229, 255, 0.55)') },
      lineStyle: { width: 2, color: CHART_COLORS[0] },
      itemStyle: { color: CHART_COLORS[0] },
      data: outputStatistic.value.today
    },
    {
      name: '昨日',
      type: 'line',
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 1.5, type: 'dashed', color: CHART_COLORS[1] },
      itemStyle: { color: CHART_COLORS[1] },
      data: outputStatistic.value.yesterday
    }
  ]
}))

// ---------- 成本监控（分组柱状，多月份 × 多成本类型） ----------
/**
 * 补充件第 1 号：首页右侧栏是 4 块，原指导文档 3.1 漏写了这一块。
 * 数据复用早已定义但一直没人用的 `fetchCostMonitor`，不新增接口。
 */
const costOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  // 图例可点：成本类型多起来之后能单独看某一项
  legend: { top: 0, right: 0, data: costMonitor.value.series.map((s) => s.name) },
  grid: { top: 24, left: 4, right: 4, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: costMonitor.value.months },
  yAxis: { type: 'value', name: '万元', nameTextStyle: { color: '#5c7a99', fontSize: 10 } },
  series: costMonitor.value.series.map((s, i) => ({
    name: s.name,
    type: 'bar' as const,
    barWidth: 8,
    // 同组柱子共用一套渐变（头顶实色、柱底透明），比纯色更贴合整体风格
    itemStyle: { color: barGradient(CHART_COLORS[i], fadeColor(CHART_COLORS[i], 0.18)) },
    data: s.data
  }))
}))

// ---------- 安全监控（环形仪表） ----------
function gaugeOption(g: { label: string; value: number; max: number; unit: string; color: string }): EChartsOption {
  return {
    series: [
      {
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        min: 0,
        max: g.max,
        radius: '92%',
        center: ['50%', '58%'],
        progress: {
          show: true,
          width: 8,
          roundCap: true,
          itemStyle: { color: g.color, shadowBlur: 8, shadowColor: g.color }
        },
        axisLine: {
          lineStyle: { width: 8, color: [[1, 'rgba(26, 58, 92, 0.9)']] }
        },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        anchor: { show: false },
        title: {
          show: true,
          offsetCenter: [0, '32%'],
          fontSize: 11,
          color: '#8fa8c4'
        },
        detail: {
          offsetCenter: [0, '-2%'],
          fontSize: 20,
          fontWeight: 'bold',
          color: g.color,
          formatter: `{value}`
        },
        data: [{ value: g.value, name: g.label }]
      }
    ]
  }
}
</script>

<style lang="scss" scoped>
.overview {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.overview__main {
  position: relative;
  width: 100%;
  flex: 1;
  min-height: 0;
}

// 三维主视图铺满，面板浮在其上
.overview__map {
  position: absolute;
  inset: 0;
}

// 顶部悬浮的生产计划进度卡
.overview__plan {
  position: absolute;
  top: $panel-gap;
  left: 50%;
  transform: translateX(-50%);
  width: 880px;
  z-index: $z-panel;
  pointer-events: none;
}

// 底部迷你图表行
.overview__minis {
  position: absolute;
  left: $panel-width + $panel-gap * 3;
  right: $panel-width + $panel-gap * 3;
  bottom: $panel-gap;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: $panel-gap;
  z-index: $z-panel;
  pointer-events: none;

  :deep(.panel-box) {
    pointer-events: auto;
  }
}

.overview__side {
  position: absolute;
  top: $panel-gap;
  // 给底部迷你图表留出空间
  bottom: 152px;
  width: $panel-width;
  display: flex;
  flex-direction: column;
  gap: $panel-gap;
  z-index: $z-panel;

  &--left {
    left: $panel-gap;
  }

  &--right {
    right: $panel-gap;
  }

  :deep(.panel-box) {
    flex: 1;
    min-height: 0;
  }
}

// ---------- 重大危险源 ----------
.overview__hazard {
  display: flex;
  height: 100%;
  align-items: center;
}

.overview__hazard-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;

  & + & {
    border-left: 1px solid $border-soft;
  }
}

.overview__hazard-value {
  font-family: $font-number;
  font-size: $fs-metric;
  font-weight: 700;
  color: $primary;
  @include glow-text($primary, 10px);
}

.overview__hazard-label {
  font-size: $fs-small;
  color: $text-secondary;
}

// ---------- 安全仪表 ----------
.overview__gauges {
  display: flex;
  height: 100%;
  align-items: center;

  :deep(.echart-box) {
    flex: 1;
  }
}

// ---------- AI 视频 ----------
.overview__video {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 6px;
  height: 100%;
}

.overview__video-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 6px 8px;
  border: 1px solid $border-soft;
  background:
    repeating-linear-gradient(
      0deg,
      rgba(0, 229, 255, 0.05) 0px,
      rgba(0, 229, 255, 0.05) 1px,
      transparent 1px,
      transparent 3px
    ),
    rgba(4, 20, 38, 0.9);
  font-size: $fs-small - 1px;

  &.is-offline {
    opacity: 0.45;
  }
}

.overview__video-name {
  color: $text-body;
  @include ellipsis;
}

.overview__video-tag {
  position: absolute;
  top: 4px;
  right: 6px;
  color: $green;

  .is-offline & {
    color: $text-muted;
  }
}
</style>
