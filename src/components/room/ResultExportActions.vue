<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { ClipboardCopy, ImageDown } from "@lucide/vue";
import { formatResultText, type ExportResultSnapshot } from "../../room/result-export";
import { renderResultImagePng } from "../../room/result-image";

// BP 结果导出动作（docs/specs/room-layout.md「BP 结果导出」）：实时房间
// 控制面板与只读记录页的「显示与分享」共用。点击瞬间构建独立的公开
// 快照：文本按点击时内容复制；图片在异步渲染（字体/同源图片）后、触发
// 下载前校验来源仍一致（父级按导出内容指纹判定连接与结果），变化即
// 终止并提示重新导出，绝不混入新旧两版内容，也不在组件卸载后下载。
// 忙碌时阻止同一组件重复触发；失败均为可恢复提示，不后台自动重试。
// 剪贴板按浏览器能力两级回退（Clipboard API → execCommand），两条路径
// 都失败时在面板内给出可选择复制的完整文本并自动聚焦，不虚报成功；
// 临时节点与焦点恢复全部 try/finally 收口，组件卸载后不再触碰 DOM。

const props = defineProps<{
  /** 当前可导出的结果快照；不可用（未完成/未同步/名单未就绪）时为 null。 */
  readonly result: ExportResultSnapshot | null;
  /** 不可用的简短原因（result 为 null 时展示）；可用时为 null。 */
  readonly unavailableReason: string | null;
  /** 点击瞬间的来源指纹捕获（图片下载前的来源一致性校验基准）。 */
  readonly captureSource: () => unknown;
  /**
   * 下载前校验来源是否仍一致：返回 null 表示一致可下载，否则返回面向
   * 用户的简短原因（连接中断、结果已变化等），本次导出终止。
   */
  readonly sourceStaleness: (captured: unknown) => string | null;
}>();

type Busy = "text" | "image" | null;

const busy = ref<Busy>(null);
const copied = ref(false);
const failureText = ref<string | null>(null);
const staleText = ref<string | null>(null);
/** 剪贴板两条路径都失败时兜底展示的完整结果文本。 */
const textFallback = ref<string | null>(null);
/** 兜底文本框（自动聚焦并全选，键盘可直接复制）。 */
const fallbackTextareaEl = ref<HTMLTextAreaElement | null>(null);

let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
/** 下载后延迟回收的 Blob URL 及其计时器（卸载时一并清理）。 */
const pendingRevokes = new Map<ReturnType<typeof setTimeout>, string>();

onBeforeUnmount(() => {
  disposed = true;
  if (copiedResetTimer !== null) clearTimeout(copiedResetTimer);
  for (const [timer, url] of pendingRevokes) {
    clearTimeout(timer);
    // 下载已在点击时同步触发，浏览器已取得 Blob；回收 URL 不影响已开始的下载。
    URL.revokeObjectURL(url);
  }
  pendingRevokes.clear();
});

const disabled = computed(() => busy.value !== null || props.result === null);

function resetFeedback(): void {
  copied.value = false;
  failureText.value = null;
  staleText.value = null;
  textFallback.value = null;
  if (copiedResetTimer !== null) {
    clearTimeout(copiedResetTimer);
    copiedResetTimer = null;
  }
}

function markCopied(): void {
  copied.value = true;
  copiedResetTimer = setTimeout(() => {
    copied.value = false;
    copiedResetTimer = null;
  }, 2000);
}

/** 剪贴板写入结果：成功标记 + 旧路径打断焦点前的用户焦点目标。 */
interface ClipboardOutcome {
  readonly copied: boolean;
  /**
   * 旧路径 select() 抢占焦点之前、用户主动聚焦的目标（等待期间移到的
   * 新控件，如复制房间链接按钮）：恢复焦点时优先于最初触发按钮。
   * 非交互容器（见 isUserFocusTarget）不带回；
   * native 路径不打断焦点，为 null。
   */
  readonly focusTarget: HTMLElement | null;
}

/**
 * 用户可通过键盘或点击自然聚焦的交互控件。
 *
 * 面板打开时主动聚焦 tabindex="-1" 的 aside；WebKit 中鼠标点击按钮
 * 不一定把焦点移到按钮，复制期间 activeElement 可能仍是该容器。
 * 容器不能当作用户选择的新控件，否则复制后会保留或恢复到容器，
 * 无法回到触发按钮。此判断同时用于旧路径捕获与复制完成后的恢复。
 */
