<script setup lang="ts">
import { onMounted, ref } from "vue";
import { healthResponseSchema, type HealthResponse } from "../../shared/api";

// 工程引导占位页：通过 /api/health 验证前端到 Worker 与房间存储的
// 完整链路，业务界面（建房、入房、BP）在后续 PR 中实现。
const health = ref<HealthResponse | null>(null);
const healthError = ref<string | null>(null);

onMounted(async () => {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health.value = healthResponseSchema.parse(await response.json());
  } catch (error) {
    healthError.value = error instanceof Error ? error.message : String(error);
  }
});
</script>

<template>
  <main
    class="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-6 px-6 text-center"
  >
    <h1 class="text-3xl font-semibold tracking-tight">zzzbp</h1>
    <p class="text-neutral-700">绝区零 BP 房间 · 工程引导页</p>
    <p v-if="health" class="text-sm text-mint-700">
      Worker 与房间存储正常 · 房间记录时间 {{ health.room.createdAt }}
    </p>
    <p v-else-if="healthError" class="text-sm text-danger-700">
      服务状态获取失败：{{ healthError }}
    </p>
    <p v-else class="text-sm text-neutral-500">正在连接本地 Worker…</p>
  </main>
</template>
