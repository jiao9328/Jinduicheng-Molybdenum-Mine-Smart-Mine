<template>
  <div class="equipment">
    <AppHeader :show-nav="false" title="智能统计分析" />

    <main class="equipment__main">
      <div class="equipment__content">
        <!-- 顶部指标卡 -->
        <div class="equipment__metrics">
          <MetricCard
            v-for="m in equipmentMetrics"
            :key="m.label"
            :label="m.label"
            :value="m.value"
            :unit="m.unit"
            :chain="m.chain"
            :yoy="m.yoy"
            :color="m.color"
          />
        </div>

        <!-- 中部四栏：评分表 / 趋势预判 / 权重 / 备件库存台账 -->
        <div class="equipment__row equipment__row--mid">
          <PanelBox title="单体设备评分表" subtitle="DEVICE SCORES">
            <!--
              点一行 ⇒ 打开该设备的档案浮层（docx §03-1「一机一码扫码即可查看设备档案…」）。
              大屏上没有扫码枪，所以这里把「扫码」落成「点一行」——
              点进去看到的东西与扫码一致，这是演示环境下能给出的等价交互。
            -->
            <el-table
              :data="deviceScores"
              size="small"
              height="100%"
              class="data-table"
              :header-cell-style="{ ...tableHeaderStyle() }"
              :cell-style="{ ...tableCellStyle() }"
              @row-click="openArchive"
            >
              <el-table-column prop="name" label="设备名称" min-width="96" />
              <el-table-column prop="score" label="评分" width="72">
                <template #default="{ row }">
                  <span class="equipment__score" :class="`is-${scoreLevel(row.score)}`">
                    {{ row.score }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column prop="time" label="时间" width="108">
                <template #default="{ row }">
                  <span class="equipment__time">{{ row.time }}</span>
                </template>
              </el-table-column>
            </el-table>
          </PanelBox>

          <PanelBox title="设备类别状态趋势预判" subtitle="TREND FORECAST">
            <EchartBox :option="trendOption" height="100%" />
          </PanelBox>

          <PanelBox title="设备状态评分（权重设置）" subtitle="WEIGHT">
            <EchartBox :option="weightOption" height="100%" />
          </PanelBox>

          <!-- §03-5 备件采购/入库/出库/消耗 + 库存低于阈值触发缺货预警 -->
          <PanelBox title="备件库存台账" subtitle="SPARE PARTS">
            <table class="equipment__parts">
              <thead>
                <tr>
                  <th>备件</th>
                  <th class="is-num">入库</th>
                  <th class="is-num">出库</th>
                  <th class="is-num">库存</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in spareParts"
                  :key="p.code"
                  class="equipment__part"
                  :data-code="p.code"
                  :data-low="isLow(p)"
                >
                  <td>
                    <span class="equipment__part-name">{{ p.name }}</span>
                    <span class="equipment__part-meta">{{ p.code }} · {{ p.device }}</span>
                  </td>
                  <td class="is-num">{{ p.inbound }}</td>
                  <td class="is-num">{{ p.outbound }}</td>
                  <td class="is-num is-stock">{{ p.stock }} {{ p.unit }}</td>
                  <td>
                    <!-- 「低于阈值」是现算的（stock < minStock），数据里不存标志位 -->
                    <span v-if="isLow(p)" class="equipment__part-warn">缺货预警</span>
                    <span v-else class="equipment__part-ok">正常</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </PanelBox>
        </div>

        <!-- 底部：周内气泡矩阵（占两列）+ 告警提醒 + 维保工单 -->
        <div class="equipment__row equipment__row--bottom">
          <PanelBox
            class="equipment__bubble"
            title="设备状态周内数据图（最高值）"
            subtitle="WEEKLY PEAK"
          >
            <EchartBox :option="bubbleOption" height="100%" />
          </PanelBox>

          <PanelBox title="设备告警提醒" subtitle="ALERTS">
            <ul class="equipment__alerts">
              <li v-for="a in deviceAlerts" :key="`${a.device}-${a.time}`" class="equipment__alert">
                <span class="equipment__alert-device">{{ a.device }}</span>
                <span class="equipment__alert-type">{{ a.type }}</span>
                <span class="equipment__alert-time">{{ a.time }}</span>
                <StatusTag :status="ALERT_STATUS[a.level]" :text="a.level" />
              </li>
            </ul>
          </PanelBox>

          <!-- §03-4 按运行时长与状态自动生成的维护计划 + 到期推送的工单 -->
          <PanelBox title="维保工单" subtitle="MAINTENANCE ORDERS">
            <ul class="equipment__orders">
              <li
                v-for="o in maintenanceOrders"
                :key="o.id"
                class="equipment__order"
                :data-status="o.status"
              >
                <div class="equipment__order-head">
                  <span class="equipment__order-device">{{ o.device }}</span>
                  <StatusTag :status="o.status === '已推送' ? 'doing' : 'info'" :text="o.status" />
                </div>
                <div class="equipment__order-plan">{{ o.plan }}</div>
                <div class="equipment__order-meta">
                  <span>{{ o.id }} · 到期 {{ o.due }}</span>
                  <span>{{ o.owner }}</span>
                </div>
                <!-- 生成依据：docx 说「根据运行时长与状态自动生成」，只写「维保到期」等于丢掉了这句话 -->
                <div class="equipment__order-basis">依据：{{ o.basis }}</div>
              </li>
            </ul>
          </PanelBox>
        </div>
      </div>

      <!--
        设备档案浮层。
        ⚠️ 挂在 `.equipment__main`（内容区）而不是 `.equipment`（页面根）：
        页面根是 flex column，含 84px 的 AppHeader，浮层的包含块会变成 1080 高、
        把标题栏一起盖住。详见 AppModal.vue 头部注释。
      -->
      <AppModal
        v-model="archiveOpen"
        :title="`${activeArchive?.name ?? '设备'} 设备档案`"
        subtitle="DEVICE ARCHIVE"
        :width="1100"
        :height="760"
      >
        <div v-if="activeArchive" class="equipment__archive">
          <!-- 左：一机一码 + 档案字段（docx 四件套里的「设备档案」） -->
          <section class="equipment__archive-id">
            <div class="equipment__qr" :data-code="activeArchive.code" :title="activeArchive.code">
              <!-- 占位图形，不是真二维码：真码需要后端按设备编码生成，前端不自己编一套 -->
              <span v-for="(on, i) in qrCells" :key="i" :class="{ 'is-on': on }" />
            </div>
            <div class="equipment__archive-code">{{ activeArchive.code }}</div>
            <dl class="equipment__archive-fields">
              <div><dt>规格型号</dt><dd>{{ activeArchive.model }}</dd></div>
              <div><dt>设备类别</dt><dd>{{ activeArchive.category }}</dd></div>
              <div><dt>安装位置</dt><dd>{{ activeArchive.location }}</dd></div>
              <div><dt>投运日期</dt><dd>{{ activeArchive.commissioned }}</dd></div>
              <div><dt>诊断评分</dt><dd>{{ activeScore ?? '—' }} 分</dd></div>
            </dl>
          </section>

          <!-- 右：图纸 / 备件清单 / 维保记录 三个页签 -->
          <section class="equipment__archive-main">
            <div class="equipment__tabs">
              <button
                v-for="t in ARCHIVE_TABS"
                :key="t.key"
                class="equipment__tab"
                :class="{ 'is-active': archiveTab === t.key }"
                type="button"
                @click="archiveTab = t.key"
              >
                {{ t.label }}
              </button>
            </div>

            <div class="equipment__pane" :data-tab="archiveTab">
              <ul v-if="archiveTab === 'drawings'" class="equipment__docs">
                <li v-for="d in activeArchive.drawings" :key="d" class="equipment__doc">
                  <span class="equipment__doc-icon">图</span>
                  <span class="equipment__doc-name">{{ d }}</span>
                </li>
              </ul>

              <table v-else-if="archiveTab === 'parts'" class="equipment__archive-parts">
                <thead>
                  <tr>
                    <th>备件编码</th>
                    <th>名称</th>
                    <th>单机用量</th>
                    <th>当前库存</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="p in activeArchive.parts"
                    :key="p.code"
                    :data-code="p.code"
                    :data-low="partLow(p.code)"
                  >
                    <td>{{ p.code }}</td>
                    <td>{{ p.name }}</td>
                    <td>{{ p.qty }}</td>
                    <td>
                      <!-- 库存取自备件台账，不在这里另存一份：两处各存一个数迟早对不上 -->
                      {{ stockOf(p.code) }}
                    </td>
                  </tr>
                </tbody>
              </table>

              <ul v-else class="equipment__records">
                <li v-for="r in activeArchive.records" :key="r.date + r.item" class="equipment__record">
                  <span class="equipment__record-date">{{ r.date }}</span>
                  <span class="equipment__record-item">{{ r.item }}</span>
                  <span class="equipment__record-crew">{{ r.crew }}</span>
                </li>
              </ul>
            </div>
          </section>

          <!-- 下：IoT 四参数 + 三级阈值 + 故障诱因 + 维修建议 -->
          <section class="equipment__archive-bottom">
            <div class="equipment__iot">
              <div class="equipment__iot-title">运行参数（IoT 实时采集）</div>
              <div class="equipment__iot-grid">
                <div
                  v-for="p in iotBars"
                  :key="p.key"
                  class="equipment__iot-item"
                  :data-param="p.key"
                  :data-level="p.level"
                >
                  <span class="equipment__iot-key">{{ p.key }}</span>
                  <span class="equipment__iot-value">
                    {{ p.value }}<em>{{ p.unit }}</em>
                  </span>
                  <span class="equipment__iot-flag">{{ IOT_TEXT[p.level] }}</span>
                  <!-- 三级阈值条：正常 / 预警 / 报警，游标落在当前值上 -->
                  <div class="equipment__thr">
                    <span class="equipment__thr-zone is-normal" :style="{ width: p.normalW }" />
                    <span
                      class="equipment__thr-zone is-warn"
                      :style="{ left: p.normalW, width: p.warnW }"
                    />
                    <span class="equipment__thr-zone is-alarm" :style="{ left: p.alarmLeft }" />
                    <span class="equipment__thr-mark" :style="{ left: p.markLeft }" />
                  </div>
                </div>
              </div>
            </div>

            <div class="equipment__causes">
              <div class="equipment__iot-title">历史故障诱因排序</div>
              <ol class="equipment__cause-list">
                <li v-for="(c, i) in activeArchive.causes" :key="c.cause" class="equipment__cause">
                  <span class="equipment__cause-no">{{ i + 1 }}</span>
                  <span class="equipment__cause-name">{{ c.cause }}</span>
                  <span class="equipment__cause-part">{{ c.part }}</span>
                  <span class="equipment__cause-count">{{ c.count }} 次</span>
                </li>
              </ol>
            </div>

            <div class="equipment__advice">
              <div class="equipment__iot-title">维修方案建议</div>
              <ol class="equipment__advice-list">
                <li v-for="a in activeArchive.advice" :key="a" class="equipment__advice-item">
                  {{ a }}
                </li>
              </ol>
            </div>
          </section>
        </div>
      </AppModal>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import type { EChartsOption, LineSeriesOption } from 'echarts'
import AppHeader from '@/components/AppHeader.vue'
import AppModal from '@/components/AppModal.vue'
import PanelBox from '@/components/PanelBox.vue'
import EchartBox from '@/components/EchartBox.vue'
import MetricCard from '@/components/MetricCard.vue'
import StatusTag from '@/components/StatusTag.vue'
import { areaGradient, CHART_COLORS } from '@/utils/chartTheme'
import { tableCellStyle, tableHeaderStyle } from '@/utils/tableTheme'
import { useAsyncData, useAutoRefresh } from '@/hooks/useAsyncData'
import { useRealtime } from '@/hooks/useRealtime'
import * as equipmentApi from '@/api/equipment'
import type {
  DeviceAlert,
  DeviceArchive,
  DeviceScore,
  EquipmentMetric,
  IotParam,
  MaintenanceOrder,
  SparePart
} from '@/api/equipment'
import { realtime, TOPICS } from '@/api/ws'

/** 告警列表上限：大屏长期挂着，不设上限这个数组会一直涨 */
const ALERT_LIMIT = 8

/**
 * 数据来源统一走 API 层。
 *
 * 后端未就绪时 requestWithFallback 会自动返回内置的 mock 数据，
 * 页面不需要关心当前用的是哪一份，接口就绪后也无需改动这里。
 * 初始值给字段齐全的空结构，加载完成前模板照常渲染，不会出现 undefined。
 */
const { data: equipmentMetrics } = useAsyncData(
  equipmentApi.fetchEquipmentMetrics,
  [] as EquipmentMetric[]
)
const { data: deviceScores } = useAsyncData(equipmentApi.fetchDeviceScores, [] as DeviceScore[])
const { data: deviceTrend } = useAsyncData(equipmentApi.fetchDeviceTrend, {
  hours: [] as string[],
  series: [] as { name: string; data: number[] }[]
})
const { data: deviceWeights } = useAsyncData(equipmentApi.fetchDeviceWeights, [] as {
  name: string
  value: number
}[])
const { data: weeklyBubble } = useAsyncData(equipmentApi.fetchWeeklyBubble, {
  days: [] as string[],
  hours: [] as string[],
  data: [] as [number, number, number][]
})
const { data: loadedAlerts, refresh: refreshAlerts } = useAsyncData(
  equipmentApi.fetchDeviceAlerts,
  [] as DeviceAlert[]
)

// ---------- §03-4 维保工单 / §03-5 备件库存台账 / §03-1~3 设备档案 ----------
const { data: maintenanceOrders } = useAsyncData(
  equipmentApi.fetchMaintenanceOrders,
  [] as MaintenanceOrder[]
)
const { data: spareParts } = useAsyncData(equipmentApi.fetchSpareParts, [] as SparePart[])
const { data: deviceArchives } = useAsyncData(
  equipmentApi.fetchDeviceArchives,
  [] as DeviceArchive[]
)

/**
 * 备件库存是否低于阈值 —— **页面现算，数据里不存标志位**。
 *
 * 存了就会出现「改了出库数忘了改标志位」这种对不上的状态，而且两种说法
 * 同时存在于屏幕上时，没人知道该信哪个。库存这一个数字说了算。
 */
function isLow(p: SparePart): boolean {
  return p.stock < p.minStock
}

/**
 * 实时推送来的告警，与接口拉的列表**分开存**。
 *
 * 不直接往 loadedAlerts 里插，是因为那样有个隐蔽的丢数据窗口：
 * 首次加载还没回来时来了一条推送，先插进去了，随后接口返回把整个数组覆盖掉，
 * 这条就没了——而且不报错，只是少一条。真后端 + 慢网络下这一定会发生。
 * 分成两个 ref 再用 computed 拼，接口怎么覆盖都冲不掉推送。
 */
const pushedAlerts = shallowRef<DeviceAlert[]>([])

const deviceAlerts = computed(() =>
  [...pushedAlerts.value, ...loadedAlerts.value].slice(0, ALERT_LIMIT)
)

// ---------- 设备告警：实时推送 + 轮询兜底 ----------
/**
 * 这一页是实时通道的接入样例，两种数据获取方式配合使用：
 *
 * - **推送为主**：IoT 传感器异常时由服务端主动下发（指导文档 13.6），
 *   新告警插到列表最前面。这是唯一能让大屏「自己动起来」的来源。
 * - **轮询兜底**：实时通道没建立时（后端未就绪、断线重连中）定时全量拉一次。
 *   两者不会打架——推送在册期间不轮询，轮询时通道本就是断的。
 */
useRealtime<DeviceAlert>(
  (handler) => realtime.subscribe(TOPICS.deviceStatus, handler),
  (alert) => {
    // 服务端推下来的东西不能全信：字段缺失就丢掉，别让它把列表渲染成空白行
    if (!alert?.device || !alert?.type) return

    // 去重：断线重连后服务端可能补推，同一条不该出现两次；
    // 也要跟接口拉来的列表比一次，避免同一条告警既有推送又出现在全量里
    const key = `${alert.device}|${alert.time}`
    const seen = [...pushedAlerts.value, ...loadedAlerts.value].some(
      (item) => `${item.device}|${item.time}` === key
    )
    if (seen) return

    // shallowRef 下必须整体替换才会触发更新
    pushedAlerts.value = [alert, ...pushedAlerts.value]
  }
)

useAutoRefresh(30000, () => {
  if (!realtime.connected) void refreshAlerts()
})

// ---------- 告警等级 → 状态标签语义 ----------
const ALERT_STATUS: Record<string, 'alarm' | 'doing' | 'info'> = {
  高: 'alarm',
  中: 'doing',
  低: 'info'
}

// ---------- 单体设备评分表 ----------
/** 评分色阶：≥95 绿 / ≥90 青 / 其余黄 */
function scoreLevel(score: number) {
  if (score >= 95) return 'high'
  if (score >= 90) return 'mid'
  return 'low'
}

// ---------- 设备类别状态趋势预判（多折线） ----------
const trendOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  // 这一块从 3 列（≈613px）缩到 4 列（460px）后，三个系列名的 legend 会顶到左边去，
  // 所以把图例压紧（10px 图标、8px 间距、10px 字号），并收进 grid 顶部那 30px 里。
  legend: {
    top: 0,
    right: 0,
    itemWidth: 10,
    itemHeight: 8,
    itemGap: 8,
    textStyle: { fontSize: 10 },
    data: deviceTrend.value.series.map((s) => s.name)
  },
  grid: { top: 30, left: 4, right: 8, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: deviceTrend.value.hours, boundaryGap: false },
  yAxis: { type: 'value' },
  series: deviceTrend.value.series.map(
    (s, i): LineSeriesOption => ({
      name: s.name,
      type: 'line',
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2, color: CHART_COLORS[i] },
      itemStyle: { color: CHART_COLORS[i] },
      data: s.data
    })
  )
}))

