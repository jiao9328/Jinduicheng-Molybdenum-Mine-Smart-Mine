/**
 * 编排层 —— 指导书 4.2 的主流程：
 * `NLU → 决策 → 权限 → 确认/执行 → 反馈`，每一步都落审计。
 *
 * ## 路由：规则优先，模型兜底
 *
 * ```
 * 归一化 → 规则引擎 →（认出来了？）─是→ 执行
 *                        └─否→ DeepSeek ─（认出来了？）─是→ 执行
 *                                        └─否→ 反问
 * ```
 *
 * 顺序反过来（模型优先）会违反指导书第 11 节「核心指令离线 100% 可用」：
 * 把 NAV/LAYER/QUERY.STATUS 的必经之路上挂一个会超时、会限流、
 * 会返回 HTTP 200 + 空内容的（实测过）外部依赖，"100%" 就是空话。
 * 现在核心指令根本不走网络，模型只处理长尾。
 *
 * ## 槽位名 == 工具参数名，这是刻意的约定
 *
 * `rule.mjs` 抽出来的 `slots` 直接当工具参数用（`{target}` → `map.flyTo({target})`），
 * 中间没有一层"槽位映射到参数"的翻译表。少掉那层翻译 = 少掉一处
 * "改了工具参数名但忘了改映射表"的静默失效。
 *
 * 模型那条路的 `slots` 本来就是它按 JSON Schema 填的参数，天然一致。
 *
 * ## 写操作的闸门只有一道
 *
 * 不管意图是规则还是模型给的，只要涉及 `readOnly: false` 的工具，
 * 一律走 `ConfirmManager` 发确认卡，**且 `execute()` 里不落库**
 * （落库在 `commit()`，确认之后才调）。所以"未经确认执行写操作"这件事
 * 在这条链路上没有可走的路径 —— 指标要求它是 0，这是唯一可靠的实现方式。
 */

import { classify } from './rule.mjs'
import { seedDict, normalizeWithDb, getDict, countDict } from './dict.mjs'
import { askModel } from './llm.mjs'
import { llmConfig, CONFIDENCE_THRESHOLD, CONFIRM_TTL_MS } from './config.mjs'
import { ALL_INTENTS, SYSTEM_INTENTS, OUT_OF_SCOPE_REPLY, OFFLINE_REPLY } from './intents.mjs'
import { authorize } from './policy.mjs'
import { issue, redeem, sweep, REDEEM_MESSAGE } from './confirm.mjs'
import { remember, take, forget } from './pending.mjs'
import { DIRECTION_NAMES, isNavigableTarget } from './vocab.mjs'
import { auditChat, auditWrite, auditReceipt, auditDenied } from './audit.mjs'
import { getTool, runTool, runCommit, registerTools, listTools, schemaForModel } from './tools/registry.mjs'
import { registerViewTools } from './tools/viewTools.mjs'
import { registerDataTools } from './tools/dataTools.mjs'
import { registerWriteTools } from './tools/writeTools.mjs'
import { registerPlanTools } from './tools/planTools.mjs'

/** 一句话最多执行几个动作。复合句常见两三个，超过这个数的多半是识别错了 */
const MAX_INTENTS = 4

/**
 * 反问接续的键。用 id；`id` 缺失的极端情况退回用户名 ——
 * 回退到 `undefined` 会让所有人的反问共用一个槽位（见 pending.mjs 末尾那段）。
 */
const dbUser = (user) => user?.id ?? user?.username ?? null

/**
 * 工具注册在**模块加载时**就完成，不等到第一次对话。
 *
 * 一开始放在 `initDuner()` 里（要拿到 db 才注册），结果是：
 * 第一次 `chat()` 之前 `listTools()` 是**空数组**。
 * 这个空数组会一路传进 `askModel` 的 `tools` 参数，
 * 表现是"模型一个工具都看不到，于是什么都调不了" —— 而它只在
 * 某些调用顺序下才出现（比如检查脚本先问能力清单再对话）。
 * 注册本身不依赖库，所以没有理由延后。
 */
registerTools([
  ...registerViewTools(),
  ...registerDataTools(),
  ...registerWriteTools(),
  ...registerPlanTools()
])