function isUserFocusTarget(element: HTMLElement): boolean {
  if (element.isContentEditable) return true;
  switch (element.tagName) {
    case "BUTTON":
    case "INPUT":
    case "TEXTAREA":
    case "SELECT":
    case "A":
      return true;
    default: {
      const tabIndex = Number.parseInt(element.getAttribute("tabindex") ?? "", 10);
      return Number.isNaN(tabIndex) ? false : tabIndex >= 0;
    }
  }
}

/**
 * 两级剪贴板写入：Clipboard API 失败（权限/安全上下文拒绝）时回退
 * execCommand；两条路径都以真实结果返回，失败不虚报成功。
 * （不使用 @vueuse 的 useClipboard：其 copy 内部吞掉失败并恒置
 * copied=true，无法满足「成功反馈不虚报」。）
 *
 * 旧路径的临时节点在 try/finally 立即回收，不留隐藏节点。临时节点被
 * 移除后焦点会落到 BODY：此刻触发按钮仍因 busy 禁用、focus() 无效，
 * 因此真正的焦点恢复由调用方在 busy 清除、DOM 更新后兜底（见
 * copyResultText），这里只带回 select() 打断前的焦点目标。非用户目标
 * 的容器（见 isUserFocusTarget）不作为恢复目标带回。
 * isAborted 在 await 之后、创建任何 DOM 之前检查：组件已卸载时不再
 * 创建隐藏节点或触碰新页面焦点。
 */
async function copyTextToClipboard(
  text: string,
  isAborted: () => boolean,
): Promise<ClipboardOutcome> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return { copied: true, focusTarget: null };
    }
  } catch {
    // 权限或安全上下文拒绝：回退旧路径。
  }
  if (isAborted()) return { copied: false, focusTarget: null };
  // select() 会把焦点抢到临时节点：先记下当时有意义的焦点目标——
  // 它可能是用户在等待期间主动移到的新目标，恢复时优先于触发按钮。
  // 非用户目标（BODY 或非交互容器）不带回复原目标，恢复时回落到
  // 触发按钮。
  const activeBeforeLegacy = document.activeElement;
  const focusBeforeLegacy =
    activeBeforeLegacy instanceof HTMLElement &&
    activeBeforeLegacy !== document.body &&
    isUserFocusTarget(activeBeforeLegacy)
      ? activeBeforeLegacy
      : null;
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  let copiedViaLegacy = false;
  try {
    scratch.select();
    copiedViaLegacy = document.execCommand("copy");
  } catch {
    copiedViaLegacy = false;
  } finally {
    scratch.remove();
  }
  return { copied: copiedViaLegacy, focusTarget: focusBeforeLegacy };
}

async function copyResultText(event: MouseEvent): Promise<void> {
  if (disabled.value || props.result === null) return;
  const snapshot = props.result; // 点击瞬间的快照，文本内容不再随后续变化。
  // 触发元素以事件目标为准，而非 activeElement：Safari/WebKit 的鼠标点击
  // 不给按钮聚焦，点击时 activeElement 可能仍是面板容器或先前的控件；
  // 事件目标在任何引擎下都是被激活的按钮本身（键盘 Enter 同样成立）。
  // currentTarget 仅在事件派发期间有效，必须在进入异步前同步捕获。
  const triggerElement =
    event.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  busy.value = "text";
  resetFeedback();
  let outcome: ClipboardOutcome | null = null;
  try {
    const text = formatResultText(snapshot);
    outcome = await copyTextToClipboard(text, () => disposed);
    if (outcome.copied) {
      // await 返回时组件可能已卸载：不再启动已无意义的反馈定时器。
      if (!disposed) markCopied();
    } else if (!disposed) {
      // 卸载后不再创建兜底 UI 或抢占新页面焦点。
      failureText.value = "复制失败，请手动复制下方文本";
      textFallback.value = text;
      // 键盘可达：兜底文本框渲染后自动聚焦（focus 触发全选），可直接复制。
      void nextTick(() => {
        if (!disposed) fallbackTextareaEl.value?.focus();
      });
    }
  } finally {
    busy.value = null;
  }
  // 复制成功后的焦点收口：等 busy 清除且 Vue 完成 DOM 更新（触发按钮
  // 重新启用，focus() 才有效）。仅当焦点当前不在用户可聚焦的目标上
  // （BODY 或 tabindex="-1" 的非交互容器）才恢复；焦点已在其他交互
  // 控件上时不抢回。失败路径的焦点由兜底文本框接管（其聚焦
  // 发生在同一 DOM 更新之后，不受影响）。恢复优先级：旧路径打断前的
  // 最新用户目标（等待期间主动移焦的目标）> 最初触发按钮。
  if (outcome !== null && outcome.copied) {
    await nextTick();
    // nextTick 期间组件可能被卸载（面板关闭/页面离开）：再核对一次。
    const active = document.activeElement;
    const focusDisplaced =
      active === null ||
      active === document.body ||
      (active instanceof HTMLElement && !isUserFocusTarget(active));
    if (!disposed && focusDisplaced) {
      const target = outcome.focusTarget ?? triggerElement;
      if (target !== null && target.isConnected) target.focus();
    }
  }
}

