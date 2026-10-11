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
import type { RoomClassificationDisplay } from "../../room/room-catalog";
import type { AgentPoolQuery } from "../../../shared/agents/filter";

// 代理人池工具栏：第一行左侧为属性筛选组，右侧为名称搜索框；宽度足够时
// 特性组与属性组同排（单行模式），放不下时特性组移到第二行左对齐（两行
// 模式），搜索框始终固定在第一行右侧、不参与自然换行。行模式由实测的
// 分类按钮内容宽度决定（分类数量与名称来自房间目录，不预设像素断点），
// 工作区宽度变化时经 ResizeObserver 复测。
//
// 图标形态：目录快照携带分类图标资源（新目录）时，按目标形态切换——宽时
// 每个筛选项显示「图标＋名称」，放不下时退为「仅图标」（悬停或聚焦显示
// 名称，无障碍名称常驻）；旧目录快照没有图标资源信息时回退为名称文字
// 按钮（沿用单行/两行的文字排布）。
//
// 图标加载失败（资源修订目录缺失等）时该按钮退回可见的分类名称文字，
// 不留不可辨认的空按钮：失败按图标 URL 记录，目录修订变化产生的新 URL
// 不沿用旧的失败状态；失败后的内容宽度参与行模式复测，布局按实际内容
// 重新计算、不溢出不抖动。
//
// 两种内容宽度都以隐藏测量行实测（测量行固定渲染完整内容，不随当前
// 模式收起，因此切换模式后仍可复测另一种配置，不会来回抖动）。

