/**
 * 地物与底图的遮挡关系巡检：模型**看得见的面**不能被底图盖住，
 * 而**该落地的边**（封边墙的底边、支腿的最低点）不能悬在空中。
 *
 * ── 为什么要它 ──
 * 用户的原话是「让建模所有的地物都在地表，不要有在 cesium 底图下面的建模」。
 * 这一条有两面，两面都在真机上出过事：
 *
 *  ① **压在底图下面**。底图地形是从离线 DEM 渲染的真实地面，模型是另一套几何。
 *     两者只在那片地被 `terrainClip` 挖掉之后才不打架（`registerModelSurface`：
 *     挖掉之后那片地的**唯一**地表就是模型本身）。没登记的地物就等着被地形盖：
 *     实测排土场 67.6m、尾矿库 40.5m 埋在地形之下——从空中看，那就是「模型跑到
 *     底图下面去了」。
 *  ② **洞沿没封住**。挖洞是沿着登记时那串经纬度把地表切掉，切口是一圈垂直崖面。
 *     模型这一侧必须自己砌一圈从模型表面落到**自然地面**的墙；墙底高于地面就是一个
 *     能看穿到天空的缝。
 *
 * ── 判据（全部在运行态上量，不读被测代码的常量）──
 * 逐点算 `差 = 地形高程 − 该点几何高程`，地形用 `sampleTerrain` 取 **level 14**
 * （跟应用自己采地形取到的最深一层一致：manifest 里地形是 11~14；取 13 会比
 * 建模本身更粗，陡坡上凭空多出几米的「误差」）。
 *
 *  ① 面（polygon / ellipse）：`差 > 1` ⇒ **可见顶面被底图盖住**。
 *     顶面怎么取是判据的要害：
 *       · `perPositionHeight: true` → 顶面是**环上逐点的高程**（`beltPolygon` 就是这族，
 *         它的 `extrudedHeight = lowest - thickness` 是板材**底**面，不是顶面）；
 *       · 否则 → `extrudedHeight ?? height ?? 0`（平置的块体，`extrudedHeight` 才是顶）。
 *     顺序反了会把整条皮带廊按板底去比地形，一条 1.8km 的廊道能报出 121m 的假埋深。
 *  ② 墙（wall）：`底 − 地形 > 1` ⇒ **底边悬空**（会露缝）。符号别弄反：
 *     `差` 为正只说明墙埋在土里，那是正常的；`minimumHeights` 缺省时 Cesium 按
 *     海拔 0 处理（`WallGeometryUpdater`），所以脚本按 0 兜底。
 *     底边**加密到 15m 一点**再判——「两端落地、中段悬空」只在顶点上量是看不见的。
 *  ③ 线（polyline）：只看该线**最低的那个顶点**，`最低点 − 地形 > 1` ⇒ 悬空。
 *     皮带廊支腿是「落地一截 + 悬空一截」画在同一根 polyline 里的，
 *     逐顶点判会把上截全报成悬空。
 *  ④ 盒（box）/ 圆柱（cylinder）：`底面 − 地形 > 1` ⇒ 设备悬在空中。
 *
 * ── 洞里不算，洞沿边界带也不算 ──
 * 洞里的地形已经被挖掉了，那里本来就没有底图盖着；贴着洞沿的一圈单独放行，
 * 是因为洞沿是 48 边形近似（`pitOutline`），模型自己的顶点就落在洞沿上，
 * 直接判内外会把「本来就在洞里」的点报成洞外。判定用「环心缩放」：
 * 收缩 0.5% 判严格内侧、放大 2% 判含边界带。
 *
 * ── 登记表：架空结构 ──
 * 皮带廊是架在支腿上的架空结构，它的侧板、檐口离地十几米是**设计**，不是缺陷。
 * 这类几何登记在这里；**登记即承诺**：登记的是「它本来就在空中」，不是「免检」。
 * 每次运行都会报出每一条登记命中了几处——命中 0 处说明登记过期了，该删。
 *
 * ── 它抓不到什么（如实写在这里，免得下次高估它）──
 * 1. 数值对不对：墙底深 3m 还是 30m 都对它无意义，它只看「在地面之上还是之下」。
 * 2. 登记过的架空结构内部：支腿落地之后，侧板挂在哪、挂多高，它不管。
 * 3. 线 / 盒 / 柱**埋**进地形：判据③④只判悬空。这是有意的——支腿的脚、
 *    树干的底本来就该埋进去一点（`min(地面, 顶)`），拿 1m 的阈值去判埋会满屏误报。
 *    那类问题（比如一条忘了 `clampToGround` 的贴地线，整根沉在地形下）由
 *    `check-entity-heights.mjs` 的静态判据与实景截图兜着，不在本脚本职责内。
 * 4. 洞沿两侧的**连续性**：它判每个点自己落没落地，判不了「一圈墙有多处缺口、
 *    但每个缺口旁边都恰好有一截落地的墙」。这一条要人来判。
 * 5. 底图本身的精度：地形高程取自同一个 manifest，DEM 错了它跟着错。
 *
 * 用法：node scripts/check-ground-cover.mjs [baseUrl] [--self-test]
 *      默认 baseUrl = http://localhost:8787（先 `npm run serve`，它按需自动构建）
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'

/** 底图上下的判定阈值（米）。小于 1m 的差在 DEM 噪声与渲染精度之内，不当缺陷。 */
const 阈值 = 1

