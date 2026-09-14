import { onBeforeUnmount, ref, shallowRef, type Ref } from 'vue'

/**
 * 异步数据加载。
 *
 * 页面里的数据来源会在「mock」与「接口」之间切换，这里统一处理加载态、
 * 错误态与组件卸载后的回调安全问题，避免每个页面各写一套 try/catch。
 *
 * @param loader 数据加载函数。返回值会被浅引用（大屏数据量可能较大）
 * @param initial 初始值，加载完成前先用它渲染，避免页面闪空
 * @param options.immediate 是否立即加载，默认 true
 */
export function useAsyncData<T>(
  loader: () => Promise<T>,
  initial: T,
  options: { immediate?: boolean } = {}
) {
  const { immediate = true } = options

  const data = shallowRef<T>(initial)
  const loading = ref(false)
  const error = ref<Error | null>(null)

  /** 组件已卸载后不再写状态，避免 Vue 的更新警告 */
  let mounted = true
  /** 请求序号，晚发出的请求永远覆盖早发出的，防止竞态 */
  let seq = 0

  async function load() {
    const current = ++seq
    loading.value = true
    error.value = null

    try {
      const result = await loader()
      if (mounted && current === seq) data.value = result
    } catch (err) {
      if (mounted && current === seq) {
        error.value = err instanceof Error ? err : new Error(String(err))
        console.error('[api] 数据加载失败：', error.value)
      }
    } finally {
      if (mounted && current === seq) loading.value = false
    }
  }

  if (immediate) void load()

  onBeforeUnmount(() => {
    mounted = false
  })

  return {
    data: data as Ref<T>,
    loading,
    error,
    /** 手动重新加载 */
    refresh: load
  }
}

/**
 * 定时刷新。
 *
 * 大屏需要周期拉取最新数据，但组件卸载或页面切到后台时要停下来——
 * 否则一个挂着的大屏会一直在后台发请求。
 *
 * @param intervalMs 刷新间隔
 * @param refresh    刷新函数
 * @param options.runInBackground 页面隐藏时是否继续刷新，默认 false
 */
export function useAutoRefresh(
  intervalMs: number,
  refresh: () => void,
  options: { runInBackground?: boolean } = {}
) {
  const { runInBackground = false } = options
  let timer: number | undefined

  function start() {
    stop()
    timer = window.setInterval(() => {
      // 页面不可见时跳过，等切回前台由 visibilitychange 触发一次立即刷新
      if (document.hidden && !runInBackground) return
      refresh()
    }, intervalMs)
  }

  function stop() {
    if (timer) {
      window.clearInterval(timer)
      timer = undefined
    }
  }

  const onVisibility = () => {
    if (!document.hidden) refresh()
  }

  start()
  document.addEventListener('visibilitychange', onVisibility)

  onBeforeUnmount(() => {
    stop()
    document.removeEventListener('visibilitychange', onVisibility)
  })

  return { start, stop }
}
