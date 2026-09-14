<template>
  <div class="production">
    <AppHeader :show-nav="false" title="生产管理系统" />

    <main class="production__main">
      <div class="production__content">
        <!-- 顶部指标卡 -->
        <section class="production__metrics">
          <MetricCard
            v-for="m in productionMetrics"
            :key="m.label"
            :label="m.label"
            :value="m.value"
            :unit="m.unit"
            :decimals="m.decimals ?? 0"
            :chain="m.chain"
            :yoy="m.yoy"
            :color="m.color"
          />
        </section>

        <!-- 中部四栏 -->
        <section class="production__row production__row--middle">
          <PanelBox title="质量活动" subtitle="QUALITY ACTIVITY">
            <EchartBox :option="qualityOption" height="100%" />
          </PanelBox>

          <PanelBox title="质检记录" subtitle="INSPECTION RECORDS">
            <!-- 报表导出对应指导文档 5.2「自动生成标准化调度报表，支持 Excel/PDF 导出」。 -->
            <template #extra>
              <button class="production__export" type="button" @click="onExportQualityRecords">
                导出
              </button>
            </template>
            <el-table
              :data="qualityRecords"
              size="small"
              height="100%"
              class="data-table"
              :header-cell-style="{ ...tableHeaderStyle() }"
              :cell-style="{ ...tableCellStyle() }"
            >
              <el-table-column prop="time" label="时间" width="112" />
              <el-table-column prop="issue" label="质检异常情况" min-width="88">
                <template #default="{ row }">
                  <span :class="{ 'is-abnormal': row.issue !== '无异常' }">{{ row.issue }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="action" label="处理措施" min-width="100" />
              <el-table-column prop="owner" label="负责人" width="66" />
            </el-table>
          </PanelBox>

          <PanelBox title="今日生产类型分布" subtitle="TYPE DISTRIBUTION">
            <EchartBox :option="typeOption" height="100%" />
          </PanelBox>

          <!-- 指导文档 5.2「产量、进尺…计划 vs 实际多维对比」 -->
          <PanelBox title="掘进进尺：计划 vs 实际" subtitle="DRILLING PLAN VS ACTUAL">
            <EchartBox :option="drillingOption" height="100%" />
          </PanelBox>
        </section>

        <!-- 底部三栏 -->
        <section class="production__row production__row--bottom">
          <PanelBox title="生产量趋势" subtitle="OUTPUT TREND">
            <EchartBox :option="outputOption" height="100%" />
          </PanelBox>

          <PanelBox title="年度生产数据" subtitle="ANNUAL OUTPUT">
            <EchartBox :option="heatmapOption" height="100%" />
          </PanelBox>

          <!-- 指导文档 5.2「调度值班、交接班记录」 -->
          <PanelBox title="调度值班与交接班" subtitle="DUTY ROSTER">
            <el-table
              :data="dutySchedule"
              size="small"
              height="100%"
              class="data-table"
              :header-cell-style="{ ...tableHeaderStyle() }"
              :cell-style="{ ...tableCellStyle() }"
            >
              <el-table-column prop="shift" label="班次" width="60" />
              <el-table-column prop="time" label="时段" width="104" />
              <el-table-column prop="leader" label="值班长" width="70" />
              <el-table-column prop="crew" label="作业队组" min-width="88" />
              <el-table-column prop="status" label="状态" width="68">
                <template #default="{ row }">
                  <span :class="{ 'is-handover': row.status === '交接中' }">{{ row.status }}</span>
                </template>
              </el-table-column>
            </el-table>
          </PanelBox>
        </section>
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
import MetricCard from '@/components/MetricCard.vue'
import { barGradient, CHART_COLORS, fadeColor, TEXT_MUTED_COLOR } from '@/utils/chartTheme'
import { tableCellStyle, tableHeaderStyle } from '@/utils/tableTheme'
import { formatDay } from '@/utils/format'
import { useAsyncData } from '@/hooks/useAsyncData'
import * as productionApi from '@/api/production'
import type { ProductionMetric, QualityRecord } from '@/api/production'

/**
 * 数据来源统一走 API 层。
 *
 * 后端未就绪时 requestWithFallback 会自动返回内置的 mock 数据，
 * 页面不需要关心当前用的是哪一份，接口就绪后也无需改动这里。
 * 初始值给字段齐全的空结构，加载完成前模板照常渲染，不会出现 undefined。
 */
const { data: productionMetrics } = useAsyncData(
  productionApi.fetchProductionMetrics,
  [] as ProductionMetric[]
)
const { data: qualityActivity } = useAsyncData(productionApi.fetchQualityActivity, {
  years: [] as string[],
  series: [] as { name: string; data: number[] }[]
})
const { data: qualityRecords } = useAsyncData(
  productionApi.fetchQualityRecords,
  [] as QualityRecord[]
)

// ---------- 报表导出 ----------
/**
 * 质检记录导出为 CSV。
 *
 * 纯前端生成，不经过后端——这也是选它做按钮级权限样例的原因：
 * 数据全是 Mock 的阶段，导出是少数能真正跑通、而不是「点了没反应」的动作。
 *
 * 用 CSV 而不是 xlsx：xlsx 要额外引一个几十 KB 的库，
 * 而 Excel 能直接打开 UTF-8 的 CSV，交付演示够用了。
 */
function onExportQualityRecords() {
  const rows = qualityRecords.value
  if (!rows.length) return

  const header = ['时间', '质检异常情况', '处理措施', '负责人']
  const body = rows.map((r) => [r.time, r.issue, r.action, r.owner])

  // 开头的 BOM 不能省：Excel 打开不带 BOM 的 UTF-8 CSV 会按 GBK 解码，
  // 中文全部变成乱码——这是 Windows 上交付这类文件最常见的翻车点。
  // 行分隔用 CRLF，同样是迁就 Excel。
  const csv = '\uFEFF' + [header, ...body].map(toCsvRow).join('\r\n')

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `质检记录_${formatDay(new Date())}.csv`
  link.click()
  // 必须撤销：blob URL 不撤销会一直占着内存直到页面卸载
  URL.revokeObjectURL(url)
}

/** CSV 字段转义：含逗号、引号或换行的字段要用双引号包起来，内部引号翻倍 */
function toCsvRow(cells: string[]): string {
  return cells
    .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
    .join(',')
}
const { data: productionTypeDistribution } = useAsyncData(
  productionApi.fetchTypeDistribution,
  [] as { name: string; value: number; color: string }[]
)
const { data: outputTrend } = useAsyncData(productionApi.fetchOutputTrend, {
  months: [] as string[],
  output: [] as number[],
  yoy: [] as number[]
})
const { data: annualHeatmap } = useAsyncData(productionApi.fetchAnnualHeatmap, {
  months: [] as string[],
  days: 31,
  max: 10000,
  values: [] as [number, number, number][]
})
const { data: drillingProgress } = useAsyncData(productionApi.fetchDrillingProgress, {
  months: [] as string[],
  plan: [] as number[],
  actual: [] as number[]
})
const { data: dutySchedule } = useAsyncData(
  productionApi.fetchDutySchedule,
  [] as { shift: string; time: string; leader: string; crew: string; status: string }[]
)

/**
 * 热力图色阶：由暗到亮。
 *
 * 用「同一个蓝 + 不同透明度」而不是写死一串 hex——
 * 调色板一改，色阶跟着走，不会出现热力图和别的图对不上色系的情况。
 * 末档用主色青，让峰值跳出来。
 */
const HEATMAP_RAMP = [0.12, 0.35, 0.65, 1].map((a) => fadeColor(CHART_COLORS[1], a))
HEATMAP_RAMP.push(CHART_COLORS[0])

// ---------- 质量活动（分组柱状） ----------
const qualityOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, right: 0, itemWidth: 8, itemHeight: 8 },
  grid: { top: 30, left: 4, right: 8, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: qualityActivity.value.years },
  yAxis: { type: 'value' },
  series: qualityActivity.value.series.map((s, i) => ({
    name: s.name,
    type: 'bar' as const,
    barWidth: 10,
    itemStyle: {
      borderRadius: [2, 2, 0, 0],
      color: barGradient(CHART_COLORS[i], fadeColor(CHART_COLORS[i], 0.2))
    },
    data: s.data
  }))
}))

