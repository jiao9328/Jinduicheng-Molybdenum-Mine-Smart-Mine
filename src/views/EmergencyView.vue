<template>
  <div class="emergency">
    <AppHeader :show-nav="false" title="应急救援指挥" />

    <main class="emergency__main">
      <!-- 左侧工具栏 -->
      <nav class="emergency__tools">
        <button
          v-for="t in emergencyTools"
          :key="t.key"
          class="emergency__tool"
          :class="{ 'is-active': isToolActive(t.key) }"
          type="button"
          @click="onToolClick(t.key)"
        >
          <span class="emergency__tool-icon">{{ t.icon }}</span>
          <span class="emergency__tool-label">{{ t.label }}</span>
        </button>
      </nav>

      <!-- 图层开关：撤离路线由数据决定有几条，人员/基站/轨迹是固定三组 -->
      <PanelBox v-if="panelOpen" class="emergency__layers" title="图层数据" subtitle="LAYERS">
        <label v-for="l in layerItems" :key="l.key" class="emergency__layer-item">
          <input
            :checked="layerVisible[l.key] !== false"
            type="checkbox"
            @change="toggleLayer(l.key)"
          />
          <span class="emergency__layer-dot" :style="{ background: l.color }" />
          <span class="emergency__layer-name">{{ l.label }}</span>
        </label>
      </PanelBox>

      <!-- 中央三维场景 -->
      <div class="emergency__map">
        <MapScene ref="mapRef" :build="buildScene" :home="EMERGENCY_HOME" />
      </div>

      <!-- 右侧数据面板 -->
      <aside class="emergency__side">
        <PanelBox class="emergency__donut" title="事故类型占比" subtitle="ACCIDENT TYPE RATIO">
          <!--
            点击环形图的扇区 ⇒ 匹配该类型的应急预案并弹指引。
            这是本页的第二条进预案弹窗的入口：中央「应急预案匹配」的 chip 是主入口，
            环形图是顺手的那个——看到哪类事故占比高，点一下就能看处置步骤。
            `clickable` 是 EchartBox 的现成 prop（内部就是 chart.on('click')）。
          -->
          <EchartBox :option="accidentOption" height="100%" clickable @click="onAccidentClick" />
        </PanelBox>

        <PanelBox title="区域隐患统计" subtitle="AREA HAZARD STATISTICS">
          <EchartBox :option="areaOption" height="100%" />
        </PanelBox>

        <!-- §7.2-4 多源画面：视频监控 + 无人机。纯占位，无真实流（见 mock 里的说明） -->
        <PanelBox title="多源画面" subtitle="MULTI-SOURCE VIEW">
          <div class="emergency__video">
            <div v-for="v in videoSources" :key="v.key" class="emergency__video-cell">
              <div class="emergency__video-frame">
                <span class="emergency__video-tip">信号接入中</span>
              </div>
              <div class="emergency__video-meta">
                <span class="emergency__video-name">{{ v.name }}</span>
                <span class="emergency__video-kind">{{ v.kind }}</span>
              </div>
            </div>
          </div>
        </PanelBox>

        <PanelBox title="隐患处置列表" subtitle="HAZARDS DISPOSAL LIST" class="emergency__panel--grow">
          <ul class="emergency__hazards">
            <li v-for="h in hazardDisposals" :key="h.id" class="emergency__hazard">
              <div class="emergency__hazard-main">
                <span class="emergency__hazard-type">{{ h.type }}</span>
                <span class="emergency__hazard-loc">{{ h.location }}</span>
              </div>
              <StatusTag :status="h.status" :text="h.statusText" />
              <!-- 页面上唯一的写操作。曾经带 v-permission.disable，
                   登录 + 权限体系移除后它就是普通按钮。 -->
              <button
                v-if="HAZARD_NEXT[h.status]"
                class="emergency__hazard-act"
                type="button"
                @click="onHandleHazard(h)"
              >
                {{ hazardActionLabel(h.status) }}
              </button>
            </li>
          </ul>
        </PanelBox>
      </aside>

      <!--
        中央三块横带：预案匹配 / 一键指令 / 最优调配（docx §7.2-1/-5/-3）。

        几何：left 66、right 412 ⇒ x 66→1508，右边界与下方 `.emergency__bottom` 对齐；
        bottom 212、height 300 ⇒ y 568→868（`.emergency__main` 的底边是 1080，
        `.emergency__bottom` 占 y 884→1064，故 868 到 884 正好留 16px 缝）。
        上方离图层开关面板（底边≈306）还有 260px 余量。

        ⚠️ **不要给这一带加任何「铺满中央」的 wrapper。** 三块都是绝对的叶子，
        只吃自己那块矩形；套一层铺满中央的容器，整条中央带的鼠标事件会被一次性吃掉，
        三维场景就再也点不动、转不了了——而且不报任何错。
      -->
      <div class="emergency__center">
        <PanelBox title="应急预案匹配" subtitle="EMERGENCY PLAN MATCHING">
          <div class="emergency__plans">
            <div class="emergency__chips">
              <button
                v-for="p in emergencyPlans"
                :key="p.key"
                class="emergency__chip"
                :class="{ 'is-active': activePlan?.key === p.key }"
                type="button"
                @click="activePlan = p"
              >
                {{ p.type }}
              </button>
            </div>

            <div v-if="activePlan" class="emergency__match">
              <div class="emergency__match-name">{{ activePlan.name }}</div>
              <div class="emergency__match-meta">
                <span class="emergency__match-level">{{ activePlan.level }}响应</span>
                <span>{{ activePlan.steps.length }} 步操作指引</span>
              </div>
            </div>
            <p v-else class="emergency__empty">选择灾害类型，自动匹配对应预案</p>

            <button
              class="emergency__btn"
              type="button"
              :disabled="!activePlan"
              @click="planOpen = true"
            >
              查看操作指引
            </button>
          </div>
        </PanelBox>

        <PanelBox title="一键指令下发" subtitle="ONE-CLICK COMMAND">
          <!--
            进度写进 DOM 的 data-* 上（容器 data-state，每条通道 data-acked/data-total），
            检查脚本据此断言「分批送达」而不是去读组件内部状态。
            分批 + 错峰（第 i 条从第 i*2 批才开始动）是这一段的关键：
            一键下发若瞬间全变 100%，大屏上只是一次闪烁，评审看不到「指令正在逐条送达」。
          -->
          <div class="emergency__cmd" :data-state="commandState">
            <ul class="emergency__channels">
              <li
                v-for="(c, i) in commandChannels"
                :key="c.key"
                class="emergency__channel"
                :data-acked="ackedOf(i)"
                :data-total="c.total"
              >
                <div class="emergency__channel-head">
                  <span class="emergency__channel-name">{{ c.name }}</span>
                  <span class="emergency__channel-num">{{ ackedOf(i) }} / {{ c.total }}</span>
                </div>
                <div class="emergency__bar">
                  <span
                    class="emergency__bar-fill"
                    :style="{
                      width: `${(ackedOf(i) / c.total) * 100}%`,
                      background: c.color
                    }"
                  />
                </div>
              </li>
            </ul>

            <button
              class="emergency__btn"
              type="button"
              :disabled="commandState === 'running'"
              @click="startCommand"
            >
              {{ commandState === 'running' ? '指令下发中…' : '一键下发' }}
            </button>
          </div>
        </PanelBox>

        <PanelBox title="最优调配方案" subtitle="OPTIMAL DISPATCH">
          <table class="emergency__dispatch">
            <thead>
              <tr>
                <th>队伍 / 物资</th>
                <th>来源</th>
                <th>目的地</th>
                <th>到场</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in dispatchSorted" :key="d.id" class="emergency__dispatch-row">
                <td>
                  <span class="emergency__dispatch-name">{{ d.name }}</span>
                  <span class="emergency__dispatch-kind">{{ d.kind }}</span>
                </td>
                <td>{{ d.from }}</td>
                <td>{{ d.to }}</td>
                <td class="emergency__dispatch-eta">{{ d.eta }} min</td>
              </tr>
            </tbody>
          </table>
        </PanelBox>
      </div>

      <!--
        预案操作指引浮层。
        ⚠️ 挂在 `.emergency__main` 而不是页面根 `.emergency`：
        页面根是 flex column，含 84px 的 AppHeader，浮层的包含块会变成 1080 高、
        把标题栏一起盖住。`.emergency__main` 是 position:relative、无内边距、
        正好 996 高的内容区。详见 AppModal.vue 头部注释。
      -->
      <AppModal
        v-model="planOpen"
        :title="activePlan?.name ?? '应急预案'"
        subtitle="OPERATION GUIDE"
        :width="880"
        :height="560"
      >
        <ol v-if="activePlan" class="emergency__guide">
          <li v-for="(s, i) in activePlan.steps" :key="i" class="emergency__guide-step">
            <span class="emergency__guide-no">{{ i + 1 }}</span>
            <span class="emergency__guide-text">{{ s }}</span>
          </li>
        </ol>

        <template #footer>
          <div class="emergency__guide-foot">
            <span class="emergency__guide-note">
              {{ activePlan?.type }}　响应级别 {{ activePlan?.level }}　共
              {{ activePlan?.steps.length ?? 0 }} 步
            </span>
            <button class="emergency__btn" type="button" @click="planOpen = false">关闭</button>
          </div>
        </template>
      </AppModal>

      <!-- 左下：月度事故趋势 + 救援资源 -->
      <div class="emergency__bottom">
        <PanelBox title="月度事故趋势" subtitle="MONTHLY ACCIDENT TRENDS">
          <EchartBox :option="trendOption" height="100%" />
        </PanelBox>

        <PanelBox title="救援资源" subtitle="RESCUE RESOURCES">
          <div class="emergency__rescue">
            <div class="emergency__rescue-col">
              <div class="emergency__rescue-head">救援队伍</div>
              <ul>
                <li v-for="t in rescueResources.teams" :key="t.name" class="emergency__rescue-row">
                  <span class="emergency__rescue-name">{{ t.name }}</span>
                  <span class="emergency__rescue-meta">{{ t.members }} 人</span>
                  <StatusTag
                    :status="t.status === '待命' ? 'info' : 'doing'"
                    :text="t.status"
                  />
                </li>
              </ul>
            </div>

            <div class="emergency__rescue-col">
              <div class="emergency__rescue-head">应急物资</div>
              <ul>
                <li v-for="s in rescueResources.supplies" :key="s.name" class="emergency__rescue-row">
                  <span class="emergency__rescue-name">{{ s.name }}</span>
                  <span class="emergency__rescue-meta">{{ s.count }} {{ s.unit }}</span>
                </li>
              </ul>
            </div>
          </div>
        </PanelBox>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { EChartsOption } from 'echarts'