/** 封边墙底边加密步长（米）：只在顶点上量会漏掉「两端落地、中段悬空」 */
const 加密步长 = 15

/**
 * 登记在册的**架空结构**（正则，匹配实体 id 前缀）。
 * 皮带廊是架在支腿上的：侧板从皮带底垂下来、檐口在屋面边上，离地十几米是设计。
 * 支腿（`-bent-`）**不登记**——判据③只量一根线的最低点，正是为了量支腿有没有落地。
 * 登记即承诺——见文件头。命中 0 处的登记项会在输出里点名。
 */
const 架空结构 = [/^conveyor-\d+-(wall|eave)/]

/** 挖洞个数的登记表：采坑 + 4 级台地 + 2 座排土场 + 尾矿库 */
const 洞个数登记 = 8

// ---------------------------------------------------------------------------
// 判据（纯函数：入参是几何 + 地形，自证时喂合成样本）
// ---------------------------------------------------------------------------

const 环内 = (ring, x, y) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 以环心为中心缩放（<1 收缩＝严格内侧；>1 放大＝含边界带） */
const 缩放 = (ring, s) => {
  let cx = 0
  let cy = 0
  for (const [x, y] of ring) {
    cx += x
    cy += y
  }
  cx /= ring.length
  cy /= ring.length
  return ring.map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s])
}

/**
 * 点相对挖洞的位置：'内'（地形已被挖掉，不算被盖）/ '边'（贴着洞沿）/ '外'。
 */
export function 洞里位置(洞集, x, y) {
  for (const r of 洞集) if (环内(缩放(r, 0.995), x, y)) return '内'
  for (const r of 洞集) if (环内(缩放(r, 1.02), x, y)) return '边'
  return '外'
}

/**
 * 判据①：面的可见顶面被底图盖住。
 * @param 面集 [{id, 点: [{lo, la, 顶}]}]  顶＝该点的可见顶面高程
 * @param 洞集 [[[lo, la], ...]]
 * @param 地形 (i, j) => 高程   —— 与 面集[i].点[j] 一一对应
 */
export function 判面(面集, 洞集, 地形) {
  const 违规 = []
  for (let i = 0; i < 面集.length; i++) {
    const e = 面集[i]
    const 坏 = []
    for (let j = 0; j < e.点.length; j++) {
      const p = e.点[j]
      const 差 = 地形(i, j) - p.顶
      if (差 <= 阈值) continue
      const 位置 = 洞里位置(洞集, p.lo, p.la)
      if (位置 === '内') continue
      坏.push({ 差: +差.toFixed(1), 位置 })
    }
    if (坏.length)
      违规.push({
        id: e.id,
        点: e.点.length,
        洞外盖点: 坏.filter((b) => b.位置 === '外').length,
        边界盖点: 坏.filter((b) => b.位置 === '边').length,
        最大盖深: Math.max(...坏.map((b) => b.差))
      })
  }
  return 违规.sort((a, b) => b.最大盖深 - a.最大盖深)
}