// ---------- 设备状态评分（横向条形，柱尾显示数值） ----------
const weightOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  grid: { top: 8, left: 4, right: 8, bottom: 0, containLabel: true },
  // 右侧留白，避免最高分的数值标签被裁掉
  xAxis: { type: 'value', boundaryGap: ['0%', '30%'] },
  yAxis: { type: 'category', data: deviceWeights.value.map((w) => w.name) },
  series: [
    {
      type: 'bar',
      barWidth: 12,
      itemStyle: { borderRadius: [0, 6, 6, 0] },
      label: { show: true, position: 'right', fontSize: 11, color: CHART_COLORS[0] },
      data: deviceWeights.value.map((w, i) => ({
        value: w.value,
        itemStyle: { color: CHART_COLORS[i] }
      }))
    }
  ]
}))

// ---------- 设备状态周内数据图（星期 × 时刻气泡矩阵） ----------
const bubbleOption = computed<EChartsOption>(() => ({
  tooltip: {
    trigger: 'item',
    formatter: (p: any) => {
      const [hi, di, value] = p.value as [number, number, number]
      return `${weeklyBubble.value.days[di]} ${weeklyBubble.value.hours[hi]}<br/>最高值 ${value}`
    }
  },
  grid: { top: 8, left: 4, right: 12, bottom: 0, containLabel: true },
  xAxis: { type: 'category', data: weeklyBubble.value.hours },
  yAxis: { type: 'category', data: weeklyBubble.value.days },
  series: [
    {
      type: 'scatter',
      // 气泡直径随数值线性映射到 6~22px
      symbolSize: (val: any) => 6 + (Number(val[2]) / 100) * 16,
      itemStyle: { color: areaGradient(CHART_COLORS[0], CHART_COLORS[1]), opacity: 0.85 },
      emphasis: {
        scale: 1.3,
        itemStyle: { opacity: 1, shadowBlur: 12, shadowColor: CHART_COLORS[0] }
      },
      data: weeklyBubble.value.data
    }
  ]
}))