import * as Cesium from 'cesium'
import AppHeader from '@/components/AppHeader.vue'
import AppModal from '@/components/AppModal.vue'
import PanelBox from '@/components/PanelBox.vue'
import EchartBox from '@/components/EchartBox.vue'
import MapScene from '@/components/MapScene.vue'
import StatusTag from '@/components/StatusTag.vue'
import {
  buildBaseStationLayer,
  buildBenchFramework,
  buildDisasterRoutes,
  buildPersonnelLayer,
  buildTrackLayer
} from '@/scene/layers/emergencyLayer'
import { sampleGroundHeights } from '@/scene/localTerrain'
import { MINE_ELEVATION, type SceneWaypoint } from '@/scene/sceneConfig'
import { areaGradient, barGradient, CHART_COLORS, fadeColor, TEXT_MUTED_COLOR } from '@/utils/chartTheme'
import { useAsyncData } from '@/hooks/useAsyncData'
import * as emergencyApi from '@/api/emergency'
import type {
  BaseStation,
  CommandChannel,
  DisasterRoute,
  DispatchPlan,
  EmergencyPlan,
  HazardDisposal,
  HazardStatus,
  PersonnelPosition,
  PersonnelTrack,
  VideoSource
} from '@/api/emergency'
import { COMMAND_BATCHES } from '@/api/emergency'

