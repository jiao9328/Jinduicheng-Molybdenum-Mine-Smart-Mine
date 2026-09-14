import { onBeforeUnmount, onMounted, ref } from 'vue'

/** 设计稿尺寸 —— 所有页面按此尺寸布局，运行时等比缩放 */
export const DESIGN_WIDTH = 1920
export const DESIGN_HEIGHT = 1080

/**
 * 大屏等比自适应缩放
 *
 * 以 1920×1080 设计稿为基准，按屏幕宽高比等比缩放并居中。
 * 屏幕比例与设计稿不一致时会在两侧（或上下）留出背景色边。
 *
 * @param designWidth  设计稿宽
 * @param designHeight 设计稿高
 */
export function useScale(designWidth = DESIGN_WIDTH, designHeight = DESIGN_HEIGHT) {
  const scale = ref(1)
  const offsetX = ref(0)
  const offsetY = ref(0)

  let frame = 0

  function calc() {
    const w = window.innerWidth
    const h = window.innerHeight
    // 等比缩放，取较小比例，保证内容完整可见
    const s = Math.min(w / designWidth, h / designHeight)

    scale.value = s
    offsetX.value = (w - designWidth * s) / 2
    offsetY.value = (h - designHeight * s) / 2
  }

  /** 用 rAF 合并 resize 抖动 */
  function onResize() {
    if (frame) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(calc)
  }

  onMounted(() => {
    calc()
    window.addEventListener('resize', onResize)
  })

  onBeforeUnmount(() => {
    if (frame) cancelAnimationFrame(frame)
    window.removeEventListener('resize', onResize)
  })

  return { scale, offsetX, offsetY }
}