const props = defineProps<{
  readonly elements: readonly RoomClassificationDisplay[];
  readonly specialties: readonly RoomClassificationDisplay[];
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

// ---- 图标与行模式判定 ----

/** 目录快照是否携带完整的分类图标资源（schema 保证带修订时全量存在）。 */
const hasIcons = computed(
  () =>
    props.elements.length > 0 &&
    props.specialties.length > 0 &&
    [...props.elements, ...props.specialties].every((entry) => entry.iconUrl !== null),
);

/**
 * 加载失败的分类图标 URL（按 URL 记录）：同一 URL 的失败是终态（不自动
 * 重试热链），图标 URL 变化（目录修订更新）后是新的键，不沿用失败状态。
 * 失败的按钮退回显示分类名称，图标不再渲染（不留空占位框）。
 */
const failedIconUrls = ref<ReadonlySet<string>>(new Set());

/** 记录图标加载失败；触发内容重渲染与行模式复测。 */
function onIconError(classification: RoomClassificationDisplay): void {
  const url = classification.iconUrl;
  if (url === null || failedIconUrls.value.has(url)) return;
  failedIconUrls.value = new Set(failedIconUrls.value).add(url);
}

/**
 * 该分类的图标当前是否可渲染（目录声明且未加载失败）；同时作为类型谓词，
 * v-if 分支内 iconUrl 收窄为 string。
 */
function iconAvailable(
  classification: RoomClassificationDisplay,
): classification is RoomClassificationDisplay & { iconUrl: string } {
  return classification.iconUrl !== null && !failedIconUrls.value.has(classification.iconUrl);
}

/** 筛选项内容模式：完整（图标＋名称或文字）与仅图标。 */
const iconOnly = ref(false);

/** 行模式：单行放不下时两组上下排列，搜索固定第一行右对齐。 */
const stacked = ref(false);

const rowEl = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLElement | null>(null);
const measureElementsEl = ref<HTMLElement | null>(null);
const measureSpecialtiesEl = ref<HTMLElement | null>(null);

/**
 * 单行模式的固定开销：3 个行内 gap（0.5rem）与分隔线（w-px）。
 * 分隔线在两行模式下隐藏（offsetWidth 为 0），因此以常量参与计算；
 * 若调整行内间距或分隔线宽度，需同步此处的换算。
 */
const SINGLE_ROW_GAP_PX = 8;
const SEPARATOR_PX = 1;

/** 筛选按钮内图标与名称的间距（与按钮内 gap-1 对应）。 */
const ICON_NAME_GAP_PX = 4;

/**
 * 复测行模式：以隐藏测量行实测完整内容（图标＋名称）与仅图标的自然
 * 宽度，再与行容器宽度比较。测量行不随模式收起，两种配置的宽度都可
 * 随时取得，切换模式不会改变行容器宽度，不会来回抖动。
 */
function recomputeRowModes(): void {
  const row = rowEl.value;
  const search = searchEl.value;
  const measureElements = measureElementsEl.value;
  const measureSpecialties = measureSpecialtiesEl.value;
  if (row === null || search === null || measureElements === null || measureSpecialties === null) {
    return;
  }
  const groupsWidth = measureElements.offsetWidth + measureSpecialties.offsetWidth;
  const wideTotal = groupsWidth + search.offsetWidth + SEPARATOR_PX + SINGLE_ROW_GAP_PX * 3;
  if (wideTotal <= row.clientWidth) {
    iconOnly.value = false;
    stacked.value = false;
    return;
  }
  if (hasIcons.value) {
    // 仅图标宽度 = 完整宽度 − 各按钮的名称占位（名称宽度以测量行内的
    // 名称元素实测，含图标与名称之间的间距）。图标加载失败的按钮在仅
    // 图标模式下改为显示名称（测量行内以 .tb-name-stays 标记），其名称
    // 占位不扣减，复测结果与实际渲染内容一致。
    const nameOverhead = (group: HTMLElement | null): number => {
      if (group === null) return 0;
      return [...group.querySelectorAll<HTMLElement>(".tb-name:not(.tb-name-stays)")].reduce(
        (sum, el) => sum + el.offsetWidth + ICON_NAME_GAP_PX,
        0,
      );
    };
    const iconTotal = wideTotal - nameOverhead(measureElements) - nameOverhead(measureSpecialties);
    iconOnly.value = true;
    stacked.value = iconTotal > row.clientWidth;
    return;
  }
  // 无图标资源（旧目录快照）：沿用文字按钮的单行/两行切换。
  iconOnly.value = false;
  stacked.value = true;
}

let rowObserver: ResizeObserver | null = null;

onMounted(() => {
  rowObserver = new ResizeObserver(recomputeRowModes);
  if (rowEl.value !== null) rowObserver.observe(rowEl.value);
  recomputeRowModes();
});

onBeforeUnmount(() => {
  rowObserver?.disconnect();
  rowObserver = null;
});

// 分类按钮随房间目录加载出现（行内容宽度变化），图标失败状态改变按钮
// 内容宽度；DOM 更新后复测行模式。
watch(
  () => [props.elements.length, props.specialties.length, hasIcons.value, failedIconUrls.value],
  () => {
    void nextTick(recomputeRowModes);
  },
);
</script>

<template>
  <div class="relative shrink-0 border-b border-(--border-default) bg-(--surface-panel) px-3 py-2">
    <TooltipProvider :delay-duration="300">
      <!--
        tb-row 的排布见下方 scoped 样式：单行为 flex 一行；两行为 grid 两行
        （属性+搜索 / 特性），搜索始终第一行右对齐。图标模式下按钮内隐藏
        名称文字（tb-name），完整内容由 aria-label 与悬停提示承接。
      -->
      <div ref="rowEl" class="tb-row" :class="{ 'tb-stacked': stacked }">
        <!-- 属性组：清除按钮 + 图标/文字按钮（旧目录快照无图标资源；目录
             未就绪时组内暂无按钮，仅保留行占位）。 -->
        <div
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
          <template v-for="classification in elements" :key="classification.id">
            <TooltipRoot v-if="iconOnly">
              <TooltipTrigger as-child>
                <Toggle
                  :model-value="query.elementIds.includes(classification.id)"
                  class="tb-toggle flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs focus-ring data-[state=on]:border-(--accent-primary) data-[state=on]:bg-(--accent-soft) data-[state=on]:font-medium data-[state=on]:text-(--text-accent)"
                  :aria-label="classification.name"
                  @update:model-value="toggleElement(classification.id)"
                >
                  <img
                    v-if="iconAvailable(classification)"
                    :src="classification.iconUrl"
                    alt=""
                    class="size-3.5 object-contain"
                    loading="lazy"
                    decoding="async"
                    @error="onIconError(classification)"
                  />
                  <!-- 图标加载失败：退回可见分类名称，不留不可辨认的空按钮。 -->
                  <span v-else class="tb-name">{{ classification.name }}</span>
                </Toggle>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent
                  class="rounded-md bg-(--text-primary) px-2 py-1 text-xs text-(--text-inverse) shadow-md"
                >
                  {{ classification.name }}
                </TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
            <Toggle
              v-else
              :model-value="query.elementIds.includes(classification.id)"
              class="tb-toggle flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs focus-ring data-[state=on]:border-(--accent-primary) data-[state=on]:bg-(--accent-soft) data-[state=on]:font-medium data-[state=on]:text-(--text-accent)"
              :aria-label="classification.name"
              @update:model-value="toggleElement(classification.id)"
            >
              <img
                v-if="iconAvailable(classification)"
                :src="classification.iconUrl"
                alt=""
                class="size-3.5 shrink-0 object-contain"
                loading="lazy"
                decoding="async"
                @error="onIconError(classification)"
              />
              <span class="tb-name">{{ classification.name }}</span>
            </Toggle>
          </template>
        </div>

        <span class="tb-sep h-4 w-px shrink-0 bg-(--border-strong)" aria-hidden="true" />

        <!-- 特性组：结构同属性组。 -->
        <div
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
          <template v-for="classification in specialties" :key="classification.id">
            <TooltipRoot v-if="iconOnly">
              <TooltipTrigger as-child>
                <Toggle
                  :model-value="query.specialtyIds.includes(classification.id)"
                  class="tb-toggle flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs focus-ring data-[state=on]:border-(--accent-primary) data-[state=on]:bg-(--accent-soft) data-[state=on]:font-medium data-[state=on]:text-(--text-accent)"
                  :aria-label="classification.name"
                  @update:model-value="toggleSpecialty(classification.id)"
                >
                  <img
                    v-if="iconAvailable(classification)"
                    :src="classification.iconUrl"
                    alt=""
                    class="size-3.5 object-contain"
                    loading="lazy"
                    decoding="async"
                    @error="onIconError(classification)"
                  />
                  <!-- 图标加载失败：退回可见分类名称，不留不可辨认的空按钮。 -->
                  <span v-else class="tb-name">{{ classification.name }}</span>
                </Toggle>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent
                  class="rounded-md bg-(--text-primary) px-2 py-1 text-xs text-(--text-inverse) shadow-md"
                >
                  {{ classification.name }}
                </TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
            <Toggle
              v-else
              :model-value="query.specialtyIds.includes(classification.id)"
              class="tb-toggle flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs focus-ring data-[state=on]:border-(--accent-primary) data-[state=on]:bg-(--accent-soft) data-[state=on]:font-medium data-[state=on]:text-(--text-accent)"
              :aria-label="classification.name"
              @update:model-value="toggleSpecialty(classification.id)"
            >
              <img
                v-if="iconAvailable(classification)"
                :src="classification.iconUrl"
                alt=""
                class="size-3.5 shrink-0 object-contain"
                loading="lazy"
                decoding="async"
                @error="onIconError(classification)"
              />
              <span class="tb-name">{{ classification.name }}</span>
            </Toggle>
          </template>
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

      <!-- 隐藏测量行：始终渲染完整内容（图标＋名称/文字），实测两种行模式
           的自然宽度；不参与交互、不可见、不占布局（绝对定位）。 -->
      <div class="tb-measure" aria-hidden="true">
        <div ref="measureElementsEl" class="flex items-center gap-1">
          <span class="flex size-6 items-center justify-center rounded border"></span>
          <Toggle
            v-for="classification in elements"
            :key="classification.id"
            class="tb-toggle pointer-events-none flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
            :model-value="false"
          >
            <img
              v-if="iconAvailable(classification)"
              :src="classification.iconUrl"
              alt=""
              class="size-3.5 shrink-0 object-contain"
            />
            <!-- 图标不可用（未声明或加载失败）的按钮在任何模式都只显示名称；
                 tb-name-stays 标记其名称在仅图标模式下仍保留，不参与名称
                 占位扣减，测量结果与实际渲染内容一致。 -->
            <span class="tb-name" :class="{ 'tb-name-stays': !iconAvailable(classification) }">
              {{ classification.name }}
            </span>
          </Toggle>
        </div>
        <span class="h-4 w-px"></span>
        <div ref="measureSpecialtiesEl" class="flex items-center gap-1">
          <span class="flex size-6 items-center justify-center rounded border"></span>
          <Toggle
            v-for="classification in specialties"
            :key="classification.id"
            class="tb-toggle pointer-events-none flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
            :model-value="false"
          >
            <img
              v-if="iconAvailable(classification)"
              :src="classification.iconUrl"
              alt=""
              class="size-3.5 shrink-0 object-contain"
            />
            <!-- 图标不可用（未声明或加载失败）的按钮在任何模式都只显示名称；
                 tb-name-stays 标记其名称在仅图标模式下仍保留，不参与名称
                 占位扣减，测量结果与实际渲染内容一致。 -->
            <span class="tb-name" :class="{ 'tb-name-stays': !iconAvailable(classification) }">
              {{ classification.name }}
            </span>
          </Toggle>
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

/* 隐藏测量行：绝对定位不占布局，visibility 保留布局测量（offsetWidth 可读）。 */
.tb-measure {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  align-items: center;
  column-gap: 0.5rem;
  visibility: hidden;
  pointer-events: none;
}
</style>
