<template>
  <div class="data-admin">
    <AppHeader :show-nav="false" title="数据管理" />

    <main class="data-admin__main">
      <div class="data-admin__content">
        <!-- 四张台账的切换条。角标是**库里的真实条数**（来自 /api/health），
             不是当前页面的行数 —— 后端没起时它会显示「—」而不是 0 -->
        <nav class="data-admin__tabs">
          <button
            v-for="item in RESOURCES"
            :key="item.key"
            class="data-admin__tab"
            :class="{ 'is-active': item.key === active }"
            type="button"
            @click="active = item.key"
          >
            {{ item.label }}
            <span class="data-admin__tab-count">{{ countOf(item.key) }}</span>
          </button>
        </nav>

        <PanelBox
          :title="current.label"
          :subtitle="current.subtitle"
          class="data-admin__panel"
        >
          <template #extra>
            <span v-if="listError" class="data-admin__bad">后端不可用</span>
            <span v-else class="data-admin__hint">
              共 {{ rows.length }} 条 · {{ current.primaryHint }}
            </span>
            <button
              class="data-admin__btn data-admin__btn--primary"
              type="button"
              @click="openCreate"
            >
              ＋ 新增
            </button>
          </template>

          <!-- 列表加载失败时**不留一张空表**：空表与「这张表就是没有数据」
               长得一模一样，而两者的处理方式完全不同 -->
          <div v-if="listError" class="data-admin__blocked">
            <p class="data-admin__blocked-title">读取失败</p>
            <p class="data-admin__blocked-text">{{ listError }}</p>
            <button class="data-admin__btn" type="button" @click="load()">重试</button>
          </div>

          <el-table
            v-else
            v-loading="listLoading"
            :data="rows"
            size="small"
            height="100%"
            class="data-table"
            :header-cell-style="{ ...tableHeaderStyle() }"
            :cell-style="{ ...tableCellStyle() }"
          >
            <el-table-column
              v-for="field in current.fields"
              :key="field.name"
              :prop="field.name"
              :label="field.label"
              :width="field.width"
              :min-width="field.minWidth"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                <!-- 隐患状态用既有 StatusTag 渲染，配色与「应急救援」页一致 -->
                <StatusTag
                  v-if="field.type === 'status'"
                  :status="row[field.name]"
                  :text="row.statusText"
                />
                <span v-else>{{ row[field.name] }}</span>
              </template>
            </el-table-column>

            <el-table-column label="操作" width="132" align="right">
              <template #default="{ row }">
                <button class="data-admin__row-btn" type="button" @click="openEdit(row)">
                  编辑
                </button>
                <button
                  class="data-admin__row-btn data-admin__row-btn--danger"
                  type="button"
                  @click="askDelete(row)"
                >
                  删除
                </button>
              </template>
            </el-table-column>

            <template #empty>
              <span class="data-admin__empty">这张表还没有记录，点右上角「＋ 新增」</span>
            </template>
          </el-table>
        </PanelBox>
      </div>

      <!--
        新增 / 编辑浮层。
        ⚠️ 必须挂在 `.data-admin__main`（内容区）且 `__main` 自身是 position: relative，
        浮层的包含块才是内容区而不是整个 1080 高的页面根。理由详见 AppModal.vue 头部注释。
      -->
      <AppModal
        v-model="formOpen"
        :title="formMode === 'create' ? `新增${current.label}` : `编辑${current.label}`"
        :subtitle="current.subtitle"
        :width="560"
        :height="current.formHeight"
      >
        <div class="data-admin__form">
          <label v-for="field in current.fields" :key="field.name" class="data-admin__field">
            <span class="data-admin__field-label">
              {{ field.label }}
              <em v-if="field.required" class="data-admin__req">必填</em>
            </span>

            <!-- 主键在编辑时不可改：改主键本质是删一条再插一条，
                 这里让它变成灰色只读，而不是提交后才发现后端不认 -->
            <input
              v-if="field.type === 'text' || field.type === 'int'"
              v-model="formValues[field.name]"
              class="data-admin__input"
              :type="field.type === 'int' ? 'number' : 'text'"
              :disabled="isLockedKey(field)"
              :placeholder="field.placeholder"
            />

            <select
              v-else-if="field.type === 'status'"
              v-model="formValues[field.name]"
              class="data-admin__input"
            >
              <option v-for="opt in HAZARD_STATUS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>

            <span v-if="field.tip" class="data-admin__field-tip">{{ field.tip }}</span>
          </label>

          <p v-if="formError" class="data-admin__error" role="alert">{{ formError }}</p>
        </div>

        <template #footer>
          <button class="data-admin__btn" type="button" @click="formOpen = false">取消</button>
          <button
            class="data-admin__btn data-admin__btn--primary"
            type="button"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </template>
      </AppModal>

      <!--
        删除确认。
        自己搭一个浮层而不用 `el-message-box`：那类组件默认 teleport 到 body，
        会跳出 ScaleScreen 的 transform 缩放在别的分辨率下错位（见 AppModal 注释）。
      -->
      <AppModal v-model="confirmOpen" title="确认删除" subtitle="DELETE" :width="460" :height="240">
        <div class="data-admin__confirm">
          <p class="data-admin__confirm-text">
            确定删除这条{{ current.label }}记录？此操作不可撤销。
          </p>
          <p v-if="pendingDelete" class="data-admin__confirm-row">
            {{ summarize(pendingDelete) }}
          </p>
          <p v-if="formError" class="data-admin__error" role="alert">{{ formError }}</p>
        </div>

        <template #footer>
          <button class="data-admin__btn" type="button" @click="confirmOpen = false">
            取消
          </button>
          <button
            class="data-admin__btn data-admin__btn--danger"
            type="button"
            :disabled="saving"
            @click="confirmDelete"
          >
            {{ saving ? '删除中…' : '删除' }}
          </button>
        </template>
      </AppModal>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppHeader from '@/components/AppHeader.vue'
