import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { agentCatalogData } from "../../shared/agents/catalog";
import { BP_STEP_ORDER } from "../../shared/bp/steps";
import { BP_RULE_VERSION } from "../../shared/bp/version";
import {
  archiveSnapshotSchema,
  computeSnapshotDeadline,
  EMPTY_ROOM_RETENTION_MS,
  SNAPSHOT_RETENTION_MS,
  type ArchiveSnapshot,
} from "../../shared/contracts/records";
import { apiErrorResponseBodySchema, roomEntryResponseSchema } from "../../shared/contracts/http";
import {
  currentAlarm,
  createRoomViaHttp,
  execInRoom,
  joinMemberViaHttp,
  queryRoomRows,
  TestWsClient,
  waitForRoomQuery,
  type TestMember,
} from "./ws-helpers";

// Workers 集成测试：房间生命周期（PR9）——空房 12 小时到期裁决、归档快照、
// 90 天快照到期清理与 Alarm 调度。全部运行在真实 workerd + SQLite 上。
//
// 受控时间推进：不等待真实 12 小时/90 天，而是把持久时间戳
// （last_member_left_at / 快照 archivedAt·expiresAt）改写为过去，再经真实
// HTTP 读取、WS 接纳或真实 Alarm（把 Alarm 设为过去时间立即触发）驱动
// 共用的到期裁决；时钟本身使用运行时真实时间。

const BASE_URL = "http://localhost";
const RETENTION_MS = EMPTY_ROOM_RETENTION_MS;

/** 把空房计时起点改写为 now - 12h + inMs（正数=未到期，负数=已过期）。 */
async function setLeftAt(roomId: string, inMs: number): Promise<string> {
  const value = new Date(Date.now() - RETENTION_MS + inMs).toISOString();
  await execInRoom(roomId, `UPDATE room_meta SET last_member_left_at = '${value}'`);
  return value;
}

/** GET 房间入口（真实 HTTP）。 */
async function getEntry(roomId: string, cookie?: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`${BASE_URL}/api/rooms/${roomId}`, {
      headers: cookie === undefined ? {} : { Cookie: cookie },
    }),
  );
}

/** 该实例的业务表名（SQLite/运行时内部表除外）。 */
async function businessTables(roomId: string): Promise<string[]> {
  const rows = await queryRoomRows(
    roomId,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  );
  return rows.map((row) => String(row.name)).sort();
}

/** 等待 room_meta.lifecycle 变为期望值。 */
function waitLifecycle(roomId: string, expected: "live" | "archived", timeoutMs = 5000) {
  return waitForRoomQuery(
    roomId,
    "SELECT lifecycle FROM room_meta",
    "lifecycle",
    expected,
    timeoutMs,
  );
}

/** 直接读取持久快照行并经 schema 校验（观察真实存储，不经 RPC）。 */
async function readStoredSnapshot(roomId: string): Promise<ArchiveSnapshot | null> {
  const rows = await queryRoomRows(roomId, "SELECT snapshot_json FROM archive_snapshot");
  const raw = rows[0]?.snapshot_json;
  if (typeof raw !== "string") return null;
  return archiveSnapshotSchema.parse(JSON.parse(raw));
}

/** 开局并推进 count 步：房主 + 双方选手全部经真实 WS 连接与命令。 */
async function startedRoom(
  roomName: string,
  count: number,
): Promise<{
  roomId: string;
  host: TestMember;
  playerA: TestMember;
  playerB: TestMember;
  hostWs: TestWsClient;
  aWs: TestWsClient;
  bWs: TestWsClient;
}> {
  const host = await createRoomViaHttp(roomName, "主持人");
  const playerA = await joinMemberViaHttp(host.roomId, "选手甲");
  const playerB = await joinMemberViaHttp(host.roomId, "选手乙");
  const roomId = host.roomId;

  const hostWs = await TestWsClient.connectMember(roomId, host.secret);
  const aWs = await TestWsClient.connectMember(roomId, playerA.secret);
  const bWs = await TestWsClient.connectMember(roomId, playerB.secret);
  await hostWs.next("hostView");
  await aWs.next("memberView");
  await bWs.next("memberView");

  const currentBpVersion = async (): Promise<number> =>
    Number((await queryRoomRows(roomId, "SELECT bp_version FROM room_meta"))[0]?.bp_version ?? 0);
  const currentRevision = async (): Promise<number> =>
    Number((await queryRoomRows(roomId, "SELECT revision FROM room_meta"))[0]?.revision ?? 0);

  async function send(client: TestWsClient, type: string, extra: Record<string, unknown>) {
    const operationId = `lifecycle-${type}-${crypto.randomUUID()}`;
    client.send({
      type,
      ...extra,
      operationId,
      expectedBpVersion: await currentBpVersion(),
      // setTeamName 需要 revision 前置条件，缺省取当前值。
      ...(type === "setTeamName" ? { expectedRevision: await currentRevision() } : {}),
    });
    const result = await client.commandResult(operationId);
    expect(result.ok, `${type} 应成功：${result.error?.code ?? ""}`).toBe(true);
    return result;
  }

  await send(hostWs, "setTeamName", { team: "A", teamName: "左方队" });
  await send(hostWs, "setTeamName", { team: "B", teamName: "右方队" });
  await send(hostWs, "assignSeat", { team: "A", targetMemberId: playerA.memberId });
  await send(hostWs, "assignSeat", { team: "B", targetMemberId: playerB.memberId });
  await send(hostWs, "startBp", {});

  // 按权威顺序推进：当前操作方的选手预选并确认（跳过实际头像内容的
  // 业务校验，只推进序列）。
  const agentIds = agentCatalogData.agents.map((agent) => agent.id);
  for (let index = 0; index < count; index += 1) {
    const step = BP_STEP_ORDER[index];
    if (step === undefined) break;
    const client = step.startsWith("A") ? aWs : bWs;
    await send(client, "setPreselect", { slotId: step, agentId: agentIds[index] });
    await send(client, "confirmPreselect", { slotId: step });
  }

  return { roomId, host, playerA, playerB, hostWs, aWs, bWs };
}