// ---------- 设备档案浮层 ----------
/**
 * 打开哪一个设备，由**评分表的行**决定（`@row-click`）。
 *
 * docx 说「一机一码，扫码即可查看设备档案」。大屏上没有扫码枪，
 * 所以把「扫码」换成一个等价的入口：点评分表的那一行。点进去看到的东西
 * 与扫码一致（档案 / 图纸 / 备件清单 / 维保记录），这是能演示又能讲通的形态。
 *
 * 评分表与档案是两份数据，靠 `name` 对上（DeviceScore 没有 code 字段）。
 * 对不上就直接不打开 —— 打开一个空浮层比不打开更像故障。
 */
const activeArchive = ref<DeviceArchive | null>(null)
const archiveOpen = ref(false)

/**
 * 三个页签而不是四个 —— docx 的四件套是「设备档案 / 图纸 / 备件清单 / 维保记录」，
 * 其中「设备档案」就是浮层左侧那一栏（编码、型号、类别、位置、投运日期），
 * 已经在屏幕上了。再做一个同名页签会把同一份信息摆两遍。
 */
const ARCHIVE_TABS = [
  { key: 'drawings', label: '图纸' },
  { key: 'parts', label: '备件清单' },
  { key: 'records', label: '维保记录' }
] as const
type ArchiveTab = (typeof ARCHIVE_TABS)[number]['key']
const archiveTab = ref<ArchiveTab>('drawings')

