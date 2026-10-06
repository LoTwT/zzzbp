import { onBeforeUnmount, onMounted } from "vue";

/**
 * 控制面板的外部点击关闭（docs/specs/room-layout.md「控制面板」）。
 *
 * 面板是非模态覆盖层：点击面板之外收起面板，实时房间与只读记录页
 * 语义一致（房主、选手、观众共用同一入口）。闭合行为有三条约束：
 *
 * - 首次外部点击只收起面板：同一次手势产生的 click 在捕获阶段被吞掉，
 *   不再触发底层的代理人预选、确认提交等操作；判定只看指针生命周期，
 *   长按与按下后移动都不放过。
 * - 入口按钮由 [data-panel-entry] 标记识别：点击入口的开关语义完全由
 *   入口自身处理，不会被外部监听「先关后开」。
 * - 面板内部（含子视图）与入口都不触发外部关闭；关闭按钮与 Esc 的
 *   语义由组件自身保留。
 */

/** 面板入口按钮的标记属性：外部点击判定时视为面板自身的一部分。 */
export const PANEL_ENTRY_ATTRIBUTE = "data-panel-entry";

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
 * 监听器挂在 window 捕获阶段并只生效一次。判定“同一次手势”只看指针
 * 生命周期，不看时长或位移：按下后抬起（无论按多久、在同一次按下内移动
 * 多远）生成的那个 click 就是要吞掉的目标；拖拽滚动等没有抬起配对的
 * 手势不吞，新手势（新的 pointerdown）或 pointercancel 会立即放弃拦截，
 * 避免误吞之后的点击。键盘触发的 click（detail 为 0）不吞。
 */
function suppressGestureClick(pointerId: number): void {
  let released = false;

  function cleanup(): void {
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerCancel, true);
    window.removeEventListener("pointerdown", onNextPointerDown, true);
    window.removeEventListener("click", onClickCapture, true);
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId === pointerId) released = true;
  }

  function onPointerCancel(event: PointerEvent): void {
    if (event.pointerId === pointerId) cleanup();
  }

  /** 新的手势开始：放弃上一次未消费的拦截，避免影响后续点击。 */
  function onNextPointerDown(): void {
    cleanup();
  }

  function onClickCapture(event: MouseEvent): void {
    cleanup();
    // 未正常抬起（手势被打断）或键盘触发（detail 为 0）时不吞。
    if (!released || event.detail === 0) return;
    // 首次外部点击只收起面板：阻止同一次手势继续触发底层操作。
    event.stopPropagation();
    event.preventDefault();
  }

  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
  window.addEventListener("pointerdown", onNextPointerDown, true);
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
    suppressGestureClick(event.pointerId);
    options.close();
  }

  onMounted(() => {
    window.addEventListener("pointerdown", onPointerDown, true);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("pointerdown", onPointerDown, true);
  });
}
