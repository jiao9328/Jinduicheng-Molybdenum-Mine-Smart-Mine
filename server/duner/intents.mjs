/**
 * 意图体系 —— 指导书第 6 节。
 *
 * ## 这张表为什么要有 `write` 和 `emergency` 两个标记
 *
 * 「不经确认执行写操作」这条指标要求**为 0**。靠提示词约束模型是不可靠的
 * （模型可以被人用「忽略之前的规则」绕），所以真正的闸门是结构性的：
 * **意图表里标了 `write`，就必须走 ConfirmManager，与意图由规则还是模型产出无关。**
 *
 * 同理 `emergency` 是唯一被允许跳过确认的通道（指导书 6.3），
 * 把它标在表里而不是散在代码里，是为了「哪些意图能跳过确认」一眼可数。
 */

/**
 * 只读意图：免确认，直接执行。
 *
 * ## 工具名一律用**点号**（`map.flyTo`），不是线上下划线写法
 *
 * 这是本模块最容易搞错的一处。指导书第 7 节的工具名带点号，`registry.mjs`
 * 里注册的也是点号；只有发给 DeepSeek 时才转成下划线（线上名不能含点，
 * 见 `llm.mjs` 文件头的实测记录）。意图表是**内部**结构，
 * 所以跟着点号走 —— 写成 `layer_show` 的话 `service.mjs` 在注册表里查不到它，
 * 表现为"识别对了意图却什么也没执行"。
 *
 * ## 一个意图只挂**一个**工具，其余指令由该工具的结果产出
 *
 * 一开始这里写的是数组（`QUERY.LOCATE: tools: ['entity.find', 'map.highlight']`），
 * 但那个数组是执行不了的：`entity.find` 要的参数是 `query`，
 * `map.highlight` 要的是 `target`，把同一份槽位喂给两个工具只会有一个报错。
 *
 * 真正的关系是**主从**：跑第一个工具，它返回的 `commands` 里就带着
 * "顺便高亮一下"这条指令（`entity.find` 就是这么做的）。所以这里只声明主工具，
 * 附带效果跟着结果走 —— 这样"一个工具产出多条指令"（应急预案要同时定位 +
 * 高亮避让路线）也不需要编排层开特例。
 */
export const READ_INTENTS = {
  'NAV.FLYTO': { label: '飞到对象/区域', tool: 'map.flyTo' },
  'NAV.VIEW': { label: '切换视角/机位', tool: 'map.setView' },
  'LAYER.SHOW': { label: '打开图层', tool: 'layer.show' },
  'LAYER.HIDE': { label: '关闭图层', tool: 'layer.hide' },
  'LAYER.ONLY': { label: '图层隔离', tool: 'layer.isolate' },
  'LAYER.LIST': { label: '列出图层', tool: 'layer.list' },
  'QUERY.STATUS': { label: '查实时状态', tool: 'data.query' },
  'QUERY.SUMMARY': { label: '综合汇总', tool: 'data.query' },
  'QUERY.LOCATE': { label: '找人/找设备', tool: 'entity.find' },
  'ORDER.LIST': { label: '查看工单列表', tool: 'order.list' },
  'ALARM.LIST': { label: '查看告警列表', tool: 'alarm.list' },
  'CHAT.HELP': { label: '帮助', tool: null }
}

/**
 * 写意图：必须确认 + 权限校验。`admin: true` 表示仅管理员。
 *
 * ## 与指导书 §7 表格的一处**刻意偏离**：`.list` 不算写
 *
 * 指导书第 7 节那张必备工具表把 `order.create / list`、`alarm.list / ack`
 * 整行标成"写"。这里只把 **create / ack / export / start / adopt** 当写，
 * 把两个 `.list` 当读（见上表 `ORDER.LIST` / `ALARM.LIST`）。
 *
 * 理由是指导书**自己的第一条原则**：「默认只读，任何写操作必须显式确认」。
 * 列一张告警清单不改任何数据，把它塞进确认闸门只会让"每查一次都要点确认"，
 * 而这项"确认"很快就会变成无脑点击 —— 那才是真的削弱了确认的意义。
 * 该表更像是按**所属模块**（决策/设备工单、安全管理）分的组，不是按可变性。
 *
 * 指标口径不受影响：指导书第 12 节量的是"未经确认**执行写操作**"，
 * 列清单不在其中。
 */
export const WRITE_INTENTS = {
  'ORDER.CREATE': { label: '生成工单', tool: 'order.create', admin: true },
  'ALARM.ACK': { label: '确认告警', tool: 'alarm.ack', admin: true },
  'EXPORT.RUN': { label: '导出文件', tool: 'report.export', admin: true },
  'SIM.START': { label: '启动模拟', tool: 'sim.start', admin: true },
  'DECISION.ADOPT': { label: '采纳建议', tool: 'decision.adopt', admin: true }
}

/**
 * 应急通道（指导书 6.3）。
 *
 * 规则写死两句话：**匹配预案不等待确认**（出事时等人点确认就是在浪费逃生时间），
 * 但**严禁自动指令真实设备** —— 调配建议只生成卡片，人工点了才下发。
 */
export const EMERGENCY_INTENTS = {
  'EMERGENCY.MATCH': { label: '应急预案匹配', tool: 'plan.match', skipConfirm: true },
  'EMERGENCY.DISPATCH': { label: '资源调配建议', tool: 'plan.match', skipConfirm: true, adviseOnly: true }
}

/** 系统意图：不驱动任何工具，只影响对话走向 */
export const SYSTEM_INTENTS = {
  'SYS.CLARIFY': { label: '反追问' },
  'SYS.CORRECT': { label: '纠错' },
  'SYS.OUT_OF_SCOPE': { label: '越界拒绝' },
  'SYS.CONFIRM': { label: '确认执行' },
  'SYS.CANCEL': { label: '取消' }
}

export const ALL_INTENTS = {
  ...READ_INTENTS,
  ...WRITE_INTENTS,
  ...EMERGENCY_INTENTS,
  ...SYSTEM_INTENTS
}

/** 该意图是否属于写操作（= 必须过确认闸门） */
export const isWrite = (id) => Object.prototype.hasOwnProperty.call(WRITE_INTENTS, id)
export const isEmergency = (id) => Object.prototype.hasOwnProperty.call(EMERGENCY_INTENTS, id)
export const isSystem = (id) => Object.prototype.hasOwnProperty.call(SYSTEM_INTENTS, id)

/** 意图要求的最低角色。非写意图一律 `user` 起 */
export const requiredRole = (id) => (WRITE_INTENTS[id]?.admin ? 'admin' : 'user')

/**
 * 越界拒绝的统一话术（指导书第 9 节第 4 条）。
 * 写成常量是因为检查脚本要断言**逐字一致** —— 换个说法就等于换了人格。
 */
export const OUT_OF_SCOPE_REPLY =
  '我是墩儿，专注这座矿的生产指挥，这个问题超出我的岗位范围。'

/** 离线兜底话术（指导书第 11 节） */
export const OFFLINE_REPLY = '当前外网不可用，墩儿进入本地值班模式，导航和图层指令照常。'
