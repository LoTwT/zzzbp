/**
 * 与操作入口可见性解耦的挂起操作反馈文案。
 *
 * 操作位轮到对方、BP 完成、成员被换下或面板按钮因状态切换消失后，
 * 对应的操作入口（确认按钮、比赛控制按钮、席位行按钮）按角色/状态
 * 规则隐藏，但该成员已发出的命令仍可能处于提交中或「结果未知、
 * 正在核对」阶段——反馈必须继续可见（docs/specs/room-layout.md
 * 「禁选确认按钮」：结果未知时先显示核对提示，重连同步后再确定
 * 结果）。入口自身可见时由入口按钮标签展示同一状态，不重复提示。
 */

/**
 * 挂起操作的反馈文案；无挂起命令为 null。
 * `checking` 表示结果未知、正在按协议核对（回执超时或连接中断）。
 */
export function pendingOperationText(pending: boolean, checking: boolean): string | null {
  if (!pending) return null;
  return checking ? "正在核对上一操作结果…" : "上一操作提交中…";
}