/** 等待空房计时写入（全员离开后 last_member_left_at 非 null）。 */
async function waitLeftAt(roomId: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await queryRoomRows(roomId, "SELECT last_member_left_at FROM room_meta");
    const value = rows[0]?.last_member_left_at;
    if (typeof value === "string") return value;
    if (Date.now() >= deadline) throw new Error("等待空房计时写入超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 关闭全部成员连接并等待空房计时与期限 Alarm 写入（真实断开路径）。 */
async function closeAll(room: {
  roomId: string;
  hostWs: TestWsClient;
  aWs: TestWsClient;
  bWs: TestWsClient;
}): Promise<void> {
  room.hostWs.close();
  room.aWs.close();
  room.bWs.close();
  await waitLeftAt(room.roomId);
  // 等待断开路径的异步 Alarm 应用完成，避免测试的 SQL 时间改写与其竞态。
  const deadline = Date.now() + 3000;
  while ((await currentAlarm(room.roomId)) === null) {
    if (Date.now() >= deadline) throw new Error("等待空房期限 Alarm 设置超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("空房到期边界", () => {
  it("期限前不裁决：读取返回 live，期限与 Alarm 保持", async () => {
    const host = await createRoomViaHttp("未到期赛", "主持人");
    const roomId = host.roomId;
    await setLeftAt(roomId, 10_000);

    const response = await getEntry(roomId);
    expect(response.status).toBe(200);
    const entry = roomEntryResponseSchema.parse(await response.json());
    expect(entry.kind).toBe("live");

    // Alarm 仍在期限上（未被读取推迟或清除）。
    const alarm = await currentAlarm(roomId);
    expect(alarm).not.toBeNull();
    expect(alarm ?? 0).toBeGreaterThan(Date.now());
  });

  it("已到期先裁决再考虑读取：无提交房间按不存在收口，存储与 Alarm 清空", async () => {
    const host = await createRoomViaHttp("空到期赛", "主持人");
    const roomId = host.roomId;
    await setLeftAt(roomId, -1);

    const response = await getEntry(roomId);
    expect(response.status).toBe(404);
    expect(apiErrorResponseBodySchema.parse(await response.json()).error.code).toBe(
      "ROOM_NOT_FOUND",
    );

    // deleteAll 原子回收：业务表全部消失，Alarm 清除。
    expect(await businessTables(roomId)).toEqual([]);
    expect(await currentAlarm(roomId)).toBeNull();

    // 删除后的未知房间：后续 GET/POST/WS 不重建表或期限。
    expect((await getEntry(roomId)).status).toBe(404);
    const join = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: "观众" }),
      }),
    );
    expect(join.status).toBe(404);
    const ws = await TestWsClient.connectMember(roomId, host.secret);
    const notice = await ws.next("notice");
    expect(notice.code).toBe("ROOM_NOT_FOUND");
    expect((await ws.waitForClose("清理后 WS 拒绝")).code).toBe(1008);
    expect(await businessTables(roomId)).toEqual([]);
    expect(await currentAlarm(roomId)).toBeNull();
  });
});

describe("归档快照生成", () => {
  it("到期生成快照：字段固定、操作期数据清理、所有访问者同一份", async () => {
    const room = await startedRoom("归档赛", 7);
    await closeAll(room);
    const roomId = room.roomId;
    await setLeftAt(roomId, -1);

    // 原房主（携带 Cookie）与匿名读取取得同一份快照。
    const hostResponse = await getEntry(roomId, room.host.cookie);
    expect(hostResponse.status).toBe(200);
    const hostEntry = roomEntryResponseSchema.parse(await hostResponse.json());
    const anonymousResponse = await getEntry(roomId);
    const anonymousEntry = roomEntryResponseSchema.parse(await anonymousResponse.json());
    expect(hostEntry).toEqual(anonymousEntry);
    expect(hostEntry.kind).toBe("archived");
    if (hostEntry.kind !== "archived") return;

    const record = hostEntry.record;
    expect(record.roomName).toBe("归档赛");
    expect(record.teamNames).toEqual({ A: "左方队", B: "右方队" });
    expect(record.bpCompleted).toBe(false);
    expect(record.operations).toHaveLength(7);
    expect(record.operations.map((operation) => operation.slotId)).toEqual(
      BP_STEP_ORDER.slice(0, 7),
    );
    // 代理人名称与头像来自该房间持久目录（归档时固定），非全局当前目录。
    for (const operation of record.operations) {
      const catalogEntry = agentCatalogData.agents.find((agent) => agent.id === operation.agentId);
      expect(operation.agentName).toBe(catalogEntry?.name);
    }
    expect(record.versions).toEqual({
      ruleVersion: BP_RULE_VERSION,
      agentDataVersion: agentCatalogData.agentDataVersion,
    });
    // 90 天自实际转为只读起算。
    expect(Date.parse(record.expiresAt) - Date.parse(record.archivedAt)).toBe(
      SNAPSHOT_RETENTION_MS,
    );
    expect(Date.parse(record.archivedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(record.archivedAt)).toBeLessThanOrEqual(Date.now());

    // 持久状态：lifecycle archived；操作期数据清理（成员凭据摘要、席位、
    // 队名行、序列、回执、目录），只保留快照与生命周期元数据。
    expect(await readStoredSnapshot(roomId)).toEqual(record);
    expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM members")).toEqual([{ n: 0 }]);
    expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM bp_submissions")).toEqual([
      { n: 0 },
    ]);
    expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM command_receipts")).toEqual([
      { n: 0 },
    ]);
    expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM room_catalog")).toEqual([
      { n: 0 },
    ]);
    expect(await queryRoomRows(roomId, "SELECT lifecycle FROM room_meta")).toEqual([
      { lifecycle: "archived" },
    ]);
    // Alarm 移到快照到期时间。
    expect(await currentAlarm(roomId)).toBe(Date.parse(record.expiresAt));
  });

  it("重复读取不刷新 90 天起点", async () => {
    const room = await startedRoom("续期验证赛", 3);
    await closeAll(room);
    const roomId = room.roomId;
    await setLeftAt(roomId, -1);

    const first = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
    expect(first.kind).toBe("archived");
    if (first.kind !== "archived") return;
    for (let index = 0; index < 3; index += 1) {
      const again = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
      expect(again).toEqual(first);
    }
    expect(await currentAlarm(roomId)).toBe(Date.parse(first.record.expiresAt));
  });

  it("完整 26 步归档为已完成记录", async () => {
    const room = await startedRoom("完整赛", BP_STEP_ORDER.length);
    await closeAll(room);
    await setLeftAt(room.roomId, -1);

    const entry = roomEntryResponseSchema.parse(await (await getEntry(room.roomId)).json());
    expect(entry.kind).toBe("archived");
    if (entry.kind !== "archived") return;
    expect(entry.record.bpCompleted).toBe(true);
    expect(entry.record.operations).toHaveLength(BP_STEP_ORDER.length);
  });

  it("撤回后归档仅保留最终有效序列，不留撤回历史", async () => {
    const room = await startedRoom("撤回赛", 3);
    const roomId = room.roomId;
    // 房主撤回最后一步（BB1）。
    room.hostWs.send({
      type: "undoBpStep",
      operationId: "lifecycle-undo",
      expectedBpVersion: Number(
        (await queryRoomRows(roomId, "SELECT bp_version FROM room_meta"))[0]?.bp_version,
      ),
    });
    const undo = await room.hostWs.commandResult("lifecycle-undo");
    expect(undo.ok).toBe(true);

    await closeAll(room);
    await setLeftAt(roomId, -1);
    const entry = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
    expect(entry.kind).toBe("archived");
    if (entry.kind !== "archived") return;
    expect(entry.record.operations).toHaveLength(2);
    expect(entry.record.operations.map((operation) => operation.slotId)).toEqual(
      BP_STEP_ORDER.slice(0, 2),
    );
  });

  it("重开后归档仅保留最终序列，不保留重开前的局次", async () => {
    const room = await startedRoom("重开赛", 4);
    const roomId = room.roomId;
    room.hostWs.send({
      type: "restartBp",
      operationId: "lifecycle-restart",
      expectedBpVersion: Number(
        (await queryRoomRows(roomId, "SELECT bp_version FROM room_meta"))[0]?.bp_version,
      ),
    });
    expect((await room.hostWs.commandResult("lifecycle-restart")).ok).toBe(true);

    // 重开后重新开局并推进 2 步（回到 waiting 后需重新开始）。
    const agentIds = agentCatalogData.agents.map((agent) => agent.id);
    const send = async (client: TestWsClient, type: string, extra: Record<string, unknown>) => {
      const operationId = `lifecycle-${type}-${crypto.randomUUID()}`;
      client.send({
        type,
        ...extra,
        operationId,
        expectedBpVersion: Number(
          (await queryRoomRows(roomId, "SELECT bp_version FROM room_meta"))[0]?.bp_version,
        ),
      });
      const result = await client.commandResult(operationId);
      expect(result.ok, `${type} 应成功：${result.error?.code ?? ""}`).toBe(true);
      return result;
    };
    await send(room.hostWs, "startBp", {});
    await send(room.aWs, "setPreselect", { slotId: "AB1", agentId: agentIds[0] });
    await send(room.aWs, "confirmPreselect", { slotId: "AB1" });
    await send(room.bWs, "setPreselect", { slotId: "BB1", agentId: agentIds[1] });
    await send(room.bWs, "confirmPreselect", { slotId: "BB1" });

    await closeAll(room);
    await setLeftAt(roomId, -1);
    const entry = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
    expect(entry.kind).toBe("archived");
    if (entry.kind !== "archived") return;
    expect(entry.record.operations).toHaveLength(2);
    expect(entry.record.bpCompleted).toBe(false);
  });
});

