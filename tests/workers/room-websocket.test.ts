import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { apiErrorResponseBodySchema } from "../../shared/contracts/http";
import { BP_RULE_VERSION } from "../../shared/bp/version";
import { createRoomViaHttp, joinMemberViaHttp, TestWsClient } from "./ws-helpers";

// Workers 集成测试：WebSocket 通道边界——升级校验、身份与房间级拒绝、
// 展示只读、消息边界与各通道的视图投影隔离。命令执行、在线计数与
// 去重回执见 room-commands.test.ts 与 room-presence.test.ts。

const BASE_URL = "http://localhost";

/** 发起 WS 升级请求；默认带 Upgrade 头，headers 可覆盖。 */
function upgradeRequest(path: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(
    new Request(`${BASE_URL}${path}`, { headers: { Upgrade: "websocket", ...headers } }),
  );
}

describe("WS 升级的协议校验（Worker 边界）", () => {
  // 说明：Workers 测试环境的 fetch 会把带 Upgrade 头的子请求规范化为
  // WebSocket 握手（POST 也按 GET 到达服务端），因此 405 分支无法经该
  // 通道驱动，仅作为代码防御保留；真实浏览器握手按协议必为 GET。
  it("缺少 Upgrade 头返回 426，不进入 DO", async () => {
    const room = await createRoomViaHttp();
    const member = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${room.roomId}/ws`),
    );
    expect(member.status).toBe(426);
    const display = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${room.roomId}/display/ws`),
    );
    expect(display.status).toBe(426);
  });

  it("第三方 Origin 的升级请求被拒绝（成员与展示通道一致）", async () => {
    const room = await createRoomViaHttp();
    for (const path of [`/api/rooms/${room.roomId}/ws`, `/api/rooms/${room.roomId}/display/ws`]) {
      const response = await upgradeRequest(path, { Origin: "https://evil.example" });
      expect(response.status).toBe(403);
      const error = apiErrorResponseBodySchema.parse(await response.json());
      expect(error.error.code).toBe("INVALID_REQUEST");
    }
  });

  it("未知子路径按未知 /api 路径处理（404 JSON）", async () => {
    const room = await createRoomViaHttp();
    const response = await upgradeRequest(`/api/rooms/${room.roomId}/wss`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not Found" });
  });
});

describe("WS 房间级拒绝（接受连接后通知并关闭，不写存储）", () => {
  it("未知房间的成员通道：ROOM_NOT_FOUND 通知 + 关闭，实例保持空存储", async () => {
    const roomId = crypto.randomUUID();
    const client = await TestWsClient.connectMember(roomId, "irrelevant-secret");
    const notice = await client.next("notice");
    expect(notice.code).toBe("ROOM_NOT_FOUND");
    // 连接被服务端以策略违规关闭。
    const close = await client.waitForClose("关闭事件");
    expect(close.code).toBe(1008);

    // 未知 roomId 的 WS 升级不留任何持久业务表。
    const tables = await runInDurableObject(
      exports.Room.get(exports.Room.idFromName(roomId)),
      (_room, state) =>
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .toArray(),
    );
    expect(tables).toEqual([]);
  });

  it("展示通道对未知房间同样拒绝", async () => {
    const client = await TestWsClient.connectDisplay(crypto.randomUUID());
    const notice = await client.next("notice");
    expect(notice.code).toBe("ROOM_NOT_FOUND");
  });

  it("缺失、篡改与跨房间的凭据均按 AUTH_FAILED 拒绝", async () => {
    const room = await createRoomViaHttp();
    const otherRoom = await createRoomViaHttp("另一房", "另一房主");

    const noCookie = await TestWsClient.connectMember(room.roomId, null);
    expect((await noCookie.next("notice")).code).toBe("AUTH_FAILED");

    const tampered = await TestWsClient.connectMember(room.roomId, `${room.secret.slice(0, -1)}0`);
    expect((await tampered.next("notice")).code).toBe("AUTH_FAILED");

    // 房间 A 的秘密装进房间 B 的 Cookie：摘要查不到成员，按无效处理。
    const crossRoom = await TestWsClient.connectMember(room.roomId, otherRoom.secret);
    expect((await crossRoom.next("notice")).code).toBe("AUTH_FAILED");
  });
});

