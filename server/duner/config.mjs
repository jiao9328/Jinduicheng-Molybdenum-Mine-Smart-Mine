/**
 * 墩儿的配置读取。
 *
 * ## 为什么这里要自己加载 `.env`
 *
 * 本项目原先**没有任何进程加载 `.env`** —— `vite` 会把 `VITE_*` 内联进前端包，
 * 后端（`scripts/serve.mjs` 直接 import `server/index.mjs`）从来不读它。
 * 所以「后端配一个模型密钥」这件事在本仓库里是**新开的一条路**，得显式把文件读进来。
 *
 * 用 Node 24 内置的 `process.loadEnvFile()`，不引 dotenv —— 与仓库
 * 「能自己写就不加依赖」的取舍一致（同 `node:sqlite`、手写 `node:http`）。
 *
 * ## 密钥为什么必须是 `DUNER_LLM_KEY` 而不是 `VITE_DUNER_LLM_KEY`
 *
 * `VITE_` 前缀的变量会被 vite **打进前端产物**，任何访客打开 devtools 都能读到。
 * 指导书 4 节的原话是「严禁把 LLM 调用或权限判断放到前端」——
 * 密钥跟着一起放前端等于把这句话当没说。命名上把前缀去掉，
 * 就是让「它不进包」这件事在变量名上就能看出来。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** 显式加载 `.env`。文件不存在是正常情况（clone 下来就没有），不当错误 */
export function loadEnv(file = join(ROOT, '.env')) {
  if (!existsSync(file)) return false
  try {
    process.loadEnvFile(file)
    return true
  } catch {
    // 语法坏掉不该让整个后端起不来：没有模型密钥时墩儿照旧能用规则引擎跑
    return false
  }
}

/**
 * 在**模块加载时**就把 `.env` 读进来。
 *
 * ⚠️ 这句不能省、也不能挪到某个 init 函数里。下面那两个模块级常量
 * （`CONFIRM_TTL_MS` / `CONFIDENCE_THRESHOLD`）在 import 的那一刻就求值了，
 * 晚一步加载 `.env` 它们就永远拿不到配置里的值 —— 而表现是"配置写了但不生效"，
 * 没有任何报错。`loadEnv()` 本身对缺文件与坏语法都是静默的，所以放在这里安全。
 */
loadEnv()

const num = (raw, fallback) => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 模型侧配置。
 *
 * `available` 只看**有没有密钥**，不去探接口 —— 每次启动都发一个探测请求会
 * 让「后端起来了没」这件事多一个外部依赖。真的连不上时由 `llm.mjs`
 * 在调用处超时回落，那时才判定不可用。
 */
export function llmConfig() {
  const key = (process.env.DUNER_LLM_KEY ?? '').trim()
  const enabled = (process.env.DUNER_LLM_ENABLED ?? '').trim().toLowerCase() !== 'false'

  return {
    available: Boolean(key) && enabled,
    key,
    model: (process.env.DUNER_LLM_MODEL ?? '').trim() || 'deepseek-v4-flash',
    baseUrl: ((process.env.DUNER_LLM_BASE_URL ?? '').trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
    /**
     * 超时必须**明显小于**前端 `http.ts` 的 15s。
     * 反过来（后端比前端慢）会让前端先超时 —— 用户看到的是「请求失败」，
     * 而后端其实还在跑、还会把审计写进去，两边账对不上。
     */
    timeoutMs: num(process.env.DUNER_LLM_TIMEOUT_MS, 8000)
  }
}

/** 写操作的确认令牌有效期，指导书 4.4 定的是 60s */
export const CONFIRM_TTL_MS = num(process.env.DUNER_CONFIRM_TTL_MS, 60_000)

/** 规则引擎的置信度门槛。低于它才去问模型（或反问用户） */
export const CONFIDENCE_THRESHOLD = Number(process.env.DUNER_CONFIDENCE ?? 0.8) || 0.8
