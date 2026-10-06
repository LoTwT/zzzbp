<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";
import { displayWebSocketPath } from "../../shared/contracts/http";
import type { AgentPoolStatus } from "../../shared/bp/agents";
import { computeAgentPoolStatuses } from "../../shared/bp/agents";
import type { DisplayView } from "../../shared/contracts/views";
import DisplayPool from "../components/room/DisplayPool.vue";
import PickColumn from "../components/room/PickColumn.vue";
import RoomHeader from "../components/room/RoomHeader.vue";
import { fetchRoomCatalog } from "../room/api";
import { DisplaySession } from "../room/display-session";
import type { RoomCatalogModel } from "../room/room-catalog";
import { toRoomCatalogModel } from "../room/room-catalog";
import {
  banSlotsOfView,
  EMPTY_BAN_SLOTS,
  EMPTY_PICK_COLUMNS,
  EMPTY_TEAM_LABELS,
  pickColumnsOfView,
  preselectAgentOf,
  teamLabelsOfView,
} from "../room/view-projections";

// 实时展示页（/rooms/:roomId/display）：匿名只读的直播采集画面
// （docs/specs/room-layout.md「实时展示页」与 room-roles.md「展示页访问」）。
// - 只连展示通道（display/ws），消费 displayView / notice；无任何命令入口、
//   不自动加入成员、不读取身份：浏览器 Cookie 即使被自动携带，展示通道
//   也一律忽略，页面不出现成员专属内容；
// - 布局固定九格竖排，与操作页一致；页面不解析布局查询参数，也不读写
//   本地布局偏好（旧链接上的多余参数被忽略）；
// - 目录经只读 /catalog 取房间固定快照（匿名读取，不派生成员 UI）；
// - 断线保留最后画面并停用动效，顶部以文字与图标提示重连状态；
// - ROOM_NOT_FOUND 按不存在收口（提供「创建新房间」）；ROOM_ARCHIVED
//   终止实时重试并保留原房间链接（只读记录页），不冒充不存在。

const route = useRoute();
const roomId = typeof route.params.roomId === "string" ? route.params.roomId : "";

