/**
 * 实时链路端到端验证：起一个 WS 桩服务，让设备管理页连上去，确认推送真的进了界面。
 *
 * 断言分三层，缺一不可：
 *   1. **线缆层** —— 浏览器确实发出了 `subscribe` 帧（用 Playwright 抓真实 WS 帧）
 *   2. **数据层** —— 收到了桩服务推送的 `device.status` 消息
 *   3. **界面层** —— 推送的内容出现在告警列表里，且排在原 mock 数据之前
 *
 * 第 1 层是关键。修复前 `subscribe()` 不调 `connect()`，
 * 订阅会静默登记在册而 socket 始终是 null——那样第 2、3 层永远不成立，
 * 而且不报任何错。所以「有没有发出 subscribe 帧」就是那个 bug 的判据。
 *
 * 前置：已 `npm run build`（带 VITE_WS_URL 指向桩服务），且 `npm run preview` 在跑。
 * 用法：node scripts/check-realtime.mjs [baseUrl]
 */
import { chromium } from 'playwright'
import { login, newLoggedInPage } from './lib/session.mjs'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

const 位置参数 = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const base = 位置参数[0] || 'http://localhost:8787'
const WS_PORT = 8765
/** 推送间隔 */
const PUSH_INTERVAL = Number(位置参数[1]) || 2500
const PUSH_COUNT = 3
/**
 * 人为拖慢告警接口的返回（毫秒）。
 *
 * 为什么要这个开关：降级到内置 mock 时接口几乎瞬时返回，
 * 「推送在首次加载返回之前到达」的窗口只有几十毫秒宽，正常跑碰不上——
 * 于是测试对这一类丢数据**没有分辨力**，实现改坏了它照样绿。
 * 把接口拖慢到数秒，窗口被撑开到必然命中，这个测试才真正守得住那条断言。
 * 传 3000 即可复现。
 */
const SLOW_API = Number(位置参数[2]) || 0

const outDir = '.snapshots/realtime'

// ---------------------------------------------------------------------------
// 判据（纯函数，`--self-test` 直接喂**合成的 WS 帧**——与浏览器交上来的形状一致）
// ---------------------------------------------------------------------------

/**
 * 输入就是现场原始数据：
 *   发送帧 / 接收帧（WS 帧的字符串数组）、桩日志（文本）、界面列表（读出来的告警行）、
 *   错误数、拦到次数、需要拦（是否传了 SLOW_API）。
 * 返回 { checks: [[名字, 是否通过], …], 派生: { 已订阅, 推送, 缺的 } }。
 *
 * 判定以「抓到的推送帧」为基准，而不是「列表比初始多了几条」：后者有时序依赖
 * （推送可能在首次加载返回之前就到了，那时 `before` 读到的已经不是纯净的 mock 列表，
 * 条数对不上——那是测试的问题，不是功能的）。拿帧做基准就没有这个窗口：
 * 服务端推了什么，界面里就必须有什么。
 *
 * ⚠️ 但「推送在首次加载期间到达」这个时序**本身**是要验的：加载完成会整体覆盖列表，
 * 早期实现会把这段窗口内到达的推送悄悄冲掉。所以第三条断言用
 * 「每条推送都必须在列表里」来卡它，而不是只数条数。
 */
