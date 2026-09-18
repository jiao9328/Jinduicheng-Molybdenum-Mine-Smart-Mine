/**
 * 地名解析 —— 后端只说地名，坐标在这一层落地。
 *
 * ## 为什么坐标留在前端
 *
 * `server/duner/vocab.mjs` 顶部写了这条分工：后端只有一份**名字清单**
 * （用来判断「这个地名我认不认识」），**坐标一概没有**。理由是一份坐标抄两处，
 * 前端一搬厂两边就不一致，且没人会发现 —— 本项目对「同一件事有两个说法」
 * 零容忍。所以后端发下来的是 `{ tool: 'map.flyTo', args: { target: '北帮3号台阶' } }`，
 * 由这里换成 `SceneWaypoint`。
 *
 * ## 两级解析，都不新建坐标表
 *
 * 1. **机位预设**：`SCENE_WAYPOINTS`（露天采坑/粗碎站/选矿厂/皮带廊/排土场/尾矿库）
 *    本来就是给人看的机位，直接用。
 * 2. **地名锚点**：`AREA_ANCHORS`（9 个中文地名）用 `waypointOfTarget` 按地物类型
 *    取机位距离。
 * 3. **业务数据里的台阶/运输道**：`北帮3号台阶` 这类**没有**锚点表，
 *    但它在 `twinSlopeSites` / `twinDevices` 上带着 `eastM/northM`，
 *    走 `pitWaypoint` 换算。
 *
 * ## 找不到就是找不到
 *
 * `resolvePlace` 返回 `null`，**不退回「飞到矿区中心」**。这是
 * `sceneTargets.ts:215` 已经立过的规矩，这里只是照着做：
 * 用户说了一个本矿没有的地名，飞到一个不相干的地方比不动更坏 ——
 * 他会以为「北帮 7 号台阶」真的存在，只是自己看错了。
 */

import type * as Cesium from 'cesium'
import { SCENE_WAYPOINTS, type SceneWaypoint } from '@/scene/sceneConfig'
import { AREA_ANCHORS, pitWaypoint, waypointOfTarget, type TargetKind } from '@/scene/sceneTargets'
import { fetchTwinDevices, fetchTwinSlopeSites } from '@/api/digitalTwin'

/**
 * 归一化：去掉空格与「号/#」，让 `'北帮 3 台阶'`（数据里的写法）与
 * `'北帮3号台阶'`（人说话/后端标准形）比得上。
 *
 * 不复刻后端的 `canonicalPlace`（它输出带「号」的标准形），而是**两边都抹平**：
 * 复刻意味着「后端改一次正则，前端也得改」，改漏了就是一次静默的解析失败；
 * 抹平的法子对形状不敏感，只有真正不同的名字才会比不出。
 */
