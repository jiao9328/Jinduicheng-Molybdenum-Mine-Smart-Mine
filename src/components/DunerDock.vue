<template>
  <!--
    墩儿的悬浮按钮与对话框。

    ## 形态

    参考 `D:\Zibo-SmartTransportation-WebGIS-main3` 的 AI 助手：
    **右下角一个按钮，点开在它上方展开贴边对话框**（不是模态框、没有遮罩、
    打开时按钮仍在且变激活态、气泡分人机两侧、底部快捷问句点了只回填不发送）。
    配色不走它那套浅色 —— 本项目是深色大屏，一律用 `styles/variables.scss` 的 token。

    ## 位置：右下角，但**躲开右栏**

    这里原来是一条底部居中的 640px 命令栏，2026-09-17 按用户要求改成右下角按钮。
    改之前量过九个页面（见 `src/duner/corner.ts` 的实测表）：右下角在六页上
    压着东西，其中数字孪生页压的是**最右一个页签**。
    所以按钮的 `right` 是**当场量出来的**（`--duner-right`），不写死 —— 理由与清单
    都在 `corner.ts` 里，那一条是本组件最容易悄悄退化的地方。
  -->
  <div
    ref="rootRef"
    class="duner"
    :class="{ 'is-open': open }"
    :style="{ '--duner-right': `${inset}px` }"
    data-duner-dock
  >
    <!-- 对话框：向上展开（向下会飞出屏幕） -->
    <transition name="duner-rise">
      <section v-if="open" class="duner__panel" aria-label="墩儿 · 自然语言指挥">
        <header class="duner__head">
          <span class="duner__logo">AI</span>
          <span class="duner__head-info">
            <span class="duner__title">墩儿 · 自然语言指挥</span>
            <span class="duner__sub">{{ sceneHint }}</span>
          </span>
          <button class="duner__link" type="button" @click="loadCapabilities">能干什么</button>
          <button class="duner__link" type="button" @click="clear">清空</button>
          <button class="duner__close" type="button" title="收起对话" @click="open = false">✕</button>
        </header>

        <div ref="listRef" class="duner__list">
          <p v-if="!messages.length" class="duner__empty">
            说一句话试试：「带我去北帮3号台阶」「打开边坡监测图层」「今天生产情况怎么样」
          </p>

          <div v-for="(m, i) in messages" :key="i" class="duner__msg" :class="`is-${m.role}`">
            <p class="duner__text">{{ m.text }}</p>

            <!-- 数据卡片：后端算好的，页面只负责摆出来 -->
            <div v-for="(c, ci) in m.cards ?? []" :key="ci" class="duner__card">
              <p class="duner__card-title">{{ c.title }}</p>
              <template v-for="(sec, si) in c.sections ?? []" :key="`s${si}`">
                <p class="duner__card-title duner__card-title--sub">{{ sec.title }}</p>
                <dl class="duner__rows">
                  <template v-for="(row, ri) in sec.rows ?? []" :key="ri">
                    <dt>{{ row[0] }}</dt>
                    <dd>{{ row[1] }}</dd>
                  </template>
                </dl>
              </template>
              <dl v-if="c.rows?.length" class="duner__rows">
                <template v-for="(row, ri) in c.rows" :key="ri">
                  <dt>{{ row[0] }}</dt>
                  <dd>{{ row[1] }}</dd>
                </template>
              </dl>
            </div>

            <!-- 确认卡片：未经确认绝不执行，这是全链路唯一的一道人工闸 -->
            <div v-if="m.confirm" class="duner__confirm" :class="{ 'is-dead': m.confirm.dead }">
              <p class="duner__card-title">{{ m.confirm.card?.title ?? '待确认' }}</p>
              <dl v-if="m.confirm.card?.rows?.length" class="duner__rows">
                <template v-for="(row, ri) in m.confirm.card.rows" :key="ri">
                  <dt>{{ row[0] }}</dt>
                  <dd>{{ row[1] }}</dd>
                </template>
              </dl>
              <div class="duner__confirm-foot">
                <span class="duner__ttl">{{ m.confirm.dead ? '已取消' : `${leftOf(m)}s 内有效` }}</span>
                <button
                  class="duner__btn is-primary"
                  type="button"
                  :disabled="m.confirm.dead || m.confirm.busy"
                  @click="doConfirm(m)"
                >
                  {{ m.confirm.busy ? '执行中…' : '确认执行' }}
                </button>
                <button
                  class="duner__btn"
                  type="button"
                  :disabled="m.confirm.dead || m.confirm.busy"
                  @click="m.confirm.dead = true"
                >
                  取消
                </button>
              </div>
            </div>

            <!-- 澄清选项：每一项都能被原样读懂，点一下等于把这句话再说一遍 -->
            <div v-if="m.clarify && !m.answered" class="duner__chips">
              <button
                v-for="(opt, oi) in m.clarify.options"
                :key="oi"
                class="duner__chip"
                type="button"
                :disabled="busy"
                @click="onClarify(m, opt)"
              >
                {{ opt }}
              </button>
            </div>

            <p v-if="m.meta" class="duner__meta">{{ m.meta }}</p>
          </div>

          <!-- 「正在想」三点。**故意不带 .duner__msg** ——
               检查脚本按 .duner__msg 的条数判断"回话到了没有"，
               多一个同类的空壳会让它数错一条 -->
          <div v-if="busy" class="duner__thinking" aria-label="正在处理">
            <i></i><i></i><i></i>
          </div>
        </div>

        <div v-if="!busy" class="duner__chips duner__chips--quick">
          <span class="duner__chips-tip">你可以说：</span>
          <button
            v-for="c in CHIPS"
            :key="c"
            class="duner__chip"
            type="button"
            @click="fillChip(c)"
          >
            {{ c }}
          </button>
        </div>

        <div class="duner__input-row">
          <input
            ref="inputRef"
            v-model="draft"
            class="duner__input"
            type="text"
            :placeholder="placeholder"
            :disabled="busy"
            @keyup.enter="onSubmit"
          />
          <button class="duner__send" type="button" :disabled="busy || !draft.trim()" @click="onSubmit">
            {{ busy ? '…' : '发送' }}
          </button>
        </div>
      </section>
    </transition>

    <!-- 悬浮按钮：开着的时候它也是关的入口（与参考一致） -->
    <button
      class="duner__fab"
      :class="{ 'is-on': open }"
      type="button"
      :title="open ? '收起墩儿' : '叫墩儿出来'"
      @click="toggle"
    >
      <span v-if="!open" class="duner__pulse" aria-hidden="true"></span>
      <span class="duner__fab-logo">AI</span>
      <span class="duner__fab-label">墩儿</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { HttpError } from '@/api/http'
