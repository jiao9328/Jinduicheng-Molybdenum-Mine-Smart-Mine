<template>
  <div class="decision">
    <AppHeader :show-nav="false" title="决策指挥">
      <!--
        决策闭环的进度挂在顶栏 #extra 里。
        既是「建议采纳了没有」的收口，也是巡检脚本读 DOM 的断言点。
      -->
      <template #extra>
        <div class="decision__closure">
          <span class="decision__closure-label">决策闭环</span>
          <span class="decision__closure-num">{{ ordersDone }} / {{ orders.length }}</span>
          <span class="decision__closure-unit">条工单已完成</span>
          <span v-if="offlineOrders" class="decision__closure-offline">
            （{{ offlineOrders }} 条未落库·演示）
          </span>
        </div>
      </template>
    </AppHeader>

    <main class="decision__main">
      <div class="decision__map">
        <MapScene ref="sceneRef" :build="buildScene" :home="PIT_HOME" pick @pick="onPick" />
      </div>

      <!--
        指标卡：生产分析的五项，全部来自 productionMetrics。
        **这五张卡带环比/同比**（数据里真有 chain / yoy），与智能监控页那五张
        （全部 show-trend=false）形成对照 —— 那边是此刻的快照，
        这边是「比上期好还是差」的判断依据，正是「看将来」要的东西。
      -->
      <div class="decision__metrics">
        <MetricCard
          v-for="m in productionMetrics"
          :key="m.label"
          :label="m.label"
          :value="m.value"
          :unit="m.unit"
          :decimals="m.decimals"
          :color="m.color"
          :chain="m.chain"
          :yoy="m.yoy"
        />
      </div>

      <!-- 左列 -->
      <div class="decision__side decision__side--left">
        <PanelBox title="产量趋势（计划 vs 实际）" subtitle="OUTPUT">
          <template #extra>与计划完成率同源</template>
          <EchartBox :option="productionOutputOption" height="100%" />
          <template #footer>{{ outputGapText }}</template>
        </PanelBox>

        <PanelBox title="设备利用率" subtitle="UTILIZATION">
          <template #extra>按设备类别</template>
          <EchartBox :option="utilizationOption" height="100%" />
          <template #footer>{{ utilizationAvgText }}</template>
        </PanelBox>

        <PanelBox title="工序效率" subtitle="PROCESS EFFICIENCY">
          <template #extra>实际 ÷ 设计能力</template>
          <EchartBox :option="processOption" height="100%" />
          <template #footer>柱长即达成率（满格 100%）</template>
        </PanelBox>
      </div>

      <!-- 右列 -->
      <div class="decision__side decision__side--right">
        <PanelBox title="智能辅助决策建议" subtitle="AI SUGGESTIONS">
          <template #extra>
            <span v-if="adopting !== null" class="decision__hint">填写责任人与期限</span>
            <span v-else>点建议看涉及区域</span>
          </template>
          <ul class="decision__suggestions">
            <li
              v-for="s in decisionSuggestions"
              :key="s.id"
              class="decision__suggestion"
              :class="[`is-${s.level}`, { 'is-linked': linked === s.type }]"
              @click="onSuggestionClick(s)"
            >
              <div class="decision__suggestion-main">
                <span class="decision__suggestion-tag">
                  {{ s.type }} · {{ levelText(s.level) }}
                </span>
                <span class="decision__suggestion-text">{{ s.content }}</span>
              </div>

              <!--
                采纳表单**内联在这一条里**，不做弹窗。
                弹窗要么 teleport（会跳出 ScaleScreen 的等比缩放，1920×1080 之外坐标全错），
                要么得挂到 `.decision__main` 上再自己算位置。内联没有这两个问题，
                而且「正在采纳哪一条」在 DOM 上一目了然，巡检脚本也好断言。
              -->
              <div v-if="adopting === s.id" class="decision__adopt" @click.stop>
                <label class="decision__adopt-field">
                  <span>责任人</span>
                  <input
                    v-model="adoptOwner"
                    class="decision__adopt-input"
                    type="text"
                    placeholder="如：张工"
                  />
                </label>
                <label class="decision__adopt-field">
                  <span>期限</span>
                  <input
                    v-model="adoptDue"
                    class="decision__adopt-input"
                    type="text"
                    placeholder="如：2026-10-01"
                  />
                </label>
                <div class="decision__adopt-acts">
                  <button class="decision__adopt-ok" type="button" @click="confirmAdopt(s)">
                    生成工单
                  </button>
                  <button class="decision__adopt-cancel" type="button" @click="cancelAdopt">
                    取消
                  </button>
                </div>
              </div>
              <button
                v-else-if="store.isAdmin"
                class="decision__suggestion-act"
                type="button"
                @click.stop="startAdopt(s.id)"
              >
                采纳
              </button>
            </li>
          </ul>
        </PanelBox>

        <PanelBox title="决策工单跟踪" subtitle="ORDER TRACKING">
          <template #extra>
            <span v-if="linked" class="decision__hint">联动中 · {{ linked }}</span>
            <span v-else>{{ ordersDone }} / {{ orders.length }} 已完成</span>
          </template>
          <ul v-if="orders.length" class="decision__orders">
            <li
              v-for="o in orders"
              :key="o.id"
              class="decision__order"
              :class="{ 'is-offline': o.id < 0 }"
            >
              <span class="decision__order-tag" :class="`is-${o.level}`">
                {{ LEVEL_TEXT[o.level] }}
              </span>
              <div class="decision__order-main">
                <span class="decision__order-title">{{ o.suggestion }}</span>
                <span class="decision__order-meta">
                  {{ o.owner || '未指派' }} · 期限 {{ o.due || '未定' }}
                  <em v-if="o.id < 0" class="decision__order-offline">未落库·演示</em>
                </span>
              </div>
              <StatusTag :status="o.status" :text="STATUS_TEXT[o.status]" />
              <button
                v-if="store.isAdmin && ORDER_NEXT[o.status]"
                class="decision__order-act"
                type="button"
                @click="advanceOrder(o)"
              >
                {{ ORDER_ACTION_TEXT[o.status] }}
              </button>
            </li>
          </ul>
          <p v-else class="decision__empty">
            暂无工单。在上面的建议上点「采纳」即可生成一条可跟踪的待办。
          </p>
        </PanelBox>

        <PanelBox title="损失贫化率趋势" subtitle="LOSS &amp; DILUTION">
          <template #extra>越低越好</template>
          <EchartBox :option="lossDilutionOption" height="100%" />
        </PanelBox>
      </div>

      <!--
        底部四块 = 安全分析维。
        第一块是**指标**，右边三块是它的**证据** —— 而且同屏可核：
        「本月隐患上报」= 隐患类型分布各段之和，「本月三违」= violationStats.total
        = 三违图无论切到哪个口径的和。这条自洽是 mock 里就写明的约束，
        拆页之后本页仍然保留，所以 `check-decision.mjs` 的强判据在这里不退化。
      -->
      <div class="decision__bottom">
        <PanelBox title="安全指标" subtitle="SAFETY KPIS">
          <template #extra>与右侧三图同源</template>
          <ul class="decision__kpis">
            <li v-for="m in safetyMetrics" :key="m.label" class="decision__kpi">
              <span class="decision__kpi-label">{{ m.label }}</span>
              <span class="decision__kpi-value">{{ formatMetric(m) }}</span>
              <span v-if="m.unit" class="decision__kpi-unit">{{ m.unit }}</span>
            </li>
          </ul>
        </PanelBox>

        <PanelBox title="事故率趋势" subtitle="ACCIDENT RATE">
          <template #extra>起数 vs 千人负伤率</template>
          <EchartBox :option="accidentOption" height="100%" />
        </PanelBox>

        <PanelBox title="隐患类型分布" subtitle="HAZARD TYPES">
          <template #extra>按类型</template>
          <EchartBox :option="hazardTypeOption" height="100%" />
          <template #footer>合计 {{ hazardTotal }} 项，等于安全指标的上报数</template>
        </PanelBox>

        <PanelBox title="「三违」行为统计" subtitle="VIOLATIONS">
          <template #extra>
            <!--
              两个口径做成切换，而不是并排两块图：数据结构完全一样，
              并排放的观感就是「同一张图印了两遍」——正是用户抱怨的那种重复。
            -->
            <button
              v-for="t in VIOLATION_VIEWS"
              :key="t.key"
              class="decision__toggle"
              :class="{ 'is-active': violationView === t.key }"
              type="button"
              @click="violationView = t.key"
            >
              {{ t.label }}
            </button>
          </template>
          <EchartBox :option="violationOption" height="100%" />
          <template #footer>
            {{ VIOLATION_FOOTER[violationView] }}，均为 {{ violationStats.total }}
            {{ violationStats.unit }}
          </template>
        </PanelBox>
      </div>

      <!--
        拾取浮层。
        ⚠️ 必须是 `.decision__main` 的**直接子元素**，不能用 teleport：
        teleport 会把它挪出 ScaleScreen 的等比缩放容器，1920×1080 之外的
        屏幕坐标会整片错位（各页面的弹层都遵守这一条）。
      -->
      <div v-if="picked" class="decision__pick" :style="pickStyle">
        <header class="decision__pick-head">
          <span class="decision__pick-kind" :style="{ background: picked.accent }">
            {{ picked.kind }}
          </span>
          <h4 class="decision__pick-title">{{ picked.title }}</h4>
          <button class="decision__pick-close" type="button" @click="clearPick">×</button>
        </header>
        <dl class="decision__pick-body">
          <div v-for="row in picked.rows" :key="row.label" class="decision__pick-row">
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
import type * as Cesium from 'cesium'
import type { EChartsOption } from 'echarts'
import AppHeader from '@/components/AppHeader.vue'
import PanelBox from '@/components/PanelBox.vue'
import EchartBox from '@/components/EchartBox.vue'
import MetricCard from '@/components/MetricCard.vue'
import MapScene from '@/components/MapScene.vue'
import StatusTag from '@/components/StatusTag.vue'
import { buildTwinRiskLayer, buildTwinSlopeLayer } from '@/scene/layers/twinLayer'
import { SCENE_WAYPOINTS, type SceneWaypoint } from '@/scene/sceneConfig'
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
import { useAsyncData } from '@/hooks/useAsyncData'
import { useUserStore } from '@/stores/user'
import * as decisionApi from '@/api/decision'
import * as twinApi from '@/api/digitalTwin'
import type { AnalysisMetric, DecisionLevel, DecisionOrder, OrderStatus } from '@/api/decision'
import type { TwinRiskZone, TwinSlopeSite } from '@/api/digitalTwin'

