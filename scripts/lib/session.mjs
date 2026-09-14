/**
 * 巡检脚本共用的登录态注入。
 *
 * ## 为什么需要它
 *
 * 加了登录之后，页面默认全部要求已登录（`src/router/guard.ts` 是 fail-closed
 * 的）。巡检脚本直奔 `#/equipment` 会被守卫弹回 `#/login`，然后**卡在
 * 「等 .equipment__part 出现」上超时** —— 报出来的错误是「找不到元素」，
 * 而真正的原因是没登录。这个错法极其误导，所以统一走这里登录一次。
 *
 * ## 注入的是 localStorage，不是去点登录框
 *
 * 走界面登录要多等一轮页面渲染 + 输入 + 跳转，十几个脚本各来一次太慢；
 * 而且登录页本身改版就会让所有巡检一起红。这里直接调接口拿 token，
 * 再用 `addInitScript` 在页面脚本执行前把会话写进 localStorage
 * —— 正是 `stores/user.ts` 的 `restore()` 读的那一份。
 *
 * ⚠️ **`STORAGE_KEY` 必须与 `src/stores/user.ts` 里的保持一字不差。**
 * 改了一边忘了另一边，全部巡检会同时挂在「找不到元素」上。
 * `scripts/check-auth.mjs` 会读两边源码比对，防的就是这个。
 *
 * ## 这些脚本现在需要后端在跑
 *
 * 以前 `vite preview` 起一个纯静态服务就能跑巡检；现在登录必须由后端发令牌，
 * 所以巡检要打 `npm run serve`（8787）。脚本打到一个没有 /api 的地址时
 * 会明确报「登录失败」而不是让后面 14 个脚本各报一次「找不到元素」。
 */

/** 与 `src/stores/user.ts` 的 STORAGE_KEY 一致 */
export const STORAGE_KEY = 'smart-mine.session'

/** 演示账号 —— 与 `server/auth.mjs` 的 DEMO_ACCOUNTS 一致，check-auth 会比对 */
export const ADMIN = { username: 'admin', password: 'admin123' }
export const USER = { username: 'user', password: 'user123' }

/**
 * 调接口登录，拿到 `{ token, user }`。
 *
 * 失败时抛出**说明白了的**错误：巡检脚本的调用方（人）最需要知道的是
 * 「后端没起」，而不是一个 `TypeError: fetch failed`。
 */
export async function login(base, account = ADMIN) {
  const url = `${base}/api/auth/login`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(account)
    })
  } catch (err) {
    throw new Error(
      `连不上 ${url} —— 巡检现在需要后端在跑，请先执行 npm run serve（8787），` +
        `并把脚本的 baseUrl 指向它。原始错误：${err.message}`
    )
  }

  if (!res.ok) {
    throw new Error(
      `登录失败（HTTP ${res.status}）：${account.username} @ ${url}。` +
        `若库是新删的，先跑 npm run db:seed 重建账号与种子数据。`
    )
  }
  return res.json()
}

/**
 * 在页面执行任何脚本之前注入会话。
 *
 * 必须在 `goto` **之前**调用 —— `addInitScript` 只对之后发生的导航生效。
 */
export async function applySession(page, session) {
  await page.addInitScript(
    ([key, payload]) => {
      window.localStorage.setItem(key, payload)
    },
    [STORAGE_KEY, JSON.stringify(session)]
  )
}

/**
 * 建一个已登录的页面 —— 各脚本把 `browser.newPage(opts)` 换成它即可。
 *
 * 包一层是为了让「建页面」和「注入会话」**绑在一起**：分成两步写的话，
 * 以后新加一个页面很容易只写前者，而漏掉会话的后果是「这页巡检诡异超时」，
 * 排查成本远高于这里多一个函数。
 */
export async function newLoggedInPage(browser, session, options) {
  const page = await browser.newPage(options)
  await applySession(page, session)
  return page
}
