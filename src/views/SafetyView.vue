<template>
  <div class="safety">
    <AppHeader :show-nav="false" title="安全分析系统" />

    <main class="safety__main">
      <!-- 左侧 2/3：三维场景 -->
      <div class="safety__map">
        <MapScene :build="buildScene" :home="SAFETY_HOME" />
        <div class="safety__clock">{{ clock }}</div>
      </div>

      <!-- 右侧 1/3：安全分析系统面板 -->
      <aside class="safety__side">
        <PanelBox title="安全监控实时数据" subtitle="REAL-TIME">
          <div class="safety__realtime">
            <div class="safety__realtime-item is-danger">
              <span class="safety__realtime-value">{{ safetyRealtime.majorRisks }}</span>
              <span class="safety__realtime-label">重大风险项</span>
            </div>
            <div class="safety__realtime-item is-warn">
              <span class="safety__realtime-value">{{ safetyRealtime.existingRisks }}</span>
              <span class="safety__realtime-label">存在风险项</span>
            </div>
          </div>
          <div class="safety__update">更新时间 {{ safetyRealtime.updateTime }}</div>
        </PanelBox>

        <PanelBox title="存在安全风险项列表" subtitle="RISK LIST" class="safety__panel--grow">
          <el-table
            :data="riskList"
            size="small"
            height="100%"
            class="data-table"
            :header-cell-style="{ ...tableHeaderStyle() }"
            :cell-style="{ ...tableCellStyle() }"
          >
            <el-table-column prop="point" label="监测点" width="76" />
            <el-table-column prop="type" label="监控类型" min-width="104" />
            <el-table-column prop="level" label="安全等级" width="72">
              <template #default="{ row }">
                <span :class="`level level--${row.level}`">{{ row.level }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="detail" label="告警详情" min-width="120" />
          </el-table>
        </PanelBox>

        <PanelBox title="存在安全风险趋势分析" subtitle="TREND">
          <EchartBox :option="trendOption" height="100%" />
        </PanelBox>

        <PanelBox title="本周存在安全风险项类型分布" subtitle="TYPE RATIO">
          <EchartBox :option="typeOption" height="100%" />
        </PanelBox>
      </aside>

      <!--
        场景右下角的两块补充面板。
        这一页右栏是竖排面板，往下加会把整页撑出纵向滚动条；浮层不参与文档高度，
        又落在场景的空白区（告警圆圈在左下），所以放在这里最省地方。

        高度不在这里写：由 `.safety__main` 上的 `--safety-overlay-h` 统一定义，
        右栏要靠它算出该让出多少底部空间（见 .safety__side 的 padding-bottom）。
        写死在这里的话，改了高度忘了改让位，右栏最后一块面板就会被静默盖住。
      -->
      <PanelBox
        class="safety__overlay safety__training"
        title="安全培训与资质"
        subtitle="TRAINING & CERTIFICATION"
      >
        <div class="safety__training-grid">
          <div
            v-for="t in trainingItems"
            :key="t.label"
            class="safety__training-item"
            :class="{ 'is-warn': t.warn }"
          >
            <div class="safety__training-value">
              {{ t.value }}<span class="safety__training-unit">{{ t.unit }}</span>
            </div>
            <div class="safety__training-label">{{ t.label }}</div>
          </div>
        </div>
      </PanelBox>

      <PanelBox
        class="safety__overlay safety__hazard"
        title="隐患整改闭环"
        subtitle="HAZARD CLOSED LOOP"
      >
        <template #extra>闭环率 {{ closedRate }}</template>
        <ol class="safety__hazard-steps">
          <li v-for="s in hazardStages" :key="s.label" class="safety__hazard-step">
            <span class="safety__hazard-value">{{ s.value }}</span>
            <span class="safety__hazard-label">{{ s.label }}</span>
          </li>
        </ol>
      </PanelBox>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { EChartsOption } from 'echarts'
import * as Cesium from 'cesium'
import AppHeader from '@/components/AppHeader.vue'
import PanelBox from '@/components/PanelBox.vue'
import EchartBox from '@/components/EchartBox.vue'
import MapScene from '@/components/MapScene.vue'
import { buildSafetyLayer } from '@/scene/layers/safetyLayer'
import {
  AXIS_NAME_STYLE,
  barGradient,
  CHART_COLORS,
  fadeColor
} from '@/utils/chartTheme'
import { tableCellStyle, tableHeaderStyle } from '@/utils/tableTheme'
import { formatDate } from '@/utils/format'
import { useAsyncData } from '@/hooks/useAsyncData'
import * as safetyApi from '@/api/safety'
import type { HazardClosedLoop, RiskItem, SafetyTraining } from '@/api/safety'
import type { SceneWaypoint } from '@/scene/sceneConfig'

/**
 * 安全页机位：从西南侧俯瞰，让风险圆圈与设施标记都入画。
 * height 是注视点海拔，取自 DEM 实测（矿区地面约 1300m）。
 */
const SAFETY_HOME: SceneWaypoint = {
  key: 'safety',
  label: '安全分析',
  lon: 109.9560,
  lat: 34.3300,
  height: 1320,
  heading: 35,
  pitch: -38,
  range: 2400
}

/**
 * 数据来源统一走 API 层。
 *
 * 后端未就绪时 requestWithFallback 会自动返回内置的 mock 数据，
 * 页面不需要关心当前用的是哪一份，接口就绪后也无需改动这里。
 * 初始值给字段齐全的空结构，加载完成前模板照常渲染，不会出现 undefined。
 */
const { data: safetyRealtime } = useAsyncData(safetyApi.fetchSafetyRealtime, {
  updateTime: '',
  majorRisks: 0,
  existingRisks: 0
})
const { data: riskList } = useAsyncData(safetyApi.fetchRiskList, [] as RiskItem[])
const { data: riskTrend } = useAsyncData(safetyApi.fetchRiskTrend, {
  months: [] as string[],
  series: [] as { name: string; data: number[] }[],
  unit: ''
})
const { data: riskTypeDistribution } = useAsyncData(
  safetyApi.fetchRiskTypeDistribution,
  [] as { name: string; value: number; color: string }[]
)
const { data: safetyTraining } = useAsyncData(safetyApi.fetchSafetyTraining, {
  vrSessions: 0,
  onlineCourses: 0,
  certifiedWorkers: 0,
  uncertified: 0
} satisfies SafetyTraining)
const { data: hazardClosedLoop } = useAsyncData(safetyApi.fetchHazardClosedLoop, {
  reported: 0,
  assigned: 0,
  rectified: 0,
  verified: 0
} satisfies HazardClosedLoop)

// ---------- 三维场景：底图由 MapScene 负责，这里只叠加安全标注 ----------
// 标注高度要从三维底座采样地面高程，所以是异步的
async function buildScene(viewer: Cesium.Viewer) {
  await buildSafetyLayer(viewer, await safetyApi.fetchSafetyMarkers())
}

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

// ---------- 存在安全风险趋势分析（1~6 月分组柱状） ----------
/**
 * 三组分类按名字取色：参考图里就是「边坡稳定-黄 / 重点区域-蓝 / 厂区沉降-绿」。
 * 按名字而不是 series 下标取，后端换了返回顺序时颜色也不会跟着串。
 */
const TREND_SERIES_COLOR: Record<string, string> = {
  边坡稳定: CHART_COLORS[3],
  重点区域: CHART_COLORS[1],
  厂区沉降: CHART_COLORS[2]
}

const trendOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  legend: { top: 0, right: 0, data: riskTrend.value.series.map((s) => s.name) },
  grid: { top: 28, left: 4, right: 4, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: riskTrend.value.months },
  yAxis: { type: 'value', name: riskTrend.value.unit, nameTextStyle: AXIS_NAME_STYLE },
  series: riskTrend.value.series.map((s, i) => {
    const color = TREND_SERIES_COLOR[s.name] ?? CHART_COLORS[i]
    return {
      name: s.name,
      type: 'bar' as const,
      barWidth: 8,
      itemStyle: {
        borderRadius: [2, 2, 0, 0],
        color: barGradient(color, fadeColor(color, 0.2))
      },
      data: s.data
    }
  })
}))

