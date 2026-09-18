/**
 * 写类工具：生成工单、确认告警、导出、启动模拟、采纳建议。
 *
 * ## 这些工具**不需要自己判断要不要确认**
 *
 * 每个都声明了 `readOnly: false`，于是 `service.mjs` 一律先发确认卡、
 * 用户点了才真正 `execute()`。工具作者不该在这里写任何 `if (confirmed)` ——
 * 那种写法一旦漏掉一处，就是"未经确认执行了写操作"，而指标要求它是 0。
 * 闸门只有一道、在编排层，这是刻意的（`registry.mjs` 文件头有详述）。
 *
 * ## 但 `execute()` 仍然要能挡住"参数不全"
 *
 * 确认卡是问"要不要做"，不是问"做什么"。所以参数不全时**在发卡之前**
 * 就要反问（`clarifyResult`）—— 让用户对着一张信息残缺的卡片点"确认"，
 * 确认完再告诉他缺东西，等于把一次对话拆成三次。
 *
 * ## 有真库的就写库，没有的**如实说**
 *
 * `order.create` / `alarm.ack` / `decision.adopt` 落 `decision_orders`
 * 与 `hazard_disposals` 两张真表，刷新之后还在。
 * `report.export` / `sim.start` 不写库 —— 它们本来就是**前端动作**
 * （生成 CSV、跑边坡动画），后端只产出指令，与 `map.*` 同一个道理。
 */

import { defineTool, viewResult, dataResult, errorResult, clarifyResult, planResult } from './registry.mjs'
import { loadFacts } from '../facts.mjs'
import { OWNER_CANDIDATES as OWNER_NAMES } from '../vocab.mjs'
import { RESOURCES, listRows, insertRow, pickFields, FieldError } from '../../db.mjs'

const ORDER_RES = RESOURCES['decision/orders']
const HAZARD_RES = RESOURCES['emergency/hazard-disposals']

/** 交办期限：默认三天后。工单列表要显示它，留空会渲染成空白格 */
function defaultDue(days = 3) {
  const d = new Date(Date.now() + days * 86400_000)
  return d.toISOString().slice(0, 10)
}

/** 已经在办的工单不许重复开 —— 用「对象 + 原因」当去重键 */
function findOpenOrder(db, target, reason) {
  return listRows(db, ORDER_RES).find(
    (o) => o.status !== 'done' && String(o.suggestion).includes(target ?? '') && String(o.content).includes(reason ?? '')
  )
}

