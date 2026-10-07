import type { RoomHttpFailure, RoomStatusView } from "./api";

/**
 * 首页「最近参与」清单的状态展示映射与时间文案。
 *
 * 状态来源是匿名公开读取（GET /api/rooms/:roomId，不带身份），只用于列出
 * 房间生命周期：live = 未归档（不等于有人在线或 BP 正在进行），archived =
 * 已归档（可查看只读记录，附服务端给出的到期日）。读取失败时按原因区分：
 * 真正的 404 表达「不存在或已过期」，其余（网络、超时、协议、服务端故障）
 * 一律「暂时无法确认」并保留进入与移除，可刷新重试，不能当成 404 自动删除。
 *
 * 记录方式（什么算参与）见 docs/specs/room-roles.md「本机参与记录」。
 */

export type RoomHistoryStatus =
  | { readonly kind: "live" }
  | { readonly kind: "archived"; readonly expiresAt: string }
  /** 服务端明确回答房间不存在或已过期。 */
  | { readonly kind: "missing" }
  /** 网络/超时/协议/服务端故障：不声称房间消失，可刷新重试。 */
  | { readonly kind: "unknown" };

/** 清单里一条记录可执行的操作。 */
export type RoomHistoryEntryAction = "enter" | "record" | "none";

export type RoomStatusResult =
  | { readonly ok: true; readonly value: RoomStatusView }
  | { readonly ok: false; readonly reason: RoomHttpFailure };

/** 把状态读取结果映射为展示状态。 */
export function roomHistoryStatusOf(result: RoomStatusResult): RoomHistoryStatus {
  if (result.ok) {
    return result.value.kind === "archived"
      ? { kind: "archived", expiresAt: result.value.expiresAt }
      : { kind: "live" };
  }
  return result.reason === "not-found" ? { kind: "missing" } : { kind: "unknown" };
}

export function roomHistoryStatusText(status: RoomHistoryStatus): string {
  switch (status.kind) {
    case "live":
      return "未归档";
    case "archived":
      return "已归档";
    case "missing":
      return "不存在或已过期";
    case "unknown":
      return "暂时无法确认";
  }
}

/** 已归档记录的到期提示；其余状态为 null。 */
export function roomHistoryExpiresText(status: RoomHistoryStatus): string | null {
  return status.kind === "archived" ? `记录保留至 ${formatLocalDate(status.expiresAt)}` : null;
}

/** 记录条目的主操作：live 进入房间，archived 查看记录，missing 无入口。 */
export function roomHistoryEntryAction(status: RoomHistoryStatus): RoomHistoryEntryAction {
  switch (status.kind) {
    case "live":
    case "unknown":
      return "enter";
    case "archived":
      return "record";
    case "missing":
      return "none";
  }
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** 最近参与时间：本机时区的「YYYY-MM-DD HH:mm」。 */
export function formatLocalDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${formatLocalDate(iso)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 到期日期：本机时区的「YYYY-MM-DD」。 */
export function formatLocalDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
