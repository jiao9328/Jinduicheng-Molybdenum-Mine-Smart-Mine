<template>
  <div class="monitor">
    <AppHeader :show-nav="false" title="智能监控" />

    <main class="monitor__main">
      <!-- 中央三维场景：本页的看点是现场本身，所以它一直铺到页面底部 -->
      <div class="monitor__map">
        <MapScene
          ref="sceneRef"
          :build="buildScene"
          :home="MONITOR_HOME"
          pick
          @pick="onPick"
        />
      </div>

      <!--
        顶部指标卡行。**五张卡全部 `show-trend=false`**：
        本页是「此刻」的快照（在岗 4 人、作业 5 台），环比同比对它们没有意义，
        硬显示只会是编造的数字或一排 0%。
      -->
      <div class="monitor__metrics">
        <MetricCard
          v-for="m in metrics"
          :key="m.label"
          :label="m.label"
          :value="m.value"
          :unit="m.unit"
          :decimals="m.decimals ?? 0"
          :color="m.color"
          :show-trend="false"
        />
      </div>

      <!-- 左列 -->
      <div class="monitor__side monitor__side--left">
        <PanelBox title="设备实时工况" subtitle="EQUIPMENT LIVE">
          <template #extra>
            <span v-if="linked" class="monitor__linked">联动中 · {{ linked }}</span>
            <span v-else>点条形可定位</span>
          </template>
          <EchartBox
            :option="deviceOption"
            height="100%"
            clickable
            @click="onDeviceClick"
          />
        </PanelBox>

        <PanelBox title="人员定位" subtitle="PERSONNEL TRACKING">
          <template #extra>{{ onlineCount }} / {{ people.length }} 在线</template>
          <ul class="monitor__list">
            <li
              v-for="p in people"
              :key="p.id"
              class="monitor__row"
              :class="{ 'is-linked': linked === p.name, 'is-offline': !p.online }"
              @click="focusPerson(p)"
            >
              <span class="monitor__row-dot" :class="{ 'is-off': !p.online }" />
              <span class="monitor__row-name">{{ p.name }}</span>
              <span class="monitor__row-role">{{ p.role }}</span>
              <span class="monitor__row-area">{{ p.area }}</span>
            </li>
          </ul>
        </PanelBox>

        <PanelBox title="边坡位移实时值" subtitle="SLOPE LIVE">
          <template #extra>阈值 {{ slopeThreshold }}mm</template>
          <EchartBox
            :option="slopeOption"
            height="100%"
            clickable
            @click="onSlopeClick"
          />
        </PanelBox>
      </div>

      <!-- 右列 -->
      <div class="monitor__side monitor__side--right">
        <PanelBox title="实时告警" subtitle="LIVE ALERTS">
          <template #extra>{{ openAlerts }} 条未闭环</template>
          <ul class="monitor__list">
            <li
              v-for="h in alerts"
              :key="h.id"
              class="monitor__row"
              :class="{ 'is-linked': linked === h.location }"
              @click="focusAlert(h)"
            >
              <span class="monitor__row-name">{{ h.type }}</span>
              <span class="monitor__row-area">{{ h.location }}</span>
              <StatusTag :status="h.status" :text="h.statusText" />
            </li>
          </ul>
        </PanelBox>

        <PanelBox title="作业面负载" subtitle="BENCH WORKLOAD">
          <template #extra>按作业面统计台数</template>
          <EchartBox :option="benchOption" height="100%" />
        </PanelBox>

        <PanelBox title="实时产量跟踪" subtitle="OUTPUT TRACKING">
          <template #extra>今日 vs 昨日</template>
          <EchartBox :option="outputOption" height="100%" />
        </PanelBox>
      </div>

      <!--
        拾取信息浮层。
        ⚠️ 必须是 `.monitor__main` 的**直接子元素**，不能用 teleport：
        teleport 会把它挪出 ScaleScreen 的等比缩放容器，1920×1080 之外的
        屏幕坐标会整片错位（各页面的弹层都遵守这一条）。
      -->
      <div v-if="picked" class="monitor__pick" :style="pickStyle">
        <header class="monitor__pick-head">
          <span class="monitor__pick-kind">{{ picked.kind }}</span>
          <h4 class="monitor__pick-title">{{ picked.title }}</h4>
          <button class="monitor__pick-close" type="button" @click="clearPick">×</button>
        </header>
        <dl class="monitor__pick-body">
          <div v-for="row in picked.rows" :key="row.label" class="monitor__pick-row">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </div>
        </dl>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import * as Cesium from 'cesium'
