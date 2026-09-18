/**
 * 视图类工具：相机与图层。**只产出指令，不碰 Cesium**（指导书 4.3）。
 *
 * ## 地名表为什么在后端也放一份
 *
 * 真正的坐标在前端（`src/scene/sceneTargets.ts` 的 `AREA_ANCHORS`、
 * `sceneConfig.ts` 的 `SCENE_WAYPOINTS`），后端拿不到也不该拿 ——
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

import { defineTool, viewResult, errorResult } from './registry.mjs'
import { KNOWN_PLACES, KNOWN_LAYERS, VIEW_PRESETS } from '../vocab.mjs'

// 词表本体在 `../vocab.mjs` —— 规则引擎也要用它判断"这个地名认不认识"，
// 放在这里会让规则引擎反向依赖工具层。这里只做转出，方便工具消费方一处引用。
export { KNOWN_PLACES, KNOWN_LAYERS, VIEW_PRESETS }

export function registerViewTools() {
  // 三个开关工具共用同一段说明。`names` 的 enum 已经把模型能填的值锁死在这份清单里，
  // 但"锁死"只保证它不会编一个不存在的图层名 —— 用户问的图层真的不在清单里时，
  // 它还是可能去挑一个最像的（"运输道路" → 挑一个看着相关的）。所以补一句：
  // 清单外就是没有，如实说。**没有这一句时实测它会在清单里硬挑一个**，
  // 用户会在屏幕上找一个被打开了、但他没要的图层。
  const LAYER_DOC = `可用图层：${KNOWN_LAYERS.join('、')}。用户说的图层不在这份清单里时，如实说明没有这个图层，不要挑一个相近的。`

  return [
    defineTool({
      name: 'map.flyTo',
      description: '将三维相机飞到指定对象或区域，并高亮。target 用本矿真实地名，如"北帮3号台阶""尾矿库"',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '对象名或区域名，如"北帮3号台阶"' },
          highlight: { type: 'boolean', default: true, description: '是否高亮该对象' },
          duration: { type: 'number', default: 2.5, description: '飞行时长（秒）' }
        },
        required: ['target']
      },
      execute: (args) => {
        const target = String(args.target ?? '').trim()
        if (!target) return errorResult('要飞到哪里？给我个地名。')
        return viewResult('map.flyTo', {
          target,
          highlight: args.highlight !== false,
          duration: Number(args.duration) > 0 ? Number(args.duration) : 2.5,
          known: KNOWN_PLACES.includes(target)
        })
      }
    }),

    defineTool({
      name: 'map.setView',
      description: '切换三维视角/机位预设。preset 取 top(俯瞰) / overview(全局) / pit(采坑) / plant(选矿厂) / dump(排土场) / tailings(尾矿库)',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          preset: { type: 'string', enum: VIEW_PRESETS, description: '机位预设' },
          duration: { type: 'number', default: 2.5 }
        },
        required: ['preset']
      },
      execute: (args) => {
        const preset = String(args.preset ?? '').trim()
        if (!VIEW_PRESETS.includes(preset)) {
          return errorResult(`没有这个视角「${preset}」，可选：${VIEW_PRESETS.join(' / ')}`)
        }
        return viewResult('map.setView', { preset, duration: Number(args.duration) > 0 ? Number(args.duration) : 2.5 })
      }
    }),

    defineTool({
      name: 'map.highlight',
      description: '在三维场景里高亮某个对象（不改相机位置）',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: { target: { type: 'string' }, on: { type: 'boolean', default: true } },
        required: ['target']
      },
      execute: (args) => {
        const target = String(args.target ?? '').trim()
        if (!target) return errorResult('要高亮哪个对象？')
        return viewResult('map.highlight', { target, on: args.on !== false })
      }
    }),

    defineTool({
      name: 'layer.show',
      description: `打开图层。${LAYER_DOC}`,
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string', enum: KNOWN_LAYERS }, description: '图层名数组' }
        },
        required: ['names']
      },
      execute: (args) => layerOp('layer.show', args, (n) => ({ name: n, visible: true }))
    }),

    defineTool({
      name: 'layer.hide',
      description: `关闭图层。${LAYER_DOC}`,
      readOnly: true,
      parameters: {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string', enum: KNOWN_LAYERS } } },
        required: ['names']
      },
      execute: (args) => layerOp('layer.hide', args, (n) => ({ name: n, visible: false }))
    }),

    defineTool({
      name: 'layer.isolate',
      description: `图层隔离：只保留指定图层，其余全部隐藏。${LAYER_DOC}`,
      readOnly: true,
      parameters: {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string', enum: KNOWN_LAYERS } } },
        required: ['names']
      },
      execute: (args) => {
        const names = normalizeNames(args.names)
        if (!names.length) return errorResult(`要只看哪些图层？可选：${KNOWN_LAYERS.join('、')}`)
        return viewResult('layer.isolate', { names })
      }
    }),

    defineTool({
      name: 'layer.list',
      description: '列出当前页面有哪些图层、各自是开还是关',
      readOnly: true,
      parameters: { type: 'object', properties: {} },
      execute: () => viewResult('layer.list', {})
    })
  ]
}

function normalizeNames(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return list.map((n) => String(n ?? '').trim()).filter(Boolean)
}

/**
 * 图层开关的公共路径。
 *
 * **认不出的图层名如实报错**，不做「模糊匹配到某个相近的算了」——
 * 用户说「打开成本图层」而这一页根本没有成本层，回一句
 * 「已打开成本图层」会让他在屏幕上找一个不存在的东西。
 */
function layerOp(tool, args, make) {
  const names = normalizeNames(args.names)
  if (!names.length) return errorResult(`要操作哪些图层？可选：${KNOWN_LAYERS.join('、')}`)

  const unknown = names.filter((n) => !KNOWN_LAYERS.includes(n))
  if (unknown.length) {
    return errorResult(`没有这个图层：${unknown.join('、')}。可选：${KNOWN_LAYERS.join('、')}`)
  }
  return viewResult(tool, { ops: names.map(make), names })
}