/**
 * 灌词典种子。**每次调用都灌**（`seedDict` 是 `ON CONFLICT DO NOTHING`，
 * 只补缺不覆盖，见 `dict.mjs`），所以重复调用是安全的、而且很便宜
 * （三十来条 prepared upsert，微秒级）。不加 flag 是因为加了之后
 * "一个进程中换了库就不再灌种子"这种坑会出现，而收益只是省掉微秒。
 */
export function initDuner(db) {
  seedDict(db)
}

/** 视角预设的中文名 —— 回话时要用它，不然会念出 `overview` 这种词 */
const PRESET_TEXT = {
  top: '俯瞰',
  overview: '全局',
  pit: '采坑',
  plant: '选矿厂',
  dump: '排土场',
  tailings: '尾矿库'
}

/**
 * 处理一句话。
 *
 * @returns {Promise<{reply, commands, cards, confirm?, clarify?, source, degraded?, ms, auditId}>}
 */
export async function chat({ db, user, text, context }) {
  const t0 = Date.now()
  initDuner(db)

  const raw = String(text ?? '').trim()
  if (!raw) return { reply: '你说句话我才能干活。', commands: [], cards: [], source: 'none', ms: 0 }

  const cfg = llmConfig()
  // 归一化：中文数字 → 阿拉伯、词典同义词 → 标准词（「边皮廊」→「皮带廊」）
  const norm = normalizeWithDb(db, raw)

  // ---- 第一步：规则引擎 ----
  const ruled = classify(norm.text)
  let intents = ruled.intents
  let source = 'rule'
  let degraded

  // ---- 第一步半：上一轮的反问，这回是在回答它吗 ----
  //
  // 顺序要紧：**先**让用户这句话按正常路径识别一遍，**认不出来**才当作
  // 上一轮反问的答案。反过来的话，他明确说「打开风险图层」时会被塞进
  // "责任人是哪个"那个槽里 —— 一句正当的指令被吃掉，比多问一遍坏得多。
  //
  // `take()` 取出即清，所以答案只用一次。
  const pendingAsk = take(dbUser(user))
  const answering = pendingAsk && !intents.length
  if (answering) {
    intents = [
      { intent: pendingAsk.intent, slots: { ...pendingAsk.slots, [pendingAsk.slot]: raw }, confidence: 0.9 }
    ]
    source = 'clarify'
  } else if (pendingAsk && intents.length) {
    // 说了别的 → 那条反问已经作废，不能留着等下一句
    forget(dbUser(user))
  }

  // ---- 第二步：规则认不出（或把握不足）才问模型 ----
  if (!answering && (!intents.length || ruled.confidence < CONFIDENCE_THRESHOLD)) {
    if (cfg.available) {
      const llm = await askModel({ text: norm.text, cfg, tools: listTools(), context })
      degraded = llm.degraded
      if (llm.intents.length) {
        intents = llm.intents
        source = 'llm'
      }
      // 模型也没认出来时，**保留规则的低置信结果**比丢掉强
      // （规则至少知道它为什么这么判，模型是一句空话）
    } else {
      degraded = 'no_key'
    }
  }

  // ---- 第三步：认不出来就反问，不猜 ----
  if (!intents.length) {
    const reply = cfg.available
      ? '这句我没听懂。你可以说「带我去北帮3号台阶」或「今天产量怎么样」。'
      : `${OFFLINE_REPLY} 这句我没听懂，可以先试试导航、图层和产量查询。`
    const clar = {
      question: reply,
      options: ['带我去北帮3号台阶', '打开边坡监测图层', '今天产量怎么样']
    }
    const auditId = auditChat(db, user, {
      raw,
      normalized: norm.text,
      intents: [],
      source: 'none',
      confidence: 0,
      results: [],
      reply,
      ms: Date.now() - t0,
      degraded
    })
    return { reply, commands: [], cards: [], clarify: clar, source: 'none', degraded, ms: Date.now() - t0, auditId }
  }

  // ---- 第四步：系统意图（越界拒绝 / 帮助）不驱动工具 ----
  const sys = intents.filter((i) => SYSTEM_INTENTS[i.intent])
  const oos = sys.find((i) => i.intent === 'SYS.OUT_OF_SCOPE')
  if (oos) {
    // 越界与注入都记一笔：被拒绝的次数是安全信号，不记就看不见有人在试
    auditDenied(db, user, { raw, reason: oos.slots?.reason ?? 'out_of_scope', intent: 'SYS.OUT_OF_SCOPE' })
    return {
      reply: OUT_OF_SCOPE_REPLY,
      commands: [],
      cards: [],
      source,
      ms: Date.now() - t0,
      auditId: null
    }
  }
  // SYS.CORRECT（纠错）—— 指导书 §6 列的系统意图，它**没有工具**，
  // 由编排层翻译成一次导航或一句反问（见 `correctTurn`）。
  const cor = intents.find((i) => i.intent === 'SYS.CORRECT')
  if (cor) {
    return correctTurn({ db, user, raw, cor, norm, intents, source, ruled, t0, degraded })
  }

  // CHAT.HELP 在 `READ_INTENTS` 里（它不是什么系统级动作），但它的 `tool` 是 null，
  // 所以**必须在这里拦下**：放它进 `actionable` 的话，`runIntents` 会去找
  // 一个叫 CHAT.HELP 的工具，然后回一句「不认识这个动作：CHAT.HELP」——
  // 用户问"你能干什么"，得到的是系统说自己不认识"你能干什么"。
  if (intents.some((i) => i.intent === 'CHAT.HELP')) {
    const reply = helpText()
    const auditId = auditChat(db, user, {
      raw, normalized: norm.text, intents, source, confidence: ruled.confidence,
      results: [], reply, ms: Date.now() - t0, degraded
    })
    return { reply, commands: [], cards: [], source, ms: Date.now() - t0, auditId }
  }

  const actionable = intents
    .filter((i) => !SYSTEM_INTENTS[i.intent] && i.intent !== 'CHAT.HELP')
    .slice(0, MAX_INTENTS)

  // ---- 第五步：权限。写在工具上而不是提示词上（见 policy.mjs） ----
  const auth = authorize({ user, intents: actionable })
  if (auth.ok === false) {
    auditDenied(db, user, { raw, reason: auth.reason, intent: actionable.map((i) => i.intent).join(',') })
    const auditId = auditChat(db, user, {
      raw, normalized: norm.text, intents: actionable, source, confidence: ruled.confidence,
      results: [], reply: auth.message, ms: Date.now() - t0, degraded
    })
    return { reply: auth.message, commands: [], cards: [], source, denied: true, ms: Date.now() - t0, auditId }
  }

  // ---- 第六步：执行 ----
  const ctx = { db, user, cfg }
  const out = await runIntents({ ctx, intents: actionable })

  // ---- 第七步：反馈 ----
  let confirm = null
  if (out.pending) {
    const issued = issue(db, {
      user,
      tool: out.pending.tool,
      payload: out.pending.plan.payload,
      card: out.pending.plan.card,
      text: out.pending.plan.text
    })
    confirm = {
      token: issued.token,
      tool: out.pending.tool,
      text: out.pending.plan.text,
      card: out.pending.plan.card,
      expiresInMs: issued.expiresInMs
    }
    sweep(db)
  }

  // ---- 第七步半：记下这轮的反问，好让下一句能接上 ----
  // 只在真的问了、且知道问的是哪个参数时才记（见 pending.mjs 的取舍）
  if (out.clarify?.resume) remember(dbUser(user), out.clarify.resume)

  const reply = composeReply(out, confirm)

  const auditId = auditChat(db, user, {
    raw,
    normalized: norm.text,
    intents: actionable,
    source,
    confidence: source === 'rule' ? ruled.confidence : 0.7,
    results: out.results,
    reply,
    ms: Date.now() - t0,
    degraded
  })

  return {
    reply,
    commands: out.commands,
    cards: out.cards,
    confirm,
    clarify: out.clarify,
    source,
    degraded,
    ms: Date.now() - t0,
    auditId
  }
}

