<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useClipboard } from "@vueuse/core";
import { ArrowLeft, Link2, SlidersHorizontal, X } from "@lucide/vue";
import type { ArchiveSnapshot } from "../../../shared/contracts/records";
import AgentStatusAvatar from "./AgentStatusAvatar.vue";
import PickColumn from "./PickColumn.vue";
import RoomHeader from "./RoomHeader.vue";
import { usePanelDismiss } from "../../room/panel-dismiss";
import {
  formatRecordExpiry,
  recordActionText,
  recordAgentDisplay,
  recordBanSlots,
  recordPickColumns,
  recordStatusText,
  recordTeamLabels,
} from "../../room/record-view";

// 只读记录页（docs/specs/room-layout.md「只读记录页」，线框
// desktop-record-v2）：原房间链接的归档查看界面，所有访问者同一套视图。
// - 快照是唯一数据来源（普通 HTTP 读取，无成员加入、无实时连接、无
//   倒计时轮询）；不请求当前 catalog 重解释旧名称或头像；
// - 沿用房间两层结构：顶部双方禁用区（旁附队名）+ 房名 +「只读记录 ·
//   已完成/未完成」；两侧选用结果固定九格竖排；中央为单列禁选顺序列表
//   （顺序/操作/代理人三列，1 起连续顺序、左右方动作文案、代理人头像
//   与名称）；
// - 只有列表内部纵向滚动；标题、列头、控制面板入口及顶部/两侧固定；
// - 控制面板为右侧覆盖（不挤压两侧网格）：复制原链接与记录到期时间；
//   Esc 关闭，关闭后焦点回到入口。

const props = defineProps<{
  readonly record: ArchiveSnapshot;
}>();

const banSlots = computed(() => recordBanSlots(props.record));

const teamLabels = computed(() => recordTeamLabels(props.record));

const pickColumns = computed(() => recordPickColumns(props.record));

const statusText = computed(() => recordStatusText(props.record));

/** 中央列表行：顺序（1 起连续）、操作文案、代理人展示与状态视觉。 */
const rows = computed(() =>
  props.record.operations.map((operation, index) => ({
    ordinal: index + 1,
    actionText: recordActionText(operation),
    agent: recordAgentDisplay(operation),
    status: operation.action === "ban" ? ("banned" as const) : ("picked" as const),
    name: operation.agentName,
  })),
);

const expiryText = computed(() => formatRecordExpiry(props.record.expiresAt));

// ---- 控制面板：右侧覆盖，内容限布局切换、复制原链接、记录到期时间。 ----

const panelOpen = ref(false);
const panelEntryEl = ref<HTMLElement | null>(null);
const panelRootEl = ref<HTMLElement | null>(null);
const { copy, copied } = useClipboard({ legacy: true });

function openPanel(): void {
  panelOpen.value = true;
  void nextTick(() => panelRootEl.value?.focus());
}

function closePanel(): void {
  panelOpen.value = false;
  // 面板关闭后焦点回到入口，保持键盘操作连续（与实时房间一致）。
  void nextTick(() => panelEntryEl.value?.focus());
}

/** 入口按钮：再次点击收起面板，开关语义与实时房间一致。 */
function togglePanel(): void {
  if (panelOpen.value) closePanel();
  else openPanel();
}

// 外部点击关闭：与实时房间共用同一套语义（首次外部点击只收起面板，
// 不触发底层操作；入口点击不被外部监听先关后开，见 panel-dismiss.ts）。
usePanelDismiss({
  panel: () => panelRootEl.value,
  close: closePanel,
});

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && panelOpen.value) closePanel();
}

onMounted(() => {
  window.addEventListener("keydown", onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeydown);
});

async function copyRecordLink(): Promise<void> {
  await copy(window.location.href);
}
</script>