const norm = (s: unknown): string => String(s ?? '').replace(/[\s号#＃]/g, '')

/** 前端只有地名清单的一半在这里（另一半在 `sceneTargets`），比对一律走 norm */
const same = (a: unknown, b: unknown): boolean => {
  const x = norm(a)
  return x.length > 0 && x === norm(b)
}

/**
 * 锚点 → 地物类型。类型只决定**机位多远**（`sceneTargets.RANGE_OF`）。
 *
 * 「厂区」与「选矿厂」不给 building（340m）而给 area（1200m）：这两个名字
 * 指的是一片地方而不是一栋楼，凑到 340m 会只看见一栋房子，看不出「厂区在哪」。
 * 同理「坑底集水池」给 tank（260m）——它就是个池子，给远了看不出是哪个。
 */
const ANCHOR_KIND: Record<string, TargetKind> = {
  北帮采剥面: 'workface',
  主运输道路: 'haulRoad',
  东帮爆破区: 'workface',
  坑底集水池: 'tank',
  排土场复垦区: 'dump',
  排土场: 'dump',
  尾矿库: 'tailings',
  厂区: 'area',
  选矿厂: 'area'
}

/** 「3号台阶」这种不带方位的说法。后端 `BARE_BENCH_RE` 放行它，这里得能接住 */
const BARE_BENCH = /^(\d+)号台阶$/

/**
 * 方位词 —— 后端把它们当**能去的地方**（`server/duner/vocab.mjs` 的
 * `DIRECTION_NAMES`，那份清单的理由写在那里），这里要给出一个坐标。
 *
 * ## 「北帮在哪」的答案是**取中**，不是新写一个坐标
 *
 * 数据里没有"北帮"这个面，只有落在北帮的那些点：监测点 SL-01（北帮 3 台阶）、
 * SL-05（北帮 6 台阶），设备 DR-01/02/03 与两台前装机（`area` 都写着北帮某处）。
 * 把这些点的 `eastM/northM` 取几何中心，是这份数据能支持的**唯一一种**
 * 有依据的回答 —— 手写一个"看着差不多"的经纬度更像回事，但它是编的，
 * 而且搬厂之后没有任何东西会提醒你它是编的（`sceneTargets.ts` 那几条注释是同一件事）。
 *
 * ## 两处如实记账
 *
 * - **点是密度不均的**：7 个点里 5 个是设备，质心会往设备密的那一侧偏，
 *   它和坡面的几何中心不是一回事。数据里没有坡面形状，做不到更好。
 * - **这一点只用于定位**：`highlightIdFor('北帮')` 找不到实体（"北帮"不是一个实体），
 *   于是相机飞过去但不高亮。`bridge.ts` 里高亮失败本来就不算这条指令失败，
 *   这里不为了"看着有反应"而随便挑一个点去高亮。
 */
export const DIRECTIONS = ['北帮', '南帮', '东帮', '西帮']

const benchNum = (name: unknown): number | null => {
  const m = /(\d+)\s*台阶/.exec(String(name ?? ''))
  return m ? Number(m[1]) : null
}

/**
 * 地名 → 机位。**认不出返回 null**。
 *
 * 每次都去要一次设备/监测点数据：这两个接口在本仓库是既有资产
 * （`api/digitalTwin.ts` 已带降级），而地名解析只在用户发指令时发生，
 * 一次几毫秒，不值得为它做缓存 —— 缓存反而会在「后端刚改了数据」时给旧坐标。
 */
export async function resolvePlace(name: string): Promise<SceneWaypoint | null> {
  const target = String(name ?? '').trim()
  if (!target) return null

  // ── 1. 机位预设：名字就是机位的 label ──
  const preset = SCENE_WAYPOINTS.find((w) => w.label === target)
  if (preset) return preset

  // ── 2. 地名锚点 ──
  const anchor = AREA_ANCHORS[target]
  if (anchor) {
    const kind = ANCHOR_KIND[target] ?? 'area'
    return waypointOfTarget({ kind, key: target }, anchor, target)
  }

  const [sites, devices] = await Promise.all([
    fetchTwinSlopeSites().catch(() => []),
    fetchTwinDevices().catch(() => [])
  ])

  // ── 3. 边坡监测点（优先于设备：「北帮3号台阶」既是 SL-01 的 name 也是 DR-01 的 area，
  //      而后者是**坡面**，后者是**坡上的钻机**。用户说台阶名时指的是那个坡） ──
  const site =
    sites.find((s) => same(s.name, target) || same(s.id, target)) ??
    (BARE_BENCH.test(target) ? sites.find((s) => benchNum(s.name) === Number(BARE_BENCH.exec(target)![1])) : undefined)
  if (site) return pitWaypoint('slope', site.id, site.eastM, site.northM, site.name)

  // ── 3.5 方位（「北帮」）—— 落在该方位上的点位取中（见 `DIRECTIONS` 的注释） ──
  if (DIRECTIONS.includes(target)) {
    const pts = [
      ...sites.filter((s) => String(s.name ?? '').includes(target)).map((s) => [s.eastM, s.northM]),
      ...devices.filter((d) => String(d.area ?? '').includes(target)).map((d) => [d.eastM, d.northM])
    ].filter(([e, n]) => Number.isFinite(e) && Number.isFinite(n))
    // 该方位一个点位都没有 → null（如实说找不到），不退回矿区中心
    if (!pts.length) return null
    const eastM = pts.reduce((a, [e]) => a + e, 0) / pts.length
    const northM = pts.reduce((a, [, n]) => a + n, 0) / pts.length
    return pitWaypoint('area', target, eastM, northM, target)
  }

  // ── 4. 设备：编号、名字、所在台阶都认 ──
  const dev = devices.find((d) => same(d.id, target) || same(d.name, target) || same(d.area, target))
  if (dev) return pitWaypoint('device', dev.id, dev.eastM, dev.northM, dev.name)

  return null
}

/**
 * 地名 → 当前场景里的实体 id，**并确认它真的在这个 viewer 里**。
 *
 * 为什么要确认存在：图层是按页建的（设备点位只在数字孪生/监测页有），
 * 同一个地名在别的页面上**根本没有实体**。此时如实回一句
 * 「该位置在当前页面没有可高亮的实体」，比发一个 `getById` 拿 null 的
 * 空指令强 —— 后者在回执里长得像成功。
 *
 * 候选按前缀列，**不做前缀遍历捞图层**（`twinLayer.ts:247` 警告过会误吞）：
 * 这里是一个个具体 id 去问「在不在」，问不到就换下一个候选，最后如实返回 null。
 */
export async function highlightIdFor(
  viewer: Cesium.Viewer | null | undefined,
  name: string
): Promise<string | null> {
  if (!viewer || viewer.isDestroyed()) return null

  const target = String(name ?? '').trim()
  if (!target) return null

  const candidates: string[] = []

  // 编号形状（SL-01 / DR-01 / RZ-01）：同族前缀全排上，谁在就是谁
  if (/^[A-Za-z]{2}-\d{2}$/.test(target)) {
    const code = target.toUpperCase()
    candidates.push(`slope-site-${code}`, `slope-base-${code}`, `twin-device-${code}`, `twin-risk-${code}`)
  }

  const [sites, devices] = await Promise.all([
    fetchTwinSlopeSites().catch(() => []),
    fetchTwinDevices().catch(() => [])
  ])
  const site = sites.find((s) => same(s.name, target) || same(s.id, target))
  if (site) candidates.push(`slope-site-${site.id}`, `slope-base-${site.id}`)

  const dev = devices.find((d) => same(d.id, target) || same(d.name, target) || same(d.area, target))
  if (dev) candidates.push(`twin-device-${dev.id}`)

  // 区域统计标注（统计报表页）：键就是中文地名
  candidates.push(`stat-area-${target}`)

  for (const id of candidates) {
    if (viewer.entities.getById(id)) return id
  }
  return null
}
