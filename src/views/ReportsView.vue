<template>
  <div class="reports">
    <AppHeader :show-nav="false" title="统计报表 · 看过去" />

    <main class="reports__main">
      <!-- 中央三维：本页的空间维度不在图里，在「数据发生在哪」——见下方 UNITS -->
      <div class="reports__map">
        <MapScene
          ref="sceneRef"
          :build="buildScene"
          :home="REPORTS_HOME"
          pick
          @pick="onPick"
        />
      </div>

      <!-- 顶部指标卡：日报口径的当期数字，来自 productionMetrics -->
      <div class="reports__metrics">
        <MetricCard
          v-for="m in productionMetrics"
          :key="m.label"
          :label="m.label"
          :value="m.value"
          :unit="m.unit"
          :decimals="m.decimals ?? 0"
          :color="m.color"
          :chain="m.chain"
          :yoy="m.yoy"
        />
      </div>

      <!-- 左列 -->
      <div class="reports__side reports__side--left">
        <PanelBox
          title="生产量趋势"
          subtitle="OUTPUT TREND"
          class="reports__panel"
          :class="{ 'is-linked': linked === '北帮采剥面' }"
        >
          <template #extra>柱：日产量 · 线：同比 · 点柱定位</template>
          <EchartBox
            :option="outputOption"
            height="100%"
            clickable
            @click="onChartClick('北帮采剥面', $event)"
          />
        </PanelBox>

        <PanelBox
          title="年度生产数据"
          subtitle="ANNUAL OUTPUT"
          class="reports__panel"
          :class="{ 'is-linked': linked === '北帮采剥面' }"
        >
          <template #extra>{{ annualHeatmap.values.length }} 天 · {{ annualHeatmap.months.length }} 个月 · 点格定位</template>
          <EchartBox
            :option="heatmapOption"
            height="100%"
            clickable
            @click="onChartClick('北帮采剥面', $event)"
          />
        </PanelBox>

        <PanelBox title="今日生产类型分布" subtitle="TYPE DISTRIBUTION" class="reports__panel">
          <template #extra>按类型占比</template>
          <EchartBox :option="typeOption" height="100%" />
          <!--
            这张图**故意不给点击**：八个类型名就是「类型1…类型8」占位，
            源数据里认不出它们各自属于哪个作业单元。挂上点击只会得到一个
            「点了没反应还不报错」的死区，不如直接把原因写在脸上。
            （与 CostView 的「各类型成本分布」是同一类占位数据，那边的处理见其注释。）
          -->
          <template #footer>类型名为占位，无法归属到作业单元，故不参与三维联动</template>
        </PanelBox>
      </div>

      <!-- 右列 -->
      <div class="reports__side reports__side--right">
        <PanelBox
          title="质检记录"
          subtitle="INSPECTION RECORDS"
          class="reports__panel"
          :class="{ 'is-linked': linked === '选矿厂' }"
        >
          <!-- 报表导出对应指导文档 5.2「自动生成标准化调度报表，支持 Excel/PDF 导出」 -->
          <template #extra>
            <span v-if="abnormalCount" class="reports__warn">{{ abnormalCount }} 条异常</span>
            <button class="reports__export" type="button" @click="onExportQualityRecords">
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
            <el-table-column prop="time" label="时间" width="96" />
            <el-table-column prop="issue" label="质检异常情况" min-width="76">
              <template #default="{ row }">
                <span :class="{ 'is-abnormal': row.issue !== '无异常' }">{{ row.issue }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="action" label="处理措施" min-width="80" />
            <el-table-column prop="owner" label="负责人" width="48" />
          </el-table>
        </PanelBox>

        <PanelBox
          title="报表中心"
          subtitle="REPORT CENTER"
          class="reports__panel"
          :class="{ 'is-linked': !!linked }"
        >
          <template #extra>
            <span v-if="linked" class="reports__linked">联动中 · {{ linked }}</span>
            <span v-else>点行定位到数据来源</span>
          </template>
          <ul class="reports__list">
            <li
              v-for="r in reports"
              :key="r.key"
              class="reports__row"
              :class="{ 'is-linked': linked === r.scope }"
              @click="focusReport(r)"
            >
              <span class="reports__row-name">{{ r.name }}</span>
              <span class="reports__row-scope">{{ r.scope }}</span>
              <span class="reports__row-count">{{ r.count }} {{ r.unit }}</span>
            </li>
          </ul>
          <template #footer>点一行 → 飞到该报表数据来源的作业单元</template>
        </PanelBox>

        <PanelBox
          title="质量活动"
          subtitle="QUALITY ACTIVITY"
          class="reports__panel"
          :class="{ 'is-linked': linked === '选矿厂' }"
        >
          <template #extra>{{ qualityActivity.years.length }} 个年度 · 点柱定位</template>
          <EchartBox
            :option="qualityOption"
            height="100%"
            clickable
            @click="onChartClick('选矿厂', $event)"
          />
        </PanelBox>
      </div>

      <!-- 底部两栏。只放两块：调度值班是 5 列表格，三栏宽度放不下会出横向滚动条 -->
      <div class="reports__bottom">
        <PanelBox
          title="掘进进尺：计划 vs 实际"
          subtitle="DRILLING PLAN VS ACTUAL"
          class="reports__panel"
          :class="{ 'is-linked': linked === '东帮爆破区' }"
        >
          <template #extra>折线为达成率 · 点柱定位</template>
          <EchartBox
            :option="drillingOption"
            height="100%"
            clickable
            @click="onChartClick('东帮爆破区', $event)"
          />
        </PanelBox>

        <PanelBox
          title="调度值班与交接班"
          subtitle="DUTY ROSTER"
          class="reports__panel"
          :class="{ 'is-linked': linked === '厂区' }"
        >
          <template #extra>交接中的班次标青</template>
          <el-table
            :data="dutySchedule"
            size="small"
            height="100%"
            class="data-table"
            :header-cell-style="{ ...tableHeaderStyle() }"
            :cell-style="{ ...tableCellStyle() }"
          >
            <el-table-column prop="shift" label="班次" width="56" />
            <el-table-column prop="time" label="时段" width="100" />
            <el-table-column prop="leader" label="值班长" width="64" />
            <el-table-column prop="crew" label="作业队组" min-width="96" />
            <el-table-column prop="status" label="状态" width="60">
              <template #default="{ row }">
                <span :class="{ 'is-handover': row.status === '交接中' }">{{ row.status }}</span>
              </template>
            </el-table-column>
          </el-table>
        </PanelBox>
      </div>

      <!-- 拾取/联动浮层：必须是 .reports__main 的直接子元素，不能用 teleport -->
      <div v-if="picked" class="reports__pick" :style="pickStyle">
        <header class="reports__pick-head">
          <span class="reports__pick-kind">{{ picked.kind }}</span>
          <h4 class="reports__pick-title">{{ picked.title }}</h4>
          <button class="reports__pick-close" type="button" @click="clearPick">×</button>
        </header>
        <dl class="reports__pick-body">
          <div v-for="row in picked.rows" :key="row.label" class="reports__pick-row">
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
import { PLANT_BUILDINGS } from '@/scene/mineLayout'
import { HOME_WAYPOINT, type SceneWaypoint } from '@/scene/sceneConfig'
import { areaAnchor, parseEntityId, type ScenePick } from '@/scene/sceneTargets'
import {
  AXIS_LINE_COLOR,
  AXIS_NAME_STYLE,
  barGradient,
  CHART_COLORS,
  fadeColor,
  TEXT_MUTED_COLOR
} from '@/utils/chartTheme'
import { tableCellStyle, tableHeaderStyle } from '@/utils/tableTheme'
import { formatDay } from '@/utils/format'
import { useAsyncData } from '@/hooks/useAsyncData'
import * as productionApi from '@/api/production'
import type { ProductionMetric, QualityRecord } from '@/api/production'

/**
 * 统计报表（看过去）—— 四分法里的「历史」一页。
 *
 * 与另外三页的分工是**数据的时间性**，不是图表的种类：
 *   智能监控 = 此刻的快照 · 统计报表 = 过去的汇总 · 决策指挥 = 将来的判断 · 成本管理 = 花钱的去向
 * 所以本页**一律是时间序列与台账**（月/年/班次），不出现「此刻」的实时值
 * ——那是智能监控的活，也是用户当初说「两个页面一模一样」的根因。
 *
 * 大屏形态：三维铺底 + 左右各 3 块 + 底部 2 块。
 *
 * ---------------------------------------------------------------------------
 * 三维里画什么：**报表的作业单元**（不是地形，也不是又一排数）
 * ---------------------------------------------------------------------------
 * 本页的数据**全是时间维的**——月度、年度、班次，没有一条带经纬度。
 * 硬要给图表连一个坐标，就会出现「点 1 月和点 6 月飞到同一个地方」，
 * 那种联动比没有联动更让人困惑。所以这里换一个诚实的问法：
 * **这些报表说的数，分别发生在矿区的哪一片？**
 *
 * 于是三维上放四个「作业单元」标注，点它显示这个单元承载了哪几张报表；
 * 反过来点右列「报表中心」的某一行，飞到它的数据来源单元。
 * 两个方向都落在同一张表上（下面的 `UNITS`），不存在第二套口径。
 *
 * ⚠️ `scope` 那张对应表是**展示口径**，不是数据源里字段（数据源里根本没有
 * 「地点」这个维度，已 grep 确认）。它的依据是各单元实际干的事：
 * 质检的异常项写的是「调整破碎间隙」「延长脱水时间」，那是选矿厂工序；
 * 调度值班与交接班发生在综合办公楼。浮层把这个口径原样写给用户看，
 * 与成本管理页 `COST_SITE_OF` 同一套做法。
 */

// ---------- 数据 ----------
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

const abnormalCount = computed(
  () => qualityRecords.value.filter((r) => r.issue !== '无异常').length
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

// ---------------------------------------------------------------------------
// 作业单元 —— 三维那一层，也是全页唯一的空间口径
// ---------------------------------------------------------------------------

/**
 * 一个作业单元。
 *
 * ⚠️ `caption` 是**作业内容**（静态事实），不是统计值。
 * 三维标注的副行放的是「几张报表」（现算，见 `areaMarks`），
 * 两处都不是编出来的数。
 */
interface ReportUnit {
  /** 单元名。**必须是 `AREA_ANCHORS` 里的键**，否则定位不到（会退回原点那种安静的错误） */
  key: string
  /** 该单元在本页报表里的作业内容 */
  caption: string
  color: string
  /**
   * 厂区内的单元改按**厂房清单里的实测厂房**定位。
   *
   * 为什么：`AREA_ANCHORS` 里「厂区」与「选矿厂」是**同一个点**（都是
   * `plantPt(100, 0)`），两个标注会严丝合缝地叠在一起，谁也点不中。
   * 而质检落在磨浮/破碎一线、调度落在综合办公楼，本来就是两栋楼。
   * 厂房名对不上时**退回地名锚点并打一条 console.info**，不 `!` 也不抛：
   * 这里是展示层，厂房改名不该让整页白屏（`mock/safety.ts` 那边抛是因为它是数据源）。
   */
  building?: string
}

const UNITS: ReportUnit[] = [
  { key: '北帮采剥面', caption: '台阶采剥作业', color: CHART_COLORS[0] },
  { key: '东帮爆破区', caption: '穿孔爆破作业', color: CHART_COLORS[3] },
  // 「选矿厂」取**化验室**而不是磨浮主厂房：质检的异常项写的是「粒度偏粗 → 调整破碎间隙」
  // 「含水率偏高 → 延长脱水时间」，化验室正是这些数出来的地方；而且它与下面那栋楼
  // 隔了 300 多米，两个标注不会挤在一起（磨浮主厂房与综合办公楼只差 136m，标注会叠住）
  { key: '选矿厂', caption: '破碎 · 磨浮 · 脱水 · 化验', color: CHART_COLORS[1], building: '化验室' },
  { key: '厂区', caption: '调度指挥与交接班', color: CHART_COLORS[6], building: '综合办公楼' }
]

/** 单元坐标。取不到就返回 null，**由调用方过滤掉**，不退化成一个假坐标 */
function unitPoint(u: ReportUnit): { lon: number; lat: number; height: number } | null {
  if (u.building) {
    const b = PLANT_BUILDINGS.find((x) => x.name === u.building)
    if (b) {
      // 注视点海拔沿用厂区台地实测值（T1~T4 是 1374.2 ~ 1349.0，取 T2 偏上对全厂都够用），
      // 与 `sceneTargets.plantPoint` 同一个数；标注自身的贴地高度由图层采样，不在这儿定
      return { lon: b.lon, lat: b.lat, height: 1374 }
    }
    console.info(`[reports] 厂房清单里没有「${u.building}」，${u.key} 退回地名锚点`)
  }
  const a = areaAnchor(u.key)
  if (!a) {
    console.info(`[reports] AREA_ANCHORS 里没有「${u.key}」，该单元在三维上不画`)
    return null
  }
  return { lon: a.lon, lat: a.lat, height: a.height }
}

/**
 * 报表目录 —— 本页每一块数据集，都是「名 + 来源单元 + 条数」。
 *
 * **`count` 全是现算的**（`.length`），没有一个写死的数：
 * 写死就会出现「报表中心写着 6 条、质检记录表里只有 4 行」这种改了源头
 * 不改目录的分叉，两边单独看都「正常」。
 */
interface ReportItem {
  key: string
  /** 报表名 */
  name: string
  /** 数据来源的作业单元，**必须是 UNITS 的 key** —— 三维联动的唯一依据 */
  scope: string
  /** 对应本页哪块面板（浮层里显示，让人知道点的是哪张图） */
  panel: string
  count: number
  /** 条数的量词：月 / 天 / 年 / 条 / 班 */
  unit: string
}

const reports = computed<ReportItem[]>(() => [
  {
    key: 'output-trend',
    name: '生产量趋势月报',
    scope: '北帮采剥面',
    panel: '生产量趋势',
    count: outputTrend.value.months.length,
    unit: '月'
  },
  {
    key: 'annual-heatmap',
    name: '年度生产数据年报',
    scope: '北帮采剥面',
    panel: '年度生产数据',
    count: annualHeatmap.value.values.length,
    unit: '天'
  },
  {
    key: 'drilling',
    name: '掘进进尺月报',
    scope: '东帮爆破区',
    panel: '掘进进尺：计划 vs 实际',
    count: drillingProgress.value.months.length,
    unit: '月'
  },
  {
    key: 'quality-activity',
    name: '质量活动年报',
    scope: '选矿厂',
    panel: '质量活动',
    count: qualityActivity.value.years.length,
    unit: '年'
  },
  {
    key: 'quality-records',
    name: '质检记录明细',
    scope: '选矿厂',
    panel: '质检记录',
    count: qualityRecords.value.length,
    unit: '条'
  },
  {
    key: 'duty',
    name: '调度值班日报',
    scope: '厂区',
    panel: '调度值班与交接班',
    count: dutySchedule.value.length,
    unit: '班'
  }
])

/** 某个单元承载几张报表 —— 三维标注的副行与浮层都用它，**只算一次** */
function reportsOf(unitKey: string): ReportItem[] {
  return reports.value.filter((r) => r.scope === unitKey)
}

const areaMarks = computed<AreaMark[]>(() =>
  UNITS.flatMap((u) => {
    const at = unitPoint(u)
    if (!at) return []
    const n = reportsOf(u.key).length
    return [
      {
        key: u.key,
        name: u.key,
        // 副行放**现算的报表张数**：三维上写的数与右列目录里数出来的必须一样，
        // 这也是检查脚本的断言点（图上 2 张 = 目录里 2 行）
        caption: n ? `${n} 张报表` : '无报表',
        lon: at.lon,
        lat: at.lat,
        color: u.color
      }
    ]
  })
)

/**
 * 本页默认机位 —— **把四个作业单元全框进中央可视带**。
 *
 * 为什么不直接用 `HOME_WAYPOINT`：那个机位是给首页看新厂址谷底的，
 * 采坑整片落在画面下缘之外。实测四个标注的屏幕 y 是 1212 / 1063，
 * 而画布只有 996 高 —— 两个单元**根本点不着**（看不见的地物等于不存在，
 * 而且不报错，正是本项目反复踩的那类坑）。
 *
 * 注视点取四个单元坐标的几何中心，**由 `unitPoint` 现算**，不手抄经纬度
 * （手抄的坐标改了下游不知道，见 `mineLayout` 顶部那条规矩）。
 * heading / pitch / range 是照着「四个标注都落在左右侧栏之间、彼此拉得开」
 * 逐档试出来的（heading ∈ {0,15,30,45,61,90} × pitch ∈ {-35,-45,-55} ×
 * range ∈ {1800…4400}，共 108 档里这两项同时达标的没几个），
 * 试出来的最优解是 heading 0 / pitch -55 / range 3000，标注最小间距 166px。
 * **改了 `UNITS` 的锚点或侧栏宽度就要重跑一遍**，`check-linkage.mjs` 会红。
 */
const REPORTS_HOME: SceneWaypoint = (() => {
  const pts = UNITS.map(unitPoint).filter((p): p is { lon: number; lat: number; height: number } => p !== null)
  if (!pts.length) {
    console.info('[reports] 四个作业单元一个都定位不到，默认机位退回 HOME_WAYPOINT')
    return { ...HOME_WAYPOINT, key: 'reports-home' }
  }
  if (pts.length !== UNITS.length) {
    console.info(`[reports] ${UNITS.length - pts.length} 个作业单元没有坐标，默认机位按剩下的平均，构图会偏`)
  }
  const avg = (pick: (p: { lon: number; lat: number; height: number }) => number) =>
    pts.reduce((sum, p) => sum + pick(p), 0) / pts.length

  return {
    key: 'reports-home',
    label: '统计报表 · 全矿区',
    lon: avg((p) => p.lon),
    lat: avg((p) => p.lat),
    height: avg((p) => p.height),
    heading: 0,
    pitch: -55,
    range: 3000
  }
})()

/** 建场景：标注不依赖异步数据（坐标是静态的），但仍要等图层自带的采样完成 */
const sceneRef = shallowRef<InstanceType<typeof MapScene> | null>(null)

async function buildScene(viewer: Cesium.Viewer) {
  // prefix 必须与 `sceneTargets.PREFIXES` 里的 'stat-area-' 对上，否则拾取解析不出业务键
  await buildAreaMarkLayer(viewer, areaMarks.value, { prefix: 'stat-area' })
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
/** 选矿厂那张卡最多 5 行（作业内容 + 张数 + 3 张报表），190px 够用 */
const PICK_H = 190
/** 中央可视带：左右面板之内、底部两栏之上（数值与 SCSS 里的 $panel-width / $bottom-h 对齐） */
const CENTER_LEFT = 432
const CENTER_RIGHT = 1488
const CENTER_TOP = 104
const CENTER_BOTTOM = 772

const pickStyle = computed(() => {
  const x = Math.min(Math.max(pickAt.value.x + 14, CENTER_LEFT), CENTER_RIGHT - PICK_W)
  const y = Math.min(Math.max(pickAt.value.y + 14, CENTER_TOP), CENTER_BOTTOM - PICK_H - 8)
  return { left: `${x}px`, top: `${y}px` }
})

/**
 * 打开某个单元的浮层：把该单元承载的报表逐条列出来。
 *
 * 三维点标注、点报表目录行，两个方向最后都走这一个函数 ——
 * 各写一份就会出现「点三维显示 2 张、点目录显示 3 张」这种两边都像对的错。
 */
function openUnitCard(unitKey: string, at?: { x: number; y: number }) {
  const unit = UNITS.find((u) => u.key === unitKey)
  const mine = reportsOf(unitKey)
  if (!unit) {
    console.info(`[reports] 作业单元「${unitKey}」不在 UNITS 表里，无法定位`)
    return
  }

  pickAt.value = at ?? { x: CENTER_LEFT + 24, y: CENTER_TOP + 36 }
  linked.value = unitKey
  linkedEntityId.value = `stat-area-${unitKey}`
  setEntityHighlight(linkedEntityId.value)

  picked.value = {
    kind: '作业单元',
    title: unitKey,
    rows: [
      { label: '作业内容', value: unit.caption },
      { label: '承载报表', value: `${mine.length} 张` },
      ...mine.map((r) => ({ label: r.panel, value: `${r.count} ${r.unit}` })),
      // 口径写出来而不是藏起来：这条对应关系是归集出来的，不是源数据里的字段
      { label: '口径', value: '按作业内容归集（源数据无地点字段）' }
    ]
  }

  const at2 = unitPoint(unit)
  if (!at2) return
  sceneRef.value?.flyTo({
    key: `stat-area-${unitKey}`,
    label: unitKey,
    lon: at2.lon,
    lat: at2.lat,
    height: at2.height,
    heading: 0,
    pitch: -35,
    range: 1200
  })
}

/** 点报表目录某行 → 飞到它数据来源的单元（顺带把同单元的其它行一起点亮） */
function focusReport(r: ReportItem) {
  openUnitCard(r.scope)
}

/**
 * 点图表 → 打开该图**数据来源单元**的浮层（顺带飞过去）。
 *
 * ⚠️ 每张图**整张只归属一个单元**：源数据里没有地点字段（见 `UNITS` 注释），
 * 所以点哪根柱、哪个格子结果都一样。这是数据本身决定的，不是偷懒——
 * 但用户要的「点图表内容，看出图上这个数对应的是什么」在**这一层**就是
 * 「这张图的数是从哪个作业单元来的」，点一下就有答案。
 *
 * `params` 只用来打一条可查的日志（点到了哪个数据项），**不参与定位**。
 * 硬要按 dataIndex 编一个「第 3 根柱属于另一个单元」的分法，就是造假。
 */
function onChartClick(unitKey: string, params?: { name?: string; seriesName?: string }) {
  if (!UNITS.some((u) => u.key === unitKey)) {
    console.info(`[reports] 图表归属的作业单元「${unitKey}」不在 UNITS 表里，点图表不联动`)
    return
  }
  console.info(`[reports] 点图表数据项「${params?.seriesName ?? ''} ${params?.name ?? ''}」→ 定位 ${unitKey}`)
  openUnitCard(unitKey)
}

function onPick(hit: ScenePick) {
  if (!hit.entityId) return clearPick()
  const ref = parseEntityId(hit.entityId)
  if (!ref || ref.kind !== 'area') {
    // 采坑/厂区那一整片程序化地物都带 id（bench- / bld- / …），点中它们是常态，
    // 不是异常；只有「前缀认识但这次用不上」才留一条可查的痕迹
    if (ref) console.info(`[reports] 三维拾取到非报表单元的地物：${hit.entityId}`)
    return clearPick()
  }
  openUnitCard(ref.key, hit.screen)
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

/** 高亮尺寸与原值备份 —— 必须先存后改，否则还原时只能猜一个尺寸 */
const HIGHLIGHT_PIXEL_SIZE = 22
let highlightBackup: { entity: Cesium.Entity; size: number } | null = null

function setEntityHighlight(id: string) {
  const viewer = sceneRef.value?.viewer
  // ⚠️ 判活用 viewer.isDestroyed()，**不要写 entity.isDestroyed()**：
  // Cesium 的 Entity 类型上没有这个成员，编译不过（全库既有代码也都用 viewer 那一套）
  if (!viewer || viewer.isDestroyed()) return

  if (highlightBackup) {
    const { entity, size } = highlightBackup
    if (viewer.entities.contains(entity) && entity.point) {
      entity.point.pixelSize = new Cesium.ConstantProperty(size)
    }
    highlightBackup = null
  }

  if (!id) return
  const entity = viewer.entities.getById(id)
  if (!entity?.point) return

  const current = entity.point.pixelSize?.getValue(viewer.clock.currentTime)
  if (typeof current !== 'number') return

  highlightBackup = { entity, size: current }
  entity.point.pixelSize = new Cesium.ConstantProperty(HIGHLIGHT_PIXEL_SIZE)
}

// ---------------------------------------------------------------------------
// 报表导出
// ---------------------------------------------------------------------------

/**
 * 质检记录导出为 CSV。
 *
 * 纯前端生成，不经过后端——数据全是 Mock 的阶段，导出是少数能真正跑通、
 * 而不是「点了没反应」的动作。
 *
 * 用 CSV 而不是 xlsx：xlsx 要额外引一个几十 KB 的库，
 * 而 Excel 能直接打开 UTF-8 的 CSV，交付演示够用了。
 */
function onExportQualityRecords() {
  const rows = qualityRecords.value
  if (!rows.length) return
  const header = ['时间', '质检异常情况', '处理措施', '负责人']
  exportCsv(header, rows.map((r) => [r.time, r.issue, r.action, r.owner]), '质检记录')
}

/**
 * 生成并下载一个 CSV。
 *
 * 开头的 BOM 不能省：Excel 打开不带 BOM 的 UTF-8 CSV 会按 GBK 解码，
 * 中文全部变成乱码——这是 Windows 上交付这类文件最常见的翻车点。
 * 行分隔用 CRLF，同样是迁就 Excel。
 */
function exportCsv(header: string[], body: string[][], fileStem: string) {
  const csv = '\uFEFF' + [header, ...body].map(toCsvRow).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${fileStem}_${formatDay(new Date())}.csv`
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

// ---------------------------------------------------------------------------
// 图表
// ---------------------------------------------------------------------------

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

// ---------- 左1 生产量趋势（柱 + 同比折线双轴） ----------
const outputOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, right: 0, data: ['日产量', '同比'], itemWidth: 8, itemHeight: 8 },
  grid: { top: 30, left: 4, right: 8, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: outputTrend.value.months },
  yAxis: [valueAxis('吨', true), valueAxis('%', false)],
  series: [
    {
      name: '日产量',
      type: 'bar',
      barWidth: 18,
      itemStyle: {
        borderRadius: [2, 2, 0, 0],
        color: barGradient(CHART_COLORS[0], fadeColor(CHART_COLORS[0], 0.15))
      },
      data: outputTrend.value.output
    },
    {
      name: '同比',
      type: 'line',
      yAxisIndex: 1,
      smooth: true,
      symbolSize: 5,
      lineStyle: { width: 2, color: CHART_COLORS[2] },
      itemStyle: { color: CHART_COLORS[2] },
      data: outputTrend.value.yoy
    }
  ]
}))

// ---------- 左2 年度生产数据（日历热力矩阵） ----------
// 用散点矩阵实现：x = 日，y = 月，symbolSize 固定、颜色表示产量。
// 相比 heatmap 系列，散点不需要在坐标轴上铺满分类带，更适合大屏紧凑布局。
const heatmapOption = computed<EChartsOption>(() => ({
  tooltip: {
    formatter: (p: any) =>
      `${annualHeatmap.value.months[p.value[1]]} 第${p.value[0] + 1}日<br/>产量 ${p.value[2]} 吨`
  },
  grid: { top: 12, left: 4, right: 8, bottom: 0, containLabel: true },
  xAxis: {
    type: 'value',
    min: -0.5,
    max: 30.5,
    interval: 4,
    axisLabel: { formatter: (v: number) => `${v + 1}`, fontSize: 9, color: TEXT_MUTED_COLOR }
  },
  yAxis: {
    type: 'category',
    data: annualHeatmap.value.months,
    axisLabel: { fontSize: 9, color: TEXT_MUTED_COLOR },
    axisLine: { show: false },
    axisTick: { show: false },
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
      // 面板只有 ~160px 高放 12 行，符元再大就糊成一片
      symbolSize: 7,
      itemStyle: { borderWidth: 0 },
      data: annualHeatmap.value.values.map(([d, m, v]) => [d, m, v])
    }
  ]
}))

// ---------- 左3 今日生产类型分布（环形） ----------
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
      center: ['32%', '50%'],
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

// ---------- 右3 质量活动（分组柱状） ----------
const qualityOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, right: 0, itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 10 } },
  grid: { top: 26, left: 4, right: 8, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: qualityActivity.value.years },
  yAxis: valueAxis('次', true),
  series: qualityActivity.value.series.map((s, i) => ({
    name: s.name,
    type: 'bar' as const,
    barWidth: 8,
    itemStyle: {
      borderRadius: [2, 2, 0, 0],
      color: barGradient(CHART_COLORS[i], fadeColor(CHART_COLORS[i], 0.2))
    },
    data: s.data
  }))
}))

// ---------- 底1 掘进进尺：计划 vs 实际（对比柱 + 达成率折线） ----------
const drillingOption = computed<EChartsOption>(() => {
  const { months, plan, actual } = drillingProgress.value
  // 达成率：实际/计划，计划为 0 时记 0，避免出现 Infinity
  const rate = actual.map((a, i) => (plan[i] ? +((a / plan[i]) * 100).toFixed(1) : 0))

  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0, right: 0, data: ['计划进尺', '实际进尺', '达成率'], itemWidth: 8, itemHeight: 8 },
    grid: { top: 30, left: 4, right: 8, bottom: 0, containLabel: true },
    xAxis: { type: 'category', data: months },
    yAxis: [valueAxis('米', true), valueAxis('%', false)],
    series: [
      {
        name: '计划进尺',
        type: 'bar',
        barWidth: 12,
        itemStyle: {
          borderRadius: [2, 2, 0, 0],
          color: barGradient(CHART_COLORS[1], fadeColor(CHART_COLORS[1], 0.18))
        },
        data: plan
      },
      {
        name: '实际进尺',
        type: 'bar',
        barWidth: 12,
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
</script>

<style lang="scss" scoped>
$metrics-h: 72px;
$bottom-h: 208px;

.reports {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.reports__main {
  position: relative;
  width: 100%;
  flex: 1;
  min-height: 0;
}

// ⚠️ 三维铺满整个 main。各面板容器是**绝对的叶子**，中间不许出现任何
// 「铺满中央」的 wrapper —— 那种容器会把整条中央带的鼠标事件吃掉，
// 三维点不动、转不了，而且不报错（见 EmergencyView 的硬约束注释）。
.reports__map {
  position: absolute;
  inset: 0;
}

.reports__metrics {
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

.reports__side {
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

// 底部只放两块。三块时 5 列的调度值班表在 340px 里放不下，
// 会出一根横向滚动条——大屏上没人会去拖它，等于最后两列看不见。
.reports__bottom {
  position: absolute;
  left: $panel-width + $panel-gap * 3;
  right: $panel-width + $panel-gap * 3;
  bottom: $panel-gap;
  height: $bottom-h;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: $panel-gap;
  z-index: $z-panel;
  pointer-events: none;

  :deep(.panel-box) {
    pointer-events: auto;
  }
}

// 联动中的面板描边。
// 这里的 `.is-linked` 加在 PanelBox 的**根元素**上（Vue 会把父组件的
// 作用域属性加到子组件根节点），所以这条规则在父组件的 scoped 样式里就能命中。
.reports__panel.is-linked {
  :deep(.panel-box__head) {
    background: linear-gradient(180deg, rgba(0, 229, 255, 0.16) 0%, transparent 100%);
  }
}

.reports__linked {
  color: $primary;
}

.reports__warn {
  margin-right: 6px;
  color: $yellow;
}

// 标题栏右侧的导出按钮。样式与隐患处置按钮保持同一套视觉，
// 大屏里同层级的操作入口不该有两副长相。
.reports__export {
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

// ---------- 报表目录 ----------
// 不做成图表：这是「一行一张报表」的形状，用 ECharts 反而要自己画轴，
// 还丢了点击热区。大屏里图与表混排也更像一张真正的作战图。
.reports__list {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}

.reports__row {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  font-size: $fs-small;
  border-left: 2px solid transparent;
  background: rgba(10, 32, 56, 0.5);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;

  &:hover {
    background: rgba(0, 229, 255, 0.12);
  }

  // 与三维联动时的标记：既是给用户的反馈，也是检查脚本的断言点
  &.is-linked {
    border-left-color: $primary;
    background: rgba(0, 229, 255, 0.16);
  }
}

.reports__row-name {
  flex-shrink: 0;
  color: $text-primary;
}

.reports__row-scope {
  flex: 1;
  min-width: 0;
  text-align: right;
  color: $text-secondary;
  @include ellipsis;
}

.reports__row-count {
  flex-shrink: 0;
  color: $text-muted;
  @include numeric;
}

// ---------- 表格 ----------
// 深色适配统一由全局 .data-table 与 utils/tableTheme 提供，此处不再重写
.is-abnormal {
  color: $yellow;
}

.is-handover {
  color: $primary;
}

// ---------- 浮层 ----------
.reports__pick {
  position: absolute;
  width: 300px;
  z-index: $z-popup;
  background: rgba(6, 26, 46, 0.94);
  border: 1px solid rgba($primary, 0.5);
  box-shadow: 0 0 18px rgba(0, 0, 0, 0.5);
  @include corner-brackets(10px, 2px, $primary);
}

.reports__pick-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid $border-soft;
  background: linear-gradient(180deg, rgba(0, 229, 255, 0.12) 0%, transparent 100%);
}

.reports__pick-kind {
  flex-shrink: 0;
  padding: 1px 5px;
  font-size: $fs-small - 1px;
  color: $bg-deep;
  background: $primary;
  border-radius: 2px;
}

.reports__pick-title {
  flex: 1;
  min-width: 0;
  font-size: $fs-small;
  font-weight: 600;
  color: $text-primary;
  @include ellipsis;
}

.reports__pick-close {
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

.reports__pick-body {
  padding: 8px 10px;
  // 选矿厂挂着 3 张报表 + 内容/张数/口径，超出就滚，不把浮层撑高到压住底部两栏
  max-height: 150px;
  overflow-y: auto;
}

.reports__pick-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  font-size: $fs-small - 1px;

  dt {
    flex-shrink: 0;
    width: 78px;
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
