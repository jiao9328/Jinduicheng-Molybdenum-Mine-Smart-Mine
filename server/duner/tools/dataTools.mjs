/**
 * 数据类工具：查业务数据、找设备/人员。
 *
 * ## 「工具返回什么就说什么」在这里是怎么落实的
 *
 * 指导书第 9 节第 3 条禁止编造数据。落实方式不是提醒模型别编（它照样会编），
 * 而是**后端把答案算好再回**：`data.query` 返回的是拼好的句子 + 结构化卡片，
 * 模型在整条链路上没有机会往数字里插话。这也是为什么数据类工具走的是
 * `dataResult`（后端已答）而不是把原始数据丢给模型去总结。
 *
 * ## 数据从哪来
 *
 * 优先读**真实入库的表**（质检记录 / 值班 / 备件 / 隐患处置 / 工单），
 * 其余读前端 mock（经 `facts.mjs` 打包，与页面同源）。
 * 两边都没有的领域如实回「暂无数据」，不拿相近的凑。
 */

import { defineTool, dataResult, errorResult, clarifyResult } from './registry.mjs'
import { loadFacts } from '../facts.mjs'
import { listRows, RESOURCES } from '../../db.mjs'
import { canonicalPlace } from '../vocab.mjs'

const fmt = (n, d = 0) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return String(n ?? '—')
  return v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })
}

/** 从 mock 的指标卡数组里按 label 找一项 */
const metricBy = (list, kw) => (list ?? []).find((m) => String(m?.label ?? '').includes(kw)) ?? null

/**
 * 一条指标 → 一行。**标签与单位都照抄平台自己的那份数据**。
 *
 * 不自己另起名字（写「今日生产车数」而平台写「生产车数」）是因为：
 * 用户会拿助手说的话去和页面上的字对，两边不一致时他不知道该信谁。
 * 更实在的一层：mock 里的单位是数据，可能有它自己的问题 ——
 * 助手照抄就只是**如实复述平台**，自己另写一个说法，等于凭空多造一处矛盾。
 */
const metricRow = (m, label) => [label ?? m.label, `${m.value}${m.unit ?? ''}`]

/**
 * 点名了一个**边坡位移监测点** → 直接答那一点。
 *
 * ## 这个分支是补的一个真缺陷
 *
 * 「北帮3号台阶现在位移多少」「SL-01现在位移多少」原来都只答领域摘要
 * （重大风险源 2 项、存在隐患 5 项……），**一个位移数字都没有**，
 * 而位移数据就在 `twinSlopeSites` 里、`entity.find` 早就查得到。
 * 根因是「位移」被 `extractDomains` 归进了 `safety`，而安全摘要里没有位移。
 *
 * ## 状态与阈值都取平台自己的
 *
 * `slopeStatus()` 与 `TWIN_SLOPE_THRESHOLD` 都是 `mock/digitalTwin.ts` 导出的
 * 纯函数/常量（经 `facts.mjs` 打包，和三维点位、面板状态列**同一个函数**）。
 * 在这里另写一遍 `displacement >= 20 ? '报警' : …` 就是同一件事的第二个说法 ——
 * 平台哪天把阈值改成 25，三维那侧变了、助手这侧不说，且两处各自看都对。
 */
function slopeCard(facts, site) {
  const status = facts?.twin?.slopeStatus?.(site.displacement) ?? '—'
  const th = facts?.twin?.TWIN_SLOPE_THRESHOLD
  const over = Number.isFinite(Number(th)) && Number(site.displacement) >= Number(th)
  const rows = [
    ['编号', site.id],
    ['位置', placeOf(site.name)],
    ['累计位移', `${site.displacement} mm${over ? `（已超阈值 ${th}mm）` : Number.isFinite(Number(th)) ? `（阈值 ${th}mm）` : ''}`],
    ['位移速率', `${site.rate} mm/d`],
    ['主滑方向', `${site.azimuth}°`],
    ['状态', status]
  ]
  return {
    text:
      `${placeOf(site.name)}（${site.id}）累计位移 ${site.displacement}mm、速率 ${site.rate}mm/d、主滑方向 ${site.azimuth}°，状态${status}` +
      (over ? `（已超 ${th}mm 阈值）` : ''),
    card: { title: `${placeOf(site.name)} · 边坡位移`, rows }
  }
}