export function registerWriteTools() {
  return [
    // ---------------------------------------------------------------- 工单
    defineTool({
      name: 'order.create',
      description:
        '生成一张处置工单（需要管理员权限，且会先弹确认卡片）。' +
        'target 是处置对象（地名或设备编号），reason 是事由，owner 是责任人 —— 没有责任人时要先问用户',
      readOnly: false,
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '处置对象，如"北帮3号台阶"或"SL-01"' },
          reason: { type: 'string', description: '事由，如"位移26.4mm 超阈值20mm"' },
          measure: { type: 'string', description: '建议措施' },
          owner: { type: 'string', description: '处置责任人（必填）' },
          level: { type: 'string', enum: ['high', 'mid', 'low'], description: '紧急度' },
          due: { type: 'string', description: '要求完成日期 YYYY-MM-DD' }
        },
        required: ['target', 'reason']
      },
      execute: (args, ctx) => {
        const target = String(args.target ?? '').trim()
        const reason = String(args.reason ?? '').trim()
        if (!target) return clarifyResult('要处置哪个对象？', ['北帮3号台阶', '东帮5号台阶', '尾矿库'], 'target')
        if (!reason) return clarifyResult(`「${target}」是因为什么要处置？`, [
          '边坡位移超阈值',
          '设备振动超限',
          '现场发现裂缝'
        ], 'reason')

        const owner = String(args.owner ?? '').trim()
        // 反问而不是编一个责任人：工单会进台账、会被别人看到，
        // 编一个「待指派」再让人以为是真名字，比直接问一句坏得多。
        if (!owner) {
          return clarifyResult(`「${target}」的处置责任人是谁？`, OWNER_CANDIDATES, 'owner')
        }

        const measure = String(args.measure ?? '').trim() || '加密监测 + 现场核查'
        const content = `${reason}；建议措施：${measure}`
        const level = ORDER_RES.enumFields.level.values.includes(args.level) ? args.level : 'high'

        return planResult({
          text: `即将为「${target}」生成处置工单，责任人 ${owner}`,
          // 确认卡片要显示的四行（指导书 7.2 的卡片就是这个形状）
          card: {
            title: '生成处置工单',
            rows: [
              ['对象', target],
              ['原因', reason],
              ['建议措施', measure],
              ['责任人 / 紧急度', `${owner} · ${LEVEL_TEXT[level]}`]
            ]
          },
          // 真正落库的载荷。确认之后由 `runCommit` 交给下面的 commit()
          payload: { target, reason, content, measure, owner, level, due: args.due || defaultDue() }
        })
      },
      /** 确认之后才走到这里。**这是唯一真正写库的地方** */
      commit: (payload, ctx) => {
        const open = findOpenOrder(ctx.db, payload.target, payload.reason)
        if (open) return errorResult(`「${payload.target}」已有一条在办工单（#${open.id}），没有重复生成。`)

        try {
          const row = insertRow(ctx.db, ORDER_RES, pickFields(ORDER_RES, {
            suggestion: `处置工单：${payload.target}`,
            content: payload.content,
            level: payload.level,
            owner: payload.owner,
            status: 'todo',
            due: payload.due
          }))
          return dataResult(
            `已生成工单 #${row.id}：${payload.target}，责任人 ${row.owner}，${row.due} 前完成。`,
            {
              title: `工单 #${row.id}`,
              rows: [
                ['对象', payload.target],
                ['原因', payload.reason],
                ['责任人', row.owner],
                ['状态', '待处理'],
                ['期限', row.due]
              ]
            }
          )
        } catch (err) {
          // 落库失败必须如实报。静默吞掉会得到"界面说建好了、台账里没有"
          if (err instanceof FieldError) return errorResult(`工单参数不合法：${err.message}`)
          return errorResult(`工单落库失败：${err?.message ?? err}`)
        }
      }
    }),

    defineTool({
      name: 'order.list',
      description: '查看工单列表（只读，免确认）。可按 status 过滤：todo 待处理 / doing 处理中 / done 已完成',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['todo', 'doing', 'done'] },
          limit: { type: 'number', default: 8 }
        }
      },
      execute: (args, ctx) => {
        const all = listRows(ctx.db, ORDER_RES)
        const want = args.status ? String(args.status) : null
        const rows = (want ? all.filter((o) => o.status === want) : all)
          .filter((o) => o.status !== 'done')
          .slice(-Math.max(1, Math.min(20, Number(args.limit) || 8)))
          .reverse()

        if (!rows.length) {
          return dataResult(want ? `没有${statusText(want)}的工单。` : '当前没有在办的工单。', {
            title: '工单列表',
            rows: [['在办工单', '0 条']]
          })
        }

        const label = statusText
        return dataResult(
          `在办工单 ${rows.length} 条，` +
            rows.slice(0, 3).map((o) => `#${o.id} ${String(o.suggestion).replace(/^处置工单：/, '')}（${label(o.status)}）`).join('，'),
          {
            title: '工单列表',
            rows: rows.map((o) => [
              `#${o.id} ${String(o.suggestion).replace(/^处置工单：/, '')}`,
              `${label(o.status)} · ${o.owner || '未指派'} · ${o.due || '无期限'}`
            ])
          }
        )
      }
    }),

    // ---------------------------------------------------------------- 告警
    defineTool({
      name: 'alarm.list',
      description: '查看当前告警与安全风险清单（只读，免确认）',
      readOnly: true,
      parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => {
        const facts = await loadFacts()
        const items = collectAlarms(facts)
        const acked = ackedKeys(ctx.db)

        if (!items.length) return errorResult('当前数据源里没有告警记录。')

        const pending = items.filter((a) => !acked.has(alarmKey(a)))
        return dataResult(
          `共 ${items.length} 条告警，其中 ${pending.length} 条待确认。` +
            (pending.length ? `最新：${pending[0].device} ${pending[0].type}（${pending[0].level}）` : ''),
          {
            title: '告警清单',
            rows: items.slice(0, 10).map((a) => [
              `${a.device} · ${a.type}`,
              `${a.level} · ${acked.has(alarmKey(a)) ? '已确认' : '待确认'}${a.time ? ` · ${a.time}` : ''}`
            ])
          }
        )
      }
    }),

    defineTool({
      name: 'alarm.ack',
      description:
        '确认一条告警（需要管理员权限，且会先弹确认卡片）。确认会在隐患处置台账里开一条处置记录，刷新后仍在',
      readOnly: false,
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: '告警设备/点位名，如"1号牙轮钻机"' },
          type: { type: 'string', description: '告警类型，如"温度偏高"' },
          note: { type: 'string', description: '确认说明' }
        },
        required: ['device']
      },
      execute: async (args, ctx) => {
        const facts = await loadFacts()
        const items = collectAlarms(facts)

        // 没给对象时把当前告警摆出来让用户挑，而不是回一句空的"要确认哪一条"。
        //
        // ⚠️ 选项必须是**一句能被原样送回来、且规则引擎自己能读懂**的完整话。
        // 只给设备名（「破碎一」）看着干净，但它送回来时是一句没有动词的话，
        // 规则引擎认不出来，于是又反问一遍 —— 点了自己的选项，回到原点。
        // 所以这里是「确认破碎一的告警」，ALARM.ACK 那条规则正是按这个句式抽对象的。
        const device = String(args.device ?? '').trim()
        if (!device) {
          if (!items.length) return errorResult('当前没有可确认的告警。')
          // ⚠️ 第三个参数 `'device'` 是**必须的**，同文件另外三处反问都带着它。
          // 少它的后果实测过：点选项能走通（选项是一句完整的话，规则引擎自己认得出），
          // 但**打字**回答「破碎一」走不通 —— 这三个字不属于任何意图，
          // 规则引擎认不出来，而澄清层因为不知道该填哪个槽、也没记下待接续的反问，
          // 于是又反问一遍同一句。用户回答了，回到原点。
          return clarifyResult(
            '要确认哪一条告警？',
            [...new Set(items.map((a) => a.device))].slice(0, 4).map((d) => `确认${d}的告警`),
            'device'
          )
        }

        // 只给设备名时，找出它名下的告警让用户挑，而不是随手挑第一条 ——
        // 「1号牙轮钻机是哪条告警」用户自己也可能没想清楚，给他看比替他选好。
        const mine = items.filter((a) => String(a.device).includes(device))
        if (!mine.length) {
          return errorResult(`当前告警里没有「${device}」。`)
        }
        if (mine.length > 1 && !args.type) {
          // ⚠️ 选项是**裸的告警类型**，不是「设备 + 类型」。带设备名看着信息更全，
          // 但那串文字会作为 `type` 送回来（接续机制填的就是这个槽），
          // 而匹配用的是 `a.type.includes(...)` —— 「破碎一 振动超限」匹配不上
          // 任何一条 `type`，于是**静默退回第一条**。用户选了第二条，落的是第一条。
          // 设备名放进问句里就够了，那个上下文本来就没丢。
          return clarifyResult(
            `「${device}」有 ${mine.length} 条告警，确认哪一条？`,
            [...new Set(mine.map((a) => a.type))],
            'type'
          )
        }

        const hit = args.type ? mine.find((a) => String(a.type).includes(String(args.type))) ?? mine[0] : mine[0]
        const key = alarmKey(hit)

        if (ackedKeys(ctx.db).has(key)) {
          return errorResult(`「${hit.device} ${hit.type}」已经确认过了，没有重复建处置记录。`)
        }

        return planResult({
          text: `即将确认「${hit.device} ${hit.type}」，并在隐患处置台账建一条记录`,
          card: {
            title: '确认告警',
            rows: [
              ['告警对象', hit.device],
              ['告警类型', hit.type],
              ['等级 / 时间', `${hit.level}${hit.time ? ` · ${hit.time}` : ''}`],
              ['确认后', '在隐患处置台账开一条处置记录']
            ]
          },
          payload: { key, device: hit.device, type: hit.type, note: String(args.note ?? '').trim() }
        })
      },
      commit: (payload, ctx) => {
        try {
          const row = insertRow(ctx.db, HAZARD_RES, pickFields(HAZARD_RES, {
            type: `告警确认：${payload.device} ${payload.type}`,
            location: payload.device,
            status: 'doing',
            statusText: payload.note || '已确认，待处置'
          }))
          return dataResult(`已确认「${payload.device} ${payload.type}」，隐患处置台账新增记录 #${row.id}。`, {
            title: '告警已确认',
            rows: [
              ['对象', payload.device],
              ['类型', payload.type],
              ['处置记录', `#${row.id}`],
              ['状态', '待处置']
            ]
          })
        } catch (err) {
          if (err instanceof FieldError) return errorResult(`告警确认参数不合法：${err.message}`)
          return errorResult(`告警确认落库失败：${err?.message ?? err}`)
        }
      }
    }),

    // ---------------------------------------------------------------- 导出
    defineTool({
      name: 'report.export',
      description: '导出数据文件（需要管理员权限，且会先弹确认卡片）。dataset 取 quality 质检记录 / orders 工单 / alarms 告警',
      readOnly: false,
      parameters: {
        type: 'object',
        properties: {
          dataset: { type: 'string', enum: ['quality', 'orders', 'alarms'], description: '导出哪份数据' },
          format: { type: 'string', enum: ['csv', 'xlsx', 'pdf'], default: 'csv' }
        },
        required: ['dataset']
      },
      execute: (args) => {
        const dataset = datasetKey(args.dataset)
        if (!dataset) {
          return clarifyResult('要导出哪份数据？', Object.values(DATASET_LABEL), 'dataset')
        }
        return planResult({
          text: `即将导出${DATASET_LABEL[dataset]}`,
          card: {
            title: '导出文件',
            rows: [
              ['数据集', DATASET_LABEL[dataset]],
              ['格式', 'CSV（浏览器直接下载）'],
              ['说明', '文件会下载到本机']
            ]
          },
          payload: { dataset, format: 'csv' }
        })
      },
      /**
       * 导出不写库 —— CSV 由浏览器生成（`ReportsView.vue` 的 `exportCsv`）。
       * 所以这里返回的仍是一条**视图指令**，由前端执行下载。
       * 它是写意图（指导书 §5.2 如此归类）因为它会在本机落一个文件，
       * 但"写"这件事发生在浏览器里，后端不该假装自己写了。
       */
      commit: (payload) => viewResult('report.export', payload)
    }),

    // ---------------------------------------------------------------- 模拟
    defineTool({
      name: 'sim.start',
      description: '启动边坡位移动态模拟（需要管理员权限，且会先弹确认卡片）',
      readOnly: false,
      parameters: {
        type: 'object',
        properties: {
          site: { type: 'string', description: '监测点名，如"北帮3号台阶"' },
          speed: { type: 'number', default: 1 }
        }
      },
      execute: (args) => {
        const site = String(args.site ?? '').trim() || '北帮3号台阶'
        return planResult({
          text: `即将在「${site}」启动边坡位移动态模拟`,
          card: {
            title: '启动边坡位移模拟',
            rows: [
              ['监测点', site],
              ['动作', '沿主滑方向动态演示至实测位移'],
              ['说明', '只播动画，不改任何数据']
            ]
          },
          payload: { site, speed: Number(args.speed) > 0 ? Number(args.speed) : 1 }
        })
      },
      commit: (payload) => viewResult('sim.start', payload)
    }),

    // ---------------------------------------------------------------- 采纳建议
    defineTool({
      name: 'decision.adopt',
      description:
        '采纳一条智能决策建议并生成工单（需要管理员权限，且会先弹确认卡片）。' +
        'id 是建议编号（1 生产计划优化 / 2 设备维保时机 / 3 库存周转 / 4 定价策略）',
      readOnly: false,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '建议编号' },
          owner: { type: 'string', description: '责任人（缺省时反问）' },
          due: { type: 'string' }
        }
      },
      execute: async (args) => {
        const facts = await loadFacts()
        const list = facts?.decision?.decisionSuggestions ?? []
        if (!list.length) return errorResult('当前取不到决策建议数据源。')

        // 两种给法都认：编号（"采纳第1条建议"）和名字（"采纳「生产计划优化」"）。
        // 名字这一路不是锦上添花 —— 澄清选项就是按名字造的，见下面。
        const id = Number(args.id)
        const name = String(args.name ?? '').trim()
        const hit =
          (Number.isFinite(id) ? list.find((s) => Number(s.id) === id) : null) ??
          (name ? list.find((s) => String(s.type).includes(name) || name.includes(String(s.type))) : null)

        if (!hit) {
          // 选项里带上建议名，用户点一下才知道自己采纳的是哪一条 ——
          // 只给「#1」的话，他得先回过头去翻决策页。
          // 「」不能省：DECISION.ADOPT 那条规则靠书名号把名字抽出来。
          return clarifyResult('要采纳哪一条建议？', list.map((s) => `采纳「${s.type}」`), 'name')
        }

        const owner = String(args.owner ?? '').trim()
        if (!owner) return clarifyResult(`采纳「${hit.type}」之后，工单交给谁？`, OWNER_CANDIDATES, 'owner')

        return planResult({
          text: `即将采纳「${hit.type}」并生成工单`,
          card: {
            title: '采纳决策建议',
            rows: [
              ['建议', `#${hit.id} ${hit.type}`],
              ['正文', hit.content],
              ['责任人', owner],
              ['紧急度', LEVEL_TEXT[hit.level] ?? hit.level]
            ]
          },
          payload: {
            // 正文是**采纳那一刻的快照**（与页面 `createDecisionOrder` 同一个语义）
            suggestion: hit.type,
            content: hit.content,
            level: hit.level,
            owner,
            due: args.due || defaultDue(7)
          }
        })
      },
      commit: (payload, ctx) => {
        try {
          const row = insertRow(ctx.db, ORDER_RES, pickFields(ORDER_RES, {
            suggestion: payload.suggestion,
            content: payload.content,
            level: payload.level,
            owner: payload.owner,
            status: 'todo',
            due: payload.due
          }))
          return dataResult(`已采纳「${payload.suggestion}」，生成工单 #${row.id}，责任人 ${row.owner}。`, {
            title: `工单 #${row.id}`,
            rows: [
              ['来源建议', row.suggestion],
              ['责任人', row.owner],
              ['紧急度', row.level],
              ['期限', row.due]
            ]
          })
        } catch (err) {
          if (err instanceof FieldError) return errorResult(`工单参数不合法：${err.message}`)
          return errorResult(`建议采纳落库失败：${err?.message ?? err}`)
        }
      }
    })
  ]
}