<template>
  <!--
    工作区宽度/高度基准与实时房间一致（见 RoomWorkspace 根节点说明）：
    最大 1920px 居中、最小 1024px（窄于最小宽度时保持 1024px 由整页横向
    滚动兜底），高度确定为「可用内容区高度与 768px 的较大值」（低于 768px
    时由整页纵向滚动兜底）。中央记录列表仍仅在自身区域内滚动。
  -->
  <div class="mx-auto flex h-[max(100dvh,48rem)] w-full max-w-[120rem] min-w-[64rem] flex-col">
    <RoomHeader
      :room-name="record.roomName"
      :bp-status-text="statusText"
      :connection-text="null"
      :team-names="teamLabels"
      :ban-slots="banSlots"
      :preselect-agent="null"
      :breathing="false"
    />

    <main class="grid min-h-0 flex-1 grid-cols-[7.5rem_1fr_7.5rem] items-stretch gap-3 p-3">
      <PickColumn
        :rows="pickColumns.A.rows"
        :preselect-agent="null"
        :breathing="false"
        side-text="A 方"
      />

      <!-- 中央禁选顺序列表：标题、记录数与列头固定，仅列表滚动；
           控制面板覆盖列表右侧，不挤压两侧网格、不遮底部入口。 -->
      <section
        class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-(--border-default) bg-(--surface-panel)"
        aria-label="禁选顺序"
      >
        <div class="relative flex min-h-0 flex-1 flex-col">
          <!-- 固定标题行：禁选顺序 + 记录数。 -->
          <div class="flex shrink-0 items-baseline justify-between gap-2 px-4 pt-3 pb-2">
            <h2 class="text-sm font-semibold text-(--text-primary)">禁选顺序</h2>
            <p class="text-xs text-(--text-muted)">共 {{ rows.length }} 步</p>
          </div>

          <!-- 固定列头：顺序 / 操作 / 代理人。 -->
          <div
            class="grid shrink-0 grid-cols-[2.75rem_6.5rem_minmax(0,1fr)] items-center gap-2 border-b border-(--border-default) px-4 pb-1.5 text-xs text-(--text-muted)"
            aria-hidden="true"
          >
            <span>顺序</span>
            <span>操作</span>
            <span>代理人</span>
          </div>

          <!-- 记录列表：仅此区域纵向滚动；行含顺序号、左右方动作与
               代理人头像名称，禁用/选用沿用既有视觉表达。顺序号为整局
               有效提交的先后（区别于已移除的选用槽位数字角标）。 -->
          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-1.5">
            <ul class="flex flex-col">
              <li
                v-for="row in rows"
                :key="row.ordinal"
                class="grid grid-cols-[2.75rem_6.5rem_minmax(0,1fr)] items-center gap-2 border-b border-(--border-subtle) py-2 last:border-b-0"
              >
                <span class="text-sm text-(--text-muted) tabular-nums">{{ row.ordinal }}</span>
                <span class="text-sm text-(--text-secondary)">{{ row.actionText }}</span>
                <span class="flex min-w-0 items-center gap-2">
                  <span class="size-9 shrink-0 rounded-md">
                    <AgentStatusAvatar :agent="row.agent" :status="row.status" />
                  </span>
                  <span class="min-w-0 truncate text-sm text-(--text-primary)" :title="row.name">
                    {{ row.name }}
                  </span>
                  <span class="sr-only"
                    >第 {{ row.ordinal }} 步：{{ row.actionText }} {{ row.name }}</span
                  >
                </span>
              </li>
            </ul>
          </div>

          <!-- 控制面板：右侧覆盖，不随列表滚动。 -->
          <aside
            v-if="panelOpen"
            ref="panelRootEl"
            class="absolute inset-y-0 right-0 z-20 flex w-88 max-w-full flex-col border-l border-(--border-default) bg-(--surface-panel) shadow-xl"
            role="dialog"
            aria-label="控制面板"
            tabindex="-1"
          >
            <header
              class="flex shrink-0 items-center justify-between gap-2 border-b border-(--border-default) px-4 py-3"
            >
              <h3 class="text-base font-semibold text-(--text-primary)">控制面板</h3>
              <button
                type="button"
                class="flex size-7 items-center justify-center rounded text-(--text-muted) focus-ring hover:text-(--text-primary)"
                aria-label="关闭控制面板"
                @click="closePanel"
              >
                <X class="size-4" aria-hidden="true" />
              </button>
            </header>

            <div class="flex flex-col gap-6 overflow-y-auto px-4 py-4">
              <!-- 显示与分享（布局固定九格竖排，无可切换项）。 -->
              <section class="flex flex-col gap-2" aria-label="显示与分享">
                <h4 class="text-xs font-semibold tracking-wide text-(--text-muted)">显示与分享</h4>
                <button
                  type="button"
                  class="flex items-center gap-2 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium focus-ring hover:bg-(--surface-subtle)"
                  @click="copyRecordLink"
                >
                  <Link2 class="size-4 text-(--text-muted)" aria-hidden="true" />
                  {{ copied ? "已复制" : "复制房间链接" }}
                </button>
              </section>

              <!-- 记录到期时间：静态展示，不做倒计时。 -->
              <section class="flex flex-col gap-1" aria-label="记录信息">
                <h4 class="text-xs font-semibold tracking-wide text-(--text-muted)">记录信息</h4>
                <p class="text-sm text-(--text-secondary)">
                  记录到期时间：<span class="tabular-nums">{{ expiryText }}</span>
                </p>
                <p class="text-xs leading-5 text-(--text-muted)">
                  到期后记录将被清理；查看记录不会延长保留期限。
                </p>
              </section>
            </div>
          </aside>
        </div>

        <!-- 底部固定入口：左侧「返回首页」（与实时房间底栏同一位置与样式，
             明确走首页路由），右侧控制面板按钮（无确认按钮，无实时状态）。 -->
        <div
          class="flex shrink-0 items-center justify-between border-t border-(--border-default) px-3 py-2.5"
        >
          <RouterLink
            to="/"
            class="flex items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-(--text-muted) focus-ring hover:bg-(--surface-subtle) hover:text-(--text-secondary)"
          >
            <ArrowLeft class="size-4" aria-hidden="true" />
            返回首页
          </RouterLink>
          <button
            ref="panelEntryEl"
            type="button"
            class="flex shrink-0 items-center gap-1.5 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium text-(--text-secondary) focus-ring hover:bg-(--surface-subtle)"
            aria-haspopup="dialog"
            data-panel-entry
            @click="togglePanel"
          >
            <SlidersHorizontal class="size-4" aria-hidden="true" />
            控制面板
          </button>
        </div>
      </section>

      <PickColumn
        :rows="pickColumns.B.rows"
        :preselect-agent="null"
        :breathing="false"
        side-text="B 方"
      />
    </main>
  </div>
</template>
