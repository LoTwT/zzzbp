<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { computeAgentPoolStatuses, type AgentPoolStatus } from "../../../shared/bp/agents";
import { memberWebSocketPath } from "../../../shared/contracts/http";
import type { RoomMemberView } from "../../../shared/contracts/views";
import {
  EMPTY_AGENT_POOL_QUERY,
  filterAgentEntries,
  type AgentPoolQuery,
} from "../../../shared/agents/filter";
import type { AgentClassification } from "../../../shared/agents/schema";
import { SlidersHorizontal } from "@lucide/vue";
import AgentCard from "./AgentCard.vue";
import AgentPoolToolbar from "./AgentPoolToolbar.vue";
import ControlPanel from "./ControlPanel.vue";
import PickColumn from "./PickColumn.vue";
import RoomHeader from "./RoomHeader.vue";
import { fetchRoomCatalog } from "../../room/api";
import type { RoomCatalogModel } from "../../room/room-catalog";
import { toRoomCatalogModel } from "../../room/room-catalog";
import {
  banSlotsOfView,
  currentStepOf,
  EMPTY_BAN_SLOTS,
  EMPTY_PICK_COLUMNS,
  EMPTY_TEAM_LABELS,
  pickColumnsOfView,
  preselectAgentOf,
  teamLabelsOfView,
} from "../../room/view-projections";
import { RoomSession } from "../../room/room-session";
import { IDENTITY_CHANGED } from "../../room/command-errors";
import { memberIdentityText } from "../../room/member-identity";
import { pendingOperationText } from "../../room/operation-feedback";

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
  (event: "room-archived"): void;
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
  // 归档不是消失：沿原房间链接转入只读记录读取。
  if (status === "room-archived") emit("room-archived");
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

const currentStep = computed(() => currentStepOf(view.value));

const isCurrentPlayerSide = computed(
  () =>
    view.value !== null &&
    currentStep.value !== null &&
    view.value.self.seatTeam === currentStep.value.team,
);

const preselectAgent = computed(() =>
  view.value === null ? null : preselectAgentOf(view.value, catalogModel.value),
);

const poolStatuses = computed<ReadonlyMap<string, AgentPoolStatus> | null>(() => {
  if (view.value === null || catalogModel.value === null) return null;
  const catalog = { agentIds: catalogModel.value.entries.map((entry) => entry.id) };
  return computeAgentPoolStatuses(catalog, view.value.submissions);
});

// 禁用/选用槽位、队伍标识与空席队名占位规则由 view-projections 统一
// 派生（与实时展示页共用同一份投影语义）；视图未到达时以空投影占位。
const banSlots = computed(() =>
  view.value === null ? EMPTY_BAN_SLOTS : banSlotsOfView(view.value, catalogModel.value),
);

const teamLabels = computed(() =>
  view.value === null ? EMPTY_TEAM_LABELS : teamLabelsOfView(view.value),
);

// ---- 选用区：九格竖排（个人布局设置已取消，各页面统一）。 ----

const pickColumns = computed(() =>
  view.value === null ? EMPTY_PICK_COLUMNS : pickColumnsOfView(view.value, catalogModel.value),
);

// ---- 代理人池筛选：仅选手（含兼任房主）可用，失去席位恢复完整列表。 ----

const isSeatedMember = computed(() => view.value !== null && view.value.self.seatTeam !== null);

/** 目录未就绪时工具栏的分类占位：不渲染分类按钮，仅保留搜索与清除入口。 */
const EMPTY_CLASSIFICATIONS: readonly AgentClassification[] = [];

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

/**
 * 当前操作位的挂起互斥：预选与确认任一在途时，两者入口都锁定，避免基于
 * 旧视图发出注定过期/越权的额外命令（服务端仍会拒绝，但那不是期望路径）。
 * 挂起解除（回执或换连接后的视图核对）后按最新权威状态恢复。
 */
const slotOperationPending = computed(
  () => session.isScopePending("setPreselect") || session.isScopePending("confirmPreselect"),
);

const canPreselect = computed(
  () =>
    connected.value &&
    view.value !== null &&
    view.value.bpStatus === "running" &&
    isCurrentPlayerSide.value &&
    !slotOperationPending.value &&
    poolStatuses.value !== null,
);

function sendPreselect(agentId: string): void {
  if (view.value === null || view.value.currentSlotId === null) return;
  if (slotOperationPending.value) return;
  if (view.value.preselect === agentId) return;
  session.sendCommand({ type: "setPreselect", slotId: view.value.currentSlotId, agentId });
}

const confirmVisible = computed(
  () => view.value !== null && currentStep.value !== null && isCurrentPlayerSide.value,
);

const confirmDisabled = computed(() => {
  if (view.value === null) return true;
  return (
    view.value.preselect === null ||
    view.value.bpStatus !== "running" ||
    !connected.value ||
    slotOperationPending.value
  );
});

