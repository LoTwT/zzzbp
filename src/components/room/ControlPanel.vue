<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useClipboard } from "@vueuse/core";
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  Link2,
  RotateCcw,
  Undo2,
  Users,
  X,
} from "@lucide/vue";
import type { BpTeam } from "../../../shared/bp/steps";
import type { HostManagementView, ManagedMember } from "../../../shared/contracts/views";
import { validateTeamName } from "../../lib/form-validation";
import type { RoomSession } from "../../room/room-session";
import { isHostManagementView, type RoomView } from "../../room/room-session";
import type { RoomCatalogModel } from "../../room/room-catalog";
import { TeamNameDraft } from "../../room/team-name-draft";
import { pendingOperationText } from "../../room/operation-feedback";
import { usePanelDismiss } from "../../room/panel-dismiss";
import { displayPagePath } from "../../room/display-url";
import {
  memberRoleText,
  otherMemberRows,
  seatSelectionRows,
  sideLabel,
  startBlockers,
  undoTargetDescription,
} from "../../room/host-panels";

// 控制面板：池内右下入口打开，右侧覆盖中央代理人池区域，不压缩网格、
// 不遮顶部与双方禁选区（docs/specs/room-layout.md「控制面板」，线框
// desktop-host-panel-v3 / desktop-host-members-v2 / 更换选手 v3）。
// 按角色展示内容：显示与分享为公共分组；比赛控制与队伍与成员仅房主。
// 面板内子视图：主面板、其他成员、席位选择（待开始分配与暂停换人共用）。
// 主面板固定面板标题与底部的「显示与分享」动作区（打开展示页与复制房间
// 链接始终完整可见），只有「比赛控制」与「队伍与成员」两组在标题与底栏
// 之间的剩余区域内滚动（docs/specs/room-layout.md「控制面板」）。
// 成员与换人子列表的固定区各自不同（同上「成员列表与换人」）：「其他成员」
// 固定返回/关闭、列头与底部「共 N 人」栏，只有名单在列头与人数栏之间滚动；
// 席位选择固定返回/关闭、目标队伍与当前选手、列头与列表底部说明，只有名单
// 在剩余区域内滚动，不展示人数。换人列表按成员加入顺序以 memberId 认人，
// 换人成功后各行保持原位，仅原位更新角色、按钮与顶部当前选手。

const props = defineProps<{
  readonly session: RoomSession;
  readonly view: RoomView;
  readonly catalogModel: RoomCatalogModel | null;
  readonly connected: boolean;
  /** 当前房间 ID：构建展示页链接使用。 */
  readonly roomId: string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
}>();

type Subview = "main" | "members" | "seat";

/** 列表行/列头共用网格：圆点 + 昵称 + 角色 + 状态（+ 操作）。 */
const MEMBER_GRID_CLASS = "grid grid-cols-[auto_minmax(0,1fr)_4rem_2rem] items-center gap-2";
const SEAT_GRID_CLASS = "grid grid-cols-[auto_minmax(0,1fr)_4rem_2rem_4.5rem] items-center gap-2";
/**
 * 队伍与成员共用网格：左侧可见标签 + 输入/选手信息 + 右侧操作。
 * 队名与选手两行同列，输入、信息和操作按同一右边界对齐。标签列收到
 * 4rem（「左方队名」四字完整），操作列固定 5rem（容纳「更换选手」并让
 * 保存/选择/更换三个按钮同宽），输入与选手信息取得剩余宽度。
 */
const TEAM_MEMBER_GRID_CLASS = "grid grid-cols-[4rem_minmax(0,1fr)_5rem] items-center gap-2";
/** 标签列之后的缩进（4rem 标签列 + 0.5rem 列间距）：错误与提示与输入列左对齐。 */
const TEAM_MEMBER_INDENT_CLASS = "pl-18";
/**
 * 队伍与成员四行的左侧字段标签：与输入内容同为 14px、20px 行高、单行
 * 不折行；四字 14px 约 56px，在 4rem 标签列内完整展示。
 */
const TEAM_MEMBER_LABEL_CLASS = "text-sm font-medium whitespace-nowrap text-(--text-secondary)";
/**
 * 队名行与选手行的控件统一 36px 高：输入框 h-9（含边框）与操作按钮 h-9
 * 同高，按钮文字用 flex 垂直居中，因此不再依赖各自的内边距。
 */