import { dunerCapabilities, dunerChat, dunerConfirm, type DunerCard, type DunerClarify, type DunerConfirm } from '@/api/duner'
import { executeCommands } from '@/duner/bridge'
import { sceneStatus } from '@/duner/scene'
import { FAB_RIGHT, measureCorner } from '@/duner/corner'

/**
 * 一条消息。`role` 三档：用户说的、墩儿回的、以及**执行结果那一行**（note）。
 *
 * 第三档必须单独存在：答复里那句「已定位到北帮3号台阶」是在前端执行**之前**
 * 就拼好的（后端不知道前端能不能做到，见 `service.mjs` 的 `composeReply`），
 * 所以执行失败时得再补一句更正。两者混在一条里，用户看到的就是自相矛盾的一段话。
 */
interface Msg {
  role: 'user' | 'bot' | 'note'
  text: string
  cards?: DunerCard[]
  clarify?: DunerClarify
  confirm?: (DunerConfirm & { busy?: boolean; dead?: boolean; at?: number }) | null
  /** 点过澄清选项之后把按钮撤掉，避免用户以为还能再点 */
  answered?: boolean
  meta?: string
}

/**
 * 快捷问句。**点了只回填到输入框，不直接发**（与参考一致）——
 * 直接发等于替用户按了回车，他还想改两个字就没机会了。
 * 四句各覆盖一类能力：导航、图层、查数据、点名问某个监测点。
 */
const CHIPS = ['带我去北帮3号台阶', '打开边坡监测图层', '今天生产情况怎么样', 'SL-01现在位移多少']

const route = useRoute()

const open = ref(false)
const busy = ref(false)
const draft = ref('')
const messages = ref<Msg[]>([])
const listRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

/** 按钮右偏移（设计像素）。默认 16，撞上右栏时由 `corner.ts` 量出来改大 */
const inset = ref(FAB_RIGHT)

/** 后端是否已经明确告诉我们"没就绪"。说一次就够，之后输入框的提示换成它 */
const backendDown = ref(false)

const placeholder = computed(() =>
  backendDown.value ? '墩儿后端未就绪（npm run serve）' : '说一句话，例如「带我去尾矿库」'
)