// ---------- 风险类型分布（环形） ----------
const typeOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {c}%' },
  legend: {
    orient: 'vertical',
    right: 4,
    top: 'center',
    itemWidth: 6,
    itemHeight: 6,
    textStyle: { fontSize: 11 }
  },
  series: [
    {
      type: 'pie',
      radius: ['52%', '74%'],
      center: ['36%', '50%'],
      label: { show: false },
      labelLine: { show: false },
      data: riskTypeDistribution.value.map((i) => ({
        name: i.name,
        value: i.value,
        itemStyle: { color: i.color }
      }))
    }
  ]
}))

// ---------- 安全培训与资质 ----------
/** 无证上岗是要报警的那一项，单独标红 */
const trainingItems = computed(() => [
  { label: 'VR 体验', value: safetyTraining.value.vrSessions, unit: '场' },
  { label: '在线课程', value: safetyTraining.value.onlineCourses, unit: '门' },
  { label: '持证人员', value: safetyTraining.value.certifiedWorkers, unit: '人' },
  { label: '无证告警', value: safetyTraining.value.uncertified, unit: '人', warn: true }
])

// ---------- 隐患整改闭环 ----------
/** 上报 → 派单 → 整改 → 验收，四个环节依次收窄，就是一套闭环流程 */
const hazardStages = computed(() => [
  { label: '上报', value: hazardClosedLoop.value.reported },
  { label: '派单', value: hazardClosedLoop.value.assigned },
  { label: '整改', value: hazardClosedLoop.value.rectified },
  { label: '验收', value: hazardClosedLoop.value.verified }
])