describe("无有效提交的到期清理（三种空序列）", () => {
  it("仅预选未确认：到期直接清理，不生成空快照", async () => {
    // 开局但不推进任何确认步骤，只留下未提交的公开预选。
    const room = await startedRoom("仅预选赛", 0);
    const roomId = room.roomId;
    const agentIds = agentCatalogData.agents.map((agent) => agent.id);
    room.aWs.send({
      type: "setPreselect",
      slotId: "AB1",
      agentId: agentIds[0],
      operationId: "lifecycle-preselect-only",
      expectedBpVersion: Number(
        (await queryRoomRows(roomId, "SELECT bp_version FROM room_meta"))[0]?.bp_version,
      ),
    });
    expect((await room.aWs.commandResult("lifecycle-preselect-only")).ok).toBe(true);

    await closeAll(room);
    await setLeftAt(roomId, -1);
    expect((await getEntry(roomId)).status).toBe(404);
    expect(await businessTables(roomId)).toEqual([]);
    expect(await currentAlarm(roomId)).toBeNull();
  });

  it("全部撤回后到期：直接清理", async () => {
    const room = await startedRoom("全撤回赛", 2);
    const roomId = room.roomId;
    for (const operationId of ["lifecycle-undo-1", "lifecycle-undo-2"]) {
      room.hostWs.send({
        type: "undoBpStep",
        operationId,
        expectedBpVersion: Number(
          (await queryRoomRows(roomId, "SELECT bp_version FROM room_meta"))[0]?.bp_version,
        ),
      });
      expect((await room.hostWs.commandResult(operationId)).ok).toBe(true);
    }
    expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM bp_submissions")).toEqual([
      { n: 0 },
    ]);

    await closeAll(room);
    await setLeftAt(roomId, -1);
    expect((await getEntry(roomId)).status).toBe(404);
    expect(await businessTables(roomId)).toEqual([]);
  });

  it("重开后未提交到期：直接清理", async () => {
    const room = await startedRoom("重开空赛", 3);
    const roomId = room.roomId;
    room.hostWs.send({
      type: "restartBp",
      operationId: "lifecycle-restart-empty",
      expectedBpVersion: Number(
        (await queryRoomRows(roomId, "SELECT bp_version FROM room_meta"))[0]?.bp_version,
      ),
    });
    expect((await room.hostWs.commandResult("lifecycle-restart-empty")).ok).toBe(true);

    await closeAll(room);
    await setLeftAt(roomId, -1);
    expect((await getEntry(roomId)).status).toBe(404);
    expect(await businessTables(roomId)).toEqual([]);
  });
});

