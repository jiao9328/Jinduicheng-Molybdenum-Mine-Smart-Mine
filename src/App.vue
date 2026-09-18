<template>
  <!--
    正式页面统一套在 1920×1080 缩放容器里，保证大屏布局一致。
    开发工具类页面（坐标拾取等）需要填满真实窗口，跳过缩放容器。
  -->
  <ScaleScreen v-if="!isFullscreen">
    <router-view v-slot="{ Component }">
      <component :is="Component" />
    </router-view>
    <!--
      墩儿的悬浮按钮（右下角）+ 对话框挂在**缩放容器里面**：
      它要跟页面一起按 1920×1080 等比缩放，挂在外面会在大屏上小一圈，
      而且它得跟页面里的面板量同一个坐标系才能"躲开右栏"（见 `duner/corner.ts`）。
      `v-if="!isFullscreen"` 顺带把它挡在登录页与坐标拾取页之外 ——
      那两页没有三维场景，也没有登录态，出现在那里只会是个摆设。
    -->
    <DunerDock />
  </ScaleScreen>

  <router-view v-else v-slot="{ Component }">
    <component :is="Component" />
  </router-view>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ScaleScreen from '@/components/ScaleScreen.vue'
import DunerDock from '@/components/DunerDock.vue'

const route = useRoute()

/** 路由 meta.fullscreen 为真时不做等比缩放 */
const isFullscreen = computed(() => route.meta?.fullscreen === true)
</script>
