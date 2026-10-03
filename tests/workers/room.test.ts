import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "../../shared/api";

// Workers 集成测试：运行在真实 workerd（miniflare）中，
// 绑定与兼容性设置来自 cloudflare.config.ts（见 vitest.config.ts）。
describe("Room Durable Object（内置 SQLite）", () => {
  it("写入的房间记录可读回，重复初始化保持幂等", async () => {
    const id = exports.Room.idFromName("bootstrap-test");
    const stub = exports.Room.get(id);

    const first = await stub.ensureCreated();
    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const second = await stub.ensureCreated();
    expect(second.createdAt).toBe(first.createdAt);

    const direct = await stub.readInfo();
    expect(direct).toEqual(first);
  });

  it("未初始化的房间读取结果为 null", async () => {
    const id = exports.Room.idFromName(`bootstrap-empty-${crypto.randomUUID()}`);
    const stub = exports.Room.get(id);
    expect(await stub.readInfo()).toBeNull();
  });
});

describe("Worker /api 路由", () => {
  it("/api/health 返回经共享契约校验的健康响应", async () => {
    const response = await exports.default.fetch("http://localhost/api/health");
    expect(response.status).toBe(200);
    const body = healthResponseSchema.parse(await response.json());
    expect(body.ok).toBe(true);
  });

  it("未知 /api 路径返回 404 JSON", async () => {
    const response = await exports.default.fetch("http://localhost/api/unknown");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not Found" });
  });
});
