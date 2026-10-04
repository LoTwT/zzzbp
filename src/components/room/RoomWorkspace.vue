<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { BpSlotId, BpTeam } from "../../../shared/bp/steps";
import { getBpStep } from "../../../shared/bp/steps";
import { computeAgentPoolStatuses, type AgentPoolStatus } from "../../../shared/bp/agents";
import { memberWebSocketPath } from "../../../shared/contracts/http";
import type { RoomMemberView } from "../../../shared/contracts/views";
import {
  EMPTY_AGENT_POOL_QUERY,
  filterAgentEntries,
  type AgentPoolQuery,
} from "../../../shared/agents/filter";
import { SlidersHorizontal } from "@lucide/vue";
import AgentCard from "./AgentCard.vue";
import AgentPoolToolbar from "./AgentPoolToolbar.vue";
import ControlPanel from "./ControlPanel.vue";
import PickColumn, { type PickSlotView } from "./PickColumn.vue";
import RoomHeader from "./RoomHeader.vue";
import { fetchRoomCatalog } from "../../room/api";
import type { RoomCatalogModel } from "../../room/room-catalog";
import { toRoomCatalogModel } from "../../room/room-catalog";
import {
  banStepsOfTeam,
  pickSlotRows,
  readPickLayoutPreference,
  writePickLayoutPreference,
  type PickLayout,
} from "../../room/pick-layout";
import { RoomSession } from "../../room/room-session";

// 房间工作区：顶部（两侧禁用区 + 赛事信息）与主体（两侧选用区 + 中央代理
// 人池）两层结构（docs/specs/room-layout.md「整体结构」，线框
// desktop-room-v4）。会话层管理 WS 连接与命令；本组件是展示与命令派发的
// 组合根。断线时保留最后确认画面、停用呼吸动效并禁用一切服务器操作。

const props = defineProps<{
  readonly roomId: string;
  readonly initialView: RoomMemberView;
}>();

const emit = defineEmits<{
  (event: "identity-lost"): void;
  (event: "room-gone"): void;
}>();

