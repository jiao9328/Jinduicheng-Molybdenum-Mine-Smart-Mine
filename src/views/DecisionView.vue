<template>
  <div class="decision">
    <AppHeader :show-nav="false" title="分析决策">
      <!--
        四维切换条 ——《项目文档.docx》§06 要求「对生产、安全、成本、效益等多维度数据
        进行深度挖掘」，故本页分四维：成本效益 / 生产分析 / 安全分析 / 能耗单耗。

        挂在顶栏 #extra 插槽里而不是内容区：内容区的 grid 行高是精算过的
        （见 check-panel-overflow），凭空多一行会把八块面板整体挤矮，
        而顶栏这 84px 是固定高度，塞在这里对 grid 零影响 —— 这也保证了
        「成本效益」维的面板矩形与本页改造前**逐像素一致**。
      -->
      <template #extra>
        <div class="decision__dims">
          <button
            v-for="d in DIMS"
            :key="d.key"
            class="decision__dim"
            :class="{ 'is-active': dim === d.key }"
            type="button"
            @click="dim = d.key"
          >
            {{ d.label }}
          </button>
        </div>
      </template>
    </AppHeader>

    <main class="decision__main">
      <!--
        ⚠️ 四个维度一律用 v-if，**不要改成 v-show**。
        v-show 下被隐藏的面板仍在 DOM 里，getBoundingClientRect() 返回全 0，
        check-panel-overflow 的三条判据（撑破 / 溢出 / 重叠）会**全部平凡为真**，
        报告里出现一排 body 0×0 的绿灯行 —— 那些面板从没被真正量过。
        同理**不要加 <KeepAlive>**：它保留 DOM 却不触发 onMounted，
        图表会停在被隐藏前的旧尺寸上，比 v-show 更糟。
      -->
      <!-- ① 成本效益 —— 甲方硬要求原样保留，一个字符都没动 -->
      <div v-if="dim === 'cost'" class="decision__grid">
        <!-- 顶部：5 张成本指标卡 -->
        <div class="decision__metrics">
          <MetricCard
            v-for="m in costMetrics"
            :key="m.label"
            :label="m.label"
            :value="m.value"
            :unit="m.unit"
            :decimals="m.decimals"
            :chain="m.chain"
            :yoy="m.yoy"
            :color="m.color"
          />
        </div>

        <!-- 中部三栏：年度对比 / 支出 TOP5 / 成本分布 -->
        <div class="decision__row">
          <PanelBox title="年度成本对比" subtitle="ANNUAL COST">
            <EchartBox :option="annualCostOption" height="100%" />
          </PanelBox>

          <PanelBox title="前 5 大支出项" subtitle="TOP EXPENSES">
            <!--
              表格配色统一由 tableTheme / 全局 .data-table 提供。
              展开成对象字面量再传：el-table 要求 CSSProperties，而 tableTheme 的
              返回类型是普通接口，缺 CSS 变量那层索引签名，直接传过不了类型检查。
            -->
            <el-table
              :data="topExpenses"
              size="small"
              height="100%"
              class="data-table"
              :header-cell-style="{ ...tableHeaderStyle() }"
              :cell-style="{ ...tableCellStyle() }"
            >
              <el-table-column prop="item" label="支出项" min-width="96" />
              <el-table-column prop="amount" label="支出成本（万元）" min-width="132" align="right">
                <template #default="{ row }">
                  <span class="decision__amount">{{ row.amount }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="date" label="支出日期" min-width="110" align="right" />
            </el-table>
          </PanelBox>

          <PanelBox title="各类型成本分布" subtitle="COST DISTRIBUTION">
            <EchartBox :option="costDistributionOption" height="100%" />
          </PanelBox>
        </div>

        <!-- 底部三栏：月度趋势（柱状 + 同比折线双轴） -->
        <div class="decision__row">
          <PanelBox
            v-for="t in monthlyTrends"
            :key="t.key"
            :title="t.title"
            subtitle="MONTHLY TREND"
          >
            <EchartBox :option="trendOptions[t.key]" height="100%" />
          </PanelBox>
        </div>

        <!-- 末行：效益分析 + 智能辅助决策建议 -->
        <div class="decision__row decision__row--split">
          <PanelBox title="效益分析" subtitle="BENEFIT">
            <ul class="decision__benefits">
              <li v-for="b in benefitAnalysis" :key="b.label" class="decision__benefit">
                <span class="decision__benefit-label">{{ b.label }}</span>
                <span class="decision__benefit-value">
                  {{ b.value }}<em v-if="b.unit">{{ b.unit }}</em>
                </span>
                <!-- 成本类指标下降是好事，故上下箭头统一用绿色 -->
                <span class="decision__benefit-arrow">{{ b.trend === 'up' ? '↑' : '↓' }}</span>
              </li>
            </ul>
          </PanelBox>

          <PanelBox title="智能辅助决策建议" subtitle="AI SUGGESTIONS">
            <ul class="decision__suggestions">
              <li
                v-for="s in decisionSuggestions"
                :key="s.id"
                class="decision__suggestion"
                :class="`is-${s.level}`"
              >
                <span class="decision__suggestion-tag">{{ s.type }}</span>
                <span class="decision__suggestion-text">{{ s.content }}</span>
              </li>
            </ul>
          </PanelBox>
        </div>
      </div>

      <!-- ② 生产分析 ——《项目文档.docx》§9.2-1：产量趋势 / 设备利用率 / 工序效率 / 损失贫化率 -->
      <div v-else-if="dim === 'prod'" class="decision__grid decision__grid--analysis">
        <div class="decision__metrics">
          <MetricCard
            v-for="m in productionMetrics"
            :key="m.label"
            :label="m.label"
            :value="m.value"
            :unit="m.unit"
            :decimals="m.decimals"
            :chain="m.chain"
            :yoy="m.yoy"
            :color="m.color"
          />
        </div>

        <div class="decision__row decision__row--half">
          <PanelBox title="产量趋势（计划 vs 实际）" subtitle="OUTPUT">
            <EchartBox :option="productionOutputOption" height="100%" />
            <!-- 把算式写出来：最后一个月为什么是这个数，看的人当场能核 -->
            <template #footer>{{ outputGapText }}</template>
          </PanelBox>

          <PanelBox title="设备利用率" subtitle="UTILIZATION">
            <EchartBox :option="utilizationOption" height="100%" />
            <template #footer>{{ utilizationAvgText }}</template>
          </PanelBox>
        </div>

        <div class="decision__row decision__row--half">
          <PanelBox title="工序效率" subtitle="PROCESS EFFICIENCY">
            <EchartBox :option="processOption" height="100%" />
            <template #footer>柱长 = 实际作业效率 ÷ 设计能力（100%）</template>
          </PanelBox>

          <PanelBox title="损失贫化率趋势" subtitle="LOSS &amp; DILUTION">
            <EchartBox :option="lossDilutionOption" height="100%" />
            <!-- 底栏顺带把「越低越好」写明白：两条线都在下降是好事，不能按涨跌颜色看 -->
            <template #footer>两项均为越低越好，6 月较 1 月分别下降 2.0 / 1.2 个百分点</template>
          </PanelBox>
        </div>
      </div>

      <!-- ③ 安全分析 ——《项目文档.docx》§9.2-2：隐患类型分布 /「三违」行为统计 / 事故率趋势 -->
      <div v-else-if="dim === 'safety'" class="decision__grid decision__grid--analysis">
        <div class="decision__metrics">
          <MetricCard
            v-for="m in safetyMetrics"
            :key="m.label"
            :label="m.label"
            :value="m.value"
            :unit="m.unit"
            :decimals="m.decimals"
            :chain="m.chain"
            :yoy="m.yoy"
            :color="m.color"
          />
        </div>

        <div class="decision__row decision__row--half">
          <PanelBox title="隐患类型分布" subtitle="HAZARD TYPES">
            <EchartBox :option="hazardTypeOption" height="100%" />
            <!--
              合计写进 DOM 是有意为之：环形图的数值只在 canvas 里，
              检查脚本读不到，这条底栏让「各类型之和 = 隐患上报数」变成可断言的事实。
            -->
            <template #footer>各类型合计 {{ hazardTotal }} 项，与指标卡「本月隐患上报」同源</template>
          </PanelBox>

          <PanelBox title="事故率趋势" subtitle="ACCIDENT RATE">
            <EchartBox :option="accidentOption" height="100%" />
            <template #footer>
              千人负伤率 = 事故起数 ÷ 在册职工 {{ accidentTrend.headcount }} 人 × 1000
            </template>
          </PanelBox>
        </div>

        <div class="decision__row decision__row--half">
          <PanelBox title="「三违」行为统计（按类别）" subtitle="VIOLATION BY TYPE">
            <EchartBox :option="violationTypeOption" height="100%" />
          </PanelBox>

          <PanelBox title="「三违」行为统计（按区队）" subtitle="VIOLATION BY TEAM">
            <EchartBox :option="violationTeamOption" height="100%" />
            <template #footer>
              两个口径合计都是 {{ violationStats.total }} 次 · 环比 {{ violationStats.chain }}%
            </template>
          </PanelBox>
        </div>
      </div>

      <!--
        ④ 能耗单耗 ——《项目文档.docx》§9.2-3：吨成本 / 单机成本 / 能耗（峰谷平电费）/ 水消耗。
        「单耗趋势」按维度名（能耗单耗）补上，两块拆解面板（吨成本 / 单机成本）与
        峰谷平电费、能耗构成之间互相自洽，见 mock/decision.ts 的推导注释。
      -->
      <div v-else class="decision__grid decision__grid--analysis">
        <div class="decision__metrics">
          <MetricCard
            v-for="m in energyMetrics"
            :key="m.label"
            :label="m.label"
            :value="m.value"
            :unit="m.unit"
            :decimals="m.decimals"
            :chain="m.chain"
            :yoy="m.yoy"
            :color="m.color"
          />
        </div>

        <div class="decision__row">
          <PanelBox title="峰谷平电费" subtitle="PEAK / FLAT / VALLEY">
            <EchartBox :option="tariffOption" height="100%" />
            <template #footer>
              合计 {{ tariffTotalText }} 万kWh · 电费 {{ tariffCostText }} 万元（= 各段电量 × 电价之和）
            </template>
          </PanelBox>

          <PanelBox title="能耗构成" subtitle="ENERGY MIX">
            <EchartBox :option="energyMixOption" height="100%" />
            <template #footer>{{ electricMixText }}</template>
          </PanelBox>

          <PanelBox title="水消耗" subtitle="WATER">
            <EchartBox :option="waterOption" height="100%" />
            <template #footer>吨矿水耗 {{ waterPerTonText }} m³/t</template>
          </PanelBox>
        </div>

        <div class="decision__row">
          <PanelBox title="单耗趋势" subtitle="UNIT CONSUMPTION">
            <EchartBox :option="unitConsumptionOption" height="100%" />
            <template #footer>吨矿电耗 = 月用电量 ÷ 月产量；吨矿水耗 = 月用水量 ÷ 月产量</template>
          </PanelBox>

          <PanelBox title="吨成本拆解" subtitle="COST PER TON">
            <EchartBox :option="tonCostOption" height="100%" />
            <template #footer>
              合计 {{ tonCostBreakdown.total }} 元/吨，与「效益分析」的吨成本同源
            </template>
          </PanelBox>

          <PanelBox title="单机成本" subtitle="COST PER MACHINE">
            <EchartBox :option="machineCostOption" height="100%" />
            <template #footer>月合计 {{ machineTotalText }} 万元</template>
          </PanelBox>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EChartsOption } from 'echarts'