describe("保留计时隔离：HTTP 与展示不保活", () => {
  it("HTTP 读取/目录/入房登记与展示访问/消息均不取消或延长期限", async () => {
    const host = await createRoomViaHttp("保活验证赛", "主持人");
    const roomId = host.roomId;
    const leftAt = await setLeftAt(roomId, 60 * 60 * 1000);

    await getEntry(roomId);
    await exports.default.fetch(`${BASE_URL}/api/rooms/${roomId}/catalog`);
    const join = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: "新观众" }),
      }),
    );
    expect(join.status).toBe(200);
    const display = await TestWsClient.connectDisplay(roomId);
    await display.next("displayView");
    display.send({ kind: "junk", hello: 1 });
    const notice = await display.waitFor((message) => {
      if (message === null) return false;
      try {
        return (JSON.parse(message) as { kind?: string; code?: string }).kind === "notice";
      } catch {
        return false;
      }
    }, "展示只读通知");
    expect(notice).not.toBeNull();
    display.close();

    // 计时起点不变：期限既未取消也未顺延。Alarm 按当前期限收敛（读取会把
    // Alarm 对齐到当前持久期限，这不是顺延——期限本身未变）。
    expect(await queryRoomRows(roomId, "SELECT last_member_left_at FROM room_meta")).toEqual([
      { last_member_left_at: leftAt },
    ]);
    const alarm = await currentAlarm(roomId);
    expect(alarm).toBe(Date.parse(leftAt) + RETENTION_MS);
  });
});

describe("Alarm 调度与竞态收敛", () => {
  /** 把 Alarm 设为过去时间，让真实 alarm() 立即触发。 */
  function fireAlarmNow(roomId: string): Promise<void> {
    const stub = exports.Room.get(exports.Room.idFromName(roomId));
    return runInDurableObject(stub, (_room, state) => {
      state.storage.setAlarm(Date.now() - 1);
    });
  }

  it("真实 Alarm 推进归档：展示连接收到 ROOM_ARCHIVED 并终止，重连被拒", async () => {
    const room = await startedRoom("Alarm 归档赛", 2);
    const roomId = room.roomId;
    // 展示连接保持打开：归档转换时须收到终态通知并被关闭。
    const display = await TestWsClient.connectDisplay(roomId);
    await display.next("displayView");

    await closeAll(room);
    await setLeftAt(roomId, -1);
    await fireAlarmNow(roomId);
    expect(await waitLifecycle(roomId, "archived")).toBe(true);

    const notice = await display.waitFor((message) => {
      if (message === null) return false;
      try {
        const parsed = JSON.parse(message) as { kind?: string; code?: string };
        return parsed.kind === "notice" && parsed.code === "ROOM_ARCHIVED";
      } catch {
        return false;
      }
    }, "归档通知");
    expect(notice).not.toBeNull();
    expect((await display.waitForClose("归档关闭展示通道")).code).toBe(1008);

    // 归档后重连（成员与展示）都以 ROOM_ARCHIVED 终态拒绝。
    const memberRetry = await TestWsClient.connectMember(roomId, room.host.secret);
    const memberNotice = await memberRetry.next("notice");
    expect(memberNotice.code).toBe("ROOM_ARCHIVED");
    expect((await memberRetry.waitForClose("归档后成员重连拒绝")).code).toBe(1008);
    const displayRetry = await TestWsClient.connectDisplay(roomId);
    const displayNotice = await displayRetry.next("notice");
    expect(displayNotice.code).toBe("ROOM_ARCHIVED");

    // Alarm 已移到快照到期时间。
    const snapshot = await readStoredSnapshot(roomId);
    expect(snapshot).not.toBeNull();
    expect(await currentAlarm(roomId)).toBe(Date.parse(snapshot!.expiresAt));
  });

  it("重复/过早 Alarm：只按当前状态重判，不重复归档、不覆盖下一期限", async () => {
    const room = await startedRoom("重复 Alarm 赛", 1);
    const roomId = room.roomId;
    await closeAll(room);
    await setLeftAt(roomId, -1);

    // 读取路径先完成归档（Alarm 延迟时读仍裁决）。
    const entry = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
    expect(entry.kind).toBe("archived");
    if (entry.kind !== "archived") return;
    const alarmAfterArchive = await currentAlarm(roomId);
    expect(alarmAfterArchive).toBe(Date.parse(entry.record.expiresAt));

    // 过早 Alarm（快照未到期就触发）：按 archived 状态重判，不重复归档、
    // 不清理，并把 Alarm 收敛回快照到期时间。
    await fireAlarmNow(roomId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await waitLifecycle(roomId, "archived")).toBe(true);
    const snapshot = await readStoredSnapshot(roomId);
    expect(snapshot).toEqual(entry.record);
    expect(await currentAlarm(roomId)).toBe(Date.parse(entry.record.expiresAt));

    // 直接再执行一次 alarm 处理器（重试语义）：仍幂等。
    const stub = exports.Room.get(exports.Room.idFromName(roomId));
    await runInDurableObject(stub, (instance) => {
      void (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await readStoredSnapshot(roomId)).toEqual(entry.record);
    expect(await currentAlarm(roomId)).toBe(Date.parse(entry.record.expiresAt));
  });

  it("成员期限前回归取消计时：过期旧 Alarm 触发时按在线重判、不归档", async () => {
    const host = await createRoomViaHttp("回归赛", "主持人");
    const roomId = host.roomId;
    // 成员连接后离开：计时与 Alarm 写入；随后期限前重新连接（取消计时）。
    const first = await TestWsClient.connectMember(roomId, host.secret);
    await first.next("hostView");
    first.close();
    await waitLeftAt(roomId);
    expect((await currentAlarm(roomId)) ?? 0).toBeGreaterThan(Date.now());

    const reconnected = await TestWsClient.connectMember(roomId, host.secret);
    await reconnected.next("hostView");
    expect(await queryRoomRows(roomId, "SELECT last_member_left_at FROM room_meta")).toEqual([
      { last_member_left_at: null },
    ]);

    // 模拟取消失败的残留旧 Alarm：触发时成员在线，按 live 重判并自清。
    await fireAlarmNow(roomId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await waitLifecycle(roomId, "live")).toBe(true);
    expect(await currentAlarm(roomId)).toBeNull();

    // 房间仍可正常操作（回归成员未被误终止）。
    reconnected.send({
      type: "setTeamName",
      team: "A",
      teamName: "回归后队名",
      operationId: "lifecycle-after-return",
      expectedBpVersion: 0,
      expectedRevision: Number(
        (await queryRoomRows(roomId, "SELECT revision FROM room_meta"))[0]?.revision,
      ),
    });
    expect((await reconnected.commandResult("lifecycle-after-return")).ok).toBe(true);
    reconnected.close();
  });

  it("Alarm 丢失（延迟）时读/入仍先完成裁决并拒绝后续写入", async () => {
    const room = await startedRoom("延迟 Alarm 赛", 1);
    const roomId = room.roomId;
    await closeAll(room);
    await setLeftAt(roomId, -1);
    // 模拟 Alarm 永久丢失。
    await runInDurableObject(exports.Room.get(exports.Room.idFromName(roomId)), (_room, state) => {
      state.storage.deleteAlarm();
    });

    // 读取仍完成归档（期限由入口裁决强制，不依赖 Alarm）。
    const entry = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
    expect(entry.kind).toBe("archived");

    // 入房 410、目录 410、WS 终态拒绝：归档房间无任何写入口。
    const join = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: "观众" }),
      }),
    );
    expect(join.status).toBe(410);
    expect(apiErrorResponseBodySchema.parse(await join.json()).error.code).toBe("ROOM_ARCHIVED");
    const catalog = await exports.default.fetch(`${BASE_URL}/api/rooms/${roomId}/catalog`);
    expect(catalog.status).toBe(410);
    expect(apiErrorResponseBodySchema.parse(await catalog.json()).error.code).toBe("ROOM_ARCHIVED");
    const ws = await TestWsClient.connectMember(roomId, room.host.secret);
    expect((await ws.next("notice")).code).toBe("ROOM_ARCHIVED");
  });

  it("已归档房间的成员命令按 ROOM_ARCHIVED 拒绝并关闭（防御路径）", async () => {
    // 归档房间不可能有有效成员连接（接纳即拒绝）；本用例以 SQL 构造
    // 「已归档但连接仍在」的防御状态，验证命令入口的裁决与终态消息顺序
    // （commandResult 先于通知/关闭）。
    const host = await createRoomViaHttp("命令拒绝赛", "主持人");
    const roomId = host.roomId;
    const client = await TestWsClient.connectMember(roomId, host.secret);
    await client.next("hostView");

    const archivedAt = new Date().toISOString();
    const snapshot = archiveSnapshotSchema.parse({
      roomId,
      roomName: "命令拒绝赛",
      teamNames: { A: "左", B: "右" },
      bpCompleted: false,
      operations: [
        {
          slotId: "AB1",
          team: "A",
          action: "ban",
          agentId: agentCatalogData.agents[0]!.id,
          agentName: agentCatalogData.agents[0]!.name,
          agentAvatarUrl: null,
        },
      ],
      versions: {
        ruleVersion: BP_RULE_VERSION,
        agentDataVersion: agentCatalogData.agentDataVersion,
      },
      archivedAt,
      expiresAt: computeSnapshotDeadline(archivedAt),
    });
    await execInRoom(
      roomId,
      `UPDATE room_meta SET lifecycle = 'archived';
       INSERT INTO archive_snapshot (id, snapshot_json) VALUES (1, '${JSON.stringify(snapshot).replace(/'/g, "''")}')`,
    );

    client.send({
      type: "setTeamName",
      team: "A",
      teamName: "不应生效",
      operationId: "lifecycle-archived-command",
      expectedBpVersion: 0,
      expectedRevision: 0,
    });
    const result = await client.commandResult("lifecycle-archived-command");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ROOM_ARCHIVED");
    const notice = await client.next("notice");
    expect(notice.code).toBe("ROOM_ARCHIVED");
    expect((await client.waitForClose("归档命令后关闭")).code).toBe(1008);
  });
});

