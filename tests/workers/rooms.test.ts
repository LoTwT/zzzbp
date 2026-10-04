import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agentCatalogData, agentDataVersion } from "../../shared/agents/catalog";
import { BP_RULE_VERSION } from "../../shared/bp/version";
import {
  apiErrorResponseBodySchema,
  createRoomResponseSchema,
  joinRoomResponseSchema,
  roomCatalogResponseSchema,
  roomEntryResponseSchema,
} from "../../shared/contracts/http";

// Workers 集成测试：经真实 Worker 入口以 HTTP 请求驱动，覆盖建房、读取、
// 入房、身份 Cookie 与错误路径；SQLite 存储与实例重建的验证见
// room-storage.test.ts。

const BASE_URL = "http://localhost";

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(
    new Request(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function get(path: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(new Request(`${BASE_URL}${path}`, { method: "GET", headers }));
}

/** 从 Set-Cookie 头提取凭据秘密（「名称=值」的值部分）。 */
function cookieSecretOf(response: Response): string {
  const setCookie = response.headers.get("Set-Cookie");
  if (setCookie === null) throw new Error("响应缺少 Set-Cookie");
  const pair = setCookie.split(";")[0] ?? "";
  const value = pair.slice(pair.indexOf("=") + 1);
  if (value === "") throw new Error("Set-Cookie 缺少值");
  return value;
}

/** 按实现约定的 Cookie 名称拼出请求头；一房一 Cookie。 */
function roomCookieHeader(roomId: string, secret: string): string {
  return `zzzbp_room_${roomId}=${secret}`;
}

/** 确定性篡改：翻转最后一个十六进制字符，保证与原秘密不同且仍为合法形态。 */
function tamper(secret: string): string {
  const last = secret.slice(-1);
  return `${secret.slice(0, -1)}${last === "0" ? "1" : "0"}`;
}

async function createRoom(roomName = "测试赛事", nickname = "房主") {
  const response = await postJson("/api/rooms", { roomName, nickname });
  expect(response.status).toBe(201);
  const body = createRoomResponseSchema.parse(await response.json());
  return { response, body, secret: cookieSecretOf(response) };
}

describe("POST /api/rooms 建房", () => {
  it("创建房间返回房主成员视图并按房间命名身份 Cookie", async () => {
    const { response, body, secret } = await createRoom();

    // 初始状态：waiting、空席、空队名、无提交无预选，房主为首位成员。
    expect(body.roomId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.memberView.roomName).toBe("测试赛事");
    expect(body.memberView.self).toEqual({
      memberId: body.memberView.self.memberId,
      nickname: "房主",
      isHost: true,
      seatTeam: null,
    });
    expect(body.memberView.bpStatus).toBe("waiting");
    expect(body.memberView.submissions).toEqual([]);
    expect(body.memberView.preselect).toBeNull();
    expect(body.memberView.teamNames).toEqual({ A: "", B: "" });
    expect(body.memberView.seatOccupancy).toEqual({ A: false, B: false });
    expect(body.memberView.bpVersion).toBe(0);
    expect(body.memberView.revision).toBe(0);
    expect(body.memberView.versions).toEqual({
      ruleVersion: BP_RULE_VERSION,
      agentDataVersion,
    });

    // Cookie 命名与属性：一房一 Cookie，HttpOnly + Secure + SameSite=Lax。
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie.startsWith(`zzzbp_room_${body.roomId}=${secret}`)).toBe(true);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=7776000");

    // 原始秘密绝不进入 JSON 响应；响应不缓存。
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("非法建房输入返回 400 且不交付房间或凭据", async () => {
    const cases: Array<{ body: unknown; label: string }> = [
      { body: {}, label: "缺少字段" },
      { body: { roomName: "   ", nickname: "房主" }, label: "空房名" },
      { body: { roomName: "名".repeat(81), nickname: "房主" }, label: "房名过长" },
      { body: { roomName: "赛事", nickname: "昵".repeat(25) }, label: "昵称过长" },
    ];
    for (const testCase of cases) {
      const response = await postJson("/api/rooms", testCase.body);
      expect(response.status, testCase.label).toBe(400);
      const error = apiErrorResponseBodySchema.parse(await response.json());
      expect(error.error.code).toBe("INVALID_REQUEST");
      // 失败请求不产生业务房间：无 roomId、无身份 Cookie。
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }

    // 非 JSON 请求体同样按 400 处理。
    const invalid = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms`, { method: "POST", body: "not-json" }),
    );
    expect(invalid.status).toBe(400);
    const error = apiErrorResponseBodySchema.parse(await invalid.json());
    expect(error.error.code).toBe("INVALID_REQUEST");
  });

  it("携带第三方 Origin 的 POST 被拒绝", async () => {
    const response = await postJson(
      "/api/rooms",
      { roomName: "赛事", nickname: "房主" },
      { Origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const error = apiErrorResponseBodySchema.parse(await response.json());
    expect(error.error.code).toBe("INVALID_REQUEST");
  });
});

describe("GET /api/rooms/:roomId 房间读取", () => {
  it("匿名读取返回房名与 null 成员视图", async () => {
    const { body } = await createRoom("匿名可读赛事");
    const response = await get(`/api/rooms/${body.roomId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();

    const entry = roomEntryResponseSchema.parse(await response.json());
    expect(entry).toEqual({ kind: "live", roomName: "匿名可读赛事", memberView: null });
  });

  it("有效 Cookie 恢复房主成员视图且不轮换凭据", async () => {
    const { body, secret } = await createRoom();
    const response = await get(`/api/rooms/${body.roomId}`, {
      Cookie: roomCookieHeader(body.roomId, secret),
    });
    expect(response.status).toBe(200);
    // 恢复身份不下发新 Cookie，其他页面继续有效。
    expect(response.headers.get("Set-Cookie")).toBeNull();

    const entry = roomEntryResponseSchema.parse(await response.json());
    expect(entry.kind).toBe("live");
    if (entry.kind !== "live") return;
    expect(entry.memberView?.self).toEqual(body.memberView.self);
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("篡改的凭据按匿名处理", async () => {
    const { body, secret } = await createRoom();
    const response = await get(`/api/rooms/${body.roomId}`, {
      Cookie: roomCookieHeader(body.roomId, tamper(secret)),
    });
    expect(response.status).toBe(200);
    const entry = roomEntryResponseSchema.parse(await response.json());
    expect(entry.kind).toBe("live");
    if (entry.kind !== "live") return;
    expect(entry.memberView).toBeNull();
  });

  it("不存在的房间返回 404 共享错误体，非法房间 ID 返回 400", async () => {
    const notFound = await get(`/api/rooms/${crypto.randomUUID()}`);
    expect(notFound.status).toBe(404);
    const errorBody = apiErrorResponseBodySchema.parse(await notFound.json());
    expect(errorBody.error.code).toBe("ROOM_NOT_FOUND");

    const tooLong = await get(`/api/rooms/${"x".repeat(101)}`);
    expect(tooLong.status).toBe(400);
    const longError = apiErrorResponseBodySchema.parse(await tooLong.json());
    expect(longError.error.code).toBe("INVALID_REQUEST");

    const badEscape = await get("/api/rooms/%zz");
    expect(badEscape.status).toBe(400);
    const escapeError = apiErrorResponseBodySchema.parse(await badEscape.json());
    expect(escapeError.error.code).toBe("INVALID_REQUEST");
  });

  it("已知路径的非法方法返回 405", async () => {
    const { body } = await createRoom();
    const entryPost = await postJson(`/api/rooms/${body.roomId}`, {});
    expect(entryPost.status).toBe(405);

    const membersGet = await get(`/api/rooms/${body.roomId}/members`);
    expect(membersGet.status).toBe(405);

    const catalogPost = await postJson(`/api/rooms/${body.roomId}/catalog`, {});
    expect(catalogPost.status).toBe(405);
  });
});

describe("POST /api/rooms/:roomId/members 入房", () => {
  it("新观众以昵称加入并取得新身份 Cookie", async () => {
    const { body } = await createRoom();
    const response = await postJson(`/api/rooms/${body.roomId}/members`, { nickname: "观众甲" });
    expect(response.status).toBe(200);

    const joined = joinRoomResponseSchema.parse(await response.json());
    expect(joined.memberView.self.isHost).toBe(false);
    expect(joined.memberView.self.seatTeam).toBeNull();
    expect(joined.memberView.self.nickname).toBe("观众甲");
    expect(joined.memberView.self.memberId).not.toBe(body.memberView.self.memberId);

    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie.startsWith(`zzzbp_room_${body.roomId}=`)).toBe(true);
    expect(setCookie).toContain("HttpOnly");
    expect(JSON.stringify(joined)).not.toContain(cookieSecretOf(response));
  });

  it("有效凭据多次入房恢复原成员：不重复建成员、忽略新昵称、不轮换凭据", async () => {
    const { body, secret } = await createRoom();
    const hostMemberId = body.memberView.self.memberId;

    for (const nickname of ["改名尝试", "再次改名"]) {
      const response = await postJson(
        `/api/rooms/${body.roomId}/members`,
        { nickname },
        { Cookie: roomCookieHeader(body.roomId, secret) },
      );
      expect(response.status).toBe(200);
      // 恢复原身份：昵称被忽略（仍是建房时的昵称），不下发新 Cookie。
      expect(response.headers.get("Set-Cookie")).toBeNull();
      const joined = joinRoomResponseSchema.parse(await response.json());
      expect(joined.memberView.self.memberId).toBe(hostMemberId);
      expect(joined.memberView.self.nickname).toBe("房主");
      expect(joined.memberView.self.isHost).toBe(true);
    }
  });

  it("清除身份后同昵称只能作为新观众加入", async () => {
    const { body } = await createRoom();
    const response = await postJson(`/api/rooms/${body.roomId}/members`, { nickname: "房主" });
    expect(response.status).toBe(200);
    const joined = joinRoomResponseSchema.parse(await response.json());
    // 昵称相同也不恢复房主身份。
    expect(joined.memberView.self.memberId).not.toBe(body.memberView.self.memberId);
    expect(joined.memberView.self.isHost).toBe(false);
  });

  it("凭据不得跨房间恢复权限", async () => {
    const roomA = await createRoom("房间A", "A房主");
    const roomB = await createRoom("房间B", "B房主");

    // 把房间 A 的秘密装进房间 B 的 Cookie 名发送：只应获得新观众身份。
    const response = await postJson(
      `/api/rooms/${roomB.body.roomId}/members`,
      { nickname: "B的新观众" },
      { Cookie: roomCookieHeader(roomB.body.roomId, roomA.secret) },
    );
    expect(response.status).toBe(200);
    const joined = joinRoomResponseSchema.parse(await response.json());
    expect(joined.memberView.self.memberId).not.toBe(roomA.body.memberView.self.memberId);
    expect(joined.memberView.self.nickname).toBe("B的新观众");
    expect(joined.memberView.self.isHost).toBe(false);

    // 房间 A 的身份不受影响，仍可恢复。
    const entry = await get(`/api/rooms/${roomA.body.roomId}`, {
      Cookie: roomCookieHeader(roomA.body.roomId, roomA.secret),
    });
    const parsed = roomEntryResponseSchema.parse(await entry.json());
    expect(parsed.kind).toBe("live");
    if (parsed.kind !== "live") return;
    expect(parsed.memberView?.self.memberId).toBe(roomA.body.memberView.self.memberId);
  });

  it("不存在的房间 404；非法请求体 400 且不吞掉其他错误", async () => {
    const { body } = await createRoom();

    const notFound = await postJson(`/api/rooms/${crypto.randomUUID()}/members`, {
      nickname: "观众",
    });
    expect(notFound.status).toBe(404);
    const notFoundBody = apiErrorResponseBodySchema.parse(await notFound.json());
    expect(notFoundBody.error.code).toBe("ROOM_NOT_FOUND");

    const invalid = await postJson(`/api/rooms/${body.roomId}/members`, { nickname: "" });
    expect(invalid.status).toBe(400);
    const invalidBody = apiErrorResponseBodySchema.parse(await invalid.json());
    expect(invalidBody.error.code).toBe("INVALID_REQUEST");
  });

  it("携带第三方 Origin 的入房 POST 被拒绝", async () => {
    const { body, secret } = await createRoom();
    const response = await postJson(
      `/api/rooms/${body.roomId}/members`,
      { nickname: "观众" },
      { Origin: "https://evil.example", Cookie: roomCookieHeader(body.roomId, secret) },
    );
    expect(response.status).toBe(403);
  });
});

describe("多房间身份共存", () => {
  it("同一浏览器可在多个房间保留各自身份", async () => {
    const roomA = await createRoom("房间A", "A房主");
    const roomB = await createRoom("房间B", "B房主");

    // 两个房间的 Cookie 同名前缀但名称不同，互不覆盖。
    const cookieA = roomCookieHeader(roomA.body.roomId, roomA.secret);
    const cookieB = roomCookieHeader(roomB.body.roomId, roomB.secret);
    expect(cookieA).not.toBe(cookieB);

    // 同时携带两个 Cookie 时，各自房间恢复各自身份。
    const both = `${cookieA}; ${cookieB}`;
    const entryA = roomEntryResponseSchema.parse(
      await (await get(`/api/rooms/${roomA.body.roomId}`, { Cookie: both })).json(),
    );
    const entryB = roomEntryResponseSchema.parse(
      await (await get(`/api/rooms/${roomB.body.roomId}`, { Cookie: both })).json(),
    );
    expect(entryA.kind).toBe("live");
    expect(entryB.kind).toBe("live");
    if (entryA.kind !== "live" || entryB.kind !== "live") return;
    expect(entryA.memberView?.self.memberId).toBe(roomA.body.memberView.self.memberId);
    expect(entryB.memberView?.self.memberId).toBe(roomB.body.memberView.self.memberId);
  });
});

describe("GET /api/rooms/:roomId/catalog 固定目录", () => {
  it("匿名只读返回建房时固定的目录快照", async () => {
    const { body } = await createRoom();
    const response = await get(`/api/rooms/${body.roomId}/catalog`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    // 内容与建房时的全局目录一致：名单、分类、来源版本全部固定。
    const catalog = roomCatalogResponseSchema.parse(await response.json());
    expect(catalog).toEqual(agentCatalogData);
    expect(catalog.agentDataVersion).toBe(agentDataVersion);
    expect(catalog.agents).toHaveLength(agentCatalogData.agents.length);
    // 目录响应不含成员数据或凭据。
    expect(JSON.stringify(catalog)).not.toContain("房主");
  });

  it("不存在的房间返回 404", async () => {
    const response = await get(`/api/rooms/${crypto.randomUUID()}/catalog`);
    expect(response.status).toBe(404);
    const error = apiErrorResponseBodySchema.parse(await response.json());
    expect(error.error.code).toBe("ROOM_NOT_FOUND");
  });
});

describe("POST 请求体大小上限", () => {
  /** 与 server/index.ts 一致的上限（8 KiB）；测试独立断言该合同值。 */
  const MAX_BODY_BYTES = 8 * 1024;

  it("超限请求体返回 413 且不产生房间或凭据", async () => {
    // 含合法房名/昵称与 1 MiB padding 的请求曾会被缓冲并按 201 接受。
    const oversized = { roomName: "赛事", nickname: "房主", padding: "x".repeat(1024 * 1024) };
    const response = await postJson("/api/rooms", oversized);
    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const error = apiErrorResponseBodySchema.parse(await response.json());
    expect(error.error.code).toBe("INVALID_REQUEST");
  });

  it("恰在上限的请求体正常处理，超出一个字节被拒绝", async () => {
    // skeleton 与 padding 均为 ASCII：字符串长度即 UTF-8 字节数。
    const skeleton = JSON.stringify({ roomName: "r", nickname: "n", padding: "" });
    const atLimit = {
      roomName: "r",
      nickname: "n",
      padding: "a".repeat(MAX_BODY_BYTES - skeleton.length),
    };
    expect(new TextEncoder().encode(JSON.stringify(atLimit)).byteLength).toBe(MAX_BODY_BYTES);
    const accepted = await postJson("/api/rooms", atLimit);
    expect(accepted.status).toBe(201);

    const overLimit = {
      roomName: "r",
      nickname: "n",
      padding: "a".repeat(MAX_BODY_BYTES - skeleton.length + 1),
    };
    const rejected = await postJson("/api/rooms", overLimit);
    expect(rejected.status).toBe(413);
    const error = apiErrorResponseBodySchema.parse(await rejected.json());
    expect(error.error.code).toBe("INVALID_REQUEST");
    expect(rejected.headers.get("Set-Cookie")).toBeNull();
  });

  it("缺失 Content-Length 的超限分块请求仍被流式计数拒绝", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"roomName":"r","nickname":"n","padding":"'));
        controller.enqueue(encoder.encode("b".repeat(64 * 1024)));
        controller.enqueue(encoder.encode('"}'));
        controller.close();
      },
    });
    // 流式 body 不携带 Content-Length，只能靠实际字节计数拒绝。
    const request = new Request(`${BASE_URL}/api/rooms`, { method: "POST", body });
    expect(request.headers.get("Content-Length")).toBeNull();
    const response = await exports.default.fetch(request);
    expect(response.status).toBe(413);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const error = apiErrorResponseBodySchema.parse(await response.json());
    expect(error.error.code).toBe("INVALID_REQUEST");
  });
});