/** 标题栏第二行：当前页面有没有可操作的三维场景 */
const sceneHint = computed(() => {
  const s = sceneStatus()
  if (!s.scene) return '本页无三维场景'
  return s.layers ? '三维 + 图层可控' : '三维可控'
})

/** 确认卡片的倒计时。用 `at` 记下发的时刻按真实时间算，不靠定时器累加 */
const now = ref(Date.now())
const ticker = window.setInterval(() => {
  now.value = Date.now()
}, 1000)
onBeforeUnmount(() => window.clearInterval(ticker))

// ---- 落位：量一次不够，页面是异步长出来的 -------------------------------
//
// 九个页面里六页的右下角压着内容，按钮要往左让（为什么见 corner.ts）。
// 但**页面不是挂载那一刻就长齐的**：面板要等接口回来、页签要等三维就绪。
// 所以盯 DOM 变化重量，而不是量一次就完。
//
// 让位怎么触发：**先当场同步量一次，再定时补量一次**。
//
// ⚠️ 同步那一次是关键，不是"顺手"。MutationObserver 的回调是**微任务**，
// 当前任务一结束就跑，不受帧率连累；而定时器/`requestAnimationFrame` 在这台
// 机器上会被软渲拖后几秒。原来只有 `setTimeout(80)` 一条路，实测漏过：
// 先走一遍数字孪生（那页量到 428）再进决策指挥，**4 秒后**读到的还是上一页的
// 428 —— 此时新页那排底部面板早就位了，按钮右边缘正好压住最右那块 5px，
// 探针如实报成"规则该躲而没躲"。让位值跟着上一页走的这段时间里，
// 按钮就浮在新页面上压着东西，越长越像"本来就该在那儿"。
// （`requestAnimationFrame` 更不行：软渲下一帧要 2~3 秒，回调被拖到几秒后。）
//
// 补量那一次是给 **CSS 过渡**兜底的：过渡不产生 DOM 变更，滑入途中量到的是
// 中间态，只能等几百毫秒后再量一遍。两次合并成一次，多的丢掉不排队。
const 让位补量 = 400
let 排队中 = 0
function remeasure() {
  const el = rootRef.value
  if (el) inset.value = measureCorner(el).right
}
function remeasureSoon() {
  remeasure()
  if (排队中) window.clearTimeout(排队中)
  排队中 = window.setTimeout(() => {
    排队中 = 0
    remeasure()
  }, 让位补量)
}

let observer: MutationObserver | null = null
function attachObserver() {
  observer?.disconnect()
  const canvas = rootRef.value?.closest('.scale-screen__canvas')
  if (!canvas) return
  // 只盯 childList：文字变化（时钟、指标跳动）不算结构变化，盯了会白量几千次。
  // 自己加消息也会触发，但 corner.ts 把 `[data-duner-dock]` 排除在候选之外，
  // 量出来的值不变 —— 是白量一次，不是死循环。
  observer = new MutationObserver(remeasureSoon)
  observer.observe(canvas, { childList: true, subtree: true })
}
onMounted(() => {
  // 挂载这一刻先量一次：命令栏原来是常驻的，按钮也一样，不能等第一次 DOM 变化
  remeasureSoon()
  window.addEventListener('resize', remeasureSoon)
  attachObserver()
})
// 换个页面，缩放容器本身也可能被换掉（那观察者就挂在旧节点上，再也不会响）。
// 每次路由变化重挂一次，顺手重量一次。
watch(
  () => route.fullPath,
  () => {
    attachObserver()
    remeasureSoon()
  }
)
onBeforeUnmount(() => {
  window.removeEventListener('resize', remeasureSoon)
  observer?.disconnect()
  if (排队中) window.clearTimeout(排队中)
})

function toggle() {
  open.value = !open.value
  if (open.value) void nextTick(() => inputRef.value?.focus())
}

/** 快捷问句：只回填 + 聚焦，发不发由人决定 */
function fillChip(text: string) {
  draft.value = text
  inputRef.value?.focus()
}

async function scrollDown() {
  await nextTick()
  const el = listRef.value
  if (el) el.scrollTop = el.scrollHeight
}

function push(msg: Msg) {
  messages.value.push(msg)
  void scrollDown()
}

/**
 * 发一句话。
 *
 * `context` 带上当前页面与场景状态：模型据此判「打开设备图层」这一句
 * 在当前页面能不能做，少问一轮。
 */
