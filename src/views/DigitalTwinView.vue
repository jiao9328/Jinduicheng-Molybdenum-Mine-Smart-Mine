<template>
  <div class="twin">
    <!-- 全屏三维实景，不带暗角与网格叠加 -->
    <MapScene ref="sceneRef" class="twin__map" :build="buildScene" :home="PIT_HOME" plain />

    <!-- 顶部：返回首页 -->
    <button class="twin__back" type="button" @click="router.push('/')">
      <span class="twin__back-icon">‹</span>
      <span>返回</span>
    </button>

    <!-- 左上：场景信息 -->
    <div class="twin__title">
      <h1>数字孪生</h1>
      <p>DIGITAL TWIN · {{ activeLabel }}</p>
    </div>

    <!--
      底座说明 —— §8.2-1「地质模型自动更新」的如实交代。

      这条能力前端做不了：要后端地质建模服务持续反演、把新模型推到前端。
      没有就是不没有，**不做一个永远走到 80% 的假进度条**。
      写在这里而不是面板里，是因为它说的是「这块三维底座是什么」，
      跟哪块数据面板当前被选中无关——挂在某个 Tab 上，评审不切到那一页就看不见。
      pointer-events: none：它是说明文字，不该挡掉下面的三维交互。
    -->
    <p class="twin__base-note">
      三维底座：离线倾斜摄影 + 程序化场景　|　§8.2-1 地质模型自动更新：未接入（需后端地质建模服务）
    </p>

    <!-- 机位条：底部左侧。宽约 545px，右侧约 935px 全长留给三维 -->
    <nav class="twin__cams">
      <button
        v-for="wp in waypoints"
        :key="wp.key"
        class="twin__cam"
        :class="{ 'is-active': activeKey === wp.key }"
        type="button"
        :disabled="flying"
        @click="flyTo(wp)"
      >
        {{ wp.label }}
      </button>
    </nav>

    <!--
      数据条：右侧一列，与 Tab 条同宽同右边距，上下对齐成一条竖线。
      面板**靠右不居中**：默认机位 PIT_HOME 把采坑摆在画面正中，
      居中的面板区压掉的正好是整屏最贵的那块画面。

      bottom: 90px 是给下面的 Tab 条让位（Tab 条高 50 + 下边距 28 = 78，
      再留 12px 缝）。面板与 Tab 条**几何上本不相交**，z 差（$z-panel 10
      vs $z-popup 30）是留给将来的：哪天有人把面板调高到压住 Tab 条，
      靠 DOM 顺序决胜会静默盖掉页签，留个层级差至少语义是对的。
    -->
    <aside class="twin__panel">
      <!--
        三块面板用 v-if 而非 v-show：v-show 下面板留在 DOM 里但矩形全 0，
        check-panel-overflow 的三条判据会**全部平凡为真**，
        报告里会出现一排「body 0×0」的绿灯行——那正是补充件 3 §1.3 说的
        「检查空转」。v-if 下它们根本不在 DOM 里，诚实。
      -->
      <PanelBox
        v-if="tab === 'device'"
        title="设备定位与作业效率"
        subtitle="DEVICE POSITION & EFFICIENCY"
        height="100%"
      >
        <div class="twin__stack">
          <div class="twin__stats">
            <div class="twin__stat">
              <span class="twin__stat-num">{{ deviceStats.total }}</span>
              <span class="twin__stat-label">设备总数</span>
            </div>
            <div class="twin__stat">
              <span class="twin__stat-num is-green">{{ deviceStats.working }}</span>
              <span class="twin__stat-label">作业中</span>
            </div>
            <div class="twin__stat">
              <span class="twin__stat-num">{{ deviceStats.avg }}%</span>
              <span class="twin__stat-label">平均效率</span>
            </div>
          </div>

          <div class="twin__scroll">
            <table class="twin__table">
              <colgroup>
                <col style="width: 118px" />
                <col style="width: 96px" />
                <col style="width: 78px" />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th>设备</th>
                  <th>位置</th>
                  <th>状态</th>
                  <th class="is-num">效率</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in devices" :key="d.id">
                  <td class="twin__td-name">{{ d.name }}</td>
                  <td class="twin__td-muted">{{ d.area }}</td>
                  <td>
                    <span
                      class="twin__chip"
                      :style="{
                        color: TWIN_DEVICE_STATUS_COLORS[d.status],
                        borderColor: fadeColor(TWIN_DEVICE_STATUS_COLORS[d.status], 0.5)
                      }"
                    >
                      {{ d.status }}
                    </span>
                  </td>
                  <td class="is-num">{{ d.efficiency }}%</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="twin__bars">
            <div class="twin__bars-head">各类设备平均效率（检修中的不计入）</div>
            <div v-for="k in kindBars" :key="k.kind" class="twin__bar">
              <span class="twin__bar-label">{{ k.kind }}</span>
              <span class="twin__bar-track">
                <span class="twin__bar-fill" :style="{ width: `${k.pct}%` }" />
              </span>
              <span class="twin__bar-value">{{ k.pct }}%</span>
            </div>
          </div>
        </div>
      </PanelBox>

      <PanelBox
        v-else-if="tab === 'risk'"
        title="三类安全风险四色分布"
        subtitle="RISK DISTRIBUTION"
        height="100%"
      >
        <div class="twin__stack">
          <div class="twin__chart">
            <EchartBox :option="riskOption" height="100%" />
          </div>

          <div class="twin__scroll">
            <ul class="twin__zones">
              <li v-for="z in riskZones" :key="z.id" class="twin__zone">
                <span class="twin__dot" :style="{ background: riskColorOf(z.level) }" />
                <span class="twin__zone-name">{{ z.name }}</span>
                <span class="twin__zone-level" :style="{ color: riskColorOf(z.level) }">
                  {{ z.level }}
                </span>
                <span class="twin__zone-detail">{{ z.detail }}</span>
              </li>
            </ul>
          </div>
        </div>
      </PanelBox>

      <PanelBox
        v-else
        title="边坡位移监测与动态模拟"
        subtitle="SLOPE DISPLACEMENT"
        height="100%"
      >
        <div class="twin__stack">
          <div class="twin__chart">
            <EchartBox :option="slopeOption" height="100%" />
          </div>

          <div class="twin__scroll">
            <ul class="twin__slopes">
              <li v-for="s in slopeSites" :key="s.id" class="twin__slope">
                <span class="twin__dot" :style="{ background: slopeColorOf(s.displacement) }" />
                <span class="twin__slope-name">{{ s.id }} {{ s.name }}</span>
                <span class="twin__slope-mm" :style="{ color: slopeColorOf(s.displacement) }">
                  {{ s.displacement.toFixed(1) }}mm
                </span>
                <span class="twin__slope-rate">{{ s.rate.toFixed(1) }}mm/d</span>
              </li>
            </ul>
          </div>

          <!--
            模拟进度写到 DOM 的 data-progress 上，检查脚本据此断言
            「点下按钮后进度确实在推进」，不必去读组件内部状态。
          -->
          <div class="twin__sim" :data-progress="simProgress.toFixed(2)" :data-playing="simPlaying">
            <div class="twin__sim-track">
              <span class="twin__sim-fill" :style="{ width: `${simProgress * 100}%` }" />
            </div>
            <div class="twin__sim-ctrl">
              <button class="twin__sim-btn is-primary" type="button" @click="onToggleSim">
                {{ simPlaying ? '暂停' : '开始模拟' }}
              </button>
              <button class="twin__sim-btn" type="button" @click="onStepSim">单步</button>
              <button class="twin__sim-btn" type="button" @click="onResetSim">复位</button>
            </div>
          </div>

          <!--
            放大倍数必须写在数字旁边，不能只写在代码注释里：
            屏幕上滑了 5 米而实测位移是 26 毫米，不说明的话看图的人会误读。
          -->
          <p class="twin__note">
            三维点位按累计位移的 <b>×{{ TWIN_SLOPE_EXAGGERATION }}</b> 放大显示，
            数值为实测值；统一预警阈值 {{ TWIN_SLOPE_THRESHOLD }}mm。
          </p>
        </div>
      </PanelBox>
    </aside>

    <!-- Tab 条：底部右侧，宽度与上面的面板列相同，上下对齐成一条竖线 -->
    <nav class="twin__tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="twin__tab"
        :class="{ 'is-active': tab === t.key }"
        type="button"
        @click="selectTab(t.key)"
      >
        {{ t.label }}
      </button>
    </nav>

    <!-- 飞行中提示 -->
    <transition name="twin-fade">
      <div v-if="flying" class="twin__flying">镜头飞行中…</div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import type { EChartsOption } from 'echarts'