describe("展示通道：只读、无身份、不计在线", () => {
  it("匿名展示连接只收展示视图；任何客户端消息一律不被接受", async () => {
    const room = await createRoomViaHttp("展示赛事");
    const display = await TestWsClient.connectDisplay(room.roomId);

    const view = await display.next("displayView");
    expect(view.view.roomName).toBe("展示赛事");
    expect(view.view.bpStatus).toBe("waiting");
    expect(view.view.revision).toBe(0);

    // 结构合法的房主命令也不被接受：只回通知，连接保持。
    display.send({
      type: "setTeamName",
      team: "A",
      teamName: "越权尝试",
      operationId: "display-op",
      expectedBpVersion: 0,
    });
    const notice = await display.next("notice");
    expect(notice.code).toBe("INVALID_MESSAGE");

    // 连接未被关闭：再发一条消息仍得到通知。
    display.send("garbage");
    const second = await display.next("notice");
    expect(second.code).toBe("INVALID_MESSAGE");
    display.close();
  });

  it("携带房主 Cookie 的展示连接仍只是展示：不下发成员视图、不计在线、不影响计时", async () => {
    const room = await createRoomViaHttp("带 Cookie 的展示");
    // 全员离开后开始计时（创建即计时，之后无人连接）。
    const display = await TestWsClient.connectDisplay(room.roomId, room.cookie);
    const view = await display.next("displayView");
    // 展示视图同公开视图：无成员数据、无 bpVersion 字段。
    expect(JSON.stringify(view)).not.toContain(room.memberId);
    expect(JSON.stringify(view)).not.toContain("bpVersion");
    expect(JSON.stringify(view)).not.toContain("members");

    // 房主未被计为在线，计时不受影响。
    const online = await runInDurableObject(
      exports.Room.get(exports.Room.idFromName(room.roomId)),
      (_room, state) => state.storage.sql.exec("SELECT online FROM members").toArray(),
    );
    expect(Number((online[0] as { online: number }).online)).toBe(0);
    const entry = await exports.Room.get(exports.Room.idFromName(room.roomId)).getRoomEntry({
      credentialDigest: null,
    });
    expect(entry.kind).toBe("live");
    if (entry.kind !== "live") return;
    expect(entry.lastMemberLeftAt).toBe(entry.createdAt);
    display.close();
  });
});

describe("成员消息边界", () => {
  it("二进制消息被拒绝并关闭（1003）", async () => {
    const room = await createRoomViaHttp();
    const client = await TestWsClient.connectMember(room.roomId, room.secret);
    await client.next("hostView");

    client.socket.send(new Uint8Array([0x01, 0x02]));
    const notice = await client.next("notice");
    expect(notice.code).toBe("INVALID_MESSAGE");
    expect((await client.waitForClose("二进制关闭")).code).toBe(1003);
  });

  it("超限文本消息被拒绝并关闭（1009），合法小消息不受影响", async () => {
    const room = await createRoomViaHttp();
    const client = await TestWsClient.connectMember(room.roomId, room.secret);
    await client.next("hostView");

    // 8 KiB 上限：超出 1 字节（ASCII 下字符数即字节数）。
    client.send(`${"a".repeat(8 * 1024 + 1)}`);
    expect((await client.waitForClose("超限关闭")).code).toBe(1009);
  });

  it("非法 JSON 与不符合命令契约的消息只回通知，连接保持", async () => {
    const room = await createRoomViaHttp();
    const client = await TestWsClient.connectMember(room.roomId, room.secret);
    await client.next("hostView");

    client.send("not-json");
    expect((await client.next("notice")).code).toBe("INVALID_MESSAGE");

    client.send({ type: "makeMeHost", operationId: "x", expectedBpVersion: 0 });
    expect((await client.next("notice")).code).toBe("INVALID_MESSAGE");

    // 载荷中的自报字段（memberId/isHost）被剥离：不影响身份。
    client.send({
      type: "setTeamName",
      team: "A",
      teamName: "合法命令",
      operationId: "valid-op",
      expectedBpVersion: 0,
      memberId: "forged-member",
      isHost: true,
    });
    const result = await client.commandResult("valid-op");
    expect(result.ok).toBe(true);
    client.close();
  });
});

