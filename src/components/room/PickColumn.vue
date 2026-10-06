<script setup lang="ts">
import { computed } from "vue";
import type { AgentDisplayBase } from "../../room/room-catalog";
import { pickRoundBreakIndex } from "../../room/pick-layout";
import type { PickSlotView } from "../../room/view-projections";
import AgentAvatar from "./AgentAvatar.vue";

// 一方选用区：九格竖排（行结构由 pickSlotRows 从 BP_STEPS 推导），每行
// 1 个槽位，不加 A/B 前缀、昵称或「你」标记；队伍标识显示在顶部禁用区
// 旁（RoomHeader），选用区只承载槽位，因此与中央代理人池区同高。
// 当前操作位是本方选用时进入 active，公开预选直接展示在当前槽位；
// 槽位不显示数字角标（顺序仍由 sr-only 文案表达，服务读屏）。
//
// 两轮选用（每方前 6 位与后 3 位）之间以横线分隔：边界按权威操作位的
// 本方选用序号推导（pickRoundBreakIndex），落在第 6、7 格之间；实时
// 房间、展示页与记录页共用本组件，三个页面的分隔一致。
//
// 选用卡片为自适应填充形态（三个页面一致）：卡片随所在行的真实可用
// 宽高伸展，按卡片实际宽度经容器查询切换排布——宽卡横向（头像 1:1 居左
// + 名称在侧），窄卡纵向（头像在上 + 名称在下）。头像保持正方形不拉伸，
// 尺寸设上限（--room-pick-avatar-max），不为填满空间无限放大；九行在
// 列高内伸展，两侧选用区与中央区域上下同高。

const props = defineProps<{
  readonly rows: ReadonlyArray<ReadonlyArray<PickSlotView>>;
  readonly preselectAgent: AgentDisplayBase | null;
  readonly breathing: boolean;
  readonly sideText: string;
}>();

/** 两轮选用之间的分隔位置（其前插入横线）；-1 表示不显示。 */
const roundBreakIndex = computed(() => pickRoundBreakIndex(props.rows));
</script>

<template>
  <section class="flex min-h-0 w-full flex-col items-center" :aria-label="`${sideText}选用区`">
    <!-- 列表容器显式占满列宽：自适应卡片的 flex 基准为 0（宽度来自行内
         伸展），不再提供固有宽度，容器必须由列宽决定（w-full）。 -->
    <div
      class="flex min-h-0 w-full flex-1 flex-col justify-start gap-[var(--room-pick-gap,0.375rem)] overflow-y-auto py-0.5"
    >
      <template v-for="(row, rowIndex) in rows" :key="rowIndex">
        <span
          v-if="rowIndex === roundBreakIndex"
          class="h-px w-full shrink-0 bg-(--border-strong)"
          data-round-break="pick"
          aria-hidden="true"
        />
        <div
          class="flex shrink-0 grow-[var(--room-pick-row-grow,0)] items-center justify-center gap-[var(--room-pick-gap,0.375rem)]"
        >
          <div
            v-for="slot in row"
            :key="slot.slotId"
            :data-slot-id="slot.slotId"
            class="pick-card relative flex h-[var(--room-pick-card-h,2.75rem)] w-[var(--room-pick-card-w,2.75rem)] min-w-0 flex-[var(--room-pick-card-flex,0_0_auto)] flex-col items-center justify-center self-stretch rounded-md border bg-(--surface-panel) p-0.5"
            :class="slot.active ? 'border-(--accent-primary)' : 'border-(--border-default)'"
          >
            <div
              v-if="slot.active"
              class="absolute inset-0 rounded-md ring-1 ring-(--accent-primary)"
              :class="{ 'slot-breathe': breathing }"
              aria-hidden="true"
            />
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
      </template>
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
 *   宽高（无内边距，无歧义），供头像正方形边长推导；卡片随行内宽高
 *   伸展，内容区宽高为确定值。
 */
.pick-card {
  container-type: inline-size;
  container-name: pick-card;
}

.pick-card-content {
  container-type: size;
}

/*
 * 默认纵向卡片：头像正方形边长 = min(内容区宽, 内容区高 − 两行名称预留,
 * 头像上限)，保证窄卡与矮卡内头像与名称都完整可见；名称在下居中，
 * 两行截断。
 */
.pick-card-content {
  flex-direction: column;
  gap: 0.25rem;
}

.pick-card-avatar {
  width: min(100cqw, calc(100cqh - 2.25rem), var(--room-pick-avatar-max, 4.5rem));
  height: auto;
}

.pick-card-name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  flex-shrink: 0;
  width: 100%;
  text-align: center;
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--text-secondary);
}

/*
 * 卡片足够宽（阈值按卡片实际宽度触发，不依赖视口断点）：横向排布，
 * 头像按内容区高度成正方形、居左，名称占据余宽、左侧对齐、两行截断。
 */
@container pick-card (min-width: 9rem) {
  .pick-card-content {
    flex-direction: row;
  }

  .pick-card-avatar {
    width: min(100cqh, var(--room-pick-avatar-max, 4.5rem));
  }

  .pick-card-name {
    flex: 1 1 0;
    min-width: 0;
    align-self: center;
    width: auto;
    text-align: left;
  }
}
</style>