/**
 * 反问责任人时给的候选。**取自本项目真实存在的人名** ——
 * `src/mock/equipment.ts` 的维保工单台账里 `owner` 字段就是这几位
 * （王建国 / 张海涛 / 李振华 / 赵明远）。
 *
 * 刻意不编几个"像那么回事"的名字：确认卡片上出现一个平台里别处都查不到的人，
 * 用户会先怀疑自己记错了。人员定位表里的名字是打码的（`张**`），
 * 那是给大屏脱敏用的，拿来当责任人不合适。
 */
const OWNER_CANDIDATES = OWNER_NAMES

const DATASET_LABEL = { quality: '质检记录', orders: '决策工单', alarms: '告警清单' }

/**
 * 把「质检记录」也认成 `quality`。
 *
 * 工具参数的 enum 是英文键，但**反问的选项是给用户点的中文**，
 * 点了之后那串中文会作为 `dataset` 送回来。只认英文键的话，
 * 用户点了自己的选项会被告知"要导出哪份数据" —— 又是一个回到原点的选项。
 * 模型那条路也会撞上：描述里写的是「quality 质检记录」，它完全可能直接送中文。
 */
const datasetKey = (raw) => {
  const v = String(raw ?? '').trim()
  if (!v) return ''
  if (DATASET_LABEL[v]) return v
  return Object.keys(DATASET_LABEL).find((k) => DATASET_LABEL[k] === v || DATASET_LABEL[k].includes(v)) ?? ''
}