function memberWebSocketUrl(roomId: string): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${memberWebSocketPath(roomId)}`;
}

const session = new RoomSession({
  url: memberWebSocketUrl(props.roomId),
  initialView: props.initialView,
});

// ---- 目录快照：房间固定的 /catalog，不使用当前构建目录取代房间名单。 ----

const catalogModel = shallowRef<RoomCatalogModel | null>(null);
const catalogState = ref<"loading" | "error" | "ready">("loading");

async function loadCatalog(): Promise<void> {
  catalogState.value = "loading";
  const result = await fetchRoomCatalog(props.roomId);
  if (result.ok) {
    catalogModel.value = toRoomCatalogModel(result.value);
    catalogState.value = "ready";
  } else {
    catalogState.value = "error";
  }
}

// ---- 生命周期 ----

onMounted(() => {
  session.connect();
  void loadCatalog();
});

onBeforeUnmount(() => {
  session.stop();
});

watch(session.status, (status) => {
  if (status === "auth-failed") emit("identity-lost");
  if (status === "room-gone") emit("room-gone");
});

// ---- 视图与派生 ----

const view = computed(() => session.view.value);
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

/** 呼吸动效：进行中且连接正常；暂停/断线保留静态高亮。 */
const breathing = computed(
  () => connected.value && view.value !== null && view.value.bpStatus === "running",
);

const currentStep = computed(() => {
  if (view.value === null || view.value.currentSlotId === null) return null;
  return getBpStep(view.value.currentSlotId);
});

const isCurrentPlayerSide = computed(
  () =>
    view.value !== null &&
    currentStep.value !== null &&
    view.value.self.seatTeam === currentStep.value.team,
);

const preselectAgent = computed(() => {
  if (view.value === null || view.value.preselect === null || catalogModel.value === null) {
    return null;
  }
  return catalogModel.value.byId.get(view.value.preselect) ?? null;
});

const poolStatuses = computed<ReadonlyMap<string, AgentPoolStatus> | null>(() => {
  if (view.value === null || catalogModel.value === null) return null;
  const catalog = { agentIds: catalogModel.value.entries.map((entry) => entry.id) };
  return computeAgentPoolStatuses(catalog, view.value.submissions);
});

const submissionsBySlotId = computed(() => {
  const map = new Map<BpSlotId, string>();
  if (view.value !== null) {
    for (const submission of view.value.submissions) map.set(submission.slotId, submission.agentId);
  }
  return map;
});

function agentDisplayOf(agentId: string | undefined) {
  if (agentId === undefined || catalogModel.value === null) return null;
  return catalogModel.value.byId.get(agentId) ?? null;
}

const banSlots = computed(() => {
  const result = {} as Record<
    BpTeam,
    ReadonlyArray<{ slotId: BpSlotId; agent: ReturnType<typeof agentDisplayOf>; active: boolean }>
  >;
  for (const team of ["A", "B"] as const) {
    result[team] = banStepsOfTeam(team).map(({ slotId }) => ({
      slotId,
      agent: agentDisplayOf(submissionsBySlotId.value.get(slotId)),
      active: view.value !== null && view.value.currentSlotId === slotId,
    }));
  }
  return result;
});

// ---- 个人布局：A、B 两侧一起切换，切换只重排槽位。 ----

const pickLayout = ref<PickLayout>(readPickLayoutPreference());

watch(pickLayout, (layout) => {
  writePickLayoutPreference(layout);
});

const pickColumns = computed(() => {
  const result = {} as Record<
    BpTeam,
    { teamName: string; rows: ReadonlyArray<ReadonlyArray<PickSlotView>> }
  >;
  for (const team of ["A", "B"] as const) {
    const teamName = view.value?.teamNames[team] ?? "";
    const rows = pickSlotRows(team, pickLayout.value).map((row) =>
      row.map(({ slotId, step }) => ({
        slotId,
        step: { sideOrdinal: step.sideOrdinal },
        agent: agentDisplayOf(submissionsBySlotId.value.get(slotId)),
        active: view.value !== null && view.value.currentSlotId === slotId,
      })),
    );
    result[team] = { teamName: teamName === "" ? "待选择" : teamName, rows };
  }
  return result;
});

// ---- 代理人池筛选：仅选手（含兼任房主）可用，失去席位恢复完整列表。 ----

const isSeatedMember = computed(() => view.value !== null && view.value.self.seatTeam !== null);

const agentQuery = ref<AgentPoolQuery>({ ...EMPTY_AGENT_POOL_QUERY });

watch(isSeatedMember, (seated) => {
  if (!seated) {
    agentQuery.value = { ...EMPTY_AGENT_POOL_QUERY };
  }
});

const filteredEntries = computed(() => {
  if (catalogModel.value === null) return [];
  return filterAgentEntries(catalogModel.value.entries, agentQuery.value);
});

/** 列表容器：筛选变动回顶；预选/提交/轮次变化保留滚动。 */
const listEl = ref<HTMLElement | null>(null);

watch(
  () =>
    [agentQuery.value.name, agentQuery.value.elementIds, agentQuery.value.specialtyIds] as const,
  () => {
    void nextTick(() => {
      if (listEl.value !== null) listEl.value.scrollTop = 0;
    });
  },
);

// ---- 预选与提交 ----

const canPreselect = computed(
  () =>
    connected.value &&
    view.value !== null &&
    view.value.bpStatus === "running" &&
    isCurrentPlayerSide.value &&
    !session.isScopePending("setPreselect") &&
    poolStatuses.value !== null,
);

function sendPreselect(agentId: string): void {
  if (view.value === null || view.value.currentSlotId === null) return;
  if (view.value.preselect === agentId) return;
  session.sendCommand({ type: "setPreselect", slotId: view.value.currentSlotId, agentId });
}

const confirmVisible = computed(
  () => view.value !== null && currentStep.value !== null && isCurrentPlayerSide.value,
);

const confirmPending = computed(() => session.isScopePending("confirmPreselect"));

const confirmDisabled = computed(() => {
  if (view.value === null) return true;
  return (
    view.value.preselect === null ||
    view.value.bpStatus !== "running" ||
    !connected.value ||
    confirmPending.value
  );
});

const confirmLabel = computed(() => {
  if (currentStep.value === null) return "确认提交";
  return currentStep.value.action === "ban" ? "确认禁用" : "确认选用";
});

function sendConfirm(): void {
  if (view.value === null || view.value.currentSlotId === null) return;
  if (confirmDisabled.value) return;
  session.sendCommand({ type: "confirmPreselect", slotId: view.value.currentSlotId });
}

const confirmErrorText = computed(
  () =>
    session.scopeError("confirmPreselect")?.text ??
    session.scopeError("setPreselect")?.text ??
    null,
);

// ---- 控制面板 ----

const panelOpen = ref(false);
const panelEntryEl = ref<HTMLElement | null>(null);

function closePanel(): void {
  panelOpen.value = false;
  // 面板关闭后焦点回到入口，保持键盘操作连续。
  void nextTick(() => panelEntryEl.value?.focus());
}
</script>

<template>
  <div v-if="view !== null" class="flex h-dvh min-h-0 flex-col overflow-hidden">
    <RoomHeader
      :room-name="view.roomName"
      :bp-status-text="bpStatusText"
      :connection-text="connectionText"
      :ban-slots="banSlots"
      :preselect-agent="preselectAgent"
      :breathing="breathing"
    />

    <main class="grid min-h-0 flex-1 grid-cols-[7.5rem_1fr_7.5rem] items-stretch gap-3 p-3">
      <PickColumn
        :team-name="pickColumns.A.teamName"
        :rows="pickColumns.A.rows"
        :preselect-agent="preselectAgent"
        :breathing="breathing"
        side-text="A 方"
      />

      <!-- 中央代理人池：筛选栏与底部操作区固定，仅列表滚动；面板右侧覆盖。 -->
      <section
        class="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-(--border-default) bg-(--surface-panel)"
        aria-label="代理人池"
      >
        <AgentPoolToolbar
          v-if="isSeatedMember && catalogModel !== null"
          v-model="agentQuery"
          :elements="catalogModel.elements"
          :specialties="catalogModel.specialties"
        />

        <div
          ref="listEl"
          class="min-h-0 flex-1 overflow-y-auto px-2 py-3"
          :class="isSeatedMember ? '' : 'pt-2'"
        >
          <template v-if="catalogState !== 'ready'">
            <div
              class="flex size-full flex-col items-center justify-center gap-2 text-sm text-neutral-500"
            >
              <template v-if="catalogState === 'loading'">
                <p>正在加载代理人名单…</p>
              </template>
              <template v-else>
                <p class="text-danger-700" role="alert">代理人名单加载失败</p>
                <button
                  type="button"
                  class="rounded-lg border border-(--border-default) px-3 py-1.5 text-xs font-medium focus-ring hover:bg-(--surface-subtle)"
                  @click="loadCatalog"
                >
                  重新加载
                </button>
              </template>
            </div>
          </template>
          <template v-else-if="filteredEntries.length === 0">
            <p class="py-10 text-center text-sm text-neutral-500">没有符合搜索或筛选条件的代理人</p>
          </template>
          <template v-else>
            <ul
              class="mx-auto grid w-full max-w-4xl grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-1"
            >
              <li v-for="entry in filteredEntries" :key="entry.id">
                <AgentCard
                  :agent="entry"
                  :status="poolStatuses?.get(entry.id) ?? 'available'"
                  :selectable="canPreselect"
                  @preselect="sendPreselect"
                />
              </li>
            </ul>
          </template>
        </div>

        <!-- 连接层全局提示（服务端连接通知），随最新视图自动清除。 -->
        <p
          v-if="session.globalNotice.value !== null"
          class="shrink-0 px-3 pb-1 text-center text-xs text-amber-800"
          role="status"
        >
          {{ session.globalNotice.value }}
        </p>

        <!-- 底部操作区：确认按钮居中（仅当前操作方），控制面板入口固定右下。 -->
        <div class="relative shrink-0 border-t border-(--border-default) px-3 py-2.5">
          <p
            v-if="confirmVisible && confirmErrorText !== null"
            class="pb-1.5 text-center text-xs text-danger-700"
            role="alert"
          >
            {{ confirmErrorText }}
          </p>
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0 flex-1" aria-hidden="true" />
            <button
              v-if="confirmVisible"
              type="button"
              class="rounded-lg bg-lavender-600 px-10 py-2 text-sm font-semibold text-white focus-ring hover:bg-lavender-700 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="confirmDisabled"
              @click="sendConfirm"
            >
              {{ confirmPending ? "提交中…" : confirmLabel }}
            </button>
            <div v-else class="min-w-0 flex-1" aria-hidden="true" />
            <button
              ref="panelEntryEl"
              type="button"
              class="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium text-neutral-700 focus-ring hover:bg-(--surface-subtle)"
              aria-haspopup="dialog"
              @click="panelOpen = true"
            >
              <SlidersHorizontal class="size-4" aria-hidden="true" />
              控制面板
            </button>
          </div>
        </div>

        <!-- 控制面板：右侧覆盖中央区，不挤压网格。 -->
        <ControlPanel
          v-if="panelOpen"
          :session="session"
          :view="view"
          :catalog-model="catalogModel"
          :layout="pickLayout"
          :connected="connected"
          @close="closePanel"
          @update:layout="pickLayout = $event"
        />
      </section>

      <PickColumn
        :team-name="pickColumns.B.teamName"
        :rows="pickColumns.B.rows"
        :preselect-agent="preselectAgent"
        :breathing="breathing"
        side-text="B 方"
      />
    </main>
  </div>
</template>