/** 闭环率取「验收 / 上报」，数据没回来时不显示 0% 免得看着像真的（也不能出 NaN） */
const closedRate = computed(() => {
  const { reported, verified } = hazardClosedLoop.value
  return reported ? `${((verified / reported) * 100).toFixed(1)}%` : '—'
})
</script>

<style lang="scss" scoped>
.safety {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.safety__main {
  /*
   * 底部两块浮层的高度：只在这里定义一次。
   * 浮层自己按它取高，右栏按它算该让出多少底部空间 —— 一处改，两处跟着动。
   */
  --safety-overlay-h: 108px;
  position: relative;
  display: flex;
  width: 100%;
  // 父级已用 padding-top 让出顶栏高度，这里不能再减一次（全局 box-sizing: border-box）
  height: 100%;
}

.safety__map {
  position: relative;
  flex: 1;
  min-width: 0;
}

.safety__clock {
  position: absolute;
  left: 20px;
  bottom: 16px;
  font-family: $font-number;
  font-size: 15px;
  color: $primary;
  @include glow-text($primary, 8px);
}

.safety__side {
  flex: 0 0 480px;
  display: flex;
  flex-direction: column;
  gap: $panel-gap;
  padding: $panel-gap;
  padding-left: 0;
  /*
   * 让出底部浮层占的那一行。
   *
   * 右栏是「撑满主区高度」的 flex 列，面板 flex-shrink: 0 由内容定高，
   * 竖着排下来最后一块自然落到主区的底边上 —— 而两块浮层也锚在同一个底边上，
   * 于是右栏最后一块面板被结结实实盖住。实测盖掉 body 的 86%，
   * 环形图一点都看不见，页面上只剩一个标题加一片空白。
   *
   * 让位高度 = 浮层底距 + 浮层高 + 与浮层之间的间距，多出来的那一段
   * 由「存在安全风险项列表」吸收（它是唯一 flex: 1 的面板）。
   */
  padding-bottom: calc(#{$panel-gap} * 2 + var(--safety-overlay-h));
  z-index: $z-panel;

  :deep(.panel-box) {
    flex-shrink: 0;
  }

  :deep(.safety__panel--grow) {
    flex: 1;
    min-height: 0;
  }
}

// ---------- 实时数据 ----------
.safety__realtime {
  display: flex;
  align-items: center;
  padding: 4px 0 8px;
}

.safety__realtime-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;

  & + & {
    border-left: 1px solid $border-soft;
  }

  &.is-danger .safety__realtime-value {
    color: $red;
    @include glow-text($red, 10px);
  }
  &.is-warn .safety__realtime-value {
    color: $orange;
    @include glow-text($orange, 10px);
  }
}

.safety__realtime-value {
  font-family: $font-number;
  font-size: $fs-metric-lg;
  font-weight: 700;
}

.safety__realtime-label {
  font-size: $fs-small;
  color: $text-secondary;
}

.safety__update {
  text-align: center;
  font-size: $fs-small - 1px;
  color: $text-muted;
}

// 安全等级色标（表格由全局 .data-table 负责深色适配，这里只留语义色）
.level {
  font-weight: 600;

  &--低 {
    color: $green;
  }
  &--中 {
    color: $yellow;
  }
  &--高 {
    color: $red;
  }
}

// ---------- 场景右下角的补充面板 ----------
.safety__overlay {
  position: absolute;
  bottom: $panel-gap;
  height: var(--safety-overlay-h);
  z-index: $z-panel;
}

.safety__hazard {
  right: $panel-gap;
  width: 400px;
}

// 与闭环面板并排，中间留一个面板间距
.safety__training {
  right: 432px;
  width: 360px;
}

.safety__training-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  height: 100%;
}

.safety__training-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;

  & + & {
    border-left: 1px solid $border-soft;
  }

  &.is-warn .safety__training-value {
    color: $red;
    @include glow-text($red, 8px);
  }
}

.safety__training-value {
  @include numeric;
  font-size: 22px;
  font-weight: 700;
  color: $primary;
}

.safety__training-unit {
  margin-left: 2px;
  font-size: $fs-small - 1px;
  font-weight: 400;
  color: $text-secondary;
}

.safety__training-label {
  font-size: $fs-small - 1px;
  color: $text-secondary;
}

.safety__hazard-steps {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  height: 100%;
}

.safety__hazard-step {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px solid $border-soft;
  background: linear-gradient(180deg, rgba($primary, 0.1) 0%, transparent 100%);

  // 环节之间画一个小箭头，表示单向流转（最后一格后面没有下一环，不画）
  &:not(:last-child)::after {
    content: '';
    position: absolute;
    right: -9px;
    top: 50%;
    width: 5px;
    height: 5px;
    border-top: 1px solid $primary;
    border-right: 1px solid $primary;
    transform: translateY(-50%) rotate(45deg);
  }
}

.safety__hazard-value {
  @include numeric;
  font-size: 20px;
  font-weight: 700;
  color: $primary;
  @include glow-text($primary, 6px);
}

.safety__hazard-label {
  font-size: $fs-small - 1px;
  color: $text-secondary;
}
</style>
