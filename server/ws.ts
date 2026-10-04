import type { RoomCommand } from "../shared/commands";
import type { CommandResultMessage, WebSocketNoticeCode } from "../shared/contracts/websocket";
import type { DisplayView, HostManagementView, RoomMemberView } from "../shared/contracts/views";
import { roomIdSchema } from "../shared/ids";

/**
 * 房间 WebSocket 协议层的纯辅助：路径解析、消息边界、附件与标签结构、
 * 服务端消息序列化与命令载荷的规范化。
 *
 * 连接生命周期、命令执行与广播编排在 server/room.ts；这里只提供无副作用
 * 的协议构件，便于独立校验与复用。
 */

/**
 * 客户端消息的字节上限：8 KiB，与 HTTP JSON 请求体上限一致。
 *
 * 命令载荷本身远小于该值（最长的预选命令约几百字节）；超限消息在解析前
 * 拒绝并关闭连接（1009），避免为任意大小的帧付出 JSON 解析成本。字节数
 * 按实际 UTF-8 编码计算，字符数快速预检只是第一道界。
 */
export const MAX_WS_MESSAGE_BYTES = 8 * 1024;

/**
 * 每房间保留的 operationId 去重回执条数上限（按写入顺序保留最近若干条）。
 *
 * 这是回执窗口的边界：回执只保证「重发不重复执行、返回原结果」在窗口内
 * 成立；窗口外被淘汰后，重发按新命令处理，由 expectedBpVersion 版本门与
 * 命令幂等性兜底（任何推进状态的命令都会递增 bp.version，使重发过期）。
 * 一整局 BP 约 50–200 条命令，2048 条覆盖十余局，够用且不会显著占存储。
 */
export const COMMAND_RECEIPT_RETENTION = 2048;

/**
 * 连接附件：随 WebSocket Hibernation 持久化的连接身份（16 KiB 结构化克隆）。
 *
 * - member：升级时经 Cookie 凭据验证的成员身份；命令操作者只来自这里，
 *   不从消息载荷读取，也不缓存任何权限（角色/席位每次从房间状态重新
 *   判断）。
 * - display：展示连接，无身份、只读、不计在线、不影响保留计时；即使
 *   升级请求携带有效房主 Cookie 也按 display 处理。
 * - rejected：升级已被接受但即将以通知拒绝并关闭的连接（房间不存在、
 *   已归档、凭据无效）。为让拒绝通知可靠送达，这类连接同样经
 *   acceptWebSocket 接入，关闭事件按附件识别后忽略。
 */
export type WsAttachment =
  | { readonly kind: "member"; readonly memberId: string }
  | { readonly kind: "display" }
  | { readonly kind: "rejected" };

/** 成员连接的查询标签：`m:` 前缀 + 成员 ID，用于按成员计数在线连接。 */
export function memberTag(memberId: string): string {
  return `m:${memberId}`;
}

/** 展示连接的查询标签：广播与统计时与成员连接区分。 */
export const DISPLAY_TAG = "d";

/** 防御性读取附件：结构不符（含损坏或未知形态）时返回 null。 */
export function readAttachment(ws: WebSocket): WsAttachment | null {
  let raw: unknown;
  try {
    raw = ws.deserializeAttachment();
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === "display") return { kind: "display" };
  if (value.kind === "rejected") return { kind: "rejected" };
  if (value.kind === "member" && typeof value.memberId === "string") {
    return { kind: "member", memberId: value.memberId };
  }
  return null;
}

/**
 * 解析房间 WebSocket 升级路径；不属于本房间的两个端点时返回 null。
 *
 * 只接受精确形态 `/api/rooms/:roomId/ws`（成员）与
 * `/api/rooms/:roomId/display/ws`（展示）；roomId 需解码并通过 schema
 * 校验，且与本 DO 实例的房间名一致（Worker 按该名字路由，直接调用时
 * 防御性拒绝错配）。
 */
export function parseWebSocketPath(
  pathname: string,
  ownRoomId: string,
): { channel: "member" | "display"; roomId: string } | null {
  const prefix = "/api/rooms/";
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname.slice(prefix.length).split("/");
  const channel =
    segments.length === 2 && segments[1] === "ws"
      ? ("member" as const)
      : segments.length === 3 && segments[1] === "display" && segments[2] === "ws"
        ? ("display" as const)
        : null;
  if (channel === null) return null;

  let decodedRoomId: string;
  try {
    decodedRoomId = decodeURIComponent(segments[0] ?? "");
  } catch {
    return null;
  }
  const parsed = roomIdSchema.safeParse(decodedRoomId);
  if (!parsed.success || parsed.data !== ownRoomId) return null;
  return { channel, roomId: parsed.data };
}

/** 连接通知消息（webSocketNoticeMessageSchema 形态）的 JSON 文本。 */
export function noticeMessage(code: WebSocketNoticeCode, message: string): string {
  return JSON.stringify({ kind: "notice", code, message });
}

/** 命令结果消息（commandResultMessageSchema 形态）的 JSON 文本。 */
export function commandResultMessage(message: CommandResultMessage): string {
  return JSON.stringify(message);
}

/** 成员视图消息的 JSON 文本。 */
export function memberViewMessage(view: RoomMemberView): string {
  return JSON.stringify({ kind: "memberView", view });
}

/** 房主管理视图消息的 JSON 文本。 */
export function hostViewMessage(view: HostManagementView): string {
  return JSON.stringify({ kind: "hostView", view });
}

/** 展示视图消息的 JSON 文本。 */
export function displayViewMessage(view: DisplayView): string {
  return JSON.stringify({ kind: "displayView", view });
}

/**
 * 命令载荷的规范化 JSON：递归按码点排序对象键，再序列化。
 *
 * 去重回执以该形态比较「同一载荷」：客户端重发时 JSON 键顺序不同不算
 * 不同载荷；输入先经 roomCommandSchema 解析（未知字段剥离、字符串
 * trim），规范化比较在解析后的可信结构上进行。
 */
export function canonicalCommandJson(command: RoomCommand): string {
  return stableStringify(command);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys.map((key) => {
    const encoded = stableStringify((value as Record<string, unknown>)[key]);
    return `${JSON.stringify(key)}:${encoded}`;
  });
  return `{${body.join(",")}}`;
}

/** 文本消息的 UTF-8 字节数；调用方先用字符数做快速预检。 */
export function messageByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