function openArchive(row: DeviceScore) {
  const hit = deviceArchives.value.find((a) => a.name === row.name)
  if (!hit) return
  activeArchive.value = hit
  archiveTab.value = 'drawings'
  archiveOpen.value = true
}

/** 浮层里显示的诊断评分，直接取评分表那一行，不另存一份 */
const activeScore = computed(
  () => deviceScores.value.find((s) => s.name === activeArchive.value?.name)?.score ?? null
)

/** 备件清单里的库存取自台账，不另存第二份数字 */
function stockOf(code: string): string {
  const hit = spareParts.value.find((p) => p.code === code)
  return hit ? `${hit.stock} ${hit.unit}` : '—'
}

/** 备件清单里同样按台账判缺货，与备件台账的写法共用一条判据 */
function partLow(code: string): boolean {
  const hit = spareParts.value.find((p) => p.code === code)
  return hit ? isLow(hit) : false
}

/**
 * 一机码的图形是**占位图案，不是真二维码**。
 * 真码要后端按设备编码生成（纠错级别、掩码都得按规范来），
 * 前端自己画一个只会得到一个扫不出来的漂亮方块 —— 那样更像骗人。
 * 这里按编码派生出一组确定的格子：同一台设备每次进来图案一样，看着像码，但不冒充能扫。
 */