import type { EChartsOption } from 'echarts'
import AppHeader from '@/components/AppHeader.vue'
import PanelBox from '@/components/PanelBox.vue'
import EchartBox from '@/components/EchartBox.vue'
import MetricCard from '@/components/MetricCard.vue'
import MapScene from '@/components/MapScene.vue'
import StatusTag from '@/components/StatusTag.vue'
import {
  buildTwinDeviceLayer,
  buildTwinSlopeLayer
} from '@/scene/layers/twinLayer'
import { buildPersonnelLayer } from '@/scene/layers/emergencyLayer'
import { SCENE_WAYPOINTS, type SceneWaypoint } from '@/scene/sceneConfig'
import {
  areaAnchor,
  parseEntityId,
  pitWaypoint,
  type ScenePick,
  type TargetKind
} from '@/scene/sceneTargets'
import {
  areaGradient,
  barGradient,
  CHART_COLORS,
  fadeColor,
  TEXT_MUTED_COLOR
} from '@/utils/chartTheme'
import { useAsyncData } from '@/hooks/useAsyncData'
import * as twinApi from '@/api/digitalTwin'
import * as emergencyApi from '@/api/emergency'
import * as overviewApi from '@/api/overview'
import type { TwinDevice, TwinSlopeSite } from '@/api/digitalTwin'
import type { HazardDisposal, PersonnelPosition } from '@/api/emergency'

/**
 * 智能监控（看现在）—— 四分法里的「实时」一页。
 *
 * 与另外三页的分工是**数据的时间性**，不是图表的种类：
 *   智能监控 = 此刻的快照（设备在干什么、人在哪、哪条告警还没闭环）
 *   统计报表 = 过去的汇总（日报月报、年度热力、可导出）
 *   决策指挥 = 将来的判断（预测、建议、派单）
 *   成本管理 = 钱花在哪（吨成本、峰值平电费、单机成本）
 * 所以本页**不出现任何月度/年度序列** —— 那是统计报表的活。
 *
 * 本页也是四页里唯一**没有底部面板行**的一页：左右各 3 块，三维一直铺到
 * 页面底部。看点是现场本身，再压一行面板就把最贵的画面挤没了。
 */

// ---------- 数据 ----------
/**
 * 三维图层要用的数据先发起请求，`useAsyncData` 复用同一个 Promise。
 *
 * `build` 回调只会在建场景时跑一遍，晚到的数据补不进图层；
 * 而 `useAsyncData` 不返回 Promise、拿不到「数据到了」的信号。
 * 这是全库统一的写法（见 DigitalTwinView 同一处注释）。
 */
const devicesPromise = twinApi.fetchTwinDevices()
const slopesPromise = twinApi.fetchTwinSlopeSites()
const peoplePromise = emergencyApi.fetchPersonnelPositions()

const { data: devices } = useAsyncData(() => devicesPromise, [] as TwinDevice[])
const { data: slopeSites } = useAsyncData(() => slopesPromise, [] as TwinSlopeSite[])
const { data: people } = useAsyncData(() => peoplePromise, [] as PersonnelPosition[])
const { data: alerts } = useAsyncData(emergencyApi.fetchHazardDisposals, [] as HazardDisposal[])
const { data: outputStatistic } = useAsyncData(overviewApi.fetchOutputStatistic, {
  hours: [] as string[],
  today: [] as number[],
  yesterday: [] as number[]
})

// ---------- 指标卡：全部由上面的数组现算 ----------
/**
 * **五个数都能由页面上的数据算出来，没有一个是另写死的。**
 * 写死就会出现「环形图上写着 5 台作业中、指标卡却写着 6 台」这种
 * 改了源头不改汇总的分叉，而且两边单独看都「正常」——
 * 本项目已经在 `mock/emergency.ts` 上吃过一次同类的亏（见该文件顶部注释）。
 */
