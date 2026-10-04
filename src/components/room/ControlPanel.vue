<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useClipboard } from "@vueuse/core";
import { ArrowLeft, ChevronRight, Link2, Pencil, RotateCcw, Undo2, Users, X } from "@lucide/vue";
import type { BpTeam } from "../../../shared/bp/steps";
import type { HostManagementView, ManagedMember } from "../../../shared/contracts/views";
import { validateTeamName } from "../../lib/form-validation";
import type { RoomSession } from "../../room/room-session";
import { isHostManagementView, type RoomView } from "../../room/room-session";
import type { RoomCatalogModel } from "../../room/room-catalog";
import {
  memberRoleText,
  otherMemberRows,
  seatSelectionRows,
  sideLabel,
  startBlockers,
  undoTargetDescription,
} from "../../room/host-panels";
import { PICK_LAYOUT_LABELS, type PickLayout } from "../../room/pick-layout";

// 控制面板：池内右下入口打开，右侧覆盖中央代理人池区域，不压缩网格、
// 不遮顶部与双方禁选区（docs/specs/room-layout.md「控制面板」，线框
// desktop-host-panel-v3 / desktop-host-members-v2 / 更换选手 v3）。
// 按角色展示内容：显示与分享为公共分组；比赛控制与队伍与成员仅房主。
// 面板内子视图：主面板、其他成员、席位选择（待开始分配与暂停换人共用）。

const props = defineProps<{
  readonly session: RoomSession;
  readonly view: RoomView;
  readonly catalogModel: RoomCatalogModel | null;
  readonly layout: PickLayout;
  readonly connected: boolean;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "update:layout", layout: PickLayout): void;
}>();

type Subview = "main" | "members" | "seat";

const subview = ref<Subview>("main");
const seatTeam = ref<BpTeam>("A");
const restartConfirming = ref(false);
const pendingSeatMemberId = ref<string | null>(null);
const teamNameErrors = reactive<{ A: string | null; B: string | null }>({ A: null, B: null });
const teamDrafts = reactive<{ A: string; B: string }>({
  A: props.view.teamNames.A,
  B: props.view.teamNames.B,
});
const teamDraftDirty = reactive<{ A: boolean; B: boolean }>({ A: false, B: false });

const isHost = computed(() => isHostManagementView(props.view));
const hostView = computed(() => (isHostManagementView(props.view) ? props.view : null));
const { copy, copied } = useClipboard({ legacy: true });

/** 面板根元素：打开时聚焦，Esc 可关闭/返回。 */
const rootEl = ref<HTMLElement | null>(null);

