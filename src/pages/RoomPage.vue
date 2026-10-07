<script setup lang="ts">
import { onMounted, ref, shallowRef } from "vue";
import { useRoute } from "vue-router";
import type { ArchiveSnapshot } from "../../shared/contracts/records";
import type { RoomMemberView } from "../../shared/contracts/views";
import JoinRoomForm from "../components/room/JoinRoomForm.vue";
import RecordView from "../components/room/RecordView.vue";
import RoomWorkspace from "../components/room/RoomWorkspace.vue";
import { fetchRoomEntry } from "../room/api";
import { roomHistory, type RoomHistoryToken } from "../room/room-history";

// 房间入口（/rooms/:roomId）：按生命周期与身份分流。
// - 不存在/已过期（真正 404）：提示并提供「创建新房间」入口；
// - live + 有效身份（HttpOnly Cookie 自动携带）：直接恢复角色进入房间；
// - live + 匿名：首次入房表单；
// - archived：成功只读响应，同一套只读记录界面（原房主、成员与匿名
//   一致）；记录经普通 HTTP 快照读取，不建立成员/展示实时连接；
// - 会话内身份失效（AUTH_FAILED）：回到首次入房表单重新加入。
// 网络/服务端故障可重试，不误报「房间不存在」。
//
// 「最近参与」本机清单按服务端成功响应记录参与：有效身份恢复与以昵称
// 加入都算参与（含普通观众）；仅停留在昵称表单、匿名展示页与归档页都
// 不新增或更新记录（docs/specs/room-roles.md「本机参与记录」）。写入令牌在
// 动作发起时（入口读取、入房提交）捕获：请求在途期间记录被移除或清空则
// 放弃本次写入，不让迟到响应复活记录。

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

/** 入房请求发起时捕获的写入令牌：请求在途期间被移除/清空则放弃本次写入。 */
let joinParticipation: RoomHistoryToken | null = null;

async function loadEntry(): Promise<void> {
  phase.value = "loading";
  loadFailed.value = false;
  // 令牌在请求发起时捕获：请求在途期间记录被移除或清空，成功响应不再写入。
  const token = roomHistory.begin(roomId);
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
    if (result.value.memberView !== null) {
      // 主动打开活动房间并成功恢复有效身份：算一次参与。
      roomHistory.commit(token, { roomName: result.value.roomName });
    }
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

/** 提交入房前捕获令牌：请求在途期间记录被移除或清空，成功后不再写入。 */
function onJoining(): void {
  joinParticipation = roomHistory.begin(roomId);
}

function onJoined(view: RoomMemberView): void {
  memberView.value = view;
  roomName.value = view.roomName;
  joinNotice.value = null;
  // 以昵称成功加入（服务端成功响应）：算一次参与。令牌缺失说明本次加入没有
  // 经过提交（不应发生），此时不写入，避免把迟到响应当成新的参与。
  const token = joinParticipation;
  joinParticipation = null;
  if (token !== null) roomHistory.commit(token, { roomName: view.roomName });
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

function onJoinNotFound(): void {
  // 提交时房间已不存在（404，初始读取 live 之后的自然过期竞态）：
  // 与初始 404、WS ROOM_NOT_FOUND 一致，转统一不存在页（含创建入口）。
  memberView.value = null;
  phase.value = "not-found";
}

onMounted(loadEntry);
</script>

<template>
  <!-- 只读记录：所有访问者同一套界面，快照是唯一数据来源；全屏布局。 -->
  <RecordView v-if="phase === 'record' && snapshot !== null" :record="snapshot" />

  <!-- 实时房间工作区：独立的铺满布局（宽度/最小高度见 RoomWorkspace 根节点），
       不与首页/入房表单的居中单列容器共用布局基准。 -->
  <RoomWorkspace
    v-else-if="phase === 'room' && memberView !== null"
    :room-id="roomId"
    :initial-view="memberView"
    @identity-lost="onIdentityLost"
    @room-gone="onRoomGone"
    @room-archived="onRoomArchived"
  />

  <!-- 首页式居中单列容器：仅承载加载/不存在/首次入房表单这些窄内容状态。 -->
  <main
    v-else
    class="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-8 px-6"
  >
    <template v-if="phase === 'loading'">
      <p
        v-if="loadFailed"
        class="max-w-sm text-center text-sm text-(--status-danger-fg)"
        role="alert"
      >
        房间信息加载失败，请检查网络后重试。
        <button
          type="button"
          class="mt-3 block w-full rounded-lg border border-(--border-default) px-4 py-2 text-sm font-medium focus-ring hover:bg-(--surface-subtle)"
          @click="loadEntry"
        >
          重新加载
        </button>
      </p>
      <p v-else class="text-sm text-(--text-muted)">正在加载房间…</p>
    </template>

    <template v-else-if="phase === 'not-found'">
      <div
        class="w-full max-w-sm rounded-xl border border-(--border-default) bg-(--surface-panel) p-8 text-center shadow-sm"
      >
        <p class="text-lg font-semibold text-(--text-primary)">房间不存在或已过期</p>
        <RouterLink
          to="/"
          class="mt-6 inline-block w-full rounded-lg bg-(--accent-primary) px-4 py-2.5 text-sm font-semibold text-(--accent-contrast) focus-ring hover:bg-(--accent-primary-hover) hover:text-(--accent-contrast-hover) active:bg-(--accent-primary-active) active:text-(--accent-contrast-active)"
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
      @joining="onJoining"
      @joined="onJoined"
      @archived="onJoinArchived"
      @not-found="onJoinNotFound"
    />
  </main>
</template>