/** 同源展示 WS 地址（浏览器 location；与成员通道同一构建方式）。 */
function displayWebSocketUrl(id: string): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${displayWebSocketPath(id)}`;
}

const session = new DisplaySession({ url: displayWebSocketUrl(roomId) });

/** 页面收口：not-found / archived 为终态，取代实时画面。 */
const phase = ref<"loading" | "not-found" | "archived">("loading");

watch(session.status, (status) => {
  if (status === "room-gone") phase.value = "not-found";
  else if (status === "archived") phase.value = "archived";
});

// ---- 目录快照：房间固定的 /catalog，匿名只读，不派生成员身份。 ----

const catalogModel = shallowRef<RoomCatalogModel | null>(null);
const catalogState = ref<"loading" | "error" | "ready">("loading");

async function loadCatalog(): Promise<void> {
  catalogState.value = "loading";
  const result = await fetchRoomCatalog(roomId);
  if (result.ok) {
    catalogModel.value = toRoomCatalogModel(result.value);
    catalogState.value = "ready";
    return;
  }
  if (result.reason === "not-found") {
    // 目录只对不存在的房间 404：房间已消失，实时展示同样按不存在收口。
    phase.value = "not-found";
    session.stop();
    return;
  }
  if (result.reason === "archived") {
    // 归档房间的目录随操作期数据清理（410）：按「已归档」收口，与展示
    // 通道的 ROOM_ARCHIVED 终态一致，不冒充不存在。
    phase.value = "archived";
    session.stop();
    return;
  }
  // 网络/服务端故障可重试：房间不一定不存在，不影响 WS 继续同步视图。
  catalogState.value = "error";
}

// ---- 生命周期 ----

onMounted(() => {
  session.connect();
  void loadCatalog();
});

onBeforeUnmount(() => {
  session.stop();
});

// ---- 视图与派生 ----

const view = computed<DisplayView | null>(() => session.view.value);
const connected = computed(() => session.status.value === "connected");

const BP_STATUS_TEXTS: Record<string, string> = {
  waiting: "待开始",
  running: "进行中",
  paused: "已暂停",
  completed: "已完成",
};

const bpStatusText = computed(() =>
  view.value === null ? "" : (BP_STATUS_TEXTS[view.value.bpStatus] ?? view.value.bpStatus),
);

const connectionText = computed<string | null>(() => {
  switch (session.status.value) {
    case "connecting":
      return "正在连接…";
    case "reconnecting":
      return "正在重连…";
    case "interrupted":
      return "连接中断";
    default:
      return null;
  }
});

/** 呼吸动效：同步正常且服务端 BP 状态为进行中；暂停/断线保留静态高亮。 */
const breathing = computed(
  () => connected.value && view.value !== null && view.value.bpStatus === "running",
);

const preselectAgent = computed(() =>
  view.value === null ? null : preselectAgentOf(view.value, catalogModel.value),
);

const EMPTY_STATUSES: ReadonlyMap<string, AgentPoolStatus> = new Map();

const poolStatuses = computed<ReadonlyMap<string, AgentPoolStatus>>(() => {
  if (view.value === null || catalogModel.value === null) return EMPTY_STATUSES;
  const catalog = { agentIds: catalogModel.value.entries.map((entry) => entry.id) };
  return computeAgentPoolStatuses(catalog, view.value.submissions);
});

const banSlots = computed(() =>
  view.value === null ? EMPTY_BAN_SLOTS : banSlotsOfView(view.value, catalogModel.value),
);

const teamLabels = computed(() =>
  view.value === null ? EMPTY_TEAM_LABELS : teamLabelsOfView(view.value),
);

const pickColumns = computed(() =>
  view.value === null ? EMPTY_PICK_COLUMNS : pickColumnsOfView(view.value, catalogModel.value),
);
</script>

<template>
  <!-- 房间不存在或已过期：与房间入口一致的不存在收口。 -->
  <main
    v-if="phase === 'not-found'"
    class="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-8 px-6"
  >
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
  </main>

  <!-- 房间已归档：终止实时重试，保留通向原房间记录的路径。 -->
  <main
    v-else-if="phase === 'archived'"
    class="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-8 px-6"
  >
    <div
      class="w-full max-w-sm rounded-xl border border-(--border-default) bg-(--surface-panel) p-8 text-center shadow-sm"
    >
      <p class="text-lg font-semibold text-(--text-primary)">房间已归档</p>
      <p class="mt-2 text-sm leading-6 text-(--text-muted)">
        实时展示已结束；本局结果保留在原房间的只读记录中。
      </p>
      <RouterLink
        :to="`/rooms/${roomId}`"
        class="mt-6 inline-block w-full rounded-lg bg-(--accent-primary) px-4 py-2.5 text-sm font-semibold text-(--accent-contrast) focus-ring hover:bg-(--accent-primary-hover) hover:text-(--accent-contrast-hover) active:bg-(--accent-primary-active) active:text-(--accent-contrast-active)"
      >
        查看房间记录
      </RouterLink>
    </div>
  </main>

  <!-- 实时画面：首个权威视图到达后渲染；断线保留最后画面。 -->
  <div v-else-if="view !== null" class="flex h-dvh min-h-0 flex-col overflow-hidden">
    <RoomHeader
      :room-name="view.roomName"
      :bp-status-text="bpStatusText"
      :connection-text="connectionText"
      :team-names="teamLabels"
      :ban-slots="banSlots"
      :preselect-agent="preselectAgent"
      :breathing="breathing"
      :connection-icon="true"
    />

    <!-- 展示页主体：两侧选用区与全量同屏代理人池；无搜索筛选、确认按钮
         与控制面板。p-2/gap-2 比操作页更紧凑，把空间让给中央网格。 -->
    <main class="grid min-h-0 flex-1 grid-cols-[7.5rem_1fr_7.5rem] items-stretch gap-2 p-2">
      <PickColumn
        :rows="pickColumns.A.rows"
        :preselect-agent="preselectAgent"
        :breathing="breathing"
        side-text="A 方"
      />

      <section
        class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-(--border-default) bg-(--surface-panel)"
        aria-label="代理人池"
      >
        <template v-if="catalogState === 'ready' && catalogModel !== null">
          <DisplayPool :entries="catalogModel.entries" :statuses="poolStatuses" />
        </template>
        <template v-else-if="catalogState === 'loading'">
          <div class="flex size-full items-center justify-center text-sm text-(--text-muted)">
            <p>正在加载代理人名单…</p>
          </div>
        </template>
        <template v-else>
          <div
            class="flex size-full flex-col items-center justify-center gap-2 text-sm text-(--text-muted)"
          >
            <p class="text-(--status-danger-fg)" role="alert">代理人名单加载失败</p>
            <button
              type="button"
              class="rounded-lg border border-(--border-default) px-3 py-1.5 text-xs font-medium focus-ring hover:bg-(--surface-subtle)"
              @click="loadCatalog"
            >
              重新加载
            </button>
          </div>
        </template>

        <!-- 连接层提示（服务端连接通知），随最新视图清除。 -->
        <p
          v-if="session.notice.value !== null"
          class="shrink-0 px-3 pb-1 text-center text-xs text-(--status-warning-fg)"
          role="status"
        >
          {{ session.notice.value }}
        </p>
      </section>

      <PickColumn
        :rows="pickColumns.B.rows"
        :preselect-agent="preselectAgent"
        :breathing="breathing"
        side-text="B 方"
      />
    </main>
  </div>

  <!-- 首个权威视图到达前的连接占位。 -->
  <main v-else class="mx-auto flex min-h-dvh flex-col items-center justify-center px-6">
    <p class="text-sm text-(--text-muted)">{{ connectionText ?? "正在连接展示…" }}</p>
  </main>
</template>
