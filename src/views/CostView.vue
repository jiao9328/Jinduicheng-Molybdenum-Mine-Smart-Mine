<template>
  <div class="cost">
    <AppHeader :show-nav="false" title="成本管理" />

    <main class="cost__main">
      <div class="cost__map">
        <MapScene
          ref="sceneRef"
          :build="buildScene"
          :home="HOME_WAYPOINT"
          pick
          @pick="onPick"
        />
      </div>

      <!--
        指标卡：吨成本 + 能耗四项。
        ⚠️ 这五行**不是**从 `energyMetrics` 直接 v-for 出来的：
        数据源那份没有「吨成本」这一项，而它是本页的头号数字。
        所以这里显式列五项，能耗那四项从 `energyMetrics` 按名字取——
        按名字取而不是按下标取，是怕数据源插一条就整体串位。
      -->
      <div class="cost__metrics">
        <MetricCard
          v-for="m in metrics"
          :key="m.label"
          :label="m.label"
          :value="m.value"
          :unit="m.unit"
          :decimals="m.decimals ?? 0"
          :color="m.color"
          :chain="m.chain"
          :yoy="m.yoy"
          :show-trend="m.chain !== undefined && m.yoy !== undefined"
        />
      </div>

      <!-- 左列 -->
      <div class="cost__side cost__side--left">
        <PanelBox title="吨成本拆解" subtitle="COST PER TON">
          <template #extra>
            <span v-if="linked" class="cost__linked">联动中 · {{ linked }}</span>
            <span v-else>点条形看成本发生地</span>
          </template>
          <EchartBox
            :option="tonCostOption"
            height="100%"
            clickable
            @click="onTonCostClick"
          />
          <template #footer>
            五项合计 <em class="cost__sum">{{ tonSum.toFixed(1) }}</em> {{ tonCostUnit }}
            <!-- 算出来的和与数据源标称的 total 不一致时**红着写出来**：
                 两个「合计」同时在屏上而谁也不提示，是本项目吃过一次亏的坑 -->
            <em v-if="tonMismatch" class="cost__mismatch">
              （与数据源标称的 {{ tonCostBreakdown.total }} 对不上）
            </em>
          </template>
        </PanelBox>

        <PanelBox title="峰谷平电费" subtitle="PEAK / FLAT / VALLEY">
          <EchartBox :option="tariffOption" height="100%" />
          <template #footer>
            合计 {{ tariffTotalText }} 万kWh · 电费 {{ tariffCostText }} 万元（= 各段电量 × 电价之和）
          </template>
        </PanelBox>
      </div>

      <!-- 右列 -->
      <div class="cost__side cost__side--right">
        <PanelBox title="各类型成本分布" subtitle="COST DISTRIBUTION">
          <template #extra>点扇区看归属地</template>
          <EchartBox
            :option="costDistributionOption"
            height="100%"
            clickable
            @click="onDistributionClick"
          />
        </PanelBox>

        <PanelBox title="前 5 大支出项" subtitle="TOP EXPENSES">
          <template #extra>点行看归属地</template>
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
            @row-click="onExpenseRowClick"
          >
            <el-table-column prop="item" label="支出项" min-width="92" />
            <el-table-column prop="amount" label="支出成本（万元）" min-width="124" align="right">
              <template #default="{ row }">
                <span class="cost__amount">{{ row.amount }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="date" label="支出日期" min-width="100" align="right" />
          </el-table>
        </PanelBox>
      </div>

      <!-- 底部三块 -->
      <div class="cost__bottom">
        <PanelBox title="能耗构成" subtitle="ENERGY MIX">
          <EchartBox :option="energyMixOption" height="100%" />
          <template #footer>{{ electricMixText }}</template>
        </PanelBox>

        <PanelBox title="单耗趋势" subtitle="UNIT CONSUMPTION">
          <EchartBox :option="unitConsumptionOption" height="100%" />
          <template #footer>吨矿电耗 = 月用电量 ÷ 月产量；吨矿水耗 = 月用水量 ÷ 月产量</template>
        </PanelBox>

        <PanelBox title="单机成本" subtitle="COST PER MACHINE">
          <template #extra>点条形看设备所在地</template>
          <EchartBox
            :option="machineCostOption"
            height="100%"
            clickable
            @click="onMachineCostClick"
          />
          <template #footer>月合计 {{ machineTotalText }} 万元</template>
        </PanelBox>
      </div>

      <!-- 拾取/联动浮层：必须是 .cost__main 的直接子元素，不能用 teleport -->
      <div v-if="picked" class="cost__pick" :style="pickStyle">
        <header class="cost__pick-head">
          <span class="cost__pick-kind">{{ picked.kind }}</span>
          <h4 class="cost__pick-title">{{ picked.title }}</h4>
          <button class="cost__pick-close" type="button" @click="clearPick">×</button>
        </header>
        <dl class="cost__pick-body">
          <div v-for="row in picked.rows" :key="row.label" class="cost__pick-row">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </div>
        </dl>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import * as Cesium from 'cesium'
import type { EChartsOption } from 'echarts'
import AppHeader from '@/components/AppHeader.vue'
import PanelBox from '@/components/PanelBox.vue'
import EchartBox from '@/components/EchartBox.vue'
import MetricCard from '@/components/MetricCard.vue'
import MapScene from '@/components/MapScene.vue'
import { buildAreaMarkLayer, type AreaMark } from '@/scene/layers/areaMarkLayer'
import { pitOffset } from '@/scene/mineLayout'
import { HOME_WAYPOINT } from '@/scene/sceneConfig'
import { highlightAt } from '@/scene/highlight'
import { areaAnchor, parseEntityId, type ScenePick } from '@/scene/sceneTargets'
import {
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
import * as twinApi from '@/api/digitalTwin'
import type { CostMetric, TopExpense } from '@/api/decision'
import type { TwinDevice } from '@/api/digitalTwin'

/**
 * 成本管理（看花钱）—— 四分法里的「成本」一页。
 *
 * 本页只回答一个问题：**钱花在哪**。
 * 「花得值不值」是结论，归决策指挥，这里不写效益分析（那是重复的源头之一）。
 *
 * 与其他三页的分工：
 *   智能监控 = 此刻 · 统计报表 = 过去的汇总 · 决策指挥 = 将来的判断 · 成本管理 = 花钱的去向
 * 所以本页**不出现年度序列**（那是统计报表的活），只有吨成本、电费、单耗、单机成本。
 *
 * 大屏形态：三维铺底 + 左右各 2 块面板 + 底部 3 块。
 * 三维里画的不是地形，而是**成本归属地**——点某一项成本，飞到它发生的地方。
 */

// ---------- 数据 ----------
const { data: energyMetrics } = useAsyncData(decisionApi.fetchEnergyMetrics, [] as CostMetric[])
const { data: tonCostBreakdown } = useAsyncData(decisionApi.fetchTonCostBreakdown, {
  items: [] as { name: string; value: number; color: string }[],
  total: 0,
  unit: '元/吨'
})
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
const { data: unitConsumption } = useAsyncData(decisionApi.fetchUnitConsumption, {
  months: [] as string[],
  series: [] as { name: string; data: number[] }[]
})
const { data: machineCost } = useAsyncData(decisionApi.fetchMachineCost, {
  items: [] as { name: string; value: number; count: number }[],
  unit: '万元/台·月'
})
const { data: costDistribution } = useAsyncData(decisionApi.fetchCostDistribution, [] as {
  name: string
  value: number
  color: string
}[])
const { data: topExpenses } = useAsyncData(decisionApi.fetchTopExpenses, [] as TopExpense[])

/**
 * 设备点位。**不是画给用户看的**，而是用来推算「钻机/卡车在哪作业」——
 * 成本归属地的经纬度由它算出来，见下面 COST_SITES。
 */
const devicesPromise = twinApi.fetchTwinDevices()
const { data: devices } = useAsyncData(() => devicesPromise, [] as TwinDevice[])

// ---------- 指标卡 ----------
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0)

/** 五项之和 —— 与数据源里的 `total` 是两回事：一个是算出来的，一个是标称的 */
const tonSum = computed(() => sum(tonCostBreakdown.value.items.map((i) => i.value)))
const tonCostUnit = computed(() => tonCostBreakdown.value.unit || '元/吨')
const tonMismatch = computed(
  () => tonCostBreakdown.value.items.length > 0 && Math.abs(tonSum.value - tonCostBreakdown.value.total) > 0.05
)

interface CostCard {
  label: string
  value: number
  unit: string
  decimals?: number
  color: string
  chain?: number
  yoy?: number
}

const metrics = computed<CostCard[]>(() => {
  const byLabel = new Map(energyMetrics.value.map((m) => [m.label, m]))
  /** 按**名字**取能耗指标，取不到就退化成 0 而不是崩 */
  const energy = (label: string, fallbackColor: string): CostCard => {
    const m = byLabel.get(label)
    return m
      ? {
          label: m.label,
          value: m.value,
          unit: m.unit,
          decimals: m.decimals,
          color: m.color,
          chain: m.chain,
          yoy: m.yoy
        }
      : { label, value: 0, unit: '', color: fallbackColor }
  }

  return [
    // 吨成本取**算出来的五项之和**，不取数据源的 total：
    // 万一两者不一致，指标卡与下方拆解面板会同时反映出来，而不是各说各话
    {
      label: '吨成本',
      value: +tonSum.value.toFixed(1),
      unit: tonCostUnit.value,
      decimals: 1,
      color: CHART_COLORS[3]
    },
    energy('月电费', CHART_COLORS[1]),
    energy('月用电量', CHART_COLORS[0]),
    energy('月用水量', CHART_COLORS[6]),
    energy('吨矿电耗', CHART_COLORS[2])
  ]
})

// ---------- 单机成本合计 ----------
/** 单机成本月合计（万元）= Σ 单机成本 × 台数 */
const machineTotalText = computed(() =>
  machineCost.value.items.reduce((s, i) => s + i.value * i.count, 0).toFixed(1)
)

// ---------------------------------------------------------------------------
// 成本归属地（三维那一层）
// ---------------------------------------------------------------------------

/**
 * 四个归属地。**只有 4 个**，不是 10 个：
 * 单机成本 5 类 + 吨成本 5 类 = 10 个成本项，但它们落在同一片地方
 * （钻机与人力都在采坑、破碎机与能耗都在选矿厂），逐项画点会叠成一坨。
 * 所以按**地点**聚合成 4 个，多个成本项共用一个归属地是正常结果，
 * 反而说明「这几项钱都花在这儿」。
 */
const COST_SITES: { key: string; name: string; anchor: string; color: string }[] = [
  { key: '采坑', name: '采坑（北帮）', anchor: '北帮采剥面', color: CHART_COLORS[0] },
  { key: '运输道', name: '主运输道路', anchor: '主运输道路', color: CHART_COLORS[1] },
  { key: '选矿厂', name: '选矿厂', anchor: '选矿厂', color: CHART_COLORS[3] },
  { key: '厂区', name: '厂区其它', anchor: '厂区', color: CHART_COLORS[6] }
]

/**
 * 成本项 → 归属地。
 *
 * ⚠️ **这张表是展示口径，不是数据源里有的东西。** 数据源（`mock/decision.ts`）
 * 只有成本**按类型**的拆分，**没有按地点**的拆分（已 grep 确认）。
 * 所以下面每一条都是「这类成本主要发生在哪」的归集，不是实测归属。
 *
 * 移动设备那几条的**位置**是数据推导的（见 `costSiteMarks`：取 `twinDevices`
 * 里同类设备的实测点位均值），但「把某机型的单机成本记到它作业的地方」
 * 仍是口径。页面的拾取浮层会把口径原样写给用户看。
 */
const COST_SITE_OF: Record<string, string> = {
  // 单机成本的五个机型
  钻机: '采坑',
  挖掘机: '采坑',
  矿用卡车: '运输道',
  破碎机: '选矿厂',
  皮带机: '选矿厂',
  // 吨成本拆解的五个大类
  材料: '采坑',
  人力: '采坑',
  折旧: '采坑',
  能耗: '选矿厂',
  其它: '厂区',
  // 前 5 大支出项
  工资发放: '采坑',
  设备采购: '采坑',
  电费结算: '选矿厂',
  炸药采购: '采坑',
  备件采购: '厂区'
}

/**
 * 由 `twinDevices` 算出某类设备作业位置的中心（均值）。
 *
 * 「挖掘机」在设备台账里对应的是 `铲车`（前装机，同样干铲装的活）——
 * 这两个名字对不上，是全表里唯一一处需要人工对应的，单独拎出来说明。
 * 取不到就返回 null，由调用方退回锚点，**不硬凑一个坐标**。
 */
function deviceCentre(kind: TwinDevice['kind']): { lon: number; lat: number } | null {
  const list = devices.value.filter((d) => d.kind === kind)
  if (!list.length) return null
  const eastM = sum(list.map((d) => d.eastM)) / list.length
  const northM = sum(list.map((d) => d.northM)) / list.length
  const [lon, lat] = pitOffset(eastM, northM)
  return { lon, lat }
}

/**
 * 成本归属地的标注点 —— 位置优先取设备实测中心，取不到退回地名锚点。
 *
 * `derived` 是本页**自己加**的字段（图层不认它）：浮层据此如实告诉用户
 * 「这个点位是算出来的还是口径给的」，见下面 `口径` 那一行。
 */
type CostSiteMark = AreaMark & { derived: boolean }

const costSiteMarks = computed<CostSiteMark[]>(() =>
  COST_SITES.map((s) => {
    const anchor = areaAnchor(s.anchor)
    // 只有采坑与运输道能由设备位置推导，厂区类没有设备台账，只能走锚点
    const derived =
      s.key === '采坑' ? deviceCentre('钻机') : s.key === '运输道' ? deviceCentre('卡车') : null
    return {
      key: s.key,
      name: s.name,
      caption: '成本归属地',
      derived: derived !== null,
      lon: derived?.lon ?? anchor?.lon ?? 0,
      lat: derived?.lat ?? anchor?.lat ?? 0,
      color: s.color
    }
  })
)

/** 归属到某个地点的全部成本项（面板上高亮、浮层里罗列都用它） */
function itemsOfSite(siteKey: string) {
  const rows: { label: string; value: string }[] = []
  for (const item of tonCostBreakdown.value.items) {
    if (COST_SITE_OF[item.name] === siteKey) rows.push({ label: item.name, value: `${item.value} 元/吨` })
  }
  for (const item of machineCost.value.items) {
    if (COST_SITE_OF[item.name] === siteKey) {
      rows.push({ label: `${item.name}（${item.count} 台）`, value: `${item.value} 万元/台·月` })
    }
  }
  for (const e of topExpenses.value) {
    if (COST_SITE_OF[e.item] === siteKey) rows.push({ label: e.item, value: `${e.amount} 万元` })
  }
  return rows
}

// ---------- 建场景 ----------
const sceneRef = shallowRef<InstanceType<typeof MapScene> | null>(null)

/** 只等设备数据：归属地里那两个推导点靠它，锚点那几个不依赖异步 */
async function buildScene(viewer: Cesium.Viewer) {
  await devicesPromise
  // prefix 必须与 `sceneTargets.PREFIXES` 里的 'cost-site-' 对上，否则拾取解析不出业务键
  await buildAreaMarkLayer(viewer, costSiteMarks.value, { prefix: 'cost-site' })
}

// ---------- 左1 吨成本拆解 ----------
const tonCostOption = computed<EChartsOption>(() =>
  buildHBar(
    tonCostBreakdown.value.items.map((i) => ({
      name: i.name,
      value: i.value,
      color: i.color,
      // 联动高亮：配置项驱动，不用 dispatchAction（EchartBox 每次全量 setOption 会抹掉它）
      active: linked.value === i.name
    })),
    { unit: tonCostUnit.value }
  )
)

// ---------- 左2 峰谷平电费 ----------
/** 各段电费（万元）= 该段电量 × 该段电价 */
const tariffCostPerPeriod = computed(() =>
  tariffUsage.value.energy.map((kwh, i) => Number((kwh * (tariffUsage.value.price[i] ?? 0)).toFixed(1)))
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

// ---------- 右1 各类型成本分布 ----------
const distributionTotal = computed(() => sum(costDistribution.value.map((i) => i.value)))

const costDistributionOption = computed<EChartsOption>(() => ({
  tooltip: {
    trigger: 'item',
    // 占比写进 tooltip：环形图不带百分比时，「哪类占得多」只能靠弧长估
    formatter: (p: any) =>
      `${p.name}: ${p.value}（${distributionTotal.value ? ((p.value / distributionTotal.value) * 100).toFixed(1) : 0}%）`
  },
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
        itemStyle: {
          color: i.color,
          ...(linked.value === i.name ? { borderColor: '#ffffff', borderWidth: 2 } : {})
        }
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

// ---------- 底1 能耗构成 ----------
/**
 * 底栏那句「电力 = 峰谷平三段电费之和」——把数写进 DOM，
 * 屏幕上两个面板对不上时才有地方断言（本项目 check-decision 的老判据）。
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

// ---------- 底2 单耗趋势 ----------
/** 单耗趋势：吨矿电耗与吨矿水耗量纲差约 60 倍，各占一根轴 */
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

// ---------- 底3 单机成本 ----------
const machineCostOption = computed<EChartsOption>(() =>
  buildHBar(
    machineCost.value.items.map((i) => ({
      name: i.name,
      value: i.value,
      active: linked.value === i.name
    })),
    {
      unit: machineCost.value.unit || '万元/台·月',
      labelFmt: (v) => `${v}`
    }
  )
)

// ---------- 共用：横向条形图 ----------
/**
 * 横向条形图 —— 吨成本拆解 / 单机成本共用。
 * 与 DecisionView 里那个同名函数的区别只有一处：多了 `active`（联动高亮描边）。
 * **不复用 DecisionView 的那份**：那个文件即将整体改造，跨页 import 页面私有函数
 * 会让两页的改动互相牵扯；等两页都稳定了再谈抽公共件。
 */
function buildHBar(
  rows: { name: string; value: number; color?: string; active?: boolean }[],
  opts: { unit: string; labelFmt?: (v: number) => string }
): EChartsOption {
  // ECharts 的类目轴是从下往上排的，数据要翻一次才是从上往下的阅读顺序
  const data = [...rows].reverse()
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    // right 留 44px 给柱端数值标签，不留会被裁在画布外
    grid: { top: 8, left: 4, right: 44, bottom: 0, containLabel: true },
    xAxis: { type: 'value', name: opts.unit, nameTextStyle: AXIS_NAME_STYLE },
    yAxis: {
      type: 'category',
      data: data.map((r) => r.name),
      axisLabel: { fontSize: 10, color: TEXT_MUTED_COLOR }
    },
    series: [
      {
        type: 'bar',
        barWidth: 12,
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
            itemStyle: {
              borderRadius: [0, 2, 2, 0],
              color: barGradient(c, fadeColor(c, 0.35)),
              ...(r.active ? { borderColor: '#ffffff', borderWidth: 2 } : {})
            }
          }
        })
      }
    ]
  }
}

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

// ---------------------------------------------------------------------------
// 双向联动
// ---------------------------------------------------------------------------

const linked = ref('')
const linkedEntityId = ref('')

interface PickCard {
  kind: string
  title: string
  rows: { label: string; value: string }[]
}

const picked = ref<PickCard | null>(null)
const pickAt = ref({ x: 0, y: 0 })

const PICK_W = 300
const PICK_H = 200
const CENTER_LEFT = 432
const CENTER_RIGHT = 1488
const MAIN_H = 996

const pickStyle = computed(() => {
  const x = Math.min(Math.max(pickAt.value.x + 14, CENTER_LEFT), CENTER_RIGHT - PICK_W)
  const y = Math.min(Math.max(pickAt.value.y + 14, 104), MAIN_H - PICK_H - 16)
  return { left: `${x}px`, top: `${y}px` }
})

/** 归属地浮层：把这个地点承载的成本项全列出来，并如实写明归属口径 */
function openSiteCard(siteKey: string, at?: { x: number; y: number }) {
  const site = COST_SITES.find((s) => s.key === siteKey)
  const mark = costSiteMarks.value.find((m) => m.key === siteKey)
  if (!site || !mark) return

  pickAt.value = at ?? { x: CENTER_LEFT + 24, y: 320 }
  linked.value = siteKey
  linkedEntityId.value = `cost-site-${siteKey}`
  setEntityHighlight(linkedEntityId.value)

  picked.value = {
    kind: '成本归属地',
    title: site.name,
    rows: [
      ...itemsOfSite(siteKey),
      // 口径写出来而不是藏起来：这条数据是归集出来的，不是源数据里的实测归属。
      // 判据取 `mark.derived`（由 deviceCentre 是否取到决定），**不在这里重算一遍**
      // —— 同一个判断写两处，改了一处就会开始互相矛盾
      {
        label: '口径',
        value: mark.derived ? '按设备实测作业位置归集' : '按主要发生地归集'
      }
    ]
  }

  const anchor = areaAnchor(site.anchor)
  const lon = mark.lon || anchor?.lon
  const lat = mark.lat || anchor?.lat
  if (!lon || !lat) return
  sceneRef.value?.flyTo({
    key: `cost-site-${siteKey}`,
    label: site.name,
    lon,
    lat,
    height: 1345,
    heading: 0,
    pitch: -35,
    range: 1200
  })
}

function onTonCostClick(params: { name?: string } | undefined) {
  const name = params?.name
  if (!name) return
  const site = COST_SITE_OF[name]
  if (!site) {
    console.info(`[cost] 成本项「${name}」不在 COST_SITE_OF 表里，无法定位归属地`)
    return
  }
  openSiteCard(site)
}

function onMachineCostClick(params: { name?: string } | undefined) {
  onTonCostClick(params)
}

function onDistributionClick(params: { name?: string } | undefined) {
  const name = params?.name
  if (!name) return
  const site = COST_SITE_OF[name]
  if (!site) {
    // 各类型成本分布是「类型1..类型8」这类占位名，本来就对不上归属地表；
    // 打一条可查的痕迹，而不是安静地什么都不发生
    console.info(`[cost] 成本类型「${name}」没有归属地映射（数据源本身就是占位名）`)
    return
  }
  openSiteCard(site)
}

function onExpenseRowClick(row: TopExpense) {
  const site = COST_SITE_OF[row.item]
  if (!site) {
    console.info(`[cost] 支出项「${row.item}」不在 COST_SITE_OF 表里，无法定位归属地`)
    return
  }
  openSiteCard(site)
}

function onPick(hit: ScenePick) {
  if (!hit.entityId) return clearPick()
  const ref = parseEntityId(hit.entityId)
  if (!ref || ref.kind !== 'cost') {
    console.info(`[cost] 三维拾取到非成本地物：${hit.entityId}`)
    return clearPick()
  }
  openSiteCard(ref.key, hit.screen)
}

function clearPick() {
  picked.value = null
  linked.value = ''
  linkedEntityId.value = ''
  setEntityHighlight('')
}

// ---------------------------------------------------------------------------
// 高亮
// ---------------------------------------------------------------------------

/**
 * 高亮实现搬到了 `src/scene/highlight.ts`（三页原先各有一份逐字节相同的副本）。
 * 搬走的理由是**备份必须只有一份**：墩儿的命令栏也高亮，两份备份会让
 * 后还原的那个把高亮永久留在实体上。
 */
const setEntityHighlight = (id: string) => highlightAt(sceneRef.value?.viewer, id)

</script>

<style lang="scss" scoped>
$metrics-h: 72px;
$bottom-h: 236px;

.cost {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.cost__main {
  position: relative;
  width: 100%;
  flex: 1;
  min-height: 0;
}

// ⚠️ 三维铺满整个 main。各面板容器是**绝对的叶子**，中间不许出现任何
// 「铺满中央」的 wrapper —— 那种容器会把整条中央带的鼠标事件吃掉，
// 三维点不动、转不了，而且不报错（见 EmergencyView 的硬约束注释）。
.cost__map {
  position: absolute;
  inset: 0;
}

.cost__metrics {
  position: absolute;
  top: $panel-gap;
  left: $panel-width + $panel-gap * 2;
  right: $panel-width + $panel-gap * 2;
  height: $metrics-h;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: $panel-gap;
  z-index: $z-panel;
  pointer-events: none;

  :deep(.metric-card) {
    pointer-events: auto;
  }
}

.cost__side {
  position: absolute;
  top: $panel-gap + $metrics-h + $panel-gap;
  bottom: $panel-gap + $bottom-h + $panel-gap;
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

.cost__bottom {
  position: absolute;
  left: $panel-width + $panel-gap * 3;
  right: $panel-width + $panel-gap * 3;
  bottom: $panel-gap;
  height: $bottom-h;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: $panel-gap;
  z-index: $z-panel;
  pointer-events: none;

  :deep(.panel-box) {
    pointer-events: auto;
  }
}

.cost__linked {
  color: $primary;
}

.cost__amount {
  @include numeric;
  font-weight: 600;
  color: $primary;
}

// 拆解面板角上的合计。算出来的和与标称值不一致时下面那条会红着补一句
.cost__sum {
  font-style: normal;
  font-weight: 600;
  color: $primary;
}

.cost__mismatch {
  margin-left: 6px;
  font-style: normal;
  color: $red;
}

// ---------- 浮层 ----------
.cost__pick {
  position: absolute;
  width: 300px;
  z-index: $z-popup;
  background: rgba(6, 26, 46, 0.94);
  border: 1px solid rgba($primary, 0.5);
  box-shadow: 0 0 18px rgba(0, 0, 0, 0.5);
  @include corner-brackets(10px, 2px, $primary);
}

.cost__pick-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid $border-soft;
  background: linear-gradient(180deg, rgba(0, 229, 255, 0.12) 0%, transparent 100%);
}

.cost__pick-kind {
  flex-shrink: 0;
  padding: 1px 5px;
  font-size: $fs-small - 1px;
  color: $bg-deep;
  background: $primary;
  border-radius: 2px;
}

.cost__pick-title {
  flex: 1;
  min-width: 0;
  font-size: $fs-small;
  font-weight: 600;
  color: $text-primary;
  @include ellipsis;
}

.cost__pick-close {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  line-height: 1;
  font-size: 14px;
  color: $text-secondary;
  background: transparent;
  border: none;
  cursor: pointer;

  &:hover {
    color: $primary;
  }
}

.cost__pick-body {
  padding: 8px 10px;
  // 归属地最多挂着七八个成本项，超出就滚，不把浮层撑高到出屏
  max-height: 160px;
  overflow-y: auto;
}

.cost__pick-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  font-size: $fs-small - 1px;

  dt {
    flex-shrink: 0;
    width: 92px;
    color: $text-muted;
    @include ellipsis;
  }

  dd {
    flex: 1;
    min-width: 0;
    color: $text-body;
    @include ellipsis;
  }
}
</style>
