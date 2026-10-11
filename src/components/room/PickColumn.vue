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
// 选用卡片为矩形图片展示（三个页面一致）：卡片随所在行的真实可用宽高
// 伸展，图片区域占满名称条以上的全部空间——方图母图按 object-fit: cover
// 与逐角色 object-position 裁成宽幅（左右共用素材、不做人物镜像）；旧
// 圆图按原比例完整 contain 展示。名称条固定在图片下方（面板底色保证可
// 读，占用范围计入脸部安全区校准），单行截断并以悬停提示补全；九行在
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
            class="pick-card relative flex h-[var(--room-pick-card-h,2.75rem)] min-h-0 w-[var(--room-pick-card-w,2.75rem)] min-w-0 flex-[var(--room-pick-card-flex,0_0_auto)] flex-col self-stretch overflow-hidden rounded-md border bg-(--surface-panel)"
            :class="slot.active ? 'border-(--accent-primary)' : 'border-(--border-default)'"
          >
            <div
              v-if="slot.active"
              class="pointer-events-none absolute inset-0 rounded-md ring-1 ring-(--accent-primary)"
              :class="{ 'slot-breathe': breathing }"
              aria-hidden="true"
            />
            <template v-if="slot.agent !== null">
              <!-- 矩形图片区域：占满名称条以上的全部空间，方图按逐角色
                   object-position 裁切（wide 用途），旧圆图完整 contain。 -->
              <div class="relative min-h-0 w-full flex-1">
                <AgentAvatar :agent="slot.agent" variant="wide" />
              </div>
              <span class="pick-card-name" :title="slot.agent.name">{{ slot.agent.name }}</span>
              <span class="sr-only"
                >第 {{ slot.step.sideOrdinal }} 个选用：{{ slot.agent.name }}</span
              >
            </template>
            <template v-else-if="slot.active && preselectAgent !== null">
              <div class="relative min-h-0 w-full flex-1">
                <AgentAvatar :agent="preselectAgent" variant="wide" />
              </div>
              <span class="pick-card-name" :title="preselectAgent.name">{{
                preselectAgent.name
              }}</span>
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
 * 名称条：固定在矩形图片下方，面板底色保证任何素材上的可读性（占用范围
 * 已计入宽幅裁切的脸部安全区校准）。单行截断防溢出，完整名称由悬停提示
 * 补全；字号贴合窄列（展示页/记录页 120px 列宽）下的最长官方名称。
 */
.pick-card-name {
  flex-shrink: 0;
  width: 100%;
  padding: 0 0.25rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 0.6875rem;
  line-height: 0.9375rem;
  padding-top: 0.125rem;
  padding-bottom: 0.1875rem;
  text-align: center;
  color: var(--text-secondary);
}
</style>
