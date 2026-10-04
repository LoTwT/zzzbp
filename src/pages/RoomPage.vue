<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import type { RoomMemberView } from "../../shared/contracts/views";
import JoinRoomForm from "../components/room/JoinRoomForm.vue";
import RoomWorkspace from "../components/room/RoomWorkspace.vue";
import { fetchRoomEntry } from "../room/api";

// 房间入口（/rooms/:roomId）：按生命周期与身份分流。
// - 不存在/已过期：提示并提供「创建新房间」入口；
// - live + 有效身份（HttpOnly Cookie 自动携带）：直接恢复角色进入房间；
// - live + 匿名：首次入房表单；
// - 会话内身份失效（AUTH_FAILED）：回到首次入房表单重新加入。
// 归档房间在 PR9 前没有只读记录页，按不可进入提示。

type Phase = "loading" | "not-found" | "join" | "room";

const route = useRoute();
const roomId = typeof route.params.roomId === "string" ? route.params.roomId : "";

const phase = ref<Phase>("loading");
const roomName = ref<string>("");
const memberView = ref<RoomMemberView | null>(null);
const loadFailed = ref(false);

async function loadEntry(): Promise<void> {
  phase.value = "loading";
  loadFailed.value = false;
  const result = await fetchRoomEntry(roomId);
  if (result.ok) {
    roomName.value = result.value.roomName;
    memberView.value = result.value.memberView;
    phase.value = result.value.memberView === null ? "join" : "room";
    return;
  }
  if (result.reason === "network" || result.reason === "server") {
    // 网络/服务端故障可重试：房间不一定不存在，保留重新加载入口。
    loadFailed.value = true;
    phase.value = "loading";
    return;
  }
  phase.value = "not-found";
}

function onJoined(view: RoomMemberView): void {
  memberView.value = view;
  roomName.value = view.roomName;
  phase.value = "room";
}

function onIdentityLost(): void {
  // Cookie 身份被服务端拒绝：按新成员重新走首次入房。
  memberView.value = null;
  phase.value = "join";
}

function onRoomGone(): void {
  memberView.value = null;
  phase.value = "not-found";
}

onMounted(loadEntry);
</script>

<template>
  <main class="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-8 px-6">
    <template v-if="phase === 'loading'">
      <p v-if="loadFailed" class="max-w-sm text-center text-sm text-danger-700" role="alert">
        房间信息加载失败，请检查网络后重试。
        <button
          type="button"
          class="mt-3 block w-full rounded-lg border border-(--border-default) px-4 py-2 text-sm font-medium focus-ring hover:bg-(--surface-subtle)"
          @click="loadEntry"
        >
          重新加载
        </button>
      </p>
      <p v-else class="text-sm text-neutral-500">正在加载房间…</p>
    </template>

    <template v-else-if="phase === 'not-found'">
      <div
        class="w-full max-w-sm rounded-xl border border-(--border-default) bg-(--surface-panel) p-8 text-center shadow-sm"
      >
        <p class="text-lg font-semibold text-neutral-900">房间不存在或已过期</p>
        <RouterLink
          to="/"
          class="mt-6 inline-block w-full rounded-lg bg-lavender-600 px-4 py-2.5 text-sm font-semibold text-white focus-ring hover:bg-lavender-700"
        >
          创建新房间
        </RouterLink>
      </div>
    </template>

    <JoinRoomForm
      v-else-if="phase === 'join'"
      :room-id="roomId"
      :room-name="roomName"
      @joined="onJoined"
    />

    <RoomWorkspace
      v-else-if="phase === 'room' && memberView !== null"
      :room-id="roomId"
      :initial-view="memberView"
      @identity-lost="onIdentityLost"
      @room-gone="onRoomGone"
    />
  </main>
</template>