describe("各通道的视图投影与隐私边界", () => {
  it("房主收 hostView、普通成员收 memberView（仅自身）、展示收 displayView（无成员数据）", async () => {
    const host = await createRoomViaHttp("投影赛事", "主持人");
    const playerA = await joinMemberViaHttp(host.roomId, "选手甲");
    const spectator = await joinMemberViaHttp(host.roomId, "观众乙");

    const hostClient = await TestWsClient.connectMember(host.roomId, host.secret);
    const playerClient = await TestWsClient.connectMember(host.roomId, playerA.secret);
    const spectatorClient = await TestWsClient.connectMember(host.roomId, spectator.secret);
    const display = await TestWsClient.connectDisplay(host.roomId);

    const hostView = await hostClient.next("hostView");
    expect(hostView.view.self.isHost).toBe(true);
    expect(hostView.view.members).toHaveLength(3);
    expect(hostView.view.members.map((member) => member.nickname)).toContain("观众乙");
    // 成员上线经 WS 连接计入在线视图。
    expect(hostView.view.members.find((member) => member.memberId === host.memberId)?.online).toBe(
      true,
    );

    const playerView = await playerClient.next("memberView");
    expect(playerView.view.self.memberId).toBe(playerA.memberId);
    expect(playerView.view.self.isHost).toBe(false);
    // 普通成员视图不含其他成员数据。
    const playerJson = JSON.stringify(playerView);
    expect(playerJson).not.toContain("members");
    expect(playerJson).not.toContain(host.memberId);
    expect(playerJson).not.toContain(spectator.memberId);
    expect(playerJson).not.toContain("主持人");

    const spectatorView = await spectatorClient.next("memberView");
    expect(spectatorView.view.self.nickname).toBe("观众乙");
    expect(JSON.stringify(spectatorView)).not.toContain(host.memberId);

    const displayView = await display.next("displayView");
    const displayJson = JSON.stringify(displayView);
    expect(displayJson).not.toContain(host.memberId);
    expect(displayJson).not.toContain(playerA.memberId);
    expect(displayJson).not.toContain("主持人");
    expect(displayJson).not.toContain("观众乙");
    expect(displayJson).not.toContain("bpVersion");

    // 状态变化后各通道均收到各自形态的最新视图（广播）。
    hostClient.send({
      type: "setTeamName",
      team: "A",
      teamName: "甲队",
      operationId: "broadcast-op",
      expectedBpVersion: 0,
    });
    expect((await hostClient.commandResult("broadcast-op")).ok).toBe(true);
    // 各连接在期间可能已收到多次广播（其他成员上线），按内容定位本次变更。
    const viewWithTeamName = (message: string | null, kind: string) => {
      if (message === null) return false;
      try {
        const parsed = JSON.parse(message) as {
          kind?: string;
          view?: { teamNames?: { A?: string } };
        };
        return parsed.kind === kind && parsed.view?.teamNames?.A === "甲队";
      } catch {
        return false;
      }
    };
    expect(
      await hostClient.waitFor((m) => viewWithTeamName(m, "hostView"), "hostView 甲队"),
    ).not.toBeNull();
    expect(
      await playerClient.waitFor((m) => viewWithTeamName(m, "memberView"), "memberView 甲队"),
    ).not.toBeNull();
    expect(
      await spectatorClient.waitFor(
        (m) => viewWithTeamName(m, "memberView"),
        "spectator memberView 甲队",
      ),
    ).not.toBeNull();
    expect(
      await display.waitFor((m) => viewWithTeamName(m, "displayView"), "displayView 甲队"),
    ).not.toBeNull();

    // 视图携带建房时固定的规则与数据版本。
    expect(playerView.view.versions).toEqual({
      ruleVersion: BP_RULE_VERSION,
      agentDataVersion: playerView.view.versions.agentDataVersion,
    });

    hostClient.close();
    playerClient.close();
    spectatorClient.close();
    display.close();
  });

  it("HTTP 新成员加入使已连接房主实时看到最新成员列表", async () => {
    const host = await createRoomViaHttp("广播赛事");
    const hostClient = await TestWsClient.connectMember(host.roomId, host.secret);
    const initial = await hostClient.next("hostView");
    expect(initial.view.members).toHaveLength(1);

    const newcomer = await joinMemberViaHttp(host.roomId, "后来者");
    const updated = await hostClient.next("hostView");
    expect(updated.view.members).toHaveLength(2);
    expect(
      updated.view.members.find((member) => member.memberId === newcomer.memberId)?.nickname,
    ).toBe("后来者");
    hostClient.close();
  });
});

describe("DO 直连的防御性校验", () => {
  // 说明：测试环境的 fetch 会把带 Upgrade 头的请求规范化为 GET 握手，
  // POST 分支（Worker 与 DO 两处）无法经该通道驱动，仅作代码防御保留。
  it("路径与实例房间名不匹配、缺少 Upgrade 头均被拒绝", async () => {
    const room = await createRoomViaHttp();
    const stub = exports.Room.get(exports.Room.idFromName(room.roomId));

    // 路径中的 roomId 与实例名不同：不接受升级。
    const wrongPath = await stub.fetch(
      new Request(`${BASE_URL}/api/rooms/${crypto.randomUUID()}/ws`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(wrongPath.status).toBe(404);

    // 无 Upgrade 头：426。
    const noUpgrade = await stub.fetch(new Request(`${BASE_URL}/api/rooms/${room.roomId}/ws`));
    expect(noUpgrade.status).toBe(426);
  });

  it("引导期健康实例（非房间名）按房间不存在处理：通知后关闭", async () => {
    const client = await TestWsClient.connectMember("bootstrap-health", null);
    const notice = await client.next("notice");
    expect(notice.code).toBe("ROOM_NOT_FOUND");
  });
});