const TEAM_MEMBER_CONTROL_CLASS = "h-9";
/** 操作按钮与输入内容同字号（text-sm），字重沿用 font-medium。 */
const TEAM_MEMBER_ACTION_CLASS =
  "flex h-9 w-full items-center justify-center rounded-lg border border-(--border-default) px-2 text-center text-sm font-medium focus-ring hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-50";

const subview = ref<Subview>("main");
const seatTeam = ref<BpTeam>("A");
const restartConfirming = ref(false);
/** 各队正在提交/核对的「设为选手」目标成员；结算后清空。 */
const pendingSeatMemberId = reactive<{ A: string | null; B: string | null }>({
  A: null,
  B: null,
});
const teamNameErrors = reactive<{ A: string | null; B: string | null }>({ A: null, B: null });
/**
 * 队名草稿：编辑代次 + 提交快照的状态机（见 src/room/team-name-draft.ts）。
 * 未编辑时跟随外部改名；保存中继续编辑、无关广播、失败回执都不覆盖草稿；
 * 成功仅收敛与该次提交对应且未被后续编辑替代的草稿（含 trim 规范化）。
 * 结算以会话的权威结论为准：明确失败、结果未知、身份失效/会话终止都
 * 不算成功，草稿保持待保存，不会卡在「保存中」。
 */
const teamDrafts = reactive<{ A: TeamNameDraft; B: TeamNameDraft }>({
  A: new TeamNameDraft(props.view.teamNames.A),
  B: new TeamNameDraft(props.view.teamNames.B),
});

const isHost = computed(() => isHostManagementView(props.view));
const hostView = computed(() => (isHostManagementView(props.view) ? props.view : null));
const { copy, copied } = useClipboard({ legacy: true });

// 面板根元素：打开时聚焦，返回焦点由父组件管理。
const rootEl = ref<HTMLElement | null>(null);

// 外部点击关闭（面板或入口之外按下时收起整个面板）：首次外部点击只
// 收起面板，不触发底层的代理人预选/确认；入口按钮由标记属性识别，
// 开关语义保留给入口自身（见 src/room/panel-dismiss.ts）。
usePanelDismiss({
  panel: () => rootEl.value,
  close: () => emit("close"),
});

onMounted(() => {
  rootEl.value?.focus();
  // Esc 全局生效（打开期间）：子视图先返回主面板，主面板关闭整个面板。
  // 面板是非模态覆盖层，焦点可能停留在面板之外，不能只监听面板内部。
  window.addEventListener("keydown", onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeydown);
});

// 重开成功（回到待开始）后收起二次确认框。
watch(
  () => props.view.bpStatus,
  (status) => {
    if (status === "waiting") restartConfirming.value = false;
  },
);

/** 某方现任选手（房主视图）；空席为 null。 */
function seatedMemberOf(view: HostManagementView, team: BpTeam): ManagedMember | null {
  return view.members.find((member) => member.seatTeam === team) ?? null;
}

// 队名草稿与权威值同步（未编辑时跟随；编辑后由状态机自行保留）。
watch(
  () => [props.view.teamNames.A, props.view.teamNames.B] as const,
  ([nextA, nextB]) => {
    teamDrafts.A.setAuthority(nextA);
    teamDrafts.B.setAuthority(nextB);
  },
);

/** 会话是否已进入终态：终态下挂起命令的消失不代表保存成功。 */
function sessionTerminated(): boolean {
  const status = props.session.status.value;
  return status === "auth-failed" || status === "room-gone" || status === "stopped";
}

// 保存结算：同 scope 命令得到权威结论（pending 消失）时按有无 scope 错误
// 判定成败；身份失效/会话终止不算成功。未发起过保存时状态机自动忽略。
for (const team of ["A", "B"] as const) {
  const scope = `setTeamName:${team}`;
  watch(
    () => props.session.isScopePending(scope),
    (pending, previous) => {
      if (previous && !pending) {
        teamDrafts[team].settleSave({
          ok: props.session.scopeError(scope) === null && !sessionTerminated(),
        });
      }
    },
  );
}

const panelTitle = computed(() => {
  switch (subview.value) {
    case "members":
      return "其他成员";
    case "seat":
      return "更换选手";
    default:
      return "控制面板";
  }
});