import AppModal from '@/components/AppModal.vue'
import PanelBox from '@/components/PanelBox.vue'
import StatusTag from '@/components/StatusTag.vue'
import { tableCellStyle, tableHeaderStyle } from '@/utils/tableTheme'
import { fetchHealth } from '@/api/auth'
import {
  createRecord,
  deleteRecord,
  listRecords,
  updateRecord,
  type ResourceKey
} from '@/api/dataAdmin'
import { HttpError } from '@/api/http'
import type { QualityRecord } from '@/api/production'
import type { SparePart } from '@/api/equipment'
import type { HazardDisposal, HazardStatus } from '@/api/emergency'

/**
 * 数据管理 —— 四张台账的增删改查。**只有管理员进得来**（路由 meta.roles）。
 *
 * ## 只管四张表，不做「万能表编辑器」
 *
 * 平台上还有七十来个接口的图表数据（月份+数值、饼图占比），它们**刻意不入库**
 * —— 那是一张图一个形状的展示参数，不是「一条条记录」。给它们做通用 JSON 编辑器
 * 看着很通用，实际上等于把数据库当文件柜用：不能按字段查询、不能按字段校验、
 * 页面上也没人能看懂那串 JSON 是什么。所以这里只有四张真台账。
 *
 * ## 权限只在界面上「裁剪」，真正的拦截在后端
 *
 * 这个页面靠路由守卫挡住普通用户，但那只是不让人白点 —— 改掉 localStorage 里的
 * role 就能进来。**每个写操作仍然会被后端逐个 403 挡回**（`server/routes.mjs`
 * 的 `requireAdmin`），所以本页所有写请求都会把后端返回的错误原文显示出来，
 * 而不是自己编一句「操作失败」。这与 README §13 第 4 条的规矩一致。
 *
 * ## 为什么表单控件是手写的
 *
 * `el-input` / `el-select` / `el-button` 在全库**从未用过**（只用过 `el-table`），
 * 暗色表现没有验证过；而本仓库对按钮/输入一直是手写样式（`.app-header__tab`、
 * `.production__export`、`.login__input`）。沿用同一套 SCSS 变量，视觉天然一致，
 * 也少一处没验证过的东西。表格继续用 `el-table` —— 那个是验证过的。
 */

interface FieldDef {
  name: string
  label: string
  /** `status` 走 StatusTag + 下拉框，其余是普通输入框 */
  type: 'text' | 'int' | 'status'
  required?: boolean
  width?: number
  minWidth?: number
  placeholder?: string
  tip?: string
}

interface ResourceDef {
  key: ResourceKey
  label: string
  subtitle: string
  /** 主键字段名，与后端 `RESOURCES` 一致 */
  pk: string
  /** 新增时主键由后端自增（true）还是要用户自己填（false） */
  autoKey: boolean
  fields: FieldDef[]
  formHeight: number
  primaryHint: string
}

/** 隐患状态 → 中文，与后端 `advanceHazard` 里的映射保持一致 */
const HAZARD_STATUS: { value: HazardStatus; label: string }[] = [
  { value: 'todo', label: '未处理' },
  { value: 'doing', label: '处置中' },
  { value: 'done', label: '已处置' }
]