import type * as Cesium from 'cesium'
import MapScene from '@/components/MapScene.vue'
import PanelBox from '@/components/PanelBox.vue'
import EchartBox from '@/components/EchartBox.vue'
import {
  buildTwinDeviceLayer,
  buildTwinRiskLayer,
  buildTwinSlopeLayer,
  createSlopeAnimation,
  type TwinSlopeAnimation
} from '@/scene/layers/twinLayer'
import { SCENE_WAYPOINTS, type SceneWaypoint } from '@/scene/sceneConfig'
import { registerLayers, registerSim, unregisterLayers, unregisterSim } from '@/duner/scene'
import { AXIS_NAME_STYLE, CHART_COLORS, fadeColor } from '@/utils/chartTheme'
import { useAsyncData } from '@/hooks/useAsyncData'
import * as twinApi from '@/api/digitalTwin'
import {
  TWIN_DEVICE_STATUS_COLORS,
  TWIN_RISK_LEVELS,
  TWIN_SLOPE_EXAGGERATION,
  TWIN_SLOPE_STATUS_COLORS,
  TWIN_SLOPE_THRESHOLD,
  slopeStatus,
  type TwinDeviceKind,
  type TwinRiskCategory
} from '@/api/digitalTwin'

const router = useRouter()

/**
 * 本页默认机位：**露天采坑**，直接复用机位条里的 `pit`。
 *
 * ⚠️ 不要改回 `HOME_WAYPOINT`。它曾经是「采坑南侧俯瞰」，本页顺手复用了；
 * 2026-09 选矿厂搬进新山谷后，它的注视点改成了**新厂址谷底**（首页要的是全厂镜头），
 * 本页跟着被带走——而本页三块面板的数据（设备点位 / 三类风险区 / 边坡监测点）
 * **全部落在采坑里**，于是默认画面里一个数据点都没有。
 * 症状由 `check-twin-layers.mjs` 的「设备点位在画面上有像素」抓着：
 * 8 个点位**0 个在画面内**，画面静止得两张截图逐像素相同。
 *
 * 与 `EMERGENCY_HOME`、`SAFETY_HOME` 同一种做法：三维页的默认镜头归页面自己管，
 * 不复用别的页面的机位——复用的时候看不出问题，被复用方一改就会安静地错。
 *
 * 复用 `pit` 而不是另写一份数值：机位条的初始高亮与点「露天采坑」是同一个机位。
 * 找不到就抛，不写 `!`——理由同 `sceneConfig.ts` 的 `namedBuilding`。
 */