async function send(text: string) {
  const clean = text.trim()
  if (!clean || busy.value) return

  draft.value = ''
  open.value = true
  push({ role: 'user', text: clean })
  busy.value = true

  try {
    const res = await dunerChat(clean, { route: String(route.name ?? ''), scene: sceneStatus() })
    backendDown.value = false

    push({
      role: 'bot',
      text: res.reply,
      cards: res.cards ?? [],
      clarify: res.clarify ?? undefined,
      confirm: res.confirm ? { ...res.confirm, at: Date.now() } : null,
      meta: metaOf(res.source, res.ms, res.degraded)
    })

    // 视图指令由前端执行（后端碰不到 Cesium）。回执在桥接层里发。
    if (res.commands?.length) await runCommands(res.commands, res.auditId)
  } catch (err) {
    backendDown.value = err instanceof HttpError && (err.status === 0 || err.status === 404)
    push({ role: 'bot', text: errorText(err) })
  } finally {
    busy.value = false
    void scrollDown()
  }
}

/** 跑一批指令，把**需要给用户看的**结果补进对话 */
async function runCommands(commands: { tool: string; args: Record<string, unknown> }[], auditId: string) {
  const outs = await executeCommands(commands, auditId)
  for (const o of outs) {
    if (o.show) push({ role: 'note', text: o.note })
  }
}

function metaOf(source: string, ms: number, degraded?: boolean) {
  const by = { rule: '规则', llm: '模型', clarify: '接着上一句', none: '未识别' }[source] ?? source
  return [`${by}判定`, `${ms}ms`, degraded ? '模型超时已回落规则' : ''].filter(Boolean).join(' · ')
}

/**
 * 点澄清选项 = **把这句话再说一遍**。
 *
 * 选项在设计上就是「一句能被原样读懂的话」（或配 `slot` 让后端接回上一次调用），
 * 所以走同一个 `send()` —— 不给它开一条特殊路径，那条路径迟早会和主路径不一致。
 */
function onClarify(m: Msg, option: string) {
  m.answered = true
  void send(option)
}

/** 兑换确认令牌。写操作只有这一条路，点不点由人决定 */
async function doConfirm(m: Msg) {
  if (!m.confirm || m.confirm.dead || m.confirm.busy) return
  if (leftOf(m) <= 0) {
    m.confirm.dead = true
    return
  }

  // 先按住按钮再发请求：令牌是一次性的，双击会让第二次拿到 409。
  // 那次拒绝本身是对的，但让用户看见"已失效"是他自己双击造成的，不如前端先拦。
  m.confirm.busy = true
  const token = m.confirm.token

  try {
    const res = await dunerConfirm(token)
    m.confirm.dead = true
    push({ role: 'bot', text: res.reply, cards: res.card ? [res.card] : [] })
    if (res.commands?.length) await runCommands(res.commands, `confirm:${token.slice(0, 8)}`)
  } catch (err) {
    m.confirm.dead = true
    // 409 = 令牌已用/过期，是**可读的业务结果**而不是故障，照原样说给用户
    push({ role: 'bot', text: errorText(err) })
  } finally {
    if (m.confirm) m.confirm.busy = false
  }
}

function leftOf(m: Msg): number {
  if (!m.confirm || !m.confirm.at) return 0
  const ttl = m.confirm.expiresInMs || 60_000
  return Math.max(0, Math.round((m.confirm.at + ttl - now.value) / 1000))
}

function onSubmit() {
  void send(draft.value)
}

function clear() {
  messages.value = []
}

/** 「能干什么」—— 能力清单由后端给（含词典条数），不在前端另写一份 */
async function loadCapabilities() {
  if (busy.value) return
  open.value = true
  busy.value = true
  try {
    const cap = await dunerCapabilities()
    const reads = cap.tools.filter((t) => t.readOnly).map((t) => t.name).join('、')
    const writes = cap.tools.filter((t) => !t.readOnly).map((t) => t.name).join('、')
    push({
      role: 'bot',
      text: '我能做四类事：导航与图层、查数据、找设备找人、以及（管理员）工单/告警/导出。',
      cards: [
        {
          title: '当前能力',
          rows: [
            ['意图', `${cap.intents.length} 条`],
            ['只读工具', reads || '—'],
            ['写工具（需确认）', writes || '—'],
            ['术语词典', `${cap.dictCount} 条`],
            ['确认有效期', `${Math.round(cap.confirmTtlMs / 1000)} 秒`]
          ]
        }
      ]
    })
  } catch (err) {
    push({ role: 'bot', text: errorText(err) })
  } finally {
    busy.value = false
  }
}

