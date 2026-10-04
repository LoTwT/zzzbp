<script setup lang="ts">
import { ref, watch } from "vue";
import { ImageOff } from "@lucide/vue";
import type { RoomAgentDisplay } from "../../room/room-catalog";

// 代理人头像：真实数据路径派生的远程图片（toAgentImageUrl）+ 加载失败与
// 缺路径时的占位后备。缺头像不改变代理人的身份、可用性或禁选结果，
// 名称始终由外层展示（docs/specs/room-layout.md「代理人头像」）。

const props = defineProps<{
  readonly agent: RoomAgentDisplay | null;
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
  <span class="relative block size-full overflow-hidden rounded-md bg-(--surface-subtle)">
    <img
      v-if="agent !== null && agent.avatarUrl !== null && !failed"
      :src="agent.avatarUrl"
      :alt="altName ?? `${agent.name}头像`"
      class="size-full object-cover"
      loading="lazy"
      decoding="async"
      @error="failed = true"
    />
    <span
      v-else
      class="flex size-full items-center justify-center text-neutral-400"
      :title="agent === null ? '' : agent.name"
    >
      <ImageOff v-if="agent !== null" class="size-2/5" aria-hidden="true" />
    </span>
  </span>
</template>
