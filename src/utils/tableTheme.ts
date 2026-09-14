/**
 * Element Plus 表格的深色适配 —— 供 el-table 的 `header-cell-style` /
 * `cell-style` 使用。
 *
 * 表格内部的背景、描边、hover 等样式由全局的 `.data-table` 类负责
 *（见 `styles/global.scss`）；这里只处理**元素级内联样式**那一半——
 * el-table 的表头 / 单元格背景是通过 style 属性下发的，CSS 类盖不住，
 * 只能由 JS 返回对象。
 *
 * 色值不写在这里，而是读 `global.scss` 里定义的 CSS 变量，
 * 保证表格配色与主题变量永远同源。
 */
export interface TableCellStyle {
  background: string
  color: string
  fontSize: string
  borderColor: string
}

/** 表头单元格样式 */
export function tableHeaderStyle(): TableCellStyle {
  return {
    background: 'var(--table-th-bg)',
    color: 'var(--table-th-text)',
    fontSize: 'var(--table-fs)',
    borderColor: 'var(--table-border)'
  }
}

/** 数据单元格样式（背景交给 `.data-table` 的 hover 规则，这里保持透明） */
export function tableCellStyle(): TableCellStyle {
  return {
    background: 'transparent',
    color: 'var(--table-cell-text)',
    fontSize: 'var(--table-fs)',
    borderColor: 'var(--table-border)'
  }
}