const PIT_HOME = SCENE_WAYPOINTS.find((w) => w.key === 'pit')
if (!PIT_HOME) throw new Error('DigitalTwinView：SCENE_WAYPOINTS 里没有 key 为 pit 的机位，默认机位无法定位')

const sceneRef = shallowRef<InstanceType<typeof MapScene> | null>(null)
const activeKey = ref(PIT_HOME.key)
const flying = ref(false)

/**
 * 底部 Tab：切面板的同时切三维图层。
 *
 * 「切哪个维度就看哪一层」而不是再给一套图层勾选框：底部已经有
 * 机位条 + Tab 条两条控件，再加一排复选框，屏幕上就只剩控件没有画面了。
 * 而且这样切 Tab 时三维会跟着变，讲的时候一个动作交代两件事。
 */
type TwinTabKey = 'device' | 'risk' | 'slope'

const TABS: { key: TwinTabKey; label: string }[] = [
  { key: 'device', label: '设备效率' },
  { key: 'risk', label: '风险分布' },
  { key: 'slope', label: '边坡监测' }
]

const tab = ref<TwinTabKey>('device')

// ---------- 数据 ----------
/**
 * 三组图层数据先发起请求，`useAsyncData` 复用同一个 Promise。
 *
 * 原因与应急救援页相同：业务图层只能在建场景那一次加进去（`build` 回调只跑一遍），
 * 晚到的数据补不进去。而 `useAsyncData` 不返回 Promise，拿不到「数据到了」的信号。
 */
const devicesPromise = twinApi.fetchTwinDevices()
const zonesPromise = twinApi.fetchTwinRiskZones()
const sitesPromise = twinApi.fetchTwinSlopeSites()

