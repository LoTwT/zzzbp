<script setup lang="ts">
import { computed, ref } from "vue";
import { useElementSize } from "@vueuse/core";
import type { AgentPoolStatus } from "../../../shared/bp/agents";
import type { RoomAgentDisplay } from "../../room/room-catalog";
import {
  computeDisplayGrid,
  GRID_GAP_PX,
  nameDisplayUnits,
  type DisplayGridSizing,
} from "../../room/display-grid";
import DisplayAgentCard from "./DisplayAgentCard.vue";

// 展示页中央代理人池：全量同屏网格（docs/specs/room-layout.md「实时展示页」）。
// 列数与头像尺寸由 display-grid 按容器可用宽高与目录条数计算，窗口尺寸
// 变化时重算；全部条目按 ID 升序固定排列，禁选后保留原位仅更新视觉状态，
// 不滚动、不翻页、不轮播。容器尺寸测量为零（首次挂载前一帧）时不渲染。

const props = defineProps<{
  readonly entries: readonly RoomAgentDisplay[];
  readonly statuses: ReadonlyMap<string, AgentPoolStatus>;
}>();

const gridEl = ref<HTMLElement | null>(null);
const { width, height } = useElementSize(gridEl);

/** 目录中最长名称的显示宽度（em 单位）：单行可读的宽度下限依据。 */
const nameUnits = computed(() => {
  let max = 1;
  for (const entry of props.entries) {
    const units = nameDisplayUnits(entry.name);
    if (units > max) max = units;
  }
  return max;
});

const sizing = computed<DisplayGridSizing | null>(() =>
  computeDisplayGrid({
    width: width.value,
    height: height.value,
    count: props.entries.length,
    nameUnits: nameUnits.value,
  }),
);
</script>

<template>
  <!-- 裁剪边界：极端小容器下也不产生滚动条（排布算法见 display-grid）。 -->
  <div ref="gridEl" class="min-h-0 min-w-0 flex-1 overflow-hidden">
    <ul
      v-if="sizing !== null"
      class="grid size-full h-full content-center"
      :style="{
        gridTemplateColumns: `repeat(${sizing.columns}, minmax(0, 1fr))`,
        rowGap: `${GRID_GAP_PX}px`,
        columnGap: `${GRID_GAP_PX}px`,
      }"
      aria-label="代理人池"
    >
      <DisplayAgentCard
        v-for="entry in entries"
        :key="entry.id"
        :agent="entry"
        :status="statuses.get(entry.id) ?? 'available'"
        :avatar-size="sizing.avatarSize"
      />
    </ul>
  </div>
</template>