const qrCells = computed(() => {
  const code = activeArchive.value?.code ?? ''
  let h = 0
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0
  const cells: boolean[] = []
  for (let i = 0; i < 64; i++) {
    h = (h * 1664525 + 1013904223) >>> 0
    cells.push((h >>> 16) % 100 < 45)
  }
  return cells
})

// ---------- §6.2-2 多级报警：正常 / 预警 / 报警 ----------
type IotLevel = 'normal' | 'warn' | 'alarm'
const IOT_TEXT: Record<IotLevel, string> = { normal: '正常', warn: '预警', alarm: '报警' }

function iotLevel(p: IotParam): IotLevel {
  if (p.value >= p.alarm) return 'alarm'
  if (p.value >= p.warn) return 'warn'
  return 'normal'
}

/**
 * 阈值条上的四段位置，**每条参数各用一个尺度**。
 *
 * 分母取 `max(报警线, 当前值) × 1.25`：报警线右边留 20% 余量，
 * 当前值越限时游标也不会跑出条外（越限时游标正好压在比例尺的 80% 处）。
 *
 * 不用四个参数共用一个尺度：温度 62℃、电流 180A、振动 12.4mm/s 单位各不相同，
 * 同一把尺子量出来的长度没有意义，反而让人以为「电流那根最长就是电流最危险」。
 */