import AppHeader from '@/components/AppHeader.vue'
import PanelBox from '@/components/PanelBox.vue'
import EchartBox from '@/components/EchartBox.vue'
import MetricCard from '@/components/MetricCard.vue'
import {
  areaGradient,
  AXIS_LINE_COLOR,
  AXIS_NAME_STYLE,
  barGradient,
  CHART_COLORS,
  fadeColor,
  TEXT_BODY_COLOR,
  TEXT_MUTED_COLOR
} from '@/utils/chartTheme'
import { tableCellStyle, tableHeaderStyle } from '@/utils/tableTheme'
import { useAsyncData } from '@/hooks/useAsyncData'
import * as decisionApi from '@/api/decision'
import type { AnalysisMetric, CostMetric, MonthlyTrend, TopExpense } from '@/api/decision'

/**
 * 数据来源统一走 API 层。
 *
 * 后端未就绪时 requestWithFallback 会自动返回内置的 mock 数据，
 * 页面不需要关心当前用的是哪一份，接口就绪后也无需改动这里。
 */
const { data: costMetrics } = useAsyncData(decisionApi.fetchCostMetrics, [] as CostMetric[])

const { data: annualCostCompare } = useAsyncData(decisionApi.fetchAnnualCostCompare, {
  years: [] as string[],
  series: [] as { name: string; data: number[] }[]
})