const blockers = computed(() => (hostView.value === null ? [] : startBlockers(hostView.value)));

const undoDescription = computed(() => {
  if (hostView.value === null) return null;
  return undoTargetDescription(
    hostView.value,
    (agentId) => props.catalogModel?.byId.get(agentId)?.name ?? "未知代理人",
  );
});

// ---- 席位选择列表：稳定行 + 资格收口 ----

/**
 * 本列表会话内已展示过的成员：资格消失（如离线）后保留原行并禁用按钮，
 * 避免待处理期间行闪烁消失；重新进入子列表时重置。
 */
const seatRetainedIds = ref<ReadonlySet<string>>(new Set());

const seatRows = computed(() => {
  if (hostView.value === null) return [];
  return seatSelectionRows(hostView.value, seatTeam.value, seatRetainedIds.value);
});

// 行集只增不减：新出现的行固定保留（含后续离线的原行），位置不重排。
watch(seatRows, (rows) => {
  const next = new Set(seatRetainedIds.value);
  let changed = false;
  for (const row of rows) {
    if (!next.has(row.member.memberId)) {
      next.add(row.member.memberId);
      changed = true;
    }
  }
  if (changed) seatRetainedIds.value = next;
});

/** 目标队现任选手（空席为 null），固定展示在列表上方。 */
const currentSeatedMember = computed(
  () => hostView.value?.members.find((member) => member.seatTeam === seatTeam.value) ?? null,
);

/** 服务端允许调整席位的两个状态；进行中/已完成时入口收口为禁用。 */
const seatChangeAllowed = computed(() => {
  const status = hostView.value?.bpStatus;
  return status === "waiting" || status === "paused";
});

const seatChangeForbiddenHint = computed(() => {
  switch (hostView.value?.bpStatus) {
    case "running":
      return "BP 进行中，暂停后可更换选手";
    case "completed":
      return "BP 已完成，不可更换选手";
    default:
      return null;
  }
});

/**
 * 席位指派的隐藏挂起反馈：目标行成为「当前选手」或不在列表中时，
 * 行内按钮不再展示提交中/核对中标签，改由列表固定区提示（行内按钮
 * 仍展示标签时无需重复）。
 */
const seatAssignFeedbackText = computed(() => {
  const scope = `assignSeat:${seatTeam.value}`;
  const memberId = pendingSeatMemberId[seatTeam.value];
  if (memberId === null || !props.session.isScopePending(scope)) return null;
  const row = seatRows.value.find((entry) => entry.member.memberId === memberId);
  if (row !== undefined && !row.isCurrent) return null;
  return pendingOperationText(true, props.session.isScopeChecking(scope));
});

/**
 * 比赛控制的隐藏挂起反馈：开始/暂停/继续按钮按状态互斥渲染，命令
 * 生效后按钮切换（如开始成功后显示「暂停 BP」），原命令的提交中/
 * 核对中状态不再由按钮展示，改由本提示承接。
 */
const controlFeedbackText = computed(() => {
  const statusButtons: ReadonlyArray<readonly [RoomView["bpStatus"], string]> = [
    ["waiting", "startBp"],
    ["running", "pauseBp"],
    ["paused", "resumeBp"],
  ];
  for (const [status, scope] of statusButtons) {
    if (props.view.bpStatus !== status && props.session.isScopePending(scope)) {
      return pendingOperationText(true, props.session.isScopeChecking(scope));
    }
  }
  return null;
});

// 「设为选手」按钮级 pending：命令结算（或核对收敛）后清空。
for (const team of ["A", "B"] as const) {
  watch(
    () => props.session.isScopePending(`assignSeat:${team}`),
    (pending) => {
      if (!pending) pendingSeatMemberId[team] = null;
    },
  );
}

const otherRows = computed(() => (hostView.value === null ? [] : otherMemberRows(hostView.value)));

const seatTargetLabel = computed(() => {
  if (hostView.value === null) return "";
  const name = hostView.value.teamNames[seatTeam.value];
  return name === "" ? sideLabel(seatTeam.value) : name;
});

function openSeat(team: BpTeam): void {
  seatTeam.value = team;
  // 重新进入子列表：保留集合按本次列表会话重新累计。
  seatRetainedIds.value = new Set();
  subview.value = "seat";
}

