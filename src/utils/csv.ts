/**
 * CSV 生成与下载。
 *
 * 原先写在 `ReportsView.vue` 里（报表页的「导出质检记录」）；墩儿的
 * `report.export` 也要落一个 CSV，且导出的数据集不止质检记录，
 * 所以搬到这里共用 —— **不是二选一，是真的同一件事**：
 * 同一份 BOM、同一个转义规则、同一个文件名格式。
 *
 * 复制一份的代价在这里最实在：两处的转义规则只要有一处漏了，
 * 就会出现"从页面导出正常、从对话导出乱码/串列"这种只在一条路径上出现的 bug。
 */

import { formatDay } from './format'

/**
 * 生成并下载一个 CSV。
 *
 * 开头的 BOM 不能省：Excel 打开不带 BOM 的 UTF-8 CSV 会按 GBK 解码，
 * 中文全部变成乱码——这是 Windows 上交付这类文件最常见的翻车点。
 * 行分隔用 CRLF，同样是迁就 Excel。
 */
export function downloadCsv(header: string[], body: string[][], fileStem: string): void {
  const csv = '﻿' + [header, ...body].map(toCsvRow).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${fileStem}_${formatDay(new Date())}.csv`
  link.click()
  // 必须撤销：blob URL 不撤销会一直占着内存直到页面卸载
  URL.revokeObjectURL(url)
}

/** CSV 字段转义：含逗号、引号或换行的字段要用双引号包起来，内部引号翻倍 */
export function toCsvRow(cells: string[]): string {
  return cells
    .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
    .join(',')
}