// ---------- 今日生产类型分布（环形） ----------
// 配色来自数据本身（每类一个色），不在这里写死
const typeOption = computed<EChartsOption>(() => ({
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
      radius: ['46%', '70%'],
      center: ['34%', '50%'],
      label: { show: false },
      labelLine: { show: false },
      data: productionTypeDistribution.value.map((i) => ({
        name: i.name,
        value: i.value,
        itemStyle: { color: i.color }
      }))
    }
  ]
}))

// ---------- 掘进进尺：计划 vs 实际（对比柱 + 达成率折线） ----------
const drillingOption = computed<EChartsOption>(() => {
  const { months, plan, actual } = drillingProgress.value
  // 达成率：实际/计划，计划为 0 时记 0，避免出现 Infinity
  const rate = actual.map((a, i) => (plan[i] ? +((a / plan[i]) * 100).toFixed(1) : 0))

  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0, right: 0, data: ['计划进尺', '实际进尺', '达成率'] },
    grid: { top: 30, left: 4, right: 8, bottom: 0, containLabel: true },
    xAxis: { type: 'category', data: months },
    yAxis: [
      { type: 'value', name: '米', nameTextStyle: { color: TEXT_MUTED_COLOR, fontSize: 10 } },
      {
        type: 'value',
        name: '%',
        nameTextStyle: { color: TEXT_MUTED_COLOR, fontSize: 10 },
        axisLabel: { formatter: '{value}%' }
      }
    ],
    series: [
      {
        name: '计划进尺',
        type: 'bar',
        barWidth: 9,
        itemStyle: {
          borderRadius: [2, 2, 0, 0],
          color: barGradient(CHART_COLORS[1], fadeColor(CHART_COLORS[1], 0.18))
        },
        data: plan
      },
      {
        name: '实际进尺',
        type: 'bar',
        barWidth: 9,
        itemStyle: {
          borderRadius: [2, 2, 0, 0],
          color: barGradient(CHART_COLORS[0], fadeColor(CHART_COLORS[0], 0.18))
        },
        data: actual
      },
      {
        name: '达成率',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 5,
        lineStyle: { width: 2, color: CHART_COLORS[2] },
        itemStyle: { color: CHART_COLORS[2] },
        data: rate
      }
    ]
  }
})