/**
 * 决策指挥（看将来）—— 四分法里的「决策」一页。
 *
 * 本页回答的是**下一步该做什么**：趋势往哪走、哪里效率低、风险在哪，
 * 以及最关键的 —— 系统给出的建议**能被人采纳、落到某个人头上、变成一条可跟踪的工单**。
 * 这正是用户说的「让企业可以收集管理信息，做出决策」：
 * 光有图不算决策，图上的建议得能派出去、有期限、能改状态。
 *
 * 与其他三页的分工是**数据的时间性**，不是图表的种类：
 *   智能监控 = 此刻的快照 · 统计报表 = 过去的汇总 · 决策指挥 = 将来的判断 · 成本管理 = 钱花在哪
 * 所以本页**不出现吨成本拆解与峰谷平电费**（那是花钱的去向，归成本管理），
 * 也不出现年度序列、年度热力与质检记录（那是过去的汇总，归统计报表）。
 *
 * ⚠️ 安全分析那三块（事故率 / 隐患类型 / 三违）**留在本页**，
 * 是因为它们的数据源（`decisionApi` 的 fetchAccidentTrend 等）**全库只有本页在用**
 * —— 已经 grep 确认。删掉它们不是「去掉重复」，是让这几组数据从此在系统里消失。
 * 独立的安全管理页 `/safety` 走的是另一套 `safetyApi`，与本页不共数据。
 */

