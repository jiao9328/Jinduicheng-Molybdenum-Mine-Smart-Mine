/**
 * 词表 —— 地名与图层名。**规则引擎与视图工具共用这一份**。
 *
 * ## 为什么单独成模块
 *
 * 这两个表有两个互不相干的消费者：
 * - `rule.mjs`（规则引擎）需要它判断**「这句话是不是在说一个真实存在的地名」**，
 *   用来当 `NAV.FLYTO` 的准入条件；
 * - `tools/viewTools.mjs` 需要它给模型写工具说明、并在生成指令时标注 `known`。
 *
 * 一开始放在 `viewTools.mjs` 里，于是规则引擎要 import 工具层 —— 方向是反的
 * （规则引擎是工具无关的），而且会诱导后来的人往这里塞"顺手能用"的东西。
 * 拆出来之后依赖是单向的：`vocab ← rule`、`vocab ← tools`。
 *
 * ## 坐标为什么**不**在这里
 *
 * 真正的坐标在前端（`src/scene/sceneTargets.ts` 的 `AREA_ANCHORS`、
 * `sceneConfig.ts` 的 `SCENE_WAYPOINTS`）。后端拿不到也不该拿 ——
 * 复制一份坐标过来，前端一搬厂就两边不一致，且**没人会发现**。
 *
 * 但后端确实需要一份**名字清单**，否则它没法回答「这个地名我认不认识」：
 * 不认识的应该反问用户，而不是发一条注定失败的指令下去、等前端回执说找不到。
 * 「认不认识」是**名字**的问题，「在哪」才是坐标的问题 —— 两者分开。
 *
 * 代价是这份名单可能与前端漂移。所以 `scripts/check-duner.mjs` 里有一条
 * 断言直接读 `src/scene/sceneTargets.ts` 与 `src/scene/sceneConfig.ts` 的源码文本
 * 做比对（本仓库既有的漂移检查范式，见 `check-auth.mjs` 读 `auth.mjs` 的做法）。
 */

/** 与 `src/scene/sceneTargets.ts` 的 `AREA_ANCHORS` 对齐 */
export const AREA_NAMES = [
  '北帮采剥面',
  '主运输道路',
  '东帮爆破区',
  '坑底集水池',
  '排土场复垦区',
  '排土场',
  '尾矿库',
  '厂区',
  '选矿厂'
]

/** 与 `src/scene/sceneConfig.ts` 的 `SCENE_WAYPOINTS` 的 label 对齐 */
export const WAYPOINT_NAMES = ['露天采坑', '粗碎站', '选矿厂', '皮带廊', '排土场', '尾矿库']

/**
 * 与 `src/mock/digitalTwin.ts` 的设备/监测点 `area` 字段对齐
 * （"北帮3号台阶" 同时是 SL-01 与 DR-01 的 area）
 */
export const SITE_NAMES = [
  '北帮3号台阶',
  '北帮4号台阶',
  '北帮5号台阶',
  '北帮6号台阶',
  '东帮5号台阶',
  '南帮2号台阶',
  '西帮4号台阶',
  '东帮运输道',
  '南帮运输道',
  '北帮装载点'
]

/**
 * 方位 —— 它**也是**一个能去的地方。
 *
 * ## 为什么必须进 `KNOWN_PLACES`
 *
 * 这四个词在词典里**本来就有**（`dict.mjs` 的种子，category=方位，把
 * 「北边坡 / 北面 / 北边」归一成「北帮」）。缺的从来不是"认不认识这个词"，
 * 而是**没有一处说过"它是个能去的地方"**。
 *
 * 后果实测过，而且是最难堪的那种：
 * - 「看看北帮」——规则引擎 `NAV.FLYTO` 的准入要求 `isKnownPlace(target)`，
 *   过不去，于是**听不懂**；
 * - 「带我去北帮」——模型那条路给了 `target=北帮`、`known=false`，后端照样回
 *   「已定位到北帮」（`service.mjs` 的 `describeCommands` 在前端执行**之前**
 *   就把回话拼好了），紧接着前端补一条「没找到「北帮」的位置」——
 *   **同一屏里两句话互相打脸**。
 *
 * 坐标仍然不在这儿（前端按方位取该方位点位的几何中心，见 `src/duner/places.ts`），
 * 这里只回答"这个说法算不算一个地方"。
 *
 * ⚠️ 「北帮」是「北帮3号台阶」「北帮装载点」的前缀，靠 `PLACES_LONGEST_FIRST`
 * 的最长匹配让长词赢 —— 与「排土场」/「排土场复垦区」是同一套机制，
 * 但这两个是**四组**前缀关系，改抽取顺序时要连带看一眼。
 */
export const DIRECTION_NAMES = ['北帮', '南帮', '东帮', '西帮']

/** 全部已知地名。`露天采坑` 等长词在前，抽取时按此顺序做最长匹配 */
export const KNOWN_PLACES = [
  ...new Set([...SITE_NAMES, ...AREA_NAMES, ...WAYPOINT_NAMES, ...DIRECTION_NAMES])
]

/**
 * 裸台阶号的合法形状（「3号台阶」）。用户常常不带方位说台阶，
 * 而它确实存在（`digitalTwin.ts` 里带方位），所以不拦。
 */
export const BARE_BENCH_RE = /^(\d+)号台阶$/

/** 这个字符串是不是一个本矿真实存在的地名 */
export const isKnownPlace = (name) =>
  Boolean(name) && (KNOWN_PLACES.includes(name) || BARE_BENCH_RE.test(String(name)))