const confirmLabel = computed(() => {
  if (slotOperationPending.value) {
    // 预选/确认任一在途或待核对：首发显示「提交中…」，结果未知（回执
    // 超时或断线）显示「正在核对结果…」，禁止同操作盲目重复。
    return session.isScopeChecking("confirmPreselect") || session.isScopeChecking("setPreselect")
      ? "正在核对结果…"
      : "提交中…";
  }
  if (currentStep.value === null) return "确认提交";
  return currentStep.value.action === "ban" ? "确认禁用" : "确认选用";
});

/**
 * 挂起操作反馈：与确认按钮可见性解耦。
 *
 * 操作位轮到对方、BP 完成或本成员被换下后，确认按钮按角色规则消失，
 * 但已发出的命令仍可能处于提交中或「结果未知、正在核对」阶段——
 * 此时在底栏显示紧凑的持久提示；确认按钮仍可见时由按钮标签展示
 * 同一状态，不重复提示。
 */
const slotOperationFeedbackText = computed(() => {
  if (!slotOperationPending.value || confirmVisible.value) return null;
  const checking =
    session.isScopeChecking("confirmPreselect") ||
    session.isScopeChecking("setPreselect") ||
    session.isScopeChecking("clearPreselect");
  return pendingOperationText(true, checking);
});

function sendConfirm(): void {
  if (view.value === null || view.value.currentSlotId === null) return;
  if (confirmDisabled.value) return;
  session.sendCommand({ type: "confirmPreselect", slotId: view.value.currentSlotId });
}

const confirmErrorText = computed(() => {
  // 身份变化结论由底栏的通用身份提示统一展示（同一结论不重复两行）。
  // 过滤只丢弃该结论本身，不跳过其后的候选：旧 confirm 的身份结论仍在
  // 保留期时，后续预选的新错误（如并发选择被拒）仍按既有优先级在
  // 操作区可见。
  const candidates = [session.scopeError("confirmPreselect"), session.scopeError("setPreselect")];
  for (const error of candidates) {
    if (error !== null && error.code !== IDENTITY_CHANGED) return error.text;
  }
  return null;
});

// ---- 控制面板 ----

const panelOpen = ref(false);
const panelEntryEl = ref<HTMLElement | null>(null);

function closePanel(): void {
  panelOpen.value = false;
  // 面板关闭后焦点回到入口，保持键盘操作连续。
  void nextTick(() => panelEntryEl.value?.focus());
}

/** 入口按钮：再次点击收起面板（外部点击不会误判入口，由面板自身处理）。 */
function togglePanel(): void {
  if (panelOpen.value) closePanel();
  else panelOpen.value = true;
}

/** 本人身份提示：昵称 + 当前身份，随服务端最新视图更新（含换人）。 */
const selfIdentityText = computed(() =>
  view.value === null ? "" : memberIdentityText(view.value.self),
);
</script>

