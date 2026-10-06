<script setup lang="ts">
import { useRoute } from "vue-router";

const route = useRoute();
</script>

<template>
  <main
    class="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-4 px-6 text-center"
  >
    <h1 class="text-2xl font-semibold tracking-tight">页面尚未实现</h1>
    <p class="text-(--text-secondary)">路径 {{ route.path }} 对应的界面在后续版本提供。</p>
    <RouterLink to="/" class="text-(--text-accent) underline">返回首页</RouterLink>
  </main>
</template>