const LEVEL_TEXT = { high: '高', mid: '中', low: '低' }

function statusText(s) {
  return { todo: '待处理', doing: '处理中', done: '已完成' }[s] ?? s
}

/** 汇总告警：设备告警 + 安全风险点。两处都在 mock 里，形状不同，这里归成一个形状 */
function collectAlarms(facts) {
  const out = []
  for (const a of facts?.equipment?.deviceAlerts ?? []) {
    out.push({ device: a.device ?? '未知设备', type: a.type ?? '异常', level: a.level ?? '中', time: a.time ?? '' })
  }
  for (const r of facts?.safety?.riskList ?? []) {
    out.push({ device: r.point ?? r.id ?? '风险点', type: r.type ?? '风险', level: r.level ?? '中', time: '' })
  }
  return out
}

/**
 * 告警的稳定标识。
 *
 * mock 的告警**没有 id**（`{device,type,level,time}`），而"已确认"必须能对上号，
 * 否则一次刷新就会把确认状态弄丢。所以用「对象 + 类型」拼一个键 ——
 * 刻意**不含 time**：同一条告警的 time 在不同数据源里格式不一，
 * 带上它反而会让"同一条告警"变成两个键，确认了还显示待确认。
 */
const alarmKey = (a) => `${a.device}|${a.type}`