<template>
  <!--
    工作区基准（docs/specs/room-layout.md「设备支持范围」）：
    - 宽度：占满浏览器内容区，最大 1920px（120rem）并左右居中；最小 1024px
      （64rem）——窄于最小宽度时保持 1024px，由整页横向滚动兜底，不压缩布局；
    - 高度：确定为「可用内容区高度与 768px 的较大值」——达到 768px 时撑满
      视口且页面不滚动，低于 768px 时保持 768px 由整页纵向滚动兜底（高度
      必须是确定值：不定高度会让主体 flex-basis 回退为内容尺寸，把工作区
      撑高）；
    - 内部各区域自行约束溢出（中央列表与两侧选用列内滚动），根节点不再
      裁剪，保证低于最小宽度/最小高度时整页滚动可达。
    room-workspace 挂载密度变量（见 src/assets/main.css）。
  -->
  <div
    v-if="view !== null"
    class="room-workspace mx-auto flex h-[max(100dvh,48rem)] w-full max-w-[120rem] min-w-[64rem] flex-col"
  >
    <RoomHeader
      :room-name="view.roomName"
      :bp-status-text="bpStatusText"
      :connection-text="connectionText"
      :team-names="teamLabels"
      :ban-slots="banSlots"
      :preselect-agent="preselectAgent"
      :breathing="breathing"
    />

    <main
      class="grid min-h-0 flex-1 grid-cols-[var(--room-side-col,7.5rem)_1fr_var(--room-side-col,7.5rem)] grid-rows-[minmax(0,1fr)] items-stretch gap-3 p-3"
    >
      <PickColumn
        :rows="pickColumns.A.rows"
        :preselect-agent="preselectAgent"
        :breathing="breathing"
        side-text="A 方"
      />

      <!-- 中央代理人池：筛选栏与底部操作区固定，仅列表滚动；面板覆盖池区右侧，不遮底部操作区。 -->
      <section
        class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-(--border-default) bg-(--surface-panel)"
        aria-label="代理人池"
      >
        <!-- 池区（筛选栏 + 滚动列表）：控制面板的覆盖范围限制在此区域内。 -->
        <div class="relative flex min-h-0 flex-1 flex-col">
          <!--
            工具栏按权限渲染（目录未就绪也预留：搜索框常驻，分类按钮随目录
            出现），保持加载前后池区框架高度稳定；分类列表为空时仅显示
            搜索框与两个清除入口。
          -->
          <AgentPoolToolbar
            v-if="isSeatedMember"
            v-model="agentQuery"
            :elements="catalogModel?.elements ?? EMPTY_CLASSIFICATIONS"
            :specialties="catalogModel?.specialties ?? EMPTY_CLASSIFICATIONS"
          />

          <div
            ref="listEl"
            class="min-h-0 flex-1 overflow-y-auto px-2 py-3"
            :class="isSeatedMember ? '' : 'pt-2'"
          >
            <template v-if="catalogState !== 'ready'">
              <div
                class="flex size-full flex-col items-center justify-center gap-2 text-sm text-(--text-muted)"
              >
                <template v-if="catalogState === 'loading'">
                  <p>正在加载代理人名单…</p>
                </template>
                <template v-else>
                  <p class="text-(--status-danger-fg)" role="alert">代理人名单加载失败</p>
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
              <p class="py-10 text-center text-sm text-(--text-muted)">
                没有符合搜索或筛选条件的代理人
              </p>
            </template>
            <template v-else>
              <!-- 单元格宽度下限随工作区宽度分档（--room-pool-cell），列数
                   由可用宽度自动推导；头像尺寸随单元格放大并设上限。 -->
              <ul
                class="mx-auto grid w-full grid-cols-[repeat(auto-fill,minmax(var(--room-pool-cell,4.5rem),1fr))] gap-1.5"
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

          <!-- 控制面板：覆盖池区右侧，不挤压网格、不遮底部操作区。 -->
          <ControlPanel
            v-if="panelOpen"
            :session="session"
            :view="view"
            :catalog-model="catalogModel"
            :connected="connected"
            :room-id="roomId"
            @close="closePanel"
          />
        </div>

        <!-- 连接层全局提示（服务端连接通知），随最新视图自动清除。 -->
        <p
          v-if="session.globalNotice.value !== null"
          class="shrink-0 px-3 pb-1 text-center text-xs text-(--status-warning-fg)"
          role="status"
        >
          {{ session.globalNotice.value }}
        </p>

        <!--
          底部操作区（固定，不被面板覆盖）：确认按钮相对整个池区几何居中，
          控制面板入口固定右下，二者始终可见可达；左侧为本人身份常驻提示
          （昵称 + 当前身份，长昵称截断，不遮挡中央确认按钮与右侧入口）。
        -->
        <div class="shrink-0 border-t border-(--border-default) px-3 py-2.5">
          <!-- 挂起操作提示：与确认按钮可见性解耦（轮到对方/完成/被换下仍可见）。 -->
          <p
            v-if="slotOperationFeedbackText !== null"
            class="pb-1.5 text-center text-xs text-(--status-warning-fg)"
            role="status"
          >
            {{ slotOperationFeedbackText }}
          </p>
          <!-- 通用身份提示：旧身份挂起命令被放弃时的结论（可能来自新身份
               不可见的房主面板操作），任何角色可见，不随视图推进清掉。 -->
          <p
            v-if="session.identityNotice.value !== null"
            class="pb-1.5 text-center text-xs text-(--status-warning-fg)"
            role="status"
          >
            {{ session.identityNotice.value }}
          </p>
          <!-- 操作错误提示：不再要求当前持有确认入口；旧命令收敛为
               「结果未知」时，即使已非当前操作方也要可见（身份变化结论
               由上方通用提示展示，不重复）。 -->
          <p
            v-if="confirmErrorText !== null"
            class="pb-1.5 text-center text-xs text-(--status-danger-fg)"
            role="alert"
          >
            {{ confirmErrorText }}
          </p>
          <div class="relative flex min-h-10 items-center gap-3">
            <p
              class="max-w-[calc(50%-6rem)] min-w-0 truncate text-xs text-(--text-muted)"
              :title="selfIdentityText"
              aria-live="polite"
            >
              {{ selfIdentityText }}
            </p>
            <button
              v-if="confirmVisible"
              type="button"
              class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-(--accent-primary) px-10 py-2 text-sm font-semibold text-(--accent-contrast) focus-ring hover:bg-(--accent-primary-hover) hover:text-(--accent-contrast-hover) active:bg-(--accent-primary-active) active:text-(--accent-contrast-active) disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="confirmDisabled"
              @click="sendConfirm"
            >
              {{ confirmLabel }}
            </button>
            <button
              ref="panelEntryEl"
              type="button"
              class="relative ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium text-(--text-secondary) focus-ring hover:bg-(--surface-subtle)"
              aria-haspopup="dialog"
              data-panel-entry
              @click="togglePanel"
            >
              <SlidersHorizontal class="size-4" aria-hidden="true" />
              控制面板
            </button>
          </div>
        </div>
      </section>

      <PickColumn
        :rows="pickColumns.B.rows"
        :preselect-agent="preselectAgent"
        :breathing="breathing"
        side-text="B 方"
      />
    </main>
  </div>
</template>