const metrics = computed(() => [
  {
    label: '在岗人员',
    value: people.value.filter((p) => p.online).length,
    unit: '人',
    color: CHART_COLORS[0]
  },
  {
    label: '作业设备',
    value: devices.value.filter((d) => d.status === '作业中').length,
    unit: '台',
    color: CHART_COLORS[1]
  },
  {
    label: '设备平均效率',
    value: devices.value.length
      ? +(devices.value.reduce((s, d) => s + d.efficiency, 0) / devices.value.length).toFixed(1)
      : 0,
    unit: '%',
    decimals: 1,
    color: CHART_COLORS[2]
  },
  {
    label: '超限监测站',
    value: slopeSites.value.filter((s) => s.displacement >= twinApi.TWIN_SLOPE_THRESHOLD).length,
    unit: '处',
    color: CHART_COLORS[3]
  },
  {
    label: '未闭环告警',
    value: alerts.value.filter((h) => h.status !== 'done').length,
    unit: '条',
    color: '#ff9f1c'
  }
])

const onlineCount = computed(() => people.value.filter((p) => p.online).length)
const openAlerts = computed(() => alerts.value.filter((h) => h.status !== 'done').length)
const slopeThreshold = twinApi.TWIN_SLOPE_THRESHOLD

/** 效率从高到低排 —— 「谁在拖后腿」一眼看出来，比按 id 排有信息量 */
const sortedDevices = computed(() =>
  [...devices.value].sort((a, b) => b.efficiency - a.efficiency)
)

// ---------- 选中态 ----------
/** 当前联动中的对象名，显示在面板角上，也是检查脚本的断言点 */
const linked = ref('')
/** 被点中的三维实体 id，用于还原高亮 */
const linkedEntityId = ref('')

// ---------- 左1 设备实时工况（横向条形，按状态着色） ----------
const deviceOption = computed<EChartsOption>(() => ({
  tooltip: {
    trigger: 'axis',
    axisPointer: { type: 'shadow' },
    formatter: (ps: any) => {
      const d = sortedDevices.value[ps[0].dataIndex]
      if (!d) return ''
      return `${d.name}<br/>${d.area} · ${d.status}<br/>当班效率 ${d.efficiency}%`
    }
  },
  grid: { top: 6, left: 4, right: 34, bottom: 0, containLabel: true },
  xAxis: { type: 'value', max: 100, show: false },
  yAxis: {
    type: 'category',
    // 反过来：ECharts 的类目轴自下而上，不反转的话效率最高的会排在最后一行
    data: sortedDevices.value.map((d) => d.name).reverse(),
    axisLabel: { fontSize: 10, color: TEXT_MUTED_COLOR },
    axisLine: { show: false },
    axisTick: { show: false }
  },
  series: [
    {
      type: 'bar',
      barWidth: 11,
      label: {
        show: true,
        position: 'right',
        fontSize: 10,
        color: TEXT_MUTED_COLOR,
        formatter: '{c}%'
      },
      data: [...sortedDevices.value].reverse().map((d) => {
        const color = twinApi.TWIN_DEVICE_STATUS_COLORS[d.status]
        const isOn = linked.value === d.name
        return {
          value: d.efficiency,
          itemStyle: {
            borderRadius: [0, 3, 3, 0],
            color: barGradient(color, fadeColor(color, 0.2)),
            // 选中项加白描边 —— 用**配置项**驱动高亮，不用 dispatchAction：
            // 后者会被任何一次 setOption 抹掉（EchartBox 每次 watch 都是全量替换），
            // 而配置项里的高亮状态天生跟着数据一起重算，不会丢。
            ...(isOn ? { borderColor: '#ffffff', borderWidth: 2 } : {})
          }
        }
      })
    }
  ]
}))

// ---------- 左2 / 左3 / 右1 用 HTML 列表与状态标签 ----------
// 这三块刻意**不做成图表**：全是「一行一条记录」的形状，
// 用 ECharts 反而要自己画轴、还丢了状态标签与点击热区。
// 大屏里图与表混排也更像一张真正的作战图，而不是一排图表的幻灯片。