onMounted(() => {
  rootEl.value?.focus();
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

// 队名草稿与权威值同步：仅在未修改时跟随视图，保留房主的输入。
watch(
  () => [props.view.teamNames.A, props.view.teamNames.B] as const,
  ([nextA, nextB]) => {
    if (!teamDraftDirty.A) teamDrafts.A = nextA;
    if (!teamDraftDirty.B) teamDrafts.B = nextB;
  },
);

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

const seatRows = computed(() => {
  if (hostView.value === null) return { current: null, candidates: [] };
  return seatSelectionRows(hostView.value, seatTeam.value);
});

const otherRows = computed(() => (hostView.value === null ? [] : otherMemberRows(hostView.value)));

const seatTargetLabel = computed(() => {
  if (hostView.value === null) return "";
  const name = hostView.value.teamNames[seatTeam.value];
  return name === "" ? sideLabel(seatTeam.value) : name;
});

function openSeat(team: BpTeam): void {
  seatTeam.value = team;
  subview.value = "seat";
}

function backToMain(): void {
  subview.value = "main";
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (subview.value === "main") emit("close");
  else subview.value = "main";
}

function chooseLayout(layout: PickLayout): void {
  emit("update:layout", layout);
}

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

function scopeErrorText(scope: string): string | null {
  return props.session.scopeError(scope)?.text ?? null;
}

function saveTeamName(team: BpTeam): void {
  const error = validateTeamName(teamDrafts[team]);
  teamNameErrors[team] = error;
  if (error !== null) return;
  teamDraftDirty[team] = false;
  props.session.sendCommand({ type: "setTeamName", team, teamName: teamDrafts[team] });
}

function onTeamNameInput(team: BpTeam, value: string): void {
  teamDrafts[team] = value;
  teamDraftDirty[team] = true;
  teamNameErrors[team] = null;
  props.session.clearScopeError(`setTeamName:${team}`);
}

function assignSeat(memberId: string): void {
  if (pendingSeatMemberId.value !== null) return;
  pendingSeatMemberId.value = memberId;
  props.session.sendCommand({
    type: "assignSeat",
    team: seatTeam.value,
    targetMemberId: memberId,
  });
  // 命令回执（或新视图）到达后清除按钮级 pending；行内容随权威视图原位更新。
  const unwatch = watch(
    () => props.session.isScopePending(`assignSeat:${seatTeam.value}`),
    (pending) => {
      if (!pending) {
        pendingSeatMemberId.value = null;
        unwatch();
      }
    },
  );
}
</script>

<template>
  <aside
    ref="rootEl"
    class="absolute inset-y-0 right-0 z-20 flex w-88 max-w-full flex-col border-l border-(--border-default) bg-(--surface-panel) shadow-xl"
    role="dialog"
    aria-label="控制面板"
    tabindex="-1"
    @keydown="onKeydown"
  >
    <!-- 顶部固定：子视图提供返回入口；只有列表内容滚动。 -->
    <header
      class="flex shrink-0 items-center justify-between gap-2 border-b border-(--border-default) px-4 py-3"
    >
      <div class="flex min-w-0 items-center gap-2">
        <button
          v-if="subview !== 'main'"
          type="button"
          class="flex items-center gap-1 rounded px-1.5 py-1 text-sm text-neutral-600 focus-ring hover:text-neutral-900"
          @click="backToMain"
        >
          <ArrowLeft class="size-4" aria-hidden="true" />
          返回
        </button>
        <h2 class="truncate text-base font-semibold text-neutral-900">{{ panelTitle }}</h2>
      </div>
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded text-neutral-500 focus-ring hover:text-neutral-900"
        aria-label="关闭控制面板"
        @click="emit('close')"
      >
        <X class="size-4" aria-hidden="true" />
      </button>
    </header>

    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
      <!-- 主面板 -->
      <template v-if="subview === 'main'">
        <!-- 比赛控制（仅房主） -->
        <section
          v-if="isHost && hostView !== null"
          class="flex flex-col gap-2"
          aria-label="比赛控制"
        >
          <h3 class="text-xs font-semibold tracking-wide text-neutral-500">比赛控制</h3>

          <template v-if="hostView.bpStatus === 'waiting'">
            <button
              type="button"
              class="rounded-lg bg-lavender-600 px-3 py-2 text-sm font-semibold text-white focus-ring hover:bg-lavender-700 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="commandButtonState('startBp', blockers.length > 0).disabled"
              @click="session.sendCommand({ type: 'startBp' })"
            >
              {{ commandButtonState("startBp", false).pending ? "开始中…" : "开始 BP" }}
            </button>
            <ul v-if="blockers.length > 0" class="flex flex-col gap-0.5 text-xs text-neutral-500">
              <li v-for="blocker in blockers" :key="blocker">· {{ blocker }}</li>
            </ul>
          </template>
          <button
            v-else-if="hostView.bpStatus === 'running'"
            type="button"
            class="rounded-lg bg-lavender-600 px-3 py-2 text-sm font-semibold text-white focus-ring hover:bg-lavender-700 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="commandButtonState('pauseBp', false).disabled"
            @click="session.sendCommand({ type: 'pauseBp' })"
          >
            {{ commandButtonState("pauseBp", false).pending ? "暂停中…" : "暂停 BP" }}
          </button>
          <button
            v-else-if="hostView.bpStatus === 'paused'"
            type="button"
            class="rounded-lg bg-lavender-600 px-3 py-2 text-sm font-semibold text-white focus-ring hover:bg-lavender-700 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="commandButtonState('resumeBp', false).disabled"
            @click="session.sendCommand({ type: 'resumeBp' })"
          >
            {{ commandButtonState("resumeBp", false).pending ? "继续中…" : "继续 BP" }}
          </button>
          <p
            v-if="
              scopeErrorText('startBp') ?? scopeErrorText('pauseBp') ?? scopeErrorText('resumeBp')
            "
            class="text-xs text-danger-700"
            role="alert"
          >
            {{
              scopeErrorText("startBp") ?? scopeErrorText("pauseBp") ?? scopeErrorText("resumeBp")
            }}
          </p>

          <div class="flex flex-col gap-1">
            <button
              type="button"
              class="flex items-center justify-center gap-1.5 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium focus-ring hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="commandButtonState('undoBpStep', undoDescription === null).disabled"
              @click="session.sendCommand({ type: 'undoBpStep' })"
            >
              <Undo2 class="size-4" aria-hidden="true" />
              {{ commandButtonState("undoBpStep", false).pending ? "撤回中…" : "撤回上一步" }}
            </button>
            <p v-if="undoDescription !== null" class="text-xs text-neutral-500">
              可撤回：{{ undoDescription }}
            </p>
            <p v-if="scopeErrorText('undoBpStep')" class="text-xs text-danger-700" role="alert">
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
              class="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3"
            >
              <p class="text-xs leading-5 text-amber-900">
                重开将清空本局全部禁选结果与未提交预选；保留房间、成员、席位与队伍名，并返回待开始。
              </p>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="flex-1 rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white focus-ring hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="commandButtonState('restartBp', false).disabled"
                  @click="session.sendCommand({ type: 'restartBp' })"
                >
                  {{ commandButtonState("restartBp", false).pending ? "重开中…" : "确认重开" }}
                </button>
                <button
                  type="button"
                  class="flex-1 rounded-lg border border-(--border-default) bg-(--surface-elevated) px-3 py-1.5 text-sm font-medium focus-ring hover:bg-(--surface-subtle)"
                  @click="restartConfirming = false"
                >
                  取消
                </button>
              </div>
              <p v-if="scopeErrorText('restartBp')" class="text-xs text-danger-700" role="alert">
                {{ scopeErrorText("restartBp") }}
              </p>
            </div>
          </div>
        </section>

        <!-- 队伍与成员（仅房主） -->
        <section
          v-if="isHost && hostView !== null"
          class="mt-6 flex flex-col gap-3"
          aria-label="队伍与成员"
        >
          <h3 class="text-xs font-semibold tracking-wide text-neutral-500">队伍与成员</h3>
          <div v-for="team in ['A', 'B'] as const" :key="team" class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <Pencil class="size-3.5 shrink-0 text-neutral-400" aria-hidden="true" />
              <label class="sr-only" :for="`team-name-${team}`">
                {{
                  hostView.teamNames[team] === "" ? sideLabel(team) : hostView.teamNames[team]
                }}队伍名
              </label>
              <input
                :id="`team-name-${team}`"
                :value="teamDrafts[team]"
                class="min-w-0 flex-1 rounded-lg border border-(--border-default) bg-(--surface-elevated) px-2.5 py-1.5 text-sm focus-ring"
                :class="{ 'border-danger-500': teamNameErrors[team] !== null }"
                type="text"
                :placeholder="`${sideLabel(team)}队伍名`"
                @input="onTeamNameInput(team, ($event.target as HTMLInputElement).value)"
              />
              <button
                type="button"
                class="shrink-0 rounded-lg border border-(--border-default) px-2.5 py-1.5 text-xs font-medium focus-ring hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="
                  commandButtonState(
                    `setTeamName:${team}`,
                    teamDrafts[team].trim() === '' || teamDrafts[team] === hostView.teamNames[team],
                  ).disabled
                "
                @click="saveTeamName(team)"
              >
                {{ commandButtonState(`setTeamName:${team}`, false).pending ? "保存中…" : "保存" }}
              </button>
            </div>
            <p
              v-if="teamNameErrors[team] !== null || scopeErrorText(`setTeamName:${team}`) !== null"
              class="text-xs text-danger-700"
              role="alert"
            >
              {{ teamNameErrors[team] ?? scopeErrorText(`setTeamName:${team}`) }}
            </p>

            <div class="flex items-center gap-2">
              <template v-if="hostView.seatOccupancy[team]">
                <!-- 选手行：昵称 + 在线状态 + 更换入口（按状态开放）。 -->
                <span
                  class="size-2 shrink-0 rounded-full"
                  :class="seatedMemberOf(hostView, team)?.online ? 'bg-mint-500' : 'bg-neutral-300'"
                  aria-hidden="true"
                />
                <span class="min-w-0 flex-1 truncate text-sm text-neutral-800">
                  {{ seatedMemberOf(hostView, team)?.nickname ?? "待选择" }}
                  <span
                    class="ml-1 text-xs"
                    :class="
                      seatedMemberOf(hostView, team)?.online ? 'text-mint-700' : 'text-neutral-400'
                    "
                  >
                    {{ seatedMemberOf(hostView, team)?.online ? "在线" : "离线" }}
                  </span>
                </span>
                <button
                  type="button"
                  class="shrink-0 rounded-lg border border-(--border-default) px-2.5 py-1.5 text-xs font-medium focus-ring hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-50"
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
                <span class="min-w-0 flex-1 text-sm text-neutral-400">待选择</span>
                <button
                  type="button"
                  class="shrink-0 rounded-lg border border-(--border-default) px-2.5 py-1.5 text-xs font-medium focus-ring hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="hostView.bpStatus === 'completed' || !connected"
                  @click="openSeat(team)"
                >
                  选择选手
                </button>
              </template>
            </div>
            <p v-if="hostView.bpStatus === 'running'" class="text-xs text-neutral-400">
              暂停后可更换选手
            </p>
          </div>

          <!-- 其他成员：单行入口，主面板不铺开名单。 -->
          <button
            type="button"
            class="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-neutral-700 focus-ring hover:bg-(--surface-subtle)"
            @click="subview = 'members'"
          >
            <Users class="size-4 text-neutral-400" aria-hidden="true" />
            其他成员（{{ otherRows.length }}）
            <ChevronRight class="ml-auto size-4 text-neutral-400" aria-hidden="true" />
          </button>
        </section>

        <!-- 显示与分享（所有角色） -->
        <section class="mt-6 flex flex-col gap-2" aria-label="显示与分享">
          <h3 class="text-xs font-semibold tracking-wide text-neutral-500">显示与分享</h3>
          <div class="flex items-center gap-2">
            <span class="text-sm text-neutral-600">选用区布局</span>
            <div class="ml-auto flex rounded-lg border border-(--border-default) p-0.5">
              <button
                v-for="option in PICK_LAYOUT_LABELS"
                :key="option.id"
                type="button"
                class="rounded-md px-2.5 py-1 text-xs font-medium focus-ring"
                :class="
                  layout === option.id
                    ? 'bg-lavender-100 text-lavender-800'
                    : 'text-neutral-600 hover:bg-(--surface-subtle)'
                "
                :aria-pressed="layout === option.id"
                @click="chooseLayout(option.id)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
          <button
            type="button"
            class="flex items-center gap-2 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium focus-ring hover:bg-(--surface-subtle)"
            @click="copyRoomLink"
          >
            <Link2 class="size-4 text-neutral-400" aria-hidden="true" />
            {{ copied ? "已复制" : "复制房间链接" }}
          </button>
        </section>
      </template>

      <!-- 其他成员列表：仅查看。 -->
      <template v-else-if="subview === 'members'">
        <p class="text-xs text-neutral-500">共 {{ otherRows.length }} 人</p>
        <ul class="mt-2 flex flex-col">
          <li
            v-for="member in otherRows"
            :key="member.memberId"
            class="flex items-center gap-2 border-b border-(--border-subtle) py-2 last:border-b-0"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :class="member.online ? 'bg-mint-500' : 'bg-neutral-300'"
              aria-hidden="true"
            />
            <span
              class="min-w-0 flex-1 truncate text-sm text-neutral-800"
              :title="member.nickname"
              >{{ member.nickname }}</span
            >
            <span class="shrink-0 text-xs text-neutral-500">{{ memberRoleText(member) }}</span>
            <span
              class="shrink-0 text-xs"
              :class="member.online ? 'text-mint-700' : 'text-neutral-400'"
            >
              {{ member.online ? "在线" : "离线" }}
            </span>
          </li>
        </ul>
      </template>

      <!-- 席位选择：待开始分配与暂停换人共用同一列表。 -->
      <template v-else>
        <div class="flex flex-col gap-0.5 text-sm text-neutral-700">
          <p>目标队伍：{{ seatTargetLabel }}</p>
          <p>当前选手：{{ seatRows.current === null ? "待选择" : seatRows.current.nickname }}</p>
        </div>
        <p
          v-if="scopeErrorText(`assignSeat:${seatTeam}`)"
          class="mt-2 text-xs text-danger-700"
          role="alert"
        >
          {{ scopeErrorText(`assignSeat:${seatTeam}`) }}
        </p>
        <ul class="mt-2 flex flex-col">
          <li
            v-if="seatRows.current !== null"
            :key="seatRows.current.memberId"
            class="flex items-center gap-2 border-b border-(--border-subtle) py-2"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :class="seatRows.current.online ? 'bg-mint-500' : 'bg-neutral-300'"
              aria-hidden="true"
            />
            <span
              class="min-w-0 flex-1 truncate text-sm text-neutral-800"
              :title="seatRows.current.nickname"
              >{{ seatRows.current.nickname }}</span
            >
            <span class="shrink-0 text-xs text-neutral-500">{{
              memberRoleText(seatRows.current)
            }}</span>
            <span
              class="shrink-0 text-xs"
              :class="seatRows.current.online ? 'text-mint-700' : 'text-neutral-400'"
            >
              {{ seatRows.current.online ? "在线" : "离线" }}
            </span>
            <button
              type="button"
              class="shrink-0 rounded-lg border border-(--border-default) px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
              disabled
            >
              当前选手
            </button>
          </li>
          <li
            v-for="member in seatRows.candidates"
            :key="member.memberId"
            class="flex items-center gap-2 border-b border-(--border-subtle) py-2 last:border-b-0"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :class="member.online ? 'bg-mint-500' : 'bg-neutral-300'"
              aria-hidden="true"
            />
            <span
              class="min-w-0 flex-1 truncate text-sm text-neutral-800"
              :title="member.nickname"
              >{{ member.nickname }}</span
            >
            <span class="shrink-0 text-xs text-neutral-500">{{ memberRoleText(member) }}</span>
            <span
              class="shrink-0 text-xs"
              :class="member.online ? 'text-mint-700' : 'text-neutral-400'"
            >
              {{ member.online ? "在线" : "离线" }}
            </span>
            <button
              type="button"
              class="shrink-0 rounded-lg border border-lavender-500 px-2.5 py-1 text-xs font-medium text-lavender-700 focus-ring hover:bg-lavender-50 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!connected || session.isScopePending(`assignSeat:${seatTeam}`)"
              @click="assignSeat(member.memberId)"
            >
              {{
                session.isScopePending(`assignSeat:${seatTeam}`) &&
                pendingSeatMemberId === member.memberId
                  ? "提交中…"
                  : "设为选手"
              }}
            </button>
          </li>
        </ul>
        <p class="mt-3 text-xs text-neutral-400">BP 保持当前状态，选手安排由房主确认。</p>
      </template>
    </div>
  </aside>
</template>
