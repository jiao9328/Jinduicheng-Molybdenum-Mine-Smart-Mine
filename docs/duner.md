# 墩儿 · 自然语言指挥层（实现说明）

> 面向**读代码的人**。怎么用、界面上长什么样见 README 首屏与第十三节第 32、34 条；
> 这份文档只讲四件事：**模块怎么切、一次请求怎么走、为什么这么设计、判据钉住了什么**。
>
> 代码位置：后端 `server/duner/**`（19 个模块）、前端 `src/duner/**` + `src/components/DunerDock.vue`；
> 巡检脚本 `scripts/check-duner.mjs`、截图脚本 `scripts/make-duner-shots.mjs`。

---

## 0. 一句话链路

```
用户说一句话
  → POST /api/duner/chat（server/routes.mjs → server/duner/service.mjs）
  → 归一化（词典热读）→ 规则引擎分类 → 认不出才问 DeepSeek
  → 意图 + 槽位 → 权限闸 → 工具执行
       ├─ 只读工具：直接执行，产出「指令 + 卡片 + 回话」
       └─ 写工具：**不执行**，发一枚一次性确认令牌（60s）
  → 响应体返回 { reply, commands, cards, confirm?, clarify?, auditId }
  → 前端 src/duner/bridge.ts 按工具名分派：飞相机 / 切图层 / 导出 CSV
  → POST /api/duner/receipt 回执，按 auditId 挂回这次对话的审计行
```

**指令不走 WebSocket**：每条指令都是对用户某句话的应答，不需要后端主动推送；
本项目的 WS 也刻意默认关闭（握手失败会在控制台留 error，破坏「0 控制台错误」这条验收线）。
理由与取舍记在 README 第十三节第 32 条。

---

## 1. 模块地图

### 后端 `server/duner/`

| 模块 | 职责 | 一句关键点 |
|---|---|---|
| `config.mjs` | 读环境变量（模型、超时、TTL、置信度门槛） | `loadEnv()` 必须**在模块加载时**调用，否则模块级常量永远拿不到配置值，且**没有任何报错** |
| `vocab.mjs` | 地名/图层名清单（`KNOWN_PLACES` 等） | 只有**名字**，没有坐标 —— 回答「认不认识」，不回答「在哪」 |
| `dict.mjs` | 术语词典（SQLite `dict_term`） | 种子用 `ON CONFLICT DO NOTHING`；词典是**运行时可改的配置**，不能被重启灌回原样 |
| `normalize.mjs` | 归一化：中文数字、同义词替换 | 替换按长度降序、不许落进真实地名里、不许吞掉后面的序号 |
| `rule.mjs` | 规则引擎（有序表 + `guard`） | **正则命中 ≠ 意图命中**，槽位抽出来才算命中 |
| `llm.mjs` | DeepSeek 兜底 | 成功判断看**内容**不看状态码（实测该模型返回过 200 + 空 content） |
| `intents.mjs` | 意图表：读 12 / 写 5 / 应急 2 / 系统 5 = **24** 条 | 工具名一律点号；一个意图只挂一个工具 |
| `tools/registry.mjs` | 工具注册与校验 | 写工具**必须**有 `commit()`，否则**注册时就抛** |
| `tools/viewTools.mjs` `dataTools.mjs` `writeTools.mjs` `planTools.mjs` | **17 个工具**（只读 12 / 写 5） | 只读工具直接执行；写工具只产出确认卡与 payload |
| `policy.mjs` | 权限闸（第二层） | 判定依据是**工具自己的 `readOnly`**，不是意图表 |
| `confirm.mjs` | 确认令牌（`pending_confirm` 表） | 判定与置位**在同一条 SQL 里**，拿 `changes === 1` 当唯一凭据 |
| `pending.mjs` | 「上一句我问了你什么」（进程内存） | 与 `pending_confirm` 要保的性质不同：一个只是上下文，**不构成授权** |
| `audit.mjs` | 五类审计（`audit_log`） | 原始输入、写操作、回执、拒绝、词典 各占一行 |
| `facts.mjs` | 事实数据（复用的 mock 数据源） | 不手抄第二份数字 —— 「大屏说 27.8、助手说 26.5」不会有检查脚本发现 |
| `service.mjs` | 编排：一次对话的完整流程 | 主流程 `NLU → 决策 → 权限 → 确认/执行 → 反馈` |

### 前端

