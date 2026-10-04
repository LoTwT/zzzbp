<script setup lang="ts">
import type { BpSlotId, BpTeam } from "../../../shared/bp/steps";
import type { RoomAgentDisplay } from "../../room/room-catalog";
import BanSlotRow from "./BanSlotRow.vue";

// 顶部区域：两侧禁用区对称排列，中间为房间名（赛事名）、房间状态与本机
// 连接提示（docs/specs/room-layout.md「整体结构」与「本机连接与异常反馈」，
// 线框 desktop-room-v4）。

defineProps<{
  readonly roomName: string;
  readonly bpStatusText: string;
  readonly connectionText: string | null;
  readonly banSlots: Readonly<
    Record<
      BpTeam,
      ReadonlyArray<{ slotId: BpSlotId; agent: RoomAgentDisplay | null; active: boolean }>
    >
  >;
  readonly preselectAgent: RoomAgentDisplay | null;
  readonly breathing: boolean;
}>();
</script>

<template>
  <header
    class="grid shrink-0 grid-cols-[auto_1fr_auto] items-center gap-4 border-b border-(--border-default) bg-(--surface-panel) px-4 py-2.5"
  >
    <BanSlotRow
      :slots="banSlots.A"
      :preselect-agent="preselectAgent"
      :breathing="breathing"
      side-text="A 方"
    />

    <div class="flex min-w-0 flex-col items-center gap-0.5 text-center">
      <h1 class="max-w-full truncate text-lg font-semibold text-neutral-900" :title="roomName">
        {{ roomName }}
      </h1>
      <p class="flex items-center gap-2 text-xs text-neutral-600">
        <span>{{ bpStatusText }}</span>
        <!-- 本机连接提示：连接正常时隐藏，不广播、不解释暂停原因。 -->
        <span
          v-if="connectionText !== null"
          class="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-amber-800"
          role="status"
        >
          {{ connectionText }}
        </span>
      </p>
    </div>

    <BanSlotRow
      :slots="banSlots.B"
      :preselect-agent="preselectAgent"
      :breathing="breathing"
      side-text="B 方"
    />
  </header>
</template>