/**
 * 四张表的界面定义 —— 字段名与先后顺序照搬 `src/mock/*.ts` 里的类型定义，
 * 与后端 `server/db.mjs` 的 `RESOURCES` 一一对应。
 */
const RESOURCES: ResourceDef[] = [
  {
    key: 'quality',
    label: '质检记录',
    subtitle: 'INSPECTION RECORDS',
    pk: 'id',
    autoKey: true,
    primaryHint: '按时间倒序录入',
    formHeight: 520,
    fields: [
      { name: 'time', label: '时间', type: 'text', required: true, placeholder: '2023-6-26 16:57', minWidth: 130 },
      { name: 'issue', label: '质检异常情况', type: 'text', placeholder: '无异常', minWidth: 120 },
      { name: 'action', label: '处理措施', type: 'text', placeholder: '无异常时填「—」', minWidth: 120 },
      { name: 'owner', label: '负责人', type: 'text', placeholder: '何**（脱敏写法）', width: 110 }
    ]
  },
  {
    key: 'duty',
    label: '值班与交接班',
    subtitle: 'DUTY ROSTER',
    pk: 'id',
    autoKey: true,
    primaryHint: '早/中/夜三班',
    formHeight: 560,
    fields: [
      { name: 'shift', label: '班次', type: 'text', required: true, placeholder: '早班', width: 100 },
      { name: 'time', label: '时段', type: 'text', placeholder: '08:00-16:00', width: 130 },
      { name: 'leader', label: '值班长', type: 'text', placeholder: '赵**', width: 110 },
      { name: 'crew', label: '作业队组', type: 'text', placeholder: '掘进一队', minWidth: 120 },
      { name: 'status', label: '状态', type: 'text', placeholder: '在岗 / 交接中', width: 100 }
    ]
  },
  {
    key: 'spare',
    label: '备件台账',
    subtitle: 'SPARE PARTS',
    pk: 'code',
    autoKey: false,
    primaryHint: '库存低于阈值即预警',
    formHeight: 700,
    fields: [
      { name: 'code', label: '备件编码', type: 'text', required: true, placeholder: 'SP-1001', width: 120, tip: '业务主键，建档后不可修改' },
      { name: 'name', label: '名称', type: 'text', required: true, placeholder: '颚板', minWidth: 110 },
      { name: 'device', label: '适用设备', type: 'text', placeholder: '破碎一', minWidth: 110 },
      { name: 'inbound', label: '累计入库', type: 'int', width: 100 },
      { name: 'outbound', label: '累计出库', type: 'int', width: 100 },
      { name: 'stock', label: '当前库存', type: 'int', width: 100 },
      { name: 'minStock', label: '缺货阈值', type: 'int', width: 100, tip: '库存低于此值触发预警' },
      { name: 'unit', label: '单位', type: 'text', placeholder: '件', width: 80 }
    ]
  },
  {
    key: 'hazard',
    label: '隐患处置',
    subtitle: 'HAZARD DISPOSAL',
    pk: 'id',
    autoKey: true,
    primaryHint: '状态可在「应急救援」页推进',
    formHeight: 520,
    fields: [
      { name: 'type', label: '隐患类型', type: 'text', required: true, placeholder: '边坡位移超限', minWidth: 130 },
      { name: 'location', label: '位置', type: 'text', placeholder: '北帮采剥面', minWidth: 130 },
      { name: 'status', label: '状态', type: 'status', width: 110 },
      {
        name: 'statusText',
        label: '状态文案',
        type: 'text',
        minWidth: 120,
        placeholder: '已处置',
        tip: '可覆盖状态的中文写法（如「已修复」）'
      }
    ]
  }
]

/**
 * 主键取值字段的类型标记，只为让下面的联合类型看起来有意义。
 * 四个资源的行都用宽松的记录类型 —— 它们的字段各不相同，逐个建类型
 * 只会得到四个除了字段名以外完全一样的接口。
 */
type Row = Record<string, unknown> & Partial<QualityRecord & SparePart & HazardDisposal>

const active = ref<ResourceKey>('quality')
const rows = ref<Row[]>([])
const listLoading = ref(false)
const listError = ref('')

const counts = ref<Record<string, number>>({})

const formOpen = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const formValues = ref<Record<string, unknown>>({})
const formError = ref('')
const saving = ref(false)

const confirmOpen = ref(false)
const pendingDelete = ref<Row | null>(null)

const current = computed(() => RESOURCES.find((r) => r.key === active.value) as ResourceDef)

function countOf(key: ResourceKey): string {
  const table = { quality: 'quality_records', duty: 'duty_schedule', spare: 'spare_parts', hazard: 'hazard_disposals' }[key]
  const n = counts.value[table]
  return typeof n === 'number' ? String(n) : '—'
}