/**
 * 左侧工具栏按钮。
 *
 * 这几个是纯界面结构（按钮的外观与排布），不是业务数据，所以留在页面里，
 * 不走 `src/api/` —— 后端不会来决定工具栏画几个按钮。
 *
 * 关于按钮名：参考图「4.应急救援.jpg」里这一列只有 1080×494 像素，
 * 五个按钮的文字高度不足 6 个像素，多次识图给出的结果互相矛盾
 *（人员/矿区/动态/隐患/轨迹、人员/标识/联动/图层/轨迹…），
 * 无法确认原文案，故保留现有命名。行为按「露天矿应急指挥」的常见语义实现。
 */
const emergencyTools = [
  { key: 'personnel', label: '人员', icon: '人' },
  { key: 'locate', label: '定位', icon: '位' },
  { key: 'station', label: '基站', icon: '站' },
  { key: 'layer', label: '图层', icon: '层' },
  { key: 'track', label: '轨迹', icon: '轨' }
]

/**
 * 应急页机位：偏高的俯视，便于看清整个采场与撤离路线网络。
 * height 是注视点海拔，取自 DEM 实测（矿区地面约 1300m）。
 */
const EMERGENCY_HOME: SceneWaypoint = {
  key: 'emergency',
  label: '应急指挥',
  lon: 109.9560,
  lat: 34.3310,
  height: 1320,
  heading: 15,
  pitch: -50,
  range: 2200
}

/**
 * 场景图层的数据先发起请求，`useAsyncData` 复用同一个 Promise。
 *
 * 原因：业务图层只能在建场景那一次加进去（`build` 回调只跑一遍），
 * 晚到的数据补不进去。而 `useAsyncData` 不返回 Promise，拿不到「数据到了」的信号。
 * 这里把请求本身提出来，两边共用——不会重复请求，也不会漏建图层。
 */
const routesPromise = emergencyApi.fetchDisasterRoutes()
const peoplePromise = emergencyApi.fetchPersonnelPositions()
const stationsPromise = emergencyApi.fetchBaseStations()
const tracksPromise = emergencyApi.fetchPersonnelTracks()

const { data: disasterRoutes } = useAsyncData(() => routesPromise, [] as DisasterRoute[])
const { data: personnelPositions } = useAsyncData(() => peoplePromise, [] as PersonnelPosition[])
const { data: baseStations } = useAsyncData(() => stationsPromise, [] as BaseStation[])
const { data: personnelTracks } = useAsyncData(() => tracksPromise, [] as PersonnelTrack[])

