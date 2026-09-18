/**
 * RuleEngine —— 离线兜底，也是**默认路径**（指导书第 11 节）。
 *
 * ## 为什么规则跑在模型前面，而不是"模型优先、规则兜底"
 *
 * 指导书第 11 节的表把在线写成「LLM 函数调用」、离线写成「规则模板」，
 * 读起来像是模型优先。这里反过来，理由是**指导书自己提的另一条要求**：
 * 「核心指令（NAV/LAYER/QUERY.STATUS）离线 100% 可用」。
 *
 * 要 100%，就不能让核心指令的关键路径上挂着一个会超时、会限流、
 * 会返回空内容（实测 `deepseek-v4-pro` 就返回过 HTTP 200 + 空 content）的外部依赖。
 * 所以顺序是：**规则先判，置信度够就直接执行；不够才去问模型**。
 * 这样核心指令既不花 token 也不受网络影响，模型只负责长尾。
 * 这也是指导书 M6 里点名要的「混合路由（在线 LLM / 离线 RuleEngine）」。
 *
 * ## `guard`：为什么"正则命中"不等于"意图命中"
 *
 * 最初只按正则判命中，上手一测就发现两类错：
 *
 * - `LAYER.SHOW` 的「打开」把 **「打开北帮3号台阶」** 吃掉了 ——
 *   它没有抽出任何图层名，本该是一次导航；
 * - `NAV.FLYTO` 的「去」把 **「过去一小时产量」** 吃掉了 ——
 *   它没有一个真实地名，本该是一次查询。
 *
 * 两个错的形状是同一个：**槽位没抽到东西，却当成了命中**。
 * 所以给规则加了 `guard`：槽位抽出来了才算数，没抽到就往下一条规则走。
 * 这比继续往正则里堆词可靠 —— 正则是"这句话里出现过什么字"，
 * `guard` 问的是"这句话里有没有那个东西"，后者才是意图的定义。
 *
 * ## 匹配顺序是这张表的语义，不是实现细节
 *
 * `RULES` 是**有序**的，第一条命中（且过 guard）即返回。顺序换了行为就变：
 * - 应急排最前：「北帮3号台阶好像有裂缝」同时含地名与"裂缝"，
 *   但它必须走应急通道而不是普通导航；
 * - `LAYER.ONLY` 必须在 `LAYER.SHOW` 之前：「只显示边坡监测」里**含有**「显示」；
 * - `QUERY.LOCATE` 必须在 `NAV.FLYTO` 之前：「带我去1号矿卡」是要找人，
 *   不是要飞到一个叫"1号矿卡"的地方；
 * - `SYS.OUT_OF_SCOPE` 排在业务规则之后但排在 `CHAT.HELP` 之前 ——
 *   「忽略之前的规则」这种注入不该被当成一句普通闲聊。
 */

import { OUT_OF_SCOPE_REPLY } from './intents.mjs'
import {
  KNOWN_PLACES,
  LAYER_ALIASES,
  ENTITY_CODE_RE,
  ENTITY_NUM_RE,
  isKnownPlace,
  OWNER_CANDIDATES
} from './vocab.mjs'

/**
 * 应急触发词。命中即走应急通道，不等确认（指导书 6.3）。
 *
 * ⚠️ 这张表和下面的 `emergencyKind` 必须**互相对得上**：
 * kind 认得出「运输/翻车/车辆/追尾/撞」是运输事故，而触发词表里一个都没有 ——
 * 那这套分类就是**永远走不到的死代码**，矿上真翻了车说一句「主运输道路上翻车了」，
 * 规则引擎认不出，只能落到 LLM 那条路上去，而 LLM 不可用时（离线要求）就是「我没听懂」。
 * 自动生成的用例集第一次跑就是把这条抓了出来。
 *
 * 反过来也**不能**往这里塞宽词：「运输」单独进表的话，
 * 「带我去东帮运输道」——一句普通的导航——会先被应急通道接走，直接跳到派车预案。
 * 所以只收**事故本身**的说法，不收作业面的说法。
 */
const EMERGENCY_WORDS = [
  '裂缝', '滑坡', '塌方', '垮塌', '冒顶', '透水', '涌水', '起火', '着火',
  '爆炸', '事故', '出事了', '快处理', '紧急', '求救', '撤离', '跑', '危险',
  '翻车', '追尾', '撞车', '车祸', '车辆伤害', '车辆事故', '撞人'
]

/** 注入/越界的特征。命中直接拒绝，不猜、不执行 */
const INJECTION_WORDS = [
  '忽略之前', '忽略以上', '忽略上述', 'ignore previous', 'ignore all previous',
  '忘记你的', '忘记之前', '无视规则', '越狱', 'jailbreak', 'system prompt',
  '你的提示词', '开发者模式', 'pretend you are', '假装你是',
  '删除所有', '删除全部', '清空数据库', 'drop table', '格式化'
]

/** 与矿山生产无关的话题特征 —— 用来兜住"和矿山无关"的闲聊 */
const OFF_TOPIC_WORDS = [
  '天气怎么样', '讲个笑话', '写首诗', '写作文', '股票', '彩票', '足球',
  '篮球', '电影', '游戏', '菜谱', '翻译', '编程题', '数学题', '你是谁', '你叫什么'
]