const { data: topExpenses } = useAsyncData(decisionApi.fetchTopExpenses, [] as TopExpense[])

const { data: costDistribution } = useAsyncData(decisionApi.fetchCostDistribution, [] as {
  name: string
  value: number
  color: string
}[])

const { data: monthlyTrends } = useAsyncData(decisionApi.fetchMonthlyTrends, [] as MonthlyTrend[])

const { data: benefitAnalysis } = useAsyncData(decisionApi.fetchBenefitAnalysis, [] as {
  label: string
  value: number
  unit: string
  trend: 'up' | 'down'
}[])

const { data: decisionSuggestions } = useAsyncData(decisionApi.fetchDecisionSuggestions, [] as {
  id: number
  type: string
  level: string
  content: string
}[])

// =============================================================================
// 四维切换
// =============================================================================
/**
 * ⚠️ `useAsyncData` **全部留在页面级**，不下沉到各维度的子组件里。
 * 下沉后每次切维度都会重建子组件、重跑 loader，数据在四维之间来回抖动。
 * 本页四个维度共用同一批 loader，只有当前维度的模板会渲染。
 */
const DIMS = [
  { key: 'cost', label: '成本效益' },
  { key: 'prod', label: '生产分析' },
  { key: 'safety', label: '安全分析' },
  { key: 'energy', label: '能耗单耗' }
] as const

type DimKey = (typeof DIMS)[number]['key']

/** 当前维度。默认「成本效益」——甲方要看的那一屏，也是本页原来的样子 */
const dim = ref<DimKey>('cost')

// ---------- ② 生产分析 ----------
type NamedValue = { name: string; value: number }

const { data: productionOutput } = useAsyncData(decisionApi.fetchProductionOutput, {
  months: [] as string[],
  plan: [] as number[],
  actual: [] as number[],
  unit: ''
})

