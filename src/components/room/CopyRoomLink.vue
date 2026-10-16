<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from "vue";
import { Link2 } from "@lucide/vue";
import { copyTextToClipboard, isUserFocusTarget } from "../../room/clipboard";

// 实时与归档面板共用；面板关闭即卸载，迟到的剪贴板结果不能抢新页面焦点。
const busy = ref(false);
const copied = ref(false);
const fallbackLink = ref<string | null>(null);
const fallbackInput = ref<HTMLInputElement | null>(null);
let disposed = false;
let resetTimer: ReturnType<typeof setTimeout> | null = null;

onBeforeUnmount(() => {
  disposed = true;
  if (resetTimer !== null) clearTimeout(resetTimer);
});

async function copyRoomLink(event: MouseEvent): Promise<void> {
  if (busy.value || disposed) return;
  const link = window.location.href;
  const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  busy.value = true;
  copied.value = false;
  fallbackLink.value = null;
  if (resetTimer !== null) clearTimeout(resetTimer);
  const outcome = await copyTextToClipboard(link, () => disposed);
  busy.value = false;
  if (disposed) return;
  if (!outcome.copied) {
    fallbackLink.value = link;
    await nextTick();
    if (!disposed) fallbackInput.value?.focus();
    return;
  }
  copied.value = true;
  resetTimer = setTimeout(() => {
    copied.value = false;
    resetTimer = null;
  }, 2000);
  // 旧复制路径会打断焦点；等按钮重新启用后恢复，不抢走用户等待期间选的新目标。
  await nextTick();
  if (disposed) return;
  const active = document.activeElement;
  if (
    active === null ||
    active === document.body ||
    (active instanceof HTMLElement && !isUserFocusTarget(active))
  ) {
    const target = outcome.focusTarget ?? trigger;
    if (target?.isConnected) target.focus();
  }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <button
      type="button"
      class="flex items-center gap-2 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium focus-ring enabled:hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="busy"
      @click="copyRoomLink"
    >
      <Link2 class="size-4 text-(--text-muted)" aria-hidden="true" />
      {{ busy ? "正在复制链接…" : copied ? "已复制" : "复制房间链接" }}
    </button>
    <template v-if="fallbackLink !== null">
      <p class="text-xs text-(--status-danger-fg)" role="alert">复制失败，请手动复制下方链接</p>
      <input
        ref="fallbackInput"
        :value="fallbackLink"
        readonly
        aria-label="房间链接"
        class="w-full min-w-0 rounded-lg border border-(--border-default) bg-(--surface-elevated) p-2 text-xs text-(--text-secondary) focus-ring"
        @focus="($event.target as HTMLInputElement).select()"
      />
    </template>
  </div>
</template>