const { data: devices } = useAsyncData(() => devicesPromise, [])
const { data: riskZones } = useAsyncData(() => zonesPromise, [])
const { data: slopeSites } = useAsyncData(() => sitesPromise, [])
const { data: slopeTrend } = useAsyncData(twinApi.fetchTwinSlopeTrend, {
  months: [] as string[],
  series: [] as { name: string; data: number[] }[],
  unit: ''
})

// ---------- 机位 ----------
// MapScene 内部已经自建了 Viewer，这里不能再用 useCesium 建第二个，
// 所以飞行动作通过 MapScene 暴露的 flyTo 转发。
const waypoints = computed<SceneWaypoint[]>(() => SCENE_WAYPOINTS)

const activeLabel = computed(
  () => waypoints.value.find((w) => w.key === activeKey.value)?.label ?? '全矿区'
)

async function flyTo(wp: SceneWaypoint) {
  if (flying.value) return
  const scene = sceneRef.value
  if (!scene?.flyTo) return

  flying.value = true
  activeKey.value = wp.key
  try {
    await scene.flyTo(wp)
  } finally {
    flying.value = false
  }
}

// ---------- 三维场景 ----------
/** 已建好的实体分组，由 `buildScene` 填充。**刻意不是响应式**：见 emergencyLayer 同一处注释 */
let layerGroups: { key: TwinTabKey; entities: Cesium.Entity[] }[] = []
let slopeAnim: TwinSlopeAnimation | null = null

/**
 * 三组图层都要先从三维底座采样地面高程，所以是异步的。
 * 全部建完后立刻按当前 Tab 刷一次显隐，否则刚建出来的图层会全部可见。
 */
async function buildScene(viewer: Cesium.Viewer) {
  const [deviceList, zoneList, siteList] = await Promise.all([
    devicesPromise,
    zonesPromise,
    sitesPromise
  ])

  const [deviceEntities, riskEntities, slopeLayer] = await Promise.all([
    buildTwinDeviceLayer(viewer, deviceList),
    buildTwinRiskLayer(viewer, zoneList),
    buildTwinSlopeLayer(viewer, siteList)
  ])

  layerGroups = [
    { key: 'device', entities: deviceEntities },
    { key: 'risk', entities: riskEntities },
    { key: 'slope', entities: slopeLayer.entities }
  ]

  slopeAnim = createSlopeAnimation(viewer, slopeLayer, {
    onProgress: (t) => {
      simProgress.value = t
      // 演到头自己把按钮弹回「开始模拟」——动画是自停的，
      // 不让按钮停在「暂停」上骗人
      if (t >= 1) simPlaying.value = false
    }
  })
  slopeAnim.reset()

  applyLayerVisibility()
}

function applyLayerVisibility() {
  for (const g of layerGroups) {
    const on = g.key === tab.value
    for (const e of g.entities) e.show = on
  }
}

function selectTab(key: TwinTabKey) {
  if (tab.value === key) return

  // 离开边坡页时把模拟停下来：实体被隐藏后 rAF 仍在每帧改坐标，白跑 CPU；
  // 而且切回来进度停在原处，比「后台偷偷演完了」好讲
  if (tab.value === 'slope' && simPlaying.value) {
    slopeAnim?.pause()
    simPlaying.value = false
  }

  tab.value = key
  applyLayerVisibility()
}

onBeforeUnmount(() => {
  // 必须挂：rAF 不随组件卸载自动停，留着会一直持有 viewer 与实体
  slopeAnim?.dispose()
})

// ---------- 动态模拟控制 ----------
const simProgress = ref(0)
const simPlaying = ref(false)

function onToggleSim() {
  if (!slopeAnim) return
  if (simPlaying.value) {
    slopeAnim.pause()
    simPlaying.value = false
    return
  }
  simPlaying.value = true
  slopeAnim.play()
}

function onStepSim() {
  if (!slopeAnim) return
  slopeAnim.pause()
  simPlaying.value = false
  slopeAnim.step()
}

function onResetSim() {
  if (!slopeAnim) return
  slopeAnim.pause()
  simPlaying.value = false
  slopeAnim.reset()
}

// ---------- 设备面板 ----------
const deviceStats = computed(() => {
  const list = devices.value
  // 检修中的设备效率记 0，计进平均会把整体无端压低，所以平均效率只统计非检修设备
  const active = list.filter((d) => d.status !== '检修')
  const avg = active.length ? active.reduce((s, d) => s + d.efficiency, 0) / active.length : 0
  return {
    total: list.length,
    working: list.filter((d) => d.status === '作业中').length,
    avg: avg.toFixed(1)
  }
})