const { data: equipmentUtilization } = useAsyncData(
  decisionApi.fetchEquipmentUtilization,
  [] as NamedValue[]
)

const { data: processEfficiency } = useAsyncData(decisionApi.fetchProcessEfficiency, [] as {
  name: string
  actual: number
  design: number
}[])

const { data: lossDilution } = useAsyncData(decisionApi.fetchLossDilution, {
  months: [] as string[],
  series: [] as { name: string; data: number[] }[],
  unit: ''
})

const { data: productionMetrics } = useAsyncData(
  decisionApi.fetchProductionMetrics,
  [] as AnalysisMetric[]
)

// ---------- ③ 安全分析 ----------
const { data: hazardTypeDistribution } = useAsyncData(
  decisionApi.fetchHazardTypeDistribution,
  [] as { name: string; value: number; color: string }[]
)

const { data: violationStats } = useAsyncData(decisionApi.fetchViolationStats, {
  byType: [] as NamedValue[],
  byTeam: [] as NamedValue[],
  total: 0,
  chain: 0,
  unit: ''
})

const { data: accidentTrend } = useAsyncData(decisionApi.fetchAccidentTrend, {
  months: [] as string[],
  counts: [] as number[],
  headcount: 0,
  ratePerThousand: [] as number[]
})

const { data: safetyMetrics } = useAsyncData(decisionApi.fetchSafetyMetrics, [] as AnalysisMetric[])

// ---------- ④ 能耗单耗 ----------
const { data: tariffUsage } = useAsyncData(decisionApi.fetchTariffUsage, {
  periods: [] as string[],
  energy: [] as number[],
  price: [] as number[],
  unitPower: 0,
  outputFor: 0,
  unit: ''
})

const { data: energyMix } = useAsyncData(decisionApi.fetchEnergyMix, [] as {
  name: string
  value: number
  color: string
}[])

const { data: waterUsage } = useAsyncData(decisionApi.fetchWaterUsage, {
  months: [] as string[],
  values: [] as number[],
  unit: ''
})

const { data: unitConsumption } = useAsyncData(decisionApi.fetchUnitConsumption, {
  months: [] as string[],
  series: [] as { name: string; data: number[] }[]
})

const { data: energyMetrics } = useAsyncData(decisionApi.fetchEnergyMetrics, [] as AnalysisMetric[])

const { data: tonCostBreakdown } = useAsyncData(decisionApi.fetchTonCostBreakdown, {
  items: [] as { name: string; value: number; color: string }[],
  total: 0,
  unit: ''
})

const { data: machineCost } = useAsyncData(decisionApi.fetchMachineCost, {
  items: [] as { name: string; value: number; count: number }[],
  unit: ''
})

// ---------- 主题色取用 ----------
// 双 Y 轴场景下 EchartBox 的 withTheme 对数组形式的 yAxis 原样透传（不做主题注入），
// 这里直接取主题里的具名常量补上，避免页面里写死颜色导致与其它图表不一致。
/** 双轴图的单根 Y 轴（带主题色） */
function valueAxis(name: string, showSplitLine: boolean) {
  return {
    type: 'value' as const,
    name,
    nameTextStyle: AXIS_NAME_STYLE,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: TEXT_MUTED_COLOR, fontSize: 11 },
    splitLine: {
      show: showSplitLine,
      lineStyle: { color: AXIS_LINE_COLOR, type: 'dashed' as const }
    }
  }
}

// ---------- 年度成本对比（分组柱状） ----------
const annualCostOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, right: 0, data: annualCostCompare.value.series.map((s) => s.name) },
  grid: { top: 30, left: 4, right: 4, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: annualCostCompare.value.years },
  yAxis: { type: 'value', name: '万元', nameTextStyle: AXIS_NAME_STYLE },
  series: annualCostCompare.value.series.map((s, i) => ({
    name: s.name,
    type: 'bar' as const,
    barWidth: 12,
    itemStyle: {
      borderRadius: [2, 2, 0, 0],
      color: barGradient(CHART_COLORS[i], fadeColor(CHART_COLORS[i], 0.18))
    },
    data: s.data
  }))
}))

// ---------- 各类型成本分布（彩色环形） ----------
const distributionTotal = computed(() =>
  costDistribution.value.reduce((sum, i) => sum + i.value, 0)
)

const costDistributionOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {c}' },
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
      radius: ['52%', '72%'],
      center: ['36%', '50%'],
      label: { show: false },
      labelLine: { show: false },
      data: costDistribution.value.map((i) => ({
        name: i.name,
        value: i.value,
        itemStyle: { color: i.color }
      }))
    }
  ],
  graphic: [
    {
      type: 'text',
      left: '33%',
      top: '42%',
      style: {
        text: `${distributionTotal.value}\n总额`,
        fill: TEXT_BODY_COLOR,
        fontSize: 16,
        fontWeight: 'bold',
        align: 'center',
        lineHeight: 18
      }
    }
  ]
}))

