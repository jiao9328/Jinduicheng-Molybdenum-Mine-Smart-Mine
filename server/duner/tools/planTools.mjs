/**
 * 应急预案匹配（指导书 §5.3 的应急通道）。
 *
 * ## 这个工具是**唯一**会一次产出多条指令的
 *
 * 指导书对 `EMERGENCY.MATCH` 的要求是「立即执行：定位事发点 + 匹配预案 +
 * 高亮避灾路线，全程不等待确认」。三件事、三个工具，但它必须是**一次**
 * 原子动作 —— 分三次让模型各调一个工具，中间任何一次失败都会留下
 * "飞过去了但没匹配预案"这种半截状态，而这是应急场景。
 *
 * 所以 `plan.match` 自己把三件事一起返回：卡片（预案正文）走 `card`，
 * 相机与图层走 `commands`。`service.mjs` 统一收 `commands` 字段，
 * 于是"一个工具产出多条指令"不需要在编排层开特例。
 *
 * ## 为什么着火时**不**硬套一个预案
 *
 * 本矿的预案只有四份：边坡滑坡 / 爆破事故 / 运输故障 / 坑底积水。
 * 「着火了」不在其中。凑一份最接近的（比如运输事故）看起来更"智能"，
 * 但应急指引凑错方向的代价不是"体验差" —— 是给人错的行动指令。
 * 所以找不到就如实说没有，并把有的四类列出来让用户选。
 */

import { defineTool, dataResult, errorResult, clarifyResult } from './registry.mjs'
import { loadFacts } from '../facts.mjs'

/** 规则引擎给的事故类型键 ↔ 预案的 key（`src/mock/emergency.ts`） */
const KIND_RE = /^(landslide|blasting|haul|flood)$/

/**
 * 反问的选项用**预案全名**（`p.name`），不用简称（`p.type`）。
 *
 * 理由是"点一下就能接着走"：用户点选项 = 他下一句话就是这行字，
 * 而这句话要能被规则引擎原样读懂。全名「坑底积水（透水）专项应急预案」里有
 * `透水`，简称「水害隐患」里一个触发词都没有 —— 点它会得到「没听懂」，
 * 于是反问了一轮又一轮，用户开始怀疑这东西到底能不能用。
 * 四份预案的全名各自含 `滑坡`/`事故`/`事故`/`透水`，四种都能认出来。
 */


export function registerPlanTools() {
  return [
    defineTool({
      name: 'plan.match',
      description:
        '匹配专项应急预案。kind 取 landslide(边坡滑坡) / blasting(爆破事故) / haul(运输故障) / flood(坑底积水透水)。' +
        '会同时把相机定位到事发点、打开避灾路线图层',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['landslide', 'blasting', 'haul', 'flood'], description: '事故类型' },
          target: { type: 'string', description: '事发地点，如"北帮3号台阶"' },
          advise: { type: 'boolean', default: false, description: '是否附带资源调配建议' }
        },
        required: ['kind']
      },
      execute: async (args) => {
        const facts = await loadFacts()
        const plans = facts?.emergency?.emergencyPlans ?? []
        if (!plans.length) return errorResult('当前取不到应急预案数据源。')

        const kind = String(args.kind ?? '').trim()
        if (!KIND_RE.test(kind)) {
          return clarifyResult('是哪一类事故？', plans.map((p) => p.name))
        }

        const plan = plans.find((p) => p.key === kind)
        if (!plan) {
          // 数据里没有这一类（比如"着火"）。列出有的，不猜。
          return {
            kind: 'text',
            text: `本矿没有匹配「${kind}」的专项预案，现有：${plans.map((p) => p.name).join('、')}。`,
            options: plans.map((p) => p.name)
          }
        }

        const target = String(args.target ?? '').trim()
        const rows = [
          ['预案名称', plan.name],
          ['响应级别', plan.level],
          ...plan.steps.map((s, i) => [`第 ${i + 1} 步`, s])
        ]

        if (args.advise) {
          const dispatch = facts?.emergency?.dispatchPlans ?? []
          for (const d of dispatch.slice(0, 4)) {
            // 「建议」二字是刻意的：指导书 §5.3 明令"严禁自动指令真实设备"，
            // 这里产出的是给人看的建议，不是下发给设备的指令。
            rows.push([`建议调配 · ${d.name}`, `${d.kind} · ${d.from} → ${target || d.to} · 约 ${d.eta} 分钟`])
          }
        }

        return {
          kind: 'data',
          text:
            `已匹配《${plan.name}》（${plan.level}）` +
            (target ? `，事发点「${target}」` : '') +
            `，共 ${plan.steps.length} 步处置指引。`,
          card: { title: `${plan.type} · 应急预案`, rows },
          /**
           * 一次产出两条指令。**不等待确认**（指导书 §5.3）——
           * 出事时让用户先点一下确认卡再定位，是在浪费逃生时间。
           * 这里能免确认的底气是：两条指令都是只读的（相机 + 图层），
           * 真正的写操作（一键下发）**不在**这个工具里，仍要人工点。
           */
          commands: [
            ...(target ? [{ tool: 'map.flyTo', args: { target, highlight: true } }] : []),
            { tool: 'layer.show', args: { names: ['避灾路线'] } }
          ]
        }
      }
    })
  ]
}
