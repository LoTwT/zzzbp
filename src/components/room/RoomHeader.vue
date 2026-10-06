<script setup lang="ts">
import { WifiOff } from "@lucide/vue";
import type { BpSlotId, BpTeam } from "../../../shared/bp/steps";
import type { AgentDisplayBase } from "../../room/room-catalog";
import BanSlotRow from "./BanSlotRow.vue";

// 顶部区域：两侧禁用区对称排列，队伍标识（队名，空席「待选择」）紧邻
// 各自禁用区靠近中间的一侧——A 方队名在禁用格右侧、B 方队名在禁用格
// 左侧，两队名称分列赛事信息两旁；中间为房间名（赛事名）、房间状态与
// 本机连接提示（docs/specs/room-layout.md「整体结构」「双方队伍信息」，
// 线框 desktop-room-v4）。实时展示页额外要求连接提示带可辨认的图标
// （「实时展示页」一节），由 connectionIcon 开启；操作页沿用纯文字；
// 只读记录页不传连接提示（普通 HTTP 读取，无实时连接状态）。
//
// 顶部背景取页面画布色（与全局背景同色）：工作区在 1920px 处限宽居中，
// 更宽视口下顶部条带与两侧页面背景没有色差，仅以底部分隔线区分层级。

defineProps<{
  readonly roomName: string;
  readonly bpStatusText: string;
  readonly connectionText: string | null;
  readonly teamNames: Readonly<Record<BpTeam, string>>;
  readonly banSlots: Readonly<
    Record<
      BpTeam,
      ReadonlyArray<{ slotId: BpSlotId; agent: AgentDisplayBase | null; active: boolean }>
    >
  >;
  readonly preselectAgent: AgentDisplayBase | null;
  readonly breathing: boolean;
  /** 连接提示是否附带中断图标（实时展示页的直播采集要求）。 */
  readonly connectionIcon?: boolean;
}>();
</script>

<template>
  <!--
    三列：两侧队伍组（禁用格 + 队名）与中央赛事信息。中间列有 12rem 下限，
    「先收缩队名、再让中央文字截断」是明确的优先级：空间不足时队名退到
    3.5rem（悬停提示补全），中央的房间名、状态与连接提示保持一行可读，
    不出现逐字竖排；状态行整体可换行但每个条目自身不断行。
  -->
  <header
    class="grid shrink-0 grid-cols-[auto_minmax(12rem,1fr)_auto] items-center gap-4 border-b border-(--border-default) bg-(--surface-canvas) px-4 py-2.5"
  >
    <div class="flex min-w-0 items-center gap-3">
      <BanSlotRow
        :slots="banSlots.A"
        :preselect-agent="preselectAgent"
        :breathing="breathing"
        side-text="A 方"
      />
      <!-- 队伍标识：紧邻禁用区靠近中间的一侧（A 方在禁用格右侧）。 -->
      <p
        class="max-w-[10rem] min-w-[3.5rem] truncate text-sm font-medium text-(--text-secondary)"
        :title="teamNames.A"
      >
        {{ teamNames.A }}
      </p>
    </div>

    <div class="flex min-w-0 flex-col items-center gap-0.5 text-center">
      <h1 class="max-w-full truncate text-lg font-semibold text-(--text-primary)" :title="roomName">
        {{ roomName }}
      </h1>
      <p
        class="flex max-w-full flex-wrap items-center justify-center gap-2 text-xs text-(--text-secondary)"
      >
        <span class="whitespace-nowrap">{{ bpStatusText }}</span>
        <!-- 本机连接提示：连接正常时隐藏，不广播、不解释暂停原因。 -->
        <span
          v-if="connectionText !== null"
          class="flex items-center gap-1 rounded-full bg-(--status-warning-bg) px-2 py-0.5 whitespace-nowrap text-(--status-warning-fg)"
          role="status"
        >
          <WifiOff v-if="connectionIcon" class="size-3.5" aria-hidden="true" />
          {{ connectionText }}
        </span>
      </p>
    </div>

    <div class="flex min-w-0 items-center gap-3">
      <!-- 队伍标识：紧邻禁用区靠近中间的一侧（B 方在禁用格左侧）。 -->
      <p
        class="max-w-[10rem] min-w-[3.5rem] truncate text-sm font-medium text-(--text-secondary)"
        :title="teamNames.B"
      >
        {{ teamNames.B }}
      </p>
      <BanSlotRow
        :slots="banSlots.B"
        :preselect-agent="preselectAgent"
        :breathing="breathing"
        side-text="B 方"
      />
    </div>
  </header>
</template>