// ---------- 月度趋势（柱状 + 同比折线双轴） ----------
/** 同比轴顶部留出余量，避免折线数据标签贴边被裁 */
function yoyMax(v: { max: number }) {
  return Math.ceil((v.max * 1.25) / 10) * 10
}

function buildTrendOption(t: MonthlyTrend): EChartsOption {
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0, right: 0, data: ['成本', '同比'] },
    grid: { top: 34, left: 4, right: 4, bottom: 0, containLabel: true },
    xAxis: { type: 'category', data: t.months },
    yAxis: [valueAxis('万元', true), { ...valueAxis('同比 %', false), max: yoyMax }],
    series: [
      {
        name: '成本',
        type: 'bar',
        barWidth: 14,
        itemStyle: {
          borderRadius: [2, 2, 0, 0],
          color: barGradient(CHART_COLORS[0], fadeColor(CHART_COLORS[0], 0.18))
        },
        data: t.values
      },
      {
        name: '同比',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 5,
        lineStyle: { width: 2, color: CHART_COLORS[3] },
        itemStyle: { color: CHART_COLORS[3] },
        label: {
          show: true,
          position: 'top',
          // 用回调而非 '{value}%' 模板，保证标签一定渲染成「数值%」
          formatter: (p) => `${p.value}%`,
          fontSize: 9,
          color: CHART_COLORS[3]
        },
        data: t.yoy
      }
    ]
  }
}

/** 三组趋势图配置：按 key 索引，避免模板里每次渲染都重建 option */
const trendOptions = computed<Record<string, EChartsOption>>(() =>
  Object.fromEntries(monthlyTrends.value.map((t) => [t.key, buildTrendOption(t)]))
)

// =============================================================================
// 三个新增维度的图表配置
// =============================================================================
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0)

/**
 * 横向条形图 —— 设备利用率之外的几处横条都用它。
 * ECharts 的类目轴是**从下往上**排的，所以数据要翻一次，才是从上往下的阅读顺序。
 */
function buildHBar(
  rows: { name: string; value: number; color?: string }[],
  opts: { unit: string; max?: number; background?: boolean; labelFmt?: (v: number) => string }
): EChartsOption {
  const data = [...rows].reverse()
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    // right 留 44px 给柱端的数值标签，不留会被裁在画布外
    grid: { top: 8, left: 4, right: 44, bottom: 0, containLabel: true },
    xAxis: { type: 'value', name: opts.unit, nameTextStyle: AXIS_NAME_STYLE, max: opts.max },
    yAxis: { type: 'category', data: data.map((r) => r.name) },
    series: [
      {
        type: 'bar',
        barWidth: 12,
        showBackground: opts.background ?? false,
        backgroundStyle: { color: 'rgba(0, 229, 255, 0.07)' },
        label: {
          show: true,
          position: 'right',
          fontSize: 10,
          color: TEXT_BODY_COLOR,
          // 参数类型放宽成 unknown：ECharts 的 CallbackDataParams.value 是联合类型，
          // 收窄成 number 会与它不兼容（TS 只认逆变）
          formatter: (p: { value: unknown }) =>
            opts.labelFmt ? opts.labelFmt(Number(p.value)) : `${p.value}`
        },
        data: data.map((r, i) => {
          const c = r.color ?? CHART_COLORS[i % CHART_COLORS.length]
          return {
            value: r.value,
            itemStyle: { borderRadius: [0, 2, 2, 0], color: barGradient(c, fadeColor(c, 0.35)) }
          }
        })
      }
    ]
  }
}

/** 竖向计数柱 ——「三违」两个口径共用 */
function buildCountBar(rows: NamedValue[], unit: string, color: string): EChartsOption {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { top: 26, left: 4, right: 4, bottom: 0, containLabel: true },
    xAxis: { type: 'category', data: rows.map((r) => r.name), axisLabel: { interval: 0 } },
    yAxis: { type: 'value', name: unit, nameTextStyle: AXIS_NAME_STYLE },
    series: [
      {
        type: 'bar',
        barWidth: 26,
        itemStyle: {
          borderRadius: [2, 2, 0, 0],
          color: barGradient(color, fadeColor(color, 0.18))
        },
        label: { show: true, position: 'top', fontSize: 10, color: TEXT_BODY_COLOR },
        data: rows.map((r) => r.value)
      }
    ]
  }
}

