import { describe, expect, it } from "vitest";
import { healthResponseSchema, roomInfoSchema } from "../../shared/api";

// 纯规则测试：共享契约在 Node 环境下独立验证，
// 不依赖 Worker 运行时；房间业务规则后续加入本目录。
describe("共享 API 契约", () => {
  const validRoom = { createdAt: "2026-10-04T00:00:00.000Z" };

  it("接受合法的房间信息与健康响应", () => {
    expect(roomInfoSchema.parse(validRoom)).toEqual(validRoom);
    expect(healthResponseSchema.parse({ ok: true, room: validRoom })).toEqual({
      ok: true,
      room: validRoom,
    });
  });

  it("拒绝缺少或非法字段的房间信息", () => {
    expect(roomInfoSchema.safeParse({}).success).toBe(false);
    expect(roomInfoSchema.safeParse({ createdAt: "not-a-timestamp" }).success).toBe(false);
    expect(roomInfoSchema.safeParse({ createdAt: 1760000000000 }).success).toBe(false);
  });

  it("拒绝 ok 不为 true 的健康响应", () => {
    expect(healthResponseSchema.safeParse({ ok: false, room: validRoom }).success).toBe(false);
    expect(healthResponseSchema.safeParse({ room: validRoom }).success).toBe(false);
  });
});