/**
 * 纠错（`SYS.CORRECT`）—— 指导书 §6 列的系统意图。
 *
 * 原来它只有 `intents.mjs` 里的一个 label，没有任何行为，实测：
 * 「不是这个」「我说的是南帮」→ **「这句我没听懂」**。
 *
 * ## 只翻译成导航，**绝不改写写操作**
 *
 * 「不是这个」否定的是眼前的画面/上一个回答，它能翻译成的动作只有"换个地方看"。
 * 让纠错去改一张待确认的工单（「不是这个，改成责任人李振华」）看着聪明，
 * 但那是一条**没有确认卡**的写路径：纠错句不经过 `ConfirmManager`，
 * 用户却会以为自己已经改完了。写操作的修改入口只有一个 —— 重新说一遍那条指令。
 *
 * ## 整句以纠错为准，同句其它意图不执行
 *
 * 有人说「不对」的时候，把同一句里另一半指令照常执行，是**明知他否定了还照做**：
 * 「带我去尾矿库，不是这个，我说的是东帮」会先飞尾矿库再飞东帮，
 * 屏幕上是一次没人要的来回。
 *
 * ## 带不带新对象是两条路
 *
 * - **带了**（「我说的是东帮」「改成1号矿卡」）→ 直接翻译成一次 `map.flyTo`，
 *   回话以「已改成」开头 —— 用户要听得出这一句是在纠正上一句，
 *   而不是又下了一条新指令（否则他会怀疑助手到底有没有意识到自己刚才错了）。
 * - **光杆**（「不是这个」）→ 反问"你想改成哪儿"并记下待接续的反问
 *   （`pending.mjs`，**不新造状态机制**），用户下一句「东帮」就能接上。
 *   这里不猜：猜错的代价是相机飞到另一个地方，他还得再纠一次。
 *
 * `options` 给**光杆地名**而不是「带我去北帮」这样的整句，是配合上面那条接续：
 * 接续机制会把用户这句话**原样**填进 `target` 槽，选项写成整句就会变成
 * `target = '带我去北帮'` —— 前端解析不出这个名字，回一句「没找到」。
 * 光杆「北帮」正好：它不属于任何意图（规则引擎认不出，这是接续能生效的前提），
 * 点到它就是把 `北帮` 填进 `target`。
 */