const kindBars = computed(() => {
  const kinds: TwinDeviceKind[] = ['钻机', '卡车', '铲车']
  return kinds.map((kind) => {
    const list = devices.value.filter((d) => d.kind === kind && d.status !== '检修')
    const pct = list.length ? list.reduce((s, d) => s + d.efficiency, 0) / list.length : 0
    return { kind, pct: Math.round(pct) }
  })
})

// ---------- 风险面板 ----------
const RISK_CATEGORIES: TwinRiskCategory[] = ['边坡', '爆破', '运输']

/** 四色分级色值查表（等级 → 颜色在 mock 里单点定义） */
function riskColorOf(level: string): string {
  return TWIN_RISK_LEVELS.find((l) => l.level === level)?.color ?? '#ffffff'
}

/**
 * 四色计数**由 riskZones 现算**，不存第二份。
 * 存一份汇总就多一个会说谎的地方：改了风险区忘了改计数，面板和三维就对不上，
 * 而两边单独看都正常。见 mock/digitalTwin.ts 顶部「能算的不要存」。
 */
const riskMatrix = computed(() =>
  RISK_CATEGORIES.map((c) =>
    TWIN_RISK_LEVELS.map(
      (l) => riskZones.value.filter((z) => z.category === c && z.level === l.level).length
    )
  )
)

/**
 * 三类风险的四色堆叠柱。
 *
 * 用竖向堆叠而不是横向条：`withTheme` 是按「x 轴＝类目、y 轴＝数值」这套
 * 默认轴样式下发的，横向条要反过来，主题会把类目轴的样式合并到数值轴上
 * （`axisLine.show` / `splitLine` 都对不上），得逐个属性覆盖回来。
 * 不值得为一个只在 400px 宽里出现的图去跟主题较劲。
 */
const riskOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  legend: { top: 0, right: 0, data: TWIN_RISK_LEVELS.map((l) => l.level) },
  grid: { top: 28, left: 4, right: 8, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: RISK_CATEGORIES },
  yAxis: { type: 'value', name: '处', nameTextStyle: AXIS_NAME_STYLE, minInterval: 1 },
  series: TWIN_RISK_LEVELS.map((l, li) => ({
    name: l.level,
    type: 'bar' as const,
    stack: 'risk',
    barWidth: 26,
    itemStyle: { color: l.color },
    data: riskMatrix.value.map((row) => row[li])
  }))
}))

// ---------- 边坡面板 ----------
function slopeColorOf(displacement: number): string {
  return TWIN_SLOPE_STATUS_COLORS[slopeStatus(displacement)]
}

/**
 * 累计位移趋势。
 *
 * 三条线的颜色**只做区分，不表示等级**：按状态色上色的话 SL-02 与 SL-04
 * 都是「预警」、两条线同一个橙色叠在一起，反而看不清谁是谁。
 * 等级由下面的监测站列表用状态色标出，图上用红色虚线把阈值摆出来，
 * 谁越过了阈值一眼就能看出来。
 */
const slopeOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, right: 0, data: slopeTrend.value.series.map((s) => s.name) },
  grid: { top: 28, left: 4, right: 10, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: slopeTrend.value.months, boundaryGap: false },
  yAxis: { type: 'value', name: slopeTrend.value.unit, nameTextStyle: AXIS_NAME_STYLE },
  series: slopeTrend.value.series.map((s, i) => ({
    name: s.name,
    type: 'line' as const,
    smooth: true,
    symbolSize: 4,
    lineStyle: { width: 2 },
    itemStyle: { color: CHART_COLORS[i] },
    data: s.data,
    // 阈值线只画在第一条上，否则三条线会叠成一团加粗的红虚线
    ...(i === 0
      ? {
          markLine: {
            silent: true,
            symbol: 'none',
            label: {
              formatter: `阈值 ${TWIN_SLOPE_THRESHOLD}mm`,
              fontSize: 10,
              color: '#ff4d4f',
              position: 'insideEndTop'
            },
            lineStyle: { color: '#ff4d4f', type: 'dashed' as const },
            data: [{ yAxis: TWIN_SLOPE_THRESHOLD }]
          }
        }
      : {})
  }))
}))

