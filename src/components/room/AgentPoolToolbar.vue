<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  Toggle,
} from "reka-ui";
import { Search, X } from "@lucide/vue";
import type { AgentClassification } from "../../../shared/agents/schema";
import type { AgentPoolQuery } from "../../../shared/agents/filter";

// 代理人池工具栏：第一行左侧为属性筛选组，右侧为名称搜索框；宽度足够时
// 特性组与属性组同排（单行模式），放不下时特性组移到第二行左对齐（两行
// 模式），搜索框始终固定在第一行右侧、不参与自然换行。行模式由实测的
// 分类按钮内容宽度决定（分类数量与名称来自房间目录，不预设像素断点），
// 工作区宽度变化时经 ResizeObserver 复测。
// 当前数据包没有属性/特性分类的结构化图标资源（iconPath 恒为 null，见
// docs/specs/agent-data.md），因此仍以官方名称文字按钮作为可识别、可访问
// 的后备；上游补齐图标后随数据版本更新切回「宽时图标+名称、窄时仅图标」
// 的目标形态（docs/specs/room-layout.md「代理人池搜索与筛选」）。

const props = defineProps<{
  readonly elements: readonly AgentClassification[];
  readonly specialties: readonly AgentClassification[];
}>();

const query = defineModel<AgentPoolQuery>({ required: true });

/** 搜索框的双向绑定：写入聚合到共享查询结构。 */
const searchModel = computed({
  get: () => query.value.name,
  set: (value: string) => {
    query.value = { ...query.value, name: value };
  },
});

function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

function toggleElement(id: string): void {
  query.value = { ...query.value, elementIds: toggleId(query.value.elementIds, id) };
}

function toggleSpecialty(id: string): void {
  query.value = { ...query.value, specialtyIds: toggleId(query.value.specialtyIds, id) };
}

function clearElements(): void {
  query.value = { ...query.value, elementIds: [] };
}

function clearSpecialties(): void {
  query.value = { ...query.value, specialtyIds: [] };
}

// ---- 行模式：单行放不下时两组上下排列，搜索固定第一行右对齐。 ----

const rowEl = ref<HTMLElement | null>(null);
const elementsEl = ref<HTMLElement | null>(null);
const specialtiesEl = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLElement | null>(null);
/** 两行模式：特性组换行到第二行。 */
const stacked = ref(false);

/**
 * 单行模式的固定开销：3 个行内 gap（0.5rem）与分隔线（w-px）。
 * 分隔线在两行模式下隐藏（offsetWidth 为 0），因此以常量参与计算；
 * 若调整行内间距或分隔线宽度，需同步此处的换算。
 */
const SINGLE_ROW_GAP_PX = 8;
const SEPARATOR_PX = 1;

/**
 * 复测行模式：比较两组与搜索框的自然宽度之和与行容器宽度。
 * 行内各部分均为 shrink-0（不参与 flex 压缩），offsetWidth 即内容自然
 * 宽度；两行模式下网格项不拉伸（justify-self: start），两种模式下测得
 * 同一判据，不会来回抖动。
 */
function recomputeStacked(): void {
  const row = rowEl.value;
  const elements = elementsEl.value;
  const specialties = specialtiesEl.value;
  const search = searchEl.value;
  if (row === null || elements === null || specialties === null || search === null) return;
  const needed =
    elements.offsetWidth +
    specialties.offsetWidth +
    search.offsetWidth +
    SEPARATOR_PX +
    SINGLE_ROW_GAP_PX * 3;
  stacked.value = needed > row.clientWidth;
}

let rowObserver: ResizeObserver | null = null;

onMounted(() => {
  rowObserver = new ResizeObserver(recomputeStacked);
  if (rowEl.value !== null) rowObserver.observe(rowEl.value);
  recomputeStacked();
});

onBeforeUnmount(() => {
  rowObserver?.disconnect();
  rowObserver = null;
});

// 分类按钮随房间目录加载出现（行内容宽度变化），DOM 更新后复测行模式。
watch(
  () => [props.elements.length, props.specialties.length],
  () => {
    void nextTick(recomputeStacked);
  },
);
</script>

