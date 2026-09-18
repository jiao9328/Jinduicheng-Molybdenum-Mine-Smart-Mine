/**
 * 实体高亮 —— 全站共用一份。
 *
 * ## 为什么从三个视图里提出来
 *
 * 原先 `MonitorView` / `ReportsView` / `CostView` 各有一份**逐字节相同**的
 * `setEntityHighlight`（连注释都一字不差），各自持有一个模块级
 * `highlightBackup` 记着「这个点原来是多大」。三份互不相干时没事。
 *
 * 墩儿来了就不行了：它由命令栏触发高亮，**不属于任何一个视图**。
 * 它要是自己再记一份备份，就会出现这种情形 ——
 * 视图记得「原来是 10px」，墩儿记得「原来是 22px」（因为墩儿读到的
 * 是视图已经改过的值），两边先后还原，谁后谁说了算。
 * 后还原的那个会把 22px 永久留在实体上，**高亮再也退不掉**，
 * 而且只在「先点图表、再说话」这个顺序下才出现。
 *
 * 所以把备份收成一份：**谁高亮都得先还原上一处**，天然不可能有两个备份。
 * 这不是新增能力，是消掉一处已经存在的重复（同 §13 第 31 条「四页拆重复」）。
 *
 * ## 两个判活细节（沿用原实现，改动它们要想清楚）
 *
 * - 判活用 `viewer.isDestroyed()`，**不写 `entity.isDestroyed()`**：
 *   Cesium 的 `Entity` 类型上根本没有这个成员（编译不过）；而且「这个句柄
 *   还能不能用」本来就该问 viewer。
 * - 还原时用 `viewer.entities.contains(entity)` 而不是「不是 null 就算在」：
 *   图层可能已被重建，手里这个句柄指向的对象早就不在集合里了，
 *   此时写它的属性是**静默无效**的。
 */

import * as Cesium from 'cesium'

/** 高亮尺寸。设备点 10px、边坡点 11px，统一放到 22px 才看得出来 */
const HIGHLIGHT_PIXEL_SIZE = 22

/** 上一处高亮：实体 + 它原来的尺寸 */
let backup: { entity: Cesium.Entity; size: number } | null = null

/**
 * 高亮某个实体；传空串或找不到实体就是**只还原**。
 *
 * @param viewer 目标场景。为 null / 已销毁时整个动作是空操作 ——
 *               建场景要好几秒，这期间用户完全可能已经说了话
 * @param id 实体 id（如 `twin-device-DR-01`）。**不是**业务编号
 */
export function highlightAt(viewer: Cesium.Viewer | null | undefined, id: string): void {
  if (!viewer || viewer.isDestroyed()) return

  // 先还原上一处
  if (backup) {
    const { entity, size } = backup
    if (viewer.entities.contains(entity) && entity.point) {
      entity.point.pixelSize = new Cesium.ConstantProperty(size)
    }
    backup = null
  }

  if (!id) return
  const entity = viewer.entities.getById(id)
  if (!entity?.point) return

  const current = entity.point.pixelSize?.getValue(viewer.clock.currentTime)
  if (typeof current !== 'number') return

  backup = { entity, size: current }
  entity.point.pixelSize = new Cesium.ConstantProperty(HIGHLIGHT_PIXEL_SIZE)
}