async function correctTurn({ db, user, raw, cor, norm, intents, source, ruled, t0, degraded }) {
  const target = String(cor.slots?.target ?? '').trim()
  const 目标可用 = isNavigableTarget(target)

  const ctx = { db, user, cfg: llmConfig() }
  const out = 目标可用
    ? await runIntents({
        ctx,
        intents: [{ intent: 'NAV.FLYTO', slots: { target, highlight: true }, confidence: 0.9 }]
      })
    : null

  /**
   * 回话**不用 `composeReply`**：那条路会拼出「已定位到东帮」，
   * 与「已改成」叠在一起成了"已改成东帮——已定位到东帮"。
   * 纠错的回话只有一句要说：**你要的那个已经换上了**。
   */
  const reply = 目标可用
    ? `已改成「${target}」。` + (out.errors.length ? out.errors.join('；') : '')
    : '你想改成哪儿？'

  const clarify = 目标可用
    ? null
    : {
        question: reply,
        options: [...DIRECTION_NAMES],
        resume: { intent: 'NAV.FLYTO', tool: 'map.flyTo', slots: {}, slot: 'target' }
      }

  if (clarify?.resume) remember(dbUser(user), clarify.resume)

  const auditId = auditChat(db, user, {
    raw,
    normalized: norm.text,
    intents,
    source,
    confidence: ruled.confidence,
    results: out?.results ?? [],
    reply,
    ms: Date.now() - t0,
    degraded
  })

  return {
    reply,
    commands: out?.commands ?? [],
    cards: out?.cards ?? [],
    clarify,
    source,
    degraded,
    ms: Date.now() - t0,
    auditId
  }
}