// ---------------------------------------------------------------------------
// 墩儿的图层 / 模拟登记（自然语言指挥层）
// ---------------------------------------------------------------------------

/**
 * 本页三组图层与底部 Tab 是**同一份状态**（`tab`），所以图层名的翻译
 * 只需一张表：图层名 ↔ Tab 键。
 */
const LAYER_TAB: Record<string, TwinTabKey> = {
  设备效率: 'device',
  风险分布: 'risk',
  边坡监测: 'slope'
}
const TAB_LABEL: Record<TwinTabKey, string> = {
  device: '设备效率',
  risk: '风险分布',
  slope: '边坡监测'
}

/**
 * 图层手柄的 id。注销时比对，理由与 `MapScene` 那处相同
 * （路由切换是「新的先挂载、旧的后卸载」，不比对会清掉新页面刚登记的句柄）。
 */
const handleId = `digital-twin-${getCurrentInstance()?.uid ?? 0}`

registerLayers({
  id: handleId,

  /**
   * ⚠️ 「关掉某一组」在这一页**做不到**，而这不是缺陷、是三选一的必然：
   * 三组图层互斥（`applyLayerVisibility` 只让当前 Tab 那组可见），
   * 关掉当前组等于让三维变成空的。
   *
   * 所以这里**如实说明并给出可执行的下一步**（「直接切到要看的那组」），
   * 而不是让 `tab` 停在一个没有可见图层的状态上 —— 用户会觉得三维坏了。
   */
  set(name, visible) {
    const key = LAYER_TAB[name]
    if (!key) return { ok: false, note: `数字孪生页没有「${name}」这个图层，这里只有设备效率 / 风险分布 / 边坡监测` }
    if (!visible) {
      if (tab.value !== key) return { ok: true, note: `${name}本来就是关的` }
      return { ok: false, note: `本页三组图层是三选一的，没法单独关掉当前这组；直接说要看哪一组就行` }
    }
    selectTab(key)
    return { ok: true, note: `已切到${name}` }
  },

  isolate(names) {
    const keys = names.map((n) => LAYER_TAB[n]).filter(Boolean)
    if (!keys.length) return { ok: false, note: `本页没有这些图层：${names.join('、')}` }
    if (keys.length > 1) {
      return { ok: false, note: '本页三组图层是三选一的，一次只能看一组' }
    }
    selectTab(keys[0])
    return { ok: true, note: `已只看${TAB_LABEL[keys[0]]}` }
  },

  list() {
    return TABS.map((t) => ({ name: t.label, visible: t.key === tab.value }))
  }
})

registerSim({
  id: handleId,
  /**
   * 启动边坡位移动态模拟。
   *
   * 先把 Tab 切到边坡：动画改的是边坡图层的坐标，在别的 Tab 上播放
   * 用户是看不到任何东西的 —— 一句「已启动」配一屏没动静的画面，
   * 比不执行还糟。
   *
   * `site` / `speed` 收下但**用不了**：本页的模拟是整层一起演示
   * （`createSlopeAnimation` 没有按监测点或速度分档的入口），
   * 所以不假装按参数播过，由桥接层在回话里说明。
   */
  startSim() {
    if (!slopeAnim) return { ok: false, note: '边坡动画还没建好（三维场景仍在加载），稍后再试' }
    if (tab.value !== 'slope') selectTab('slope')
    simPlaying.value = true
    slopeAnim.play()
    return { ok: true, note: '已在数字孪生页启动边坡位移动态模拟' }
  }
})

onBeforeUnmount(() => {
  unregisterLayers(handleId)
  unregisterSim(handleId)
})
</script>

<style lang="scss" scoped>
.twin {
  position: relative;
  width: 100%;
  height: 100%;
  background: $bg-deep;
  overflow: hidden;
}

.twin__map {
  position: absolute;
  inset: 0;
}

// ---------- 返回按钮 ----------
.twin__back {
  position: absolute;
  left: 24px;
  top: 24px;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 34px;
  padding: 0 16px 0 12px;
  font-family: $font-title;
  font-size: $fs-body;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(6, 28, 51, 0.62);
  border: 1px solid rgba(0, 229, 255, 0.4);
  border-radius: 17px;
  backdrop-filter: blur(8px);
  cursor: pointer;
  z-index: $z-popup;
  transition: background 0.2s;

  &:hover {
    background: rgba(0, 229, 255, 0.22);
  }
}