/** 名称/编号 → 监测点。三级：编号（SL-01）→ 地名（北帮3号台阶）→ 裸台阶号（3号台阶） */
function slopeSiteOf(sites, q) {
  const raw = String(q ?? '').trim()
  if (!raw) return null
  const up = raw.toUpperCase()
  const byId = sites.find((s) => String(s.id).toUpperCase() === up)
  if (byId) return byId

  const canon = canonicalPlace(raw)
  const byName = sites.find((s) => canonicalPlace(s.name) === canon)
  if (byName) return byName

  // 裸台阶号：「带我去三号台阶」那条路能走通，问它的位移也该走通。
  // 台阶号唯一才认 —— 数据里 3 号台阶只有北帮一个，但那是数据的性质、不是保证，
  // 所以这里显式要求唯一，多了就不猜（见 `BARE_BENCH_RE` 放行它的那段注释）。
  const bench = /^(\d+)号台阶$/.exec(canon ?? raw)
  if (bench) {
    const hit = sites.filter((s) => siteNum(s.name) === Number(bench[1]))
    if (hit.length === 1) return hit[0]
  }
  return null
}

/**
 * 点名 → 一张卡片。落不到就返回 null（调用方决定是答领域摘要还是如实说没找到）。
 *
 * 两条路：边坡监测点答位移；设备/人员答它自己的卡片，
 * 并**说明它不是位移监测点** —— 用户问「1号矿卡现在位移多少」，
 * 回一句"它在南帮运输道、作业中"比硬凑一个位移数字诚实，
 * 也比反问"你想看哪一块"更贴着他问的东西。
 */
async function answerSite(facts, name) {
  const sites = facts?.twin?.twinSlopeSites ?? []
  const site = slopeSiteOf(sites, name)
  if (site) return slopeCard(facts, site)

  const hit = findEntity(facts, name)
  if (!hit) return null
  return { text: `${hit.text}（它不是边坡位移监测点，没有位移数据）`, card: { title: hit.title, rows: hit.rows } }
}

/**
 * 领域的中文名。澄清选项由它拼出来。
 *
 * ⚠️ 改这里的字要连带确认**规则引擎还认得出拼出来的那句话** ——
 * `extractDomains` 靠 `生产/安全/设备/成本/人员` 这几个词认领域，
 * 选项写成「生产情况怎么样」能认出来，写成「看看生产」就未必。
 * 选项一旦认不出来，用户点了自己的选项会再被问一遍同一句。
 */
const DOMAIN_TEXT = [
  { key: 'production', text: '生产情况' },
  { key: 'safety', text: '安全情况' },
  { key: 'equipment', text: '设备情况' },
  { key: 'cost', text: '成本情况' },
  { key: 'personnel', text: '人员情况' }
]

