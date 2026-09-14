import { onBeforeUnmount } from 'vue'

/**
 * 实时订阅。
 *
 * 与 `useAsyncData` 配合使用：先用接口拿一份全量数据，再用实时推送做增量更新。
 * 典型写法（见 `views/EquipmentView.vue`）：
 *
 * ```ts
 * const { data: alerts } = useAsyncData(api.fetchDeviceAlerts, [] as DeviceAlert[])
 *
 * useRealtime<DeviceAlert>(
 *   (handler) => realtime.subscribe(TOPICS.deviceStatus, handler),
 *   (alert) => { alerts.value = [alert, ...alerts.value] }
 * )
 * ```
 *
 * 单独成文件而不是塞在 `useAsyncData.ts` 里：那个文件管的是「拉数据」，
 * 这个是「推数据」，混在一起时按名字找不到订阅逻辑在哪。
 *
 * @param subscribe 订阅函数，返回取消订阅的回调
 * @param handler   收到推送时的处理逻辑
 */
export function useRealtime<T>(
  subscribe: (handler: (payload: T) => void) => () => void,
  handler: (payload: T) => void
): void {
  // 原来这里绕了一圈 watch(() => true, cb, { immediate: true })。
  // 那是「立刻执行一次」的等价写法，但会平白多建一个永不再次触发的侦听器，
  // 读代码的人还得先想明白它的触发条件才敢改——这里不需要那层间接。
  const unsubscribe = subscribe(handler)

  onBeforeUnmount(unsubscribe)
}
