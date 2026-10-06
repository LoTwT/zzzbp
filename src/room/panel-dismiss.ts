import { onBeforeUnmount, onMounted } from "vue";

/**
 * 控制面板的外部点击关闭（docs/specs/room-layout.md「控制面板」）。
 *
 * 面板是非模态覆盖层：点击面板之外收起面板，实时房间与只读记录页
 * 语义一致（房主、选手、观众共用同一入口）。闭合行为有三条约束：
 *
 * - 首次外部点击只收起面板：同一次手势产生的 click 在捕获阶段被吞掉，
 *   不再触发底层的代理人预选、确认提交等操作。
 * - 入口按钮由 [data-panel-entry] 标记识别：点击入口的开关语义完全由
 *   入口自身处理，不会被外部监听「先关后开」。
 * - 面板内部（含子视图）与入口都不触发外部关闭；关闭按钮与 Esc 的
 *   语义由组件自身保留。
 */

/** 面板入口按钮的标记属性：外部点击判定时视为面板自身的一部分。 */
export const PANEL_ENTRY_ATTRIBUTE = "data-panel-entry";

/**
 * 同一次手势的 click 与 pointerdown 的位置容差与等待上限。
 *
 * 位置容差用于确认 click 与 pointerdown 属于同一次手势（指针在按下与
 * 抬起之间没有移开），等待上限避免空闲监听器长期驻留。
 */
const SUPPRESS_RADIUS_PX = 4;
const SUPPRESS_WINDOW_MS = 700;

/** 目标是否属于面板或面板入口。 */
function isPanelTarget(target: EventTarget | null, panel: HTMLElement | null): boolean {
  if (!(target instanceof Element)) return false;
  if (panel !== null && panel.contains(target)) return true;
  return target.closest(`[${PANEL_ENTRY_ATTRIBUTE}]`) !== null;
}

/**
 * 吞掉同一次手势产生的 click。
 *
 * 面板在 pointerdown 时立即收起并卸载，因此这里不依赖组件生命周期：
 * 监听器挂在 window 捕获阶段、只生效一次，并按按下位置与时间窗口匹配，
 * 既保证同一次手势的 click 不落到下层（面板卸载不影响判定），也不会
 * 顺带吞掉之后在别处发生的点击。
 */
function suppressGestureClick(point: { readonly x: number; readonly y: number }): void {
  const deadline = Date.now() + SUPPRESS_WINDOW_MS;
  function onClickCapture(event: MouseEvent): void {
    window.removeEventListener("click", onClickCapture, true);
    if (Date.now() > deadline) return;
    if (
      Math.abs(event.clientX - point.x) > SUPPRESS_RADIUS_PX ||
      Math.abs(event.clientY - point.y) > SUPPRESS_RADIUS_PX
    ) {
      return;
    }
    // 首次外部点击只收起面板：阻止同一次手势继续触发底层操作。
    event.stopPropagation();
    event.preventDefault();
  }
  window.addEventListener("click", onClickCapture, true);
}

export interface PanelDismissOptions {
  /** 面板根元素；面板未挂载时为 null。 */
  readonly panel: () => HTMLElement | null;
  /** 判定为外部点击时收起面板（含焦点返回，由调用方定义）。 */
  readonly close: () => void;
}

export function usePanelDismiss(options: PanelDismissOptions): void {
  function onPointerDown(event: PointerEvent): void {
    const panel = options.panel();
    if (panel === null || isPanelTarget(event.target, panel)) return;
    suppressGestureClick({ x: event.clientX, y: event.clientY });
    options.close();
  }

  onMounted(() => {
    window.addEventListener("pointerdown", onPointerDown, true);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("pointerdown", onPointerDown, true);
  });
}