/** 把异常翻成人能看懂的一句话。401/403 用后端原文 —— 那句里已经说明了原因 */
function describe(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 0) return '无法连接后端，请确认已执行 npm run serve（8787 端口）'
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

async function load() {
  listLoading.value = true
  listError.value = ''
  try {
    rows.value = await listRecords<Row>(active.value)
  } catch (err) {
    rows.value = []
    listError.value = describe(err)
  } finally {
    listLoading.value = false
  }
}

/** 刷新各表条数角标。失败就保持「—」，不报错 —— 它是锦上添花，不该打断操作 */
async function loadCounts() {
  try {
    const health = await fetchHealth()
    counts.value = health.tables
  } catch {
    counts.value = {}
  }
}

watch(active, () => void load(), { immediate: true })
void loadCounts()

/** 编辑时主键只读；新增时若是用户自己定的主键（备件编码）则可填 */
function isLockedKey(field: FieldDef): boolean {
  return formMode.value === 'edit' && field.name === current.value.pk
}

function openCreate() {
  const values: Record<string, unknown> = {}
  for (const field of current.value.fields) {
    values[field.name] = field.type === 'int' ? 0 : field.type === 'status' ? 'todo' : ''
  }
  formValues.value = values
  formMode.value = 'create'
  formError.value = ''
  formOpen.value = true
}

function openEdit(row: Row) {
  formValues.value = { ...row }
  formMode.value = 'edit'
  formError.value = ''
  formOpen.value = true
}

/**
 * 提交表单。
 *
 * 只送**定义过的字段**，主键在编辑时不送（后端也不接受改主键）。
 * 校验交给后端 —— 前端这里只做「必填别交白卷」，规则不写第二份：
 * 两处规则一定会漂移，而后端那份才是算数的。
 */
async function save() {
  const def = current.value
  const body: Record<string, unknown> = {}

  for (const field of def.fields) {
    if (isLockedKey(field)) continue
    const raw = formValues.value[field.name]
    if (field.type === 'int') {
      const n = Number(raw)
      body[field.name] = Number.isFinite(n) ? Math.trunc(n) : 0
    } else {
      body[field.name] = raw === undefined || raw === null ? '' : String(raw).trim()
    }
  }

  saving.value = true
  formError.value = ''
  try {
    if (formMode.value === 'create') {
      await createRecord(active.value, body)
    } else {
      await updateRecord(active.value, String(formValues.value[def.pk]), body)
    }
    formOpen.value = false
    await Promise.all([load(), loadCounts()])
  } catch (err) {
    // 400（缺必填）/ 403（越权）/ 409（主键重复）都会带着后端文案落到这里
    formError.value = describe(err)
  } finally {
    saving.value = false
  }
}

function askDelete(row: Row) {
  pendingDelete.value = row
  formError.value = ''
  confirmOpen.value = true
}

async function confirmDelete() {
  const row = pendingDelete.value
  if (!row) return

  saving.value = true
  formError.value = ''
  try {
    await deleteRecord(active.value, String(row[current.value.pk]))
    confirmOpen.value = false
    pendingDelete.value = null
    await Promise.all([load(), loadCounts()])
  } catch (err) {
    formError.value = describe(err)
  } finally {
    saving.value = false
  }
}

/** 删除确认框里那一行「这是什么记录」—— 取前三个非空字段拼一句 */
function summarize(row: Row): string {
  const parts = current.value.fields
    .filter((f) => f.type !== 'status')
    .map((f) => row[f.name])
    .filter((v) => v !== undefined && v !== null && String(v).trim() !== '')
    .slice(0, 3)
    .map((v) => String(v))
  return parts.join(' · ')
}
</script>

<style lang="scss" scoped>
.data-admin {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.data-admin__main {
  // ⚠️ 必须有 position: relative —— AppModal 是 absolute + inset:0，
  // 它的包含块由最近的定位祖先决定。少了这一句，包含块会一路回溯到
  // .data-admin（整页 1080 高），浮层会连 84px 的标题栏一起盖住
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  flex: 1;
  min-height: 0;
}

.data-admin__content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: $panel-gap;
  padding: $panel-gap;
}

// ---------- 台账切换条 ----------
.data-admin__tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.data-admin__tab {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 16px;
  font-family: $font-title;
  font-size: $fs-body;
  color: $text-secondary;
  background: $bg-panel-soft;
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: color 0.2s, background 0.2s, border-color 0.2s;

  &:hover {
    color: $primary;
    background: $bg-hover;
  }

  &.is-active {
    color: $primary;
    border-color: $border-panel;
    background: linear-gradient(180deg, rgba(0, 229, 255, 0.22) 0%, rgba(0, 229, 255, 0.06) 100%);
    @include glow-text($primary, 6px);
  }
}

