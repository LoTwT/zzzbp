<script setup lang="ts">
import type { AgentPoolStatus } from "../../../shared/bp/agents";
import type { RoomAgentDisplay } from "../../room/room-catalog";
import AgentStatusAvatar from "./AgentStatusAvatar.vue";

// 代理人池卡片：头像网格单元，头像下方显示官方名称。状态视觉由共用
// AgentStatusAvatar 呈现（可选正常色彩；已禁用压暗 + 斜杠；已选用降饱和
// + 角落小勾）。禁用与选用不可点击、无悬停高亮；只有当前操作方在可
// 预选时可点击可选代理人的卡片。

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
  <!-- 头像宽度跟随网格单元格（auto-fill 列宽）放大，8.5rem 为尺寸上限：
       工作区超过上限宽度后多出的空间转为更多列数，不再继续放大头像。 -->
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
    <span class="relative mx-auto block aspect-square w-full max-w-[8.5rem]">
      <AgentStatusAvatar :agent="agent" :status="status" />
    </span>
    <span
      class="w-full truncate text-center text-xs text-neutral-700 xl:text-sm"
      :title="agent.fullName ?? agent.name"
      >{{ agent.name }}</span
    >
  </button>
</template>
