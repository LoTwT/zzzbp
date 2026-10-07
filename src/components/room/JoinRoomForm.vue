<script setup lang="ts">
import { computed, ref } from "vue";
import type { RoomMemberView } from "../../../shared/contracts/views";
import { validateNickname } from "../../lib/form-validation";
import { joinRoom, type RoomHttpFailure } from "../../room/api";

// 首次入房表单（docs/specs/room-layout.md「首页与首次入房」，线框
// desktop-join-v1）：当前房间名只读展示，填写昵称后以观众身份进入。

const props = defineProps<{
  readonly roomId: string;
  readonly roomName: string;
  /** 回到入房表单的原因提示（如原身份失效）；无则为 null。 */
  readonly notice?: string | null;
}>();

const emit = defineEmits<{
  /**
   * 提交通过校验、入房请求即将发出：父级据此捕获「最近参与」写入令牌，
   * 使请求在途期间发生的移除/清空能作废本次写入。
   */
  (event: "joining"): void;
  (event: "joined", view: RoomMemberView): void;
  /**
   * 入房请求进行中房间被归档（410 ROOM_ARCHIVED）：父级沿原链接转入
   * 只读记录读取，本表单不再以「不存在」误导。
   */
  (event: "archived"): void;
  /**
   * 提交时房间已不存在（404，含提交瞬间到期清理的自然竞态）：转入
   * 统一不存在页（「不存在或已过期」+「创建新房间」），与本页初始
   * 404 和 WS ROOM_NOT_FOUND 的收口一致；失效的入房表单退出。
   */
  (event: "not-found"): void;
}>();

const nickname = ref("");
const nicknameError = ref<string | null>(null);
const formError = ref<string | null>(null);
const submitting = ref(false);

const canSubmit = computed(() => !submitting.value && nickname.value.trim() !== "");

const FAILURE_TEXTS: Record<RoomHttpFailure, string> = {
  // not-found 不在表单内提示：房间已消失，转统一不存在页（emit not-found）。
  "not-found": "房间不存在或已过期",
  archived: "房间已归档，正在转至只读记录…",
  invalid: "提交内容不合法，请检查后重试",
  server: "服务器暂时不可用，请稍后重试",
  network: "网络异常，进入失败，请重试",
};

async function submit(): Promise<void> {
  if (submitting.value) return;
  nicknameError.value = validateNickname(nickname.value);
  formError.value = null;
  if (nicknameError.value !== null) return;
  submitting.value = true;
  emit("joining");
  const result = await joinRoom(props.roomId, nickname.value);
  submitting.value = false;
  if (result.ok) {
    emit("joined", result.value.memberView);
    return;
  }
  if (result.reason === "archived") {
    // 归档房间不需要也无法加入成员：转由父级读取只读记录。
    emit("archived");
    return;
  }
  if (result.reason === "not-found") {
    // 提交时房间已被清理（初始读取 live 之后的自然过期竞态）：转统一
    // 不存在页，保留「创建新房间」出口。
    emit("not-found");
    return;
  }
  formError.value = FAILURE_TEXTS[result.reason];
}
</script>

<template>
  <main class="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-10 px-6">
    <div class="text-center">
      <h1 class="text-3xl font-semibold tracking-tight">绝区零 BP</h1>
      <p class="mt-2 text-base text-(--text-muted)">危局强袭战</p>
    </div>

    <form
      class="w-full max-w-sm rounded-xl border border-(--border-default) bg-(--surface-panel) p-8 shadow-sm"
      novalidate
      @submit.prevent="submit"
    >
      <h2 class="text-center text-xl font-semibold">进入房间</h2>

      <p
        v-if="props.notice !== null && props.notice !== undefined"
        class="mt-4 rounded-lg bg-(--status-warning-bg) px-3 py-2 text-center text-xs leading-5 text-(--status-warning-fg)"
        role="status"
      >
        {{ props.notice }}
      </p>

      <p class="mt-4 text-center text-lg font-medium break-all text-(--text-primary)">
        {{ roomName }}
      </p>
      <p class="mt-1 text-center text-xs text-(--text-muted)">进入后为观众，选手由房主安排。</p>

      <div class="mt-6 flex flex-col gap-5">
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium text-(--text-secondary)" for="join-nickname"
            >你的昵称</label
          >
          <input
            id="join-nickname"
            v-model="nickname"
            class="w-full rounded-lg border border-(--border-default) bg-(--surface-elevated) px-3 py-2 text-sm focus-ring"
            :aria-invalid="nicknameError !== null"
            :aria-describedby="nicknameError !== null ? 'join-nickname-error' : undefined"
            type="text"
            name="nickname"
            autocomplete="off"
          />
          <p
            v-if="nicknameError !== null"
            id="join-nickname-error"
            class="text-xs text-(--status-danger-fg)"
          >
            {{ nicknameError }}
          </p>
        </div>

        <button
          type="submit"
          class="w-full rounded-lg bg-(--accent-primary) px-4 py-2.5 text-sm font-semibold text-(--accent-contrast) focus-ring hover:bg-(--accent-primary-hover) hover:text-(--accent-contrast-hover) active:bg-(--accent-primary-active) active:text-(--accent-contrast-active) disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canSubmit"
        >
          {{ submitting ? "进入中…" : "进入房间" }}
        </button>

        <p v-if="formError !== null" class="text-sm text-(--status-danger-fg)" role="alert">
          {{ formError }}
        </p>
      </div>
    </form>
  </main>
</template>
