<template>
  <div class="map-scene" :class="{ 'is-plain': plain }">
    <div id="cesium-container" class="map-scene__canvas" />
    <template v-if="!plain">
      <div class="map-scene__vignette" />
      <div class="map-scene__grid" />
    </template>
    <slot />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import * as Cesium from 'cesium'
import { useCesium, type SceneBuilder } from '@/scene/useCesium'
import type { SceneWaypoint } from '@/scene/sceneConfig'
import type { ScenePick } from '@/scene/sceneTargets'

/**
 * Cesium 三维场景容器 —— 各页面的中央主视图。
 *
 * 默认加载程序化矿区示意场景；需要通过 build 传入自定义构建器
 * 来叠加业务图层（安全标注、避灾路线、设备点位等）。
 */
const props = withDefaults(
  defineProps<{
    /** 自定义场景构建器，默认使用程序化矿区场景 */
    build?: SceneBuilder | null
    /** 初始机位，默认俯瞰全矿区 */
    home?: SceneWaypoint
    /** 去掉暗角与网格叠加层（数字孪生页需要干净的写实画面） */
    plain?: boolean
    /**
     * 开启三维拾取：点中地物时 emit `pick`。
     *
     * **默认关**。既有页面（首页 / 安全 / 应急 / 数字孪生）不传它，
     * 行为与加这个功能之前**逐字节一致**；只有需要联动的页面才打开。
     */
    pick?: boolean
  }>(),
  {
    build: undefined,
    home: undefined,
    plain: false,
    pick: false
  }
)

const emit = defineEmits<{
  (e: 'pick', hit: ScenePick): void
}>()

const { viewer, ready, flyTo } = useCesium({ build: props.build, home: props.home })

// ---------------------------------------------------------------------------
// 三维拾取（点地物 → 出信息浮层）
// ---------------------------------------------------------------------------

/**
 * 「点击」与「拖拽旋转」的判定阈值（像素）。
 *
 * ⚠️ **这个守卫不能省。** 大屏上用户会频繁按住左键拖转相机，
 * 没有它的话**每次转完相机都会顺手「点中」一个地物**——鼠标松开的位置
 * 底下多半压着点什么，于是浮层乱弹、相机又被拉回原地，
 * 表现为「一转就跳」，而日志里什么都没有。
 *
 * 4px 是常见的手抖容差：再小会把正常点击判成拖拽，再大则拖拽结束的
 * 甩尾位移会被误判成点击。
 */
const DRAG_THRESHOLD_PX = 4

/** 按下时的屏幕位置，松开时用来判是不是拖拽 */
let downPosition: Cesium.Cartesian2 | null = null

/**
 * 由屏幕坐标反查地物。
 *
 * 三步各管一段，缺一段就会得到「点了没反应还不报错」：
 *   1. `scene.pick`        —— 打**实体与图元**（地物、标签、模型、倾斜摄影瓦片）
 *   2. `camera.getPickRay` + `globe.pick` —— 打**地球表面**，拿到经纬高
 *   3. `scene.pickPosition` —— 前两步都落空时的兜底（贴地几何、深度纹理可读时）
 *
 * ⚠️ 第 1 步拿到的 `picked.id` **不一定是 Entity**：命中实景三维的倾斜摄影
 * 瓦片时它是 `Cesium3DTileFeature`（没有 `id` 属性）、命中程序化场景的
 * 图元时是那个 Primitive 本身。所以这里用 `instanceof Cesium.Entity` 收窄，
 * 认不出的就归到 `tileset: true`，而不是把图元对象硬当成实体往上传
 * ——那样页面会在 `entity.name` 上取到 undefined，然后静默地什么都不显示。
 */
