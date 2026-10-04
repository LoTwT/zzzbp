<script setup lang="ts">
import type { RoomAgentDisplay } from "../../room/room-catalog";
import type { PickSlotView } from "../../room/view-projections";
import AgentAvatar from "./AgentAvatar.vue";

// 一方选用区：默认 9 格竖排或按 Pick 分行（行结构由 pickSlotRows 从
// BP_STEPS / BP_PICK_SEGMENTS 推导）。顶部只显示队名，空席「待选择」，
// 不加 A/B 前缀、昵称或「你」标记。当前操作位是本方选用时进入 active，
// 公开预选直接展示在当前槽位。

defineProps<{
  readonly teamName: string;
  readonly rows: ReadonlyArray<ReadonlyArray<PickSlotView>>;
  readonly preselectAgent: RoomAgentDisplay | null;
  readonly breathing: boolean;
  readonly sideText: string;
}>();
</script>

<template>
  <section
    class="flex min-h-0 w-full flex-col items-center gap-2"
    :aria-label="`${sideText}选用区`"
  >
    <p
      class="w-full truncate rounded-md bg-(--surface-panel) px-2 py-1 text-center text-sm font-medium text-neutral-800"
      :title="teamName"
    >
      {{ teamName }}
    </p>
    <div class="flex min-h-0 flex-1 flex-col justify-start gap-1.5 overflow-y-auto py-0.5">
      <div v-for="(row, rowIndex) in rows" :key="rowIndex" class="flex justify-center gap-1.5">
        <div
          v-for="slot in row"
          :key="slot.slotId"
          class="relative size-11 shrink-0 rounded-md border bg-(--surface-panel) p-0.5"
          :class="slot.active ? 'border-lavender-500' : 'border-(--border-default)'"
        >
          <div
            v-if="slot.active"
            class="absolute inset-0 rounded-md ring-1 ring-lavender-500"
            :class="{ 'slot-breathe': breathing }"
            aria-hidden="true"
          />
          <span
            class="absolute -top-1 -left-1 z-10 flex size-4 items-center justify-center rounded-full bg-neutral-800 text-[10px] font-medium text-white"
            aria-hidden="true"
          >
            {{ slot.step.sideOrdinal }}
          </span>
          <template v-if="slot.agent !== null">
            <AgentAvatar :agent="slot.agent" />
            <span class="sr-only"
              >第 {{ slot.step.sideOrdinal }} 个选用：{{ slot.agent.name }}</span
            >
          </template>
          <template v-else-if="slot.active && preselectAgent !== null">
            <AgentAvatar :agent="preselectAgent" />
            <span class="sr-only">当前操作位，预选：{{ preselectAgent.name }}</span>
          </template>
          <template v-else>
            <span class="sr-only">空选用位 {{ slot.step.sideOrdinal }}</span>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