/**
 * 判据②③④：底边（墙 / 盒 / 圆柱）与最低点（线）悬空。
 * @param 体集 [{id, 类型, 点: [{lo, la, 底}]}]  底＝该点的几何下沿高程
 */
export function 判底(体集, 洞集, 地形) {
  const 违规 = []
  for (let i = 0; i < 体集.length; i++) {
    const e = 体集[i]
    const 坏 = []
    for (let j = 0; j < e.点.length; j++) {
      const p = e.点[j]
      const 缝 = p.底 - 地形(i, j) // >0：底边高于地面
      if (缝 <= 阈值) continue
      const 位置 = 洞里位置(洞集, p.lo, p.la)
      if (位置 === '内') continue
      坏.push({ 缝: +缝.toFixed(1), 位置 })
    }
    if (坏.length)
      违规.push({
        id: e.id,
        类型: e.类型,
        点: e.点.length,
        洞外缝点: 坏.filter((b) => b.位置 === '外').length,
        边界缝点: 坏.filter((b) => b.位置 === '边').length,
        最大缝高: Math.max(...坏.map((b) => b.缝))
      })
  }
  return 违规.sort((a, b) => b.最大缝高 - a.最大缝高)
}

/** 登记表匹配：命中即豁免（并记账，见文件头「登记即承诺」） */
export function 豁免登记(id, 登记 = 架空结构) {
  return 登记.some((r) => r.test(id))
}

/**
 * 结论口径（自证与实跑都用它）：
 * 只有**洞外**的点才算违规——洞里的地形已被挖掉；贴着洞沿的一圈单列出来给人看，
 * 因为洞沿是 48 边形近似，模型自己的顶点就落在洞沿上。底边还要过登记表。
 */
export function 面违规(面集, 洞集, 地形) {
  return 判面(面集, 洞集, 地形).filter((r) => r.洞外盖点 > 0)
}

export function 底违规(体集, 洞集, 地形) {
  return 判底(体集, 洞集, 地形).filter((r) => r.洞外缝点 > 0 && !豁免登记(r.id))
}

// ---------------------------------------------------------------------------
// 自证：合成样本
// ---------------------------------------------------------------------------
const 洞 = [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]]]
const 洞外 = { lo: 0.05, la: 0.05 }
const 洞内 = { lo: 0.005, la: 0.005 }
const 洞沿上 = { lo: 0, la: 0.005 } // 正好落在洞的左边上

