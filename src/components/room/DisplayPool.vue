<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useElementSize } from "@vueuse/core";
import type { AgentPoolStatus } from "../../../shared/bp/agents";
import type { RoomAgentDisplay } from "../../room/room-catalog";
import {
  computeDisplayGrid,
  GRID_GAP_PX,
  NAME_FONT_PX,
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

/**
 * 目录最长名称的单行像素宽度：用与卡片名称同字体（取池容器的继承字体栈）
 * 、同字号的隐藏元素逐条实测。单行布局的宽度下限必须取实测值——同一名称
 * 在不同平台的字体回退下相差不到 1px，字符类估算（全角 1em、半角 0.6em）
 * 偏窄时最长名称会换行，行高多出一行并在网格居中下溢出裁剪容器。
 */
function measureMaxNameWidth(host: HTMLElement, entries: readonly RoomAgentDisplay[]): number {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.left = "-99999px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "nowrap";
  probe.style.fontFamily = getComputedStyle(host).fontFamily;
  probe.style.fontSize = `${NAME_FONT_PX}px`;
  document.body.append(probe);
  let max = 0;
  for (const entry of entries) {
    probe.textContent = entry.name;
    const measured = probe.getBoundingClientRect().width;
    if (measured > max) max = measured;
  }
  probe.remove();
  return max;
}

const maxNameWidthPx = ref(0);

/** 重新实测名称宽度：条目变化、挂载与字体就绪后都要刷新。 */
function remeasureMaxNameWidth(): void {
  if (gridEl.value === null) return;
  maxNameWidthPx.value = measureMaxNameWidth(gridEl.value, props.entries);
}

onMounted(remeasureMaxNameWidth);
watch(() => props.entries, remeasureMaxNameWidth);
// 系统字体不需要等待，此处只为将来引入 web 字体时不被首帧测量窗口卡住。
void document.fonts.ready.then(remeasureMaxNameWidth);

const sizing = computed<DisplayGridSizing | null>(() =>
  computeDisplayGrid({
    width: width.value,
    height: height.value,
    count: props.entries.length,
    nameWidthPx: maxNameWidthPx.value,
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
