<script setup lang="ts">
import { ref, watch } from "vue";
import { ImageOff } from "@lucide/vue";
import type { AgentDisplayBase } from "../../room/room-catalog";

// 代理人头像：真实数据路径派生的远程图片（toAgentImageUrl）+ 加载失败与
// 缺路径时的占位后备。缺头像不改变代理人的身份、可用性或禁选结果，
// 名称始终由外层展示（docs/specs/room-layout.md「代理人头像」）。
// 头像正常展示时不绘制方形底板：按素材原比例呈现（上游为圆形头像，
// 透明角保留），不裁切放大伪造其他形状；缺路径/加载失败时以与素材
// 协调的圆形占位兜底。展示按最小信息声明依赖（AgentDisplayBase）：
// 实时房间目录与归档快照（归档时固定的名称与头像）共用同一实现。

const props = defineProps<{
  readonly agent: AgentDisplayBase | null;
  /** 无障碍名称前缀，与外层展示文案组合。 */
  readonly altName?: string;
}>();

const failed = ref(false);

watch(
  () => props.agent?.id ?? null,
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <span class="relative block size-full">
    <img
      v-if="agent !== null && agent.avatarUrl !== null && !failed"
      :src="agent.avatarUrl"
      :alt="altName ?? `${agent.name}头像`"
      class="size-full object-cover"
      loading="lazy"
      decoding="async"
      @error="failed = true"
    />
    <!-- 缺路径/加载失败：圆形占位（与素材的圆形轮廓协调），名称仍由外层展示。 -->
    <span
      v-else
      class="flex size-full items-center justify-center rounded-full bg-(--surface-subtle) text-neutral-400"
      :title="agent === null ? '' : agent.name"
    >
      <ImageOff v-if="agent !== null" class="size-2/5" aria-hidden="true" />
    </span>
  </span>
</template>