.data-admin__tab-count {
  padding: 0 5px;
  font-size: $fs-subtitle;
  color: $text-muted;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 8px;
}

.data-admin__tab.is-active .data-admin__tab-count {
  color: $primary;
  background: rgba(0, 229, 255, 0.18);
}

.data-admin__panel {
  flex: 1;
  min-height: 0;
}

.data-admin__hint,
.data-admin__bad {
  margin-right: 10px;
  font-size: $fs-small;
}

.data-admin__hint {
  color: $text-muted;
}

.data-admin__bad {
  color: #ff9f1c;
}

// ---------- 按钮 ----------
// 与 .production__export / .app-header__home 同一套视觉：大屏里同层级的
// 操作入口不该有两副长相
.data-admin__btn {
  height: 26px;
  padding: 0 12px;
  font-family: $font-title;
  font-size: $fs-small;
  color: $primary;
  background: rgba(0, 229, 255, 0.08);
  border: 1px solid $border-panel;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: background 0.2s, opacity 0.2s;

  &:hover:not(:disabled) {
    background: rgba(0, 229, 255, 0.2);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &--primary {
    color: $bg-deep;
    background: linear-gradient(180deg, $primary 0%, $primary-dim 100%);
    border-color: transparent;

    &:hover:not(:disabled) {
      filter: brightness(1.15);
      background: linear-gradient(180deg, $primary 0%, $primary-dim 100%);
    }
  }

  &--danger {
    color: #ff7875;
    background: rgba(255, 77, 79, 0.1);
    border-color: rgba(255, 77, 79, 0.45);

    &:hover:not(:disabled) {
      background: rgba(255, 77, 79, 0.22);
    }
  }
}

.data-admin__row-btn {
  padding: 0 6px;
  font-family: inherit;
  font-size: $fs-small;
  color: $primary;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 0.15s;

  &:hover {
    text-decoration: underline;
  }

  &--danger {
    color: #ff7875;
  }
}

.data-admin__empty {
  font-size: $fs-small;
  color: $text-muted;
}

// ---------- 后端不可用时的占位 ----------
.data-admin__blocked {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 100%;
}

.data-admin__blocked-title {
  font-size: $fs-body;
  color: #ff9f1c;
  letter-spacing: 1px;
}

.data-admin__blocked-text {
  font-size: $fs-small;
  color: $text-secondary;
}

// ---------- 表单 ----------
.data-admin__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.data-admin__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.data-admin__field-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: $fs-small;
  color: $text-secondary;
}

.data-admin__req {
  padding: 0 4px;
  font-size: $fs-subtitle;
  font-style: normal;
  color: #ff9f1c;
  border: 1px solid rgba(255, 159, 28, 0.45);
  border-radius: 2px;
}

.data-admin__field-tip {
  font-size: $fs-subtitle;
  color: $text-muted;
}

.data-admin__input {
  height: 32px;
  padding: 0 10px;
  font-family: inherit;
  font-size: $fs-body;
  color: $text-primary;
  background: $bg-panel-soft;
  border: 1px solid $border-soft;
  border-radius: $radius-sm;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;

  &::placeholder {
    color: $text-muted;
  }

  &:focus {
    border-color: $border-panel;
    box-shadow: 0 0 10px rgba($primary, 0.25);
  }

  &:disabled {
    color: $text-muted;
    cursor: not-allowed;
    background: rgba(255, 255, 255, 0.03);
  }
}

// 数字输入框去掉浏览器自带的步进箭头：大屏这套配色下它们显得很脏，
// 而且库存/阈值这类值都是整数，用不上点按微调
.data-admin__input[type='number'] {
  &::-webkit-outer-spin-button,
  &::-webkit-inner-spin-button {
    margin: 0;
    -webkit-appearance: none;
  }
  -moz-appearance: textfield;
}

.data-admin__error {
  padding: 7px 10px;
  font-size: $fs-small;
  color: #ff7875;
  background: rgba(255, 77, 79, 0.12);
  border: 1px solid rgba(255, 77, 79, 0.4);
  border-radius: $radius-sm;
}

// ---------- 删除确认 ----------
.data-admin__confirm {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.data-admin__confirm-text {
  font-size: $fs-body;
  color: $text-body;
}

.data-admin__confirm-row {
  padding: 8px 10px;
  font-size: $fs-small;
  color: $primary;
  background: $bg-hover;
  border-left: 2px solid $primary;
  border-radius: $radius-sm;
}
</style>