.twin__back-icon {
  font-size: 20px;
  line-height: 1;
  margin-top: -2px;
}

// ---------- 标题 ----------
.twin__title {
  position: absolute;
  left: 24px;
  top: 72px;
  z-index: $z-popup;
  pointer-events: none;

  h1 {
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 3px;
    color: #ffffff;
    text-shadow: 0 2px 12px rgba(0, 20, 40, 0.9);
  }

  p {
    margin-top: 2px;
    font-size: $fs-small;
    letter-spacing: 1px;
    color: rgba(255, 255, 255, 0.65);
    text-shadow: 0 2px 8px rgba(0, 20, 40, 0.9);
  }
}

// ---------- 底座说明（§8.2-1 的如实交代） ----------
.twin__base-note {
  position: absolute;
  left: 24px;
  bottom: 90px;
  z-index: $z-popup;
  font-size: 11px;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.5);
  text-shadow: 0 2px 8px rgba(0, 20, 40, 0.9);
  pointer-events: none;
}

// ---------- 底部两条控件共用的玻璃条外观 ----------
@mixin twin-bar {
  display: flex;
  gap: 8px;
  padding: 8px;
  background: rgba(6, 28, 51, 0.72);
  border: 1px solid rgba(0, 229, 255, 0.32);
  border-radius: 6px;
  backdrop-filter: blur(10px);
}

// 机位条：底部左侧。7 个机位在 padding 0 14px 下实测约 545px 宽，
// 右边界落在 x≈570，距面板列（x=1504）还有 900 多像素的三维画面。
.twin__cams {
  @include twin-bar;
  position: absolute;
  left: 24px;
  bottom: 28px;
  z-index: $z-popup;
}

.twin__cam {
  height: 34px;
  padding: 0 14px;
  font-family: $font-title;
  font-size: $fs-body;
  color: rgba(255, 255, 255, 0.82);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;

  &:hover:not(:disabled) {
    color: $primary;
    background: rgba(0, 229, 255, 0.14);
  }

  &.is-active {
    color: #001a2e;
    background: linear-gradient(180deg, #7ff0ff 0%, $primary 100%);
    border-color: $primary;
    font-weight: 600;
    box-shadow: 0 0 14px rgba(0, 229, 255, 0.6);
  }

  &:disabled {
    cursor: default;
    opacity: 0.7;
  }
}

// ---------- 数据条（右栏） ----------
.twin__panel {
  position: absolute;
  right: 16px;
  bottom: 90px;
  width: $panel-width;
  // 三块面板共用这一个高度：切 Tab 时面板大小不变，画面不跳
  height: 600px;
  z-index: $z-panel;
}

// Tab 条：底部右侧，与面板列同宽同右边距 ⇒ 上下对齐成一条竖线
.twin__tabs {
  @include twin-bar;
  position: absolute;
  right: 16px;
  bottom: 28px;
  width: $panel-width;
  z-index: $z-popup;
}

.twin__tab {
  flex: 1;
  height: 34px;
  font-family: $font-title;
  font-size: $fs-body;
  color: rgba(255, 255, 255, 0.82);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    color: $primary;
    background: rgba(0, 229, 255, 0.14);
  }

  &.is-active {
    color: #001a2e;
    background: linear-gradient(180deg, #7ff0ff 0%, $primary 100%);
    border-color: $primary;
    font-weight: 600;
    box-shadow: 0 0 14px rgba(0, 229, 255, 0.6);
  }
}

// ---------- 面板内布局 ----------
// 一块面板里要竖着放图表 + 列表 + 控件，所以自己起一列 flex。
// PanelBox 的 body 是 flex:1 + overflow:hidden，这里必须显式 height:100%，
// 否则下面的百分比高度没有参照，列表会把控件挤出面板。
.twin__stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
}

.twin__chart {
  flex: 0 0 38%;
  min-height: 0;
}

// 需要滚动的区域一律自己滚，不撑破面板
.twin__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  @include thin-scrollbar;
}

// ---------- 设备面板 ----------
.twin__stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  flex-shrink: 0;
}

.twin__stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 0;
  background: $bg-panel-soft;
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
}

.twin__stat-num {
  @include numeric;
  font-size: 22px;
  font-weight: 700;
  color: $primary;

  &.is-green {
    color: $green;
  }
}

.twin__stat-label {
  font-size: 11px;
  color: $text-muted;
}