/**
 * 连接词 —— 复合句的切分点（指导书第 12 节明确要求覆盖"多意图复合句"）。
 *
 * `再` 带了个前瞻：不加的话「再次飞到北帮」会被切成 `["", "次飞到北帮"]`，
 * 把一个好好的单意图句子劈成碎片。要求它后面**跟着一个动词**才算连接词。
 */
const CONNECTORS = /(顺便|顺带|并且|然后|同时|接着|再(?=[看查显开关飞导调比])|，|,|；|;|、)/

/** 客套前缀。「带我去北帮」不剥掉的话，宾语抽取看到的开头是"带我" */
const POLITE_PREFIX = /^(?:请|帮我|麻烦|劳驾|给我|带我|我要|我想|你能|你可以|可以|能)+/

/**
 * 纠错词的两种形态（给 `SYS.CORRECT` 的 guard 用，理由写在那条规则上）。
 *
 * `BARE_CORRECT` 是**光杆**的：说完这句就等于说"你刚才那句不对"，
 * 它本身不携带新对象。少一个词就会让用户最顺口的那句纠错掉到"没听懂"去。
 */
const BARE_CORRECT = /(不是这个|不是那个|不是这|不是那|不对|错了|搞错了|弄错了|说错了)/

/** 在问一个值 —— 这类句子里的「应该是」是在问"应该是多少"，不是在纠错 */
const ASK_WORDS = /多少|多大|多长|多高|几点|多久|怎么样|咋样|如何|是什么/

/** 地名按长度降序 —— 「排土场复垦区」必须先于「排土场」被匹配到 */
const PLACES_LONGEST_FIRST = [...KNOWN_PLACES].sort((a, b) => b.length - a.length)

/**
 * 从文本里抠出对象名。返回 null 表示没抠到。
 *
 * 抽不出来时**返回 null 而不是把半截东西当名字** —— 调用方（`NAV.FLYTO` 的
 * guard）靠这个 null 来判断"这次导航没对象，不算命中"。
 */
export function extractTarget(text) {
  if (!text) return null
  const t = String(text).replace(POLITE_PREFIX, '').trim()
  if (!t) return null

  // 带方位的台阶：「北帮3号台阶」。数字与"号/台阶"之间容空格：「北帮 3 号台阶」
  const dirBench = /(北帮|南帮|东帮|西帮)\s*(\d+)\s*号?\s*(台阶|帮|坡)?/.exec(t)
  if (dirBench) return `${dirBench[1]}${dirBench[2]}号台阶`

  // 裸台阶号：「3号台阶」（用户常不带方位）
  const bareBench = /(\d+)\s*号台阶/.exec(t)
  if (bareBench) return `${bareBench[1]}号台阶`

  // 已知地名，长词优先
  for (const k of PLACES_LONGEST_FIRST) if (t.includes(k)) return k

  // 「去/到/看看 X」—— **必须贴在开头**。
  // 不锚定的话「过去一小时产量」会被抠成「一小时产量」，
  // 然后这句查询就被当成一次导航（就是文件头 `guard` 那段记的那个错）。
  const loose = /^(?:去|到|看看|看一下|看下|瞧瞧|带我看|逛逛)\s*([一-龥A-Za-z0-9]{2,8})/.exec(t)
  if (loose) return loose[1]

  return null
}

/**
 * 抠图层名，返回标准化后的数组（可多个：「打开风险分布和边坡监测」）。
 *
 * ## 同一段文字只归一个图层
 *
 * 每个图层记下自己**是被哪个词认出来的**（`needle`）和它在句中的位置，
 * 然后把「落在更长的命中里面」的那些丢掉。
 *
 * 起因是一句话被拆成两个图层：
 *
 * ```
 * 打开人员当日轨迹图层  →  [作业人员定位, 人员当日轨迹]
 *                     ↑ 靠「人员」这个宽别名误认的
 * ```
 *
 * 「人员」是 `作业人员定位` 的别名（「打开人员」确实该开人员定位），
 * 但它同时是「人员当日轨迹」的**前缀** —— 于是用户想看轨迹，
 * 桥接层会顺手把人员定位那一层也打开（`EmergencyView` 里是两个独立开关）。
 * 用户看到的是"它自己动了一个我没说的图层"。
 *
 * 判据用**跨度包含**而不是"名字里有没有"：`人员` 的跨度 [2,4) 落在
 * `人员当日轨迹` 的 [2,8) 里面，长的赢。这一条与 `normalize.mjs` 的
 * 「标准词先占住自己那段」是同一个规矩 —— 那里护的是地名，这里护的是图层名。
 *
 * ⚠️ 只处理**包含**，不处理一般重叠（部分交叠仍会两个都返回）。
 * 实测里出现过的只有包含这一种形状，而为了一个没见过的形状写一段
 * 没被验证过的合并规则，比留着它更危险。
 */
export function extractLayers(text) {
  if (!text) return []
  const low = String(text).toLowerCase()
  const hits = []
  for (const [canonical, aliases] of LAYER_ALIASES) {
    // 认出来的词可能有好几个（「边坡监测」与「边坡」都能认），取最长的那一个
    const needle = [canonical, ...aliases]
      .map((w) => w.toLowerCase())
      .filter((w) => low.includes(w))
      .sort((a, b) => b.length - a.length)[0]
    if (needle) hits.push({ name: canonical, at: low.indexOf(needle), len: needle.length })
  }
  return hits
    .filter((h) => !hits.some((o) => o.len > h.len && o.at <= h.at && o.at + o.len >= h.at + h.len))
    .map((h) => h.name)
}

