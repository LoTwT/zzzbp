import type { ApiErrorResponseBody } from "../../shared/contracts/http";
import {
  apiErrorResponseBodySchema,
  createRoomRequestSchema,
  createRoomResponseSchema,
  joinRoomRequestSchema,
  joinRoomResponseSchema,
  roomCatalogResponseSchema,
  roomEntryResponseSchema,
} from "../../shared/contracts/http";
import type { AgentCatalogData } from "../../shared/agents/schema";
import type { RoomMemberView } from "../../shared/contracts/views";

/**
 * 房间 HTTP 客户端：建房、读取房间、加入成员与目录快照。
 *
 * 浏览器凭据只依赖同源 HttpOnly Cookie 的自动携带，代码不读取、不保存
 * 任何身份秘密（边界见 docs/architecture.md「身份与凭据边界」）。所有
 * 响应都经共享 schema 校验后再交给调用方；失败以判别结果返回，不抛出
 * 供 UI 捕获的异常，调用方据此保留输入并提示。
 */

/** 房间 HTTP 层失败原因。 */
export type RoomHttpFailure =
  | "not-found"
  /** 房间已归档：PR9 前读取归档分支是防御实现，界面按不可进入处理。 */
  | "archived"
  /** 请求体未通过共享 schema（客户端已预检，正常流程不应出现）。 */
  | "invalid"
  | "network";

/** 统一的判别结果。 */
export type RoomHttpResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: RoomHttpFailure;
    };

/** 解析 JSON 响应体；非 JSON 或结构不符按 network 处理（服务端合同外响应）。 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("non-json response");
  }
}

/** 把非 2xx 响应转换为失败原因。 */
async function failureOfResponse(response: Response): Promise<RoomHttpFailure> {
  const body = apiErrorResponseBodySchema.safeParse(await readJson(response).catch(() => null));
  if (body.success) {
    switch (body.data.error.code) {
      case "ROOM_NOT_FOUND":
        return "not-found";
      case "ROOM_ARCHIVED":
        return "archived";
      default:
        return "invalid";
    }
  }
  return response.ok ? "network" : "invalid";
}

/** 网络层异常（连接失败、中断、超时）统一折叠为 network。 */
async function requestJson(input: string, init: RequestInit): Promise<RoomHttpResult<unknown>> {
  try {
    const response = await fetch(input, init);
    if (!response.ok) {
      return { ok: false, reason: await failureOfResponse(response) };
    }
    return { ok: true, value: await readJson(response) };
  } catch {
    return { ok: false, reason: "network" };
  }
}

/** `POST /api/rooms`：建房并直接成为房主；成功返回房间 ID。 */
export async function createRoom(input: {
  readonly roomName: string;
  readonly nickname: string;
}): Promise<RoomHttpResult<{ readonly roomId: string }>> {
  const body = createRoomRequestSchema.safeParse(input);
  if (!body.success) return { ok: false, reason: "invalid" };
  const response = await requestJson("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body.data),
  });
  if (!response.ok) return response;
  const parsed = createRoomResponseSchema.safeParse(response.value);
  return parsed.success
    ? { ok: true, value: { roomId: parsed.data.roomId } }
    : { ok: false, reason: "network" };
}

/**
 * `GET /api/rooms/:roomId`：读取房间入口。
 *
 * live 且携带有效身份时返回成员视图（刷新恢复角色）；匿名返回 null，
 * 由页面渲染首次入房表单。归档房间按 archived 返回（PR9 接入只读记录）。
 */
export async function fetchRoomEntry(
  roomId: string,
): Promise<
  RoomHttpResult<{ readonly roomName: string; readonly memberView: RoomMemberView | null }>
> {
  const response = await requestJson(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: "GET",
  });
  if (!response.ok) return response;
  const parsed = roomEntryResponseSchema.safeParse(response.value);
  if (!parsed.success) return { ok: false, reason: "network" };
  if (parsed.data.kind === "archived") return { ok: false, reason: "archived" };
  return {
    ok: true,
    value: { roomName: parsed.data.roomName, memberView: parsed.data.memberView },
  };
}

/** `POST /api/rooms/:roomId/members`：首次入房（新观众身份）。 */
export async function joinRoom(
  roomId: string,
  nickname: string,
): Promise<RoomHttpResult<{ readonly memberView: RoomMemberView }>> {
  const body = joinRoomRequestSchema.safeParse({ nickname });
  if (!body.success) return { ok: false, reason: "invalid" };
  const response = await requestJson(`/api/rooms/${encodeURIComponent(roomId)}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body.data),
  });
  if (!response.ok) return response;
  const parsed = joinRoomResponseSchema.safeParse(response.value);
  return parsed.success
    ? { ok: true, value: { memberView: parsed.data.memberView } }
    : { ok: false, reason: "network" };
}

/** `GET /api/rooms/:roomId/catalog`：房间固定的代理人目录快照；只读、无需身份。 */
export async function fetchRoomCatalog(roomId: string): Promise<RoomHttpResult<AgentCatalogData>> {
  const response = await requestJson(`/api/rooms/${encodeURIComponent(roomId)}/catalog`, {
    method: "GET",
  });
  if (!response.ok) return response;
  const parsed = roomCatalogResponseSchema.safeParse(response.value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: "network" };
}

/** 非浏览器环境/调用方无法解析错误体时的兜底（测试与诊断辅助，不参与 UI 判断）。 */
export function parseApiErrorBody(body: unknown): ApiErrorResponseBody | null {
  const parsed = apiErrorResponseBodySchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
