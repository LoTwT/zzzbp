import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { toAgentCatalog, toAgentDisplayLookup } from "../../shared/agents/catalog";
import { agentCatalogSchema, type AgentCatalogData } from "../../shared/agents/schema";
import { createRoomResponseSchema } from "../../shared/contracts/http";

// Workers 集成测试：房间 Durable Object 的 SQLite 持久化与固定目录。
// 通过 cloudflare:test 的 runInDurableObject 直接观察实例内 SQLite 行，
// 并用 evictDurableObject 拆除实例（保留持久存储）验证状态恢复。

const BASE_URL = "http://localhost";

function roomStub(roomId: string) {
  return exports.Room.get(exports.Room.idFromName(roomId));
}

async function createRoomViaHttp(roomName = "存储验证房", nickname = "房主") {
  const response = await exports.default.fetch(
    new Request(`${BASE_URL}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomName, nickname }),
    }),
  );
  expect(response.status).toBe(201);
  const body = createRoomResponseSchema.parse(await response.json());
  const setCookie = response.headers.get("Set-Cookie") ?? "";
  return { body, secret: setCookie.split(";")[0]?.split("=")[1] ?? "" };
}

/** 在房间实例内直接执行 SQL 并返回结果行（观察真实持久存储，而非内存缓存）。 */
function queryRows(
  roomId: string,
  query: string,
): Promise<Array<Record<string, string | number | null>>> {
  const stub = roomStub(roomId);
  return runInDurableObject(stub, (_room, state) => {
    const rows = state.storage.sql.exec(query).toArray();
    return rows.map((row) => {
      const plain: Record<string, string | number | null> = {};
      for (const column of Object.keys(row)) {
        const value: unknown = row[column];
        if (value === null || typeof value === "string" || typeof value === "number") {
          plain[column] = value;
        } else {
          throw new Error(`测试查询不应返回非标量列：${column}`);
        }
      }
      return plain;
    });
  });
}

/** 受控目录：模拟「建房时刻的部署目录」。生产路径中该输入来自全局目录
 * （server/index.ts 建房时传入），此处直接驱动 DO 以模拟后续部署目录变化。 */
function controlledCatalog(agentDataVersion: string, withThirdAgent: boolean): AgentCatalogData {
  const agents = [
    {
      id: "9001",
      name: "甲",
      fullName: "甲全名",
      avatarPath: null,
      elementId: "200",
      specialtyId: "1",
    },
    {
      id: "9002",
      name: "乙",
      fullName: null,
      avatarPath: "UI/Sprite/A1DynamicLoad/IconRoleCircle/UnPacker/IconRoleCircle02.png",
      elementId: "201",
      specialtyId: "1",
    },
  ];
  if (withThirdAgent) {
    agents.push({
      id: "9003",
      name: "丙",
      fullName: "丙全名",
      avatarPath: null,
      elementId: "200",
      specialtyId: "1",
    });
  }
  return agentCatalogSchema.parse({
    agentDataVersion,
    source: {
      package: "@randomplay/data",
      packageVersion: agentDataVersion,
      gameVersion: "9.9",
      sourceId: "controlled-test",
      snapshotId: `sha256:controlled-${agentDataVersion}`,
    },
    elements: [
      { id: "200", name: "物理", iconPath: null },
      { id: "201", name: "火属性", iconPath: null },
    ],
    specialties: [{ id: "1", name: "强攻", iconPath: null }],
    agents,
  });
}

/** 在指定 DO 实例上以受控目录建房（模拟某次部署的全局目录输入）。 */
async function createRoomOnStub(roomId: string, catalog: AgentCatalogData) {
  const result = await roomStub(roomId).createRoom({
    roomId,
    name: "受控目录房",
    hostMemberId: crypto.randomUUID(),
    nickname: "房主",
    credentialDigest: "a".repeat(64),
    ruleVersion: "test-rule",
    catalogJson: JSON.stringify(catalog),
  });
  expect(result.kind).toBe("created");
  if (result.kind !== "created") throw new Error("受控目录建房失败");
  return result;
}

describe("目录快照按房间固定", () => {
  it("已建房的名单、展示与版本来自其持久快照，不被后续目录覆盖", async () => {
    // catalogA 模拟建房时刻的部署目录；catalogB 模拟之后一次部署升级的全局目录。
    const catalogA = controlledCatalog("9.9.9-a", false);
    const catalogB = controlledCatalog("9.9.9-b", true);

    const roomIdA = `fixed-a-${crypto.randomUUID()}`;
    const roomIdB = `fixed-b-${crypto.randomUUID()}`;
    const createdA = await createRoomOnStub(roomIdA, catalogA);
    await createRoomOnStub(roomIdB, catalogB);

    // 房间 A 的成员视图版本固定为其快照版本。
    expect(createdA.memberView.versions).toEqual({
      ruleVersion: "test-rule",
      agentDataVersion: "9.9.9-a",
    });

    // 「升级部署」后（房间 B 以新目录创建）房间 A 的读取仍返回旧快照。
    expect(await roomStub(roomIdA).getRoomCatalog()).toEqual(catalogA);
    expect(await roomStub(roomIdB).getRoomCatalog()).toEqual(catalogB);

    // 规则名单与归档展示 lookup 均从持久快照派生，而非全局当前目录。
    const persisted = await roomStub(roomIdA).getRoomCatalog();
    expect(persisted).not.toBeNull();
    if (persisted === null) return;
    expect(toAgentCatalog(persisted).agentIds).toEqual(["9001", "9002"]);
    const display = toAgentDisplayLookup(persisted);
    expect(display.get("9001")).toEqual({ name: "甲", avatarUrl: null });
    expect(display.get("9002")).toEqual({
      name: "乙",
      avatarUrl: "https://static.nanoka.cc/assets/zzz/IconRoleCircle02.webp",
    });
  });
});

describe("SQLite 持久化与表结构", () => {
  it("建房原子写入房主成员与初始状态；成员加入只增量更新", async () => {
    const { body } = await createRoomViaHttp("增量验证房");
    const roomId = body.roomId;

    // 初始状态：一名房主成员（离线）、waiting、空席、空队名、无提交。
    const metaRows = await queryRows(
      roomId,
      "SELECT name, lifecycle, bp_status, revision, bp_version, bp_preselect, last_member_left_at, created_at FROM room_meta",
    );
    expect(metaRows).toHaveLength(1);
    expect(metaRows[0]).toMatchObject({
      name: "增量验证房",
      lifecycle: "live",
      bp_status: "waiting",
      revision: 0,
      bp_version: 0,
      bp_preselect: null,
    });
    // 空房无人时间初始化为创建时刻（从未有成员连接的计时起点）。
    expect(metaRows[0]?.last_member_left_at).toBe(metaRows[0]?.created_at);
    expect(metaRows[0]?.last_member_left_at).not.toBeNull();

    const memberRows = await queryRows(roomId, "SELECT member_id, nickname, online FROM members");
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.nickname).toBe("房主");
    // HTTP 建房/入房不计在线：新成员为 offline。
    expect(memberRows[0]?.online).toBe(0);

    expect(await queryRows(roomId, "SELECT team, member_id FROM seats")).toEqual([
      { team: "A", member_id: null },
      { team: "B", member_id: null },
    ]);
    expect(await queryRows(roomId, "SELECT team, name FROM team_names")).toEqual([
      { team: "A", name: "" },
      { team: "B", name: "" },
    ]);
    expect(
      await queryRows(roomId, "SELECT position, slot_id, agent_id FROM bp_submissions"),
    ).toEqual([]);
    expect(await queryRows(roomId, "SELECT COUNT(*) AS n FROM room_catalog")).toEqual([{ n: 1 }]);
    expect(await queryRows(roomId, "SELECT version FROM schema_meta")).toEqual([{ version: 1 }]);

    // 新观众加入：只新增一行 members 并递增 revision，不动目录与其他数据。
    const join = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: "观众" }),
      }),
    );
    expect(join.status).toBe(200);
    expect(await queryRows(roomId, "SELECT COUNT(*) AS n FROM members")).toEqual([{ n: 2 }]);
    expect((await queryRows(roomId, "SELECT revision FROM room_meta"))[0]?.revision).toBe(1);
    expect(await queryRows(roomId, "SELECT COUNT(*) AS n FROM room_catalog")).toEqual([{ n: 1 }]);
  });

  it("非法入房请求不产生成员行", async () => {
    const { body } = await createRoomViaHttp();
    const invalid = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${body.roomId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: "昵".repeat(25) }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await queryRows(body.roomId, "SELECT COUNT(*) AS n FROM members")).toEqual([{ n: 1 }]);
  });

  it("未知 roomId 的读取不创建业务房间", async () => {
    const unknownRoomId = crypto.randomUUID();
    const response = await exports.default.fetch(`${BASE_URL}/api/rooms/${unknownRoomId}`);
    expect(response.status).toBe(404);
    // 只有空表结构壳：room_meta 无行。
    expect(await queryRows(unknownRoomId, "SELECT COUNT(*) AS n FROM room_meta")).toEqual([
      { n: 0 },
    ]);
  });

  it("同一实例重复建房被拒绝且不产生第二份写入", async () => {
    const roomId = `dup-${crypto.randomUUID()}`;
    const catalog = controlledCatalog("9.9.8", false);
    await createRoomOnStub(roomId, catalog);

    const stub = roomStub(roomId);
    const second = await stub.createRoom({
      roomId,
      name: "第二间房",
      hostMemberId: crypto.randomUUID(),
      nickname: "另一房主",
      credentialDigest: "b".repeat(64),
      ruleVersion: "test-rule",
      catalogJson: JSON.stringify(controlledCatalog("9.9.9-b", true)),
    });
    expect(second.kind).toBe("already_exists");
    // 原房间数据不变。
    expect(await queryRows(roomId, "SELECT COUNT(*) AS n FROM room_meta")).toEqual([{ n: 1 }]);
    expect(await queryRows(roomId, "SELECT COUNT(*) AS n FROM members")).toEqual([{ n: 1 }]);
    expect(await queryRows(roomId, "SELECT name FROM room_meta")).toEqual([{ name: "受控目录房" }]);
  });
});

describe("实例重建后的状态恢复", () => {
  it("evictDurableObject 拆除实例后，HTTP 读取从 SQLite 恢复身份与房间", async () => {
    const { body, secret } = await createRoomViaHttp("重建验证房");
    const roomId = body.roomId;
    const hostMemberId = body.memberView.self.memberId;

    // 一名观众加入，形成两名成员的持久状态。
    const joinResponse = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: "观众" }),
      }),
    );
    expect(joinResponse.status).toBe(200);
    const joinSetCookie = joinResponse.headers.get("Set-Cookie") ?? "";
    const spectatorSecret = joinSetCookie.split(";")[0]?.split("=")[1] ?? "";
    const spectatorBody = (await joinResponse.json()) as {
      memberView: { self: { memberId: string } };
    };

    // 拆除 DO 实例（保留持久存储）：模拟平台按需重建实例。
    const stub = roomStub(roomId);
    await stub.getRoomCatalog(); // 确保实例当前在运行
    await evictDurableObject(stub);

    // 重建后的读取全部来自 SQLite：房主与观众身份各自恢复。
    const hostEntry = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${roomId}`, {
        headers: { Cookie: `zzzbp_room_${roomId}=${secret}` },
      }),
    );
    const hostBody = (await hostEntry.json()) as {
      kind: string;
      roomName: string;
      memberView: { self: { memberId: string; isHost: boolean; nickname: string } } | null;
    };
    expect(hostBody.kind).toBe("live");
    expect(hostBody.roomName).toBe("重建验证房");
    expect(hostBody.memberView?.self.memberId).toBe(hostMemberId);
    expect(hostBody.memberView?.self.isHost).toBe(true);

    const spectatorJoin = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `zzzbp_room_${roomId}=${spectatorSecret}`,
        },
        body: JSON.stringify({ nickname: "被忽略的昵称" }),
      }),
    );
    expect(spectatorJoin.headers.get("Set-Cookie")).toBeNull();
    const spectatorBodyAfter = (await spectatorJoin.json()) as {
      memberView: { self: { memberId: string; nickname: string } };
    };
    expect(spectatorBodyAfter.memberView.self.memberId).toBe(
      spectatorBody.memberView.self.memberId,
    );
    expect(spectatorBodyAfter.memberView.self.nickname).toBe("观众");

    // 成员数据完整保留在 SQLite 中。
    expect(await queryRows(roomId, "SELECT COUNT(*) AS n FROM members")).toEqual([{ n: 2 }]);
  });

  it("普通 HTTP 读取不影响空房无人时间", async () => {
    const { body } = await createRoomViaHttp("计时验证房");
    const roomId = body.roomId;

    const before = await roomStub(roomId).getRoomEntry({ credentialDigest: null });
    expect(before.kind).toBe("live");
    if (before.kind !== "live") return;
    expect(before.lastMemberLeftAt).toBe(before.createdAt);

    // 匿名读取、目录读取、有效身份恢复都不取消或重置计时。
    await exports.default.fetch(`${BASE_URL}/api/rooms/${roomId}`);
    await exports.default.fetch(`${BASE_URL}/api/rooms/${roomId}/catalog`);
    const after = await roomStub(roomId).getRoomEntry({ credentialDigest: null });
    expect(after.kind).toBe("live");
    if (after.kind !== "live") return;
    expect(after.lastMemberLeftAt).toBe(before.lastMemberLeftAt);
    expect(after.createdAt).toBe(before.createdAt);
  });
});
