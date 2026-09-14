/** 通用格式化工具 */

const pad = (n: number) => String(n).padStart(2, '0')

/** 2025.08.08 16:13 —— 与参考截图顶栏格式一致 */
export function formatDate(d: Date): string {
  return (
    `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/** 2023-07-26 */
export function formatDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 2023-06-26 16:57 */
export function formatMinute(d: Date): string {
  return `${formatDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/** 月份数字 → 中文，如 1 → 一月 */
export function monthLabel(m: number): string {
  return `${m}月`
}

/** 千分位，可选小数位 */
export function thousands(v: number, decimals = 0): string {
  return v.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

/** 转成百分比字符串 */
export function percent(v: number, decimals = 2): string {
  return `${v.toFixed(decimals)}%`
}

/** 数组 [0..n-1] */
export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

export { CN_NUM }
