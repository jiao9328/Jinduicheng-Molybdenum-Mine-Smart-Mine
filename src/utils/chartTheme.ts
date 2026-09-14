/**
 * ECharts 深色主题 —— 与 SCSS 主题变量保持一致
 * 坐标轴 #1a3a5c、文字 #c8d8ea、背景透明，见开发指导文档第 11 节。
 */

import type { LinearGradientObject } from 'echarts'

/** 分类色板（饼图 / 环形图 / 分组柱状图按序取色） */
export const CHART_COLORS = [
  '#00e5ff', // 青
  '#1890ff', // 蓝
  '#00ff9d', // 绿
  '#ffd60a', // 黄
  '#ff9f1c', // 橙
  '#ff4d4f', // 红
  '#b388ff', // 紫
  '#ff7ab6' // 粉
]

/**
 * 图表内的辅助色 —— 与 `styles/variables.scss` 的同名变量一一对应。
 *
 * 页面给坐标轴名、刻度、图例单独指定颜色时从这里取，不要在页面里写字面量：
 * 这几组值原本散落在各页面的 option 里各写一份，改主题时总会漏掉几处。
 */
export const AXIS_LINE_COLOR = '#1a3a5c' // = $border-grid
export const TEXT_BODY_COLOR = '#c8d8ea' // = $text-body
export const TEXT_MUTED_COLOR = '#5c7a99' // = $text-muted

/** 坐标轴名称（如「吨」「万元」）的文字样式 */
export const AXIS_NAME_STYLE = { color: TEXT_MUTED_COLOR, fontSize: 10 }

const AXIS_LINE = AXIS_LINE_COLOR
const TEXT_BODY = TEXT_BODY_COLOR
const TEXT_MUTED = TEXT_MUTED_COLOR

/** 基础配置：所有图表都会合并这一层 */
export const baseChartOption = {
  backgroundColor: 'transparent',
  color: CHART_COLORS,
  textStyle: {
    color: TEXT_BODY,
    fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif'
  },
  grid: {
    top: 36,
    right: 16,
    bottom: 8,
    left: 8,
    containLabel: true
  },
  tooltip: {
    backgroundColor: 'rgba(6, 28, 51, 0.92)',
    borderColor: 'rgba(0, 229, 255, 0.35)',
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: TEXT_BODY, fontSize: 12 },
    axisPointer: {
      lineStyle: { color: 'rgba(0, 229, 255, 0.4)' },
      crossStyle: { color: 'rgba(0, 229, 255, 0.4)' }
    }
  },
  legend: {
    textStyle: { color: TEXT_MUTED, fontSize: 11 },
    itemWidth: 8,
    itemHeight: 8,
    icon: 'circle'
  },
  categoryAxis: {
    axisLine: { lineStyle: { color: AXIS_LINE } },
    axisTick: { show: false },
    axisLabel: { color: TEXT_MUTED, fontSize: 11 },
    splitLine: { show: false }
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: TEXT_MUTED, fontSize: 11 },
    splitLine: {
      lineStyle: { color: AXIS_LINE, type: 'dashed' }
    }
  }
}

/**
 * 合并主题到图表配置。
 *
 * 坐标轴处理：把 baseChartOption 里的 categoryAxis / valueAxis 当作
 * ECharts 的默认轴样式下发给 xAxis / yAxis。
 * 图表若显式提供了对象形式的轴配置，则与其合并；
 * 若提供了数组（多轴，如双 Y 轴），则保持原样不动。
 */
export function withTheme<T extends Record<string, any>>(option: T): T {
  const { categoryAxis, valueAxis, ...base } = baseChartOption as Record<string, any>

  const merged: Record<string, any> = {
    ...base,
    ...option,
    grid: { ...base.grid, ...(option.grid ?? {}) },
    tooltip: { ...base.tooltip, ...(option.tooltip ?? {}) },
    legend: { ...base.legend, ...(option.legend ?? {}) }
  }

  if (option.xAxis === undefined) {
    merged.xAxis = categoryAxis
  } else if (!Array.isArray(option.xAxis)) {
    merged.xAxis = { ...categoryAxis, ...option.xAxis }
  }

  if (option.yAxis === undefined) {
    merged.yAxis = valueAxis
  } else if (!Array.isArray(option.yAxis)) {
    merged.yAxis = { ...valueAxis, ...option.yAxis }
  }

  return merged as T
}

/**
 * 常用渐变色生成器 —— 面积图 / 柱状图渐变填充。
 *
 * 返回类型必须显式写成 LinearGradientObject：不写的话 `type` 会被推断成
 * string，而 ECharts 要求字面量 'linear'，凡是把返回值塞进 itemStyle.color
 * 的地方（几乎每个页面）都会报 TS2769。
 */
export function areaGradient(
  from: string,
  to = 'rgba(0, 229, 255, 0)'
): LinearGradientObject {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: from },
      { offset: 1, color: to }
    ]
  }
}

/** 纵向渐变柱 —— 从亮到暗 */
export function barGradient(from: string, to: string): LinearGradientObject {
  return areaGradient(from, to)
}

/**
 * 取调色板里的 hex 色值转成半透明 —— 用于渐变柱的下沿收边。
 *
 * 柱状图的渐变末端不能直接写 `rgba(0, 229, 255, 0.18)`：
 * 颜色一旦在 CHART_COLORS 里调整，这里就悄悄和柱顶色对不上了。
 *
 * @param hex   形如 `#00e5ff` 的色值
 * @param alpha 0~1
 */
export function fadeColor(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`
}