// ---------- ② 生产分析 ----------
/** 计划与实际并列柱：计划用低饱和、实际用主色，一眼看出超欠产 */
const productionOutputOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, right: 0, data: ['计划', '实际'] },
  grid: { top: 30, left: 4, right: 4, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: productionOutput.value.months },
  yAxis: {
    type: 'value',
    name: productionOutput.value.unit || '万吨',
    nameTextStyle: AXIS_NAME_STYLE
  },
  series: [
    {
      name: '计划',
      type: 'bar',
      barWidth: 12,
      itemStyle: {
        borderRadius: [2, 2, 0, 0],
        color: barGradient(fadeColor(TEXT_MUTED_COLOR, 0.7), fadeColor(TEXT_MUTED_COLOR, 0.2))
      },
      data: productionOutput.value.plan
    },
    {
      name: '实际',
      type: 'bar',
      barWidth: 12,
      itemStyle: {
        borderRadius: [2, 2, 0, 0],
        color: barGradient(CHART_COLORS[0], fadeColor(CHART_COLORS[0], 0.18))
      },
      data: productionOutput.value.actual
    }
  ]
}))

const utilizationOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  grid: { top: 26, left: 4, right: 4, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: equipmentUtilization.value.map((e) => e.name) },
  yAxis: { type: 'value', name: '%', nameTextStyle: AXIS_NAME_STYLE, max: 100 },
  series: [
    {
      type: 'bar',
      barWidth: 26,
      itemStyle: {
        borderRadius: [2, 2, 0, 0],
        color: barGradient(CHART_COLORS[1], fadeColor(CHART_COLORS[1], 0.18))
      },
      label: { show: true, position: 'top', fontSize: 10, color: TEXT_BODY_COLOR, formatter: '{c}%' },
      data: equipmentUtilization.value.map((e) => e.value)
    }
  ]
}))

/**
 * 产量趋势底栏：「最后一个月完成率 = 实际 ÷ 计划」。
 * 与指标卡的「计划完成率」是同一件事的两种写法，写出来两者对不上就会被看见。
 */
const outputGapText = computed(() => {
  const { months, plan, actual } = productionOutput.value
  const i = months.length - 1
  if (i < 0 || !plan[i]) return ''
  const rate = ((actual[i] / plan[i]) * 100).toFixed(2)
  return `${months[i]}完成率 ${rate}%（实际 ${actual[i]} ÷ 计划 ${plan[i]} ${productionOutput.value.unit}）`
})

/** 设备利用率底栏：综合利用率 = 各类别均值，与指标卡同一件事 */
const utilizationAvgText = computed(() => {
  const rows = equipmentUtilization.value
  if (!rows.length) return ''
  const avg = (sum(rows.map((r) => r.value)) / rows.length).toFixed(1)
  return `综合利用率 ${avg}%（${rows.length} 类设备均值）`
})

/** 工序效率：横条 + 满格背景（max=100），柱长本身就是达成率 */
const processOption = computed<EChartsOption>(() =>
  buildHBar(
    processEfficiency.value.map((p) => ({ name: p.name, value: p.actual })),
    { unit: '%', max: 100, background: true, labelFmt: (v) => `${v}%` }
  )
)

const lossDilutionOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, right: 0, data: lossDilution.value.series.map((s) => s.name) },
  grid: { top: 30, left: 4, right: 4, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: lossDilution.value.months },
  yAxis: { type: 'value', name: lossDilution.value.unit || '%', nameTextStyle: AXIS_NAME_STYLE },
  series: lossDilution.value.series.map((s, i) => ({
    name: s.name,
    type: 'line' as const,
    smooth: true,
    symbolSize: 5,
    // 用黄、橙两个弱警示色：这两项都是「越低越好」的负面指标
    lineStyle: { width: 2, color: CHART_COLORS[3 + i] },
    itemStyle: { color: CHART_COLORS[3 + i] },
    data: s.data
  }))
}))

// ---------- ③ 安全分析 ----------
const hazardTotal = computed(() => sum(hazardTypeDistribution.value.map((i) => i.value)))

const hazardTypeOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {c} 项' },
  legend: {
    orient: 'vertical',
    right: 0,
    top: 'center',
    itemWidth: 8,
    itemHeight: 8,
    textStyle: { fontSize: 11 }
  },
  series: [
    {
      type: 'pie',
      radius: ['50%', '72%'],
      center: ['38%', '52%'],
      label: { show: false },
      labelLine: { show: false },
      data: hazardTypeDistribution.value.map((i) => ({
        name: i.name,
        value: i.value,
        itemStyle: { color: i.color }
      }))
    }
  ],
  // 圆心写合计：环形图各段之和等于隐患上报数，这个数是本页的一条数据约束，
  // 写在圆心既好看也让看的人能当场对上
  graphic: [
    {
      type: 'text',
      left: '35%',
      top: '44%',
      style: {
        text: `${hazardTotal.value}\n项`,
        fill: TEXT_BODY_COLOR,
        fontSize: 18,
        fontWeight: 'bold',
        align: 'center',
        lineHeight: 20
      }
    }
  ]
}))