<template>
  <div class="shrink-0 border-b border-(--border-default) bg-(--surface-panel) px-3 py-2">
    <TooltipProvider :delay-duration="300">
      <!-- tb-row 的两种排布见下方 scoped 样式：单行为 flex 一行；两行为
           grid 两行（属性+搜索 / 特性），搜索始终第一行右对齐。 -->
      <div ref="rowEl" class="tb-row" :class="{ 'tb-stacked': stacked }">
        <!-- 属性组：清除按钮 + 名称文字按钮（数据包无结构化图标资源；
             目录未就绪时组内暂无按钮，仅保留行占位）。 -->
        <div
          ref="elementsEl"
          class="tb-elements flex shrink-0 items-center gap-1"
          role="group"
          aria-label="属性筛选"
        >
          <TooltipRoot v-if="elements.length > 0">
            <TooltipTrigger as-child>
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded border border-(--border-default) text-(--text-muted) focus-ring enabled:hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="query.elementIds.length === 0"
                aria-label="清除属性筛选"
                @click="clearElements"
              >
                <X class="size-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                class="rounded-md bg-(--text-primary) px-2 py-1 text-xs text-(--text-inverse) shadow-md"
              >
                清除属性筛选
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
          <Toggle
            v-for="classification in elements"
            :key="classification.id"
            :model-value="query.elementIds.includes(classification.id)"
            class="rounded border px-1.5 py-0.5 text-xs focus-ring data-[state=on]:border-(--accent-primary) data-[state=on]:bg-(--accent-soft) data-[state=on]:font-medium data-[state=on]:text-(--text-accent)"
            @update:model-value="toggleElement(classification.id)"
          >
            {{ classification.name }}
          </Toggle>
        </div>

        <span class="tb-sep h-4 w-px shrink-0 bg-(--border-strong)" aria-hidden="true" />

        <!-- 特性组：结构同属性组。 -->
        <div
          ref="specialtiesEl"
          class="tb-specialties flex shrink-0 items-center gap-1"
          role="group"
          aria-label="特性筛选"
        >
          <TooltipRoot v-if="specialties.length > 0">
            <TooltipTrigger as-child>
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded border border-(--border-default) text-(--text-muted) focus-ring enabled:hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="query.specialtyIds.length === 0"
                aria-label="清除特性筛选"
                @click="clearSpecialties"
              >
                <X class="size-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                class="rounded-md bg-(--text-primary) px-2 py-1 text-xs text-(--text-inverse) shadow-md"
              >
                清除特性筛选
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
          <Toggle
            v-for="classification in specialties"
            :key="classification.id"
            :model-value="query.specialtyIds.includes(classification.id)"
            class="rounded border px-1.5 py-0.5 text-xs focus-ring data-[state=on]:border-(--accent-primary) data-[state=on]:bg-(--accent-soft) data-[state=on]:font-medium data-[state=on]:text-(--text-accent)"
            @update:model-value="toggleSpecialty(classification.id)"
          >
            {{ classification.name }}
          </Toggle>
        </div>

        <!-- 名称搜索：包含匹配简短名与官方全名，trim 后为空不限制；
             固定在第一行右侧（单行 ml-auto，两行 grid 首行末列）。 -->
        <div ref="searchEl" class="tb-search ml-auto flex shrink-0 items-center gap-1.5">
          <Search class="size-4 shrink-0 text-(--text-muted)" aria-hidden="true" />
          <input
            v-model="searchModel"
            class="w-44 shrink-0 rounded-lg border border-(--border-default) bg-(--surface-elevated) px-2.5 py-1 text-sm focus-ring"
            type="search"
            placeholder="搜索代理人名称"
            aria-label="搜索代理人名称"
          />
        </div>
      </div>
    </TooltipProvider>
  </div>
</template>

<style scoped>
/*
 * 单行模式：一行排下两组、分隔线与搜索框，搜索框靠右。
 * 使用 column-gap 统一行内间距（与脚本中的 SINGLE_ROW_GAP_PX 对应）。
 */
.tb-row {
  display: flex;
  align-items: center;
  column-gap: 0.5rem;
}

/*
 * 两行模式：属性组与搜索在第一行（搜索右对齐），特性组独占第二行且
 * 左对齐；分隔线隐藏。网格项不拉伸（justify-self: start），保证行模式
 * 复测时各部分仍测得内容自然宽度。
 */
.tb-stacked {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    "elements search"
    "specialties specialties";
  row-gap: 0.375rem;
}

.tb-stacked > * {
  justify-self: start;
}

.tb-elements {
  grid-area: elements;
}

.tb-specialties {
  grid-area: specialties;
}

.tb-stacked .tb-sep {
  display: none;
}
</style>
