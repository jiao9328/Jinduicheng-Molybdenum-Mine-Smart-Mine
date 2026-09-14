<template>
  <!--
    正式页面统一套在 1920×1080 缩放容器里，保证大屏布局一致。
    开发工具类页面（坐标拾取等）需要填满真实窗口，跳过缩放容器。
  -->
  <ScaleScreen v-if="!isFullscreen">
    <router-view v-slot="{ Component }">
      <component :is="Component" />
    </router-view>
  </ScaleScreen>

  <router-view v-else v-slot="{ Component }">
    <component :is="Component" />
  </router-view>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ScaleScreen from '@/components/ScaleScreen.vue'

const route = useRoute()

/** 路由 meta.fullscreen 为真时不做等比缩放 */
const isFullscreen = computed(() => route.meta?.fullscreen === true)
</script>