// ---------- 面板数据 ----------
const { data: accidentTypes } = useAsyncData(
  emergencyApi.fetchAccidentTypes,
  [] as { name: string; value: number; color: string }[]
)
const { data: areaHazards } = useAsyncData(emergencyApi.fetchAreaHazards, {
  areas: [] as string[],
  values: [] as number[]
})
const { data: hazardDisposals } = useAsyncData(
  emergencyApi.fetchHazardDisposals,
  [] as HazardDisposal[]
)
const { data: monthlyAccidents } = useAsyncData(emergencyApi.fetchMonthlyAccidents, {
  months: [] as string[],
  values: [] as number[]
})
const { data: rescueResources } = useAsyncData(emergencyApi.fetchRescueResources, {
  teams: [] as { name: string; members: number; status: string }[],
  supplies: [] as { name: string; count: number; unit: string }[]
})

// ---------- 隐患处置（页面上唯一的写操作） ----------
/**
 * 状态推进规则：未处理 → 处置中 → 已处置。
 * 已处置是终态，模板据此不渲染按钮（用 `null` 表达，而不是靠文案判断）。
 */
const HAZARD_NEXT: Record<HazardStatus, { status: HazardStatus; text: string } | null> = {
  todo: { status: 'doing', text: '处置中' },
  doing: { status: 'done', text: '已处置' },
  done: null
}

/** 按钮文案：动词跟着当前状态走，「处置中」的下一步是「完成处置」 */
function hazardActionLabel(status: HazardStatus): string {
  return status === 'doing' ? '完成处置' : '处置'
}

async function onHandleHazard(hazard: HazardDisposal) {
  const next = HAZARD_NEXT[hazard.status]
  if (!next) return

  const previous = hazardDisposals.value
  // 乐观更新：先改本地，按钮点下去立刻有反馈。
  // data 是 shallowRef，必须整体替换数组——改元素属性不会触发渲染。
  hazardDisposals.value = previous.map((item) =>
    item.id === hazard.id ? { ...item, status: next.status, statusText: next.text } : item
  )

  try {
    // 后端未就绪时这个调用返回 false（不发请求、不落库），本地状态即最终状态；
    // 真实接口上线后同一行代码就变成真正的写操作，页面无需改动
    await emergencyApi.updateHazardStatus(hazard.id, next.status)
  } catch (err) {
    // 只有「参数错误」这类不可降级的失败才会抛到这里：回滚乐观更新
    hazardDisposals.value = previous
    console.error('[emergency] 隐患处置失败，已回滚：', err)
  }
}

// ---------- §7.2-1 应急预案匹配 ----------
const { data: emergencyPlans } = useAsyncData(
  emergencyApi.fetchEmergencyPlans,
  [] as EmergencyPlan[]
)
const { data: videoSources } = useAsyncData(emergencyApi.fetchVideoSources, [] as VideoSource[])
const { data: dispatchPlans } = useAsyncData(
  emergencyApi.fetchDispatchPlans,
  [] as DispatchPlan[]
)

/** 当前选中的预案。为空时「查看操作指引」是禁用态 */
const activePlan = ref<EmergencyPlan | null>(null)
const planOpen = ref(false)

/**
 * 点环形图扇区 ⇒ 匹配该类型预案并弹出操作指引。
 *
 * 按**名称**匹配 —— 环形图的类型名与预案的 `type` 是同一套词（mock 里有说明，
 * 两处名字对不上的类型就是「点了没反应」且不报任何错）。
 * 匹配不上就什么都不做，**不猜一个「最接近的」**：那会把「点了没反应」
 * 变成「点了弹出错误预案」，后者在演示里更难被发现。
 */
function onAccidentClick(params: { name?: string } | undefined) {
  const hit = emergencyPlans.value.find((p) => p.type === params?.name)
  if (!hit) return
  activePlan.value = hit
  planOpen.value = true
}

// ---------- §7.2-5 一键指令下发 ----------
const { data: commandChannels } = useAsyncData(
  emergencyApi.fetchCommandChannels,
  [] as CommandChannel[]
)

type CommandState = 'idle' | 'running' | 'done'
const commandState = ref<CommandState>('idle')

/**
 * 每条通道**已送达**的终端数，与 `commandChannels` 同序。
 * `shallowRef` + 整体替换（项目规范）：改元素不会触发渲染，
 * 所以下面一律 `commandAcked.value = next`，不写 `commandAcked.value[i] = x`。
 */
const commandAcked = shallowRef<number[]>([])

/** 第 i 条通道的已送达数。数据未到 / 尚未开始都按 0 —— 模板与检查脚本都读它 */
const ackedOf = (i: number): number => commandAcked.value[i] ?? 0

