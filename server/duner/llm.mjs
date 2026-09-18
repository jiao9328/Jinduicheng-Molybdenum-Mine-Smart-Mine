/**
 * DeepSeek 适配器 —— 只负责「规则认不出来时，把话交给模型」。
 *
 * ## 三条实测出来的硬约束（不是推测，动手前逐条验过）
 *
 * 1. **工具名不能带点号。** OpenAI 兼容协议的工具名要匹配 `^[a-zA-Z0-9_-]{1,64}$`。
 *    用指导书里的 `map.flyTo` 发过去是 **HTTP 400**，换成 `map_flyTo` 立刻正常。
 *    所以内部逻辑名保留指导书的点号写法（`map.flyTo`），**上线时转成下划线**，
 *    收回来再转回去 —— `toWireName` / `fromWireName` 就是干这个的。
 *    这条错得很隐蔽：报错信息是 `Failed to parse the request body`，
 *    看着像 JSON 写坏了，其实是名字里有非法字符。
 *
 * 2. **`deepseek-v4-pro` 会返回 HTTP 200 + 空 content。** `flash` 正常。
 *    所以下面判断成功用的是「有没有拿到 tool_calls 或非空 content」，
 *    **不是**看状态码 —— 只看状态码会把一个空回复当成成功，然后回一句空话给用户。
 *
 * 3. **中文必须用 node `fetch` 发，不能用 `curl -d`。** 本机 curl 按 GBK 编码，
 *    服务端收到的是乱码（既有坑，README 里记过）。这里用 fetch，天然没这问题。
 *
 * ## 超时为什么必须存在且明显小于前端
 *
 * 前端 `src/api/http.ts` 的 `TIMEOUT` 是 15s。后端如果不设上限地等，
 * 会出现「前端已经报失败、后端还在跑并写审计」的错账。所以这里
 * 用 AbortController 卡在 8s（`config.mjs` 可配），超时即回落规则引擎。
 * 实测这个模型跑函数调用是 0.7~1.9s，8s 有 4 倍以上余量。
 */

/**
 * 系统提示词 —— 指导书第 10 节的模板，按本项目的实际工具集改写。
 * 里面每一条「规则」都不是靠模型自觉：写操作的确认在 `ConfirmManager` 里强制，
 * 越界拒绝在 `rule.mjs` 里有独立通道。提示词只是**让模型少犯错**，
 * 不是安全边界 —— 这是指导书第 2 节第 6 条的同一个意思。
 */
const SYSTEM_PROMPT = `你是「墩儿」，金堆城钼矿智慧矿山综合管控平台的 AI 副驾。
职责是把用户的自然语言指令转化为平台工具调用，让非 GIS 专业人员也能直接指挥三维矿山平台。

【核心规则】
1. 你只能输出两类内容：a) 面向用户的简短中文回复；b) 工具调用。禁止编造执行结果。
2. 工具返回什么你报告什么，禁止编造产量、告警、设备状态等数据。
3. 矿山术语按词典归一化："三号台阶"="3号台阶"；"大车"="矿用卡车"；"大坑"="露天采坑"。
4. 回复 ≤ 80 字（大屏环境，信息要短）。
5. 与矿山生产无关的问题一律拒绝，话术：「我是墩儿，专注这座矿的生产指挥，这个问题超出我的岗位范围。」
6. 拿不准就反问，给 2~4 个候选让用户点选，禁止猜测执行。
7. 涉及工单、告警确认、导出、采纳建议这类写操作，**不要自己判断要不要确认** ——
   照常发起工具调用即可，平台会自己弹确认卡片。你只要把参数填对。

【本矿的真实对象】（用这些，不要编）
- 区域：露天采坑、排土场、尾矿库、选矿厂、粗碎站、皮带廊
- 方位与台阶：北帮/南帮/东帮/西帮 + 数字 + 台阶（如"北帮3号台阶"）
- 设备：1#~3# 牙轮钻机、1#~3# 矿用卡车、1#~2# 前装机
- 监测点：北帮3号台阶(SL-01)、东帮5号台阶、南帮2号台阶、西帮4号台阶、北帮6号台阶
- 图层：边坡监测、风险分布、设备效率、作业人员定位、定位基站、人员当日轨迹、避灾路线

【示例】
用户："带我去北帮3号台阶，看看边坡"
你：map_flyTo({target:"北帮3号台阶"}) + layer_show({names:["边坡监测"]})

用户："今天产量咋样"
你：data_query({domain:"production"})

用户："给SL-01生成处置工单"
你：order_create({target:"北帮3号台阶", reason:"位移26.4mm 超阈值20mm"})`

