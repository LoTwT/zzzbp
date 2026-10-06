<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { validateNickname, validateRoomName } from "../lib/form-validation";
import { createRoom, type RoomHttpFailure } from "../room/api";

// 首页：居中单列的建房表单（docs/specs/room-layout.md「首页与首次入房」，
// 线框 desktop-home-v1）。创建成功直接进入房间，创建者成为房主；
// 提交失败在表单附近提示并保留已填写内容。

const router = useRouter();

const roomName = ref("");
const nickname = ref("");
const roomNameError = ref<string | null>(null);
const nicknameError = ref<string | null>(null);
const formError = ref<string | null>(null);
const submitting = ref(false);

const canSubmit = computed(
  () => !submitting.value && roomName.value.trim() !== "" && nickname.value.trim() !== "",
);

const FAILURE_TEXTS: Record<RoomHttpFailure, string> = {
  "not-found": "房间不存在或已过期",
  archived: "房间不存在或已过期",
  invalid: "提交内容不合法，请检查后重试",
  server: "服务器暂时不可用，请稍后重试",
  network: "网络异常，创建失败，请重试",
};

async function submit(): Promise<void> {
  if (submitting.value) return;
  roomNameError.value = validateRoomName(roomName.value);
  nicknameError.value = validateNickname(nickname.value);
  formError.value = null;
  if (roomNameError.value !== null || nicknameError.value !== null) return;
  submitting.value = true;
  const result = await createRoom({ roomName: roomName.value, nickname: nickname.value });
  submitting.value = false;
  if (result.ok) {
    await router.push({ name: "room", params: { roomId: result.value.roomId } });
    return;
  }
  formError.value = FAILURE_TEXTS[result.reason];
}
</script>

<template>
  <main class="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-10 px-6">
    <div class="text-center">
      <h1 class="text-4xl font-semibold tracking-tight">绝区零 BP</h1>
      <p class="mt-2 text-lg text-(--text-muted)">危局强袭战</p>
    </div>

    <form
      class="w-full max-w-sm rounded-xl border border-(--border-default) bg-(--surface-panel) p-8 shadow-sm"
      novalidate
      @submit.prevent="submit"
    >
      <h2 class="text-center text-xl font-semibold">创建房间</h2>

      <div class="mt-6 flex flex-col gap-5">
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium text-(--text-secondary)" for="home-room-name"
            >房间名（赛事名）</label
          >
          <input
            id="home-room-name"
            v-model="roomName"
            class="w-full rounded-lg border border-(--border-default) bg-(--surface-elevated) px-3 py-2 text-sm focus-ring"
            :aria-invalid="roomNameError !== null"
            :aria-describedby="roomNameError !== null ? 'home-room-name-error' : undefined"
            type="text"
            name="roomName"
            autocomplete="off"
            placeholder=""
          />
          <p
            v-if="roomNameError !== null"
            id="home-room-name-error"
            class="text-xs text-(--status-danger-fg)"
          >
            {{ roomNameError }}
          </p>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium text-(--text-secondary)" for="home-nickname"
            >你的昵称</label
          >
          <input
            id="home-nickname"
            v-model="nickname"
            class="w-full rounded-lg border border-(--border-default) bg-(--surface-elevated) px-3 py-2 text-sm focus-ring"
            :aria-invalid="nicknameError !== null"
            :aria-describedby="nicknameError !== null ? 'home-nickname-error' : undefined"
            type="text"
            name="nickname"
            autocomplete="off"
          />
          <p
            v-if="nicknameError !== null"
            id="home-nickname-error"
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
          {{ submitting ? "创建中…" : "创建房间" }}
        </button>

        <p v-if="formError !== null" class="text-sm text-(--status-danger-fg)" role="alert">
          {{ formError }}
        </p>
      </div>
    </form>
  </main>
</template>
