/**
 * 指令桥 —— 把后端下发的视图指令真正执行掉，并回执。
 *
 * ## 后端只发指令，这里才碰 Cesium（指导书 4.3）
 *
 * 分工不是形式主义：后端不知道当前是哪个页面、viewer 建好没有、这一页有没有
 * 图层开关。把这些判断放在后端，它就只能**假设**成功 —— 那正是
 * 指导书第 2 节禁止的「假装成功」。
 *
 * ## 三条规矩
 *
 * 1. **做不到就说做不到。** 每一处失败都带一句人话：没有场景、
 *    地名认不出、这一页没有这个图层、模拟页没打开。含糊的一句
 *    「执行失败」等于让用户自己去猜。
 * 2. **回执必发**（含失败）。失败也回执，是「指令发下去了、前端没执行成」
 *    能在审计里查出来的唯一办法。
 * 3. **不吞异常。** 单条指令抛错只影响它自己，后面的照常执行 ——
 *    半句命令里前半段做成了、后半段没做，用户得看得见。
 */

import type * as Cesium from 'cesium'
import { highlightAt } from '@/scene/highlight'
import { HOME_WAYPOINT, SCENE_WAYPOINTS, type SceneWaypoint } from '@/scene/sceneConfig'
import { currentLayers, currentScene, currentSim } from './scene'
import { highlightIdFor, resolvePlace } from './places'
import { dunerReceipt, type DunerCommand } from '@/api/duner'
import { downloadCsv } from '@/utils/csv'
import * as productionApi from '@/api/production'
import * as decisionApi from '@/api/decision'
import * as equipmentApi from '@/api/equipment'

/** 单条指令的执行结果 */
export interface ExecOutcome {
  tool: string
  cmdId: string
  ok: boolean
  /** 给用户看的一句话 */
  note: string
  /** 这句话要不要显示在对话里 —— 失败与「查现状」类要，成功的导航类不用（答复里已经说了） */
  show: boolean
  ms: number
}

/** 单条指令的执行返回（`show` 省略时按「失败才显示」） */
type StepResult = { ok: boolean; note: string; show?: boolean }

const ok = (note: string, show = false): StepResult => ({ ok: true, note, show })
const bad = (note: string): StepResult => ({ ok: false, note })

const SCENE_ABSENT = '当前页面没有可操作的三维场景'
const NOT_READY = '三维场景还在加载，稍等几秒再说一次'

/** 当前场景的 viewer。**判活一律问它**（`entity.isDestroyed()` 在 Cesium 上不存在） */
function currentViewer(): Cesium.Viewer | null {
  const scene = currentScene()
  const viewer = scene?.viewer() as Cesium.Viewer | null | undefined
  return viewer && !viewer.isDestroyed() ? viewer : null
}

/**
 * 视角预设 → 机位。
 *
 * `overview` / `pit` / `plant` / `dump` / `tailings` 直接用既有机位，
 * **一个参数都不另写**。
 *
 * `top` 是唯一需要构造的：本仓库没有「正上方俯瞰」这个机位
 * （`HOME_WAYPOINT` 是 -40° 的南侧俯瞰，看的是构图而不是平面位置）。
 * 所以它**从 `HOME_WAYPOINT` 派生**：同一个注视点，俯角压到 -85°、
 * 距离收到 2600m。派生而不是手写一份新坐标，理由与
 * `sceneConfig.ts:63` 把经纬度由 `plantPt` 算出来是同一条 ——
 * 手抄的那份在搬厂之后会安静地错掉。
 */
const PRESET_OF: Record<string, () => SceneWaypoint | null> = {
  overview: () => HOME_WAYPOINT,
  top: () => ({ ...HOME_WAYPOINT, key: 'top', label: '俯瞰', pitch: -85, range: 2600 }),
  pit: () => SCENE_WAYPOINTS.find((w) => w.key === 'pit') ?? null,
  plant: () => SCENE_WAYPOINTS.find((w) => w.key === 'plant') ?? null,
  dump: () => SCENE_WAYPOINTS.find((w) => w.key === 'dump') ?? null,
  tailings: () => SCENE_WAYPOINTS.find((w) => w.key === 'tailings') ?? null
}