export function 判(测得) {
  const 发送帧 = 测得.发送帧 ?? []
  const 接收帧 = 测得.接收帧 ?? []
  const 界面列表 = 测得.界面列表 ?? []
  const 期望条数 = 测得.期望推送条数 ?? 3

  const 已订阅 = 发送帧.some((f) => {
    try {
      const m = JSON.parse(f)
      return m.type === 'subscribe' && m.topic === 'device.status'
    } catch {
      return false
    }
  })

  const 推送 = 接收帧
    .map((f) => {
      try {
        const m = JSON.parse(f)
        return m.topic === 'device.status' ? m.data : null
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const 界面键 = new Set(界面列表.map((a) => `${a.device}|${a.time}`))
  const 缺的 = 推送.filter((d) => !界面键.has(`${d.device}|${d.time}`))
  /** 被推送过的那些行的键 —— 用来判「列表最前面那条是不是推送来的」 */
  const 推送键 = new Set(推送.map((d) => `${d.device}|${d.time}`))

  const checks = [
    ['浏览器发出了 subscribe 帧（修复的判据）', 已订阅],
    ['桩服务收到了订阅消息', /收到:.*"type":"subscribe"/.test(测得.桩日志 ?? '')],
    [`收到 ${期望条数} 条推送`, 推送.length >= 期望条数],
    ['每条推送都出现在列表里（含加载期间到达的）', 缺的.length === 0],
    [
      /**
       * 这里原来比的是 `界面键`（列表**自己的**键集合）——
       * 于是「列表非空」就等于「通过」，**恒真**，名字里那件事一件也没验。
       * 自证把这条抓出来了（当时红的不是判据，是它压根不会红）。
       * 真正的形状见 `EquipmentView.vue:385`：`[...pushedAlerts, ...loadedAlerts]`，
       * 推送那批必须整体排在接口拉来的前面，所以拿**推送键**去比第一行。
       */
      '推送的告警排在原 mock 数据之前',
      界面列表.length > 0 && 推送键.has(`${界面列表[0].device}|${界面列表[0].time}`)
    ],
    ['页面无错误', (测得.错误数 ?? 0) === 0]
  ]

  // 拖慢接口的开关只有在拦到请求时才有意义。拦不到说明测试在自欺欺人——
  // 那时它并没有真正验「推送先到」，只是碰巧全量返回得快而已。
  if (测得.需要拦) {
    checks.push([`告警接口确实被拦到（${测得.拦到次数 ?? 0} 次）`, (测得.拦到次数 ?? 0) > 0])
  }

  return { checks, 派生: { 已订阅, 推送, 缺的 } }
}

// ---------------------------------------------------------------------------
// 自证：合成的 WS 帧与界面列表（不连浏览器、不起桩服务）
// ---------------------------------------------------------------------------
/** 桩服务推的第 n 条设备推送，形状同 `ws-stub.mjs` */
const 推送帧 = (n) =>
  JSON.stringify({ topic: 'device.status', data: { device: `桩设备${n}`, type: '温度', time: `2026-09-14 10:0${n}:00` } })
/** 节点管理页读出来的告警行 */
const 告警行 = (n) => ({ device: `桩设备${n}`, type: '温度', time: `2026-09-14 10:0${n}:00` })
const 订阅帧 = JSON.stringify({ type: 'subscribe', topic: 'device.status' })
const 桩日志 = '收到: {"type":"subscribe","topic":"device.status"}'

/** 健康现场：6 条断言全绿 */
const 健康 = {
  发送帧: [订阅帧],
  接收帧: [推送帧(1), 推送帧(2), 推送帧(3)],
  桩日志,
  界面列表: [告警行(3), 告警行(2), 告警行(1), { device: 'mock设备', type: '离线', time: '2026-09-14 09:00:00' }],
  错误数: 0,
  拦到次数: 0,
  需要拦: false
}

export const 自证样本 = [
  { name: '正例·健康现场（全部断言绿）', 测得: 健康, 应绿: ['全部'], 应红: [] },
  {
    // 修复前那个 bug：subscribe 静默登记在册、socket 始终是 null
    name: '正例·没发出 subscribe 帧（修复的判据）',
    测得: { ...健康, 发送帧: [] },
    应红: ['subscribe 帧']
  },
  {
    name: '正例·桩服务没收到订阅消息',
    测得: { ...健康, 桩日志: '桩服务已启动 ws://localhost:8765/ws' },
    应红: ['桩服务收到了']
  },
  {
    name: '正例·只收到 2 条推送',
    测得: { ...健康, 接收帧: [推送帧(1), 推送帧(2)] },
    应红: ['条推送']
  },
  {
    // 加载完成整体覆盖列表，把加载窗口内到达的推送冲掉——只数条数看不出来
    name: '正例·推送丢在加载窗口里（收到 3 条、界面只留第 1 条）',
    测得: { ...健康, 界面列表: [告警行(1), { device: 'mock设备', type: '离线', time: '2026-09-14 09:00:00' }] },
    应红: ['每条推送都出现在列表里']
  },
  {
    name: '正例·推送没排在 mock 数据之前',
    测得: { ...健康, 界面列表: [{ device: 'mock设备', type: '离线', time: '2026-09-14 09:00:00' }, { ...告警行(3) }, { ...告警行(2) }, { ...告警行(1) }] },
    应红: ['排在原 mock 数据之前']
  },
  { name: '正例·页面有错误', 测得: { ...健康, 错误数: 2 }, 应红: ['页面无错误'] },
  {
    name: '正例·要拦接口却一次没拦到（测试在自欺欺人）',
    测得: { ...健康, 需要拦: true, 拦到次数: 0 },
    应红: ['拦到']
  },
  { name: '反例·要拦接口且拦到了', 测得: { ...健康, 需要拦: true, 拦到次数: 3 }, 应绿: ['拦到'], 应红: [] },
  {
    // 界面上多出来的记录不算问题：断言只要求「推送过的都在」，不要求「只能有推送的」
    name: '反例·界面上另有 mock 与历史记录（不许报）',
    测得: { ...健康, 界面列表: [告警行(3), 告警行(2), 告警行(1), { device: 'mock设备', type: '离线', time: '2026-09-14 09:00:00' }, { device: '历史设备', type: '振动', time: '2026-09-13 08:00:00' }] },
    应红: []
  },
  {
    // 不传 SLOW_API 时那条断言根本不该存在（原来它是条件 push 的）
    name: '反例·没开 SLOW_API 时不产出「拦到」这条断言',
    测得: 健康,
    应绿: ['全部'],
    应红: [],
    应无断言: ['拦到']
  }
]

function 自证() {
  let 坏 = 0
  console.log('=== 自证：合成的 WS 帧与界面列表 ===')
  const 全部断言名 = 判(健康).checks.map(([n]) => n)
  const 被证伪过 = new Set()

  for (const c of 自证样本) {
    const { checks } = 判(c.测得)
    const 红 = checks.filter(([, ok]) => !ok)
    const 名字 = checks.map(([n]) => n)
    const 报错 = []
    for (const 子串 of c.应红 ?? []) {
      if (!红.some(([n]) => n.includes(子串))) 报错.push(`期望「${子串}」判红，它没红`)
    }
    for (const 子串 of c.应绿 ?? []) {
      const 命中 = 子串 === '全部' ? checks : checks.filter(([n]) => n.includes(子串))
      const 没绿的 = 命中.filter(([, ok]) => !ok)
      if (!命中.length) 报错.push(`期望「${子串}」判绿，但找不到这条断言`)
      for (const [n] of 没绿的) 报错.push(`期望「${子串}」判绿，「${n}」却是红的`)
    }
    for (const 子串 of c.应无断言 ?? []) {
      if (名字.some((n) => n.includes(子串))) 报错.push(`不该产出「${子串}」这条断言，它却在`)
    }
    // 「哪些断言被证伪过」是用来查死断言的：一条从没在任何样本里判红过的断言，
    // 与一条恒真的断言，在日志上长得一模一样（第 5 节的规矩：每条断言都要能红）
    for (const [n] of 红) if (全部断言名.includes(n)) 被证伪过.add(n)

    if (报错.length) 坏++
    console.log(`  ${报错.length ? '✗' : '✓'} ${c.name}`)
    for (const m of 报错) console.log(`      ${m}`)
  }

  const 没证伪过 = 全部断言名.filter((n) => !被证伪过.has(n))
  if (没证伪过.length) {
    坏++
    console.log(`\n✗ 有 ${没证伪过.length} 条断言在任何样本里都没判红过（可能是恒真的死断言）：`)
    for (const n of 没证伪过) console.log(`      ${n}`)
  } else {
    console.log(`\n✓ ${全部断言名.length} 条断言都至少在一个样本里被判红过`)
  }

  console.log(坏 ? `\n✗ 自证 ${坏} 项不通过` : `\n✓ 自证 ${自证样本.length} 项全过`)
  return 坏
}

if (process.argv.includes('--self-test')) {
  process.exit(自证() ? 1 : 0)
}

// ---------------------------------------------------------------------------
await mkdir(outDir, { recursive: true })

// ---------- 1. 起桩服务 ----------
const stub = spawn(
  process.execPath,
  [
    'scripts/ws-stub.mjs',
    '--port',
    String(WS_PORT),
    '--interval',
    String(PUSH_INTERVAL),
    '--count',
    String(PUSH_COUNT)
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)

const stubLog = []
stub.stdout.on('data', (d) => stubLog.push(d.toString()))
stub.stderr.on('data', (d) => stubLog.push('[stderr] ' + d.toString()))

/** 等桩服务把监听端口的日志打出来 */
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('桩服务启动超时')), 8000)
  const check = () => {
    if (stubLog.join('').includes('已启动')) {
      clearTimeout(timer)
      resolve()
    } else {
      setTimeout(check, 100)
    }
  }
  check()
})
console.log(`✓ 桩服务已启动 ws://localhost:${WS_PORT}/ws`)