/**
 * 逻辑名 ↔ 线上名。点号 ↔ 下划线（约束 1）。
 * 用 `[._]` 互转而不是只换点号，是为了容忍模型偶尔写错分隔符。
 */
export const toWireName = (logical) => String(logical).replace(/\./g, '_')
export const fromWireName = (wire) => String(wire).replace(/_/g, '.')

/** 把工具注册表转成 OpenAI 兼容的 tools 数组 */
export function buildToolSchema(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: toWireName(t.name),
      description: t.description,
      parameters: t.parameters ?? { type: 'object', properties: {} }
    }
  }))
}

/**
 * 问模型。
 *
 * @returns {Promise<{intents:{intent:string,slots:object,confidence:number}[],
 *                     reply?:string, source:'llm', degraded?:string}>}
 *   失败时 `intents` 为空、`degraded` 写明原因 —— **不抛异常**。
 *   调用方拿到空结果会回落到规则引擎或反问，不该因为模型挂了就整个请求 500。
 */
export async function askModel({ text, cfg, tools, context }) {
  if (!cfg.available) return { intents: [], source: 'llm', degraded: 'no_key' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 500,
        tools: buildToolSchema(tools),
        tool_choice: 'auto',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          // 上下文按指导书第 3 节注入。**只给模型它真能用上的字段** ——
          // 把整个页面状态塞进去既费 token，也让模型更容易对着无用信息乱猜。
          { role: 'user', content: buildUserMessage(text, context) }
        ]
      }),
      signal: controller.signal
    })

    const body = await res.json().catch(() => null)

    // 约束 2：不看状态码看内容。200 + 空 content 是实测发生过的
    const message = body?.choices?.[0]?.message
    const toolCalls = message?.tool_calls
    const content = (message?.content ?? '').trim()

    if (!toolCalls?.length && !content) {
      return { intents: [], source: 'llm', degraded: `empty_response(http_${res.status})` }
    }

    const intents = (toolCalls ?? []).flatMap((call) => {
      const name = call?.function?.name
      if (!name) return []
      let args = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        return [] // 参数不是合法 JSON 就丢掉这条，别拿半个参数去执行
      }
      return [
        {
          intent: fromWireName(name),
          slots: args,
          // 模型的置信度一律记 0.7：它没给分数，编一个"看起来精确"的数字
          // 比给个保守值更糟。要区分的是「规则命中」与「模型猜的」这两类。
          confidence: 0.7
        }
      ]
    })

    return { intents, reply: content || undefined, source: 'llm' }
  } catch (err) {
    const degraded = err?.name === 'AbortError' ? `timeout_${cfg.timeoutMs}ms` : `network_${err?.message ?? 'error'}`
    return { intents: [], source: 'llm', degraded }
  } finally {
    clearTimeout(timer)
  }
}

function buildUserMessage(text, context) {
  if (!context) return text
  const bits = []
  if (context.pageTitle) bits.push(`当前页面：${context.pageTitle}`)
  if (context.role) bits.push(`用户角色：${context.role === 'admin' ? '管理员' : '普通用户'}`)
  if (context.visibleLayers?.length) bits.push(`当前可见图层：${context.visibleLayers.join('、')}`)
  return bits.length ? `【上下文】${bits.join('；')}\n【用户说】${text}` : text
}
