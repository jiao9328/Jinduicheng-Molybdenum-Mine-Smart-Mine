<template>
  <div class="metric-card">
    <div class="metric-card__icon" :style="{ color: color }">
      <slot name="icon">
        <span class="metric-card__dot" />
      </slot>
    </div>

    <div class="metric-card__main">
      <div class="metric-card__label">{{ label }}</div>
      <div class="metric-card__value">
        <NumberFlip :value="value" :decimals="decimals" :duration="duration" />
        <span v-if="unit" class="metric-card__unit">{{ unit }}</span>
      </div>
    </div>

    <div v-if="showTrend" class="metric-card__trend">
      <div class="metric-card__trend-row">
        <span class="metric-card__trend-key">环比</span>
        <span class="metric-card__trend-val" :class="trendClass(chain)">
          {{ formatTrend(chain) }}
        </span>
      </div>
      <div class="metric-card__trend-row">
        <span class="metric-card__trend-key">同比</span>
        <span class="metric-card__trend-val" :class="trendClass(yoy)">
          {{ formatTrend(yoy) }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import NumberFlip from './NumberFlip.vue'

const props = withDefaults(
  defineProps<{
    /** 指标名称 */
    label: string
    /** 指标值 */
    value: number
    /** 单位 */
    unit?: string
    /** 小数位 */
    decimals?: number
    /** 主题色（图标 + 数字） */
    color?: string
    /** 环比，单位 %，可正可负 */
    chain?: number
    /** 同比，单位 % */
    yoy?: number
    /** 是否显示环比/同比 */
    showTrend?: boolean
    /** 数字滚动时长 ms */
    duration?: number
  }>(),
  {
    unit: '',
    decimals: 0,
    color: '#00e5ff',
    chain: 0,
    yoy: 0,
    showTrend: true,
    duration: 1200
  }
)

/** 涨绿跌红（大屏习惯：增长为好） */
function trendClass(v: number) {
  if (v > 0) return 'is-up'
  if (v < 0) return 'is-down'
  return 'is-flat'
}

function formatTrend(v: number) {
  const sign = v > 0 ? '+' : ''
  return `${sign}${v}%`
}
</script>

<style lang="scss" scoped>
.metric-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: linear-gradient(135deg, rgba(0, 229, 255, 0.1) 0%, rgba(6, 28, 51, 0.7) 45%);
  border: 1px solid $border-soft;
  border-left: 2px solid currentColor;
  @include corner-brackets(8px, 1px, rgba($primary, 0.5));
  color: $primary;
}

.metric-card__icon {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.metric-card__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}

.metric-card__main {
  flex: 1;
  min-width: 0;
}

.metric-card__label {
  font-size: $fs-small;
  color: $text-secondary;
  @include ellipsis;
}

.metric-card__value {
  display: flex;
  align-items: baseline;
  gap: 3px;
  margin-top: 2px;
  font-family: $font-number;
  font-size: $fs-metric;
  font-weight: 700;
  line-height: 1.1;
  color: $text-primary;
  @include glow-text($primary, 10px);
}

.metric-card__unit {
  font-size: $fs-small;
  font-weight: 400;
  color: $text-secondary;
  text-shadow: none;
}

.metric-card__trend {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: $fs-small - 1px;
}

.metric-card__trend-row {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.metric-card__trend-key {
  color: $text-muted;
}

.metric-card__trend-val {
  @include numeric;

  &.is-up {
    color: $green;
  }
  &.is-down {
    color: $red;
  }
  &.is-flat {
    color: $text-secondary;
  }
}
</style>
