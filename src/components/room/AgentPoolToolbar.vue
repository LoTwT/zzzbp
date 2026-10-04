<script setup lang="ts">
import { computed } from "vue";
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

// 代理人池工具栏：左侧属性与特性两组筛选（含各自的清除按钮），右侧名称
// 搜索框。仅向选手（含兼任房主）展示；匹配语义沿用共享 filter（同维 OR、
// 跨维 AND）。当前数据包没有结构化分类图标资源（iconPath 恒为 null，见
// docs/specs/agent-data.md），因此以官方名称文字按钮作为可识别、可访问的
// 后备，上游补齐图标后随数据更新切换。

defineProps<{
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
</script>

<template>
  <div
    class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-(--border-default) bg-(--surface-panel) px-3 py-2"
  >
    <TooltipProvider :delay-duration="300">
      <!-- 属性组：清除按钮 + 名称文字按钮（数据包无结构化图标资源）。 -->
      <div class="flex items-center gap-1" role="group" aria-label="属性筛选">
        <TooltipRoot>
          <TooltipTrigger as-child>
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded border border-(--border-default) text-neutral-500 focus-ring hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="query.elementIds.length === 0"
              aria-label="清除属性筛选"
              @click="clearElements"
            >
              <X class="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent
              class="rounded-md bg-neutral-900 px-2 py-1 text-xs text-white shadow-md"
            >
              清除属性筛选
            </TooltipContent>
          </TooltipPortal>
        </TooltipRoot>
        <Toggle
          v-for="classification in elements"
          :key="classification.id"
          :model-value="query.elementIds.includes(classification.id)"
          class="rounded border px-1.5 py-0.5 text-xs focus-ring data-[state=on]:border-lavender-500 data-[state=on]:bg-lavender-100 data-[state=on]:font-medium data-[state=on]:text-lavender-800"
          @update:model-value="toggleElement(classification.id)"
        >
          {{ classification.name }}
        </Toggle>
      </div>

      <span class="h-4 w-px bg-(--border-strong)" aria-hidden="true" />

      <!-- 特性组：清除按钮 + 名称文字按钮。 -->
      <div class="flex items-center gap-1" role="group" aria-label="特性筛选">
        <TooltipRoot>
          <TooltipTrigger as-child>
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded border border-(--border-default) text-neutral-500 focus-ring hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="query.specialtyIds.length === 0"
              aria-label="清除特性筛选"
              @click="clearSpecialties"
            >
              <X class="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent
              class="rounded-md bg-neutral-900 px-2 py-1 text-xs text-white shadow-md"
            >
              清除特性筛选
            </TooltipContent>
          </TooltipPortal>
        </TooltipRoot>
        <Toggle
          v-for="classification in specialties"
          :key="classification.id"
          :model-value="query.specialtyIds.includes(classification.id)"
          class="rounded border px-1.5 py-0.5 text-xs focus-ring data-[state=on]:border-lavender-500 data-[state=on]:bg-lavender-100 data-[state=on]:font-medium data-[state=on]:text-lavender-800"
          @update:model-value="toggleSpecialty(classification.id)"
        >
          {{ classification.name }}
        </Toggle>
      </div>
    </TooltipProvider>

    <!-- 名称搜索：包含匹配简短名与官方全名，trim 后为空不限制。 -->
    <div class="ml-auto flex items-center gap-1.5">
      <Search class="size-4 shrink-0 text-neutral-400" aria-hidden="true" />
      <input
        v-model="searchModel"
        class="w-44 rounded-lg border border-(--border-default) bg-(--surface-elevated) px-2.5 py-1 text-sm focus-ring"
        type="search"
        placeholder="搜索代理人名称"
        aria-label="搜索代理人名称"
      />
    </div>
  </div>
</template>