// ---------- 生产量趋势（柱状 + 同比折线双轴） ----------
const outputOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, right: 0, data: ['日产量', '同比'] },
  grid: { top: 30, left: 4, right: 8, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: outputTrend.value.months },
  yAxis: [
    {
      type: 'value',
      name: '吨',
      nameTextStyle: { color: TEXT_MUTED_COLOR, fontSize: 10 }
    },
    {
      type: 'value',
      name: '%',
      nameTextStyle: { color: TEXT_MUTED_COLOR, fontSize: 10 },
      axisLabel: { formatter: '{value}%' }
    }
  ],
  series: [
    {
      name: '日产量',
      type: 'bar',
      barWidth: 22,
      itemStyle: {
        borderRadius: [3, 3, 0, 0],
        color: barGradient(CHART_COLORS[0], fadeColor(CHART_COLORS[0], 0.15))
      },
      data: outputTrend.value.output
    },
    {
      name: '同比',
      type: 'line',
      yAxisIndex: 1,
      smooth: true,
      symbolSize: 6,
      lineStyle: { width: 2, color: CHART_COLORS[2] },
      itemStyle: { color: CHART_COLORS[2] },
      label: {
        show: true,
        formatter: '{c}%',
        color: CHART_COLORS[2],
        fontSize: 10,
        position: 'top'
      },
      data: outputTrend.value.yoy
    }
  ]
}))

// ---------- 年度生产数据（日历热力矩阵） ----------
// 用散点矩阵实现：x = 日，y = 月，symbolSize 固定、颜色表示产量。
// 相比 heatmap 系列，散点不需要在坐标轴上铺满分类带，更适合大屏紧凑布局。
const heatmapOption = computed<EChartsOption>(() => ({
  tooltip: {
    formatter: (p: any) =>
      `${annualHeatmap.value.months[p.value[1]]} 第${p.value[0] + 1}日<br/>产量 ${p.value[2]} 吨`
  },
  grid: { top: 20, left: 4, right: 12, bottom: 4, containLabel: true },
  xAxis: {
    type: 'value',
    min: -0.5,
    max: 30.5,
    interval: 2,
    axisLabel: { formatter: (v: number) => `${v + 1}`, fontSize: 9 }
  },
  yAxis: {
    type: 'category',
    data: annualHeatmap.value.months,
    axisLabel: { fontSize: 9 },
    splitLine: { show: false }
  },
  visualMap: {
    show: false,
    min: 0,
    max: annualHeatmap.value.max,
    inRange: { color: HEATMAP_RAMP }
  },
  series: [
    {
      type: 'scatter',
      symbolSize: 8,
      itemStyle: { borderWidth: 0 },
      data: annualHeatmap.value.values.map(([d, m, v]) => [d, m, v])
    }
  ]
}))
</script>

<style lang="scss" scoped>
// 本页是纯数据页，没有三维场景（按参考图与需求，三维背景统一去掉了）
.production {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.production__main {
  display: flex;
  flex-direction: column;
  width: 100%;
  flex: 1;
  min-height: 0;
}

// 面板层：作为普通子元素吃满标题栏以下的剩余高度
.production__content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: $panel-gap;
  padding: $panel-gap;
}

// ---------- 指标卡 ----------
.production__metrics {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: $panel-gap;
  flex-shrink: 0;
}

// ---------- 行 ----------
.production__row {
  display: grid;
  gap: $panel-gap;
  min-height: 0;

  // 四栏：参考图的三块 + 指导文档 5.2 的「计划 vs 实际」
  &--middle {
    grid-template-columns: repeat(4, 1fr);
    flex: 1;
  }

  // 三栏：参考图的两块 + 指导文档 5.2 的「调度值班」
  &--bottom {
    grid-template-columns: repeat(3, 1fr);
    flex: 0.9;
  }

  :deep(.panel-box__body) {
    min-height: 0;
  }
}

// 图表自适应容器高度
.production__row :deep(.echart-box) {
  height: 100% !important;
}

// ---------- 表格 ----------
// 深色适配统一由全局 .data-table 与 utils/tableTheme 提供，此处不再重写

// 标题栏右侧的导出按钮。样式与隐患处置按钮保持同一套视觉，
// 大屏里同层级的操作入口不该有两副长相。
.production__export {
  padding: 2px 10px;
  font-size: $fs-small - 1px;
  color: $primary;
  background: rgba($primary, 0.1);
  border: 1px solid rgba($primary, 0.4);
  border-radius: 2px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;

  &:hover {
    color: $bg-deep;
    background: $primary;
  }
}

.is-abnormal {
  color: $yellow;
}

.is-handover {
  color: $primary;
}
</style>