| 模块 | 职责 | 一句关键点 |
|---|---|---|
| `src/components/DunerDock.vue` | 右下角按钮 + 对话框 | 按钮是**开合切换**的；面板挂在缩放容器里，跟页面一起等比缩放 |
| `src/duner/corner.ts` | 按钮的让位算法 | `right` 是**当场量出来的**，不是每页配一个偏移表 |
| `src/duner/scene.ts` | 模块级总线（相机 / 图层 / 模拟三个句柄） | 注销**必须比对 id**：路由切换是「新的先挂载、旧的后卸载」 |
| `src/duner/places.ts` | 中文地名 → 坐标 | 坐标只在前端；找不到就是找不到，**不退回矿区中心** |
| `src/duner/bridge.ts` | 指令 → 动作 | 做不到就说做不到；回执必发（含失败） |
| `src/api/duner.ts` | 四个接口封装（chat / confirm / receipt / capabilities） | **一律 `http.post`，不走降级** —— 对话没有「内置数据」可言，编一句「已完成」比报错坏得多 |
| `src/utils/csv.ts`、`src/scene/highlight.ts` | 本轮抽出来的公共实现 | 两份逐字节相同的副本会让「谁后还原谁说了算」把高亮永久留下 |

---

## 2. 一次 `/api/duner/chat` 请求的完整链路

| # | 做什么 | 位置 |
|---|---|---|
| 1 | 未登录一律 401（统一前置闸） | `server/routes.mjs` |
| 2 | `POST /duner/chat` → 空文本 400；**超长截断到 500 而不是拒绝** | `routes.mjs` 的 `dunerChat` |
| 3 | 灌词典种子（`ON CONFLICT DO NOTHING`） | `service.mjs` → `dict.mjs` |
| 4 | **归一化**：中文数字 → 阿拉伯、词典同义词 → 标准词（**每次对话都现读库**，不是启动快照） | `service.mjs` → `normalize.mjs` / `dict.mjs` |
| 5 | **规则引擎** `classify(text)`：有序表，第一条命中且过 `guard` 即返回 | `rule.mjs` |
| 6 | 取出上一轮的反问；本轮认不出时，把这句当作上一轮问题的答案接续 | `pending.mjs`（取出即清） |
| 7 | 认不出或置信度 < 0.8 → 问模型（仅在 `available` 时） | `llm.mjs` |
| 8 | 系统意图分流：越界拒绝（「删除所有数据」）/ 纠错（「不是这个」）/ 帮助 | `service.mjs` |
| 9 | 截到最多 4 个意图 | `service.mjs` |
| 10 | **权限**：普通用户提出写意图 → 直接拒绝（**连确认卡都拿不到**） | `policy.mjs` |
| 11 | **执行**：意图 → 工具名 → `runTool()`；只读工具跑完即得指令，写工具只产出确认卡 | `tools/registry.mjs` |
| 12 | 写操作 → 发一次性令牌（`pending_confirm`），并清理过期令牌 | `confirm.mjs` |
| 13 | 记下本轮反问，供下一句接续 | `pending.mjs` |
| 14 | 拼回话 + 落审计（原始输入与归一化后的文本都存） | `service.mjs` / `audit.mjs` |
| 15 | 返回 `{ reply, commands, cards, confirm, clarify, source, degraded, ms, auditId }` | `service.mjs` |
| 16 | 前端执行指令（逐条隔离，单条失败不影响其余），随后发回执 | `bridge.ts` → `POST /duner/receipt` |

**确认走另一条路**：`POST /api/duner/confirm` 带令牌 → 判归属 → 判过期 → 单条 SQL 兑换 →
兑换成功**才**调 `commit()` 落库。无效/过期/重复使用一律 **409**（不是 500 —— 那是「后端坏了」，会被前端当成故障）。

---

## 3. 意图识别：为什么规则在前、模型在后

指导书第 11 节要求核心指令（导航 / 图层 / 查询状态）**离线 100% 可用**。
把模型放在必经之路上，等于把这条承诺挂在一个会超时、会限流、实测还返回过
「HTTP 200 + 空 content」的外部依赖上 —— 所以顺序是**规则优先、模型兜底**，不是反过来。

- **有序表即语义**：应急排最前、`ONLY` 先于 `SHOW`、`LOCATE` 先于 `FLYTO`、越界在业务之后但 `HELP` 之前。
  顺序本身就是规格，改顺序等于改行为。
- **`guard`：正则命中 ≠ 意图命中**。`LAYER.SHOW` 的「打开」会吃掉「打开北帮3号台阶」，
  `NAV.FLYTO` 的「去」会吃掉「过去一小时产量」—— 两个错的形状都是「槽位没抽到却当命中」，
  所以每个规则还要把槽位抽出来才算数。
- **置信度是手写常数**，不是算出来的分数：「没人能说清 0.73 和 0.81 的区别」。
- **模型只在它真的给出意图时覆盖规则**；模型也认不出时，保留规则的低置信结果（而不是清空）。
- **降级是静默的、但不假装成功**：无密钥 → `degraded='no_key'`；超时 8s（前端 15s，必须留余量，
  否则「前端已报失败、后端还在写审计」，两边账对不上）→ `degraded='timeout_*'`。
  失败**不抛异常**，返回空意图数组。