describe("归档失败与恢复", () => {
  it("归档 SQL 故障整体回滚：读取 500、房间仍 live，恢复后读取重试成功", async () => {
    const room = await startedRoom("归档故障赛", 2);
    const roomId = room.roomId;
    await closeAll(room);
    await setLeftAt(roomId, -1);

    // 注入故障：快照写入失败 → 归档转换整体回滚（不半归档）。
    await execInRoom(
      roomId,
      "CREATE TRIGGER test_archive_fault BEFORE INSERT ON archive_snapshot BEGIN SELECT RAISE(ABORT, 'test injected archive failure'); END",
    );
    const failed = await getEntry(roomId);
    expect(failed.status).toBe(500);
    expect(apiErrorResponseBodySchema.parse(await failed.json()).error.code).toBe("INTERNAL");
    expect(await waitLifecycle(roomId, "live")).toBe(true);
    // 回滚不留半归档：无快照行，成员与序列完整保留。
    expect(await readStoredSnapshot(roomId)).toBeNull();
    expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM members")).toEqual([{ n: 3 }]);
    expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM bp_submissions")).toEqual([
      { n: 2 },
    ]);

    // 恢复后同一读取重试成功完成归档。
    await execInRoom(roomId, "DROP TRIGGER test_archive_fault");
    const entry = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
    expect(entry.kind).toBe("archived");
  });
});

describe("实例重建与 v2 迁移", () => {
  it("重建后 deadline 与快照恢复：读取同一份记录，Alarm 由持久存储恢复", async () => {
    const room = await startedRoom("重建归档赛", 2);
    const roomId = room.roomId;
    await closeAll(room);
    await setLeftAt(roomId, -1);
    const entry = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
    expect(entry.kind).toBe("archived");

    // 拆除实例（保留持久存储与平台 Alarm）：读取从 SQLite 恢复同一快照。
    await evictDurableObject(exports.Room.get(exports.Room.idFromName(roomId)));
    const after = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
    expect(after).toEqual(entry);
    const snapshot = await readStoredSnapshot(roomId);
    expect(snapshot).not.toBeNull();
    expect(await currentAlarm(roomId)).toBe(Date.parse(snapshot!.expiresAt));
  });

  it("空房期限跨实例重建保留", async () => {
    const host = await createRoomViaHttp("重建期限赛", "主持人");
    const roomId = host.roomId;
    const alarm = await currentAlarm(roomId);
    expect(alarm).not.toBeNull();

    await evictDurableObject(exports.Room.get(exports.Room.idFromName(roomId)));
    expect(await currentAlarm(roomId)).toBe(alarm);
    // 重建后读取仍为 live。
    const entry = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
    expect(entry.kind).toBe("live");
  });

  it("既有 v2 房间首次访问完成迁移并补设 Alarm", async () => {
    const host = await createRoomViaHttp("v2 迁移赛", "主持人");
    const roomId = host.roomId;
    // 模拟 v2 结构：移除 archive_snapshot 表并把版本降回 2，清掉 Alarm。
    await execInRoom(roomId, "DROP TABLE archive_snapshot; UPDATE schema_meta SET version = 2");
    await runInDurableObject(exports.Room.get(exports.Room.idFromName(roomId)), (_room, state) => {
      state.storage.deleteAlarm();
    });
    expect(await currentAlarm(roomId)).toBeNull();

    // 首次访问：迁移到 v3（表恢复）并按当前状态补设空房期限 Alarm。
    const entry = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
    expect(entry.kind).toBe("live");
    expect(await queryRoomRows(roomId, "SELECT version FROM schema_meta")).toEqual([
      { version: 3 },
    ]);
    expect(
      await queryRoomRows(
        roomId,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archive_snapshot'",
      ),
    ).toEqual([{ name: "archive_snapshot" }]);
    const alarm = await currentAlarm(roomId);
    const leftAt = Date.parse(
      String((await queryRoomRows(roomId, "SELECT created_at FROM room_meta"))[0]?.created_at),
    );
    expect(Math.abs((alarm ?? 0) - (leftAt + RETENTION_MS))).toBeLessThanOrEqual(5_000);
  });
});