// ---------- 数据 ----------
const { data: productionMetrics } = useAsyncData(
  decisionApi.fetchProductionMetrics,
  [] as AnalysisMetric[]
)

const { data: productionOutput } = useAsyncData(decisionApi.fetchProductionOutput, {
  months: [] as string[],
  plan: [] as number[],
  actual: [] as number[],
  unit: ''
})
const { data: equipmentUtilization } = useAsyncData(decisionApi.fetchEquipmentUtilization, [] as {
  name: string
  value: number
}[])
const { data: processEfficiency } = useAsyncData(decisionApi.fetchProcessEfficiency, [] as {
  name: string
  actual: number
  design: number
}[])
const { data: lossDilution } = useAsyncData(decisionApi.fetchLossDilution, {
  months: [] as string[],
  unit: '',
  series: [] as { name: string; data: number[] }[]
})
const { data: hazardTypeDistribution } = useAsyncData(
  decisionApi.fetchHazardTypeDistribution,
  [] as { name: string; value: number; color: string }[]
)
/**
 * 「三违」统计。`total` 是**数据源自带的合计**，不是页面另算的 ——
 * mock 里写明「byType 与 byTeam 各自的和都等于 total」，
 * 底栏直接显示它，这条约束就摆在用户眼前。
 */
const { data: violationStats } = useAsyncData(decisionApi.fetchViolationStats, {
  byType: [] as { name: string; value: number }[],
  byTeam: [] as { name: string; value: number }[],
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
/** 安全分析的五张卡 —— 数字全都取自本页底部三块图，见下面「安全指标」面板 */
const { data: safetyMetrics } = useAsyncData(
  decisionApi.fetchSafetyMetrics,
  [] as AnalysisMetric[]
)
/**
 * ⚠️ `level` 在这里是**裸字符串**（mock 没有把它收成字面量联合类型），
 * 所以下面用 `levelText` / `toLevel` 两处各自兜一次，
 * 不直接拿它去索引 `Record<DecisionLevel, …>`（那样编译不过）。
 */
const { data: decisionSuggestions } = useAsyncData(decisionApi.fetchDecisionSuggestions, [] as {
  id: number
  type: string
  level: string
  content: string
}[])

/**
 * 三维要用的两组数据先发起请求，`useAsyncData` 复用同一个 Promise。
 * 这是全库统一的写法：`build` 回调只在建场景时跑一遍，晚到的数据补不进图层，
 * 而 `useAsyncData` 不返回 Promise、拿不到「数据到了」的信号。
 */
const riskZonesPromise = twinApi.fetchTwinRiskZones()
const slopeSitesPromise = twinApi.fetchTwinSlopeSites()
const { data: riskZones } = useAsyncData(() => riskZonesPromise, [] as TwinRiskZone[])
const { data: slopeSites } = useAsyncData(() => slopeSitesPromise, [] as TwinSlopeSite[])

/**
 * 决策工单 —— 全库唯一一份**没有 mock 降级数据**的列表。
 *
 * 后端没起来时它就是空的，页面显示「暂无工单」，而不是显示几条编出来的工单：
 * 工单是用户的动作产生的，凭空造一条等于伪造业务记录。
 */
const { data: orders } = useAsyncData(decisionApi.fetchDecisionOrders, [] as DecisionOrder[])

const store = useUserStore()

// ---------------------------------------------------------------------------
// 决策闭环：采纳建议 → 生成工单 → 状态流转
// ---------------------------------------------------------------------------

/** 状态文案。三档与 `StatusTag` 的取值一一对应 */
const STATUS_TEXT: Record<OrderStatus, string> = {
  todo: '待处理',
  doing: '处理中',
  done: '已完成'
}
/** 紧急度文案。键是 string 而不是 DecisionLevel —— 建议数据里的 level 是裸字符串 */
const LEVEL_TEXT: Record<string, string> = { high: '紧急', mid: '一般', low: '较低' }
/** 查不到就原样显示这个值：显示成 undefined 会让人以为是页面坏了，其实是数据里多了个新档 */
const levelText = (level: string) => LEVEL_TEXT[level] ?? level

/**
 * 把裸字符串收敛成 `DecisionLevel` —— **入库前的最后一道**。
 *
 * 后端 `decision/orders` 的 `enumFields.level` 也是同一套值域、同一个 fallback
 * （见 `server/db.mjs`），两边都拦一次是有意的：前端拦是为了不发脏值，
 * 后端拦是因为它不能信任任何客户端。
 */
const toLevel = (level: string): DecisionLevel =>
  (['high', 'mid', 'low'] as readonly string[]).includes(level) ? (level as DecisionLevel) : 'mid'
/** 状态推进的下一步。`done` 没有下一步，按钮据此不渲染 */
const ORDER_NEXT: Record<OrderStatus, OrderStatus | null> = {
  todo: 'doing',
  doing: 'done',
  done: null
}
/** 按钮动词跟着当前状态走 */
const ORDER_ACTION_TEXT: Record<OrderStatus, string> = {
  todo: '开始处理',
  doing: '标记完成',
  done: ''
}

const ordersDone = computed(() => orders.value.filter((o) => o.status === 'done').length)
/** 未落库的条数（id 为负 = 本地临时单，后端没起来时的产物） */
const offlineOrders = computed(() => orders.value.filter((o) => o.id < 0).length)

/** 正在填写采纳表单的建议 id，null = 没在填 */
const adopting = ref<number | null>(null)
const adoptOwner = ref('')
const adoptDue = ref('')

function startAdopt(id: number) {
  adopting.value = id
  adoptOwner.value = ''
  adoptDue.value = ''
}

function cancelAdopt() {
  adopting.value = null
  adoptOwner.value = ''
  adoptDue.value = ''
}

/**
 * 确认采纳：先乐观插入一条本地单，再调写接口。
 *
 * 本地单的 id 取**负数**，这样「这条还没落库」在数据本身就看得出来，
 * 不靠一个额外数组去记 —— 负 id 不可能是后端发的（自增主键从 1 起）。
 */
async function confirmAdopt(s: {
  id: number
  type: string
  level: string
  content: string
}) {
  const owner = adoptOwner.value.trim()
  const due = adoptDue.value.trim()
  const level = toLevel(s.level)

  const optimistic: DecisionOrder = {
    id: -Date.now(),
    suggestion: s.type,
    // 建议正文**抄一份快照**进工单：之后建议文案改了，已经派出去的工单不该跟着变
    content: s.content,
    level,
    owner,
    status: 'todo',
    due,
    createdAt: new Date().toISOString()
  }
  orders.value = [...orders.value, optimistic]
  cancelAdopt()

  try {
    const saved = await decisionApi.createDecisionOrder({
      suggestion: s.type,
      content: s.content,
      level,
      owner,
      due
    })

    // `null` = 后端未就绪，本次没有落库。**保留那条负 id 的本地单**，
    // 让用户看见「未落库·演示」，而不是让它悄悄变成一条看起来正常的记录。
    if (!saved) {
      console.info('[decision] 后端未就绪，工单未落库（保留本地演示单）')
      return
    }
    // 落库成功：用服务端返回的行替换本地单（id 与 createdAt 都以服务端为准）
    orders.value = orders.value.map((o) => (o.id === optimistic.id ? saved : o))
  } catch (err) {
    // 抛到这里的是 401 / 403 / 400 —— 不可降级，必须回滚并把原因说出来
    orders.value = orders.value.filter((o) => o.id !== optimistic.id)
    console.error('[decision] 生成工单失败，已回滚：', err)
  }
}

/** 推进一条工单的状态 */
async function advanceOrder(order: DecisionOrder) {
  const next = ORDER_NEXT[order.status]
  if (!next) return

  // 本地临时单（后端未就绪时产生的）没有可改的库行，直接本地流转。
  // 不试一次 PATCH 再失败：那会在控制台留下一条必然的 404 噪声。
  if (order.id < 0) {
    orders.value = orders.value.map((o) => (o.id === order.id ? { ...o, status: next } : o))
    return
  }

  const previous = orders.value
  orders.value = previous.map((o) => (o.id === order.id ? { ...o, status: next } : o))

  try {
    const saved = await decisionApi.updateOrderStatus(order.id, next)
    if (!saved) {
      // 后端未就绪：保留乐观值（与 EmergencyView 处理隐患降级的方式一致）
      console.info('[decision] 后端未就绪，状态未落库（保留本地值）')
      return
    }
    orders.value = orders.value.map((o) => (o.id === order.id ? saved : o))
  } catch (err) {
    orders.value = previous
    console.error('[decision] 工单状态流转失败，已回滚：', err)
  }
}

// ---------------------------------------------------------------------------
// 三维：风险区 + 边坡监测点
// ---------------------------------------------------------------------------

/**
 * 默认机位：采坑全景。
 *
 * 比数字孪生页那个 `pit` 机位略远（range 1700 vs 1500）——
 * 本页图元不只在坑里，北帮爆破区（RZ-05）在坑沿上，坑内机位会把它压到画面边缘。
 */
const PIT_HOME: SceneWaypoint = (() => {
  const pit = SCENE_WAYPOINTS.find((w) => w.key === 'pit')
  if (!pit) throw new Error('DecisionView：SCENE_WAYPOINTS 里没有 key 为 pit 的机位')
  return { ...pit, key: 'decision-home', range: 1700 }
})()

const sceneRef = shallowRef<InstanceType<typeof MapScene> | null>(null)

/**
 * 两层业务图层：安全风险区、边坡位移监测点。
 *
 * **本页不做实体高亮**（智能监控页有）—— 风险区是贴地的填充几何，
 * Cesium 会强制关掉贴地几何的 outline，高亮只能改填充色，
 * 那就要为 7 个风险区各自记账原色、并在每次拾取时逐个还原。
 * 本页的联动反馈是「浮层弹出 + 镜头飞过去」，已经足够看得见，
 * 不值得为它引入一套按对象记账的高亮状态机。
 *
 * `buildTwinSlopeLayer` 的返回值是图层句柄（含 entities 与动画播放接口），
 * 本页不用动画（那是数字孪生页的「动态模拟」），也不做图层开关，所以只 await 不接；
 * 它本身不启 rAF，不会留下需要 dispose 的帧循环。
 */
async function buildScene(viewer: Cesium.Viewer) {
  const [zones, sites] = await Promise.all([riskZonesPromise, slopeSitesPromise])
  await Promise.all([buildTwinRiskLayer(viewer, zones), buildTwinSlopeLayer(viewer, sites)])
}

// ---------------------------------------------------------------------------
// 共用图表件
// ---------------------------------------------------------------------------

/** 求和。产量底栏与隐患合计两处用到，写一份 */
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0)

/**
 * 指标值按各自的小数位渲染。
 *
 * 不统一成固定位数：这批卡里「本月隐患上报 48 项」写 48.00 是噪音，
 * 而「整改率 96.50%」少一位就和数据源对不上了。`decimals` 缺省即整数。
 */
const formatMetric = (m: AnalysisMetric) =>
  m.decimals != null ? m.value.toFixed(m.decimals) : String(m.value)

/**
 * 双轴图的单根 Y 轴（带主题色）。
 *
 * 双 Y 轴场景下 `EchartBox` 的 withTheme 对**数组形式**的 yAxis 原样透传
 * （不做主题注入），所以这两根轴必须自己把主题里的具名常量补上，
 * 否则会退回 ECharts 的默认灰，与同页其它图表不一致。
 */
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

/** 横向条形图 —— 工序效率用 */
function buildHBar(
  rows: { name: string; value: number }[],
  opts: { unit: string; max?: number; background?: boolean; labelFmt?: (v: number) => string }
): EChartsOption {
  // 反转：ECharts 的类目轴自下而上，不反转的话第一项会排在最后一行
  const data = [...rows].reverse()
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { top: 8, left: 4, right: 42, bottom: 0, containLabel: true },
    xAxis: { type: 'value', name: opts.unit, nameTextStyle: AXIS_NAME_STYLE, max: opts.max },
    yAxis: {
      type: 'category',
      data: data.map((r) => r.name),
      axisLabel: { fontSize: 10, color: TEXT_MUTED_COLOR }
    },
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
          formatter: (p: { value: unknown }) =>
            opts.labelFmt ? opts.labelFmt(Number(p.value)) : `${p.value}`
        },
        data: data.map((r, i) => {
          const c = CHART_COLORS[i % CHART_COLORS.length]
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
function buildCountBar(
  rows: { name: string; value: number }[],
  unit: string,
  color: string
): EChartsOption {
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

// ---------------------------------------------------------------------------
// 图表配置
// ---------------------------------------------------------------------------

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

/**
 * 产量趋势底栏：最后一个月完成率 = 实际 ÷ 计划。
 * 与指标卡的「计划完成率」是同一件事的两种算法，写出来两者对不上就会被看见。
 */
const outputGapText = computed(() => {
  const { months, plan, actual, unit } = productionOutput.value
  const i = months.length - 1
  if (i < 0 || !plan[i]) return ''
  const rate = ((actual[i] / plan[i]) * 100).toFixed(2)
  return `${months[i]}完成率 ${rate}%（实际 ${actual[i]} ÷ 计划 ${plan[i]} ${unit}）`
})

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
 * 设备利用率底栏：综合利用率 = 各类别均值。
 * 与指标卡的「设备综合利用率」是同一个口径的两种说法，
 * 页面上同时出现，对不上就会当场露馅 —— 这正是想要的。
 */
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
  // 圆心写合计：环形各段之和等于隐患上报数，这个数是本页的一条数据约束，
  // 写在圆心既好看，也让看的人能当场对上
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

/** 「三违」两个口径：同一张图，切换数据源 */
const VIOLATION_VIEWS = [
  { key: 'type', label: '按类别' },
  { key: 'team', label: '按区队' }
] as const
const violationView = ref<'type' | 'team'>('type')

/** 底栏随口径变 —— 顺带把「两边总数相等」这条数据约束摆出来 */
const VIOLATION_FOOTER: Record<'type' | 'team', string> = {
  type: '按行为类别切分同一批行为',
  team: '按区队切分同一批行为'
}

const violationOption = computed<EChartsOption>(() =>
  buildCountBar(
    violationView.value === 'type' ? violationStats.value.byType : violationStats.value.byTeam,
    '次',
    // 两个口径**同一个颜色**：这是同一批行为的两种切法，
    // 换色会让人以为是两组不同的数据
    CHART_COLORS[5]
  )
)

// ---------------------------------------------------------------------------
// 双向联动
// ---------------------------------------------------------------------------

/** 当前联动中的对象名，显示在面板角上，也是检查脚本的断言点 */
const linked = ref('')

interface PickCard {
  kind: string
  title: string
  rows: { label: string; value: string }[]
  /** 类型角标的底色 —— 风险区按等级取红/橙/黄/蓝 */
  accent: string
}

const picked = ref<PickCard | null>(null)
const pickAt = ref({ x: 0, y: 0 })

/** 浮层尺寸，用来做边界钳制（与样式里的宽高一致） */
const PICK_W = 300
const PICK_H = 196
/** 中央可视区（左右面板之间），浮层不许越过它压到面板上 */
const CENTER_LEFT = 432
const CENTER_RIGHT = 1488
/** `__main` 的高度（1080 − 顶栏 84） */
const MAIN_H = 996

const pickStyle = computed(() => {
  const x = Math.min(Math.max(pickAt.value.x + 14, CENTER_LEFT), CENTER_RIGHT - PICK_W)
  const y = Math.min(Math.max(pickAt.value.y + 14, 104), MAIN_H - PICK_H - 16)
  return { left: `${x}px`, top: `${y}px` }
})

/**
 * 建议 → 涉及区域。
 *
 * ⚠️ **这是展示口径，不是数据源里有的东西**：`decisionSuggestions` 只有
 * type / level / content 三个字段，**没有任何地理信息**（已核对 mock）。
 * 下面是「这类建议主要跟哪片区域有关」的归集，浮层里会把口径原样写给用户看。
 *
 * 取值必须是 `AREA_ANCHORS` 里**真实存在的键** —— 打错一个字的后果是
 * 镜头不飞、浮层却还写着「已定位」，属于「不报错的错」，`check-linkage.mjs` 会断言。
 */
const SUGGESTION_AREA: Record<string, string> = {
  生产计划优化: '北帮采剥面',
  设备维保时机: '选矿厂',
  库存周转: '厂区',
  定价策略: '厂区'
}

/** 飞到某片区域时的机位距离。与智能监控页 `focusAlert` 取同一档 */
const AREA_RANGE = 900

/**
 * 点建议卡 → 飞到涉及区域 + 弹浮层。
 *
 * 「定价策略」这条归到厂区最勉强 —— 它本来就不是地理问题。但四条卡在同一个
 * 列表里，单独一条点了不飞会让交互显得时灵时不灵，所以照旧给个落点，
 * 并让浮层如实说明这是业务归属而不是实测坐标。
 */
function onSuggestionClick(s: { type: string; level: string; content: string }) {
  const areaName = SUGGESTION_AREA[s.type]
  const anchor = areaName ? areaAnchor(areaName) : null

  linked.value = s.type
  // 建议列表在右列，浮层就落在靠右那半边，别横跨整个三维区。
  // ⚠️ 这句必须在下面那个 `return` 之前：查不到区域时同样要把卡片弹出来
  // （卡片上写着「无对应区域」），放在 return 之后会出现「卡片停在上一次的位置」。
  pickAt.value = { x: CENTER_RIGHT - PICK_W - 24, y: 300 }
  picked.value = {
    kind: '决策建议',
    title: s.type,
    accent: '#00e5ff',
    rows: [
      { label: '紧急度', value: levelText(s.level) },
      { label: '建议内容', value: s.content },
      { label: '涉及区域', value: areaName ?? '无对应区域' },
      { label: '口径', value: '按建议类型的业务归属归集，非实测坐标' }
    ]
  }

  if (!anchor) {
    console.info(
      `[decision] 建议「${s.type}」的区域「${areaName ?? '—'}」不在 AREA_ANCHORS 里，无法定位`
    )
    return
  }

  sceneRef.value?.flyTo({
    key: `suggestion-${s.type}`,
    label: anchor.label,
    lon: anchor.lon,
    lat: anchor.lat,
    height: anchor.height,
    heading: 0,
    pitch: -35,
    range: AREA_RANGE
  })
}

/** 风险等级 → 四色。与三维风险圆同源，两边不可能对不上 */
const riskColor = (level: string) =>
  twinApi.TWIN_RISK_LEVELS.find((l) => l.level === level)?.color ?? TEXT_MUTED_COLOR

/**
 * 三维 → 面板。
 *
 * 风险区（`twin-risk-*` / `twin-risk-label-*`）与边坡监测点（`slope-site-*`）
 * 都能识别；其余地物一律按「点了空地」处理 —— 本页在三维里只放了这两层。
 *
 * `entityId` 为空**不一定是点了空地**：倾斜摄影瓦片被点中时也没有 id。
 * 两种情况都按「清空选中态」处理，但浮层不弹 —— 弹一个「未绑定」的卡片
 * 反而让人以为点错了地方。
 */
function onPick(hit: ScenePick) {
  if (!hit.entityId) return clearPick()

  const ref = parseEntityId(hit.entityId)
  if (!ref) {
    // 前缀认识不了：不是异常，但留个可查的痕迹（本项目白屏过一次的教训）
    console.info(`[decision] 认不出的实体 id：${hit.entityId}`)
    return clearPick()
  }

  pickAt.value = hit.screen
  linked.value = ''

  if (ref.kind === 'risk') {
    const z = riskZones.value.find((x) => x.id === ref.key)
    if (!z) return clearPick()
    linked.value = z.name
    picked.value = {
      kind: `风险区 · ${z.level}`,
      title: z.name,
      accent: riskColor(z.level),
      rows: [
        { label: '类型', value: z.category },
        { label: '等级', value: z.level },
        { label: '影响半径', value: `${z.radius} m` },
        { label: '描述', value: z.detail }
      ]
    }
    return
  }

  if (ref.kind === 'slope') {
    const s = slopeSites.value.find((x) => x.id === ref.key)
    if (!s) return clearPick()
    const st = twinApi.slopeStatus(s.displacement)
    linked.value = `${s.id} ${s.name}`
    picked.value = {
      kind: '边坡监测站',
      title: `${s.id} ${s.name}`,
      accent: twinApi.TWIN_SLOPE_STATUS_COLORS[st],
      rows: [
        { label: '累计位移', value: `${s.displacement} mm` },
        { label: '位移速率', value: `${s.rate} mm/d` },
        { label: '状态', value: st },
        { label: '阈值', value: `${twinApi.TWIN_SLOPE_THRESHOLD} mm` }
      ]
    }
    return
  }

  // 本页三维里只有风险区与边坡两层，别的命中没有业务含义
  clearPick()
}

function clearPick() {
  picked.value = null
  linked.value = ''
}
</script>

<style lang="scss" scoped>
// 指标卡行的高度。左右两列都从它的下沿开始排，所以这个值**必须是一个确定值**，
// 不能靠内容撑开——撑开的话两列的位置就跟着数据变了。
$metrics-h: 72px;
// 底部三块的高度。左右两列从它的上沿收住
$bottom-h: 236px;

.decision {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.decision__main {
  position: relative;
  width: 100%;
  flex: 1;
  min-height: 0;
}

// 三维铺满整个 main，面板浮在它上面。
// ⚠️ 各面板容器是**绝对的叶子**，只吃自己那块矩形；
// 中间不许出现任何「铺满中央」的 wrapper（见 EmergencyView 的硬约束注释），
// 那种容器会把整条中央带的鼠标事件一次性吃掉，三维点不动、转不了，还不报错。
.decision__map {
  position: absolute;
  inset: 0;
}

.decision__metrics {
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

.decision__side {
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

.decision__bottom {
  position: absolute;
  left: $panel-width + $panel-gap * 3;
  right: $panel-width + $panel-gap * 3;
  bottom: $panel-gap;
  height: $bottom-h;
  display: grid;
  // 四列：安全指标 + 三张图。指标块窄一档 —— 它只是五行「标签 + 数」
  grid-template-columns: 0.8fr repeat(3, 1fr);
  gap: $panel-gap;
  z-index: $z-panel;
  pointer-events: none;

  :deep(.panel-box) {
    pointer-events: auto;
  }
}

// ---------- 安全指标（紧凑列表）----------
.decision__kpis {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.decision__kpi {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 1px 0;

  // ⚠️ 这里**刻意不给环比上色**：本页顶部那五张卡用的是「涨绿跌红」，
  // 而安全指标里「隐患整改率」涨是好事、「事故起数」涨是坏事 ——
  // 同一套配色规则在一列里必然对一半错一半。所以趋势交给右边的图去说，
  // 这一列只放数。
  &-label {
    flex: 1;
    min-width: 0;
    font-size: $fs-small - 1px;
    color: $text-secondary;
    @include ellipsis;
  }

  &-value {
    @include numeric;
    font-size: 15px;
    font-weight: 600;
    color: $text-primary;
  }

  &-unit {
    flex-shrink: 0;
    font-size: $fs-small - 1px;
    color: $text-muted;
  }
}

// ---------- 顶栏的闭环进度 ----------
.decision__closure {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: $fs-small;

  &-label {
    color: $text-secondary;
  }

  &-num {
    @include numeric;
    font-size: 16px;
    font-weight: 600;
    color: $primary;
  }

  &-unit {
    color: $text-muted;
  }

  &-offline {
    color: $orange;
  }
}

.decision__hint {
  color: $primary;
}

// ---------- 建议列表 ----------
.decision__suggestions {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}

.decision__suggestion {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 5px 7px;
  border-left: 2px solid transparent;
  background: rgba(10, 32, 56, 0.5);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;

  &:hover {
    background: rgba(0, 229, 255, 0.12);
  }

  // 紧急度用左边框配色区分：high 红 / mid 橙 / low 蓝
  &.is-high {
    border-left-color: $red;
  }

  &.is-mid {
    border-left-color: $orange;
  }

  &.is-low {
    border-left-color: $blue;
  }

  // 与三维联动时的标记：既是给用户的反馈，也是检查脚本的断言点
  &.is-linked {
    background: rgba(0, 229, 255, 0.16);
  }
}

.decision__suggestion-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.decision__suggestion-tag {
  font-size: $fs-small - 1px;
  color: $primary;
}

.decision__suggestion-text {
  font-size: $fs-small - 1px;
  line-height: 1.45;
  color: $text-body;
}

.decision__suggestion-act {
  flex-shrink: 0;
  align-self: center;
  padding: 3px 8px;
  font-size: $fs-small - 1px;
  color: $primary;
  background: rgba(0, 229, 255, 0.12);
  border: 1px solid rgba($primary, 0.5);
  border-radius: 2px;
  cursor: pointer;

  &:hover {
    background: rgba(0, 229, 255, 0.26);
  }
}

// ---------- 采纳表单（内联，不弹窗）----------
.decision__adopt {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px;
  background: rgba(4, 16, 30, 0.7);
  border: 1px solid rgba($primary, 0.33);
}

.decision__adopt-field {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: $fs-small - 1px;
  color: $text-muted;

  span {
    flex-shrink: 0;
    width: 36px;
  }
}

.decision__adopt-input {
  flex: 1;
  min-width: 0;
  width: 76px;
  padding: 2px 4px;
  font-size: $fs-small - 1px;
  color: $text-body;
  background: rgba(10, 32, 56, 0.9);
  border: 1px solid $border-soft;
  outline: none;

  &:focus {
    border-color: $primary;
  }
}

.decision__adopt-acts {
  display: flex;
  gap: 4px;
}

.decision__adopt-ok,
.decision__adopt-cancel {
  flex: 1;
  padding: 3px 0;
  font-size: $fs-small - 1px;
  border-radius: 2px;
  cursor: pointer;
}

.decision__adopt-ok {
  color: $bg-deep;
  background: $primary;
  border: none;
}

.decision__adopt-cancel {
  color: $text-secondary;
  background: transparent;
  border: 1px solid $border-soft;
}

// ---------- 工单列表 ----------
.decision__orders {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
}

.decision__order {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: rgba(10, 32, 56, 0.5);

  // 未落库的本地单压暗一档：它不是一条真记录
  &.is-offline {
    opacity: 0.75;
  }
}

.decision__order-tag {
  flex-shrink: 0;
  padding: 1px 4px;
  font-size: $fs-small - 1px;
  border-radius: 2px;

  &.is-high {
    color: $red;
    background: rgba(255, 77, 79, 0.16);
  }

  &.is-mid {
    color: $orange;
    background: rgba(255, 159, 28, 0.16);
  }

  &.is-low {
    color: $blue;
    background: rgba(24, 144, 255, 0.16);
  }
}

.decision__order-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.decision__order-title {
  font-size: $fs-small - 1px;
  color: $text-primary;
  @include ellipsis;
}

.decision__order-meta {
  font-size: $fs-small - 1px;
  color: $text-muted;
  @include ellipsis;
}

.decision__order-offline {
  font-style: normal;
  color: $orange;
}

.decision__order-act {
  flex-shrink: 0;
  padding: 2px 6px;
  font-size: $fs-small - 1px;
  color: $primary;
  background: rgba(0, 229, 255, 0.12);
  border: 1px solid rgba($primary, 0.5);
  border-radius: 2px;
  cursor: pointer;

  &:hover {
    background: rgba(0, 229, 255, 0.26);
  }
}

.decision__empty {
  padding: 10px 4px;
  font-size: $fs-small;
  line-height: 1.6;
  color: $text-muted;
}

// ---------- 「三违」口径切换 ----------
.decision__toggle {
  margin-left: 4px;
  padding: 1px 6px;
  font-size: $fs-small - 1px;
  color: $text-secondary;
  background: transparent;
  border: 1px solid $border-soft;
  border-radius: 2px;
  cursor: pointer;

  &.is-active {
    color: $bg-deep;
    background: $primary;
    border-color: $primary;
  }
}

// ---------- 拾取浮层 ----------
.decision__pick {
  position: absolute;
  width: 300px;
  z-index: $z-popup;
  background: rgba(6, 26, 46, 0.94);
  border: 1px solid rgba($primary, 0.5);
  box-shadow: 0 0 18px rgba(0, 0, 0, 0.5);
  @include corner-brackets(10px, 2px, $primary);
}

.decision__pick-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid $border-soft;
  background: linear-gradient(180deg, rgba(0, 229, 255, 0.12) 0%, transparent 100%);
}

.decision__pick-kind {
  flex-shrink: 0;
  padding: 1px 5px;
  font-size: $fs-small - 1px;
  color: $bg-deep;
  background: $primary;
  border-radius: 2px;
}

.decision__pick-title {
  flex: 1;
  min-width: 0;
  font-size: $fs-small;
  font-weight: 600;
  color: $text-primary;
  @include ellipsis;
}

.decision__pick-close {
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

.decision__pick-body {
  padding: 8px 10px;
}

.decision__pick-row {
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
  }
}
</style>