/**
 * 把数据源里的写法归到**用户口语的标准形**。
 *
 * 存在的理由是一个真实的写法分裂：`mock/digitalTwin.ts` 里设备与监测点的
 * `area` 写的是 `'北帮 3 台阶'`（数字前有空格、没有"号"），
 * 而人说话是 `'北帮3号台阶'`。两边都能被前端认出来，但**后端只认后者**
 * （`KNOWN_PLACES` 是后者），于是 `entity.find` 把设备位置原样透出去，
 * 下游的 `map.highlight` 就会拿到一个后端自己不认识的名字。
 *
 * 所以统一在这里收口：**标准形 = 人说话的形状**（带"号"、无空格）。
 * 前端的 `areaAnchor` / `parseEntityId` 拿到标准形之后自己会解析，
 * 后端不去猜坐标（那是 `sceneTargets.ts` 的事）。
 */
export function canonicalPlace(raw) {
  if (!raw) return null
  const t = String(raw).replace(/\s+/g, '')
  const bench = /^(北帮|南帮|东帮|西帮)(\d+)台阶$/.exec(t)
  if (bench) return `${bench[1]}${bench[2]}号台阶`
  if (KNOWN_PLACES.includes(t)) return t
  // 兜底：文本里含某个已知地名就取它（「北帮 3 台阶附近」这类）
  const longestFirst = [...KNOWN_PLACES].sort((a, b) => b.length - a.length)
  return longestFirst.find((p) => t.includes(p)) ?? null
}

/**
 * 设备/人员的编号形状。`extractEntity` 与规则准入共用。
 *
 * ⚠️ 备选项里**必须**有「矿用卡车」这种完整写法，而且要排在「矿卡」「卡车」前面。
 * 原因：词典会把「矿卡」归一成「矿用卡车」（种子词典里就是这么定的），
 * 于是这里拿到的是归一化**之后**的文本。少了这一项，
 * 「带我去1号矿卡」会走到规则引擎里认不出来 —— 而这是最常说的那句话之一。
 */
export const ENTITY_CODE_RE = /\b([A-Z]{2}-\d{2})\b/i
export const ENTITY_NUM_RE = /(\d+)\s*号\s*(矿用卡车|牙轮钻机|前装机|自卸车|矿卡|卡车|钻机|铲车)/

/**
 * 这个名字前端**解析得出来**吗 —— 发 `map.flyTo` 之前的最后一道闸门。
 *
 * 比 `isKnownPlace` 宽一档：设备/监测点的编号前端也认
 * （`places.ts` 的 `resolvePlace` 第 3、4 级分别查监测点表和设备表），
 * 所以「改成1号矿卡」该真的飞过去，而不是反问一句"你想改成哪儿"。
 *
 * ⚠️ 它**不是** `NAV.FLYTO` 的准入条件（那里仍用 `isKnownPlace`，见 `rule.mjs`）：
 * 导航规则要拦住「带我去1号矿卡」那种说法（那是 `QUERY.LOCATE` 要找人），
 * 而纠错句里的对象只可能是"换个地方看"，宽一点没有歧义。
 */
export const isNavigableTarget = (name) => {
  const n = String(name ?? '')
  return isKnownPlace(n) || ENTITY_CODE_RE.test(n) || ENTITY_NUM_RE.test(n)
}

/**
 * 与前端 `src/duner/scene.ts` 登记的图层名对齐（`DigitalTwinView` 三组、
 * `EmergencyView` 四组）。
 * 名字对不上的图层，`layer_*` 会**如实回「该页没有这个图层」**，
 * 不会假装成功 —— 假成功比找不到更坏，用户会以为是自己看错了。
 */
export const KNOWN_LAYERS = [
  '边坡监测',
  '风险分布',
  '设备效率',
  '作业人员定位',
  '定位基站',
  '人员当日轨迹',
  '避灾路线',
  '安全监测点',
  '成本'
]

/** 视角预设。`top` 俯瞰、`overview` 全局、`pit` 采坑 */
export const VIEW_PRESETS = ['top', 'overview', 'pit', 'plant', 'dump', 'tailings']

/**
 * 口语 → 规范名的替换表（指导书第 5 节的词典种子，见 `dict.mjs`）。
 * 放在这里是为了让「图层别名」与「图层名」在同一屏里能对着看。
 */
export const LAYER_ALIASES = [
  ['边坡监测', ['边坡', '边坡位移', '滑坡位移', '位移', 'gnss', '边坡监测点']],
  ['风险分布', ['风险', '风险区', '安全风险', '三类安全风险', '四色']],
  ['设备效率', ['设备', '设备定位', '设备点位', '钻机', '卡车', '铲车']],
  ['作业人员定位', ['人员', '人员定位', '作业人员', '人的位置']],
  ['定位基站', ['基站', '通讯基站']],
  ['人员当日轨迹', ['轨迹', '人员轨迹', '当日轨迹', '走过的路']],
  ['避灾路线', ['避灾路线', '撤离路线', '逃生路线', '疏散路线']],
  ['安全监测点', ['监测点', '监测站', '安全监测']],
  ['成本', ['成本', '费用', '电费']]
]

/**
 * 处置责任人候选 —— **真实姓名，取自 `src/mock/equipment.ts` 的工单数据**。
 *
 * 编不出来的一个原因：人员定位那份数据里名字是打码的（`张**`），
 * 拿它当候选会往台账里写一个打码的名字。这四个名字来自平台自己的工单，
 * 是"这个矿上确实有人叫这个"的唯一证据。
 *
 * 放在 `vocab.mjs` 而不是工具里，是因为**规则引擎也要用它**：
 * 用户说「责任人王建国」时，规则要能把这四个字抽成 `owner` 槽 ——
 * 抽不出来就得反问一遍，而他明明已经说了。
 */
export const OWNER_CANDIDATES = ['王建国', '张海涛', '李振华', '赵明远']