describe("90 天快照到期清理", () => {
  it("快照到期：清理后原链接按不存在收口，未知访问零写入", async () => {
    const room = await startedRoom("快照到期赛", 2);
    const roomId = room.roomId;
    await closeAll(room);
    await setLeftAt(roomId, -1);
    const entry = roomEntryResponseSchema.parse(await (await getEntry(roomId)).json());
    expect(entry.kind).toBe("archived");

    // 受控时间推进：把持久快照改写为 91 天前归档（archivedAt 与 expiresAt
    // 保持 90 天关系，仍通过 schema 校验）。
    const stored = await readStoredSnapshot(roomId);
    expect(stored).not.toBeNull();
    const oldArchivedAt = new Date(
      Date.now() - SNAPSHOT_RETENTION_MS - 24 * 60 * 60 * 1000,
    ).toISOString();
    const expired = archiveSnapshotSchema.parse({
      ...stored,
      archivedAt: oldArchivedAt,
      expiresAt: computeSnapshotDeadline(oldArchivedAt),
    });
    await execInRoom(
      roomId,
      `UPDATE archive_snapshot SET snapshot_json = '${JSON.stringify(expired).replace(/'/g, "''")}'`,
    );

    const response = await getEntry(roomId);
    expect(response.status).toBe(404);
    expect(await businessTables(roomId)).toEqual([]);
    expect(await currentAlarm(roomId)).toBeNull();

    // 清理后的后续 GET/POST/WS 不重建表或期限。
    expect((await getEntry(roomId)).status).toBe(404);
    const ws = await TestWsClient.connectDisplay(roomId);
    expect((await ws.next("notice")).code).toBe("ROOM_NOT_FOUND");
    expect(await businessTables(roomId)).toEqual([]);
    expect(await currentAlarm(roomId)).toBeNull();
  });
});

