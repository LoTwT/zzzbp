<script setup lang="ts">
import type { BpSlotId } from "../../../shared/bp/steps";
import type { RoomAgentDisplay } from "../../room/room-catalog";
import AgentAvatar from "./AgentAvatar.vue";

// 顶部禁用槽位（每方 4 个）：已提交的禁用结果显示头像与斜杠；当前操作位
// 是禁用时进入 active（高亮描边，进行中且连接正常时呼吸），并公开预选。

defineProps<{
  readonly slots: ReadonlyArray<{
    readonly slotId: BpSlotId;
    readonly agent: RoomAgentDisplay | null;
    readonly active: boolean;
  }>;
  /** 当前操作位的公开预选（显示在 active 槽位内）。 */
  readonly preselectAgent: RoomAgentDisplay | null;
  /** 是否允许呼吸动效：进行中且连接正常；暂停/断线保留静态高亮。 */
  readonly breathing: boolean;
  /** 槽位内容描述的前缀（如「A 方」），仅用于无障碍标签。 */
  readonly sideText: string;
}>();
</script>

<template>
  <div class="flex items-center gap-1.5" :aria-label="`${sideText}禁用区`">
    <div
      v-for="slot in slots"
      :key="slot.slotId"
      class="relative size-8 shrink-0 rounded-md border bg-(--surface-panel) p-0.5 sm:size-9"
      :class="slot.active ? 'border-lavender-500' : 'border-(--border-default)'"
    >
      <!-- 当前操作位：进行中呼吸；暂停/断线静态高亮，保留预选展示。 -->
      <div
        v-if="slot.active"
        class="absolute inset-0 rounded-md ring-1 ring-lavender-500"
        :class="{ 'slot-breathe': breathing }"
        aria-hidden="true"
      />
      <template v-if="slot.agent !== null">
        <AgentAvatar :agent="slot.agent" />
        <!-- 已禁用：压暗 + 斜杠覆盖。 -->
        <span class="absolute inset-0 rounded-md bg-neutral-950/50" aria-hidden="true" />
        <svg
          class="absolute inset-0 size-full text-white/85"
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
  </div>
</template>