function probeAt(v: Cesium.Viewer, position: Cesium.Cartesian2): ScenePick {
  const scene = v.scene

  const picked = scene.pick(position)
  const entity = picked?.id instanceof Cesium.Entity ? (picked.id as Cesium.Entity) : null

  let carto: Cesium.Cartographic | undefined
  const ray = v.camera.getPickRay(position)
  const cartesian = (ray ? scene.globe.pick(ray, scene) : undefined) ?? scene.pickPosition(position)
  // `Cartographic.fromCartesian` 对零向量返回 undefined，不是抛错
  if (cartesian) carto = Cesium.Cartographic.fromCartesian(cartesian)

  return {
    // `entity.id` 对 Entity 是 string（本库每个实体都显式给了 id）；
    // 给成 number/undefined 的实体会在这里退化成 null，页面按「点了空地」处理
    entityId: typeof entity?.id === 'string' ? entity.id : null,
    entityName: entity?.name ?? null,
    lonLat: carto
      ? {
          lon: Cesium.Math.toDegrees(carto.longitude),
          lat: Cesium.Math.toDegrees(carto.latitude),
          height: carto.height
        }
      : null,
    screen: { x: position.x, y: position.y },
    tileset: picked != null && entity === null
  }
}

/**
 * 把拾取挂到 **viewer 自己的** `screenSpaceEventHandler` 上，
 * 而不是容器的 DOM `@click`。
 *
 * 为什么：`useCesium` 卸载时会销毁 viewer，而 viewer 会连带销毁它自己的
 * 事件处理器，监听器跟着一起走。挂在 DOM 上则相反——路由一切走，
 * 容器没了，监听器还持有一个已销毁的 viewer（`useCesium.ts:67-75`
 * 那段注释防的正是这一类漏，那边漏的是 viewer 本身，这边漏的是它的引用）。
 */
function attachPick(v: Cesium.Viewer) {
  const handler = v.screenSpaceEventHandler

  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    downPosition = Cesium.Cartesian2.clone(e.position)
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const from = downPosition
    downPosition = null

    // 拖拽守卫：按下与松开隔得远 ⇒ 这是一次相机旋转，不是点击
    if (from && Cesium.Cartesian2.distance(from, e.position) > DRAG_THRESHOLD_PX) return

    emit('pick', probeAt(v, e.position))
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

  // 诊断入口，给检查脚本做**确定性拾取**用：
  // 脚本先用 SceneTransforms.worldToWindowCoordinates 把目标实体换算成屏幕点，
  // 再调这里断言命中的就是它。比「在画布上随便点、碰运气」可靠得多。
  Object.assign(window as never, {
    __mapScene: {
      probeAt: (x: number, y: number) => probeAt(v, new Cesium.Cartesian2(x, y))
    }
  })
}

// viewer 是在 useCesium 那条异步链的末尾才赋值的（建场景要好几秒），
// 所以不能在 onMounted 里直接挂，必须等 ready 翻真。
watch(
  ready,
  (isReady) => {
    if (isReady && props.pick && viewer.value) attachPick(viewer.value)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  downPosition = null

  // 清掉诊断入口 —— 留着会指向一个已销毁的 viewer，
  // 检查脚本读到的会是「有 probeAt、但 pick 全返回 null」这种极具迷惑性的状态。
  // 与 useCesium 里清 `__cesiumViewer` 同一套理由。
  const w = window as never as { __mapScene?: unknown }
  delete w.__mapScene
})

// 供父组件驱动相机飞行
defineExpose({ viewer, ready, flyTo, probeAt })
</script>

<style lang="scss" scoped>
.map-scene {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: $bg-deep;
}

.map-scene__canvas {
  width: 100%;
  height: 100%;

  // Cesium 默认的版权信息条在大屏上不需要
  :deep(.cesium-viewer-bottom) {
    display: none;
  }
}

// 四周暗角，让中间场景更聚焦
.map-scene__vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(4, 11, 26, 0.75) 100%);
}

// 科技感网格叠层
.map-scene__grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.18;
  background-image:
    linear-gradient(rgba(0, 229, 255, 0.35) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 229, 255, 0.35) 1px, transparent 1px);
  background-size: 80px 80px;
  mask-image: radial-gradient(ellipse at 50% 50%, transparent 40%, #000 100%);
  -webkit-mask-image: radial-gradient(ellipse at 50% 50%, transparent 40%, #000 100%);
}
</style>