/**
 * 抠番号（「1号矿卡」「SL-01」）或人名（「张伟在哪」）。
 *
 * 人名那一条**锚定在句首或标点之后**，是刻意的：不锚定的话
 * 「现场人员在哪」会抽出「场人员」这种半截词，然后如实回一句
 * 「没找到场人员」—— 一个用户看不懂的失败，比反问一句更糟。
 * 按人的名字找人本就是长尾，交给 LLM 那条路更合适。
 *
 * ## 真实地名不算人名
 *
 * 「破碎站在哪」按上面的正则能抽出「破碎站」（3 个汉字 + 在哪），
 * 于是整句被 `QUERY.LOCATE` 截胡，走 `entity.find` 去设备表和人员表里
 * 找一个叫「破碎站」的人，如实回一句「没找到破碎站」——
 * 而它明明是**本矿的一个真实地名**，该走导航。
 *
 * 判据用 `isKnownPlace` 而不是"有没有方位词"：地名清单是这里唯一权威的
 * 「这个词指的是一个地方」的证据。所以 `extractEntity` 里认出来的东西
 * 必须**不是**地名，这正是文件头 `guard` 那段说的「槽位有没有抽到那个东西」。
 */
export function extractEntity(text) {
  if (!text) return null
  const t = String(text)
  const code = ENTITY_CODE_RE.exec(t)
  if (code) return code[1].toUpperCase()
  const numed = ENTITY_NUM_RE.exec(t)
  if (numed) return `${numed[1]}号${numed[2]}`
  const named = /(?:^|[，,。！？\s])([一-龥]{2,3})\s*(?:在哪|在哪儿|在哪呢|的位置)/.exec(t)
  if (named && !isKnownPlace(named[1])) return named[1]
  return null
}

/**
 * 抽「这句话点的是哪个点位」—— 查询类意图的 `site` 槽。
 *
 * ## 为什么不能直接用 `extractTarget`
 *
 * `extractTarget` 是最长匹配**地名**的，它认"像地名"的东西，不认"是不是真地方"：
 * 「帮我看看今天产量」剥掉客套前缀后是「看看今天产量」，宽松分支
 * `^(?:去|到|看看|…)` 会把「今天产量」抠出来当对象。
 * 那个值在 `NAV.FLYTO` 上没有危害（`isKnownPlace` 的 guard 会拦住整条规则），
 * 但放进 `site` 槽就是**一个凭空多出来的实体**：计分按误报算，
 * 更要紧的是工具收到 `site="今天产量"` 会去边坡监测点表里找它 —— 找不到，
 * 于是走回领域摘要。一次静默的绕路。
 *
 * 所以这里只放行两种东西，都要求**真的是个点位**：
 * - **已知地名**（含方位词）：`北帮3号台阶`、`北帮`、`尾矿库`；
 * - **设备/监测点编号**：`SL-01`、`1号矿用卡车`。
 *
 * 人名**不要**（`extractEntity` 会给「张伟在哪」抽出人名，而"张伟的位移"
 * 不是一个位置）。所以这里不走 `extractEntity` 的整体，只用它的两个编号正则。
 */
function extractSite(text) {
  if (!text) return null
  const t = String(text)
  const target = extractTarget(t)
  if (isKnownPlace(target)) return target
  const code = ENTITY_CODE_RE.exec(t)
  if (code) return code[1].toUpperCase()
  const numed = ENTITY_NUM_RE.exec(t)
  if (numed) return `${numed[1]}号${numed[2]}`
  return null
}

/**
 * 抽工单事由。
 *
 * 只认用户**明确说了**的三种说法：`事由X` / `原因X` / `因为X`。
 * 抽不出来就返回 `null`，让 `order.create` 反问一句 ——
 * **绝不给默认值**（原来这里写死过 `'超阈值'`，见 ORDER.CREATE 那条上的注释）。
 *
 * 不去从上下文里"推断"事由（比如看到"裂缝"就当事由）是刻意的：
 * 「看看北帮3号台阶有没有裂缝，顺便开张工单」里那个"裂缝"是**要查的东西**，
 * 不是已经确认的原因。把待查的事写成已确认的原因，是往台账里灌假数据。
 */
function extractReason(text) {
  const m = /(?:事由|原因|因为)\s*[:：]?\s*([^，,。；;]{2,24})/.exec(String(text ?? ''))
  return m ? m[1].trim() : null
}

/**
 * 抽责任人。
 *
 * 两条路：显式的「责任人X / 由X负责」，或直接命中真实姓名表。
 * 认不出来返回 `null` 让工具反问 —— 编一个责任人比问一句坏得多
 * （工单会进台账、会被别人当成真名字）。
 */
function extractOwner(text) {
  const t = String(text ?? '')
  const named = OWNER_CANDIDATES.find((n) => t.includes(n))
  if (named) return named
  const m = /(?:责任人|负责人|交给|指派)\s*[:：]?\s*([一-龥]{2,4})/.exec(t)
  return m ? m[1].trim() : null
}

/**
 * 有序规则表。每条：
 *   `intent` 意图 ID、`re` 触发正则、`conf` 基础置信度、
 *   `slots` 槽位抽取、`guard(text, slots)` 准入判定（可选，不写=无条件准入）
 *
 * 置信度是**手写的常数**而不是算出来的分数，这是刻意的：算出来的分数看着更"科学"，
 * 但没人能说清 0.73 和 0.81 的区别意味着什么，而手写常数至少能被检查脚本
 * 逐条断言、改动时一眼看出行为变了。
 */
