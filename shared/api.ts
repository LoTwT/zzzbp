import { z } from "zod";

/**
 * 房间基础信息。当前是工程引导阶段的最小共享契约，
 * 后续房间 PR 会在此扩展为完整的房间视图与命令协议。
 */
export const roomInfoSchema = z.object({
  createdAt: z.iso.datetime(),
});
export type RoomInfo = z.infer<typeof roomInfoSchema>;

/** `GET /api/health` 的响应体，附带一条房间记录以验证存储链路。 */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  room: roomInfoSchema,
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
