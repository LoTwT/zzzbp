<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { fetchRoomStatus } from "../../room/api";
import {
  formatLocalDateTime,
  roomHistoryEntryAction,
  roomHistoryExpiresText,
  roomHistoryStatusOf,
  roomHistoryStatusText,
  type RoomHistoryStatus,
} from "../../room/history-status";
import { roomHistory, type RoomHistoryEntry } from "../../room/room-history";

// 首页「最近参与」本机清单（docs/specs/room-layout.md「首页与首次入房」，
// 行为规则见 docs/specs/room-roles.md「本机参与记录」）：
// - 只展示本浏览器记住的房间链接，不是身份或权限来源；进入房间沿用
//   /rooms/:roomId，由 HttpOnly Cookie 恢复身份；
// - 默认显示最近 10 条，「显示更多」每次再展开 10 条；
// - 首次展示与「显示更多」各查询新展示记录的状态，手动「刷新状态」复查
//   当前已展示记录，不持续轮询；状态读取是匿名公开 GET，不建立成员身份、
//   成员连接或展示连接；
// - 「移除」直接执行；「清空历史」二次确认，且只删除本功能自己的数据。

const PAGE_SIZE = 10;
/** 写入失败提示：只在真正影响持久保存时出现（stale 是主动移除的正常结果）。 */
const SAVE_FAILURE_TEXT = "上次的参与记录未能保存到本机（本机存储不可用或已满）。";
const STORAGE_UNAVAILABLE_TEXT =
  "本机存储不可用，最近参与无法在此浏览器保存；不影响创建与进入房间。";
const EMPTY_TEXT = "还没有参与记录，创建或加入房间后会自动记录。";
/** 状态读取进行中的过渡文案：避免在结果返回前就声称「暂时无法确认」。 */
const PENDING_TEXT = "正在确认…";

const router = useRouter();

const entries = ref<readonly RoomHistoryEntry[]>([]);
const storageAvailable = ref(true);
const visibleCount = ref(PAGE_SIZE);
const statuses = ref<Readonly<Record<string, RoomHistoryStatus>>>({});
const pending = ref<ReadonlySet<string>>(new Set());
const refreshing = ref(false);
const confirmingClear = ref(false);
const writeFailure = ref<string | null>(null);
/** 每个房间的状态请求代次：只采纳最新一次请求的结果（含手动刷新）。 */
const statusSequences = new Map<string, number>();
let sequence = 0;
let unsubscribe: (() => void) | null = null;

const displayed = computed(() => entries.value.slice(0, visibleCount.value));
const hasMore = computed(() => entries.value.length > visibleCount.value);
const showList = computed(() => storageAvailable.value && entries.value.length > 0);

function reload(): void {
  const list = roomHistory.list();
  entries.value = list.entries;
  storageAvailable.value = list.storageAvailable;
  // 列表变短（移除/清空/其他标签页）时收回展开量，仍在 10 条起步。
  const expanded = Math.max(PAGE_SIZE, Math.ceil(list.entries.length / PAGE_SIZE) * PAGE_SIZE);
  visibleCount.value = Math.max(PAGE_SIZE, Math.min(visibleCount.value, expanded));
  // 丢弃已移除记录的状态缓存与读取中标记。
  const remaining = new Set(list.entries.map((entry) => entry.roomId));
  const next: Record<string, RoomHistoryStatus> = {};
  for (const [roomId, status] of Object.entries(statuses.value)) {
    if (remaining.has(roomId)) next[roomId] = status;
  }
  statuses.value = next;
  pending.value = new Set([...pending.value].filter((roomId) => remaining.has(roomId)));
  if (roomHistory.takeWriteFailure() !== null) writeFailure.value = SAVE_FAILURE_TEXT;
}

function setPending(roomId: string, value: boolean): void {
  const next = new Set(pending.value);
  if (value) next.add(roomId);
  else next.delete(roomId);
  pending.value = next;
}