/** 领域 → 摘要 + 卡片。每个分支只碰它自己有把握的字段 */
async function queryDomain(domain, db) {
  const facts = await loadFacts()

  if (domain === 'production') {
    const rows = []
    const out = facts?.production?.productionMetrics ?? []
    const today = metricBy(out, '生产量')
    const cars = metricBy(out, '车数')
    const pass = metricBy(out, '合格率')
    if (today) rows.push(metricRow(today))
    if (cars) rows.push(metricRow(cars))
    if (pass) rows.push(metricRow(pass))
    const drill = facts?.production?.drillingProgress
    if (drill?.plan?.length) {
      const i = drill.plan.length - 1
      const plan = Number(drill.plan[i])
      const actual = Number(drill.actual?.[i])
      rows.push(['掘进进尺（计划/实际）', `${drill.plan[i]} / ${drill.actual?.[i] ?? '—'} 米`])
      // 指导书 §12 第 3 条点名要「计划 / 实际 / 完成率」三件套。完成率是**现算的**：
      // 数据源里只有 plan/actual 两条数组，没有现成的完成率字段。
      // 拿同一组数除一下，比另编一个"像那么回事"的百分比诚实 ——
      // 卡片上的数字会被当成产量口径引用，编出来的那个没人能发现是编的。
      // 计划为 0 时不算：卡片上出现 `Infinity%` 比少一行难看得多。
      if (plan > 0 && Number.isFinite(actual)) {
        rows.push(['完成率', `${Math.round((actual / plan) * 100)}%`])
      }
    }
    if (!rows.length) return null
    return { text: rows.map(([k, v]) => `${k} ${v}`).join('，'), card: { title: '生产情况', rows } }
  }

  if (domain === 'safety') {
    const rows = []
    const rt = facts?.safety?.safetyRealtime
    if (rt) {
      rows.push(['重大风险源', `${rt.majorRisks} 项`])
      rows.push(['存在风险', `${rt.existingRisks} 项`])
      if (rt.updateTime) rows.push(['更新时间', rt.updateTime])
    }
    const loop = facts?.safety?.hazardClosedLoop
    if (loop) {
      rows.push(['隐患闭环 上报/派单/整改/验收', `${loop.reported}/${loop.assigned}/${loop.rectified}/${loop.verified}`])
    }
    // 隐患处置是真入库的表，优先用它
    const disposals = listRows(db, RESOURCES['emergency/hazard-disposals'])
    if (disposals.length) {
      const open = disposals.filter((d) => d.status !== 'done').length
      rows.push(['待处置隐患', `${open} 项（共 ${disposals.length} 项）`])
    }
    // 「位移多少」没点名时也要看得见一个位移数字：上面几行全是计数
    // （风险源几项、隐患几项），而问"位移"的人要的是**毫米**。
    // 取最大的那一个点报出来 —— 它也正是最该被先看到的那一个。
    const sites = facts?.twin?.twinSlopeSites ?? []
    if (sites.length) {
      const top = [...sites].sort((a, b) => Number(b.displacement) - Number(a.displacement))[0]
      const st = facts?.twin?.slopeStatus?.(top.displacement) ?? '—'
      rows.push(['最大位移点', `${placeOf(top.name)}（${top.id}）${top.displacement}mm · ${st}`])
    }
    if (!rows.length) return null
    return { text: rows.map(([k, v]) => `${k} ${v}`).join('，'), card: { title: '安全情况', rows } }
  }

  if (domain === 'equipment') {
    const rows = []
    const metrics = facts?.equipment?.equipmentMetrics ?? []
    const avg = metricBy(metrics, '平均')
    const running = metricBy(metrics, '运行中')
    const total = metricBy(metrics, '总数')
    if (avg) rows.push(metricRow(avg, '平均评分'))
    if (running) rows.push(metricRow(running, '运行中'))
    if (total) rows.push(metricRow(total, '设备总数'))
    const alerts = facts?.equipment?.deviceAlerts ?? []
    if (alerts.length) {
      rows.push(['当前告警', `${alerts.length} 条`])
      for (const a of alerts.slice(0, 3)) rows.push([`　${a.device}`, `${a.type}（${a.level}）`])
    }
    const spares = listRows(db, RESOURCES['equipment/spare-parts'])
    const low = spares.filter((s) => Number(s.stock) < Number(s.minStock))
    if (spares.length) rows.push(['备件缺货预警', `${low.length} 项（共 ${spares.length} 项）`])
    if (!rows.length) return null
    return { text: rows.slice(0, 4).map(([k, v]) => `${k} ${v}`).join('，'), card: { title: '设备情况', rows } }
  }

  if (domain === 'cost') {
    const rows = []
    const metrics = facts?.decision?.costMetrics ?? []
    for (const m of metrics.slice(0, 4)) {
      if (m?.label) rows.push([m.label, `${m.value}${m.unit ?? ''}`])
    }
    const ton = facts?.decision?.tonCostBreakdown
    if (ton?.labels?.length && ton?.values?.length) {
      const total = ton.values.reduce((a, b) => a + Number(b || 0), 0)
      rows.push(['吨成本合计', `${fmt(total, 1)} 元/吨`])
    }
    if (!rows.length) return null
    return { text: rows.map(([k, v]) => `${k} ${v}`).join('，'), card: { title: '成本情况', rows } }
  }

  if (domain === 'personnel') {
    const dist = facts?.overview?.personnelDistribution
    const rows = []
    if (dist?.total) rows.push(['在岗总人数', `${dist.total} 人`])
    for (const it of (dist?.items ?? []).slice(0, 5)) rows.push([it.name, `${it.value} 人`])
    if (!rows.length) return null
    return { text: rows.map(([k, v]) => `${k} ${v}`).join('，'), card: { title: '人员分布', rows } }
  }

  return null
}