describe("终态连接收口：任何入口与重试都幂等收敛现存实时通道", () => {
  /** 等待客户端收到指定 notice 并返回其内容；超时抛错。 */
  async function waitNotice(
    client: TestWsClient,
    code: string,
    label: string,
    timeoutMs = 3000,
  ): Promise<void> {
    await client.waitFor(
      (message) => {
        if (message === null) return false;
        try {
          const parsed = JSON.parse(message) as { kind?: string; code?: string };
          return parsed.kind === "notice" && parsed.code === code;
        } catch {
          return false;
        }
      },
      label,
      timeoutMs,
    );
  }

  /**
   * 到期房间 + 保持打开的展示连接：裁决经真实 HTTP/WS 入口或 Alarm
   * 执行时，现存展示连接必须收到终态通知并被关闭——展示客户端没有
   * 心跳，遗漏通知会永远保留「已连接」的旧画面。
   */
  async function expiredRoomWithDisplay(withStep: boolean): Promise<{
    roomId: string;
    hostSecret: string;
    display: TestWsClient;
  }> {
    const room = await startedRoom(withStep ? "终态收口赛" : "终态清理赛", withStep ? 1 : 0);
    const roomId = room.roomId;
    const display = await TestWsClient.connectDisplay(roomId);
    await display.next("displayView");
    await closeAll(room);
    await setLeftAt(roomId, -1);
    return { roomId, hostSecret: room.host.secret, display };
  }

  it.each([
    { label: "GET 房间入口", kind: "entry" },
    { label: "POST members 入房", kind: "join" },
    { label: "GET catalog 目录", kind: "catalog" },
    { label: "成员 WS 接纳", kind: "member-ws" },
    { label: "展示 WS 接纳", kind: "display-ws" },
  ] as const)(
    "HTTP/WS 入口触发归档（$label）：展示连接收 ROOM_ARCHIVED 并关闭",
    async ({ kind }) => {
      const { roomId, hostSecret, display } = await expiredRoomWithDisplay(true);
      try {
        if (kind === "entry") {
          const response = await getEntry(roomId);
          expect(response.status).toBe(200);
          expect(roomEntryResponseSchema.parse(await response.json()).kind).toBe("archived");
        } else if (kind === "join") {
          const response = await exports.default.fetch(
            new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ nickname: "观众" }),
            }),
          );
          expect(response.status).toBe(410);
        } else if (kind === "catalog") {
          const response = await exports.default.fetch(`${BASE_URL}/api/rooms/${roomId}/catalog`);
          expect(response.status).toBe(410);
        } else if (kind === "member-ws") {
          // 成员通道接纳：先完成到期裁决与终态收口，再以 ROOM_ARCHIVED
          // 拒绝新连接（即使凭据有效也不能注册连接清掉已过期期限）。
          const client = await TestWsClient.connectMember(roomId, hostSecret);
          expect((await client.next("notice")).code).toBe("ROOM_ARCHIVED");
          expect((await client.waitForClose("归档后成员接纳拒绝")).code).toBe(1008);
        } else {
          const client = await TestWsClient.connectDisplay(roomId);
          expect((await client.next("notice")).code).toBe("ROOM_ARCHIVED");
        }
        await waitNotice(display, "ROOM_ARCHIVED", "归档通知");
        expect((await display.waitForClose("归档关闭展示通道")).code).toBe(1008);
      } finally {
        display.close();
      }
    },
  );

  it.each([
    { label: "HTTP 读取触发", kind: "http" },
    { label: "Alarm 触发", kind: "alarm" },
  ] as const)("空序列到期清理（$label）：展示连接收 ROOM_NOT_FOUND 并关闭", async ({ kind }) => {
    const { roomId, display } = await expiredRoomWithDisplay(false);
    try {
      if (kind === "http") {
        expect((await getEntry(roomId)).status).toBe(404);
      } else {
        await runInDurableObject(exports.Room.get(exports.Room.idFromName(roomId)), (_r, state) => {
          state.storage.setAlarm(Date.now() - 1);
        });
        expect(
          await waitForRoomQuery(
            roomId,
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'room_meta'",
            "n",
            0,
            5000,
          ),
        ).toBe(true);
      }
      await waitNotice(display, "ROOM_NOT_FOUND", "清理通知");
      expect((await display.waitForClose("清理关闭展示通道")).code).toBe(1008);
      expect(await currentAlarm(roomId)).toBeNull();
    } finally {
      display.close();
    }
  });

  it("归档已提交但 Alarm 写入失败：恢复后的重试仍完成终态通知与 Alarm 补齐", async () => {
    const { roomId, display } = await expiredRoomWithDisplay(true);
    const stub = exports.Room.get(exports.Room.idFromName(roomId));
    try {
      // 注入 setAlarm 故障：alarm() 的 SQL 归档照常提交，Alarm 写入抛错。
      const first = await runInDurableObject(stub, async (instance, state) => {
        const original = state.storage.setAlarm.bind(state.storage);
        state.storage.setAlarm = async () => {
          throw new Error("review injected setAlarm failure");
        };
        try {
          await (instance as unknown as { alarm(): Promise<void> }).alarm();
          return "did not fail";
        } catch {
          return "failed";
        } finally {
          state.storage.setAlarm = original;
        }
      });
      expect(first).toBe("failed");
      // SQL 归档已持久成立；通知在 Alarm 恢复前不发出（不发假终态）。
      expect((await queryRoomRows(roomId, "SELECT lifecycle FROM room_meta"))[0]?.lifecycle).toBe(
        "archived",
      );

      // 平台重试（或任意入口）恢复后：终态通知幂等补齐，Alarm 补设。
      await runInDurableObject(stub, async (instance) => {
        await (instance as unknown as { alarm(): Promise<void> }).alarm();
      });
      await waitNotice(display, "ROOM_ARCHIVED", "恢复重试后的归档通知");
      expect((await display.waitForClose("恢复重试后关闭")).code).toBe(1008);
      const snapshot = await readStoredSnapshot(roomId);
      expect(snapshot).not.toBeNull();
      expect(await currentAlarm(roomId)).toBe(Date.parse(snapshot!.expiresAt));
    } finally {
      display.close();
    }
  });

  it("入房的前置 Alarm 收敛失败：零成员写入、无凭据交付，恢复后重试正常建成员", async () => {
    const host = await createRoomViaHttp("入房收敛故障赛", "主持人");
    const roomId = host.roomId;
    const stub = exports.Room.get(exports.Room.idFromName(roomId));
    const revisionBefore = Number(
      (await queryRoomRows(roomId, "SELECT revision FROM room_meta"))[0]?.revision,
    );

    // 注入：删除既有 Alarm（使收敛必然走 setAlarm）并让 setAlarm 失败。
    await runInDurableObject(stub, async (_r, state) => {
      await state.storage.deleteAlarm();
      const target = state.storage as unknown as {
        setAlarm: (...args: unknown[]) => Promise<void>;
        __restore?: () => void;
      };
      const original = target.setAlarm.bind(target);
      target.setAlarm = async () => {
        throw new Error("review injected setAlarm failure");
      };
      target.__restore = () => {
        target.setAlarm = original;
      };
    });

    try {
      const response = await exports.default.fetch(
        new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nickname: "不应存在的观众" }),
        }),
      );
      // 失败零写入：500、无 Cookie、成员与 revision 不变（无孤儿成员）。
      expect(response.status).toBe(500);
      expect(response.headers.has("Set-Cookie")).toBe(false);
      expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM members")).toEqual([{ n: 1 }]);
      expect(await queryRoomRows(roomId, "SELECT revision FROM room_meta")).toEqual([
        { revision: revisionBefore },
      ]);
    } finally {
      await runInDurableObject(stub, (_r, state) => {
        (state.storage as unknown as { __restore: () => void }).__restore();
      });
    }

    // 故障解除后重试：前置收敛成功，成员写入与凭据交付正常，Alarm 在期限上。
    const retry = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: "恢复后的观众" }),
      }),
    );
    expect(retry.status).toBe(200);
    expect(retry.headers.has("Set-Cookie")).toBe(true);
    expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM members")).toEqual([{ n: 2 }]);
    expect(await queryRoomRows(roomId, "SELECT revision FROM room_meta")).toEqual([
      { revision: revisionBefore + 1 },
    ]);
    const leftAt = Date.parse(
      String((await queryRoomRows(roomId, "SELECT created_at FROM room_meta"))[0]?.created_at),
    );
    expect(
      Math.abs(((await currentAlarm(roomId)) ?? 0) - (leftAt + RETENTION_MS)),
    ).toBeLessThanOrEqual(5_000);
  });

  it("清理的冗余 deleteAlarm 失败：deleteAll 成功即完成收口，Alarm 清理独立自清", async () => {
    // 半收口故障边界：deleteAll 原子成功（持久数据已删除 = ROOM_NOT_FOUND
    // 终态），其后的冗余 deleteAlarm 失败不得挡住旧连接的终止——收口在
    // deleteAll 成功后立即执行；残留 Alarm（仅旧运行时语义）触发时由
    // alarm() 按 not_found 自清，无需平台重试。deleteAll 自身失败仍会
    // 上抛、不发假终态。
    const host = await createRoomViaHttp("清理收口故障赛", "主持人");
    const roomId = host.roomId;
    const display = await TestWsClient.connectDisplay(roomId);
    await display.next("displayView");
    await setLeftAt(roomId, -1);
    const stub = exports.Room.get(exports.Room.idFromName(roomId));
    try {
      const first = await runInDurableObject(stub, async (instance, state) => {
        const original = state.storage.deleteAlarm.bind(state.storage);
        state.storage.deleteAlarm = async () => {
          throw new Error("review injected deleteAlarm failure");
        };
        try {
          await (instance as unknown as { alarm(): Promise<void> }).alarm();
          return "success";
        } catch {
          return "failure";
        } finally {
          state.storage.deleteAlarm = original;
        }
      });
      // 冗余清理失败被独立处理：alarm() 不抛错，deleteAll 已完成，
      // 终态收口（通知 + 关闭）在本次执行内送达。
      expect(first).toBe("success");
      expect(
        await queryRoomRows(
          roomId,
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'room_meta'",
        ),
      ).toEqual([{ n: 0 }]);
      await waitNotice(display, "ROOM_NOT_FOUND", "清理收口通知");
      expect((await display.waitForClose("清理收口关闭")).code).toBe(1008);
      expect(await currentAlarm(roomId)).toBeNull();
      // 恢复后的任何入口重放（含 not_found 路径）不再依赖重试补齐。
      expect((await getEntry(roomId)).status).toBe(404);
    } finally {
      display.close();
    }
  });

  it("入房兜底修复持久在线残留：补写离开时间并设新期限 Alarm", async () => {
    // 持久恢复状态：最后断开的协调写入失败且旧实例/重试链已丢失——
    // 存储 online=1、last_member_left_at=null、无连接、无 Alarm（schema
    // 合法，正是文档承诺由下一个入房事件兜底的状态）。入房的阶段一先
    // 协调（修复残留并补写离开时间）再裁决：新期限的 Alarm 应用与协调
    // 写入都在成员事务之前完成。
    const host = await createRoomViaHttp("入房兜底修复赛", "主持人");
    const roomId = host.roomId;
    const stub = exports.Room.get(exports.Room.idFromName(roomId));
    await execInRoom(
      roomId,
      "UPDATE members SET online = 1; UPDATE room_meta SET last_member_left_at = NULL",
    );
    await runInDurableObject(stub, async (_r, state) => {
      await state.storage.deleteAlarm();
    });
    expect(await runInDurableObject(stub, (_r, state) => state.getWebSockets().length)).toBe(0);

    const response = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: "兜底修复观众" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.has("Set-Cookie")).toBe(true);
    const leftAt = (await queryRoomRows(roomId, "SELECT last_member_left_at FROM room_meta"))[0]
      ?.last_member_left_at;
    expect(typeof leftAt).toBe("string");
    expect(await queryRoomRows(roomId, "SELECT online FROM members")).toEqual([
      { online: 0 },
      { online: 0 },
    ]);
    // 新离开时间有对应的空房期限 Alarm（否则无人访问时永不自动清理）。
    expect(await currentAlarm(roomId)).toBe(Date.parse(String(leftAt)) + RETENTION_MS);
  });

  it("入房兜底修复路径的 setAlarm 故障：零成员写入，恢复后重试正常", async () => {
    const host = await createRoomViaHttp("入房兜底故障赛", "主持人");
    const roomId = host.roomId;
    const stub = exports.Room.get(exports.Room.idFromName(roomId));
    await execInRoom(
      roomId,
      "UPDATE members SET online = 1; UPDATE room_meta SET last_member_left_at = NULL",
    );
    await runInDurableObject(stub, async (_r, state) => {
      await state.storage.deleteAlarm();
      const target = state.storage as unknown as {
        setAlarm: (...args: unknown[]) => Promise<void>;
        __restore?: () => void;
      };
      const original = target.setAlarm.bind(target);
      target.setAlarm = async () => {
        throw new Error("review injected setAlarm failure");
      };
      target.__restore = () => {
        target.setAlarm = original;
      };
    });
    try {
      const response = await exports.default.fetch(
        new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nickname: "不应存在" }),
        }),
      );
      // 阶段一（协调 + 新期限 Alarm）失败在成员事务之前：500、零成员
      // 写入、无凭据交付。
      expect(response.status).toBe(500);
      expect(response.headers.has("Set-Cookie")).toBe(false);
      expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM members")).toEqual([{ n: 1 }]);
    } finally {
      await runInDurableObject(stub, (_r, state) => {
        (state.storage as unknown as { __restore: () => void }).__restore();
      });
    }

    // 恢复后重试：协调已修复（幂等），Alarm 设上新期限，成员正常写入。
    const retry = await exports.default.fetch(
      new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: "恢复后观众" }),
      }),
    );
    expect(retry.status).toBe(200);
    expect(retry.headers.has("Set-Cookie")).toBe(true);
    expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM members")).toEqual([{ n: 2 }]);
    const leftAt = (await queryRoomRows(roomId, "SELECT last_member_left_at FROM room_meta"))[0]
      ?.last_member_left_at;
    expect(typeof leftAt).toBe("string");
    expect(await currentAlarm(roomId)).toBe(Date.parse(String(leftAt)) + RETENTION_MS);
  });

  it("终态收口触发的成员 close 回调不产生无意义重试", async () => {
    const host = await createRoomViaHttp("归档关闭回调赛", "主持人");
    const roomId = host.roomId;
    // 构造「已归档但成员连接仍在」的防御状态（正常运行中接纳即拒绝，
    // 此处验证终态关闭后的 close 回调路径）。
    const client = await TestWsClient.connectMember(roomId, host.secret);
    await client.next("hostView");
    const archivedAt = new Date().toISOString();
    const snapshot = archiveSnapshotSchema.parse({
      roomId,
      roomName: "归档关闭回调赛",
      teamNames: { A: "左", B: "右" },
      bpCompleted: false,
      operations: [
        {
          slotId: "AB1",
          team: "A",
          action: "ban",
          agentId: agentCatalogData.agents[0]!.id,
          agentName: agentCatalogData.agents[0]!.name,
          agentAvatarUrl: null,
        },
      ],
      versions: {
        ruleVersion: BP_RULE_VERSION,
        agentDataVersion: agentCatalogData.agentDataVersion,
      },
      archivedAt,
      expiresAt: computeSnapshotDeadline(archivedAt),
    });
    await execInRoom(
      roomId,
      `UPDATE room_meta SET lifecycle = 'archived';
       INSERT INTO archive_snapshot (id, snapshot_json) VALUES (1, '${JSON.stringify(snapshot).replace(/'/g, "''")}')`,
    );

    // 读取入口触发终态收口：成员连接收通知并被关闭；close 回调对非 live
    // 房间零写入跳过，不触发协调重试链（无 close/presence-retry 诊断日志）。
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await getEntry(roomId)).status).toBe(200);
      await waitNotice(client, "ROOM_ARCHIVED", "收口通知");
      expect((await client.waitForClose("收口关闭")).code).toBe(1008);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const lifecycleErrors = errorSpy.mock.calls.filter(([message]) => {
        const text = String(message);
        return (
          text.includes('"phase":"close"') ||
          text.includes('"phase":"presence-retry"') ||
          text.includes("在线协调")
        );
      });
      expect(lifecycleErrors).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      client.close();
    }
  });
});
