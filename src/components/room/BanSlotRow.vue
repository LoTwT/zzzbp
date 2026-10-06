<script setup lang="ts">
import { computed } from "vue";
import type { BpSlotId } from "../../../shared/bp/steps";
import type { AgentDisplayBase } from "../../room/room-catalog";
import { banRoundBreakIndex } from "../../room/pick-layout";
import AgentAvatar from "./AgentAvatar.vue";

// 顶部禁用槽位（每方 4 个）：已提交的禁用结果显示头像与斜杠；当前操作位
// 是禁用时进入 active（高亮描边，进行中且连接正常时呼吸），并公开预选。
// 两轮禁用（每方前 2 位与后 2 位）之间以竖线分隔，边界按权威操作位推导
// （banRoundBreakIndex），与显示顺序无关；实时房间、展示页与记录页共用
// 本组件，三个页面的分隔一致。

const props = defineProps<{
  readonly slots: ReadonlyArray<{
    readonly slotId: BpSlotId;
    readonly agent: AgentDisplayBase | null;
    readonly active: boolean;
  }>;
  /** 当前操作位的公开预选（显示在 active 槽位内）。 */
  readonly preselectAgent: AgentDisplayBase | null;
  /** 是否允许呼吸动效：进行中且连接正常；暂停/断线保留静态高亮。 */
  readonly breathing: boolean;
  /** 槽位内容描述的前缀（如「A 方」），仅用于无障碍标签。 */
  readonly sideText: string;
}>();

/** 两轮禁用之间的分隔位置（其前插入竖线）；-1 表示不显示。 */
const roundBreakIndex = computed(() => banRoundBreakIndex(props.slots));
</script>

<template>
  <div class="flex items-center gap-1.5" :aria-label="`${sideText}禁用区`">
    <template v-for="(slot, index) in slots" :key="slot.slotId">
      <!-- self-stretch + 上下留白：竖线跟随禁用格高度，不依赖百分比高度。 -->
      <span
        v-if="index === roundBreakIndex"
        class="my-1 w-px shrink-0 self-stretch bg-(--border-strong)"
        data-round-break="ban"
        aria-hidden="true"
      />
      <div
        :data-slot-id="slot.slotId"
        class="relative size-[var(--room-ban-slot,2.25rem)] shrink-0 rounded-md border bg-(--surface-panel) p-0.5"
        :class="slot.active ? 'border-(--accent-primary)' : 'border-(--border-default)'"
      >
        <!-- 当前操作位：进行中呼吸；暂停/断线静态高亮，保留预选展示。 -->
        <div
          v-if="slot.active"
          class="absolute inset-0 rounded-md ring-1 ring-(--accent-primary)"
          :class="{ 'slot-breathe': breathing }"
          aria-hidden="true"
        />
        <template v-if="slot.agent !== null">
          <AgentAvatar :agent="slot.agent" />
          <!-- 已禁用：压暗 + 斜杠覆盖（图像遮罩按实际用途保留）。 -->
          <span class="absolute inset-0 rounded-md bg-(--text-primary)/50" aria-hidden="true" />
          <svg
            class="absolute inset-0 size-full text-(--text-inverse)/85"
            viewBox="0 0 32 32"
            aria-hidden="true"
          >
            <line
              x1="4"
              y1="28"
              x2="28"
              y2="4"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
            />
          </svg>
          <span class="sr-only">已禁用：{{ slot.agent.name }}</span>
        </template>
        <template v-else-if="slot.active && preselectAgent !== null">
          <AgentAvatar :agent="preselectAgent" />
          <span class="sr-only">当前操作位，预选：{{ preselectAgent.name }}</span>
        </template>
        <template v-else>
          <span class="sr-only">空禁用位</span>
        </template>
      </div>
    </template>
  </div>
</template>