export function registerDataTools() {
  return [
    defineTool({
      name: 'data.query',
      description:
        '查业务数据汇总。domain 取 production(生产) / safety(安全) / equipment(设备) / cost(成本) / personnel(人员)。' +
        'site 传**点名的一个点**（"北帮3号台阶""SL-01"），有它就先答那一点自己的数据。' +
        '返回的结构化卡片会显示在界面上',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', enum: ['production', 'safety', 'equipment', 'cost', 'personnel'] },
          domains: { type: 'array', items: { type: 'string' }, description: '一次查多个领域' },
          site: { type: 'string', description: '点名查询的点位，如"北帮3号台阶""SL-01"' }
        }
      },
      execute: async (args, ctx) => {
        const asked = [...new Set([...(args.domains ?? []), args.domain].filter(Boolean).map(String))]
        const siteName = String(args.site ?? '').trim()

        // 点了名 → **先答那个点**。
        // 顺序在澄清之前：「北帮3号台阶怎么样」这种"有地点、无领域"的句子，
        // 原来会得到一句「你想看哪一块？」—— 地点本身就是上下文，
        // 他站在北帮3号台阶前面问"怎么样"，不是想让你问他一遍。
        if (siteName) {
          const facts = await loadFacts()
          const hit = await answerSite(facts, siteName)
          if (hit) return dataResult(hit.text, hit.card)
          // 落不到任何点位，但给了领域 → 照旧答领域摘要（下面）
          // 领域也没有 → 如实说没找到，**不**改口去问"你想看哪一块"
          // （问一句和用户说的东西无关的话，比说一句"没找到"更让人摸不着头脑）
          if (!asked.length) {
            return errorResult(`没找到「${siteName}」这个点位。可以试试「北帮3号台阶」或「SL-01」。`)
          }
        }

        // 认不出领域就**问**，不默认查「生产 + 安全」。
        // 默认那两个看着贴心，实际是替用户选了问题 —— 他问的是成本，
        // 收到一屏产量和安全数字，还得自己再问一遍。
        // 选项写成完整的话（"生产情况怎么样"），点一下就能被规则引擎原样读懂。
        if (!asked.length) {
          return clarifyResult(
            '你想看哪一块？',
            DOMAIN_TEXT.map((d) => `${d.text}怎么样`)
          )
        }

        const parts = []
        const cards = []
        for (const d of asked.slice(0, 4)) {
          const out = await queryDomain(d, ctx.db)
          if (out) {
            parts.push(out.text)
            cards.push(out.card)
          }
        }
        if (!parts.length) return errorResult('这几个领域暂时没有数据可查。')
        return dataResult(parts.join('；'), cards.length === 1 ? cards[0] : { title: '汇总', sections: cards })
      }
    }),

    defineTool({
      name: 'entity.find',
      description: '找设备或人员的位置与状态。query 传编号或名称，如"1号矿卡""SL-01""张"',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '设备/人员编号或名称' } },
        required: ['query']
      },
      execute: async (args) => {
        const q = String(args.query ?? '').trim()
        if (!q) return errorResult('要找谁？给我个编号或名字。')

        const facts = await loadFacts()
        if (!facts) return errorResult('业务数据源当前不可用，暂时查不了位置。')

        const hit = findEntity(facts, q)
        if (!hit) return errorResult(`没找到「${q}」。可以试试设备编号（如 DR-01、TR-11）或人员姓名。`)

        return {
          kind: 'data',
          text: hit.text,
          card: { title: hit.title, rows: hit.rows },
          // 找到就顺手高亮一下（指导书 §6 的 QUERY.LOCATE 就是 find + highlight）。
          // **只高亮不移动相机**：用户问"SL-01 在哪"时多半正看着别处，
          // 直接把镜头拽走会让他丢掉当前上下文。要看就说"带我去 SL-01"。
          commands: hit.place ? [{ tool: 'map.highlight', args: { target: hit.place, on: true } }] : []
        }
      }
    })
  ]
}

