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
import type { ArchiveSnapshot } from "../../shared/contracts/records";
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
  /**
   * 房间已归档：本入口（入房、目录）对归档房间按 410 拒绝；房间入口
   * GET 对归档房间是成功响应（只读快照，见 fetchRoomEntry），页面据此
   * 分流到只读记录而不是提示不可进入。
   */
  | "archived"
  /** 请求体未通过共享 schema（客户端已预检，正常流程不应出现）。 */
  | "invalid"
  /**
   * 服务端或协议层故障：INTERNAL 错误体、非 JSON 的非 2xx 响应等。与调用
   * 方输入无关且通常可重试；短暂服务故障不代表房间消失，不能并入
   * not-found 或 invalid 的文案。
   */
  | "server"
  /** 网络层失败（连接失败、中断、超时）。 */
  | "network";

/** 统一的判别结果。 */
export type RoomHttpResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: RoomHttpFailure;
    };

/** 解析 JSON 响应体；非 JSON 抛错，由调用方决定归类（2xx 合同违背按可重试处理）。 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("non-json response");
  }
}

/** 把非 2xx 响应转换为失败原因：按错误体稳定码区分，无法解析时视为可重试的服务/协议故障。 */
async function failureOfResponse(response: Response): Promise<RoomHttpFailure> {
  const body = apiErrorResponseBodySchema.safeParse(await readJson(response).catch(() => null));
  if (body.success) {
    switch (body.data.error.code) {
      case "ROOM_NOT_FOUND":
        return "not-found";
      case "ROOM_ARCHIVED":
        return "archived";
      case "INVALID_REQUEST":
        return "invalid";
      default:
        // INTERNAL 等其余稳定码：服务端故障，可重试。
        return "server";
    }
  }
  // 非 JSON 或不符合错误体合同的非 2xx（如网关 503 HTML）：协议层故障，可重试。
  return "server";
}

/**
 * 网络层异常（连接失败、中断、超时）统一折叠为 network。
 *
 * `anonymous: true` 显式不携带同源身份 Cookie（用于只读的匿名公开读取，
 * 如首页清单的状态查询）；其余请求沿用浏览器默认的同源 Cookie 携带规则，
 * 页面恢复身份与入房仍依赖 HttpOnly Cookie。请求初始化不直接写成
 * `RequestInit` 字面量：本模块同时按浏览器与 Workers（测试环境）类型检查，
 * 后者没有 `credentials` 字段。
 */
async function requestJson(
  input: string,
  init: RequestInit,
  options: { readonly anonymous?: boolean } = {},
): Promise<RoomHttpResult<unknown>> {
  // credentials 取字面量类型（"omit"），既满足浏览器 RequestInit 的
  // RequestCredentials 联合，也在 Workers 类型下作为多余字段被接受。
  const anonymousInit = { ...init, credentials: "omit" as const };
  const requestInit = options.anonymous === true ? anonymousInit : init;
  try {
    const response = await fetch(input, requestInit);
    if (!response.ok) {
      return { ok: false, reason: await failureOfResponse(response) };
    }
    return { ok: true, value: await readJson(response) };
  } catch {
    return { ok: false, reason: "network" };
  }
}

/**
 * `POST /api/rooms`：建房并直接成为房主；成功返回房间 ID 与房间名。
 *
 * 房间名取服务端确认的成员视图字段（规范化与长度约束以服务端为准），
 * 首页「最近参与」记录本机清单时据此保存，避免保存未规范化的输入。
 */
export async function createRoom(input: {
  readonly roomName: string;
  readonly nickname: string;
}): Promise<RoomHttpResult<{ readonly roomId: string; readonly roomName: string }>> {
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
    ? {
        ok: true,
        value: { roomId: parsed.data.roomId, roomName: parsed.data.memberView.roomName },
      }
    : { ok: false, reason: "network" };
}

/**
 * `GET /api/rooms/:roomId`：读取房间入口。
 *
 * live 且携带有效身份时返回成员视图（刷新恢复角色）；匿名返回 null，
 * 由页面渲染首次入房表单。归档房间是成功响应：返回同一份只读快照
 * （原房主、成员与匿名一致），页面据此分流到只读记录页；快照由普通
 * HTTP 读取，无需成员加入或任何实时连接。
 */
export async function fetchRoomEntry(roomId: string): Promise<
  RoomHttpResult<
    | {
        readonly kind: "live";
        readonly roomName: string;
        readonly memberView: RoomMemberView | null;
      }
    | { readonly kind: "archived"; readonly record: ArchiveSnapshot }
  >
> {
  const response = await requestJson(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: "GET",
  });
  if (!response.ok) return response;
  const parsed = roomEntryResponseSchema.safeParse(response.value);
  if (!parsed.success) return { ok: false, reason: "network" };
  if (parsed.data.kind === "archived") {
    return { ok: true, value: { kind: "archived", record: parsed.data.record } };
  }
  return {
    ok: true,
    value: { kind: "live", roomName: parsed.data.roomName, memberView: parsed.data.memberView },
  };
}

/** 清单状态读取的成功结果：只表达生命周期与展示所需字段。 */
export type RoomStatusView =
  | { readonly kind: "live"; readonly roomName: string }
  | { readonly kind: "archived"; readonly roomName: string; readonly expiresAt: string };

/**
 * `GET /api/rooms/:roomId` 的匿名公开读取：首页「最近参与」清单查询状态。
 *
 * 明确匿名读取（`anonymous: true` → `credentials: "omit"`）：不携带身份
 * Cookie，因此不恢复身份、不创建成员、不建立成员或展示实时连接，也不会
 * 因为刷新清单而延长保留期限（读取路径仍会执行已到期的归档/清理裁决，
 * 这是既有的生命周期规则，见 docs/architecture.md「生命周期与归档记录」）。
 * 房间不存在返回 not-found，网络/服务端故障返回可重试的失败，由界面区分
 * 「不存在」与「暂时无法确认」。
 */
export async function fetchRoomStatus(roomId: string): Promise<RoomHttpResult<RoomStatusView>> {
  const response = await requestJson(
    `/api/rooms/${encodeURIComponent(roomId)}`,
    { method: "GET" },
    { anonymous: true },
  );
  if (!response.ok) return response;
  const parsed = roomEntryResponseSchema.safeParse(response.value);
  if (!parsed.success) return { ok: false, reason: "network" };
  if (parsed.data.kind === "archived") {
    return {
      ok: true,
      value: {
        kind: "archived",
        roomName: parsed.data.record.roomName,
        expiresAt: parsed.data.record.expiresAt,
      },
    };
  }
  return { ok: true, value: { kind: "live", roomName: parsed.data.roomName } };
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