/** 已确认的告警键集合 —— 从隐患处置台账反查（确认动作就是往那儿写一条记录） */
/**
 * 已经从台账里反推出来的"已确认"集合。
 *
 * ⚠️ 拼出来的必须是 `alarmKey()` 那个形状的键，**不能另造一种格式**。
 * 这里原来直接往集合里塞 `告警确认：` 后面那串原文（`破碎一 振动超限`，空格分隔），
 * 而查的时候用的是 `alarmKey()` 的（`破碎一|振动超限`，竖线分隔）——
 * 两边永远对不上，于是：
 *
 * - 确认过的告警在 `alarm.list` 里**一直显示"待确认"**
 * - 同一条告警可以**反复确认**，每点一次就往隐患台账多写一行
 *
 * 两个格式不一致不会报错，只会让判重静静失效 —— 所以这里按 location 切掉
 * 设备名再交给 `alarmKey()` 去拼，**只有一处**在决定键长什么样。
 */
function ackedKeys(db) {
  const set = new Set()
  for (const row of listRows(db, HAZARD_RES)) {
    const m = /^告警确认：(.+)$/.exec(String(row.type ?? ''))
    if (!m) continue
    const device = String(row.location ?? '')
    const body = m[1]
    // 按 location 切，不按空格切 —— 设备名本身可能带空格
    const type = device && body.startsWith(device) ? body.slice(device.length).trim() : body
    set.add(alarmKey({ device, type }))
  }
  return set
}