const iotBars = computed(() =>
  (activeArchive.value?.iot ?? []).map((p) => {
    const top = Math.max(p.alarm, p.value) * 1.25
    const at = (v: number) => `${(v / top) * 100}%`
    return {
      key: p.key,
      value: p.value,
      unit: p.unit,
      level: iotLevel(p),
      normalW: at(p.warn),
      warnW: at(p.alarm - p.warn),
      alarmLeft: at(p.alarm),
      markLeft: at(p.value)
    }
  })
)
</script>

<style lang="scss" scoped>
// 本页是纯数据页，没有三维场景；position: relative 保留给指标卡的切角装饰定位
.equipment {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  // 设备档案浮层的内容一旦超出 996，会越过内容区糊住 84px 的标题栏
  // （$z-modal 40 > $z-header 20），而 html/body 的 overflow:hidden 又会把它
  // 裁在 1080 边界上 —— 两种表现都不报错，看起来只是「浮层被切了」。
  // 这里裁一刀，让它老老实实待在内容区里。与 .decision 对齐。
  overflow: hidden;
}

.equipment__main {
  display: flex;
  flex-direction: column;
  width: 100%;
  flex: 1;
  min-height: 0;
}

// 面板层：场景已移除，作为普通子元素吃满标题栏以下的剩余高度
.equipment__content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: $panel-gap;
  padding: $panel-gap;
}

.equipment__metrics {
  flex-shrink: 0;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: $panel-gap;
}

// 两行共用一套 4 轨列网格（每列 460px）：上下两行的竖缝必须对齐，
// 错开一格在大屏上非常显眼。气泡图那一块跨两列补回宽度。
.equipment__row {
  display: grid;
  gap: $panel-gap;
  min-height: 0;

  &--mid {
    flex: 1.15;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  &--bottom {
    flex: 1;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.equipment__bubble {
  grid-column: span 2;
}

// ---------- 单体设备评分表 ----------
// 表格的深色适配统一由全局 .data-table 与 utils/tableTheme 提供，此处不再重写
.equipment__score {
  @include numeric;
  font-weight: 700;

  &.is-high {
    color: $green;
    @include glow-text($green, 6px);
  }
  &.is-mid {
    color: $primary;
  }
  &.is-low {
    color: $yellow;
  }
}

.equipment__time {
  @include numeric;
  color: $text-muted;
}

// ---------- 设备告警提醒 ----------
.equipment__alerts {
  height: 100%;
  overflow-y: auto;
  @include thin-scrollbar;
}

.equipment__alert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 2px;
  font-size: $fs-small;

  & + & {
    border-top: 1px solid $border-soft;
  }
}

.equipment__alert-device {
  flex-shrink: 0;
  font-weight: 600;
  color: $text-primary;
}

.equipment__alert-type {
  flex: 1;
  min-width: 0;
  color: $text-secondary;
  @include ellipsis;
}

.equipment__alert-time {
  flex-shrink: 0;
  @include numeric;
  font-size: $fs-small - 1px;
  color: $text-muted;
}

// =============================================================================
// §03-5 备件库存台账
// =============================================================================
.equipment__parts {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  @include thin-scrollbar;
  font-size: $fs-small;

  // 表头吸顶：台账要能滚动，滚下去看不见列名就得靠猜
  thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 4px 6px;
    font-weight: 400;
    color: $text-muted;
    text-align: left;
    white-space: nowrap;
    background: $bg-panel-solid;
    border-bottom: 1px solid $border-grid;
  }

  tbody td {
    padding: 5px 6px;
    color: $text-body;
    border-bottom: 1px solid $border-soft;
    vertical-align: middle;
  }

  .is-num {
    @include numeric;
    text-align: right;
  }
}

.equipment__part-name {
  display: block;
  color: $text-primary;
}

.equipment__part-meta {
  display: block;
  font-size: $fs-small - 2px;
  color: $text-muted;
  @include ellipsis;
}

.equipment__part .is-stock {
  color: $primary;
  font-weight: 700;
}

// 缺货预警：整行提色，扫一眼就能找到是哪两条
.equipment__part[data-low='true'] {
  background: rgba($red, 0.07);

  .is-stock {
    color: $red;
  }
}

.equipment__part-warn {
  display: inline-block;
  padding: 1px 6px;
  font-size: $fs-small - 2px;
  color: $red;
  white-space: nowrap;
  background: rgba($red, 0.12);
  border: 1px solid rgba($red, 0.45);
  border-radius: $radius-sm;
}

.equipment__part-ok {
  font-size: $fs-small - 2px;
  color: $text-muted;
}

// =============================================================================
// §03-4 维保工单
// =============================================================================
// 6 张工单 × 4 行 ≈ 420px，装不进 341px 的正文区 ⇒ 让它自己滚。
// 不砍「依据」那一行：docx 说的就是「根据运行时长与状态自动生成」，
// 去掉依据就只剩一句「该保养了」，看不出是算出来的还是随手抄的。
.equipment__orders {
  height: 100%;
  overflow-y: auto;
  @include thin-scrollbar;
  font-size: $fs-small;
}

.equipment__order {
  padding: 6px 2px;

  & + & {
    border-top: 1px solid $border-soft;
  }
}

.equipment__order-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.equipment__order-device {
  font-weight: 600;
  color: $text-primary;
}

.equipment__order-plan {
  margin-top: 2px;
  color: $text-body;
  @include ellipsis;
}

.equipment__order-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
  font-size: $fs-small - 2px;
  color: $text-muted;

  span {
    @include ellipsis;
  }
}

