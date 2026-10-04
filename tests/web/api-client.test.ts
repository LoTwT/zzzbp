import { afterEach, expect, test, vi } from "vitest";
import { createRoom, fetchRoomEntry, joinRoom } from "../../src/room/api";

// HTTP 客户端错误分类回归：真实 404/410/400 与可重试的服务/协议故障
// （INTERNAL 500、非 JSON 503）必须区分，短暂服务故障不能被归为
// 「房间不存在」或「输入不合法」。

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/html" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("500 INTERNAL 错误体归为 server（可重试），不是 invalid/not-found", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(500, { error: { code: "INTERNAL", message: "服务器内部错误" } }),
    ),
  );
  const result = await fetchRoomEntry("room-1");
  expect(result).toEqual({ ok: false, reason: "server" });
});

test("503 非 JSON 响应归为 server（协议层故障，可重试）", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => textResponse(503, "<html>Service Unavailable</html>")),
  );
  const result = await joinRoom("room-1", "观众");
  expect(result).toEqual({ ok: false, reason: "server" });
});

test("真实 404 ROOM_NOT_FOUND 归为 not-found", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(404, { error: { code: "ROOM_NOT_FOUND", message: "房间不存在" } }),
    ),
  );
  expect(await fetchRoomEntry("room-1")).toEqual({ ok: false, reason: "not-found" });
  expect(await joinRoom("room-1", "观众")).toEqual({ ok: false, reason: "not-found" });
});

test("410 ROOM_ARCHIVED 归为 archived", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(410, { error: { code: "ROOM_ARCHIVED", message: "房间已归档" } }),
    ),
  );
  expect(await fetchRoomEntry("room-1")).toEqual({ ok: false, reason: "archived" });
});

test("400 INVALID_REQUEST 归为 invalid（输入失败）", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(400, { error: { code: "INVALID_REQUEST", message: "入房请求不合法" } }),
    ),
  );
  expect(await joinRoom("room-1", "观众")).toEqual({ ok: false, reason: "invalid" });
});

test("客户端预检失败（非法昵称）不发起请求，归为 invalid", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  expect(await joinRoom("room-1", "  ")).toEqual({ ok: false, reason: "invalid" });
  expect(await createRoom({ roomName: "", nickname: "昵称" })).toEqual({
    ok: false,
    reason: "invalid",
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("网络层异常归为 network", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed");
    }),
  );
  expect(await fetchRoomEntry("room-1")).toEqual({ ok: false, reason: "network" });
  expect(await createRoom({ roomName: "房间", nickname: "昵称" })).toEqual({
    ok: false,
    reason: "network",
  });
});

test("归档房间的 200 快照响应按只读记录成功返回，不是失败", async () => {
  // GET 房间入口对归档房间是成功只读响应：页面据此分流到记录页，
  // 不建立成员/展示连接；同一份快照对所有访问者一致。
  const archivedAt = "2026-10-05T00:00:00.000Z";
  const record = {
    roomId: "room-1",
    roomName: "归档赛事",
    teamNames: { A: "左方队", B: "右方队" },
    bpCompleted: false,
    operations: [
      {
        slotId: "AB1",
        team: "A",
        action: "ban",
        agentId: "9001",
        agentName: "代理人甲",
        agentAvatarUrl: null,
      },
    ],
    versions: { ruleVersion: "rules-test", agentDataVersion: "agents-test" },
    archivedAt,
    expiresAt: "2027-01-03T00:00:00.000Z",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { kind: "archived", record })),
  );
  const result = await fetchRoomEntry("room-1");
  expect(result).toEqual({ ok: true, value: { kind: "archived", record } });
});

test("2xx 非 JSON 响应归为 network（服务端合同违背，可重试）", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => textResponse(200, "not json")),
  );
  const result = await fetchRoomEntry("room-1");
  expect(result).toEqual({ ok: false, reason: "network" });
});
