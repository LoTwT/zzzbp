import { afterEach, expect, test, vi } from "vitest";
import { createRoom, fetchRoomEntry, fetchRoomStatus, joinRoom } from "../../src/room/api";

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

/** 合法的成员视图（建房响应与身份恢复共用的最小结构）。 */
const MEMBER_VIEW = {
  roomName: "赛事甲",
  teamNames: { A: "", B: "" },
  seatOccupancy: { A: false, B: false },
  bpStatus: "waiting",
  currentSlotId: null,
  submissions: [],
  preselect: null,
  versions: { ruleVersion: "rules-test", agentDataVersion: "agents-test" },
  revision: 0,
  self: { memberId: "member-1", nickname: "房主", isHost: true, seatTeam: null },
  bpVersion: 0,
};

/** 合法的归档快照（只读记录页与状态读取共用）。 */
const ARCHIVE_RECORD = {
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
  archivedAt: "2026-10-05T00:00:00.000Z",
  expiresAt: "2027-01-03T00:00:00.000Z",
};

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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { kind: "archived", record: ARCHIVE_RECORD })),
  );
  const result = await fetchRoomEntry("room-1");
  expect(result).toEqual({ ok: true, value: { kind: "archived", record: ARCHIVE_RECORD } });
});

test("建房成功返回服务端确认的房间名（首页清单据此记录本机参与）", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(201, { roomId: "room-1", memberView: MEMBER_VIEW })),
  );
  expect(await createRoom({ roomName: "  赛事甲  ", nickname: "房主" })).toEqual({
    ok: true,
    value: { roomId: "room-1", roomName: "赛事甲" },
  });
});

test("清单状态读取不带身份 Cookie，未归档与已归档分别返回展示字段", async () => {
  // 捕获请求初始化：测试项目按 Workers 类型检查，RequestInit 没有
  // credentials 字段，这里按结构读取实际发送的选项。
  const calls: Array<{ readonly method?: string; readonly credentials?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (
        _input: unknown,
        options?: { readonly method?: string; readonly credentials?: unknown },
      ) => {
        calls.push(options ?? {});
        return jsonResponse(200, { kind: "live", roomName: "赛事甲", memberView: null });
      },
    ),
  );
  expect(await fetchRoomStatus("room-1")).toEqual({
    ok: true,
    value: { kind: "live", roomName: "赛事甲" },
  });
  // credentials: "omit" 明确匿名读取：不恢复身份、不创建成员、不建立连接。
  expect(calls[0]?.method).toBe("GET");
  expect(calls[0]?.credentials).toBe("omit");

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { kind: "archived", record: ARCHIVE_RECORD })),
  );
  expect(await fetchRoomStatus("room-1")).toEqual({
    ok: true,
    value: {
      kind: "archived",
      roomName: "归档赛事",
      expiresAt: "2027-01-03T00:00:00.000Z",
    },
  });
});

test("清单状态读取把真正的 404 归为 not-found，服务端故障归为 server", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(404, { error: { code: "ROOM_NOT_FOUND", message: "房间不存在" } }),
    ),
  );
  expect(await fetchRoomStatus("room-1")).toEqual({ ok: false, reason: "not-found" });

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(500, { error: { code: "INTERNAL", message: "内部错误" } })),
  );
  expect(await fetchRoomStatus("room-1")).toEqual({ ok: false, reason: "server" });
});

test("2xx 非 JSON 响应归为 network（服务端合同违背，可重试）", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => textResponse(200, "not json")),
  );
  const result = await fetchRoomEntry("room-1");
  expect(result).toEqual({ ok: false, reason: "network" });
});