async function queryStatuses(
  targets: readonly RoomHistoryEntry[],
  options: { readonly force: boolean },
): Promise<void> {
  await Promise.all(
    targets.map(async (entry) => {
      if (!options.force && statuses.value[entry.roomId] !== undefined) return;
      sequence += 1;
      const current = sequence;
      statusSequences.set(entry.roomId, current);
      setPending(entry.roomId, true);
      const status = roomHistoryStatusOf(await fetchRoomStatus(entry.roomId));
      // 迟到结果不覆盖更新的请求，也不写入已移除的记录。
      if (statusSequences.get(entry.roomId) !== current) return;
      if (!entries.value.some((candidate) => candidate.roomId === entry.roomId)) return;
      setPending(entry.roomId, false);
      statuses.value = { ...statuses.value, [entry.roomId]: status };
    }),
  );
}

async function refresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  reload();
  await queryStatuses(displayed.value, { force: true });
  refreshing.value = false;
}

function showMore(): void {
  visibleCount.value += PAGE_SIZE;
  void queryStatuses(displayed.value, { force: false });
}

function remove(roomId: string): void {
  const result = roomHistory.remove(roomId);
  writeFailure.value = result.ok ? null : SAVE_FAILURE_TEXT;
  reload();
}

function clearAll(): void {
  const result = roomHistory.clear();
  writeFailure.value = result.ok ? null : SAVE_FAILURE_TEXT;
  confirmingClear.value = false;
  reload();
}

function open(entry: RoomHistoryEntry): void {
  void router.push({ name: "room", params: { roomId: entry.roomId } });
}

function statusOf(entry: RoomHistoryEntry): RoomHistoryStatus {
  return statuses.value[entry.roomId] ?? { kind: "unknown" };
}

function statusTextOf(entry: RoomHistoryEntry): string {
  return pending.value.has(entry.roomId) ? PENDING_TEXT : roomHistoryStatusText(statusOf(entry));
}

function actionOf(entry: RoomHistoryEntry) {
  return roomHistoryEntryAction(statusOf(entry));
}

function expiresTextOf(entry: RoomHistoryEntry): string | null {
  return roomHistoryExpiresText(statusOf(entry));
}

onMounted(() => {
  reload();
  void queryStatuses(displayed.value, { force: false });
  // 多标签页同步：其他标签页的改动只影响对应房间的键，重新读取即可合并。
  unsubscribe = roomHistory.subscribe(() => {
    reload();
    void queryStatuses(displayed.value, { force: false });
  });
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});
</script>

