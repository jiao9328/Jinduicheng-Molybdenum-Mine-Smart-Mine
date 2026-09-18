/**
 * 工具注册表 —— 指导书第 7 节的 MCP 风格接口。
 *
 * ## `readOnly` 是这套系统里最重要的一个布尔值
 *
 * 指导书第 2 节第 1~2 条要求「默认只读、写操作必须显式确认」，第 12 节把
 * 「未经确认执行写操作」的指标定成 **0**。这不能靠提示词（模型可以被绕过），
 * 只能靠一个结构性的事实：**每个工具自己声明它是不是只读**，
 * 而 `service.mjs` 对 `readOnly: false` 的一律先发确认卡。
 *
 * 所以「加了一个写工具却忘了接确认」这件事在这里**做不到** ——
 * 只要 `readOnly` 写 false，闸门是自动的；写 true 才是需要解释的选择。
 *
 * ## 视图类工具为什么不在这里碰 Cesium
 *
 * 指导书 4.3 的关键设计：后端**不直接操作三维场景**，而是产出标准指令，
 * 由前端执行后回执。所以 `map.*` / `layer.*` 的 `execute()` 只返回
 * `{ kind:'view', ... }`，真正调 `camera.flyTo` 的是浏览器里的 `bridge.ts`。
 * 好处是后端可以脱离浏览器单测（检查脚本就是这么打它的），
 * 而且「谁改的画面」永远可追。
 */

/**
 * 定义一个工具。只是加一层形状校验 —— 名字写错、忘了写 readOnly
 * 这类错误在注册表构造时就要炸出来，而不是等到运行到那一行。
 *
 * 最后那条校验（写工具必须有 `commit`）是这里最有价值的一条：
 * 写工具的 `execute()` **只做预检、不落库**（落库在 `commit()` 里，
 * 确认之后才调）。如果一个写工具只写了 `execute()`，它照样能注册、
 * 照样能发确认卡、用户点确认后也"成功"返回 —— 只是**库里什么都没有**。
 * 这是最难查的一类错（界面上一切正常）。所以在注册时直接拒掉。
 */
export function defineTool(spec) {
  const { name, description, readOnly, parameters, execute, commit } = spec
  if (!name || typeof name !== 'string') throw new Error('工具必须有 name')
  if (!description) throw new Error(`工具 ${name} 必须有 description（模型要靠它选工具）`)
  if (typeof readOnly !== 'boolean') throw new Error(`工具 ${name} 必须声明 readOnly`)
  if (typeof execute !== 'function') throw new Error(`工具 ${name} 必须有 execute`)
  if (readOnly === false && typeof commit !== 'function') {
    throw new Error(`写工具 ${name} 必须实现 commit() —— 否则确认之后什么也不会发生`)
  }
  if (readOnly === true && typeof commit === 'function') {
    throw new Error(`只读工具 ${name} 不该有 commit() —— 只读工具直接 execute 就完了`)
  }
  return {
    name,
    description,
    readOnly,
    parameters: parameters ?? { type: 'object', properties: {} },
    execute,
    commit
  }
}

/** 视图指令：交前端执行 */
export const viewResult = (tool, args, note = '') => ({
  kind: 'view',
  tool,
  args: args ?? {},
  note
})

/** 数据答复：后端已经查好了 */
export const dataResult = (text, card = null) => ({ kind: 'data', text, card })

/** 纯文本答复（拒绝、帮助、反问） */
export const textResult = (text) => ({ kind: 'text', text })