/** 逐个跑意图，把各种形态的返回值收成一份 */
async function runIntents({ ctx, intents }) {
  const commands = []
  const cards = []
  const texts = []
  const errors = []
  const results = []
  let clarify = null
  let pending = null

  for (const item of intents) {
    // 意图 → 主工具。两条路（见 policy.mjs 的同一段解释）
    const declared = ALL_INTENTS[item.intent]?.tool
    const toolName = declared ?? (getTool(item.intent) ? item.intent : null)
    if (!toolName) {
      errors.push(`不认识这个动作：${item.intent}`)
      continue
    }

    const result = await runTool(toolName, item.slots ?? {}, ctx)
    results.push({ intent: item.intent, tool: toolName, result })

    for (const c of commandsOf(result)) commands.push(c)
    if (result.card) cards.push(result.card)

    if (result.kind === 'plan') {
      // 写操作：**只记待确认，不执行**。真正的落库在 `confirm()` 里
      pending = { tool: toolName, plan: result }
    } else if (result.kind === 'clarify') {
      // `resume` 是给下一轮用的：用户回答之后就接着跑这一个工具，
      // 而不是把他那句话当新指令重新识别（见 pending.mjs）。
      // 只有工具指明了 slot 才记 —— 没指明就不知道该把答案填到哪儿。
      clarify = clarify ?? {
        question: result.question,
        options: result.options ?? [],
        resume: result.slot
          ? { intent: item.intent, tool: toolName, slots: item.slots ?? {}, slot: result.slot }
          : null
      }
    } else if (result.kind === 'error') {
      errors.push(result.message)
    } else if (result.kind === 'data' && result.text) {
      texts.push(result.text)
    } else if (result.kind === 'text' && result.text) {
      texts.push(result.text)
      if (result.options && !clarify) clarify = { question: result.text, options: result.options }
    }
  }

  return { commands, cards, texts, errors, results, clarify, pending }
}

/**
 * 从一个工具结果里取出视图指令。
 *
 * 两种形态都要认：`viewResult` 给的是 `{kind:'view', tool, args}`（单条），
 * 而 `plan.match` / `entity.find` 直接给 `commands` 数组（多条）。
 * 在编排层统一，是为了让"一个工具产出多条指令"不需要在工具侧开特例。
 */
function commandsOf(result) {
  if (!result) return []
  const list = []
  if (Array.isArray(result.commands)) {
    for (const c of result.commands) if (c?.tool) list.push({ tool: c.tool, args: c.args ?? {} })
  }
  if (result.kind === 'view' && result.tool) list.push({ tool: result.tool, args: result.args ?? {} })
  return list
}

/**
 * 拼回话。
 *
 * 指导书 §7.3 的原则是「执行结果必须落到视图变化或卡片上，不能只回一句文字」，
 * 所以这里把视图指令**也**说成一句话（「已定位：北帮3号台阶」）——
 * 用户对着大屏看画面变化的同时，对话区里有一句能对上号的说明。
 *
 * ⚠️ 这句"已完成"是在前端**执行之前**说的。闭环靠回执：
 * `POST /api/duner/receipt` 会记下每条指令的真实结果，
 * 前端拿到失败回执时会补一条更正提示。不这么做的话，
 * 就得先执行再回话 —— 那是两次往返，大屏上会明显卡顿。
 */
function composeReply(out, confirm) {
  if (confirm) {
    // 秒数**从 `CONFIRM_TTL_MS` 现算**，不写死 60。
    // 写死的那版在把 TTL 配成别的值时（本仓库拍展示图时配过 180s）会说假话：
    // 卡片倒计时按配置走，回话却说 60 —— 两边对不上，而没有任何报错。
    const 秒 = Math.round(CONFIRM_TTL_MS / 1000)
    return `${confirm.text}。请在确认卡片上点「确认」执行，${秒} 秒内有效。`
  }
  if (out.clarify) return out.clarify.question

  const bits = []
  if (out.texts.length) bits.push(out.texts.join('；'))
  const described = describeCommands(out.commands)
  if (described) bits.push(described)
  if (out.errors.length) bits.push(out.errors.join('；'))

  if (!bits.length) return '这条指令我没有产生任何动作，换个说法试试？'
  return bits.join('；')
}

