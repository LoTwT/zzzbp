<script setup lang="ts">
import type { AgentDisplayBase } from "../../room/room-catalog";
import type { PickSlotView } from "../../room/view-projections";
import AgentAvatar from "./AgentAvatar.vue";

// 一方选用区：默认 9 格竖排或按 Pick 分行（行结构由 pickSlotRows 从
// BP_STEPS / BP_PICK_SEGMENTS 推导）。顶部只显示队名，空席「待选择」，
// 不加 A/B 前缀、昵称或「你」标记。当前操作位是本方选用时进入 active，
// 公开预选直接展示在当前槽位。
//
// 选用卡片的两种形态（见下方 scoped 样式）：
// - 基础形态（只读记录页/实时展示页，未挂载 room-workspace）：固定方形
//   槽位，仅头像，沿用既有尺寸（--room-pick-card-* 兜底值）；
// - 自适应形态（实时房间，.room-workspace 作用域）：卡片随所在行的真实
//   可用宽高伸展，按卡片实际宽度经容器查询切换排布——单格宽卡横向
//   （头像 1:1 居左 + 名称在侧），双格/窄卡纵向（头像在上 + 名称在下）。
//   头像保持正方形不拉伸，尺寸设上限（--room-pick-avatar-max），不为
//   填满空间无限放大。

defineProps<{
  readonly teamName: string;
  readonly rows: ReadonlyArray<ReadonlyArray<PickSlotView>>;
  readonly preselectAgent: AgentDisplayBase | null;
  readonly breathing: boolean;
  readonly sideText: string;
}>();
</script>

<template>
  <section
    class="flex min-h-0 w-full flex-col items-center gap-2"
    :aria-label="`${sideText}选用区`"
  >
    <p
      class="w-full truncate rounded-md bg-(--surface-panel) px-2 py-1 text-center text-sm font-medium text-neutral-800"
      :title="teamName"
    >
      {{ teamName }}
    </p>
    <!-- 列表容器显式占满列宽：自适应卡片的 flex 基准为 0（宽度来自行内
         伸展），不再提供固有宽度，容器必须由列宽决定（w-full）。 -->
    <div
      class="flex min-h-0 w-full flex-1 flex-col justify-start gap-[var(--room-pick-gap,0.375rem)] overflow-y-auto py-0.5"
    >
      <div
        v-for="(row, rowIndex) in rows"
        :key="rowIndex"
        class="flex shrink-0 grow-[var(--room-pick-row-grow,0)] items-center justify-center gap-[var(--room-pick-gap,0.375rem)]"
      >
        <div
          v-for="slot in row"
          :key="slot.slotId"
          class="pick-card relative flex h-[var(--room-pick-card-h,2.75rem)] w-[var(--room-pick-card-w,2.75rem)] min-w-0 flex-[var(--room-pick-card-flex,0_0_auto)] flex-col items-center justify-center self-stretch rounded-md border bg-(--surface-panel) p-0.5"
          :class="slot.active ? 'border-lavender-500' : 'border-(--border-default)'"
        >
          <div
            v-if="slot.active"
            class="absolute inset-0 rounded-md ring-1 ring-lavender-500"
            :class="{ 'slot-breathe': breathing }"
            aria-hidden="true"
          />
          <span
            class="pick-card-badge absolute -top-1 -left-1 z-10 flex size-4 items-center justify-center rounded-full bg-neutral-800 text-[10px] font-medium text-white"
            aria-hidden="true"
          >
            {{ slot.step.sideOrdinal }}
          </span>
          <template v-if="slot.agent !== null">
            <!-- 卡片内容区同时是尺寸容器：头像正方形边长以容器查询单位
                 按可用宽高推导（见 scoped 样式），名称两行截断防溢出。 -->
            <div class="pick-card-content flex min-h-0 w-full flex-1 items-center justify-center">
              <span class="pick-card-avatar relative block aspect-square">
                <AgentAvatar :agent="slot.agent" />
              </span>
              <span class="pick-card-name" :title="slot.agent.name">{{ slot.agent.name }}</span>
            </div>
            <span class="sr-only"
              >第 {{ slot.step.sideOrdinal }} 个选用：{{ slot.agent.name }}</span
            >
          </template>
          <template v-else-if="slot.active && preselectAgent !== null">
            <div class="pick-card-content flex min-h-0 w-full flex-1 items-center justify-center">
              <span class="pick-card-avatar relative block aspect-square">
                <AgentAvatar :agent="preselectAgent" />
              </span>
              <span class="pick-card-name" :title="preselectAgent.name">{{
                preselectAgent.name
              }}</span>
            </div>
            <span class="sr-only">当前操作位，预选：{{ preselectAgent.name }}</span>
          </template>
          <template v-else>
            <span class="sr-only">空选用位 {{ slot.step.sideOrdinal }}</span>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * 两级容器：
 * - .pick-card 是排布切换的查询容器（inline-size）：卡片实际宽度决定
 *   横向/纵向形态。容器查询只能作用于后代，卡片自身不参与查询结果，
 *   因此方向规则挂在卡片的后代（内容区/头像/名称）上。
 * - .pick-card-content 是尺寸单位容器（size）：cqw/cqh 即内容区实际可用
 *   宽高（无内边距，无歧义），供头像正方形边长推导。两种形态下内容区
 *   宽高均为确定值——基础形态由固定方形槽位决定，自适应形态由行内
 *   伸展决定。
 */
