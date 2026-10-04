<script setup lang="ts">
import type { AgentPoolStatus } from "../../../shared/bp/agents";
import {
  AVATAR_NAME_GAP_PX,
  CARD_PAD_PX,
  NAME_FONT_PX,
  NAME_LINE_PX,
} from "../../room/display-grid";
import type { RoomAgentDisplay } from "../../room/room-catalog";
import AgentStatusAvatar from "./AgentStatusAvatar.vue";

// 展示页代理人卡片：直播采集画面的非交互网格单元（无预选入口、无悬停
// 高亮）。头像尺寸与文字规格由 display-grid 的排布常量给定（尺寸预算
// 与渲染规格同源），名称直接显示在头像下：排布保证单行宽度，极端容器
// 下换行，绝不以截断省略号代替可读性。状态视觉与房间卡片共用
// AgentStatusAvatar。title 只是桌面浏览器的补充提示，直播画面的识别
// 不依赖悬停。

defineProps<{
  readonly agent: RoomAgentDisplay;
  readonly status: AgentPoolStatus;
  /** 头像边长（px），来自 display-grid 的排布结果。 */
  readonly avatarSize: number;
}>();
</script>

<template>
  <li
    class="flex min-w-0 flex-col items-center"
    :style="{ gap: `${AVATAR_NAME_GAP_PX}px`, padding: `${CARD_PAD_PX}px` }"
    :aria-label="`${agent.name}${status === 'banned' ? '（已禁用）' : status === 'picked' ? '（已选用）' : ''}`"
  >
    <span class="block shrink-0" :style="{ width: `${avatarSize}px`, height: `${avatarSize}px` }">
      <AgentStatusAvatar :agent="agent" :status="status" />
    </span>
    <span
      class="w-full text-center break-words text-neutral-700"
      :style="{ fontSize: `${NAME_FONT_PX}px`, lineHeight: `${NAME_LINE_PX}px` }"
      :title="agent.fullName ?? agent.name"
      >{{ agent.name }}</span
    >
  </li>
</template>
