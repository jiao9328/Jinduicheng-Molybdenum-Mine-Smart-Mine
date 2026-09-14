<template>
  <div class="picker">
    <div id="cesium-container" class="picker__map" @click="onPick" />

    <div class="picker__hud">
      <div class="picker__head">
        <h2>坐标拾取</h2>
        <p>把三维模型对齐到卫星底图的真实地物上</p>
      </div>

      <ol class="picker__steps">
        <li><b>先点谷的上游端</b>（粗碎站／卸矿平台的位置）</li>
        <li><b>再点下游端</b>（精矿库／装车站的位置）—— 两点定出厂区走向</li>
        <li>把右下角的配置整段发我，我按它定厂址与 <code>PLANT_AXIS_DEG</code></li>
      </ol>

      <div class="picker__list">
        <div v-for="(p, i) in points" :key="i" class="picker__item">
          <span class="picker__idx">{{ i + 1 }}</span>
          <span class="picker__coord">{{ p.lon.toFixed(6) }}, {{ p.lat.toFixed(6) }}</span>
          <button type="button" @click="points.splice(i, 1)">×</button>
        </div>
        <p v-if="!points.length" class="picker__empty">尚未拾取任何点</p>
      </div>

      <pre class="picker__out">{{ output }}</pre>

      <div class="picker__actions">
        <button type="button" @click="copy">复制配置</button>
        <button type="button" @click="points = []">清空</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 坐标拾取工具页（#/coord-picker）。
 *
 * 用途：卫星底图上的真实地物位置需要人工判读，这个页面把点击位置换算成
 * 经纬度并输出成配置片段，避免靠猜坐标把三维模型摆到错误的地方。
 * 属于开发工具，不参与正式导航。
 */
import { computed, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import { createViewer } from '@/scene/createViewer'
import { HOME_WAYPOINT, waypointToFlyTo } from '@/scene/sceneConfig'

interface PickedPoint {
  lon: number
  lat: number
}

const points = ref<PickedPoint[]>([])
let viewer: Cesium.Viewer | null = null

onMounted(async () => {
  await new Promise((r) => requestAnimationFrame(r))
  const el = document.getElementById('cesium-container')
  if (!el) return

  viewer = createViewer(el, { imageryManifest: await loadManifest() })

  const { destination, orientation } = waypointToFlyTo({
    ...HOME_WAYPOINT,
    pitch: -75,
    range: 3000
  })
  viewer.camera.setView({ destination, orientation })
})

async function loadManifest() {
  try {
    const res = await fetch('map-tiles/imagery/manifest.json')
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** 屏幕点击 → 经纬度 */
function onPick(event: MouseEvent) {
  if (!viewer) return

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top

  const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(x, y))
  if (!ray) return

  // 优先打地球表面，落到实体上时取其位置
  const cartesian =
    viewer.scene.globe.pick(ray, viewer.scene) ??
    viewer.scene.pickPosition(new Cesium.Cartesian2(x, y))
  if (!cartesian) return

  const carto = Cesium.Cartographic.fromCartesian(cartesian)
  points.value.push({
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude)
  })
}

/**
 * 输出成可直接粘贴的数组片段。
 *
 * 前两点另外算一次**走向**：厂区的长轴必须顺着山谷，而「走向」是一个
 * 从两个点才能推出来的量。让使用者在谷的上游端、下游端各点一下，
 * 一次就同时得到厂址（第 1 点）与方位角，不必再回头量一遍。
 */
const output = computed(() => {
  if (!points.value.length) return '// 点击底图开始拾取'

  const lines = points.value.map(
    (p, i) => `  { name: '地物${i + 1}', lon: ${p.lon.toFixed(6)}, lat: ${p.lat.toFixed(6)} }`
  )

  // 走向注释放在数组**外面**：塞进数组里会被当成元素去接逗号，
  // 出来是一串「注释后面跟个逗号」的怪东西，复制出去也不像能用的代码
  let head = ''
  if (points.value.length >= 2) {
    // 用局部平面近似算方位角与间距（厂区尺度上足够准）
    const [a, b] = points.value
    const mx = 111320 * Math.cos((a.lat * Math.PI) / 180)
    const east = (b.lon - a.lon) * mx
    const north = (b.lat - a.lat) * 110540
    // atan2 给的是 -180~180，手工归一，免得出现负角度
    const deg = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360
    const dist = Math.hypot(east, north)
    head =
      `// 第1点 → 第2点 方位角 ${deg.toFixed(1)}°（0=正北，顺时针），间距 ${dist.toFixed(0)}m\n` +
      `// 第2点 → 第1点 方位角 ${((deg + 180) % 360).toFixed(1)}°  ← 这就是 PLANT_AXIS_DEG\n`
  }

  return `${head}[\n${lines.join(',\n')}\n]`
})

async function copy() {
  try {
    await navigator.clipboard.writeText(output.value)
    console.info('[picker] 配置已复制到剪贴板')
  } catch {
    console.warn('[picker] 剪贴板不可用，请手动复制')
  }
}
</script>

<style lang="scss" scoped>
.picker {
  position: relative;
  width: 100%;
  height: 100%;
}

.picker__map {
  width: 100%;
  height: 100%;
  cursor: crosshair;
}

.picker__hud {
  position: absolute;
  right: 16px;
  top: 16px;
  width: 380px;
  max-height: calc(100% - 32px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  background: $bg-panel;
  border: 1px solid $border-panel;
  backdrop-filter: blur(8px);
  overflow-y: auto;
  @include thin-scrollbar;
}

.picker__head h2 {
  font-size: 16px;
  color: $text-primary;
}

.picker__head p {
  margin-top: 2px;
  font-size: $fs-small;
  color: $text-secondary;
}

.picker__steps {
  list-style: decimal;
  padding-left: 18px;
  font-size: $fs-small;
  color: $text-secondary;
  line-height: 1.8;

  code {
    font-family: $font-number;
    color: $primary;
  }
}

.picker__list {
  border: 1px solid $border-soft;
  max-height: 160px;
  overflow-y: auto;
  @include thin-scrollbar;
}

.picker__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  font-size: $fs-small;

  & + & {
    border-top: 1px solid $border-soft;
  }

  button {
    margin-left: auto;
    padding: 0 6px;
    color: $red;
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 14px;
  }
}

.picker__idx {
  width: 16px;
  color: $text-muted;
}

.picker__coord {
  font-family: $font-number;
  color: $text-body;
}

.picker__empty {
  padding: 10px;
  text-align: center;
  font-size: $fs-small;
  color: $text-muted;
}

.picker__out {
  margin: 0;
  padding: 8px;
  max-height: 180px;
  overflow: auto;
  font-family: $font-number;
  font-size: 11px;
  line-height: 1.6;
  color: $green;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid $border-soft;
  @include thin-scrollbar;
}

.picker__actions {
  display: flex;
  gap: 8px;

  button {
    flex: 1;
    height: 28px;
    font-family: $font-title;
    font-size: $fs-small;
    color: $primary;
    background: rgba(0, 229, 255, 0.1);
    border: 1px solid $border-panel;
    border-radius: $radius-sm;
    cursor: pointer;

    &:hover {
      background: rgba(0, 229, 255, 0.22);
    }
  }
}
</style>