const RULES = [
  // ---------- 应急通道（最高优先） ----------
  // 故意不设 guard：应急宁可多触发。少触发一次的代价是人命，多触发一次只是多弹张卡。
  {
    intent: 'EMERGENCY.MATCH',
    re: new RegExp(EMERGENCY_WORDS.join('|')),
    conf: 0.95,
    slots: (t) => ({ target: extractTarget(t), ...kindSlot(t) })
  },
  // 资源调配 —— 与 MATCH 同属应急通道，但**只出建议卡片**（指导书 §5.3：
  // 严禁自动指令真实设备）。排在 MATCH 之后：含事故词的话先匹配预案。
  {
    intent: 'EMERGENCY.DISPATCH',
    re: /(调配|调派|派谁|谁来救|救援资源|救援力量|救援队伍|怎么调|物资调|救护)/,
    conf: 0.9,
    slots: (t) => ({ ...kindSlot(t), target: extractTarget(t), advise: true })
  },

  // ---------- 越界/注入：必须先于业务规则 ----------
  {
    intent: 'SYS.OUT_OF_SCOPE',
    re: new RegExp([...INJECTION_WORDS, ...OFF_TOPIC_WORDS].join('|'), 'i'),
    conf: 0.99,
    slots: (t) => ({
      reason: INJECTION_WORDS.some((w) => t.toLowerCase().includes(w.toLowerCase())) ? 'injection' : 'off_topic'
    })
  },

  // ---------- 纠错（指导书 §6 的 SYS.CORRECT） ----------
  //
  // 排在越界之后、业务规则之前：纠错句里往往**带着新对象**
  // （「不是这个，我说的是东帮」），排在业务规则之后的话，
  // 「我说的是东帮」会先被 NAV.FLYTO 接走 —— 结果一样是飞东帮，
  // 但走的是"一句普通导航"，回话里不会带「已改成」，
  // 用户听不出助手是否意识到他刚才说错了。
  //
  // ## 两种说法，准入条件不同
  //
  // - **光杆**「不是这个」「不对」——本身就指向上一句，不含新对象。
  //   这类必须在规则层放行（抽不到东西也准），由编排层反问「你想改成哪儿？」。
  // - **带对象**「我说的是东帮」「改成南帮」「应该是尾矿库」——
  //   要有新对象才算纠错，抽不出来就往下走。
  //
  // ⚠️ **问值的话不当纠错**（`ASK_WORDS`）。反例是真会说的：
  // 「3号台阶位移应该是多少」——它含「应该是」，也能抽到 `target=3号台阶`
  // （`extractTarget` 的裸台阶号分支），照上面两条判就是个标准的"带对象纠错"，
  // 于是想查个数的人会得到一句「你想改成哪儿？」。
  // 判据取"这句话在不在问一个值"，而不是继续往词表里加否定词 ——
  // 加了「应该是多少」还会有「应该是几点」。
  {
    intent: 'SYS.CORRECT',
    re: /(不是这个|不是那个|不是这|不是那|我说的是|我是说|我指的是|说错了|搞错了|弄错了|不对|改成|换成|应该是)/,
    conf: 0.9,
    slots: (t) => ({ target: extractTarget(t) ?? extractEntity(t) }),
    guard: (t, s) => !ASK_WORDS.test(t) && (BARE_CORRECT.test(t) || Boolean(s.target))
  },

  // ---------- 帮助 ----------
  {
    intent: 'CHAT.HELP',
    re: /(你能干什么|你会什么|有什么功能|能做什么|帮助|怎么用|使用说明|help)/i,
    conf: 0.95,
    slots: () => ({})
  },

  // ---------- 图层：ONLY 必须在 SHOW 之前 ----------
  // 三条都带 guard：抽不到图层名的「打开」不是图层指令（见文件头）。
  {
    intent: 'LAYER.ONLY',
    re: /(只(给我)?(显示|看|留|要)|仅(显示|看)|单独(显示|看)|isolate)/,
    conf: 0.92,
    slots: (t) => ({ names: extractLayers(t) }),
    guard: (_t, s) => (s.names?.length ?? 0) > 0
  },
  {
    intent: 'LAYER.HIDE',
    re: /(关掉|关闭|隐藏|收起来|去掉|撤掉|不显示|别显示|hide)/i,
    conf: 0.9,
    slots: (t) => ({ names: extractLayers(t) }),
    guard: (_t, s) => (s.names?.length ?? 0) > 0
  },
  {
    intent: 'LAYER.LIST',
    re: /(有哪些图层|图层列表|列一下图层|都有什么图层|show.*layer)/i,
    conf: 0.9,
    slots: () => ({})
  },
  {
    intent: 'LAYER.SHOW',
    re: /(打开|显示|展示|调出|show)/i,
    conf: 0.9,
    slots: (t) => ({ names: extractLayers(t) }),
    guard: (_t, s) => (s.names?.length ?? 0) > 0
  },

  // ---------- 视角 ----------
  {
    intent: 'NAV.VIEW',
    re: /(俯瞰|俯视|全景|全局|鸟瞰|正射|顶视|看全|整个采场|一览)/,
    conf: 0.9,
    slots: (t) => ({ preset: /俯瞰|俯视|鸟瞰|顶视/.test(t) ? 'top' : 'overview' })
  },

  // ---------- 找人/找设备：必须在 NAV.FLYTO 之前 ----------
  // guard 要求真的抽到编号/人名，否则「带我去北帮3号台阶」会被这里截胡。
  {
    intent: 'QUERY.LOCATE',
    re: /(在(哪|哪儿|哪边)|的位置|在哪呢|找到|带我去|去|到|看看|看一下|瞧|找)/,
    conf: 0.88,
    slots: (t) => ({ query: extractEntity(t) }),
    guard: (_t, s) => Boolean(s.query)
  },

  // ---------- 导航 ----------
  //
  // `在哪/在哪儿/的位置` 这几个问法**两边都要有**，这是刻意的：
  // 「1号矿卡在哪」是找人（上面 `QUERY.LOCATE`），「破碎站在哪」是导航。
  // 两条规则用同一个触发词、靠 `guard` 分开 —— 上面那条要抽到编号/人名，
  // 这条要抽到真实地名（`extractEntity` 现在会把地名排掉，见它的注释）。
  // 少写这条的话，「破碎站在哪」会掉到模型那条路上去，
  // 而它明明是本矿最普通的一个地名。
  {
    intent: 'NAV.FLYTO',
    re: /(带我去|带我看看|带我看|去|到|飞到|飞往|定位到|导航到|看看|看一下|看下|瞧瞧|打开看看|打开|调出|在哪|在哪儿|在哪呢|的位置)/,
    conf: 0.88,
    slots: (t) => ({ target: extractTarget(t), highlight: true }),
    guard: (_t, s) => isKnownPlace(s.target)
  },

  // ---------- 列表：必须在写操作之前 ----------
  // `ORDER.CREATE` 的正则里有裸「工单」，不先拦住的话「查看工单」会被当成"生成工单"，
  // 于是查个列表反而弹出一张确认卡（还要管理员权限）。
  // 靠 `列表|有哪些|查看|待办` 这些词把两者分开：「生成工单」不含它们。
  {
    intent: 'ORDER.LIST',
    re: /(工单列表|有哪些工单|查看工单|工单情况|待办事项|我的待办|派工情况)/,
    conf: 0.9,
    slots: () => ({})
  },
  {
    intent: 'ALARM.LIST',
    re: /(告警列表|报警列表|有哪些告警|未处理告警|告警情况|有哪些报警)/,
    conf: 0.9,
    slots: () => ({})
  },

  // ---------- 写操作 ----------
  //
  // ⚠️ `EXPORT.RUN` 必须排在 `ORDER.CREATE` **前面**，理由与 `ORDER.LIST`
  // 排在最前是同一个：`ORDER.CREATE` 的正则里有一条裸「工单」，
  // 它会吃掉「**导出工单**」—— 于是想下载一份台账的人，
  // 收到的是一张"要生成工单"的确认卡（还要求管理员权限）。
  // 抽出「导出一份告警」的那个 `dataset` 分支本来就是为下载写的，
  // 是这条排序把它挡在了后面。
  //
  // 反过来不会误伤：`EXPORT.RUN` 认的是导出动词（导出/下载/出一份），
  // 「生成工单」里一个都没有。
  {
    intent: 'EXPORT.RUN',
    re: /(导出|下载|生成报表|出一份|导一份)/,
    conf: 0.88,
    // `dataset` 必须在这里就抽出来：抽不到的话 `report.export` 只能反问一句
    // "要导出哪份数据"，而用户其实已经说了（"导出质检记录"）。
    // 抽不到时**留空**让工具去问，不默认成 quality —— 默认成质检记录
    // 会让"导出告警"导出一份质检表，且用户要到打开文件才发现。
    slots: (t) => ({
      format: /excel|xlsx|表格/i.test(t) ? 'xlsx' : /pdf/i.test(t) ? 'pdf' : 'csv',
      dataset: /质检|质量|检验/.test(t) ? 'quality' : /工单|派工|待办/.test(t) ? 'orders' : /告警|报警/.test(t) ? 'alarms' : undefined
    })
  },
  {
    intent: 'ORDER.CREATE',
    re: /(生成|开|建|下|派)(一张|个|条)?(工单|派工|处置单)|工单|派单/,
    conf: 0.88,
    /**
     * ⚠️ `reason` 抽不出来时**留空**，绝不写死一个。
     *
     * 这里原来写的是 `reason: '超阈值'`。看着无害（"总得有个事由"），
     * 实际是把一句**用户没说过的话写进台账**：他说「给1号矿卡开张工单」，
     * 工单上就印着"超阈值"，而他从头到尾没提过阈值。
     * 更坏的是它让工具里那句 `if (!reason) 反问` 成了**死代码** ——
     * 反问路径永远走不到，也就永远不会有人发现事由是编的。
     *
     * 留空之后 `order.create` 会反问一句，并给出几个常见事由当选项。
     */
    slots: (t) => ({
      // 地名优先，其次是设备（「给1号矿卡开张工单」的对象是台设备而不是地点）
      target: extractTarget(t) ?? extractEntity(t),
      reason: extractReason(t),
      owner: extractOwner(t)
    })
  },
  {
    intent: 'ALARM.ACK',
    re: /(我知道(这条|了)|确认告警|告警确认|确认[^，。]{0,12}告警|这条告警|收到告警|已阅)/,
    conf: 0.88,
    // 对象抽不出来时**留空**，由 `alarm.ack` 反问 —— 它会把当前告警摆出来让用户挑。
    // 规则这里猜错一个设备名，就是替用户确认了别人的告警。
    //
    // 能抽出来的两种说法：「确认破碎一的告警」和「确认告警 破碎一」。
    // 前者是澄清选项的原样（选项文本必须能被送回来，见 writeTools.mjs 那段），
    // 后者是人翻着告警列表念出来的。
    slots: (t) => ({
      device:
        /(?:确认|处置|处理|核实)\s*([^\s，。]{2,10}?)\s*的\s*(?:告警|报警|预警)/.exec(t)?.[1] ??
        /(?:确认|处置|处理|核实)\s*(?:告警|报警|预警)\s*[：:]?\s*([^\s，。]{2,10})/.exec(t)?.[1]
    })
  },
  {
    intent: 'DECISION.ADOPT',
    // 末尾那个 `[」』]` 是为澄清选项留的：选项文本长这样「采纳「生产计划优化」」，
    // 用户点一下就是把这句话原样发回来 —— 少认一种写法，选项就成了死路。
    re: /(采纳|批准|同意|按这个)[^，。]{0,16}(建议|方案|决策|条|[」』])/,
    conf: 0.88,
    // 建议编号抽不出来时留空，由 `decision.adopt` 反问 —— 四条建议里替他挑一条
    // 等于替他做了决策，而"采纳建议"正是要落到某个人头上的动作。
    // 认编号（第1条 / #1 / 1号）也认书名号里的建议名，两者都能对上工具那张表。
    slots: (t) => {
      const num = /(?:第|#|＃)\s*(\d+)/.exec(t) ?? /(\d+)\s*[条号]/.exec(t)
      const name = /[「『"]([^」』"]{2,20})[」』"]/.exec(t)
      return { id: num ? Number(num[1]) : undefined, name: name?.[1] }
    }
  },
  {
    intent: 'SIM.START',
    // ⚠️ 这里**不能**写成 `(边坡|位移)?` —— 那个可选组只能匹配其中之一，
    // 而最自然的那句话是「开始边坡位移模拟」，两个词连着出现，
    // 正则走到「位移模拟」时匹配不上就整条落空，用户说的话明明最普通。
    re: /(开始|启动|播放|演示|来一段|跑一下)\s*(?:边坡|位移|地表|滑移|岩移|变形){0,3}\s*(模拟|动画|演练)/,
    conf: 0.88,
    slots: (t) => ({ site: extractTarget(t) })
  },

  // ---------- 查询 ----------
  //
  // ⚠️ 两条都带 `site`，这是本轮修的那个真缺陷。
  //
  // 「北帮3号台阶现在位移多少」原来抽出 `domains=['safety']`（「位移」归安全），
  // 于是 `data.query(safety)` 如实答的是风险源与隐患闭环 —— **一个位移数字都没有**。
  // 而位移数据就在 `twinSlopeSites` 里（SL-01 是 26.4mm），`entity.find` 早就查得到。
  //
  // 更值得记一笔的是：测试集里这条用例的期望写的就是 `domain=safety`，
  // **判据把错的答案固化成了期望**，所以全绿。缺口不在实现，在判据。
  // 所以这里补槽位的同时，fixture 里那条期望也一并改成 `place`（见该文件）。
  //
  // 槽位只影响"点了名"的句子：`extractSite` 抽不到东西时给 null，
  // 空的槽不进计分（`check-duner.mjs` 里跳过 null/''），于是没点名的查询
  // 仍然只算出 `domains` 一项。
  {
    intent: 'QUERY.SUMMARY',
    re: /(汇总|总结|概况|整体情况|总体情况|综合)/,
    conf: 0.9,
    slots: (t) => ({ domains: extractDomains(t), site: extractSite(t) })
  },
  {
    intent: 'QUERY.STATUS',
    re: /(怎么样|咋样|如何|多少|是多少|什么情况|状态|情况|效率|产量|告警)/,
    conf: 0.85,
    slots: (t) => ({ domains: extractDomains(t), site: extractSite(t) })
  }
]

/**
 * 事故类型 → 预案 key。**返回值必须与 `src/mock/emergency.ts` 的四个 `key` 一致**
 * （landslide / blasting / haul / flood），否则 `plan.match` 会一份预案都匹配不到。
 *
 * `fire` 是**故意留着的不匹配项**：本矿四份预案里没有消防专项预案，
 * 返回一个凑数的 key 会让"着火了"匹配到「运输事故预案」—— 应急指引凑错方向
 * 不是体验问题，是给人错的行动指令。宁可如实回一句"没有这一类"。
 *
 * ## 认不出来返回 `null`，**不兜底成 `landslide`**
 *
 * 兜底的那个版本实测长这样：用户问「派谁去救」（没说事故类型），
 * 助手答「已匹配《边坡滑坡事故专项应急预案》（Ⅱ级）」——
 * **凭空认定了这是一起滑坡**，然后把五步处置指引摆出来。
 * 说的人和看的人都不会意识到这个类型是编的：句子通顺、名词都对、数字是真的。
 *
 * 这和 `extractDomains` 认不出领域时返回空数组是同一条规矩（那里写了整段理由）：
 * 把握不足就反问。认不出类型时不带 `kind` 槽，`plan.match` 会反问
 * 「是哪一类事故？」并把四份预案的**全名**当选项 —— 全名能被规则引擎原样读懂
 * （含"滑坡/事故/透水"这些触发词），用户点一下就能接着走完这一趟。
 */
function emergencyKind(text) {
  if (/滑坡|塌方|垮塌|裂缝|边坡/.test(text)) return 'landslide'
  if (/爆炸|爆破/.test(text)) return 'blasting'
  if (/透水|涌水|水害|积水/.test(text)) return 'flood'
  if (/运输|翻车|车辆|追尾|撞/.test(text)) return 'haul'
  if (/起火|着火|火灾|火情/.test(text)) return 'fire'
  return null
}

/**
 * `kind` 这个槽：认得出才带，认不出**整个键都不出现**。
 *
 * 写成 `kind: emergencyKind(t)` 再让下游把 `null` 当"没给"处理，多了一道
 * "谁知道 null 是什么意思"的默契；不带键则是同一件事里唯一说得清的那种写法
 * （`plan.match` 的 `String(args.kind ?? '')` 对两者一视同仁，但读代码的人不用想）。
 */
function kindSlot(text) {
  const k = emergencyKind(text)
  return k ? { kind: k } : {}
}

/**
 * 从一句话里认领域。
 *
 * ⚠️ 认不出来时**返回空数组，不返回 `['production']`**。
 *
 * 原来这里兜底成生产领域，看着"总能答上一句"，实际是最坏的一种失败：
 * 用户问「那个台阶位移多少」，命中的是他不认识的任何一个领域，
 * 得到的却是「今日生产量 27.8 吨」—— 数字是真的、答的是别的问题，
 * 而且**看不出答错了**。`data.query` 拿到空数组会反问一句"你想看哪一块"，
 * 那比一个静默的错答案好得多（指导书第 2 节：把握不足就反问，不许猜）。
 */
function extractDomains(text) {
  const d = []
  if (/产量|生产|进尺|车数/.test(text)) d.push('production')
  // 位移/沉降/边坡/监测 归安全：它们在平台上就是边坡监测那套数据，
  // 而"位移多少"是大屏前最常问的一句
  if (/告警|报警|隐患|安全|风险|位移|沉降|边坡|监测/.test(text)) d.push('safety')
  if (/设备|钻机|卡车|铲车|效率|维保/.test(text)) d.push('equipment')
  if (/成本|费用|电费|能耗|吨成本/.test(text)) d.push('cost')
  if (/人员|人数|出勤/.test(text)) d.push('personnel')
  return d
}

/**
 * 在连接词处切分。**只做切分，不做合并** ——
 * 「切开的碎片要不要并回去」需要知道每条碎片能不能识别成意图，
 * 那是 `classify` 的事（`regroup`），放在这里会让这个函数不再纯粹。
 */
export function splitClauses(text) {
  if (!text) return []
  return String(text)
    .split(new RegExp(`(?:${CONNECTORS.source})`))
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
}

/**
 * 在"动词边界"再切一刀：「飞到尾矿库打开避灾路线」中间没有连接词，
 * 但显然有两个动作。切点是**图层动词**，条件是它前面那截确实在说一个对象。
 *
 * 条件卡得比较紧（前面得是个真地名，或已经出现了一个图层名），
 * 是为了不误伤「打开边坡监测」这种单个动词开头的句子 —— 那种不切。
 */
const NEW_VP_RE = /(打开|关闭|隐藏|调出|只显示|仅显示)/g

function splitAtVerbBoundaries(text) {
  const re = new RegExp(NEW_VP_RE.source, 'g')
  let m
  while ((m = re.exec(text))) {
    if (m.index === 0) continue
    const before = text.slice(0, m.index)
    const isObject = isKnownPlace(extractTarget(before)) || extractLayers(before).length > 0
    if (!isObject) continue
    const rest = text.slice(m.index)
    // 后半段可能还有下一个动词（「去A打开B关闭C」）
    return [before.trim(), ...splitAtVerbBoundaries(rest)]
  }
  return [text.trim()]
}

/** 对单个子句跑规则表，返回第一条**过了 guard** 的命中 */
function classifyClause(text) {
  for (const rule of RULES) {
    if (!rule.re.test(text)) continue
    let slots = {}
    try {
      slots = rule.slots(text) ?? {}
    } catch {
      slots = {}
    }
    if (rule.guard && !rule.guard(text, slots)) continue
    return { intent: rule.intent, slots, confidence: rule.conf }
  }
  return null
}

/**
 * 带字段名的碎片该并给谁。
 *
 * 起因是一个真实说法的静默失败：
 *
 * ```
 * 生成处置工单，对象北帮3号台阶，事由裂缝，责任人王建国
 * ```
 *
 * 按逗号切开后，「事由裂缝」自己会命中应急规则（有「裂缝」），于是它**占住了**
 * 一个位置。后面那句「责任人王建国」再往前并时并到的是紧挨着的应急那条，
 * 而应急规则没有 `owner` 这个槽 —— **责任人就静静地没了**。
 * 用户明明报了名字，收到的却是一句「责任人是哪个」。
 *
 * 所以带字段名的碎片要并给**前面最近的、声明了那个字段的意图**，
 * 而不是紧挨着的那一个。判定"有没有这个字段"看的是意图抽出来的槽位键 ——
 * 抽不出来也会带着键（值是 null），所以键在就说明这个意图管这个字段。
 */
const LABELED_FIELDS = [
  ['owner', /^\s*(?:责任人|负责人|指派|交给)/, extractOwner],
  ['reason', /^\s*(?:事由|原因|因为)/, extractReason],
  ['target', /^\s*(?:对象|目标|地点)/, (t) => extractTarget(t) ?? extractEntity(t)]
]

/** 从后往前找第一个声明了该槽位的段落。找不到返回 -1 */
function lastWithSlot(segs, field) {
  for (let i = segs.length - 1; i >= 0; i--) {
    const hit = classifyClause(segs[i].text)
    if (hit && field in (hit.slots ?? {})) return i
  }
  return -1
}

/**
 * 把切出来的碎片并成段落。每段是 `{ text, fields }`。
 *
 * ## 两件不同的事：并文字 vs 挂字段
 *
 * 「打开风险分布、边坡监测」在顿号处切开，后一段「边坡监测」自己什么都不是 ——
 * 它是前一段的宾语，所以**文字并回去**才抽得到两个图层名。
 *
 * 而「…，事由裂缝，责任人王建国」里的那两段是**字段值**，不是话。
 * 它们要挂到前面那个声明了该字段的意图上（`fields`），
 * **不能并进文字**。并进去会踩到两个坑，实测各踩过一次：
 *
 * 1. 并进去之后整段变成一句话，段落重跑规则表时，
 *    排在最前面的应急规则看到「裂缝」就直接命中 —— 工单意图整个消失。
 * 2. 不带分隔符并过去会拼出 `事由裂缝责任人王建国`，
 *    而事由抽的是"到下一个标点为止"，于是事由变成七个字。
 *
 * 挂成 `fields` 之后，字段值不参与意图判定，只在最后并进槽位。
 */
function regroup(segments) {
  const out = []
  for (const seg of segments) {
    if (!seg) continue

    const labeled = LABELED_FIELDS.find(([, re]) => re.test(seg))
    if (labeled) {
      const [field, , extract] = labeled
      const value = extract(seg)
      const at = lastWithSlot(out, field)
      // 抽不出值（比如只说了「事由」两个字）就不当字段处理，
      // 让它走下面的普通路径，别把这句话整段吃掉
      if (value && at >= 0) {
        out[at].fields[field] = value
        continue
      }
    }

    if (!classifyClause(seg) && out.length) {
      out[out.length - 1].text += seg
      continue
    }
    out.push({ text: seg, fields: {} })
  }
  return out
}

/**
 * 主入口：识别一句话（可含多个意图）。
 *
 * @returns {{intents:{intent:string,slots:object,confidence:number}[], confidence:number, source:'rule'|'none'}}
 *   `intents` 为空数组表示规则引擎认不出来 —— 由调用方决定去问模型还是反问用户。
 */
export function classify(text) {
  if (!text || !text.trim()) return { intents: [], confidence: 0, source: 'none' }

  const segments = splitClauses(text).flatMap(splitAtVerbBoundaries)
  const clauses = regroup(segments)
  const hits = []
  const seen = new Set()

  // ⚠️ `clause` 是 `{text, fields}` 而不是字符串（见 regroup）。
  // 意图判定只看 `text`；`fields` 是带字段名的碎片挂上来的**字段值**，
  // 它不参与规则匹配 —— 参与了就会让「事由裂缝」这种片段自己命中央急规则。
  for (const clause of clauses.length ? clauses : [{ text, fields: {} }]) {
    const hit = classifyClause(clause.text)
    if (!hit) continue
    hit.slots = mergeSlots(hit.slots, clause.fields)
    // 同一意图在复合句里出现两次就把槽位并起来（"打开风险分布、边坡监测"）
    if (seen.has(hit.intent)) {
      const prev = hits.find((h) => h.intent === hit.intent)
      if (prev) prev.slots = mergeSlots(prev.slots, hit.slots)
      continue
    }
    seen.add(hit.intent)
    hits.push(hit)
  }

  if (!hits.length) return { intents: [], confidence: 0, source: 'none' }

  // 整句置信度取最高的那条：一句话里只要有一个高置信意图，就不该被低置信的拖去反问
  const confidence = Math.max(...hits.map((h) => h.confidence))
  return { intents: hits, confidence, source: 'rule' }
}

function mergeSlots(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v === undefined || v === null) continue
    if (Array.isArray(out[k]) && Array.isArray(v)) out[k] = [...new Set([...out[k], ...v])]
    else if (Array.isArray(out[k]) && typeof v === 'string') out[k] = [...new Set([...out[k], v])]
    else if (Array.isArray(v) && typeof out[k] === 'string') out[k] = [...new Set([out[k], ...v])]
    // ⚠️ `null` 也要能被覆盖，不能只判 `undefined`。
    // 抽取器抽不到东西时返回的是 **null**（`extractTarget` 那类函数就是这么写的，
    // 因为 `NAV.FLYTO` 的 guard 靠 null 判断"这次没对象"）。
    // 只判 undefined 的话，一个 null 槽位会把后面**真的抽到了**的值挡掉 ——
    // 「生成处置工单，对象北帮3号台阶」就会反问"要处置哪个对象"，
    // 而用户明明说了。这种"抽到了却被丢掉"的错不报任何异常。
    else out[k] = out[k] === undefined || out[k] === null ? v : out[k]
  }
  return out
}

export { OUT_OF_SCOPE_REPLY }