const SELF_TEST_CASES = [
  {
    name: '① 面：洞外的顶面被盖 20m',
    判: () => 面违规([{ id: 'x', 点: [{ ...洞外, 顶: 1300 }] }], 洞, () => 1320),
    expect: 1
  },
  {
    name: '① 面：洞里的顶面被盖 20m（地形已挖掉，不算）',
    判: () => 面违规([{ id: 'x', 点: [{ ...洞内, 顶: 1300 }] }], 洞, () => 1320),
    expect: 0
  },
  {
    name: '① 面：正好落在洞沿上的点放行（48 边形近似的误差）',
    判: () => 面违规([{ id: 'x', 点: [{ ...洞沿上, 顶: 1300 }] }], 洞, () => 1320),
    expect: 0
  },
  {
    name: '① 面：只被盖 0.5m（阈值内，不算）',
    判: () => 面违规([{ id: 'x', 点: [{ ...洞外, 顶: 1300 }] }], 洞, () => 1300.5),
    expect: 0
  },
  {
    name: '① 面：顶面高出地面（架空／堆体）不算',
    判: () => 面违规([{ id: 'x', 点: [{ ...洞外, 顶: 1380 }] }], 洞, () => 1300),
    expect: 0
  },
  {
    name: '① 面：一行里有一个点被盖也算（按实体报，不按点报）',
    判: () =>
      面违规(
        [{ id: 'x', 点: [{ ...洞内, 顶: 1300 }, { ...洞外, 顶: 1300 }] }],
        洞,
        (_, j) => (j === 1 ? 1320 : 1300)
      ),
    expect: 1
  },
  {
    name: '② 墙：洞外底边悬空 3m',
    判: () => 底违规([{ id: 'dump-0-skirt', 类型: 'wall', 点: [{ ...洞外, 底: 1303 }] }], 洞, () => 1300),
    expect: 1
  },
  {
    name: '② 墙：底边埋在土里（差为正）是正常的，不算',
    判: () =>
      底违规([{ id: 'dump-0-skirt', 类型: 'wall', 点: [{ ...洞外, 底: 1270 }] }], 洞, () => 1300),
    expect: 0
  },
  {
    name: '② 墙：底边悬在洞里（那是洞内，不算）',
    判: () =>
      底违规([{ id: 'dump-0-skirt', 类型: 'wall', 点: [{ ...洞内, 底: 1400 }] }], 洞, () => 1300),
    expect: 0
  },
  {
    name: '② 墙：底边悬在洞沿上（封边墙的正常位置）不算',
    判: () =>
      底违规([{ id: 'dump-0-skirt', 类型: 'wall', 点: [{ ...洞沿上, 底: 1400 }] }], 洞, () => 1300),
    expect: 0
  },
  {
    name: '③ 线：最低点悬空 12m（支腿没落地）',
    判: () => 底违规([{ id: 'conveyor-0-bent-3', 类型: 'polyline', 点: [{ ...洞外, 底: 1312 }] }], 洞, () => 1300),
    expect: 1
  },
  {
    name: '④ 盒：底面悬空 4m（设备飘了）',
    判: () => 底违规([{ id: 'plant-block-3', 类型: 'box', 点: [{ ...洞外, 底: 1304 }] }], 洞, () => 1300),
    expect: 1
  },
  {
    name: '登记表：皮带廊侧板悬空 13m 放行（架空结构）',
    判: () =>
      底违规([{ id: 'conveyor-0-wall-1', 类型: 'wall', 点: [{ ...洞外, 底: 1313 }] }], 洞, () => 1300),
    expect: 0
  },
  {
    name: '登记表：皮带廊檐口线悬空 17m 放行',
    判: () =>
      底违规([{ id: 'conveyor-2-eave--1', 类型: 'polyline', 点: [{ ...洞外, 底: 1317 }] }], 洞, () => 1300),
    expect: 0
  },
  {
    name: '登记表：排土场裙墙悬空 5m 必须报（它得落地）',
    判: () =>
      底违规([{ id: 'dump-1-skirt', 类型: 'wall', 点: [{ ...洞外, 底: 1305 }] }], 洞, () => 1300),
    expect: 1
  },
  {
    name: '登记表：台地削坡悬空 5m 必须报',
    判: () =>
      底违规([{ id: 'bench-T2-cut', 类型: 'wall', 点: [{ ...洞外, 底: 1305 }] }], 洞, () => 1300),
    expect: 1
  },
  {
    name: '登记表：名字里带 conveyor 但不是侧板/檐口/支腿的不放行',
    判: () =>
      底违规([{ id: 'conveyor-0-deck', 类型: 'wall', 点: [{ ...洞外, 底: 1313 }] }], 洞, () => 1300),
    expect: 1
  }
]

function selfTest() {
  let bad = 0
  console.log('=== 自证：合成样本 ===')
  for (const c of SELF_TEST_CASES) {
    const got = c.判().length
    const ok = got === c.expect
    if (!ok) bad++
    console.log(`  ${ok ? '✓' : '✗'} ${c.name}`)
    if (!ok) console.log(`      期望报 ${c.expect} 处，实际报 ${got} 处`)
  }
  console.log(bad ? `\n✗ 自证 ${bad}/${SELF_TEST_CASES.length} 项不通过` : `\n✓ 自证 ${SELF_TEST_CASES.length} 项全过`)
  return bad
}

// ---------------------------------------------------------------------------
if (process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 1 : 0)
}

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:8787'
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a)

const session = await login(base)

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
})
const page = await newLoggedInPage(browser, session, { viewport: { width: 1280, height: 800 } })
const 页面错 = []
page.on('pageerror', (e) => 页面错.push(String(e.stack || e).replace(/\s+/g, ' ').slice(0, 300)))