/** 每批之间的间隔。8 批 × 320ms ≈ 2.6s，是「看得出来在推进」又不至于让人等 */
const COMMAND_TICK = 320

/**
 * 第 i 条通道从第 i*2 批才开始动（错峰）。
 *
 * **没有这个错峰，三条通道会同时开始、同时走完**，大屏上看起来就是
 * 「三条一起涨」——「一键下发、逐条送达」这件事就完全看不出来了。
 * 错峰后总时长约 3.8s，且任意时刻各通道进度都不同。
 */
const startBatchOf = (i: number): number => i * 2

let commandTimer: ReturnType<typeof setInterval> | null = null
let commandBatch = 0

function stopCommand() {
  if (commandTimer === null) return
  clearInterval(commandTimer)
  commandTimer = null
}

/**
 * 一键下发：分 8 批把指令推给三条通道的全部终端。
 *
 * 为什么是分批而不是「一次到位」：一次到位在大屏上只是闪一下，
 * 评审看不到「指令正在一条条送达」，§7.2-5 想要的那件事就没演出来。
 *
 * 收尾**自停**：不到 100% 就停表，页面会在后台每 320ms 空跑一次，
 * 演示环境一挂一下午，这种定时器忘了停的事故很常见。
 */
function startCommand() {
  if (commandState.value === 'running') return
  const channels = commandChannels.value
  if (!channels.length) return

  commandBatch = 0
  commandAcked.value = channels.map(() => 0)
  commandState.value = 'running'

  commandTimer = setInterval(() => {
    commandBatch += 1

    const next = channels.map((c, i) => {
      const done = commandBatch - startBatchOf(i)
      if (done <= 0) return 0
      // 向上取整：最后一批必须正好落在 total 上，
      // 用 floor 的话总分不完（差一两个人永远到不了 100%）
      const settled = Math.ceil((Math.min(done, COMMAND_BATCHES) / COMMAND_BATCHES) * c.total)
      return Math.min(c.total, settled)
    })
    commandAcked.value = next

    if (next.every((n, i) => n >= channels[i].total)) {
      commandState.value = 'done'
      stopCommand()
    }
  }, COMMAND_TICK)
}

// 组件卸载（切页、热更新）时必须停表，否则定时器会继续去改一个已销毁组件的状态
onBeforeUnmount(stopCommand)

/**
 * 最优调配方案：按**预计到场时间**升序。
 *
 * 「最优」在这里就是这个排序 —— docx 要求「自动计算最优调配方案」，
 * 但没定义「匹配度」怎么算，所以数据里也没有这个字段（mock 里有说明）。
 * 排序在组件里现做，不在数据里存一份排好的顺序：那种「已经排好的顺序」
 * 一旦和 eta 对不上，没有任何办法发现。
 */
const dispatchSorted = computed(() =>
  [...dispatchPlans.value].sort((a, b) => a.eta - b.eta || a.id.localeCompare(b.id))
)

// ---------- 图层显隐 ----------
/**
 * 图层开关表。键与三维实体的分组键一一对应。
 *
 * 撤离路线的键由数据决定（接口返回几条就是几条），所以先只放固定三组，
 * 路线那几条等数据到位后由下面的 watch 补进来。
 */
const layerVisible = ref<Record<string, boolean>>({
  personnel: true,
  stations: true,
  tracks: true
})

/** 已建好的实体分组，由 `buildScene` 填充 */
let layerGroups: { key: string; entities: Cesium.Entity[] }[] = []
const mapRef = shallowRef<InstanceType<typeof MapScene> | null>(null)
const panelOpen = ref(true)

/** 图层面板的条目：撤离路线（取自数据）+ 人员/基站/轨迹（固定） */
const layerItems = computed(() => [
  ...disasterRoutes.value.map((r) => ({ key: r.key, label: r.label, color: r.color })),
  { key: 'personnel', label: '作业人员定位', color: '#00ff9d' },
  { key: 'stations', label: '定位基站', color: '#b388ff' },
  { key: 'tracks', label: '人员当日轨迹', color: '#ffd60a' }
])

// 路线数据到位后把它们的键并进开关表，并按开关状态刷一次显隐
watch(
  disasterRoutes,
  (routes) => {
    const next = { ...layerVisible.value }
    for (const r of routes) if (!(r.key in next)) next[r.key] = r.visible
    layerVisible.value = next
    applyLayerVisibility()
  },
  { immediate: true }
)

function applyLayerVisibility() {
  for (const g of layerGroups) {
    const on = layerVisible.value[g.key] !== false
    for (const e of g.entities) e.show = on
  }
}

function toggleLayer(key: string) {
  layerVisible.value = { ...layerVisible.value, [key]: layerVisible.value[key] === false }
  applyLayerVisibility()
}

/**
 * 工具栏按钮的按下态。
 *
 * 「图层」按钮跟的是面板开合，「定位」跟的是相机是否已聚焦，
 * 其余三个直接跟图层开关——按钮状态和它实际控制的东西是同一份状态，
 * 不会出现「按钮亮着但图层没显示」这种对不上的情况。
 */
