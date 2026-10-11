<script setup lang="ts">
import { computed } from "vue";
import { Check } from "@lucide/vue";
import type { AgentPoolStatus } from "../../../shared/bp/agents";
import type { AgentDisplayBase } from "../../room/room-catalog";
import AgentAvatar from "./AgentAvatar.vue";

// 代理人图片与状态视觉的共用展示单元：三种视觉状态（可选正常色彩；
// 已禁用压暗 + 明显斜杠；已选用降饱和 + 角落小勾）的唯一实现，房间
// 卡片与展示页卡片共用，保证两个场景的禁选视觉一致
// （docs/specs/room-layout.md「代理人池状态展示」）。占满父级给定的
// 尺寸，具体大小由外层决定。斜杠裁切随素材形状：方图沿卡片圆角覆盖，
// 旧圆图仍按圆形轮廓裁切（素材透明角之外不延伸）。

const props = withDefaults(
  defineProps<{
    readonly agent: AgentDisplayBase;
    readonly status: AgentPoolStatus;
    /** 图片用途透传（见 AgentAvatar）；记录页行缩略用 thumb。 */
    readonly variant?: "master" | "thumb" | "wide";
  }>(),
  { variant: "master" },
);

/** 禁用斜杠的裁切轮廓：方图用圆角（贴合卡片），圆图/外部图片用圆形。 */
const slashClipClass = computed(() =>
  props.agent.image?.kind === "square" ? "rounded-md" : "rounded-full",
);
</script>

<template>
  <span
    class="relative block size-full rounded-md"
    :class="
      status === 'banned'
        ? 'opacity-60 grayscale'
        : status === 'picked'
          ? 'opacity-80 saturate-50'
          : ''
    "
  >
    <AgentAvatar :agent="agent" :variant="variant" />
    <!-- 已禁用：明显斜杠覆盖，裁切轮廓随素材形状（方图圆角/圆图圆形），
         保证斜杠贴合图片本身。 -->
    <span
      v-if="status === 'banned'"
      class="absolute inset-0 overflow-hidden"
      :class="slashClipClass"
      aria-hidden="true"
    >
      <svg class="absolute inset-0 size-full text-(--text-secondary)" viewBox="0 0 56 56">
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
    </span>
    <!-- 已选用：角落小勾选图标（仅提交成功后出现）。 -->
    <span
      v-if="status === 'picked'"
      class="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-(--status-success) text-(--text-inverse)"
      aria-hidden="true"
    >
      <Check class="size-3" />
    </span>
  </span>
</template>
