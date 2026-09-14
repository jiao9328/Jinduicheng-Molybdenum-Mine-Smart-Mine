<template>
  <span class="status-tag" :class="`is-${resolved}`">
    <i class="status-tag__dot" />
    {{ text || DEFAULT_TEXT[resolved] }}
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

/** 状态语义 —— 与文档验收标准一致：绿=已处理 / 黄=处置中 / 橙=未处理 / 红=告警 */
export type StatusType = 'done' | 'doing' | 'todo' | 'alarm' | 'info'

const DEFAULT_TEXT: Record<StatusType, string> = {
  done: '已处理',
  doing: '处置中',
  todo: '未处理',
  alarm: '告警',
  info: '正常'
}

const props = withDefaults(
  defineProps<{
    status: StatusType
    /** 覆盖默认文案，如「已修复」「未处理」 */
    text?: string
  }>(),
  { text: '' }
)

const resolved = computed(() => props.status)
</script>

<style lang="scss" scoped>
.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px;
  font-size: $fs-small - 1px;
  line-height: 1;
  border-radius: 10px;
  border: 1px solid currentColor;
  background: rgba(255, 255, 255, 0.04);
  white-space: nowrap;
}

.status-tag__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 5px currentColor;
}

.is-done {
  color: $status-done;
}
.is-doing {
  color: $status-doing;
}
.is-todo {
  color: $status-todo;
}
.is-alarm {
  color: $status-alarm;
  .status-tag__dot {
    animation: g-pulse 1.2s ease-in-out infinite;
  }
}
.is-info {
  color: $text-secondary;
}
</style>