/** 事故率趋势：起数柱（左轴）+ 千人负伤率折线（右轴）——两者量纲差 100 倍，必须双轴 */
const accidentOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, right: 0, data: ['事故起数', '千人负伤率'] },
  grid: { top: 34, left: 4, right: 4, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: accidentTrend.value.months },
  yAxis: [
    valueAxis('起', true),
    // 右轴留余量，否则折线最高点会贴顶
    { ...valueAxis('‰', false), max: (v: { max: number }) => Math.ceil(v.max * 1.6 * 100) / 100 }
  ],
  series: [
    {
      name: '事故起数',
      type: 'bar',
      barWidth: 12,
      itemStyle: {
        borderRadius: [2, 2, 0, 0],
        color: barGradient(CHART_COLORS[5], fadeColor(CHART_COLORS[5], 0.18))
      },
      data: accidentTrend.value.counts
    },
    {
      name: '千人负伤率',
      type: 'line',
      yAxisIndex: 1,
      smooth: true,
      symbolSize: 4,
      // 12 个月的点不挂数据标签：挤在一起反而看不清，数值交给 tooltip
      lineStyle: { width: 2, color: CHART_COLORS[3] },
      itemStyle: { color: CHART_COLORS[3] },
      data: accidentTrend.value.ratePerThousand
    }
  ]
}))

const violationTypeOption = computed<EChartsOption>(() =>
  buildCountBar(violationStats.value.byType, '次', CHART_COLORS[4])
)

const violationTeamOption = computed<EChartsOption>(() =>
  buildCountBar(violationStats.value.byTeam, '次', CHART_COLORS[6])
)

// ---------- ④ 能耗单耗 ----------
/** 各段电费（万元）= 该段电量 × 该段电价 */
const tariffCostPerPeriod = computed(() =>
  tariffUsage.value.energy.map((kwh, i) =>
    Number((kwh * (tariffUsage.value.price[i] ?? 0)).toFixed(1))
  )
)

const tariffTotalText = computed(() => sum(tariffUsage.value.energy).toFixed(1))
const tariffCostText = computed(() => sum(tariffCostPerPeriod.value).toFixed(1))

const tariffOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  legend: { top: 0, right: 0, data: ['电量', '电费'] },
  grid: { top: 34, left: 4, right: 4, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: tariffUsage.value.periods },
  yAxis: [valueAxis('万kWh', true), valueAxis('万元', false)],
  series: [
    {
      name: '电量',
      type: 'bar',
      barWidth: 22,
      itemStyle: {
        borderRadius: [2, 2, 0, 0],
        color: barGradient(CHART_COLORS[0], fadeColor(CHART_COLORS[0], 0.18))
      },
      label: { show: true, position: 'top', fontSize: 10, color: TEXT_BODY_COLOR },
      data: tariffUsage.value.energy
    },
    {
      name: '电费',
      type: 'bar',
      barWidth: 22,
      itemStyle: {
        borderRadius: [2, 2, 0, 0],
        color: barGradient(CHART_COLORS[3], fadeColor(CHART_COLORS[3], 0.18))
      },
      label: { show: true, position: 'top', fontSize: 10, color: TEXT_BODY_COLOR },
      data: tariffCostPerPeriod.value
    }
  ]
}))

/**
 * 能耗构成底栏：把「电力」那一项的数值写出来。
 * 它与峰谷平三段电费之和必须相等 —— 同一个数在两个面板上各画一次，
 * 对不上时屏幕上不会有任何提示，只能靠把数写进 DOM 来断言。
 */
const electricMixText = computed(() => {
  const item = energyMix.value.find((i) => i.name === '电力')
  return item ? `电力 ${item.value} 万元 = 峰谷平三段电费之和` : ''
})

const energyMixOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {c} 万元' },
  legend: {
    orient: 'vertical',
    right: 0,
    top: 'center',
    itemWidth: 8,
    itemHeight: 8,
    textStyle: { fontSize: 11 }
  },
  series: [
    {
      type: 'pie',
      radius: ['50%', '72%'],
      center: ['38%', '52%'],
      label: { show: false },
      labelLine: { show: false },
      data: energyMix.value.map((i) => ({
        name: i.name,
        value: i.value,
        itemStyle: { color: i.color }
      }))
    }
  ]
}))

/** 吨矿水耗（m³/t）= 月用水量 ÷ 月产量，万元/万吨那套量纲抵消同样适用 */
const waterPerTonText = computed(() => {
  const v = waterUsage.value.values
  const out = tariffUsage.value.outputFor
  if (!v.length || !out) return '0.00'
  return (v[v.length - 1] / out).toFixed(2)
})

const waterOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  grid: { top: 26, left: 4, right: 4, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: waterUsage.value.months },
  yAxis: {
    type: 'value',
    name: waterUsage.value.unit || '万m³',
    nameTextStyle: AXIS_NAME_STYLE
  },
  series: [
    {
      name: '用水量',
      type: 'line',
      smooth: true,
      symbolSize: 5,
      lineStyle: { width: 2, color: CHART_COLORS[6] },
      itemStyle: { color: CHART_COLORS[6] },
      areaStyle: { color: areaGradient(fadeColor(CHART_COLORS[6], 0.4)) },
      data: waterUsage.value.values
    }
  ]
}))