/**
 * 把异常说成人话。
 *
 * 后端不在线是本项目最常见的一种失败（前端先行、后端是另一条命令起来的），
 * 所以它单独有一句话，并且**带上怎么起来**。其余照抄后端给的文案 ——
 * 403/409 那些句子是后端写的，比这里重写一遍准确。
 */
function errorText(err: unknown): string {
  if (!(err instanceof HttpError)) return `出了点问题：${String(err)}`
  if (err.status === 0) return '连不上墩儿的后端。请确认已执行 npm run serve（端口 8787）后重试。'
  if (err.status === 404) return '后端还没有 /api/duner 这组接口，请重启后端（npm run serve）后重试。'
  return err.message
}
</script>

<style lang="scss" scoped>
/**
 * 层级取 35：面板是 10、页内浮出控件 30、全屏遮罩 40。
 * 墩儿要在面板之上（对话框会盖住底部面板），又必须在 AppModal 之下
 * （弹窗是人主动打开的，不能被墩儿压住）。见 `styles/variables.scss` 的层级表。
 *
 * 位置：`right` 是变量（见 `corner.ts`），`bottom` 固定 16 —— 与页面自己的边距对齐。
 * 整个容器 `pointer-events: none`、只有子元素收事件：不然这块空白会在右下角
 * 吞掉地图的点击（参考那版也是这么做的）。
 */
.duner {
  position: absolute;
  right: var(--duner-right, 16px);
  bottom: 16px;
  z-index: 35;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  pointer-events: none;

  > * {
    pointer-events: auto;
  }
}

// ---------- 对话框 ----------
.duner__panel {
  @include panel-surface;
  display: flex;
  flex-direction: column;
  width: 400px;
  max-height: 560px;
  overflow: hidden;
}

.duner__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid $border-soft;
}

/** 标题栏左侧那个方块：与参考的「AI 方块」同形，配色换成我们的主色 */
.duner__logo {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: $font-number;
  font-size: 14px;
  font-style: italic;
  color: $bg-deep;
  background: $primary;
  border-radius: $radius-sm;
}

.duner__head-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.duner__title {
  font-size: $fs-body;
  color: $primary;
  letter-spacing: 1px;
}

.duner__sub {
  font-size: $fs-small;
  color: $text-muted;
}

.duner__link {
  padding: 2px 6px;
  font-size: $fs-small;
  color: $text-secondary;
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;

  &:hover {
    color: $primary;
    border-color: $border-panel;
  }
}

.duner__close {
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  font-size: $fs-small;
  color: $text-muted;
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: pointer;

  &:hover {
    color: $red;
    background: rgba(255, 77, 79, 0.12);
  }
}

.duner__list {
  @include thin-scrollbar;
  flex: 1;
  min-height: 120px;
  overflow-y: auto;
  padding: 10px 12px;
}

.duner__empty {
  margin: 4px 0;
  font-size: $fs-small;
  color: $text-muted;
  line-height: 1.7;
}

/**
 * 气泡：人说的靠右、墩儿说的靠左，靠**方向角**区分（参考那版的辨识点）。
 * 执行结果（note）做成居中的一条窄提示 —— 它是补充，不是墩儿说的话。
 */
.duner__msg {
  margin-bottom: 10px;

  &.is-user {
    display: flex;
    flex-direction: column;
    align-items: flex-end;

    .duner__text {
      max-width: 88%;
      padding: 6px 10px;
      color: $bg-deep;
      background: $primary;
      border-radius: 8px 2px 8px 8px;
    }
  }

  &.is-bot .duner__text {
    max-width: 100%;
    padding: 6px 10px;
    background: $bg-panel-soft;
    border: 1px solid $border-soft;
    border-radius: 2px 8px 8px 8px;
  }

  &.is-note {
    display: flex;
    justify-content: center;

    .duner__text {
      padding: 2px 10px;
      font-size: $fs-small;
      color: $text-muted;
      border: 1px solid $border-soft;
      border-radius: 12px;
    }
  }
}

.duner__text {
  margin: 0;
  font-size: $fs-body;
  color: $text-primary;
  line-height: 1.7;
  word-break: break-word;
}

.duner__card,
.duner__confirm {
  margin-top: 6px;
  padding: 8px 10px;
  background: $bg-panel-soft;
  border: 1px solid $border-panel;
  border-radius: $radius-md;
}

.duner__confirm.is-dead {
  opacity: 0.55;
}

