import { z } from "zod";
import { operationIdSchema, roomCommandSchema, roomOperationErrorSchema } from "../commands";
import { displayViewSchema, hostManagementViewSchema, roomMemberViewSchema } from "./views";

/**
 * WebSocket 消息合同：成员通道与展示通道分离。
 *
 * - 客户端业务消息复用 roomCommandSchema：系统入口（如 setMemberOnline）
 *   不在客户端联合中，无法注入；认证经连接升级时的成员凭据完成，
 *   升级后的命令操作者一律来自连接附件中的可信身份。
 * - 展示连接始终没有写入口：即使携带房主凭据连接展示通道，也只接收
 *   展示视图，客户端消息一律不被接受。
 * - 命令结果关联 operationId 与命令生效后的 bp.version / revision，
 *   不把包含全部成员的内部 RoomOperationResult.state 直接下发；结果
 *   之后由服务端按连接身份推送最新视图（memberView 或 hostView）。
 * - 结果未知（超时或断线）时，客户端重连并取得最新完整视图，再决定
 *   是否重发；重发必须复用同一 operationId 与同一命令载荷。
 * - operationId 持久化去重回执：按 room + member + operationId 辨认操作，
 *   回执与状态更新同事务写入房间 SQLite。同一规范化载荷（Zod 解析后
 *   重建、键序无关）重发返回原结果且不再执行；同一 ID 配不同载荷以
 *   OPERATION_ID_CONFLICT 拒绝。回执是有限窗口：每房间仅保留最近的
 *   2048 条（按写入顺序淘汰最旧），被淘汰后的重发按新命令处理，由
 *   expectedBpVersion 版本门与命令幂等性保证不会重复推进；保留边界
 *   的正文见 docs/architecture.md「WebSocket 通道」。
 */

/** 客户端可发送的消息：仅业务命令，系统入口不可注入。 */
export const webSocketClientMessageSchema = roomCommandSchema;
export type WebSocketClientMessage = z.infer<typeof webSocketClientMessageSchema>;

/** 连接通知码：无效结构、认证失效与房间状态变化。 */
export const webSocketNoticeCodeSchema = z.enum([
  "INVALID_MESSAGE",
  "AUTH_FAILED",
  "ROOM_ARCHIVED",
  "ROOM_NOT_FOUND",
]);
export type WebSocketNoticeCode = z.infer<typeof webSocketNoticeCodeSchema>;

/** 连接通知：服务端说明连接层面的问题，不带状态负载。 */
export const webSocketNoticeMessageSchema = z.object({
  kind: z.literal("notice"),
  code: webSocketNoticeCodeSchema,
  message: z.string(),
});
export type WebSocketNoticeMessage = z.infer<typeof webSocketNoticeMessageSchema>;

/**
 * 命令结果：成功关联命令生效后的 bp.version 与 revision；失败携带
 * 当前版本与稳定错误码，便于客户端判断过期并同步。
 */
export const commandResultMessageSchema = z
  .object({
    kind: z.literal("commandResult"),
    operationId: operationIdSchema,
    ok: z.boolean(),
    /** 仅失败时非 null。 */
    error: roomOperationErrorSchema.nullable(),
    /** 结果产生时的 BP 版本：成功时为命令生效后的版本。 */
    bpVersion: z.number().int().nonnegative(),
    /** 结果产生时的公开 revision。 */
    revision: z.number().int().nonnegative(),
  })
  .superRefine((message, ctx) => {
    if (message.ok && message.error !== null) {
      ctx.addIssue({
        code: "custom",
        message: "成功结果不应携带错误",
        path: ["error"],
        input: message.error,
      });
    }
    if (!message.ok && message.error === null) {
      ctx.addIssue({
        code: "custom",
        message: "失败结果必须携带错误",
        path: ["error"],
        input: null,
      });
    }
  });
export type CommandResultMessage = z.infer<typeof commandResultMessageSchema>;

/** 成员通道的服务端消息：按连接身份推送成员视图或房主管理视图。 */
export const memberServerMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("memberView"),
    view: roomMemberViewSchema,
  }),
  z.object({
    kind: z.literal("hostView"),
    view: hostManagementViewSchema,
  }),
  commandResultMessageSchema,
  webSocketNoticeMessageSchema,
]);
export type MemberServerMessage = z.infer<typeof memberServerMessageSchema>;

/** 展示通道的服务端消息：只有展示视图与连接通知，无任何命令入口。 */
export const displayServerMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("displayView"),
    view: displayViewSchema,
  }),
  webSocketNoticeMessageSchema,
]);
export type DisplayServerMessage = z.infer<typeof displayServerMessageSchema>;