function isToolActive(key: string): boolean {
  if (key === 'layer') return panelOpen.value
  if (key === 'locate') return focused.value
  return layerVisible.value[layerKeyOf(key)] !== false
}

/** 工具栏 key → 图层 key。两者命名不完全一致（station/stations、track/tracks） */
function layerKeyOf(toolKey: string): string {
  return { personnel: 'personnel', station: 'stations', track: 'tracks' }[toolKey] ?? toolKey
}

function onToolClick(key: string) {
  if (key === 'layer') {
    panelOpen.value = !panelOpen.value
    return
  }
  if (key === 'locate') {
    void toggleFocus()
    return
  }
  toggleLayer(layerKeyOf(key))
}

// ---------- 「定位」：聚焦首个作业人员 / 回到全场俯瞰 ----------
const focused = ref(false)

async function toggleFocus() {
  const target = personnelPositions.value[0]
  if (!target || !mapRef.value?.viewer) return

  if (focused.value) {
    focused.value = false
    await mapRef.value?.flyTo(EMERGENCY_HOME)
    return
  }

  // 注视点海拔必须实测：采坑底与坑沿差两百多米，
  // 用矿区平均高程会把机位对到半空中，人物点位就跑到画面外了
  const ground = await sampleGroundHeights(
    [{ key: 'focus', lon: target.lon, lat: target.lat }],
    MINE_ELEVATION
  )

  focused.value = true
  await mapRef.value?.flyTo({
    key: 'focus',
    label: `${target.name} · ${target.area}`,
    lon: target.lon,
    lat: target.lat,
    height: ground.focus ?? MINE_ELEVATION,
    heading: 0,
    pitch: -55,
    range: 900
  })
}

// ---------- 三维场景 ----------
// 五组图层都要先从三维底座采样地面高程，所以是异步的。
// 全部建完后立刻按当前开关状态刷一次显隐，否则刚建出来的图层会全部可见。
async function buildScene(viewer: Cesium.Viewer) {
  await buildBenchFramework(viewer)

  const [routes, people, stations, tracks] = await Promise.all([
    routesPromise,
    peoplePromise,
    stationsPromise,
    tracksPromise
  ])

  const [routeGroups, peopleEntities, stationEntities, trackEntities] = await Promise.all([
    buildDisasterRoutes(viewer, routes),
    buildPersonnelLayer(viewer, people),
    buildBaseStationLayer(viewer, stations),
    buildTrackLayer(viewer, tracks)
  ])

  layerGroups = [
    ...[...routeGroups.entries()].map(([key, entities]) => ({ key, entities })),
    { key: 'personnel', entities: peopleEntities },
    { key: 'stations', entities: stationEntities },
    { key: 'tracks', entities: trackEntities }
  ]

  applyLayerVisibility()
}

// ---------- 事故类型占比（环形） ----------
// 配色来自数据本身（每类一个色），不在这里写死
const accidentOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {c}%' },
  legend: {
    bottom: 0,
    itemWidth: 6,
    itemHeight: 6,
    textStyle: { fontSize: 10 }
  },
  series: [
    {
      type: 'pie',
      radius: ['46%', '68%'],
      center: ['50%', '44%'],
      label: { show: false },
      labelLine: { show: false },
      data: accidentTypes.value.map((i) => ({
        name: i.name,
        value: i.value,
        itemStyle: { color: i.color }
      }))
    }
  ]
}))

// ---------- 区域隐患统计（柱状） ----------
const areaOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  grid: { top: 18, left: 4, right: 8, bottom: 0, containLabel: true },
  xAxis: {
    type: 'category',
    data: areaHazards.value.areas,
    axisLabel: { fontSize: 10, interval: 0 }
  },
  yAxis: { type: 'value', name: '个', nameTextStyle: { color: TEXT_MUTED_COLOR, fontSize: 10 } },
  series: [
    {
      type: 'bar',
      barWidth: 16,
      itemStyle: {
        borderRadius: [2, 2, 0, 0],
        color: barGradient(CHART_COLORS[4], fadeColor(CHART_COLORS[4], 0.2))
      },
      label: { show: true, position: 'top', color: CHART_COLORS[4], fontSize: 11 },
      data: areaHazards.value.values
    }
  ]
}))

// ---------- 月度事故趋势（面积折线） ----------
const trendOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  grid: { top: 18, left: 4, right: 8, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: monthlyAccidents.value.months, boundaryGap: false },
  yAxis: { type: 'value', name: '起', nameTextStyle: { color: TEXT_MUTED_COLOR, fontSize: 10 } },
  series: [
    {
      type: 'line',
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2, color: CHART_COLORS[0] },
      itemStyle: { color: CHART_COLORS[0] },
      areaStyle: { color: areaGradient(fadeColor(CHART_COLORS[0], 0.5)) },
      data: monthlyAccidents.value.values
    }
  ]
}))
</script>