/** 一条指令 → 一次执行 */
async function runOne(cmd: DunerCommand): Promise<StepResult> {
  const args = (cmd.args ?? {}) as Record<string, unknown>
  const viewer = currentViewer()

  switch (cmd.tool) {
    case 'map.flyTo': {
      const target = String(args.target ?? '')
      if (!viewer) return bad(currentScene() ? NOT_READY : SCENE_ABSENT)

      const wp = await resolvePlace(target)
      if (!wp) return bad(`没找到「${target}」的位置，换一个地名试试（可以说「带我去尾矿库」）`)

      await currentScene()!.flyTo(wp, Number(args.duration) > 0 ? Number(args.duration) : 2.5)

      // 高亮失败不算这条指令失败：相机已经真的飞过去了，那是用户要的主要动作
      if (args.highlight !== false) {
        const id = await highlightIdFor(viewer, target)
        if (id) highlightAt(viewer, id)
      }
      return ok(`已飞到${target}`)
    }

    case 'map.setView': {
      const preset = String(args.preset ?? '')
      if (!viewer) return bad(currentScene() ? NOT_READY : SCENE_ABSENT)

      const wp = PRESET_OF[preset]?.()
      if (!wp) return bad(`没有「${preset}」这个视角预设`)
      await currentScene()!.flyTo(wp, Number(args.duration) > 0 ? Number(args.duration) : 2.5)
      return ok(`已切到${wp.label}视角`)
    }

    case 'map.highlight': {
      const target = String(args.target ?? '')
      if (!viewer) return bad(currentScene() ? NOT_READY : SCENE_ABSENT)

      // 关闭高亮：目标名可以是空的
      if (args.on === false) {
        highlightAt(viewer, '')
        return ok('已取消高亮')
      }
      const id = await highlightIdFor(viewer, target)
      if (!id) {
        return bad(`「${target}」在当前页面没有对应的三维实体（图层可能没打开，或这一页没有该图层）`)
      }
      highlightAt(viewer, id)
      return ok(`已高亮${target}`)
    }

    case 'layer.show':
    case 'layer.hide':
    case 'layer.isolate':
    case 'layer.list':
      return runLayer(cmd.tool, args)

    case 'sim.start': {
      const sim = currentSim()
      if (!sim) return bad('这一页没有边坡位移动态模拟，请先切到「数字孪生」页再说一次')

      const site = String(args.site ?? '')
      const speed = Number(args.speed) > 0 ? Number(args.speed) : 1
      const res = sim.startSim(site, speed)
      if (!res.ok) return bad(res.note)
      // 速度是后端签名里有、但本页实现不了的参数（动画时长写死在 twinLayer）。
      // 说清楚比装作按 2 倍速播过要诚实。
      return ok(speed === 1 ? res.note : `${res.note}（本页速度固定，未按 ${speed} 倍播放）`)
    }

    case 'report.export':
      return runExport(args)

    default:
      // 后端加了工具而前端没跟上时，**必须说出来**：静默忽略会让用户
      // 以为指令生效了（对他来说这条指令和一个 bug 长得一模一样）
      return bad(`不认识这条指令（${cmd.tool}），前端版本可能落后于后端`)
  }
}

/** 图层开关：一律交给当前页登记的图层手柄，认不出的图层如实说没有 */
function runLayer(tool: string, args: Record<string, unknown>): StepResult {
  const layers = currentLayers()
  if (!layers) {
    return bad('当前页面没有图层开关。图层可以在「数字孪生」页（设备/风险/边坡）或「应急救援」页（人员/基站/轨迹/避灾路线）操作')
  }

  if (tool === 'layer.list') {
    const items = layers.list()
    if (!items.length) return { ok: true, note: '这一页当前没有任何图层', show: true }
    return { ok: true, note: items.map((i) => `${i.name}：${i.visible ? '开' : '关'}`).join('，'), show: true }
  }

  const names = (Array.isArray(args.names) ? args.names : args.names ? [args.names] : [])
    .map((n) => String(n ?? '').trim())
    .filter(Boolean)
  if (!names.length) return bad('要操作哪些图层？')

  const notes = []
  let allOk = true
  for (const name of names) {
    const r =
      tool === 'layer.isolate'
        ? layers.isolate([name])
        : layers.set(name, tool === 'layer.show')
    notes.push(r.note)
    if (!r.ok) allOk = false
  }
  return { ok: allOk, note: notes.join('；') }
}