// ---------- 2. 打开页面，抓 WS 帧 ----------
const session = await login(base)

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--js-flags=--max-old-space-size=3072'
  ]
})
const page = await newLoggedInPage(browser, session, { viewport: { width: 1920, height: 1080 } })

/** 浏览器侧看到的真实 WS 帧 */
const frames = { sent: [], received: [] }
page.on('websocket', (ws) => {
  console.log('  [ws] 浏览器建立了 WebSocket 连接')
  ws.on('framesent', (f) => frames.sent.push(typeof f === 'string' ? f : String(f.payload)))
  ws.on('framereceived', (f) =>
    frames.received.push(typeof f === 'string' ? f : String(f.payload))
  )
})

// 拖慢告警接口，把「推送先到、全量后到」的窗口撑开
let routeHits = 0
if (SLOW_API) {
  await page.route('**/api/equipment/device-alerts*', async (route) => {
    routeHits++
    await new Promise((r) => setTimeout(r, SLOW_API))
    await route.continue()
  })
  console.log(`  [setup] 告警接口已延迟 ${SLOW_API}ms 返回`)
}

const errs = []
const apiMisses = []
page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)))
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const text = m.text().slice(0, 120)
  // 后端未就绪时接口首次 404 是预期行为（请求层会自动降级到内置数据），
  // 单独归类，不混进真实错误里造成误报——与 check-all-pages.mjs 同一套口径
  if (text.includes('404') || text.includes('/api/')) apiMisses.push(text)
  else errs.push('CONSOLE ' + text)
})
// 进设备管理页 —— 挂载时会 useRealtime 订阅
await page.goto(base + '/#/equipment', { waitUntil: 'domcontentloaded', timeout: 90000 })

