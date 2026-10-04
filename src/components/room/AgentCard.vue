<script setup lang="ts">
import { Check } from "@lucide/vue";
import type { AgentPoolStatus } from "../../../shared/bp/agents";
import type { RoomAgentDisplay } from "../../room/room-catalog";
import AgentAvatar from "./AgentAvatar.vue";

// 代理人池卡片：头像网格单元，头像下方显示官方名称。三种视觉状态：
// 可选正常色彩；已禁用压暗 + 斜杠；已选用降饱和 + 角落小勾。禁用与选用
// 不可点击、无悬停高亮；只有当前操作方在可预选时可点击可选代理人的卡片。

const props = defineProps<{
  readonly agent: RoomAgentDisplay;
  readonly status: AgentPoolStatus;
  /** 是否允许预选操作（当前操作方、进行中、连接正常且无挂起命令）。 */
  readonly selectable: boolean;
}>();

const emit = defineEmits<{
  (event: "preselect", agentId: string): void;
}>();

function onClick(): void {
  if (props.status !== "available" || !props.selectable) return;
  emit("preselect", props.agent.id);
}
</script>

<template>
  <button
    type="button"
    class="group relative flex w-full flex-col items-center gap-1 rounded-lg p-1.5 focus-ring-inset"
    :class="
      status === 'available' && selectable
        ? 'cursor-pointer hover:bg-(--surface-subtle)'
        : 'cursor-default'
    "
    :disabled="status !== 'available' || !selectable"
    :aria-label="`${agent.name}${status === 'banned' ? '（已禁用）' : status === 'picked' ? '（已选用）' : ''}`"
    @click="onClick"
  >
    <span
      class="relative block size-14 rounded-md"
      :class="
        status === 'banned'
          ? 'opacity-60 grayscale'
          : status === 'picked'
            ? 'opacity-80 saturate-50'
            : ''
      "
    >
      <AgentAvatar :agent="agent" />
      <!-- 已禁用：明显斜杠覆盖。 -->
      <svg
        v-if="status === 'banned'"
        class="absolute inset-0 size-full text-neutral-700"
        viewBox="0 0 56 56"
        aria-hidden="true"
      >
        <line
          x1="6"
          y1="50"
          x2="50"
          y2="6"
          stroke="currentColor"
          stroke-width="3"
          stroke-linecap="round"
        />
      </svg>
      <!-- 已选用：角落小勾选图标（仅提交成功后出现）。 -->
      <span
        v-if="status === 'picked'"
        class="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-mint-600 text-white"
        aria-hidden="true"
      >
        <Check class="size-3" />
      </span>
    </span>
    <span
      class="w-full truncate text-center text-xs text-neutral-700"
      :title="agent.fullName ?? agent.name"
      >{{ agent.name }}</span
    >
  </button>
</template>
