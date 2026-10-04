<script setup lang="ts">
import { onMounted, ref, shallowRef } from "vue";
import { useRoute } from "vue-router";
import type { ArchiveSnapshot } from "../../shared/contracts/records";
import type { RoomMemberView } from "../../shared/contracts/views";
import JoinRoomForm from "../components/room/JoinRoomForm.vue";
import RecordView from "../components/room/RecordView.vue";
import RoomWorkspace from "../components/room/RoomWorkspace.vue";
import { fetchRoomEntry } from "../room/api";

// 房间入口（/rooms/:roomId）：按生命周期与身份分流。
// - 不存在/已过期（真正 404）：提示并提供「创建新房间」入口；
// - live + 有效身份（HttpOnly Cookie 自动携带）：直接恢复角色进入房间；
// - live + 匿名：首次入房表单；
// - archived：成功只读响应，同一套只读记录界面（原房主、成员与匿名
//   一致）；记录经普通 HTTP 快照读取，不建立成员/展示实时连接；
// - 会话内身份失效（AUTH_FAILED）：回到首次入房表单重新加入。
// 网络/服务端故障可重试，不误报「房间不存在」。

type Phase = "loading" | "not-found" | "join" | "room" | "record";

const route = useRoute();
const roomId = typeof route.params.roomId === "string" ? route.params.roomId : "";

const phase = ref<Phase>("loading");
const roomName = ref<string>("");
const memberView = ref<RoomMemberView | null>(null);
const snapshot = shallowRef<ArchiveSnapshot | null>(null);
const loadFailed = ref(false);
/** 回到首次入房时的原因提示（如 WS AUTH_FAILED：原身份已失效）。 */
const joinNotice = ref<string | null>(null);

async function loadEntry(): Promise<void> {
  phase.value = "loading";
  loadFailed.value = false;
  const result = await fetchRoomEntry(roomId);
  if (result.ok) {
    if (result.value.kind === "archived") {
      snapshot.value = result.value.record;
      memberView.value = null;
      phase.value = "record";
      return;
    }
    snapshot.value = null;
    roomName.value = result.value.roomName;
    memberView.value = result.value.memberView;
    phase.value = result.value.memberView === null ? "join" : "room";
    return;
  }
  if (result.reason === "network" || result.reason === "server") {
    // 网络/服务端故障可重试：房间不一定不存在（含归档房间读取失败），
    // 保留重新加载入口，不误报「不存在或已过期」。
    loadFailed.value = true;
    phase.value = "loading";
    return;
  }
  phase.value = "not-found";
}

function onJoined(view: RoomMemberView): void {
  memberView.value = view;
  roomName.value = view.roomName;
  joinNotice.value = null;
  phase.value = "room";
}

function onIdentityLost(): void {
  // Cookie 身份被服务端拒绝：按新成员重新走首次入房；旧身份的席位与
  // 挂起操作不恢复，昵称相同也不会认回原身份（服务端按凭据判断）。
  memberView.value = null;
  joinNotice.value = "原身份已失效，请重新填写昵称进入房间。";
  phase.value = "join";
}

function onRoomGone(): void {
  memberView.value = null;
  phase.value = "not-found";
}

function onRoomArchived(): void {
  // 入房后或重连时房间被归档：沿原链接转入只读记录读取，不回到表单
  // 或不存在页；记录内容以服务端快照为准。
  memberView.value = null;
  void loadEntry();
}

function onJoinArchived(): void {
  // 入房请求进行中房间被归档（410）：同样转记录读取。
  memberView.value = null;
  void loadEntry();
}

onMounted(loadEntry);
</script>

<template>
  <!-- 只读记录：所有访问者同一套界面，快照是唯一数据来源；全屏布局。 -->
  <RecordView v-if="phase === 'record' && snapshot !== null" :record="snapshot" />

  <main
    v-else
    class="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-8 px-6"
  >
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
      :notice="joinNotice"
      @joined="onJoined"
      @archived="onJoinArchived"
    />

    <RoomWorkspace
      v-else-if="phase === 'room' && memberView !== null"
      :room-id="roomId"
      :initial-view="memberView"
      @identity-lost="onIdentityLost"
      @room-gone="onRoomGone"
      @room-archived="onRoomArchived"
    />
  </main>
</template>