/**
 * 把「1号矿用卡车」拆成 `{num:1, kind:'矿用卡车'}`，拆不出返回 null。
 *
 * 为什么需要它：词典会把「矿卡」归一成「矿用卡车」（`dict.mjs` 的种子里有
 * `矿用卡车: ['矿卡','自卸车','大车','卡车']`），于是用户说的
 * 「1号矿卡」到这里已经是「1号矿用卡车」。而设备在数据里的名字是
 * `'1# 矿用卡车'` —— **用 `includes` 拿「1号矿用卡车」去匹配它永远是 false**
 * （`号` vs `#`）。光靠字符串包含是匹配不上的，必须拆开按「序号 + 机种」比。
 */
function parseNumberedEntity(q) {
  const m = /^(\d+)\s*号\s*(.+)$/.exec(String(q ?? '').trim())
  return m ? { num: Number(m[1]), kind: m[2].trim() } : null
}

/** 从设备名 `'1# 矿用卡车'` 拆出序号与机种 */
function parseDeviceName(name) {
  const m = /^(\d+)\s*#\s*(.+)$/.exec(String(name ?? '').trim())
  return m ? { num: Number(m[1]), kind: m[2].trim() } : null
}

const kindCompatible = (a, b) => Boolean(a) && Boolean(b) && (a.includes(b) || b.includes(a))

/**
 * 在设备/人员/监测点里找。
 *
 * 三级阶梯，**每一级都要么命中要么往下走，最终找不到就返回 null** ——
 * 不退回「飞到矿区中心」了事。这条与 `sceneTargets.ts:215` 的注释是同一条规矩：
 * 「没有对应地名时返回 null，不要退化成『飞到矿区中心』了事」。
 */