/** 导出文件名：BP结果-房间名.png；非法文件名字符与过长名称收敛。 */
function downloadFileName(snapshot: ExportResultSnapshot): string {
  const sanitized = Array.from(snapshot.roomName)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      // 控制字符（含换行/制表）与路径/通配等文件名保留字符替换为空格。
      return code <= 0x1f || '\\/:*?"<>|'.includes(char) ? " " : char;
    })
    .join("")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40);
  return sanitized === "" ? "BP结果.png" : `BP结果-${sanitized}.png`;
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Blob URL 延迟回收：下载已由点击触发，浏览器已引用该 Blob。
  const timer = setTimeout(() => {
    URL.revokeObjectURL(url);
    pendingRevokes.delete(timer);
  }, 60_000);
  pendingRevokes.set(timer, url);
}

async function downloadResultImage(): Promise<void> {
  if (disabled.value || props.result === null) return;
  const snapshot = props.result; // 点击瞬间的快照，渲染内容不随后续变化混排。
  const capturedSource = props.captureSource();
  busy.value = "image";
  resetFeedback();
  try {
    const blob = await renderResultImagePng(snapshot);
    if (disposed) return; // 组件已卸载（面板关闭/页面离开）：终止本次下载。
    const staleness = props.sourceStaleness(capturedSource);
    if (staleness !== null) {
      staleText.value = staleness;
      return;
    }
    triggerDownload(blob, downloadFileName(snapshot));
  } catch {
    // 画布不可用或 PNG 编码失败：可恢复失败，用户可明确重试。
    failureText.value = "图片生成失败，请重试";
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <!-- 两个导出动作 + 不可用原因/反馈。禁用态沿用项目约定：无 hover/按压反馈。 -->
  <div class="flex flex-col gap-2">
    <button
      type="button"
      class="flex items-center gap-2 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium focus-ring enabled:hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="disabled"
      @click="copyResultText($event)"
    >
      <ClipboardCopy class="size-4 text-(--text-muted)" aria-hidden="true" />
      {{ busy === "text" ? "正在复制…" : copied ? "已复制" : "复制结果文本" }}
    </button>
    <button
      type="button"
      class="flex items-center gap-2 rounded-lg border border-(--border-default) px-3 py-2 text-sm font-medium focus-ring enabled:hover:bg-(--surface-subtle) disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="disabled"
      @click="downloadResultImage"
    >
      <ImageDown class="size-4 text-(--text-muted)" aria-hidden="true" />
      {{ busy === "image" ? "正在生成图片…" : "下载结果图片" }}
    </button>
    <p v-if="result === null && unavailableReason !== null" class="text-xs text-(--text-muted)">
      {{ unavailableReason }}
    </p>
    <p v-if="staleText !== null" class="text-xs text-(--status-warning-fg)" role="status">
      {{ staleText }}
    </p>
    <p v-if="failureText !== null" class="text-xs text-(--status-danger-fg)" role="alert">
      {{ failureText }}
    </p>
    <!-- 剪贴板两条路径都失败：面板内给出可选择复制的完整文本，不丢失结果。
         固定行数 + 禁止拖拽缩放（内部滚动），避免把 shrink-0 分享底栏撑破。 -->
    <textarea
      v-if="textFallback !== null"
      ref="fallbackTextareaEl"
      :value="textFallback"
      rows="6"
      readonly
      aria-label="结果文本"
      class="w-full resize-none overflow-y-auto rounded-lg border border-(--border-default) bg-(--surface-elevated) p-2 text-xs leading-5 text-(--text-secondary) focus-ring"
      @focus="($event.target as HTMLTextAreaElement).select()"
    />
  </div>
</template>