await page.goto(base + '/#/', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForFunction(() => !!window.__cesiumViewer, null, { timeout: 180000 })

// 场景是异步分块建的（地形采样 + 上千个实体）。判「建完了」要看两个条件：
// 实体数连续 5 秒不变，**且**已经过了几百个——只判「不变」会在建完之前就通过。
let 上次 = -1
let 稳定 = 0
let 建完 = false
for (let i = 0; i < 300; i++) {
  const n = await page.evaluate(() => window.__cesiumViewer.entities.values.length)
  if (n === 上次 && n > 500) 稳定++
  else 稳定 = 0
  上次 = n
  if (稳定 >= 5) {
    建完 = true
    break
  }
  await page.waitForTimeout(1000)
}
log('实体数', 上次, 建完 ? '（已稳定）' : '（等超时了，数可能还在涨）')

const 原始 = await page.evaluate(
  async ({ 加密步长 }) => {
    const v = window.__cesiumViewer
    const C = window.__cesiumNS
    const 取 = (p) => (p && typeof p.getValue === 'function' ? p.getValue(C.JulianDate.now()) : p)
    const 数 = (x) => (typeof x === 'number' && isFinite(x) ? x : null)

    const 洞集 = []
    for (const poly of v.scene.globe.clippingPolygons?._polygons ?? []) {
      const ring = (poly._positions ?? []).map((p) => {
        const c = C.Cartographic.fromCartesian(p)
        return [c.longitude, c.latitude]
      })
      if (ring.length >= 3) 洞集.push(ring)
    }

    const 环上点 = (h) => {
      const out = []
      const 走 = (node) => {
        if (!node) return
        for (const p of node.positions ?? []) out.push(p)
        for (const c of node.holes ?? []) 走(取(c))
      }
      走(h)
      return out
    }

    const 面集 = []
    const 体集 = []
    for (const e of v.entities.values) {
      const g = e
      if (g.polygon) {
        const ps = 环上点(取(g.polygon.hierarchy))
        if (!ps.length) continue
        const ex = 数(取(g.polygon.extrudedHeight))
        const h = 数(取(g.polygon.height))
        const perPos = 取(g.polygon.perPositionHeight) === true
        const ref = 取(g.polygon.heightReference)
        let 点
        if (perPos) 点 = ps.map((p) => ({ p, 顶: C.Cartographic.fromCartesian(p).height }))
        else if (ex !== null) 点 = ps.map((p) => ({ p, 顶: ex }))
        else if (h !== null) 点 = ps.map((p) => ({ p, 顶: h }))
        else if (ref !== undefined && ref !== null && ref !== C.HeightReference.NONE) continue // 贴地：天然在地表上
        else 点 = ps.map((p) => ({ p, 顶: 0 }))
        面集.push({ id: e.id, 点 })
      } else if (g.ellipse) {
        const ex = 数(取(g.ellipse.extrudedHeight))
        const h = 数(取(g.ellipse.height))
        const ref = 取(g.ellipse.heightReference)
        const c = 取(g.ellipse.position)
        if (!c) continue
        if (ex !== null) 面集.push({ id: e.id, 点: [{ p: c, 顶: ex }] })
        else if (h !== null) 面集.push({ id: e.id, 点: [{ p: c, 顶: h }] })
        else if (ref !== undefined && ref !== null && ref !== C.HeightReference.NONE) continue
        else 面集.push({ id: e.id, 点: [{ p: c, 顶: 0 }] })
      } else if (g.wall) {
        const ps = 取(g.wall.positions) ?? []
        const mn = 取(g.wall.minimumHeights)
        const arr = Array.isArray(mn) ? mn : null
        // minimumHeights 缺省时 Cesium 按海拔 0 处理（下沿拉到椭球面），这里同样兜底
        const 底 = (i) => (arr ? (数(arr[i]) ?? 0) : (数(mn) ?? 0))
        const 点 = []
        for (let i = 0; i + 1 < ps.length; i++) {
          const a = C.Cartographic.fromCartesian(ps[i])
          const b = C.Cartographic.fromCartesian(ps[i + 1])
          const n = Math.max(1, Math.ceil(C.Cartesian3.distance(ps[i], ps[i + 1]) / 加密步长))
          for (let k = 0; k <= n; k++) {
            if (k === 0 && i > 0) continue // 顶点只记一次
            const f = k / n
            点.push({
              lo: a.longitude + (b.longitude - a.longitude) * f,
              la: a.latitude + (b.latitude - a.latitude) * f,
              底: 底(i) + (底(i + 1) - 底(i)) * f
            })
          }
        }
        if (点.length) 体集.push({ id: e.id, 类型: 'wall', 点 })
      } else if (g.polyline) {
        if (取(g.polyline.clampToGround) === true) continue // 贴地线天然在地表上
        const ps = 取(g.polyline.positions) ?? []
        if (!ps.length) continue
        const cads = ps.map((p) => C.Cartographic.fromCartesian(p))
        // 只取最低的那个顶点：支腿是「落地一截 + 悬空一截」画在同一根线上的
        let 低 = 0
        for (let i = 1; i < cads.length; i++) if (cads[i].height < cads[低].height) 低 = i
        体集.push({ id: e.id, 类型: 'polyline', 点: [{ p: ps[低], 底: cads[低].height }] })
      } else if (g.cylinder) {
        const c = 取(g.cylinder.position)
        const L = 数(取(g.cylinder.length))
        if (!c || L === null) continue
        体集.push({ id: e.id, 类型: 'cylinder', 点: [{ p: c, 底: C.Cartographic.fromCartesian(c).height - L / 2 }] })
      } else if (g.box) {
        const c = 取(g.box.position)
        const d = 取(g.box.dimensions)
        if (!c || !d) continue
        体集.push({ id: e.id, 类型: 'box', 点: [{ p: c, 底: C.Cartographic.fromCartesian(c).height - d.z / 2 }] })
      }
    }

    // 一次问完所有点（level 14：跟应用采地形的最深一层一致）
    const 索引 = []
    const 全部 = []
    const 收 = (lo, la) => {
      索引.push([lo, la])
      全部.push(new C.Cartographic(lo, la))
    }
    for (const e of 面集)
      for (const q of e.点) {
        const c = C.Cartographic.fromCartesian(q.p)
        收(c.longitude, c.latitude)
        q.lo = c.longitude
        q.la = c.latitude
      }
    for (const e of 体集)
      for (const q of e.点) {
        // 墙底是插值出来的点，本来就是经纬度（别再塞回 Cartesian3 当 xyz 用）
        if (q.lo === undefined) {
          const c = C.Cartographic.fromCartesian(q.p)
          q.lo = c.longitude
          q.la = c.latitude
        }
        收(q.lo, q.la)
        delete q.p
      }
    let 采样错 = null
    try {
      await C.sampleTerrain(v.terrainProvider, 14, 全部)
    } catch (err) {
      采样错 = String((err && err.message) || err)
    }
    let k = 0
    for (const e of 面集) for (const q of e.点) q.地形 = 全部[k++].height
    for (const e of 体集) for (const q of e.点) q.地形 = 全部[k++].height

    const 剥 = (e) => ({ id: e.id, 类型: e.类型, 点: e.点.map((q) => ({ lo: q.lo, la: q.la, 顶: q.顶, 底: q.底, 地形: q.地形 })) })
    return { 采样错, 洞集, 面集: 面集.map(剥), 体集: 体集.map(剥) }
  },
  { 加密步长 }
)

await browser.close()

console.log(`巡检 ${base}（地形采样 ${原始.采样错 ? '失败：' + 原始.采样错 : 'level 14 成功'}）`)
console.log(`挖洞 ${原始.洞集.length} 个（登记 ${洞个数登记}：采坑 + 4 级台地 + 2 座排土场 + 尾矿库）`)
console.log(`面实体 ${原始.面集.length} 个、墙/线/盒/柱 ${原始.体集.length} 个；阈值 ${阈值}m，墙底加密步长 ${加密步长}m`)
console.log('')

const 面清单 = 判面(原始.面集, 原始.洞集, (i, j) => 原始.面集[i].点[j].地形)
const 体清单 = 判底(原始.体集, 原始.洞集, (i, j) => 原始.体集[i].点[j].地形)
const 面坏 = 面违规(原始.面集, 原始.洞集, (i, j) => 原始.面集[i].点[j].地形)
const 体坏 = 底违规(原始.体集, 原始.洞集, (i, j) => 原始.体集[i].点[j].地形)
const 体豁免 = 体清单.filter((r) => 豁免登记(r.id))

const 登记命中 = 架空结构.map((r) => [r, [...原始.体集.filter((e) => r.test(e.id)).map((e) => e.id)].length])

console.log('—— 判据① 面的可见顶面被底图盖住 ——')
if (!面坏.length) console.log('  ✓ 洞外没有一处面的顶面在底图之下')
for (const r of 面坏.slice(0, 20))
  console.log(`  ✗ ${r.id}：洞外 ${r.洞外盖点}/${r.点} 点在底图之下，最深 ${r.最大盖深}m`)
const 只在洞沿 = 面清单.filter((r) => r.洞外盖点 === 0 && r.边界盖点 > 0)
if (只在洞沿.length) console.log(`  · 另有 ${只在洞沿.length} 个实体只在洞沿边界带上（地形已挖掉，不算）：${只在洞沿.slice(0, 6).map((r) => r.id).join(' / ')}`)

console.log('')
console.log('—— 判据②③④ 该落地的边悬空了 ——')
if (!体坏.length) console.log('  ✓ 洞外的底边与支腿最低点全部落在土里')
for (const r of 体坏.slice(0, 20))
  console.log(`  ✗ ${r.id}（${r.类型}）：洞外 ${r.洞外缝点}/${r.点} 点悬空，最高 ${r.最大缝高}m`)
const 体边界 = 体清单.filter((r) => r.洞外缝点 === 0 && r.边界缝点 > 0)
const 体洞内 = 体清单.filter((r) => r.洞外缝点 === 0 && r.边界缝点 === 0)
if (体豁免.length) console.log(`  · 另有 ${体豁免.length} 处是登记在册的架空结构（皮带廊侧板／檐口）`)
if (体边界.length) console.log(`  · 另有 ${体边界.length} 处只在洞沿边界带上悬空（洞沿是 48 边形近似，不算）`)
if (体洞内.length) console.log(`  · 另有 ${体洞内.length} 处只在洞里悬空（那片地形已挖掉，不算）`)
console.log(`  · 登记表命中：${登记命中.map(([r, n]) => `${r} → ${n} 个实体`).join('；')}`)

console.log('')
let 退出 = 0
if (原始.采样错) {
  console.log('✗ 地形一个点都没采到，判据无从谈起（检查离线地形 manifest 与网络）')
  退出 = 1
}
if (原始.洞集.length !== 洞个数登记) {
  console.log(
    `✗ 挖洞个数是 ${原始.洞集.length}，登记的是 ${洞个数登记}。` +
      '少了＝某块地物没登记（`registerModelSurface`），它的模型会和底图打架；' +
      '有意新增地物就改这个登记表。'
  )
  退出 = 1
}
if (面坏.length || 体坏.length) {
  console.log(
    `✗ ${面坏.length} 个实体的可见顶面压在底图下面、${体坏.length} 个实体的底边悬空。` +
      '\n  修法（README 第 13 节第 22 条）：' +
      '\n  ① 压在底图下面 → 给这块地物脚印登记 `registerModelSurface(环)`，并在同一文件里砌一圈落地墙；' +
      '\n  ② 墙底悬空 → 墙底取「设计标高」与「沿线地面采样」的较小者，别只在两端顶点上采样；' +
      '\n  ③ 支腿悬空 → 该处的地面采样点要加密（长路径只在折点上采地形，中间会漏掉整个山包）。'
  )
  退出 = 1
}
if (页面错.length) {
  console.log(`✗ 页面运行时报了 ${页面错.length} 个错：${页面错[0]}`)
  退出 = 1
}
if (!退出) console.log('✓ 地物全部贴着底图：没有压在地形之下的可见面，也没有悬空的底边')
process.exit(退出)