// ---------- 左4 边坡位移实时值（当前值 vs 阈值） ----------
const slopeOption = computed<EChartsOption>(() => ({
  tooltip: {
    trigger: 'axis',
    axisPointer: { type: 'shadow' },
    formatter: (ps: any) => {
      const s = slopeSites.value[ps[0].dataIndex]
      if (!s) return ''
      return `${s.id} ${s.name}<br/>累计位移 ${s.displacement}mm<br/>速率 ${s.rate}mm/d`
    }
  },
  grid: { top: 6, left: 4, right: 40, bottom: 0, containLabel: true },
  xAxis: { type: 'value', max: Math.max(slopeThreshold * 1.6, 30), show: false },
  yAxis: {
    type: 'category',
    data: slopeSites.value.map((s) => `${s.id} ${s.name}`).reverse(),
    axisLabel: { fontSize: 10, color: TEXT_MUTED_COLOR },
    axisLine: { show: false },
    axisTick: { show: false }
  },
  series: [
    {
      type: 'bar',
      barWidth: 11,
      // 阈值线画在系列上：一条竖直虚线，超没超一眼看出来
      markLine: {
        silent: true,
        symbol: 'none',
        label: {
          formatter: '阈值',
          fontSize: 9,
          color: '#ff4d4f',
          position: 'end'
        },
        lineStyle: { color: '#ff4d4f', type: 'dashed', width: 1 },
        data: [{ xAxis: slopeThreshold }]
      },
      label: {
        show: true,
        position: 'right',
        fontSize: 10,
        color: TEXT_MUTED_COLOR,
        formatter: '{c}mm'
      },
      data: [...slopeSites.value].reverse().map((s) => {
        const color = twinApi.TWIN_SLOPE_STATUS_COLORS[twinApi.slopeStatus(s.displacement)]
        return {
          value: s.displacement,
          itemStyle: {
            borderRadius: [0, 3, 3, 0],
            color: barGradient(color, fadeColor(color, 0.2)),
            ...(linked.value === s.id ? { borderColor: '#ffffff', borderWidth: 2 } : {})
          }
        }
      })
    }
  ]
}))

// ---------- 右2 作业面负载（按作业面聚合台数的堆叠条） ----------
const benchOption = computed<EChartsOption>(() => {
  const byArea = new Map<string, Record<string, number>>()
  for (const d of devices.value) {
    // 注解不能省：`?? {}` 会让推断结果变成 `Record<string, number> | {}`，
    // 而 `{}` 没有索引签名，下一行 `row[d.status]` 会报「不能索引 {}」
    const row: Record<string, number> = byArea.get(d.area) ?? {}
    row[d.status] = (row[d.status] ?? 0) + 1
    byArea.set(d.area, row)
  }
  const areas = [...byArea.keys()]
  const statuses = ['作业中', '待机', '检修'] as const

  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0, right: 0, itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 10 } },
    grid: { top: 26, left: 4, right: 8, bottom: 0, containLabel: true },
    xAxis: { type: 'value', minInterval: 1 },
    yAxis: {
      type: 'category',
      data: areas,
      axisLabel: { fontSize: 10, color: TEXT_MUTED_COLOR },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    series: statuses.map((s) => ({
      name: s,
      type: 'bar' as const,
      stack: 'bench',
      barWidth: 11,
      itemStyle: { color: twinApi.TWIN_DEVICE_STATUS_COLORS[s] },
      data: areas.map((a) => byArea.get(a)?.[s] ?? 0)
    }))
  }
})