### 三条实测出来的硬约束（都在 `llm.mjs` 文件头）

1. 工具名**不能带点号**（线上名 `map.flyTo` 会 HTTP 400，报错文案是 `Failed to parse the request body`，
   **看着像 JSON 写坏了**）→ 传输时点号↔下划线互转。
2. `deepseek-v4-pro` 返回过 **HTTP 200 + 空 content** → 成功判断看有没有 `tool_calls` 或非空 content。
3. 中文必须用 node `fetch` 发（`curl -d` 按 GBK 编码，服务端收到乱码 —— 是客户端的锅）。

---

## 4. 写操作：确认与审计是怎么被「钉死」的

这套东西的价值全在一条承诺上：**未经用户确认，一个字节都不写**。它在代码里有五道结构：

1. **注册期**：`readOnly: false` 的工具必须实现 `commit()`，否则 `defineTool()` 直接抛。
   这条校验最有价值 —— 只写 `execute()` 的写工具**照样能注册、照样能发卡、用户点确认后也"成功"返回**，
   只是库里什么都没有。
2. **`execute()` 不落库**，只返回 `planResult({ text, card, payload })`。
3. **编排层对 `plan` 只记待确认、不执行**：确认卡是问「要不要做」，不是问「做什么」，
   参数不齐仍要在 `execute()` 里反问。
4. **落库唯一入口 `commit()`，且只在令牌兑换成功后调用**。
5. **令牌不可猜 + 一次性**：`randomBytes(24)`；兑换是
   `UPDATE ... SET redeemed=1 WHERE token=? AND redeemed=0 AND expires_at>?`，
   **判定与置位在同一条语句里**，拿 `changes === 1` 当唯一凭据 ——
   写成「先查再改」的话，两个并发的同令牌请求可以双双通过（这个接口是 async 的，
   兑换之后还要 await 执行工具与写审计，窗口足够大）。

**权限有两层，别只看一层**：

- **路由级**：`POST·DELETE /duner/dict`、`GET /duner/audit` 要 admin；其余登录即可。
- **工具级**（`policy.mjs`）：判定依据是**工具自己的 `readOnly`**，不是意图表 ——
  意图有两个来源，规则给意图 ID、模型给工具名，只看意图表的话模型产出的调用**整张表都绕过去了**。
  普通用户提出写意图直接拒绝，**连确认卡都不发**（否则「确认一下就能写」这条路是通的，
  等于把权限押在前端拦不拦得住上）。

**审计五类**，各占一行、缺一不可：`duner`（对话，原始输入与归一化文本都存）、`duner.write`（写操作单列，
排查优先级和「查了一下」完全不同）、`duner.receipt`（前端回执）、`duner.denied`（越界拒绝）、
`duner.dict.*`（词典改动）。`detail` 截断到 2000 字并**标明已截断**。

---

## 5. 前端三件事

### 5.1 为什么要有 `scene.ts` 这层总线

面板挂在 `App.vue` 上，而 viewer 在 `MapScene.vue` 组件内部的 `shallowRef` 里 ——
面板**够不到任何 viewer**。否掉的三条路：再挂一个隐藏 MapScene 抢 DOM id /
用 `window.__cesiumViewer`（那是诊断入口，会被删）/ 按前缀捞图层（会误吞）。
三个句柄分开（相机 / 图层 / 模拟），相机句柄由 `MapScene.vue` 自己登记，
**九个页面一次性都有导航能力，不用挨个改页面**。
注销必须比对 id：路由切换时「新页面先挂载、旧页面后卸载」，不比 id 会把刚登记好的新场景顺手清掉，
表现是「切一次页之后墩儿就不认路了」。

### 5.2 坐标只在前端

后端只有**名字清单**（`vocab.mjs`），坐标在前端（`sceneTargets.ts` 的 `AREA_ANCHORS`、
`sceneConfig.ts` 的 `SCENE_WAYPOINTS`、`mock/digitalTwin.ts`）。
复制一份坐标到后端，前端一搬厂就两边不一致，**而且没人会发现**（本项目搬过一次选矿厂）。
漂移由 `check-duner.mjs` 读前端源码逐项比对（词表不许与前端漂移那一段）。
解析阶梯：机位预设 → 区域锚点 → 边坡监测点 → 方位取中 → 设备 → **找不到返回 null**，
不退回矿区中心（否则用户会以为「北帮 7 号台阶」真的存在，只是自己看错了）。

### 5.3 右下角按钮的让位（`corner.ts`）

- 为什么不是「每页面配一个偏移表」：那等于把九个页面的布局复制进墩儿，
  页面一改**不会报错**，只会把按钮重新压回某个面板上。
- **必须迭代**：底部是两块并排面板时，让一次只是「看上去躲开了」，压住的其实是隔壁那块。
- **必须有护栏**：让位不能让出画面（`RIGHT_MAX = 画布宽 - 16 - 66`），
  否则设备管理/数据管理两页会一路算到画布外。