function backToMain(): void {
  subview.value = "main";
}

/** Esc 处理：子视图返回主面板，主面板关闭整个面板（挂在 window 上）。 */
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (subview.value === "main") emit("close");
  else subview.value = "main";
}

/**
 * 展示页链接：新标签页打开并保留原操作页，noopener 防止展示页反向操作
 * 原页。选用区固定九格竖排，链接不再携带布局参数。
 */
const displayHref = computed(() => displayPagePath(props.roomId));

async function copyRoomLink(): Promise<void> {
  await copy(window.location.href);
}

function commandButtonState(
  scope: string,
  extraDisabled: boolean,
): { readonly disabled: boolean; readonly pending: boolean } {
  return {
    disabled: extraDisabled || !props.connected || props.session.isScopePending(scope),
    pending: props.session.isScopePending(scope),
  };
}

/**
 * 挂起命令的按钮文案：核对中统一显示「核对中…」，首发显示各自的
 * 进行中文案，其余显示常规文案。
 */
function commandLabel(scope: string, pendingText: string, normalText: string): string {
  if (props.session.isScopeChecking(scope)) return "核对中…";
  return props.session.isScopePending(scope) ? pendingText : normalText;
}

function scopeErrorText(scope: string): string | null {
  return props.session.scopeError(scope)?.text ?? null;
}

function saveTeamName(team: BpTeam): void {
  const error = validateTeamName(teamDrafts[team].draft);
  teamNameErrors[team] = error;
  if (error !== null) return;
  // 登记提交快照（trim 规范化值）；发送被会话拒绝时撤销登记，草稿保持待保存。
  const submitted = teamDrafts[team].beginSave();
  if (submitted === null) return;
  const result = props.session.sendCommand({ type: "setTeamName", team, teamName: submitted });
  if (!result.sent) {
    teamDrafts[team].abortSave();
  }
}

function onTeamNameInput(team: BpTeam, value: string): void {
  teamDrafts[team].edit(value);
  teamNameErrors[team] = null;
  props.session.clearScopeError(`setTeamName:${team}`);
}

function assignSeat(team: BpTeam, memberId: string): void {
  if (pendingSeatMemberId[team] !== null) return;
  const result = props.session.sendCommand({
    type: "assignSeat",
    team,
    targetMemberId: memberId,
  });
  // 直接提交、无统一确认；不乐观假成功，行内容待权威视图原位更新。
  if (result.sent) pendingSeatMemberId[team] = memberId;
}

function seatRowButtonText(team: BpTeam, memberId: string): string {
  const scope = `assignSeat:${team}`;
  if (props.session.isScopePending(scope) && pendingSeatMemberId[team] === memberId) {
    return props.session.isScopeChecking(scope) ? "核对中…" : "提交中…";
  }
  return "设为选手";
}
</script>

