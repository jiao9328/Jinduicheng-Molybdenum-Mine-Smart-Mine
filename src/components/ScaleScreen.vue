<template>
  <div class="scale-screen__viewport">
    <div
      class="scale-screen__canvas"
      :style="{
        width: `${DESIGN_WIDTH}px`,
        height: `${DESIGN_HEIGHT}px`,
        transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
      }"
    >
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { DESIGN_HEIGHT, DESIGN_WIDTH, useScale } from '@/hooks/useScale'

const { scale, offsetX, offsetY } = useScale()
</script>

<style lang="scss" scoped>
.scale-screen__viewport {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: radial-gradient(ellipse at 50% 40%, #0a1628 0%, $bg-deep 70%);
}

.scale-screen__canvas {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: left top;
  will-change: transform;
}
</style>