.equipment__order-basis {
  margin-top: 3px;
  padding-left: 6px;
  font-size: $fs-small - 2px;
  line-height: 15px;
  color: $text-secondary;
  border-left: 2px solid $border-soft;
}

// =============================================================================
// 设备档案浮层
// =============================================================================
// 左栏 292px 放「一机一码 + 档案字段」，右栏放三个页签，
// 底下横贯一条「运行参数 / 故障诱因 / 维修建议」。
// 尺寸：正文区 ≈1066×694（1100×760 减去标题栏与内边距）⇒ 上排 316 + 间距 12 + 下排 366
.equipment__archive {
  display: grid;
  grid-template-columns: 292px minmax(0, 1fr);
  grid-template-rows: 316px auto;
  grid-template-areas:
    'id main'
    'bottom bottom';
  gap: 12px;
  min-height: 100%;
}

// 浮层里的小节统一长相：软底 + 细边，与面板区分开又不抢眼
.equipment__archive-id,
.equipment__archive-main,
.equipment__iot,
.equipment__causes,
.equipment__advice {
  box-sizing: border-box;
  padding: 10px 12px;
  background: $bg-panel-soft;
  border: 1px solid $border-soft;
  border-radius: $radius-md;
}

// ---------- 左：一机一码 ----------
.equipment__archive-id {
  grid-area: id;
  display: flex;
  flex-direction: column;
  align-items: center;
}

// 占位图形，不是真二维码（见 .vue 内 qrCells 的说明）
.equipment__qr {
  display: grid;
  flex-shrink: 0;
  grid-template-columns: repeat(8, 1fr);
  gap: 1px;
  width: 104px;
  height: 104px;
  padding: 6px;
  background: rgba($primary, 0.04);
  border: 1px solid $border-panel;
  border-radius: $radius-sm;

  span {
    background: transparent;
    border-radius: 1px;

    &.is-on {
      background: $primary;
      box-shadow: 0 0 3px rgba($primary, 0.6);
    }
  }
}

.equipment__archive-code {
  margin-top: 8px;
  font-size: $fs-small + 1px;
  color: $primary;
  @include numeric;
  @include glow-text($primary, 6px);
}

.equipment__archive-fields {
  width: 100%;
  margin-top: 10px;
  font-size: $fs-small;

  > div {
    display: flex;
    gap: 8px;
    padding: 4px 0;
    border-bottom: 1px dashed $border-soft;

    &:last-child {
      border-bottom: none;
    }
  }

  dt {
    flex-shrink: 0;
    width: 60px;
    color: $text-muted;
  }

  dd {
    flex: 1;
    min-width: 0;
    color: $text-body;
    @include ellipsis;
  }
}

// ---------- 右：图纸 / 备件清单 / 维保记录 ----------
.equipment__archive-main {
  grid-area: main;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.equipment__tabs {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
  padding-bottom: 8px;
  border-bottom: 1px solid $border-soft;
}

.equipment__tab {
  padding: 4px 14px;
  font-size: $fs-small;
  color: $text-secondary;
  background: transparent;
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;

  &:hover {
    color: $primary;
    background: $bg-hover;
  }

  &.is-active {
    color: $text-primary;
    background: rgba($primary, 0.14);
    border-color: $border-panel;
    @include glow-text($primary, 4px);
  }
}

.equipment__pane {
  flex: 1;
  min-height: 0;
  margin-top: 8px;
  overflow-y: auto;
  @include thin-scrollbar;
  font-size: $fs-small;
}

.equipment__docs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.equipment__doc {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: rgba($primary, 0.05);
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
}

.equipment__doc-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  font-size: $fs-small - 2px;
  line-height: 20px;
  color: $primary;
  text-align: center;
  background: rgba($primary, 0.12);
  border-radius: $radius-sm;
}