<style lang="scss" scoped>
.emergency {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.emergency__main {
  position: relative;
  width: 100%;
  flex: 1;
  min-height: 0;
}

.emergency__map {
  position: absolute;
  inset: 0;
}

// ---------- 左侧工具栏 ----------
.emergency__tools {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 58px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 14px;
  background: linear-gradient(90deg, rgba(4, 20, 38, 0.92) 0%, rgba(4, 20, 38, 0) 100%);
  z-index: $z-panel;
}

.emergency__tool {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 44px;
  padding: 7px 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: $radius-sm;
  color: $text-secondary;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    color: $primary;
    background: $bg-hover;
  }

  &.is-active {
    color: $primary;
    border-color: $border-panel;
    background: rgba(0, 229, 255, 0.14);
    @include glow-text($primary, 6px);
  }
}

.emergency__tool-icon {
  font-size: 16px;
  font-weight: 600;
  line-height: 1;
}

.emergency__tool-label {
  font-size: 10px;
}

// ---------- 图层开关 ----------
.emergency__layers {
  position: absolute;
  left: 66px;
  top: 14px;
  width: 268px;
  height: auto;
  z-index: $z-panel;
}

.emergency__layer-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 2px;
  font-size: $fs-small;
  color: $text-body;
  cursor: pointer;

  & + & {
    border-top: 1px solid $border-soft;
  }

  input {
    accent-color: $primary;
    cursor: pointer;
  }

  &:hover {
    color: $primary;
  }
}

.emergency__layer-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 6px currentColor;
}

.emergency__layer-name {
  @include ellipsis;
}

// ---------- 右侧面板 ----------
.emergency__side {
  position: absolute;
  right: $panel-gap;
  top: $panel-gap;
  bottom: $panel-gap;
  width: 380px;
  display: flex;
  flex-direction: column;
  gap: $panel-gap;
  z-index: $z-panel;

  :deep(.panel-box) {
    flex-shrink: 0;
  }

  :deep(.emergency__panel--grow) {
    flex: 1;
    min-height: 0;
  }
}

.emergency__hazards {
  height: 100%;
  overflow-y: auto;
  @include thin-scrollbar;
}

.emergency__hazard {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 2px;

  & + & {
    border-top: 1px solid $border-soft;
  }
}

.emergency__hazard-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  // 占满剩余宽度，把状态标签与操作按钮一起挤到右侧
  flex: 1;
}

.emergency__hazard-type {
  font-size: $fs-small;
  color: $text-primary;
}

.emergency__hazard-loc {
  font-size: $fs-small - 1px;
  color: $text-muted;
}

/// 隐患处置按钮
.emergency__hazard-act {
  flex-shrink: 0;
  padding: 2px 8px;
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

// ---------- 左下：月度趋势 + 救援资源 ----------
// 右边界让开右侧面板（380px）+ 两侧间隙，否则两块会叠在一起
.emergency__bottom {
  position: absolute;
  left: 66px;
  right: 380px + $panel-gap * 2;
  bottom: $panel-gap;
  height: 180px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: $panel-gap;
  z-index: $z-panel;

  :deep(.panel-box__body) {
    min-height: 0;
  }

  :deep(.echart-box) {
    height: 100% !important;
  }
}

.emergency__rescue {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: $panel-gap;
  height: 100%;
}

.emergency__rescue-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.emergency__rescue-head {
  font-size: $fs-small;
  color: $text-muted;
  padding-bottom: 4px;
  border-bottom: 1px solid $border-soft;
}

.emergency__rescue-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  font-size: $fs-small;

  & + & {
    border-top: 1px solid $border-soft;
  }
}

.emergency__rescue-name {
  flex: 1;
  min-width: 0;
  color: $text-body;
  @include ellipsis;
}

.emergency__rescue-meta {
  flex-shrink: 0;
  color: $text-primary;
}

// ---------- 中央三块横带：预案匹配 / 一键指令 / 最优调配 ----------
// 右边界与 `.emergency__bottom` 用同一个算式，两块在屏幕上左右对齐；
// bottom 212 = 底部条(180) + 两条间隙(16×2)，与它留出 16px 缝。
.emergency__center {
  position: absolute;
  left: 66px;
  right: 380px + $panel-gap * 2;
  bottom: 212px;
  height: 300px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: $panel-gap;
  z-index: $z-panel;

  // 三块等高（grid 默认 stretch），各自内部再排版
  :deep(.panel-box__body) {
    min-height: 0;
  }
}

