/** 剪贴板写入结果：成功标记 + 旧路径打断焦点前的用户焦点目标。 */
export interface ClipboardOutcome {
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
export function isUserFocusTarget(element: HTMLElement): boolean {
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
 * （不使用 @vueuse 的 useClipboard：其 legacy 路径忽略 execCommand 的
 * false 结果并置 copied=true，无法满足「成功反馈不虚报」。）
 *
 * 旧路径的临时节点在 try/finally 立即回收，不留隐藏节点。临时节点被
 * 移除后焦点会落到 BODY：此刻触发按钮仍因 busy 禁用、focus() 无效，
 * 因此真正的焦点恢复由调用方在 busy 清除、DOM 更新后兜底（见
 * 调用组件），这里只带回 select() 打断前的焦点目标。非用户目标
 * 的容器（见 isUserFocusTarget）不作为恢复目标带回。
 * isAborted 在 await 之后、创建任何 DOM 之前检查：组件已卸载时不再
 * 创建隐藏节点或触碰新页面焦点。
 */
export async function copyTextToClipboard(
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