- 阈值 `PAGE_WIDE_RATIO = 2/3` 是实测定的：写成 9/10 时安全管理页按钮停在 492、
  **正好压住那块 360 宽的隐患面板**。
- 测量时机：`MutationObserver` 回调是微任务、不吃帧率；`rAF`/`setTimeout` 在软件渲染下会被拖后数秒
  （实测「先走数字孪生再进决策指挥，4 秒后读到的还是上一页的 428」）。

**已知代价（如实记账）**：设备管理、应急救援两页按钮压住**宽面板**一角（< 2/3 画布的元素不算冲突），
数据管理页那块铺满整行的 1888 面板两边判据都不算 —— 这是检查脚本的盲区，README 第十三节第 34 条有账。

---

## 6. 判据：这套东西怎么被验证

`node scripts/check-duner.mjs [baseUrl] [--self-test]` —— **两种模式各跑一次**
（`process.exit` 抢在常规体检之前结束的坑，本项目在别的脚本上踩过；
「自证全绿」从来不等于「真实链路被巡检过」）。

| 段 | 答什么问题 | 怎么答 |
|---|---|---|
| 甲 | 接口层：指导书 §12 的 7 条必过用例 | node `fetch` 直打 8787，不开浏览器 |
| 乙 | 意图与槽位准不准 | 进程内纯函数喂 **295 条测试集**（生成 244 + 手写 51），当场算意图准确率与实体 F1 |
| 丙 | 真实链路：按钮 / 让位 / 相机 / 图层 / 确认卡 | Playwright 真开浏览器 |
| 丁 | 判据自己是不是恒绿的壳 | `--self-test`：注入缺陷 + 反向期望，要求判据**当场翻红**（T1~T7 七条） |

**最近一次实测**（2026-09-18，`dist` 重建后）：

```
常规体检  105 项 / 0 失败 · EXIT=0
自证      120 项 / 0 失败 · 含 T1~T7 反向判据
测试集    295 条：意图准确率 100.0%（244/244 + 51/51）· 实体 F1 100.0%（TP 273 / FP 0 / FN 0）
未确认写操作 0（点确认之前 `/duner/confirm` 请求数必须为 0）
```

**截图脚本自带两条判据**（`make-duner-shots.mjs`）：三维区不能是空地球（照抄
`make-screenshots.mjs` 的 `baseColorShare`，0.25 上限）；截确认卡那一步
**不许发出任何兑换请求、库里不许多出单子** —— 「截图脚本顺手把库改了」是最不该发生的事。

**跑之前**：后端必须在跑（`npm run serve`，8787）。改过 `server/duner/**` 之后
**必须重启后端**（node 缓存模块），否则测的还是老代码。

---

## 7. 已知限制与欠账

- **语音输入没做**（参考的那版有这个入口，本项目刻意不跟；理由见 README 第十三节第 34 条）。
- **`GET /duner/pending` 未注册**：`confirm.mjs` 导出了 `listPending()`，注释里提到这条路由，
  但 `FIXED_ROUTES` 里没有它，当前无调用方 —— 留着是排查用的口子，不是漏注册。
- **前端没有词典编辑界面**：词典的读/改接口都在（`/duner/dict`），`src/api/duner.ts` 未封装，
  UI 也没有 —— 改词目前只能打接口。
- **`degraded` 字段口径不一致**：后端是字符串（`'no_key'` / `'timeout_…'`），
  前端类型声明成了 `degraded?: boolean`（展示按真值用，不影响行为，但读代码时会误导）。
- **按钮压住宽面板一角**：设备管理 / 应急救援两页，见第 5.3 节。
- **README 口径已订正两处**（2026-09-18）：duner 接口是 **8 个**不是 7 个；
  词典删除是 `DELETE /duner/dict?term=…`，不是路径参数 `/:term`。

---

## 8. 从零跑起来

```bash
npm install
npm run serve            # 8787，同时供 dist/ 与 /api；dist 过期会先自动构建
node scripts/check-duner.mjs http://localhost:8787              # 常规体检
node scripts/check-duner.mjs http://localhost:8787 --self-test  # 自证（另一条命令，不是同一个进程）
node scripts/make-duner-shots.mjs http://localhost:8787         # 重出那两张展示图
```

模型是**可选的**：`.env` 里配上 `DUNER_LLM_KEY` 才会启用 DeepSeek
（`DUNER_LLM_MODEL` 默认 `deepseek-v4-flash`，超时 8s）。**没配也能用** ——
核心指令由规则引擎离线完成，这正是「规则优先」要保的那条性质。
`VITE_` 前缀的密钥会被 vite 打进前端产物，所以模型密钥叫 `DUNER_LLM_KEY`。