.twin__table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: $fs-small;

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    height: 28px;
    padding: 0 6px;
    font-weight: 400;
    text-align: left;
    color: $text-muted;
    background: $bg-panel-solid;
    border-bottom: 1px solid $border-soft;
  }

  td {
    height: 34px;
    padding: 0 6px;
    color: $text-body;
    border-bottom: 1px solid rgba(0, 229, 255, 0.07);
    @include ellipsis;
  }

  .is-num {
    text-align: right;
    @include numeric;
  }
}

.twin__td-name {
  color: $text-primary;
}

.twin__td-muted {
  color: $text-secondary;
}

.twin__chip {
  display: inline-block;
  padding: 0 6px;
  font-size: 11px;
  line-height: 17px;
  border: 1px solid;
  border-radius: $radius-sm;
}

.twin__bars {
  flex-shrink: 0;
  padding-top: 8px;
  border-top: 1px solid $border-soft;
}

.twin__bars-head {
  margin-bottom: 6px;
  font-size: 11px;
  color: $text-muted;
}

.twin__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 20px;
}

.twin__bar-label {
  width: 32px;
  font-size: $fs-small;
  color: $text-secondary;
}

.twin__bar-track {
  flex: 1;
  height: 6px;
  background: rgba(0, 229, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
}

.twin__bar-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, $primary-dim 0%, $primary 100%);
  border-radius: 3px;
}

.twin__bar-value {
  width: 36px;
  text-align: right;
  font-size: $fs-small;
  color: $text-body;
  @include numeric;
}

// ---------- 风险面板 ----------
.twin__zones {
  display: flex;
  flex-direction: column;
}

.twin__zone {
  display: grid;
  grid-template-columns: 8px auto auto 1fr;
  align-items: baseline;
  gap: 6px;
  padding: 7px 0;
  border-bottom: 1px solid rgba(0, 229, 255, 0.07);
}

.twin__zone-name {
  font-size: $fs-small;
  color: $text-primary;
}

.twin__zone-level {
  font-size: 11px;
}

.twin__zone-detail {
  font-size: 11px;
  color: $text-muted;
  line-height: 1.4;
}

.twin__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

// ---------- 边坡面板 ----------
.twin__slopes {
  display: flex;
  flex-direction: column;
}

.twin__slope {
  display: grid;
  grid-template-columns: 8px 1fr auto auto;
  align-items: center;
  gap: 8px;
  height: 40px;
  border-bottom: 1px solid rgba(0, 229, 255, 0.07);
}

.twin__slope-name {
  font-size: $fs-small;
  color: $text-primary;
  @include ellipsis;
}

.twin__slope-mm {
  font-size: $fs-small;
  font-weight: 600;
  @include numeric;
}

.twin__slope-rate {
  width: 62px;
  text-align: right;
  font-size: 11px;
  color: $text-muted;
  @include numeric;
}

.twin__sim {
  flex-shrink: 0;
}

.twin__sim-track {
  height: 5px;
  background: rgba(0, 229, 255, 0.12);
  border-radius: 3px;
  overflow: hidden;
}

.twin__sim-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, $primary-dim 0%, $primary 100%);
  border-radius: 3px;
}

.twin__sim-ctrl {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.twin__sim-btn {
  flex: 1;
  height: 28px;
  font-size: $fs-small;
  color: $text-secondary;
  background: $bg-panel-soft;
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: color 0.2s, border-color 0.2s, background 0.2s;

  &:hover {
    color: $primary;
    border-color: $border-panel;
  }

  &.is-primary {
    color: $primary;
    border-color: $border-panel;
    background: rgba(0, 229, 255, 0.12);
  }
}

.twin__note {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1.5;
  color: $text-muted;

  b {
    color: $yellow;
    @include numeric;
  }
}

// ---------- 飞行提示 ----------
.twin__flying {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 8px 20px;
  font-size: $fs-body;
  color: $primary;
  letter-spacing: 2px;
  background: rgba(4, 20, 38, 0.7);
  border: 1px solid $border-panel;
  border-radius: 4px;
  backdrop-filter: blur(6px);
  pointer-events: none;
  z-index: $z-popup;
}

.twin-fade-enter-active,
.twin-fade-leave-active {
  transition: opacity 0.25s;
}
.twin-fade-enter-from,
.twin-fade-leave-to {
  opacity: 0;
}
</style>
