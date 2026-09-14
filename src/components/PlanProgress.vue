<template>
  <div class="plan">
    <div v-for="p in plans" :key="p.label" class="plan__item">
      <div class="plan__head">
        <span class="plan__label">{{ p.label }}</span>
        <span class="plan__value">
          <NumberFlip :value="p.current" :duration="1400" />
          <em class="plan__total">/{{ p.total }}</em>
          <em class="plan__unit">{{ p.unit }}</em>
        </span>
      </div>
      <div class="plan__track">
        <div class="plan__bar" :style="{ width: `${percent(p)}%`, background: barColor(p) }" />
      </div>
      <span class="plan__percent">{{ percent(p) }}%</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import NumberFlip from './NumberFlip.vue'
import type { PlanProgress } from '@/config/nav'

/**
 * 生产计划进度卡组 —— 首页顶部悬浮。
 * 完成率越低颜色越警示：<50% 红、<80% 橙、其余青色。
 */
withDefaults(defineProps<{ plans: PlanProgress[] }>(), {})

function percent(p: PlanProgress) {
  if (!p.total) return 0
  return Math.round((p.current / p.total) * 100)
}

function barColor(p: PlanProgress) {
  const v = percent(p)
  if (v < 50) return 'linear-gradient(90deg, #ff4d4f, #ff9f1c)'
  if (v < 80) return 'linear-gradient(90deg, #ff9f1c, #ffd60a)'
  return 'linear-gradient(90deg, #00e5ff, #00ff9d)'
}
</script>

<style lang="scss" scoped>
.plan {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 18px;
  padding: 10px 18px;
  background: rgba(4, 20, 38, 0.72);
  border: 1px solid $border-panel;
  border-radius: $radius-md;
  backdrop-filter: blur(8px);
}

.plan__item {
  position: relative;
  min-width: 0;
}

.plan__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.plan__label {
  font-size: $fs-small;
  color: $text-secondary;
  @include ellipsis;
}

.plan__value {
  display: flex;
  align-items: baseline;
  gap: 1px;
  font-family: $font-number;
  font-size: 15px;
  font-weight: 700;
  color: $text-primary;
  white-space: nowrap;
}

.plan__total {
  font-style: normal;
  font-size: $fs-small;
  color: $text-muted;
}

.plan__unit {
  margin-left: 2px;
  font-style: normal;
  font-size: $fs-small - 2px;
  color: $text-muted;
}

.plan__track {
  height: 5px;
  background: rgba(26, 58, 92, 0.85);
  border-radius: 3px;
  overflow: hidden;
}

.plan__bar {
  height: 100%;
  border-radius: 3px;
  transition: width 0.8s ease-out;
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.5);
}

.plan__percent {
  position: absolute;
  right: 0;
  bottom: -14px;
  font-family: $font-number;
  font-size: $fs-small - 2px;
  color: $text-muted;
}
</style>