/** 单耗趋势：吨矿电耗与吨矿水耗两项量纲差约 60 倍，各占一根轴 */
const unitConsumptionOption = computed<EChartsOption>(() => {
  const series = unitConsumption.value.series
  return {
    tooltip: { trigger: 'axis' },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 8,
      itemGap: 8,
      textStyle: { fontSize: 10 },
      data: series.map((s) => s.name)
    },
    grid: { top: 34, left: 4, right: 4, bottom: 0, containLabel: true },
    xAxis: { type: 'category', data: unitConsumption.value.months },
    yAxis: [valueAxis('kWh/t', true), valueAxis('m³/t', false)],
    series: series.map((s, i) => ({
      name: s.name,
      type: 'line' as const,
      yAxisIndex: i,
      smooth: true,
      symbolSize: 5,
      lineStyle: { width: 2, color: CHART_COLORS[i === 0 ? 2 : 6] },
      itemStyle: { color: CHART_COLORS[i === 0 ? 2 : 6] },
      data: s.data
    }))
  }
})

const tonCostOption = computed<EChartsOption>(() =>
  buildHBar(
    tonCostBreakdown.value.items.map((i) => ({ name: i.name, value: i.value, color: i.color })),
    { unit: tonCostBreakdown.value.unit || '元/吨' }
  )
)

const machineCostOption = computed<EChartsOption>(() =>
  buildHBar(
    machineCost.value.items.map((i) => ({ name: i.name, value: i.value })),
    { unit: machineCost.value.unit || '万元/台·月' }
  )
)

/** 单机成本月合计（万元）= Σ 单机成本 × 台数 */
const machineTotalText = computed(() =>
  machineCost.value.items.reduce((s, i) => s + i.value * i.count, 0).toFixed(1)
)
</script>

<style lang="scss" scoped>
.decision {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.decision__main {
  display: flex;
  flex-direction: column;
  width: 100%;
  flex: 1;
  min-height: 0;
}

.decision__grid {
  display: grid;
  flex: 1;
  min-height: 0;
  // auto 行给指标卡，其余三行按比例吃满剩余高度，保证整页无纵向滚动
  grid-template-rows: auto minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 0.9fr);
  gap: $panel-gap;
  padding: $panel-gap;
}

.decision__metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: $panel-gap;
}

.decision__row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: $panel-gap;
  min-height: 0;

  &--split {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr);
  }

  &--half {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/**
 * 新增三个维度共用的栅格 ——「指标卡 + 两行面板」，比「成本效益」维少一行。
 * 内容区可用高 964px，扣指标卡行 74 与两道 gap 32，余 858px 按 1.05 : 1 分
 * ⇒ 面板行 439 / 419，面板 body 401px（与设备管理页中排同高）。
 */
.decision__grid--analysis {
  grid-template-rows: auto minmax(0, 1.05fr) minmax(0, 1fr);
}

// ---------- 顶栏四维切换条 ----------
// 这条控件渲染在 AppHeader 的 #extra 里，但模板写在本页 ⇒ 带的是本页的 scope id，
// 所以样式写在这里能生效，不需要 :deep()。
.decision__dims {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
  background: rgba(0, 229, 255, 0.04);
}

.decision__dim {
  height: 24px;
  padding: 0 14px;
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

// ---------- 前 5 大支出项 ----------
.decision__amount {
  @include numeric;
  font-weight: 600;
  color: $primary;
}

// ---------- 效益分析 ----------
.decision__benefits {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: center;
  height: 100%;
}

.decision__benefit {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;

  & + & {
    border-left: 1px solid $border-soft;
  }
}

.decision__benefit-label {
  font-size: $fs-small;
  color: $text-secondary;
  @include ellipsis;
}

.decision__benefit-value {
  display: flex;
  align-items: baseline;
  gap: 3px;
  font-family: $font-number;
  font-size: $fs-metric;
  font-weight: 700;
  color: $text-primary;
  @include glow-text($primary, 10px);

  em {
    font-size: $fs-small;
    font-style: normal;
    font-weight: 400;
    color: $text-secondary;
    text-shadow: none;
  }
}

.decision__benefit-arrow {
  font-size: $fs-small;
  color: $green;
  @include glow-text($green, 8px);
}

// ---------- 智能辅助决策建议 ----------
.decision__suggestions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
}

.decision__suggestion {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 0;
  padding: 0 10px;
  border: 1px solid $border-soft;
  border-left: 2px solid currentColor;
  background: $bg-panel-soft;

  // 建议等级决定标签与左侧色条颜色
  &.is-high {
    color: $red;
  }
  &.is-mid {
    color: $orange;
  }
  &.is-low {
    color: $blue;
  }
}

.decision__suggestion-tag {
  flex-shrink: 0;
  padding: 2px 8px;
  font-size: $fs-small - 1px;
  font-weight: 600;
  color: currentColor;
  border: 1px solid currentColor;
  border-radius: $radius-sm;
}

.decision__suggestion-text {
  font-size: $fs-small;
  color: $text-body;
  @include ellipsis;
}
</style>