/**
 * 反问：参数不够时不猜，把选项摆出来让用户点（指导书 7.1）。
 *
 * 与 `errorResult` 分开是必要的：两者都"没执行成"，但**该说的话不一样**。
 * 出错要说明哪儿出了问题；反问要给出候选让用户一句话就能接上。
 * 界面上前者是红字提示，后者是可点的选项按钮 —— 合成一种就没法区分了。
 *
 * ## `slot` 是干嘛的（不填也能跑，但多轮对话会断）
 *
 * 填上"我在问的是哪个参数"，编排层就能把用户的下一句话**接回到同一个工具**上。
 * 不填的话，用户点一下选项，那句话要重新走一遍意图识别 ——
 * 而「王建国」这三个字单独出现时不属于任何意图，于是又反问一遍同一句，
 * 用户点了自己的选项却回到原点。
 *
 * 单槽的问答（如 `alarm.ack` 问确认哪条）**不需要** slot：
 * 它的选项本身写成了一句完整的话（"确认破碎一的告警"），规则引擎直接读得懂。
 * 需要 slot 的是**多槽**场景 —— 用户前面说过「北帮3号台阶有裂缝」，
 * 后面只补一句「王建国」，前面那两个参数只存在于上一次调用里。
 */
export const clarifyResult = (question, options = [], slot = null) => ({ kind: 'clarify', question, options, slot })

/**
 * 待确认：写工具的 `execute()` 返回它，表示"参数齐了、可以做了，但还没做"。
 *
 * `payload` 是**确认之后要落库的东西**，与 `card` 分开：
 * 卡片是给人看的（四行中文），payload 是给 `commit()` 用的（结构化字段）。
 * 合成一份的话，要么卡片里塞着机器字段，要么 `commit()` 去解析中文 —— 两条路都糟。
 */
export const planResult = ({ text, card, payload }) => ({ kind: 'plan', text, card, payload: payload ?? {} })

/** 执行失败 —— 会如实回给用户，绝不假装成功 */
export const errorResult = (message) => ({ kind: 'error', message })

/**
 * 注册表。用 Map 而不是对象：工具名带点号（`map.flyTo`），
 * 对象键虽然也能写，但 Map 的 `has`/`get` 语义在这里更不容易出错。
 */
const TOOLS = new Map()

export function registerTools(tools) {
  for (const t of tools) {
    if (TOOLS.has(t.name)) throw new Error(`工具名重复：${t.name}`)
    TOOLS.set(t.name, t)
  }
}

export const getTool = (name) => TOOLS.get(name) ?? null
export const listTools = () => [...TOOLS.values()]
export const toolNames = () => [...TOOLS.keys()]

/** 只读工具名列表 —— 检查脚本用它断言「所有写工具都过了确认闸门」 */
export const writeToolNames = () => listTools().filter((t) => !t.readOnly).map((t) => t.name)

/** 执行一个工具。未注册的名字返回 error 而不是抛异常（模型可能编一个不存在的工具名） */
export async function runTool(name, args, ctx) {
  const tool = TOOLS.get(name)
  if (!tool) return errorResult(`没有这个工具：${name}`)
  try {
    const out = await tool.execute(args ?? {}, ctx)
    return out ?? errorResult(`工具 ${name} 没有返回结果`)
  } catch (err) {
    return errorResult(`工具 ${name} 执行失败：${err?.message ?? err}`)
  }
}

/**
 * 执行一个写工具的落库部分。**只有 `ConfirmManager` 兑换成功后才该调它**。
 *
 * 单独一个函数而不是让编排层去 `tool.commit(...)`：这样"谁有权调 commit"
 * 在代码里只有一个入口，将来加审计/加二次校验都改这一处。
 */
export async function runCommit(name, payload, ctx) {
  const tool = TOOLS.get(name)
  if (!tool) return errorResult(`没有这个工具：${name}`)
  if (typeof tool.commit !== 'function') return errorResult(`工具 ${name} 不是写工具，没有 commit`)
  try {
    const out = await tool.commit(payload ?? {}, ctx)
    return out ?? errorResult(`工具 ${name} 的 commit 没有返回结果`)
  } catch (err) {
    return errorResult(`工具 ${name} 落库失败：${err?.message ?? err}`)
  }
}

/** 给模型看的工具清单（附 JSON Schema） */
export const schemaForModel = () =>
  listTools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, readOnly: t.readOnly }))