// 三块共用的按钮。禁用态是「还没选预案」的可见反馈，
// 不用 title 提示、也不隐藏——禁用的按钮本身就在说「先选一个类型」。
.emergency__btn {
  padding: 5px 14px;
  font-size: $fs-small;
  color: $primary;
  background: rgba($primary, 0.1);
  border: 1px solid rgba($primary, 0.4);
  border-radius: $radius-sm;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, opacity 0.15s;

  &:hover:not(:disabled) {
    color: $bg-deep;
    background: $primary;
  }

  &:disabled {
    color: $text-muted;
    background: transparent;
    border-color: $border-soft;
    cursor: not-allowed;
  }
}

// ----- 1. 应急预案匹配 -----
.emergency__plans {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
}

.emergency__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
}

.emergency__chip {
  padding: 4px 10px;
  font-size: $fs-small;
  color: $text-body;
  background: $bg-panel-soft;
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    color: $primary;
    border-color: $border-panel;
  }

  &.is-active {
    color: $primary;
    border-color: $border-panel;
    background: rgba(0, 229, 255, 0.14);
    @include glow-text($primary, 6px);
  }
}

// 匹配结果卡片。`flex: 1` 把按钮顶到底部，选中前后按钮位置不跳。
.emergency__match {
  flex: 1;
  min-height: 0;
  padding: 10px 12px;
  background: $bg-panel-soft;
  border-left: 2px solid $primary;
  border-radius: $radius-sm;
  overflow-y: auto;
  @include thin-scrollbar;
}

.emergency__match-name {
  font-size: $fs-body;
  color: $text-primary;
  line-height: 1.5;
}

.emergency__match-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  font-size: $fs-small;
  color: $text-secondary;
}

.emergency__match-level {
  padding: 1px 7px;
  font-size: $fs-small - 1px;
  color: $primary;
  border: 1px solid rgba($primary, 0.4);
  border-radius: $radius-sm;
}

.emergency__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: $fs-small;
  color: $text-muted;
}

// ----- 2. 一键指令下发 -----
.emergency__cmd {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
}

.emergency__channels {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
}

.emergency__channel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 5px;
}

.emergency__channel-name {
  font-size: $fs-small;
  color: $text-body;
}

.emergency__channel-num {
  font-size: $fs-small;
  color: $text-primary;
  // 数字等宽：进度跳动时右侧数字不会左右抖
  font-variant-numeric: tabular-nums;
}

.emergency__bar {
  height: 6px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 3px;
  overflow: hidden;
}

// 过渡必须**短于**一次 tick（320ms），否则进度条永远在追目标值，
// 看起来是「一直在爬但数字已经停了」
.emergency__bar-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  box-shadow: 0 0 8px currentColor;
  transition: width 0.28s linear;
}

// ----- 3. 最优调配方案 -----
.emergency__dispatch {
  width: 100%;
  font-size: $fs-small;
  border-collapse: collapse;

  th {
    padding: 0 6px 6px;
    font-weight: 400;
    color: $text-muted;
    text-align: left;
    border-bottom: 1px solid $border-soft;
  }

  td {
    padding: 8px 6px;
    color: $text-body;
    vertical-align: middle;
  }

  tbody tr + tr td {
    border-top: 1px solid $border-soft;
  }
}

// 第一列是两行：名称 + 类别。类别不给单独一列，
// 四列已经排到 446px 内，再拆一列每格就放不下「救援队伍」四个字了
.emergency__dispatch-name {
  display: block;
  color: $text-primary;
  @include ellipsis;
}

.emergency__dispatch-kind {
  display: block;
  font-size: $fs-small - 1px;
  color: $text-muted;
}

.emergency__dispatch-eta {
  color: $primary;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

// ---------- §7.2-4 多源画面（右栏）----------
// 三个 16:9 小窗排一行。**没有真实视频流**：画面区写的是「信号接入中」，
// 不伪造一帧截图——那会让人以为已经接进去了（mock 里有说明）。
.emergency__video {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.emergency__video-cell {
  min-width: 0;
}

.emergency__video-frame {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 16 / 9;
  background: repeating-linear-gradient(
    135deg,
    rgba(0, 229, 255, 0.05) 0,
    rgba(0, 229, 255, 0.05) 6px,
    transparent 6px,
    transparent 12px
  );
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
}

.emergency__video-tip {
  font-size: $fs-small - 1px;
  color: $text-muted;
}

.emergency__video-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
  margin-top: 4px;
  font-size: $fs-small - 1px;
}

.emergency__video-name {
  color: $text-body;
  @include ellipsis;
}

.emergency__video-kind {
  flex-shrink: 0;
  color: $text-muted;
}

// ---------- 预案操作指引（AppModal 内）----------
.emergency__guide {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.emergency__guide-step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.emergency__guide-no {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: $fs-small - 1px;
  color: $primary;
  background: rgba($primary, 0.14);
  border-radius: 50%;
}

.emergency__guide-text {
  font-size: $fs-body;
  color: $text-body;
  line-height: 1.6;
}

.emergency__guide-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.emergency__guide-note {
  font-size: $fs-small;
  color: $text-muted;
}
</style>
