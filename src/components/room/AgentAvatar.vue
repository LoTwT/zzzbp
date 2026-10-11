<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ImageOff } from "@lucide/vue";
import type { AgentDisplayBase } from "../../room/room-catalog";

// 代理人图片：共用展示单元，以 variant 表达三种用途（不复制加载逻辑）——
// master：池内方图（384x384 母图）；thumb：顶部禁用区的 128 缩略图（方图
// 缺缩略图时回退母图）；wide：两侧选用区的宽幅裁切（object-fit: cover +
// 逐角色 object-position，同一母图）。方图素材按 cover 裁切；旧圆图与
// 外部图片按素材原比例完整 contain 展示，不裁切放大改变素材形状。
// 缺资源或加载失败走与素材协调的占位兜底（方图圆角、圆图圆形），名称
// 始终由外层展示（docs/specs/room-layout.md「代理人头像」）。展示按最小
// 信息声明依赖（AgentDisplayBase）：实时房间目录与归档快照（归档时固定
// 的名称与图片）共用同一实现。

const props = withDefaults(
  defineProps<{
    readonly agent: AgentDisplayBase | null;
    /** 无障碍名称前缀，与外层展示文案组合。 */
    readonly altName?: string;
    /** 图片用途：池内方图 / 禁用区缩略图 / 选用区宽幅裁切。 */
    readonly variant?: "master" | "thumb" | "wide";
  }>(),
  { variant: "master" },
);

const failed = ref(false);

/** 实际加载的图片地址（用途决定母图或缩略图）。 */
const src = computed<string | null>(() => {
  const image = props.agent?.image ?? null;
  if (image === null) return null;
  if (props.variant === "thumb" && image.thumbUrl !== null) return image.thumbUrl;
  return image.url;
});

// 失败状态随实际图片来源与用途变化恢复：同一代理人在不同用途/不同资源
// 修订下的 src 不同，仅监听 agent.id 会让切换后的图片停留在占位。
watch([() => props.variant, src], () => {
  failed.value = false;
});

/** 宽幅裁切位置：仅方图在 wide 用途下使用，其余居中。 */
const objectPosition = computed(() => {
  const image = props.agent?.image ?? null;
  if (props.variant === "wide" && image?.kind === "square" && image.crop !== null) {
    return `${image.crop.x}% ${image.crop.y}%`;
  }
  return "50% 50%";
});

/** 非方图素材按原比例完整展示（圆图/外部图片不裁切）。 */
const objectFit = computed(() => (props.agent?.image?.kind === "square" ? "cover" : "contain"));
</script>

<template>
  <span class="relative block size-full">
    <!-- 图片与占位都绝对定位：不向弹性行高贡献固有内容尺寸（选用区卡片
         的图片区域高度完全由行内伸展决定，img 的自然高度不参与测量）。 -->
    <img
      v-if="src !== null && !failed"
      :src="src"
      :alt="altName ?? `${agent?.name}头像`"
      class="absolute inset-0 size-full"
      :style="{ objectFit, objectPosition }"
      loading="lazy"
      decoding="async"
      @error="failed = true"
    />
    <!-- 缺资源/加载失败：与素材形状协调的占位（方图圆角、圆图圆形），
         名称仍由外层展示；失败后不自动重新热链未知外部资源。 -->
    <span
      v-else
      class="absolute inset-0 flex items-center justify-center bg-(--surface-subtle) text-(--text-muted)"
      :class="agent?.image?.kind === 'square' ? 'rounded-md' : 'rounded-full'"
      :title="agent === null ? '' : agent.name"
    >
      <ImageOff v-if="agent !== null" class="size-2/5" aria-hidden="true" />
    </span>
  </span>
</template>