.equipment__doc-name {
  min-width: 0;
  color: $text-body;
  @include ellipsis;
}

.equipment__archive-parts {
  width: 100%;

  th {
    padding: 5px 8px;
    font-weight: 400;
    color: $text-muted;
    text-align: left;
    border-bottom: 1px solid $border-grid;
  }

  td {
    padding: 6px 8px;
    color: $text-body;
    border-bottom: 1px solid $border-soft;
  }

  td:last-child {
    color: $primary;
    text-align: right;
    @include numeric;
  }

  // 库存少的那一档直接标红：备件清单的作用就是「要备哪个」
  tr[data-low='true'] td:last-child {
    color: $red;
  }
}

.equipment__record {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 2px;

  & + & {
    border-top: 1px solid $border-soft;
  }
}

.equipment__record-date {
  flex-shrink: 0;
  color: $primary;
  @include numeric;
}

.equipment__record-item {
  flex: 1;
  min-width: 0;
  color: $text-body;
  @include ellipsis;
}

.equipment__record-crew {
  flex-shrink: 0;
  color: $text-muted;
}

// ---------- 下：参数 / 诱因 / 建议 ----------
.equipment__archive-bottom {
  grid-area: bottom;
  display: grid;
  grid-template-columns: 1.25fr 1fr 1.15fr;
  gap: 12px;
  min-height: 360px;
}

.equipment__iot-title {
  margin-bottom: 8px;
  font-size: $fs-small;
  color: $text-primary;
  @include glow-text($primary, 4px);
}

.equipment__iot-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 16px;
}

.equipment__iot-item {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: 2px 8px;

  // 阈值条横跨两列
  .equipment__thr {
    grid-column: 1 / -1;
  }
}

.equipment__iot-key {
  font-size: $fs-small;
  color: $text-secondary;
}

.equipment__iot-value {
  @include numeric;
  font-size: $fs-body + 4px;
  font-weight: 700;
  color: $text-primary;

  em {
    margin-left: 2px;
    font-size: $fs-small - 1px;
    font-style: normal;
    color: $text-muted;
  }
}

.equipment__iot-flag {
  grid-column: 2;
  grid-row: 1;
  justify-self: end;
  font-size: $fs-small - 2px;
  color: $text-muted;
}

// §6.2-2 多级报警：越限就换色，别让人自己对着数字比阈值
.equipment__iot-item[data-level='warn'] {
  .equipment__iot-value {
    color: $yellow;
  }
  .equipment__iot-flag {
    color: $yellow;
  }
}

.equipment__iot-item[data-level='alarm'] {
  .equipment__iot-value {
    color: $red;
    @include glow-text($red, 6px);
  }
  .equipment__iot-flag {
    color: $red;
  }
}

// 三级阈值条：正常段 / 预警段 / 报警段 + 当前值游标
.equipment__thr {
  position: relative;
  height: 6px;
  margin-top: 6px;
  background: rgba($text-muted, 0.18);
  border-radius: 3px;
}

.equipment__thr-zone {
  position: absolute;
  top: 0;
  bottom: 0;

  &.is-normal {
    left: 0;
    background: rgba($green, 0.5);
    border-radius: 3px 0 0 3px;
  }

  &.is-warn {
    background: rgba($yellow, 0.45);
  }

  &.is-alarm {
    right: 0;
    background: rgba($red, 0.4);
    border-radius: 0 3px 3px 0;
  }
}

.equipment__thr-mark {
  position: absolute;
  top: -3px;
  width: 2px;
  height: 12px;
  background: $text-primary;
  border-radius: 1px;
  box-shadow: 0 0 4px rgba($text-primary, 0.8);
  transform: translateX(-1px);
}

.equipment__cause {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 2px;
  font-size: $fs-small;

  & + & {
    border-top: 1px solid $border-soft;
  }
}

.equipment__cause-no {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  font-size: $fs-small - 2px;
  line-height: 16px;
  color: $primary;
  text-align: center;
  background: rgba($primary, 0.12);
  border-radius: $radius-sm;
}

.equipment__cause-name {
  flex-shrink: 0;
  color: $text-primary;
}

.equipment__cause-part {
  flex: 1;
  min-width: 0;
  color: $text-muted;
  @include ellipsis;
}

.equipment__cause-count {
  flex-shrink: 0;
  color: $orange;
  @include numeric;
}

.equipment__advice-item {
  position: relative;
  padding: 6px 0 6px 14px;
  font-size: $fs-small;
  line-height: 18px;
  color: $text-body;

  &::before {
    content: '';
    position: absolute;
    top: 12px;
    left: 2px;
    width: 5px;
    height: 5px;
    background: $primary;
    border-radius: 50%;
    box-shadow: 0 0 4px rgba($primary, 0.8);
  }
}
</style>