/** 导出：CSV 在浏览器里生成，与报表页那个按钮是同一份实现 */
async function runExport(args: Record<string, unknown>): Promise<StepResult> {
  const dataset = String(args.dataset ?? '')

  if (dataset === 'quality') {
    const rows = await productionApi.fetchQualityRecords()
    if (!rows?.length) return bad('质检记录当前没有数据，导不出文件')
    downloadCsv(
      ['时间', '质检异常情况', '处理措施', '负责人'],
      rows.map((r) => [r.time, r.issue, r.action, r.owner]),
      '质检记录'
    )
    return ok(`已导出质检记录，共 ${rows.length} 条`)
  }

  if (dataset === 'orders') {
    const rows = await decisionApi.fetchDecisionOrders()
    if (!rows?.length) return bad('工单当前没有数据，导不出文件')
    downloadCsv(
      ['编号', '来源建议', '内容', '紧急度', '责任人', '状态', '期限', '建单时间'],
      rows.map((r) => [
        String(r.id),
        r.suggestion,
        r.content,
        LEVEL_TEXT[r.level] ?? r.level,
        r.owner,
        STATUS_TEXT[r.status] ?? r.status,
        r.due,
        String(r.createdAt ?? '').slice(0, 10)
      ]),
      '工单'
    )
    return ok(`已导出工单，共 ${rows.length} 条`)
  }

  if (dataset === 'alarms') {
    const rows = await equipmentApi.fetchDeviceAlerts()
    if (!rows?.length) return bad('设备告警当前没有数据，导不出文件')
    downloadCsv(
      ['设备', '告警类型', '等级', '时间'],
      rows.map((r) => [r.device, r.type, r.level, r.time]),
      '设备告警'
    )
    return ok(`已导出设备告警，共 ${rows.length} 条`)
  }

  return bad(`不认识要导出的数据集「${dataset}」`)
}

/** 状态与紧急度文案。与 `DecisionView.vue` 的那两份**必须一致** —— 导出的文件要和页面上的字对得上 */
const STATUS_TEXT: Record<string, string> = { todo: '待处理', doing: '处理中', done: '已完成' }
const LEVEL_TEXT: Record<string, string> = { high: '紧急', mid: '一般', low: '较低' }

/**
 * 执行一批指令并回执。
 *
 * `auditId` 由调用方从对话响应里带过来，写进每一条回执 —— 后端不知道
 * 一条指令会被拆成几次执行，只有它能把这行回执挂回那次对话。
 */
export async function executeCommands(commands: DunerCommand[], auditId: string): Promise<ExecOutcome[]> {
  const list = commands ?? []
  const outcomes: ExecOutcome[] = []
  const receipts: Promise<unknown>[] = []

  for (const [i, cmd] of list.entries()) {
    const cmdId = `${auditId}:${i}`
    const t0 = performance.now()

    let res: StepResult
    try {
      res = await runOne(cmd)
    } catch (err) {
      // 单条指令抛错不拖累后面的：半句命令前半段做成了、后半段没做，用户得看得见
      res = bad(`执行出错：${err instanceof Error ? err.message : String(err)}`)
    }

    const ms = Math.round(performance.now() - t0)
    outcomes.push({ tool: cmd.tool, cmdId, ok: res.ok, note: res.note, show: res.show ?? !res.ok, ms })

    // 回执的失败**只记控制台**：它是审计用的旁路，报错弹给用户看会让人以为
    // 刚才那个动作失败了。等所有指令跑完再一起等结果，不给每条指令加一次往返。
    receipts.push(
      dunerReceipt({ cmdId, tool: cmd.tool, ok: res.ok, ms, auditId, note: res.note }).catch((err) => {
        console.warn('[duner] 回执上报失败（不影响本次操作）', err)
      })
    )
  }

  await Promise.allSettled(receipts)
  return outcomes
}
