import { z } from "zod";
import { agentCatalogSchema } from "../agents/schema";
import { roomIdSchema } from "../ids";
import { nicknameSchema, roomNameSchema } from "../room";
import { archiveSnapshotSchema } from "./records";
import { roomMemberViewSchema } from "./views";

/**
 * HTTP 接口合同：房间的创建、读取与成员加入。
 *
 * 身份与凭据边界（Cookie 与存储的具体实现见 docs/architecture.md
 * 「身份与凭据边界」）：
 * - 成员凭据由服务端生成并验证，经同域 HttpOnly Cookie 保存于浏览器；
 *   每个房间一个独立 Cookie，多房间身份互不覆盖；恢复身份不轮换凭据。
 * - JSON 响应与广播绝不包含凭据；有效身份重开页面即可恢复当前角色。
 * - 昵称仅用于展示，不用于身份查找；路由参数与机器 ID 均由服务端
 *   生成和校验，客户端输入不直接成为可信状态；载荷中的自报
 *   memberId/角色/席位字段不构成身份或权限来源。
 *
 * 通用行为：`/api/*` 的 JSON 响应均带 `Cache-Control: no-store`；
 * 请求体必须是合法 JSON 并通过对应 schema（失败返回 400 INVALID_REQUEST）；
 * 已知路径的非法方法返回 405；带凭据的写请求校验同源 Origin
 * （携带第三方 Origin 的 POST 被拒绝）。归档房间的原 URL 经普通 HTTP
 * 读取只读快照，无需成员加入或 WS；`/api/health` 为既有引导契约
 * （见 shared/api.ts），不在本文件重复。
 */

/** `POST /api/rooms` 请求：创建房间 + 首次昵称（创建者成为房主）。 */
export const createRoomRequestSchema = z.object({
  roomName: roomNameSchema,
  nickname: nicknameSchema,
});
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;

/** `POST /api/rooms` 响应：房间 ID + 创建者（房主）的成员视图。 */
export const createRoomResponseSchema = z.object({
  roomId: roomIdSchema,
  memberView: roomMemberViewSchema,
});
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;

/**
 * `GET /api/rooms/:roomId` 响应：按生命周期分流。
 *
 * 房间不存在时返回 404 与 apiErrorResponseBodySchema（code 为
 * ROOM_NOT_FOUND）；live 且携带有效身份时直接返回成员视图以恢复角色。
 */
export const roomEntryResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("live"),
    roomName: roomNameSchema,
    /** 携带有效身份时为自身成员视图；匿名访客为 null，进入首次入房表单。 */
    memberView: roomMemberViewSchema.nullable(),
  }),
  z.object({
    kind: z.literal("archived"),
    /** 只读快照：原链接普通 HTTP 读取，无需成员加入或 WS。 */
    record: archiveSnapshotSchema,
  }),
]);
export type RoomEntryResponse = z.infer<typeof roomEntryResponseSchema>;

/**
 * `POST /api/rooms/:roomId/members` 请求。
 *
 * 新成员以昵称作为观众加入；携带有效身份时恢复原身份，请求中的昵称
 * 被忽略（昵称仅首次入房设置）。房间不存在或已归档时返回错误体。
 */
export const joinRoomRequestSchema = z.object({
  nickname: nicknameSchema,
});
export type JoinRoomRequest = z.infer<typeof joinRoomRequestSchema>;

/** `POST /api/rooms/:roomId/members` 响应：请求者自身的成员视图。 */
export const joinRoomResponseSchema = z.object({
  memberView: roomMemberViewSchema,
});
export type JoinRoomResponse = z.infer<typeof joinRoomResponseSchema>;

/**
 * `GET /api/rooms/:roomId/catalog` 响应：该房间创建时固定的代理人目录快照。
 *
 * 房间在建房时一次性保存经过校验的目录与 `agentDataVersion`；本入口返回
 * 该房间的持久快照（结构即目录产物，含来源记录），供界面与展示页取得
 * 旧房间对应目录。只读：无需成员身份，不含任何成员或凭据数据，不计
 * 在线、不影响房间保留计时。后续部署更新全局目录不改变已建房间在本
 * 入口返回的内容；名单与展示解释（规则 AgentCatalog、归档 displayLookup）
 * 一律从该持久快照派生。
 */
export const roomCatalogResponseSchema = agentCatalogSchema;
export type RoomCatalogResponse = z.infer<typeof roomCatalogResponseSchema>;

/** HTTP 层错误码。 */
export const apiErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "ROOM_NOT_FOUND",
  "ROOM_ARCHIVED",
  "INTERNAL",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** 非 2xx 响应的错误体。 */
export const apiErrorResponseBodySchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
  }),
});
export type ApiErrorResponseBody = z.infer<typeof apiErrorResponseBodySchema>;

/** 成员实时连接路径：凭据经同域 HttpOnly Cookie 验证；展示连接不使用本路径。 */
export function memberWebSocketPath(roomId: string): string {
  return `/api/rooms/${roomId}/ws`;
}

/** 匿名展示连接路径：只接收公开视图，无任何写入口。 */
export function displayWebSocketPath(roomId: string): string {
  return `/api/rooms/${roomId}/display/ws`;
}