// 关键一步：整页 reload。
//
// 首页那几个接口 404 已经把 http.ts 的模块级 `degraded` 置为 true，
// 而一旦置真，本次页面生命周期内的请求都会**直接返回内置 mock、根本不发出去**，
// 于是 page.route 拦不到 device-alerts，上面那个「拖慢接口」也就形同虚设。
// reload 会重置这个模块状态，设备管理页的请求才真的走网络。
// （注：导航到锚点不会重新加载文档，必须显式 reload。）
//
// 这套「会话级降级」的取舍见 README §13：没有反向重置入口，
// 后端恢复后刷新页面即可——所以这里的 reload 不只是为了重置路由状态。
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(6000)

const readAlerts = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.equipment__alert')].map((li) => ({
      device: li.querySelector('.equipment__alert-device')?.textContent.trim() ?? '',
      type: li.querySelector('.equipment__alert-type')?.textContent.trim() ?? '',
      time: li.querySelector('.equipment__alert-time')?.textContent.trim() ?? ''
    }))
  )

// 页面刚起来时应该只有 mock 的 4 条
const before = await readAlerts()
console.log(`✓ 初始告警 ${before.length} 条（mock）`)

// 等推送进来：留足 PUSH_COUNT 个间隔
await page.waitForTimeout(PUSH_INTERVAL * (PUSH_COUNT + 1))
const after = await readAlerts()

await page.screenshot({ path: `${outDir}/equipment-realtime.png` })

await browser.close()
stub.kill()

// ---------- 3. 判定 ----------
const log = stubLog.join('')

// 现场原始数据直接交给纯函数，判定只有一份实现（自证喂的就是同一形状）
const { checks, 派生 } = 判({
  发送帧: frames.sent,
  接收帧: frames.received,
  桩日志: log,
  界面列表: after,
  错误数: errs.length,
  期望推送条数: PUSH_COUNT,
  拦到次数: routeHits,
  需要拦: SLOW_API > 0
})
const { 推送: pushedDevices, 缺的: missing } = 派生

console.log('\n' + '='.repeat(64))
for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`)
console.log('='.repeat(64))

console.log(`\n发送帧 ${frames.sent.length} 条：`, frames.sent.slice(0, 3))
console.log(`接收帧 ${frames.received.length} 条，前 3 条：`)
for (const d of pushedDevices.slice(0, 3)) console.log('   ', JSON.stringify(d))

console.log(`\n列表变化：${before.length} 条 → ${after.length} 条`)
console.log(`  当前最前 3 条:`)
for (const a of after.slice(0, 3)) console.log(`    ${a.device} / ${a.type} / ${a.time}`)
if (missing.length) {
  console.log('  ⚠ 推送了但界面上没有：')
  for (const m of missing) console.log(`    ${m.device} / ${m.time}`)
}

console.log(`\n接口未就绪（预期，已降级到内置数据）：${apiMisses.length} 条`)
if (errs.length) {
  console.log('页面错误：')
  for (const e of errs.slice(0, 10)) console.log('   ', e)
}

const failed = checks.filter(([, ok]) => !ok)
process.exit(failed.length ? 1 : 0)