.pick-card {
  container-type: inline-size;
  container-name: pick-card;
}

/*
 * 自适应形态的角标内收（仅 .room-workspace）：卡片铺满行宽后，列表为纵向
 * 滚动容器，overflow-x 随之计算为 auto，基础形态的外扩偏移（-top-1
 * -left-1，4px）会被列表左/上边界裁切——每行首列、首行角标缺角。
 * 自适应卡片没有列内空隙可供外扩，因此把角标收进卡片可见范围的内角；
 * 数字、配色与层级不变。只读记录页/实时展示页不挂载 room-workspace，
 * 固定方槽沿用原有外扩定位。
 */
.room-workspace .pick-card-badge {
  top: 0;
  left: 0;
}

.pick-card-content {
  container-type: size;
}

/* 基础形态（记录/展示页）：头像填满方形槽位，不显示名称。 */
.pick-card-avatar {
  width: 100%;
  height: auto;
}

.pick-card-name {
  display: none;
}

/*
 * 自适应形态（.room-workspace 作用域）：默认纵向卡片。
 * 头像正方形边长 = min(内容区宽, 内容区高 − 两行名称预留, 头像上限)，
 * 保证双格窄卡与矮卡内头像与名称都完整可见；名称在下居中，两行截断。
 */
.room-workspace .pick-card-content {
  flex-direction: column;
  gap: 0.25rem;
}

.room-workspace .pick-card-avatar {
  width: min(100cqw, calc(100cqh - 2.25rem), var(--room-pick-avatar-max, 4.5rem));
  height: auto;
}

.room-workspace .pick-card-name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  flex-shrink: 0;
  width: 100%;
  text-align: center;
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-neutral-700);
}

/*
 * 卡片足够宽（单格行，阈值按卡片实际宽度触发，不依赖视口断点）：
 * 横向排布，头像按内容区高度成正方形、居左，名称占据余宽、左侧对齐、
 * 两行截断。双格行卡片宽度不足本查询，保持纵向。
 */
@container pick-card (min-width: 9rem) {
  .room-workspace .pick-card-content {
    flex-direction: row;
  }

  .room-workspace .pick-card-avatar {
    width: min(100cqh, var(--room-pick-avatar-max, 4.5rem));
  }

  .room-workspace .pick-card-name {
    flex: 1 1 0;
    min-width: 0;
    align-self: center;
    width: auto;
    text-align: left;
  }
}
</style>