function findEntity(facts, q) {
  const raw = String(q ?? '').trim()
  const up = raw.toUpperCase()

  const devices = facts?.twin?.twinDevices ?? []
  const people = facts?.emergency?.personnelPositions ?? []
  const sites = facts?.twin?.twinSlopeSites ?? []

  // ── 1. 精确编号（DR-01 / SL-01 / P-1024）。三种 id 前缀不同，不会撞 ──
  const byId =
    devices.find((d) => String(d.id).toUpperCase() === up) ??
    sites.find((s) => String(s.id).toUpperCase() === up) ??
    people.find((p) => String(p.id).toUpperCase() === up)
  if (byId) {
    const hit = byId.efficiency !== undefined ? deviceHit(byId) : byId.azimuth !== undefined ? siteHit(byId) : personHit(byId)
    if (hit) return hit
  }

  // ── 2. 编号片段（「1号矿卡」→「1号矿用卡车」，见 parseNumberedEntity） ──
  const want = parseNumberedEntity(raw)
  if (want) {
    if (/台阶|帮|坡/.test(want.kind)) {
      const site = sites.find((s) => siteNum(s.name) === want.num && directionMatches(s.name, raw))
      if (site) return siteHit(site)
    }
    const dev = devices.find((d) => {
      const p = parseDeviceName(d.name)
      return p && p.num === want.num && kindCompatible(p.kind, want.kind)
    })
    if (dev) return deviceHit(dev)
  }

  // ── 3. 地名相等（用规范化后的形状比：「北帮3号台阶」↔「北帮 3 台阶」） ──
  const site = sites.find((s) => canonicalPlace(s.name) === raw)
  if (site) return siteHit(site)

  // ── 4. 编号片段 / 名称包含（打码姓名只有姓，靠 includes 兜） ──
  const loose =
    devices.find((d) => String(d.id).toUpperCase().includes(up)) ??
    sites.find((s) => String(s.id).toUpperCase().includes(up))
  if (loose && raw.length >= 2) {
    return loose.efficiency !== undefined ? deviceHit(loose) : siteHit(loose)
  }
  const person = people.find((p) => String(p.name).includes(raw) || String(p.role).includes(raw))
  if (person) return personHit(person)

  return null
}

/** 从监测点名里取台阶号（「北帮 3 台阶」→ 3） */
const siteNum = (name) => {
  const m = /(\d+)\s*台阶/.exec(String(name ?? ''))
  return m ? Number(m[1]) : null
}

/** 用户说了方位就要求方位一致，「北帮3号台阶」不该落到南帮的那个 3 号台阶 */
const directionMatches = (siteName, query) => {
  const d = /(北帮|南帮|东帮|西帮)/.exec(String(query))
  return !d || String(siteName).includes(d[1])
}

/**
 * 展示用地名。mock 里存的是 `'北帮 3 台阶'`（带空格、不带「号」），
 * 而用户说的话是 `'北帮3号台阶'`。
 *
 * 这个函数不只是给下游的 `map.highlight` 用（那才是必须的，前端按这个解析坐标），
 * **回话和卡片里也要用同一个形状**：用户问「SL-01 在哪」，回一句
 * 「SL-01 在 北帮 3 台阶」会让人以为自己问的不是他说的那个地方。
 * 说的话和看到的字对不上号，是这类助手最容易被骂的一处。
 */
const placeOf = (raw) => canonicalPlace(raw) ?? String(raw ?? '')

const deviceHit = (dev) => ({
  title: `${dev.name}（${dev.id}）`,
  text: `${dev.name} 在${placeOf(dev.area)}，状态${dev.status}，效率 ${dev.efficiency}%`,
  rows: [
    ['编号', dev.id],
    ['位置', placeOf(dev.area)],
    ['状态', dev.status],
    ['作业效率', `${dev.efficiency}%`],
    ['最近上报', dev.lastReport ?? '—']
  ],
  place: canonicalPlace(dev.area)
})

const personHit = (person) => ({
  title: `${person.name}（${person.id}）`,
  text: `${person.name} 在${placeOf(person.area)}，${person.online ? '在线' : '离线'}`,
  rows: [
    ['编号', person.id],
    ['岗位', person.role],
    ['位置', placeOf(person.area)],
    ['状态', person.online ? '在线' : '离线']
  ],
  place: canonicalPlace(person.area)
})

const siteHit = (site) => ({
  title: `${site.name}（${site.id}）`,
  text: `${placeOf(site.name)} 累计位移 ${site.displacement}mm，速率 ${site.rate}mm/d`,
  rows: [
    ['编号', site.id],
    ['累计位移', `${site.displacement} mm`],
    ['速率', `${site.rate} mm/d`],
    ['方位角', `${site.azimuth}°`]
  ],
  place: canonicalPlace(site.name)
})