function describeCommands(commands) {
  const bits = []
  for (const c of commands) {
    const a = c.args ?? {}
    switch (c.tool) {
      case 'map.flyTo':
        bits.push(`已定位到${a.target}`)
        break
      case 'map.setView':
        bits.push(`已切到${PRESET_TEXT[a.preset] ?? a.preset}视角`)
        break
      case 'map.highlight':
        bits.push(`已高亮${a.target}`)
        break
      case 'layer.show':
        bits.push(`已打开图层：${(a.names ?? []).join('、')}`)
        break
      case 'layer.hide':
        bits.push(`已关闭图层：${(a.names ?? []).join('、')}`)
        break
      case 'layer.isolate':
        bits.push(`已只保留图层：${(a.names ?? []).join('、')}`)
        break
      // 图层清单只有前端知道（每个视图自己持有图层开关），后端这里答不了，
      // 所以只能回一句"正在读"。**不能落到 default 那个分支** ——
      // 那会让用户看到一句「已下发指令：layer.list」，一个英文工具名。
      case 'layer.list':
        bits.push('正在读取当前页面的图层状态')
        break
      case 'report.export':
        bits.push('已开始下载导出文件')
        break
      case 'sim.start':
        bits.push(`已在「${a.site}」启动边坡位移模拟`)
        break
      default:
        bits.push(`已下发指令：${c.tool}`)
    }
  }
  return bits.join('；')
}

/**
 * 兑换确认令牌并真正落库。
 *
 * 顺序是刻意的：**先兑换再执行**。反过来的话，"执行成功但令牌已被别人用掉"
 * 会得到一次无法解释的重复写操作 —— 而一次性兑换正是为了排除这种可能。
 */
export async function confirm({ db, user, token }) {
  initDuner(db)

  const r = redeem(db, token, user)
  if (!r.ok) {
    // 兑换失败也留痕：一个人反复拿过期令牌来兑换，是值得看的信号
    auditWrite(db, user, { tool: '(未兑换)', payload: {}, ok: false, reason: r.reason, message: REDEEM_MESSAGE[r.reason], token })
    return { ok: false, reason: r.reason, reply: REDEEM_MESSAGE[r.reason] }
  }

  const t0 = Date.now()
  const ctx = { db, user, cfg: llmConfig() }
  const out = await runCommit(r.row.tool, r.row.payload, ctx)
  const ms = Date.now() - t0

  auditWrite(db, user, {
    tool: r.row.tool,
    payload: r.row.payload,
    ok: out.kind !== 'error',
    message: out.text ?? out.message ?? '',
    token,
    ms
  })

  const commands = commandsOf(out)
  const described = describeCommands(commands)
  const reply =
    out.kind === 'error'
      ? out.message
      : [out.text, described].filter(Boolean).join('；') || '已执行。'

  return { ok: out.kind !== 'error', reply, card: out.card ?? null, commands, result: out }
}

/**
 * 前端执行完视图指令后回执，闭合审计链路（指导书 4.3）。
 *
 * `auditId` 由前端带回：`cmdId` 是前端造的（后端不知道一条指令会被拆成几次执行），
 * 只有 `auditId` 能把回执那行挂回**是哪一次对话**。没有它，
 * 审计里会出现一堆孤立的 `duner.receipt`，问「这句话到底执行成没有」还得靠时间戳猜。
 */
export function receipt(db, user, body) {
  auditReceipt(db, user, {
    cmdId: body?.cmdId,
    tool: body?.tool,
    ok: body?.ok !== false,
    ms: body?.ms,
    note: body?.note,
    auditId: body?.auditId
  })
  return { ok: true }
}

/** `GET /api/duner/capabilities` —— 面板的「你能干什么」 */
export function capabilities(db) {
  initDuner(db)
  return {
    intents: Object.entries(ALL_INTENTS).map(([id, v]) => ({
      id,
      label: v.label,
      write: Boolean(v.admin),
      emergency: Boolean(v.skipConfirm)
    })),
    tools: schemaForModel().map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })),
    dictCount: countDict(db),
    dict: getDict(db),
    confirmTtlMs: CONFIRM_TTL_MS
  }
}

/** 「你能干什么」的固定话术。**不经过模型** —— 能力清单不该被模型转述走样 */
function helpText() {
  return [
    '我能做这些：',
    '① 导航「带我去北帮3号台阶」',
    '② 图层「打开边坡监测图层」「只显示风险分布」',
    '③ 查询「今天产量怎么样」「设备效率怎么样」',
    '④ 找人找设备「SL-01 在哪」',
    '⑤ 工单与告警「生成处置工单」「确认这条告警」（需管理员）',
    '⑥ 应急「北帮3号台阶有裂缝」（立即匹配预案，不等确认）'
  ].join('\n')
}

export { listTools }
