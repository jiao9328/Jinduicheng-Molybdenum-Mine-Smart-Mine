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
import { useCesium, type SceneBuilder } from '@/scene/useCesium'
import type { SceneWaypoint } from '@/scene/sceneConfig'

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
  }>(),
  {
    build: undefined,
    home: undefined,
    plain: false
  }
)

const { viewer, ready, flyTo } = useCesium({ build: props.build, home: props.home })

// 供父组件（数字孪生页底部 Tab）驱动相机飞行
defineExpose({ viewer, ready, flyTo })
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