<template>
  <section
    class="w-full max-w-sm rounded-xl border border-(--border-default) bg-(--surface-panel) p-6 shadow-sm"
    aria-labelledby="recent-rooms-title"
  >
    <div class="flex items-start justify-between gap-6">
      <div>
        <h2 id="recent-rooms-title" class="text-lg font-semibold">最近参与</h2>
        <p class="mt-1 text-xs text-(--text-muted)">仅此浏览器</p>
      </div>

      <div v-if="showList" class="flex shrink-0 items-center gap-5">
        <button
          type="button"
          class="rounded-lg border border-(--border-default) px-3 py-1.5 text-xs font-medium focus-ring hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="refreshing"
          @click="refresh"
        >
          {{ refreshing ? "刷新中…" : "刷新状态" }}
        </button>
        <button
          type="button"
          class="text-xs font-medium text-(--text-muted) underline-offset-4 focus-ring hover:text-(--text-primary) hover:underline"
          @click="confirmingClear = true"
        >
          清空历史
        </button>
      </div>
    </div>

    <p v-if="!storageAvailable" class="mt-4 text-xs leading-5 text-(--text-muted)" role="status">
      {{ STORAGE_UNAVAILABLE_TEXT }}
    </p>

    <template v-else>
      <!-- 保存失败提示与清单是否为空无关：空清单同样不能承诺已持久保存。 -->
      <p
        v-if="writeFailure !== null"
        class="mt-4 rounded-lg bg-(--status-warning-bg) px-3 py-2 text-xs leading-5 text-(--status-warning-fg)"
        role="status"
      >
        {{ writeFailure }}
      </p>

      <p v-if="entries.length === 0" class="mt-4 text-xs leading-5 text-(--text-muted)">
        {{ EMPTY_TEXT }}
      </p>

      <template v-else>
        <!-- 清空本机历史：二次确认，只删除本功能的数据。 -->
        <div
          v-if="confirmingClear"
          class="mt-4 flex flex-col gap-2 rounded-lg border border-(--status-warning-border) bg-(--status-warning-bg) p-3"
        >
          <p class="text-xs leading-5 text-(--status-warning-fg)">
            清空只删除本浏览器记住的这份列表：服务器上的房间与记录不受影响，也不会退出房间成员身份。
          </p>
          <div class="flex gap-2">
            <button
              type="button"
              class="flex-1 rounded-lg bg-(--status-danger) px-3 py-1.5 text-sm font-semibold text-(--text-inverse) focus-ring hover:bg-(--status-danger-fg)"
              @click="clearAll"
            >
              确认清空
            </button>
            <button
              type="button"
              class="flex-1 rounded-lg border border-(--border-default) bg-(--surface-elevated) px-3 py-1.5 text-sm font-medium focus-ring hover:bg-(--surface-subtle)"
              @click="confirmingClear = false"
            >
              取消
            </button>
          </div>
        </div>

        <!-- 记录列表：房间名、生命周期状态、最近参与时间（已归档另附到期日）。
             长房间名截断展示，完整名称仍在无障碍树中可读，并以悬停提示补全。 -->
        <ul class="mt-2 flex flex-col">
          <li
            v-for="entry in displayed"
            :key="entry.roomId"
            class="flex items-start justify-between gap-3 border-t border-(--border-subtle) py-3 first:border-t-0"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-(--text-primary)" :title="entry.roomName">
                {{ entry.roomName }}
              </p>
              <p class="mt-1 text-xs leading-5 text-(--text-secondary)">
                {{ statusTextOf(entry) }}
              </p>
              <p class="mt-0.5 text-xs leading-5 text-(--text-muted)">
                最近参与 {{ formatLocalDateTime(entry.lastVisitedAt) }}
                <template v-if="expiresTextOf(entry) !== null">
                  · {{ expiresTextOf(entry) }}
                </template>
              </p>
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <button
                v-if="actionOf(entry) === 'enter'"
                type="button"
                class="rounded-lg border border-(--border-default) px-3 py-1.5 text-xs font-medium focus-ring hover:bg-(--surface-subtle)"
                @click="open(entry)"
              >
                进入房间<span class="sr-only">：{{ entry.roomName }}</span>
              </button>
              <button
                v-else-if="actionOf(entry) === 'record'"
                type="button"
                class="rounded-lg border border-(--border-default) px-3 py-1.5 text-xs font-medium focus-ring hover:bg-(--surface-subtle)"
                @click="open(entry)"
              >
                查看记录<span class="sr-only">：{{ entry.roomName }}</span>
              </button>
              <button
                type="button"
                class="text-xs font-medium text-(--text-muted) underline-offset-4 focus-ring hover:text-(--text-primary) hover:underline"
                @click="remove(entry.roomId)"
              >
                移除<span class="sr-only">：{{ entry.roomName }}</span>
              </button>
            </div>
          </li>
        </ul>

        <button
          v-if="hasMore && !confirmingClear"
          type="button"
          class="mt-2 w-full rounded-lg py-1.5 text-xs font-medium text-(--text-muted) underline-offset-4 focus-ring hover:text-(--text-primary) hover:underline"
          @click="showMore"
        >
          显示更多
        </button>
      </template>
    </template>
  </section>
</template>
