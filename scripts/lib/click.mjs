/**
 * 在这些大屏页面上点 DOM，**不要用 `locator.click()`** —— 它会一直等下去。
 *
 * ---------------------------------------------------------------------------
 * 实测（`tmp-probe-close.mjs`，/reports 页面板浮层的 × 按钮）
 * ---------------------------------------------------------------------------
 *
 *   locator.click({ timeout: 8000 }) →
 *     locator.click: Timeout 8000ms exceeded.
 *     Call log:
 *       - waiting for locator('.reports__pick-close').first()
 *         - locator resolved to <button type="button" class="reports__pick-close">×</button>
 *       - attempting click action
 *         - waiting for element to be visible, enabled and stable      ← 卡在这一项
 *
 * 元素**已经找到了**，也不是没露出来：同一个点上 `document.elementFromPoint`
 * 返回的就是这个 button。紧接着按同一坐标发原始 `mouse.click` ——
 * **回执 0.0 秒返回，点完卡片立刻消失**。
 *
 * 所以卡住的是 Playwright 自己的「元素要连续两帧不动」可操作性检查：
 * 它由注入脚本的 rAF 驱动，而 /reports 上有一个 Cesium + SwiftShader 的
 * 全屏渲染循环在抢主线程的帧。旁证：同一页面上一次 CDP 点击的回执
 * 实测要 68~115 秒才回来。
 *
 * ⚠️ **适用范围的边界，按实测说，别扩大也别缩小**：
 *
 *   | 页面 | 元素 | `locator.click()` |
 *   |---|---|---|
 *   | `/reports` | `.reports__pick-close` | ✗ 卡满 8 秒超时 |
 *   | `/reports` | `.reports__row`（目录行） | ✓ 正常 |
 *   | `/decision` | `.decision__suggestion-act` | ✗ 卡满 10 秒超时 |
 *   | `/decision` | `.decision__toggle`（两个口径按钮） | ✓ 正常，点了就切 |
 *   | `/twin` | `.twin__tab`（第 2 个页签） | ✗ 卡满 10 秒，**把整轮巡检炸掉、一份报告都没产出** |
 *
 * 也就是说它**既不是「所有 Cesium 页面都坏」，也不是「只有某个页面坏」**：
 * 同一个页面（`/reports`）上 `.reports__row` 点得动、`.reports__pick-close` 点不动。
 * 规律没找出来，也不打算猜 —— 所以**没量过的页面和元素，别替它下结论**。
 *
 * 结论只到这一步：**这个坑存在、踩中时不报错（或者炸掉整轮），
 * 所以点 DOM 一律走 `clickAt` 更省心。** 别拿它去批量改写那些
 * 已经跑绿灯、且用的是 `.locator(..., {hasText})` 的脚本（本函数还不支持 hasText）。
 *
 * ⚠️ 这个坑**不会报错**。上游脚本如果写成
 * `await btn.click().catch(() => {})`，症状就是「关浮层这一步什么都没做」，
 * 然后下一个标注被浮层压住、点不着 —— 报出来却是
 * 「点东帮爆破区弹出来的是北帮采剥面」，看上去像锚点表串了。
 * check-linkage.mjs 在这个假象上耗了好几轮。
 *
 * ---------------------------------------------------------------------------
 * 代价，以及为什么这里不是「随便点一下」
 * ---------------------------------------------------------------------------
 * 原始点击**绕过了** Playwright 的可见 / 可用 / 未被遮挡三项检查。
 * 所以这个函数不把它们省掉，而是**自己量一遍**：
 * 尺寸不为 0、不是 disabled、中心点的 `elementFromPoint` 确实是它自己
 * （或它的后代）。量不过就返回 `ok: false` 并说明是被谁压着，
 * 由调用方或后面的效果判据去判死 —— 不做「点了没反应也不报错」的哑巴。
 */

/**
 * 按元素中心发一次**原始**鼠标点击。
 *
 * @returns `{ ok: true, x, y, ms, late }` —— `late` 表示「回执没等到，
 *          但事件已经发出去了」，此时**真值由调用方后面的效果判据回答**，
 *          别把「我没等到回执」说成「页面没收到」。
 *          或 `{ ok: false, reason }`。
 */
export const clickAt = async (page, selector, { index = 0, timeout = 20000, ackTimeout = 90000 } = {}) => {
  const deadline = Date.now() + timeout
  let target = null

  // 用 page.evaluate 轮询，不用 waitForSelector：后者同样走注入脚本，
  // 而这个函数存在的理由就是「注入脚本那套在这几页上不可靠」。
  while (Date.now() < deadline) {
    target = await page.evaluate(
      ([sel, i]) => {
        const el = document.querySelectorAll(sel)[i]
        if (!el) return null
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) return { empty: true, w: r.width, h: r.height }
        const x = r.left + r.width / 2
        const y = r.top + r.height / 2
        const top = document.elementFromPoint(x, y)
        return {
          x,
          y,
          disabled: el.disabled === true,
          top: top ? `${top.tagName.toLowerCase()}.${String(top.className).split(' ').join('.') || '(无 class)'}` : '(null)',
          covered: !(top === el || el.contains(top))
        }
      },
      [selector, index]
    )
    if (target && !target.empty) break
    await new Promise((r) => setTimeout(r, 200))
  }

  if (!target) return { ok: false, reason: `等了 ${timeout}ms，页面上没有 ${selector}[${index}]` }
  if (target.empty) return { ok: false, reason: `${selector}[${index}] 尺寸为 0（${target.w}×${target.h}）` }
  if (target.disabled) return { ok: false, reason: `${selector}[${index}] 是 disabled` }
  if (target.covered) {
    return {
      ok: false,
      reason: `${selector}[${index}] 中心点 [${Math.round(target.x)},${Math.round(target.y)}] 被 ${target.top} 压着`
    }
  }

  const t0 = Date.now()
  const ack = await Promise.race([
    page.mouse.click(target.x, target.y).then(() => ({ late: false })),
    new Promise((res) => setTimeout(() => res({ late: true }), ackTimeout))
  ])
  return { ok: true, x: target.x, y: target.y, ms: Date.now() - t0, late: ack.late }
}