.duner__card-title {
  margin: 0 0 4px;
  font-size: $fs-small;
  color: $primary;

  &--sub {
    margin-top: 6px;
    color: $text-secondary;
  }
}

.duner__rows {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  margin: 0;
  font-size: $fs-small;

  dt {
    color: $text-muted;
  }

  dd {
    margin: 0;
    color: $text-primary;
    word-break: break-word;
  }
}

.duner__confirm-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.duner__ttl {
  flex: 1;
  font-size: $fs-small;
  color: $text-muted;
}

.duner__btn {
  padding: 3px 12px;
  font-size: $fs-small;
  color: $text-primary;
  background: transparent;
  border: 1px solid $border-panel;
  border-radius: $radius-sm;
  cursor: pointer;

  &.is-primary {
    color: $bg-deep;
    background: $primary;
    border-color: $primary;
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.duner__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

/** 快捷问句那一行：横排可滚，占了输入框上方整条 */
.duner__chips--quick {
  flex-wrap: nowrap;
  align-items: center;
  margin: 0;
  padding: 6px 12px;
  overflow-x: auto;

  @include thin-scrollbar;
}

.duner__chips-tip {
  flex: 0 0 auto;
  font-size: $fs-small;
  color: $text-muted;
}

.duner__chip {
  flex: 0 0 auto;
  padding: 3px 10px;
  font-size: $fs-small;
  color: $primary;
  background: transparent;
  border: 1px solid $border-panel;
  border-radius: 12px;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: rgba(0, 229, 255, 0.12);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.duner__meta {
  margin: 4px 0 0;
  font-size: 11px;
  color: $text-muted;
}

/** 「正在想」三点：错峰跳动，与参考同款 */
.duner__thinking {
  display: flex;
  gap: 4px;
  padding: 4px 2px;

  i {
    width: 5px;
    height: 5px;
    background: $primary;
    border-radius: 50%;
    animation: duner-bounce 1s infinite;

    &:nth-child(2) {
      animation-delay: 0.15s;
    }

    &:nth-child(3) {
      animation-delay: 0.3s;
    }
  }
}

@keyframes duner-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.5;
  }

  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.duner__input-row {
  display: flex;
  gap: 8px;
  padding: 8px 12px 10px;
  border-top: 1px solid $border-soft;
}

.duner__input {
  flex: 1;
  height: 30px;
  padding: 0 10px;
  font-size: $fs-body;
  color: $text-primary;
  background: rgba(4, 20, 38, 0.6);
  border: 1px solid $border-panel;
  border-radius: $radius-md;

  &::placeholder {
    color: $text-muted;
  }

  &:focus {
    outline: none;
    border-color: $primary;
  }
}

.duner__send {
  height: 30px;
  padding: 0 16px;
  font-size: $fs-body;
  color: $bg-deep;
  background: $primary;
  border: none;
  border-radius: $radius-md;
  cursor: pointer;

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

// ---------- 悬浮按钮 ----------
.duner__fab {
  position: relative;
  width: 66px;
  height: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: $primary;
  cursor: pointer;
  background: $bg-panel;
  border: 1px solid $border-panel;
  border-radius: $radius-md;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  transition: transform 0.2s, background 0.2s, color 0.2s;

  &:hover {
    transform: translateY(-2px);
    background: $bg-hover;
  }

  // 打开态：主色实底 —— 与参考一致，开着的时候按钮也还在，且一眼看得出是开的
  &.is-on {
    color: $bg-deep;
    background: $primary;
    border-color: $primary;
  }
}

.duner__fab-logo {
  font-family: $font-number;
  font-size: 17px;
  font-style: italic;
  font-weight: 700;
  letter-spacing: 1px;
  line-height: 1;
}

.duner__fab-label {
  font-size: 11px;
  letter-spacing: 1px;
  line-height: 1;
  opacity: 0.85;
}

/** 呼吸光点：只在收起时亮着，意思是"我在这儿"（参考那版用来提示未读） */
.duner__pulse {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 9px;
  height: 9px;
  background: $green;
  border-radius: 50%;
  box-shadow: 0 0 8px $green;
  animation: duner-pulse 1.8s ease-in-out infinite;
}

@keyframes duner-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }

  50% {
    opacity: 0.35;
    transform: scale(0.8);
  }
}

// 对话框自下而上展开 —— 与它「从按钮长出来」的观感一致
.duner-rise-enter-active,
.duner-rise-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.duner-rise-enter-from,
.duner-rise-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