// ---------- 右3 实时产量跟踪（今日 vs 昨日，面积折线） ----------
const outputOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, right: 0, data: ['今日', '昨日'], itemWidth: 8, itemHeight: 8 },
  grid: { top: 26, left: 4, right: 8, bottom: 0, containLabel: true },
  xAxis: {
    type: 'category',
    data: outputStatistic.value.hours,
    boundaryGap: false,
    axisLabel: { fontSize: 9, color: TEXT_MUTED_COLOR, interval: 1 }
  },
  yAxis: { type: 'value', name: '吨', nameTextStyle: { color: TEXT_MUTED_COLOR, fontSize: 10 } },
  series: [
    {
      name: '今日',
      type: 'line',
      smooth: true,
      showSymbol: false,
      areaStyle: { color: areaGradient(fadeColor(CHART_COLORS[0], 0.5)) },
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

// ---------------------------------------------------------------------------
// 三维：建场景 + 拾取
// ---------------------------------------------------------------------------

/**
 * 默认机位：从采坑南侧俯瞰。
 *
 * 比数字孪生页那个 `pit` 机位更远（range 1900 vs 1500）——本页的图元
 * 不只在坑里，排土场上还有人员点位，坑内机位会把它们甩出画面。
 */
const MONITOR_HOME: SceneWaypoint = (() => {
  const pit = SCENE_WAYPOINTS.find((w) => w.key === 'pit')
  if (!pit) throw new Error('MonitorView：SCENE_WAYPOINTS 里没有 key 为 pit 的机位')
  return { ...pit, key: 'monitor-home', range: 1900 }
})()

const sceneRef = shallowRef<InstanceType<typeof MapScene> | null>(null)

/**
 * 三组业务图层：设备、边坡监测、作业人员。
 *
 * 每个构建器内部**各自**调一次 `sampleGroundHeights`（它们要采的点不同）。
 * 没有合并不是疏忽：合并要改 twinLayer / emergencyLayer 的签名，
 * 而那两个文件还被数字孪生页与应急页用着，为省几毫秒去动公共图层不划算。
 */
async function buildScene(viewer: Cesium.Viewer) {
  const [deviceList, slopeList, peopleList] = await Promise.all([
    devicesPromise,
    slopesPromise,
    peoplePromise
  ])

  await Promise.all([
    buildTwinDeviceLayer(viewer, deviceList),
    buildTwinSlopeLayer(viewer, slopeList),
    buildPersonnelLayer(viewer, peopleList)
  ])
}

/**
 * 三维高亮的原值。**必须先存后改**——不存原值就直接改小回去，
 * 会把设备点（10px）和边坡点（11px）统一压成同一个尺寸。
 */
let highlightBackup: { entity: Cesium.Entity; size: number } | null = null
const HIGHLIGHT_PIXEL_SIZE = 22

function setEntityHighlight(id: string) {
  const viewer = sceneRef.value?.viewer
  /**
   * ⚠️ 判活用 `viewer.isDestroyed()`，**不要写 `entity.isDestroyed()`**：
   * Cesium 的 `Entity` 类型上根本没有这个成员（编译不过），而且真要说
   * 「这个句柄还能不能用」，本来就该问 viewer——视图销毁时实体集合跟着没了。
   * 全库既有代码（createViewer / twinLayer / useCesium）清一色用的也是这个判据。
   */
  if (!viewer || viewer.isDestroyed()) return

  // 先还原上一个
  if (highlightBackup) {
    const { entity, size } = highlightBackup
    // `entities.contains` 而不是「不是 null 就算在」：图层可能已被重建，
    // 手里这个句柄指向的对象早就不在集合里了，此时写它的属性是静默无效的
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

/** 拾取浮层的展示内容 */
interface PickCard {
  kind: string
  title: string
  rows: { label: string; value: string }[]
  accent: string
}

const picked = ref<PickCard | null>(null)
const pickAt = ref({ x: 0, y: 0 })

/** 浮层尺寸，用来做边界钳制（与样式里的宽高一致） */
const PICK_W = 268
const PICK_H = 168
/** 中央可视区（左右面板之间），浮层不许越过它压到面板上 */
const CENTER_LEFT = 432
const CENTER_RIGHT = 1488
/** `__main` 的高度（1080 − 顶栏 84） */
const MAIN_H = 996

const pickStyle = computed(() => {
  const x = Math.min(
    Math.max(pickAt.value.x + 14, CENTER_LEFT),
    CENTER_RIGHT - PICK_W
  )
  const y = Math.min(Math.max(pickAt.value.y + 14, 104), MAIN_H - PICK_H - 16)
  return { left: `${x}px`, top: `${y}px` }
})

/**
 * 把拾取结果翻译成浮层内容。
 *
 * ⚠️ 查不到业务对象时**返回「未绑定数据」而不是猜一个**：
 * 猜出来的字段会让人以为三维和面板是通的，实际是编的。
 */
function describePick(ref: { kind: TargetKind; key: string }, name: string | null): PickCard {
  switch (ref.kind) {
    case 'device': {
      const d = devices.value.find((x) => x.id === ref.key)
      if (!d) break
      return {
        kind: '作业设备',
        title: d.name,
        accent: twinApi.TWIN_DEVICE_STATUS_COLORS[d.status],
        rows: [
          { label: '类型', value: d.kind },
          { label: '位置', value: d.area },
          { label: '状态', value: d.status },
          { label: '当班效率', value: `${d.efficiency}%` },
          { label: '最近上报', value: d.lastReport }
        ]
      }
    }
    case 'slope': {
      const s = slopeSites.value.find((x) => x.id === ref.key)
      if (!s) break
      const st = twinApi.slopeStatus(s.displacement)
      return {
        kind: '边坡监测站',
        title: `${s.id} ${s.name}`,
        accent: twinApi.TWIN_SLOPE_STATUS_COLORS[st],
        rows: [
          { label: '累计位移', value: `${s.displacement} mm` },
          { label: '位移速率', value: `${s.rate} mm/d` },
          { label: '状态', value: st },
          { label: '阈值', value: `${slopeThreshold} mm` }
        ]
      }
    }
    case 'person': {
      const p = people.value.find((x) => x.id === ref.key)
      if (!p) break
      return {
        kind: '作业人员',
        title: p.name,
        accent: p.online ? '#00ff9d' : '#7a8b99',
        rows: [
          { label: '工种', value: p.role },
          { label: '区域', value: p.area },
          { label: '定位终端', value: p.online ? '在线' : '离线' },
          { label: '终端编号', value: p.id }
        ]
      }
    }
    default:
      break
  }

  return {
    kind: '三维地物',
    title: name ?? ref.key,
    accent: '#5c7a99',
    rows: [{ label: '业务数据', value: `未绑定（${ref.kind}）` }]
  }
}

/**
 * 三维 → 面板。
 *
 * `entityId` 为空**不一定是点了空地**：倾斜摄影瓦片被点中时也没有 id。
 * 两种情况都按「清空选中态」处理，但浮层不弹——弹一个「未绑定」的卡片
 * 反而让人以为点错了地方。
 */
function onPick(hit: ScenePick) {
  if (!hit.entityId) return clearPick()

  const ref = parseEntityId(hit.entityId)
  if (!ref) {
    // 前缀认识不了：不是异常，但留个可查的痕迹（本项目白屏过一次的教训）
    console.info(`[monitor] 认不出的实体 id：${hit.entityId}`)
    return clearPick()
  }

  pickAt.value = hit.screen
  picked.value = describePick(ref, hit.entityName)
  linkedEntityId.value = hit.entityId

  // 反查业务键，让面板那边的对应项也亮起来
  linked.value = linkedNameOf(ref.kind, ref.key)
  setEntityHighlight(hit.entityId)
  flyToPicked(ref.kind, ref.key)
}

/** 业务键 → 面板上显示的名字（也是图表高亮与列表 .is-linked 的判据） */
function linkedNameOf(kind: TargetKind, key: string): string {
  if (kind === 'device') return devices.value.find((d) => d.id === key)?.name ?? ''
  if (kind === 'slope') return key
  if (kind === 'person') return people.value.find((p) => p.id === key)?.name ?? ''
  return ''
}

function clearPick() {
  picked.value = null
  linked.value = ''
  linkedEntityId.value = ''
  setEntityHighlight('')
}

// ---------------------------------------------------------------------------
// 面板 → 三维
// ---------------------------------------------------------------------------

function flyTo(wp: SceneWaypoint | null) {
  if (!wp) return
  sceneRef.value?.flyTo(wp)
}

/** 点设备效率条 → 飞到那台设备 */
function onDeviceClick(params: { dataIndex?: number } | undefined) {
  const d = params?.dataIndex == null ? undefined : sortedDevices.value[params.dataIndex]
  if (!d) return
  linked.value = d.name
  linkedEntityId.value = `twin-device-${d.id}`
  setEntityHighlight(linkedEntityId.value)
  // 图表点击没有「点击处的三维坐标」可依据，给浮层一个**固定**的落点：
  // 沿用上一次三维拾取留下的 pickAt 会让卡片出现在跟这次点击无关的位置上
  pickAt.value = { x: CENTER_LEFT + 24, y: 320 }
  picked.value = describePick({ kind: 'device', key: d.id }, d.name)
  flyTo(pitWaypoint('device', d.id, d.eastM, d.northM, d.name))
}

/** 点边坡条 → 飞到该监测站 */
function onSlopeClick(params: { dataIndex?: number } | undefined) {
  const list = [...slopeSites.value].reverse()
  const s = params?.dataIndex == null ? undefined : list[params.dataIndex]
  if (!s) return
  linked.value = s.id
  linkedEntityId.value = `slope-site-${s.id}`
  setEntityHighlight(linkedEntityId.value)
  pickAt.value = { x: CENTER_LEFT + 24, y: 560 }
  picked.value = describePick({ kind: 'slope', key: s.id }, `${s.id} ${s.name}`)
  flyTo(pitWaypoint('slope', s.id, s.eastM, s.northM, `${s.id} ${s.name}`))
}

/** 点人员行 → 飞到那个人 */
function focusPerson(p: PersonnelPosition) {
  linked.value = p.name
  linkedEntityId.value = `person-${p.id}`
  setEntityHighlight(linkedEntityId.value)
  pickAt.value = { x: CENTER_LEFT + 24, y: 320 }
  picked.value = describePick({ kind: 'person', key: p.id }, p.name)
  // 人员点位不是从采坑中心偏移算的，数据里直接给了经纬度
  flyTo({
    key: `person-${p.id}`,
    label: p.name,
    lon: p.lon,
    lat: p.lat,
    height: 1345,
    heading: 0,
    pitch: -35,
    range: 180
  })
}

/**
 * 点告警行 → 飞到现场。
 *
 * 告警的「位置」是中文地名，三维里并没有对应实体 —— 这类地方本来就没画东西。
 * 所以走 `AREA_ANCHORS` 这张地名表，飞过去之后**在三维上也不高亮**（没有可高亮的对象），
 * 只把浮层里的区域信息摆出来。查不到地名就明说，不硬飞。
 */
function focusAlert(h: HazardDisposal) {
  const anchor = areaAnchor(h.location)
  linked.value = h.location
  linkedEntityId.value = ''
  setEntityHighlight('')

  // 告警行在右列，浮层就落在靠右那半边，别横跨整个三维区。
  // ⚠️ 这一句必须在下面那个 `return` **之前**：查不到地名的告警同样要把卡片弹出来
  // （卡片上写着「无坐标」），放在 return 之后会出现「卡片显示上一次点过的位置」。
  pickAt.value = { x: CENTER_RIGHT - PICK_W - 24, y: 320 }
  picked.value = {
    kind: '隐患告警',
    title: h.type,
    accent: h.status === 'done' ? '#00ff9d' : '#ff9f1c',
    rows: [
      { label: '位置', value: h.location },
      { label: '状态', value: h.statusText },
      { label: '关联区域', value: anchor ? '已定位' : '无坐标' }
    ]
  }

  if (!anchor) {
    console.info(`[monitor] 地名「${h.location}」不在 AREA_ANCHORS 里，无法定位`)
    return
  }

  flyTo({
    key: `alert-${h.id}`,
    label: anchor.label,
    lon: anchor.lon,
    lat: anchor.lat,
    height: anchor.height,
    heading: 0,
    pitch: -35,
    range: 900
  })
}

/** 业务键反查坐标，与 `focusPerson` 分开是因为设备/边坡有 eastM/northM 而人员没有 */
function flyToPicked(kind: TargetKind, key: string) {
  if (kind === 'device') {
    const d = devices.value.find((x) => x.id === key)
    if (d) flyTo(pitWaypoint('device', d.id, d.eastM, d.northM, d.name))
    return
  }
  if (kind === 'slope') {
    const s = slopeSites.value.find((x) => x.id === key)
    if (s) flyTo(pitWaypoint('slope', s.id, s.eastM, s.northM, `${s.id} ${s.name}`))
    return
  }
  // 人员与倾斜摄影地物不主动改机位：点一下就把镜头拽走，在「看现场」的
  // 页面里是打扰而不是帮助。要定位到具体的人，用左列的人员行。
  if (kind === 'person') {
    const p = people.value.find((x) => x.id === key)
    if (!p) return
    linked.value = p.name
  }
}

// 数据晚于第一次渲染到达时，把指标卡与图表刷新一遍
// （computed 会自动跟，这里只需要保证 `linked` 的初值不会带出一个空名字）
watch(devices, () => {
  if (linked.value && !linkedNameOf('device', linked.value)) linked.value = ''
})
</script>

<style lang="scss" scoped>
// 指标卡行的高度。左右两列都从它的下沿开始排，所以这个值**必须是一个确定值**，
// 不能靠内容撑开——撑开的话两列的位置就跟着数据变了。
$metrics-h: 72px;

.monitor {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.monitor__main {
  position: relative;
  width: 100%;
  flex: 1;
  min-height: 0;
}

// 三维铺满整个 main，面板浮在它上面。
// ⚠️ 各面板容器是**绝对的叶子**，只吃自己那块矩形；
// 中间不许出现任何「铺满中央」的 wrapper（见 EmergencyView 的硬约束注释），
// 那种容器会把整条中央带的鼠标事件一次性吃掉，三维点不动、转不了，还不报错。
.monitor__map {
  position: absolute;
  inset: 0;
}

.monitor__metrics {
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

.monitor__side {
  position: absolute;
  top: $panel-gap + $metrics-h + $panel-gap;
  bottom: $panel-gap;
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

// ---------- 列表（人员 / 告警共用）----------
.monitor__list {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}

.monitor__row {
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

  &.is-offline {
    opacity: 0.5;
  }
}

.monitor__row-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: $green;
  box-shadow: 0 0 6px $green;

  &.is-off {
    background: $text-muted;
    box-shadow: none;
  }
}

.monitor__row-name {
  flex-shrink: 0;
  color: $text-primary;
}

.monitor__row-role {
  flex-shrink: 0;
  color: $text-secondary;
}

.monitor__row-area {
  flex: 1;
  min-width: 0;
  text-align: right;
  color: $text-muted;
  @include ellipsis;
}

// 面板角上的「联动中 · xxx」
.monitor__linked {
  color: $primary;
}

// ---------- 拾取浮层 ----------
.monitor__pick {
  position: absolute;
  width: 268px;
  z-index: $z-popup;
  background: rgba(6, 26, 46, 0.94);
  border: 1px solid rgba($primary, 0.5);
  box-shadow: 0 0 18px rgba(0, 0, 0, 0.5);
  @include corner-brackets(10px, 2px, $primary);
}

.monitor__pick-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid $border-soft;
  background: linear-gradient(180deg, rgba(0, 229, 255, 0.12) 0%, transparent 100%);
}

.monitor__pick-kind {
  flex-shrink: 0;
  padding: 1px 5px;
  font-size: $fs-small - 1px;
  color: $bg-deep;
  background: $primary;
  border-radius: 2px;
}

.monitor__pick-title {
  flex: 1;
  min-width: 0;
  font-size: $fs-small;
  font-weight: 600;
  color: $text-primary;
  @include ellipsis;
}

.monitor__pick-close {
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

.monitor__pick-body {
  padding: 8px 10px;
}

.monitor__pick-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  font-size: $fs-small - 1px;

  dt {
    flex-shrink: 0;
    width: 62px;
    color: $text-muted;
  }

  dd {
    flex: 1;
    min-width: 0;
    color: $text-body;
    @include ellipsis;
  }
}
</style>