<template>
  <aside
    ref="rootEl"
    class="absolute inset-y-0 right-0 z-20 flex w-88 max-w-full flex-col border-l border-(--border-default) bg-(--surface-panel) shadow-xl"
    role="dialog"
    aria-label="控制面板"
    tabindex="-1"
  >
    <!-- 顶部固定：子视图提供返回入口；只有列表内容滚动。 -->
    <header
      class="flex shrink-0 items-center justify-between gap-2 border-b border-(--border-default) px-4 py-3"
    >
      <div class="flex min-w-0 items-center gap-2">
        <button
          v-if="subview !== 'main'"
          type="button"
          class="flex items-center gap-1 rounded px-1.5 py-1 text-sm text-(--text-muted) focus-ring hover:text-(--text-primary)"
          @click="backToMain"
        >
          <ArrowLeft class="size-4" aria-hidden="true" />
          返回
        </button>
        <h2 class="truncate text-base font-semibold text-(--text-primary)">{{ panelTitle }}</h2>
      </div>
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded text-(--text-muted) focus-ring hover:text-(--text-primary)"
        aria-label="关闭控制面板"
        @click="emit('close')"
      >
        <X class="size-4" aria-hidden="true" />
      </button>
    </header>

    <!-- 主面板：标题固定；比赛控制与队伍成员在中间区域滚动；
         「显示与分享」固定在面板底部，按钮不随内容滚动被裁切。 -->
    <div v-if="subview === 'main'" class="flex min-h-0 flex-1 flex-col">
      <div
        v-if="isHost && hostView !== null"
        class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4"
      >
        <!-- 比赛控制（仅房主） -->
        <section
          v-if="isHost && hostView !== null"
          class="flex flex-col gap-2"
          aria-label="比赛控制"
        >
          <h3 class="text-xs font-semibold tracking-wide text-(--text-muted)">比赛控制</h3>

          <template v-if="hostView.bpStatus === 'waiting'">
            <button
              type="button"
              class="rounded-lg bg-(--accent-primary) px-3 py-2 text-sm font-semibold text-(--accent-contrast) focus-ring hover:bg-(--accent-primary-hover) hover:text-(--accent-contrast-hover) active:bg-(--accent-primary-active) active:text-(--accent-contrast-active) disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="commandButtonState('startBp', blockers.length > 0).disabled"
              @click="session.sendCommand({ type: 'startBp' })"
            >
              {{ commandLabel("startBp", "开始中…", "开始 BP") }}
            </button>
            <ul
              v-if="blockers.length > 0"
              class="flex flex-col gap-0.5 text-xs text-(--text-muted)"
            >
              <li v-for="blocker in blockers" :key="blocker">· {{ blocker }}</li>
            </ul>
          </template>
          <button
            v-else-if="hostView.bpStatus === 'running'"
            type="button"
            class="rounded-lg bg-(--accent-primary) px-3 py-2 text-sm font-semibold text-(--accent-contrast) focus-ring hover:bg-(--accent-primary-hover) hover:text-(--accent-contrast-hover) active:bg-(--accent-primary-active) active:text-(--accent-contrast-active) disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="commandButtonState('pauseBp', false).disabled"
            @click="session.sendCommand({ type: 'pauseBp' })"
          >
            {{ commandLabel("pauseBp", "暂停中…", "暂停 BP") }}
          </button>
          <button
            v-else-if="hostView.bpStatus === 'paused'"
            type="button"
            class="rounded-lg bg-(--accent-primary) px-3 py-2 text-sm font-semibold text-(--accent-contrast) focus-ring hover:bg-(--accent-primary-hover) hover:text-(--accent-contrast-hover) active:bg-(--accent-primary-active) active:text-(--accent-contrast-active) disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="commandButtonState('resumeBp', false).disabled"
            @click="session.sendCommand({ type: 'resumeBp' })"
          >
            {{ commandLabel("resumeBp", "继续中…", "继续 BP") }}
          </button>
          <p
            v-if="
              scopeErrorText('startBp') ?? scopeErrorText('pauseBp') ?? scopeErrorText('resumeBp')
            "
            class="text-xs text-(--status-danger-fg)"
            role="alert"
          >
            {{
              scopeErrorText("startBp") ?? scopeErrorText("pauseBp") ?? scopeErrorText("resumeBp")
            }}
          </p>
          <!-- 按钮因状态切换消失时，原命令的挂起/核对状态由此提示承接。 -->
          <p
            v-if="controlFeedbackText !== null"
            class="text-xs text-(--status-warning-fg)"
            role="status"
          >
            {{ controlFeedbackText }}
          </p>

          <div class="flex flex-col gap-1">
            <button
              type="button"
              class="flex items-center justify-center gap-1.5 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium focus-ring hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="commandButtonState('undoBpStep', undoDescription === null).disabled"
              @click="session.sendCommand({ type: 'undoBpStep' })"
            >
              <Undo2 class="size-4" aria-hidden="true" />
              {{ commandLabel("undoBpStep", "撤回中…", "撤回上一步") }}
            </button>
            <p v-if="undoDescription !== null" class="text-xs text-(--text-muted)">
              可撤回：{{ undoDescription }}
            </p>
            <p
              v-if="scopeErrorText('undoBpStep')"
              class="text-xs text-(--status-danger-fg)"
              role="alert"
            >
              {{ scopeErrorText("undoBpStep") }}
            </p>
          </div>

          <!-- 重开：独立一行 + 明确二次确认。 -->
          <div class="mt-1 flex flex-col gap-1.5 border-t border-(--border-default) pt-3">
            <button
              v-if="!restartConfirming"
              type="button"
              class="flex items-center justify-center gap-1.5 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium focus-ring hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="commandButtonState('restartBp', false).disabled"
              @click="restartConfirming = true"
            >
              <RotateCcw class="size-4" aria-hidden="true" />
              重开本局
            </button>
            <div
              v-else
              class="flex flex-col gap-2 rounded-lg border border-(--status-warning-border) bg-(--status-warning-bg) p-3"
            >
              <p class="text-xs leading-5 text-(--status-warning-fg)">
                重开将清空本局全部禁选结果与未提交预选；保留房间、成员、席位与队伍名，并返回待开始。
              </p>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="flex-1 rounded-lg bg-(--status-danger) px-3 py-1.5 text-sm font-semibold text-(--text-inverse) focus-ring hover:bg-(--status-danger-fg) disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="commandButtonState('restartBp', false).disabled"
                  @click="session.sendCommand({ type: 'restartBp' })"
                >
                  {{ commandLabel("restartBp", "重开中…", "确认重开") }}
                </button>
                <button
                  type="button"
                  class="flex-1 rounded-lg border border-(--border-default) bg-(--surface-elevated) px-3 py-1.5 text-sm font-medium focus-ring hover:bg-(--surface-subtle)"
                  @click="restartConfirming = false"
                >
                  取消
                </button>
              </div>
              <p
                v-if="scopeErrorText('restartBp')"
                class="text-xs text-(--status-danger-fg)"
                role="alert"
              >
                {{ scopeErrorText("restartBp") }}
              </p>
            </div>
          </div>
        </section>

        <!-- 队伍与成员（仅房主） -->
        <section
          v-if="isHost && hostView !== null"
          class="flex flex-col gap-3"
          aria-label="队伍与成员"
        >
          <h3 class="text-xs font-semibold tracking-wide text-(--text-muted)">队伍与成员</h3>
          <!-- 两队各自成组：组内行距 8px，队与队之间 20px，分组界线清楚。 -->
          <div class="flex flex-col gap-5">
            <div v-for="team in ['A', 'B'] as const" :key="team" class="flex flex-col gap-2">
              <!-- 队名行：左侧可见标签说明方位与内容，标签与输入框正确关联。 -->
              <div :class="TEAM_MEMBER_GRID_CLASS">
                <label :class="TEAM_MEMBER_LABEL_CLASS" :for="`team-name-${team}`">
                  {{ sideLabel(team) }}队名
                </label>
                <input
                  :id="`team-name-${team}`"
                  :value="teamDrafts[team].draft"
                  :class="[
                    TEAM_MEMBER_CONTROL_CLASS,
                    { 'border-(--status-danger)': teamNameErrors[team] !== null },
                  ]"
                  class="min-w-0 rounded-lg border border-(--border-default) bg-(--surface-elevated) px-2.5 text-sm focus-ring"
                  type="text"
                  :placeholder="`${sideLabel(team)}队伍名`"
                  @input="onTeamNameInput(team, ($event.target as HTMLInputElement).value)"
                />
                <button
                  type="button"
                  :class="TEAM_MEMBER_ACTION_CLASS"
                  :disabled="
                    commandButtonState(
                      `setTeamName:${team}`,
                      teamDrafts[team].draft.trim() === '' || !teamDrafts[team].dirty,
                    ).disabled
                  "
                  @click="saveTeamName(team)"
                >
                  {{ commandLabel(`setTeamName:${team}`, "保存中…", "保存") }}
                </button>
              </div>
              <p
                v-if="
                  teamNameErrors[team] !== null || scopeErrorText(`setTeamName:${team}`) !== null
                "
                :class="TEAM_MEMBER_INDENT_CLASS"
                class="text-xs text-(--status-danger-fg)"
                role="alert"
              >
                {{ teamNameErrors[team] ?? scopeErrorText(`setTeamName:${team}`) }}
              </p>

              <!-- 选手行：与队名行同列，昵称、在线状态与席位操作按列对齐。 -->
              <div :class="TEAM_MEMBER_GRID_CLASS">
                <span :class="TEAM_MEMBER_LABEL_CLASS">{{ sideLabel(team) }}选手</span>
                <template v-if="hostView.seatOccupancy[team]">
                  <span class="flex min-w-0 items-center gap-2">
                    <span
                      class="size-2 shrink-0 rounded-full"
                      :class="
                        seatedMemberOf(hostView, team)?.online
                          ? 'bg-(--status-success)'
                          : 'bg-(--surface-muted)'
                      "
                      aria-hidden="true"
                    />
                    <span class="min-w-0 flex-1 truncate text-sm text-(--text-secondary)">
                      {{ seatedMemberOf(hostView, team)?.nickname ?? "待选择" }}
                      <span
                        class="ml-1 text-xs"
                        :class="
                          seatedMemberOf(hostView, team)?.online
                            ? 'text-(--status-success-fg)'
                            : 'text-(--text-muted)'
                        "
                      >
                        {{ seatedMemberOf(hostView, team)?.online ? "在线" : "离线" }}
                      </span>
                    </span>
                  </span>
                  <button
                    type="button"
                    :class="TEAM_MEMBER_ACTION_CLASS"
                    :disabled="
                      hostView.bpStatus === 'running' ||
                      hostView.bpStatus === 'completed' ||
                      !connected
                    "
                    :title="hostView.bpStatus === 'running' ? '暂停后可更换选手' : undefined"
                    @click="openSeat(team)"
                  >
                    更换选手
                  </button>
                </template>
                <template v-else>
                  <span class="min-w-0 text-sm text-(--text-muted)">待选择</span>
                  <button
                    type="button"
                    :class="TEAM_MEMBER_ACTION_CLASS"
                    :disabled="hostView.bpStatus === 'completed' || !connected"
                    @click="openSeat(team)"
                  >
                    选择选手
                  </button>
                </template>
              </div>
              <p
                v-if="hostView.bpStatus === 'running'"
                :class="TEAM_MEMBER_INDENT_CLASS"
                class="text-xs text-(--text-muted)"
              >
                暂停后可更换选手
              </p>
            </div>
          </div>

          <!-- 其他成员：单行入口，主面板不铺开名单。 -->
          <button
            type="button"
            class="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-(--text-secondary) focus-ring hover:bg-(--surface-subtle)"
            @click="subview = 'members'"
          >
            <Users class="size-4 text-(--text-muted)" aria-hidden="true" />
            其他成员（{{ otherRows.length }}）
            <ChevronRight class="ml-auto size-4 text-(--text-muted)" aria-hidden="true" />
          </button>
        </section>
      </div>

      <!-- 显示与分享（所有角色；固定底栏，不随上方内容滚动） -->
      <section
        class="flex shrink-0 flex-col gap-2 px-4 py-4"
        :class="isHost && hostView !== null ? 'border-t border-(--border-default)' : ''"
        aria-label="显示与分享"
      >
        <h3 class="text-xs font-semibold tracking-wide text-(--text-muted)">显示与分享</h3>
        <a
          :href="displayHref"
          target="_blank"
          rel="noopener"
          class="flex items-center gap-2 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium focus-ring hover:bg-(--surface-subtle)"
        >
          <ExternalLink class="size-4 text-(--text-muted)" aria-hidden="true" />
          打开展示页
        </a>
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium focus-ring hover:bg-(--surface-subtle)"
          @click="copyRoomLink"
        >
          <Link2 class="size-4 text-(--text-muted)" aria-hidden="true" />
          {{ copied ? "已复制" : "复制房间链接" }}
        </button>
      </section>
    </div>

    <!-- 其他成员列表：标题与列头固定，名单在剩余区域内滚动；
         「共 N 人」置于固定底栏，以上方横线与列表分隔。 -->
    <div v-else-if="subview === 'members'" class="flex min-h-0 flex-1 flex-col">
      <div class="shrink-0 px-4 pt-4">
        <div
          :class="MEMBER_GRID_CLASS"
          class="border-b border-(--border-subtle) pb-1 text-xs text-(--text-muted)"
        >
          <span class="size-2" aria-hidden="true" />
          <span>昵称</span>
          <span>角色</span>
          <span>状态</span>
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-4">
        <ul class="flex flex-col">
          <li
            v-for="member in otherRows"
            :key="member.memberId"
            :class="MEMBER_GRID_CLASS"
            class="border-b border-(--border-subtle) py-2 last:border-b-0"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :class="member.online ? 'bg-(--status-success)' : 'bg-(--surface-muted)'"
              aria-hidden="true"
            />
            <span
              class="min-w-0 truncate text-sm text-(--text-secondary)"
              :title="member.nickname"
              >{{ member.nickname }}</span
            >
            <span class="text-xs text-(--text-muted)">{{ memberRoleText(member) }}</span>
            <span
              class="text-xs"
              :class="member.online ? 'text-(--status-success-fg)' : 'text-(--text-muted)'"
            >
              {{ member.online ? "在线" : "离线" }}
            </span>
          </li>
        </ul>
      </div>
      <p
        class="shrink-0 border-t border-(--border-default) px-4 py-2.5 text-xs text-(--text-muted)"
      >
        共 {{ otherRows.length }} 人
      </p>
    </div>

    <!-- 席位选择：待开始分配与暂停换人共用同一列表；目标队伍与当前选手固定。 -->
    <div v-else class="flex min-h-0 flex-1 flex-col px-4 py-4">
      <div class="shrink-0 pb-2">
        <div class="flex flex-col gap-0.5 text-sm text-(--text-secondary)">
          <p>目标队伍：{{ seatTargetLabel }}</p>
          <p>当前选手：{{ currentSeatedMember?.nickname ?? "待选择" }}</p>
        </div>
        <p
          v-if="scopeErrorText(`assignSeat:${seatTeam}`)"
          class="mt-2 text-xs text-(--status-danger-fg)"
          role="alert"
        >
          {{ scopeErrorText(`assignSeat:${seatTeam}`) }}
        </p>
        <!-- 目标行成为「当前选手」或不在列表中时，挂起状态由此提示承接。 -->
        <p
          v-if="seatAssignFeedbackText !== null"
          class="mt-2 text-xs text-(--status-warning-fg)"
          role="status"
        >
          {{ seatAssignFeedbackText }}
        </p>
        <div
          :class="SEAT_GRID_CLASS"
          class="mt-2 border-b border-(--border-subtle) pb-1 text-xs text-(--text-muted)"
        >
          <span class="size-2" aria-hidden="true" />
          <span>昵称</span>
          <span>角色</span>
          <span>状态</span>
          <span class="justify-self-end">操作</span>
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <ul class="flex flex-col">
          <li
            v-for="row in seatRows"
            :key="row.member.memberId"
            :data-member-id="row.member.memberId"
            :class="SEAT_GRID_CLASS"
            class="border-b border-(--border-subtle) py-2 last:border-b-0"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :class="row.member.online ? 'bg-(--status-success)' : 'bg-(--surface-muted)'"
              aria-hidden="true"
            />
            <span
              class="min-w-0 truncate text-sm text-(--text-secondary)"
              :title="row.member.nickname"
            >
              {{ row.member.nickname }}
            </span>
            <span class="text-xs text-(--text-muted)">{{ memberRoleText(row.member) }}</span>
            <span
              class="text-xs"
              :class="row.member.online ? 'text-(--status-success-fg)' : 'text-(--text-muted)'"
            >
              {{ row.member.online ? "在线" : "离线" }}
            </span>
            <button
              v-if="row.isCurrent"
              type="button"
              class="justify-self-end rounded-lg border border-(--border-default) px-2.5 py-1 text-xs font-medium text-(--text-muted) disabled:cursor-not-allowed"
              disabled
            >
              当前选手
            </button>
            <button
              v-else
              type="button"
              class="justify-self-end rounded-lg border px-2.5 py-1 text-xs font-medium focus-ring disabled:cursor-not-allowed disabled:opacity-50"
              :class="
                row.eligible
                  ? 'border-(--accent-primary) text-(--text-accent) hover:bg-(--accent-soft)'
                  : 'border-(--border-default) text-(--text-muted)'
              "
              :disabled="
                !row.eligible ||
                !seatChangeAllowed ||
                !connected ||
                session.isScopePending(`assignSeat:${seatTeam}`)
              "
              :title="
                !row.eligible ? '成员当前离线，不能上席' : (seatChangeForbiddenHint ?? undefined)
              "
              @click="assignSeat(seatTeam, row.member.memberId)"
            >
              {{ seatRowButtonText(seatTeam, row.member.memberId) }}
            </button>
          </li>
        </ul>
      </div>
      <p class="shrink-0 pt-2 text-xs text-(--text-muted)">BP 保持当前状态，选手安排由房主确认。</p>
    </div>
  </aside>
</template>
