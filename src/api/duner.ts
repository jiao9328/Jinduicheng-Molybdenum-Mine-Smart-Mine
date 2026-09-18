/**
 * 墩儿接口 —— 自然语言指挥层。
 *
 * ## 一律 `http.post`，**不用 `requestWithFallback`**
 *
 * 这是本文件最重要的一条，别顺手改成"统一风格"。
 *
 * 降级的语义是「接口没就绪，先用内置数据把页面撑起来」。对话没有"内置数据"
 * 可言：本地的 `reply` 只能是我编的。而**编一句"已完成"比报错坏得多** ——
 * 用户会当真，然后去找一个根本没发生的相机移动、一张根本没生成的工单。
 *
 * 后端的写操作也是这样守的（`writeTools.mjs` 顶部），前端这条是对称的。
 * 所以后端不在线时，面板如实显示「墩儿后端未就绪」，并说明怎么起来。
 *
 * ## 超时留了多少余量
 *
 * `http.ts` 的默认超时是 15s，后端给模型留了 **8s**（`config.mjs` 的
 * `DUNER_LLM_TIMEOUT_MS`）。余量是给"模型慢 + 网络慢"两边一起用掉的，
 * 不是随手写的数：前端先超时的话，用户看到的是"网络异常"，
 * 而后端其实马上就把结果算出来了 —— 那种错最难查。
 */

import { http } from './http'

/** 后端下发的视图指令。`cmdId` 是**前端生成**的（后端不知道前端有几条），见 `bridge.ts` */
export interface DunerCommand {
  tool: string
  args: Record<string, unknown>
}

/** 结果卡片。`sections` 与 `rows` 二者有其一 */
export interface DunerCard {
  title: string
  rows?: [string, string][]
  sections?: DunerCard[]
}

/** 反问。`options` 里每一项都是**能再读一遍的完整话**（或配合 resume 的槽位值） */
export interface DunerClarify {
  question: string
  options: string[]
}

/** 待确认的写操作。`token` 是一次性凭据，60s 内有效 */
export interface DunerConfirm {
  token: string
  tool: string
  text: string
  card?: DunerCard | null
  expiresInMs: number
}

export interface DunerChatReply {
  reply: string
  commands: DunerCommand[]
  cards: DunerCard[]
  confirm?: DunerConfirm | null
  clarify?: DunerClarify | null
  /** `rule` 规则引擎 / `llm` 模型 / `clarify` 接上一轮反问 / `none` 没识别 */
  source: string
  /** 模型调用失败并回落规则时为 true —— 结果能用，但要说出来 */
  degraded?: boolean
  ms: number
  auditId: string
}

export interface DunerConfirmReply {
  /** 兑换是否成功。⚠️ HTTP 200 也可能 ok=false —— 令牌过期/已用 */
  ok: boolean
  reply: string
  card?: DunerCard | null
  commands: DunerCommand[]
}

/** 面板上「你能干什么」用的能力清单 */
export interface DunerCapabilities {
  intents: { id: string; label: string; write: boolean; emergency: boolean }[]
  tools: { name: string; description: string; readOnly: boolean }[]
  dictCount: number
  confirmTtlMs: number
}

/**
 * 说一句话。
 *
 * `context` 带上当前页面与场景状态（`{ route, scene }`）—— 模型据此判
 * 「打开设备图层」是不是在当前页面能做的事。不带也能跑，只是它得多问一句。
 */
export const dunerChat = (text: string, context?: Record<string, unknown>) =>
  http.post<DunerChatReply>('/duner/chat', { text, context })

/** 兑换确认令牌并真正执行写操作。重复兑换会被后端拒（409） */
export const dunerConfirm = (token: string) =>
  http.post<DunerConfirmReply>('/duner/confirm', { token })

/**
 * 回执：前端执行完视图指令之后必调，闭合审计链路（指导书 4.3）。
 *
 * `auditId` 是必须的 —— 回执要能挂回**哪一次对话**。后端不生成 cmdId
 * （它不知道前端会把一条指令拆成几次执行），所以 cmdId 由前端造，
 * 只有 auditId 能把两行审计对上。
 *
 * 回执失败**不弹错**（调用方自行 catch）：回执本身失败不该毁掉用户这一次操作，
 * 但也不能静默 —— 桥接层会把它记进控制台。
 */
export const dunerReceipt = (payload: {
  cmdId: string
  tool: string
  ok: boolean
  ms: number
  auditId: string
  note?: string
}) => http.post<{ ok: boolean }>('/duner/receipt', payload)

/** 能力清单（词典条数、意图表、工具表） */
export const dunerCapabilities = () => http.get<DunerCapabilities>('/duner/capabilities')
