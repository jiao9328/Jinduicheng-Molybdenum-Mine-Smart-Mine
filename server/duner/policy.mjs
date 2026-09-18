/**
 * PolicyService —— 权限判定（指导书第 2 节第 6 条「不越权」）。
 *
 * ## 判定依据是**工具自己的 `readOnly`**，不是意图表
 *
 * 这条是刻意的，而且是因为一个具体的坑：意图有两条来源。
 * 规则引擎给的是**意图 ID**（`ORDER.CREATE`），LLM 给的是**工具名**
 * （它只会说 `order_create`，不知道我们的意图编号）。如果权限只看意图表，
 * 那么模型产出的调用就**绕过了整张表** —— 它说 `order_create` 时
 * "这个工具是不是写"根本没人查，权限判定直接落空。
 *
 * 所以真正的闸门挂在工具上：`getTool(name).readOnly === false` 即写。
 * 意图表只用来补充"这个意图还需要什么角色"，是**加成**不是唯一依据。
 *
 * ## 与既有 `requireAdmin` 的关系
 *
 * `server/auth.mjs` 的 `requireAdmin` 是**路由级**的（这个接口谁能调），
 * 这里的是**工具级**的（这一次动作谁能做）。两者都要有：
 * 前者挡住"普通用户调词典管理接口"，后者挡住"普通用户在对话里说'给我建张工单'"——
 * 后者是自然语言特有的攻击面，路由级权限完全看不见它。
 */

import { getTool } from './tools/registry.mjs'
import { WRITE_INTENTS, requiredRole } from './intents.mjs'

/** 指导书 §8.1 的越权话术。检查脚本要断言逐字一致，所以写成常量 */
export const DENY_WRITE =
  '这项操作需要管理员权限，你当前是普通用户（只读）。可以让管理员来执行，或者我帮你查一下相关数据。'

export const DENY_ANON = '请先登录，墩儿的操作要记在具体用户名下。'

/**
 * 判一次动作能不能做。
 *
 * @param user    当前用户（`currentUser` 的结果，可能为 null）
 * @param intents 本次识别出的意图（规则或模型产出）
 * @returns {{ok:true} | {ok:false, message:string, reason:string}}
 */
export function authorize({ user, intents }) {
  if (!user) return { ok: false, message: DENY_ANON, reason: 'anonymous' }
  if (user.role === 'admin') return { ok: true }

  const writes = writeToolsOf(intents)
  if (writes.length) {
    return { ok: false, message: DENY_WRITE, reason: 'write_needs_admin', tools: writes }
  }

  // 非写意图里也可能有要求管理员的（当前没有，但留出这条通道，
  // 免得将来加一个"仅管理员可见的查询"时又要改这里）
  const needAdmin = intents.filter((i) => requiredRole(i.intent) === 'admin')
  if (needAdmin.length) {
    return { ok: false, message: DENY_WRITE, reason: 'intent_needs_admin', tools: needAdmin.map((i) => i.intent) }
  }

  return { ok: true }
}

/**
 * 本次意图里涉及哪些**写工具**。
 *
 * 两路都要查（见文件头）：
 * - 意图 ID 在 `WRITE_INTENTS` 表里 → 写；
 * - 意图名本身就是一个注册的写工具（LLM 路径） → 写。
 *
 * 认不出来的名字**不算写** —— 但它也执行不了（`runTool` 会回
 * 「没有这个工具」），所以不存在"漏判成只读然后执行了写"的路径。
 */
export function writeToolsOf(intents) {
  const out = []
  for (const item of intents ?? []) {
    // 路径一：意图 ID 在写意图表里（规则引擎产出）
    const declared = WRITE_INTENTS[item.intent]
    if (declared?.tool) out.push(declared.tool)

    // 路径二：意图名**本身**就是一个注册工具（LLM 产出，它只知道工具名）。
    // 这一路不能省 —— 只查意图表的话，模型产出的写调用整张表都绕过去了。
    const tool = getTool(item.intent)
    if (tool && !tool.readOnly) out.push(tool.name)
  }
  return [...new Set(out)]
}

/** 本次动作用不用走确认闸门（= 有没有写工具） */
export const needsConfirm = (intents) => writeToolsOf(intents).length > 0

/**
 * 普通用户看到写意图时，**不是**把话咽掉装没听懂，而是明说原因。
 * 指导书 §8.1 的越权话术就是这么要求的。
 */
export const isDenied = (auth) => auth && auth.ok === false
