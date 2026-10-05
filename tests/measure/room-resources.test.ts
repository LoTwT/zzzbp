import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { agentCatalogData } from "../../shared/agents/catalog";
import { BP_STEP_ORDER } from "../../shared/bp/steps";
import { archiveSnapshotSchema } from "../../shared/contracts/records";
import {
  currentAlarm,
  currentRevisionOf,
  execInRoom,
  createRoomViaHttp,
  joinMemberViaHttp,
  queryRoomRows,
  TestWsClient,
  type TestMember,
} from "../workers/ws-helpers";

/**
 * 本地资源基准（PR10）：在真实 workerd + SQLite 上测量首版典型房间与
 * 有界示例规模下的数据量、消息量与本地耗时，为
 * docs/specs/cloudflare-budget.md 的容量估算提供可复现输入。
 *
 * 诚实边界：
 * - 这是本地 workerd 观测（消息为逻辑 JSON 字节、存储为 SQLite 分配与
 *   行内容长度、耗时为本地 wall-clock），不是 Cloudflare 计费实测；
 *   计费单位（请求、SQL 行读写、GB-s）的换算规则由预算文档维护。
 * - SQL 行读取/写入的计费口径无法在本地直接观测，预算文档按代码路径
 *   的语句形状估算并标注为推算。
 * - 示例规模（房间数/连接数/预选频率）是假设情景，不是用户已确定规模。
 *
 * 用法：pnpm measure:rooms（输出 JSON 到标准输出）。
 */

const encoder = new TextEncoder();
function bytes(text: string): number {
  return encoder.encode(text).length;
}

/** 跟踪一组连接上收到的帧数与逻辑字节（UTF-8 JSON 文本）。 */
class TrafficMeter {
  private readonly clients: readonly TestWsClient[];
  private readonly mark = new Map<TestWsClient, number>();
  private frames = 0;
  private byteCount = 0;

  constructor(clients: readonly TestWsClient[]) {
    this.clients = clients;
    this.resetBaseline();
  }

  private resetBaseline(): void {
    for (const client of this.clients) this.mark.set(client, client.received.length);
  }

  /** 读取自上次 reset/read 之后的增量。 */
  read(): { frames: number; bytes: number } {
    for (const client of this.clients) {
      const from = this.mark.get(client) ?? 0;
      for (let index = from; index < client.received.length; index += 1) {
        this.frames += 1;
        this.byteCount += bytes(client.received[index] ?? "");
      }
      this.mark.set(client, client.received.length);
    }
    return { frames: this.frames, bytes: this.byteCount };
  }

  reset(): void {
    this.frames = 0;
    this.byteCount = 0;
    this.resetBaseline();
  }
}

function now(): number {
  return performance.now();
}

/** 房间业务表的行数（观察持久数据的行规模）。 */
async function tableRows(roomId: string): Promise<Record<string, number>> {
  const names = (
    await queryRoomRows(
      roomId,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
  )
    .map((row) => String(row.name))
    .sort();
  const stats: Record<string, number> = {};
  for (const name of names) {
    stats[name] = Number(
      (await queryRoomRows(roomId, `SELECT COUNT(*) AS n FROM ${name}`))[0]?.n ?? 0,
    );
  }
  return stats;
}

/** SQLite 分配信息（表值 PRAGMA 函数可用时）；不支持时返回 null。 */
async function sqliteAlloc(roomId: string): Promise<number | null> {
  const stub = exports.Room.get(exports.Room.idFromName(roomId));
  return runInDurableObject(stub, (_room, state) => state.storage.sql.databaseSize);
}

interface MemberSet {
  readonly host: TestMember;
  readonly playerA: TestMember;
  readonly playerB: TestMember;
  readonly spectator: TestMember;
  readonly hostWs: TestWsClient;
  readonly aWs: TestWsClient;
  readonly bWs: TestWsClient;
  readonly spectatorWs: TestWsClient;
  readonly displayWs: TestWsClient;
}

/** 建房 + 三人入房 + 四个成员连接 + 一个展示连接。 */
async function connectRoom(roomName: string): Promise<{
  room: MemberSet;
  roomId: string;
  joinMs: number[];
}> {
  const host = await createRoomViaHttp(roomName, "主持人");
  const roomId = host.roomId;
  const joinMs: number[] = [];
  const joined: TestMember[] = [];
  for (const nickname of ["选手甲", "选手乙", "观众星河"]) {
    const started = now();
    joined.push(await joinMemberViaHttp(roomId, nickname));
    joinMs.push(Math.round(now() - started));
  }
  const [playerA, playerB, spectator] = joined;
  if (playerA === undefined || playerB === undefined || spectator === undefined) {
    throw new Error("成员创建失败");
  }
  const hostWs = await TestWsClient.connectMember(roomId, host.secret);
  const aWs = await TestWsClient.connectMember(roomId, playerA.secret);
  const bWs = await TestWsClient.connectMember(roomId, playerB.secret);
  const spectatorWs = await TestWsClient.connectMember(roomId, spectator.secret);
  const displayWs = await TestWsClient.connectDisplay(roomId);
  await hostWs.next("hostView");
  await aWs.next("memberView");
  await bWs.next("memberView");
  await spectatorWs.next("memberView");
  await displayWs.next("displayView");
  return {
    room: { host, playerA, playerB, spectator, hostWs, aWs, bWs, spectatorWs, displayWs },
    roomId,
    joinMs,
  };
}

/** 开局并推进全部 26 步（每步含公开预选更换），返回消息与耗时增量。 */
async function playFullGame(room: MemberSet, roomId: string) {
  const meter = new TrafficMeter([
    room.hostWs,
    room.aWs,
    room.bWs,
    room.spectatorWs,
    room.displayWs,
  ]);
  const steps: Array<{ slot: string; ms: number; frames: number; bytes: number }> = [];

  let bpVersion = 0;
  async function send(client: TestWsClient, type: string, extra: Record<string, unknown>) {
    const operationId = `measure-${type}-${crypto.randomUUID()}`;
    client.send({
      type,
      ...extra,
      operationId,
      expectedBpVersion: bpVersion,
      ...(type === "setTeamName" ? { expectedRevision: await currentRevisionOf(roomId) } : {}),
    });
    const result = await client.commandResult(operationId);
    if (!result.ok) throw new Error(`${type} 失败：${result.error?.code ?? "?"}`);
    bpVersion = result.bpVersion;
    return result;
  }

  const setupStart = now();
  await send(room.hostWs, "setTeamName", { team: "A", teamName: "左方队" });
  await send(room.hostWs, "setTeamName", { team: "B", teamName: "右方队" });
  await send(room.hostWs, "assignSeat", { team: "A", targetMemberId: room.playerA.memberId });
  await send(room.hostWs, "assignSeat", { team: "B", targetMemberId: room.playerB.memberId });
  await send(room.hostWs, "startBp", {});
  const setupMs = Math.round(now() - setupStart);
  const setupTraffic = meter.read();

  const agentIds = agentCatalogData.agents.map((agent) => agent.id);
  meter.reset();
  let preselectFrames = 0;
  let preselectBytes = 0;
  for (const [index, step] of BP_STEP_ORDER.entries()) {
    const client = step.startsWith("A") ? room.aWs : room.bWs;
    const agentId = agentIds[index];
    if (agentId === undefined) throw new Error("名单不足");
    meter.reset();
    const started = now();
    await send(client, "setPreselect", { slotId: step, agentId });
    // 公开预选频率示例：每步 2 次更换（首步 5 次），末次换回目标代理人。
    const churn = index === 0 ? 5 : 2;
    for (let change = 0; change < churn; change += 1) {
      const next = agentIds[index + 26 + change];
      if (next === undefined) break;
      await send(client, "setPreselect", { slotId: step, agentId: next });
    }
    if (churn > 0) {
      await send(client, "setPreselect", { slotId: step, agentId });
    }
    const preRead = meter.read();
    preselectFrames += preRead.frames;
    preselectBytes += preRead.bytes;
    await send(client, "confirmPreselect", { slotId: step });
    const traffic = meter.read();
    steps.push({
      slot: step,
      ms: Math.round(now() - started),
      frames: traffic.frames,
      bytes: traffic.bytes,
    });
  }

  return { steps, setupMs, setupTraffic, preselectFrames, preselectBytes };
}

/** 等待空房计时写入（全员离开后 last_member_left_at 非 null）。 */
async function waitLeftAt(roomId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = (await queryRoomRows(roomId, "SELECT last_member_left_at FROM room_meta"))[0]
      ?.last_member_left_at;
    if (typeof value === "string") return;
    if (Date.now() >= deadline) throw new Error("等待空房计时写入超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 经真实 HTTP 读取房间入口，只区分 live/archived/not-found。 */
async function fetchEntryKind(path: string): Promise<string> {
  const response = await exports.default.fetch(new Request(`http://localhost${path}`));
  if (response.status === 404) return "not-found";
  const body = (await response.json()) as { kind?: string };
  return body.kind ?? "unknown";
}

/** 把空房计时改写为已过期（受控时间戳，与生命周期测试同一手法）。 */
async function expireEmptyRoom(roomId: string): Promise<void> {
  await execInRoom(
    roomId,
    `UPDATE room_meta SET last_member_left_at = '${new Date(Date.now() - 13 * 3600_000).toISOString()}'`,
  );
}

it("典型房间分阶段资源测量（含归档与清理）", async () => {
  const report: Record<string, unknown> = {
    说明: "本地 workerd + SQLite 观测，非 Cloudflare 计费实测；字节为逻辑 JSON/内容长度。",
  };

  // ---- 典型房间：建房、入房、连接、开局、26 步、归档 ----
  const created = await connectRoom("资源测量赛");
  const { room, roomId, joinMs } = created;
  const play = await playFullGame(room, roomId);
  const afterBp = await tableRows(roomId);
  const allocAfterBp = await sqliteAlloc(roomId);

  const receipts = await queryRoomRows(
    roomId,
    "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload_json) + LENGTH(COALESCE(error_message, '')) + 48), 0) AS b FROM command_receipts",
  );
  const catalogRow = await queryRoomRows(
    roomId,
    "SELECT LENGTH(catalog_json) AS b FROM room_catalog",
  );

  // ---- 归档：全员断开 → 到期裁决（真实读取路径） ----
  for (const client of [room.hostWs, room.aWs, room.bWs, room.spectatorWs, room.displayWs]) {
    client.close();
  }
  await waitLeftAt(roomId);
  await expireEmptyRoom(roomId);
  const readStart = now();
  const archivedKind = await fetchEntryKind(`/api/rooms/${roomId}`);
  const archiveReadMs = Math.round(now() - readStart);
  const snapshotRow = await queryRoomRows(
    roomId,
    "SELECT LENGTH(snapshot_json) AS b FROM archive_snapshot",
  );
  const afterArchive = await tableRows(roomId);
  const allocAfterArchive = await sqliteAlloc(roomId);
  const alarm = await currentAlarm(roomId);
  const snapshot = archiveSnapshotSchema.parse(
    JSON.parse(
      String(
        (await queryRoomRows(roomId, "SELECT snapshot_json FROM archive_snapshot"))[0]
          ?.snapshot_json,
      ),
    ),
  );
  expect(archivedKind).toBe("archived");
  expect(snapshot.operations).toHaveLength(BP_STEP_ORDER.length);

  // ---- 空记录房间（仅预选、无确认）：到期直接清理 ----
  const emptyHost = await createRoomViaHttp("空记录测量赛", "主持人");
  const emptyId = emptyHost.roomId;
  const emptyGuest = await joinMemberViaHttp(emptyId, "选手乙");
  const emptyHostWs = await TestWsClient.connectMember(emptyId, emptyHost.secret);
  const emptyGuestWs = await TestWsClient.connectMember(emptyId, emptyGuest.secret);
  await emptyHostWs.next("hostView");
  await emptyGuestWs.next("memberView");
  let emptyVersion = 0;
  const emptyCommand = async (
    client: TestWsClient,
    type: string,
    extra: Record<string, unknown>,
  ) => {
    const operationId = `measure-empty-${type}-${crypto.randomUUID()}`;
    client.send({
      type,
      ...extra,
      operationId,
      expectedBpVersion: emptyVersion,
      ...(type === "setTeamName" ? { expectedRevision: await currentRevisionOf(emptyId) } : {}),
    });
    const result = await client.commandResult(operationId);
    if (!result.ok) throw new Error(`${type} 失败：${result.error?.code ?? "?"}`);
    emptyVersion = result.bpVersion;
  };
  await emptyCommand(emptyHostWs, "setTeamName", { team: "A", teamName: "左方队" });
  await emptyCommand(emptyHostWs, "setTeamName", { team: "B", teamName: "右方队" });
  await emptyCommand(emptyHostWs, "assignSeat", { team: "A", targetMemberId: emptyHost.memberId });
  await emptyCommand(emptyHostWs, "assignSeat", { team: "B", targetMemberId: emptyGuest.memberId });
  await emptyCommand(emptyHostWs, "startBp", {});
  // 仅预选 AB1，从不确认：到期按当前局无有效记录直接清理。
  await emptyCommand(emptyHostWs, "setPreselect", {
    slotId: "AB1",
    agentId: agentCatalogData.agents[0]?.id ?? "",
  });
  emptyHostWs.close();
  emptyGuestWs.close();
  await waitLeftAt(emptyId);
  await expireEmptyRoom(emptyId);
  const emptyKind = await fetchEntryKind(`/api/rooms/${emptyId}`);
  const emptyTables = await tableRows(emptyId);
  const emptyAlloc = await sqliteAlloc(emptyId);
  expect(emptyKind).toBe("not-found");
  expect(Object.keys(emptyTables)).toHaveLength(0);

  report["典型房间"] = {
    入房毫秒: joinMs,
    开局5条命令毫秒: play.setupMs,
    开局广播: play.setupTraffic,
    "26步": play.steps,
    预选更换消息: {
      说明: "每步 2 次更换（首步 5 次）的额外公开预选广播",
      总帧: play.preselectFrames,
      总字节: play.preselectBytes,
    },
    "26步后表行数": afterBp,
    "26步后SQLite分配(字节)": allocAfterBp,
    会话追加: {
      回执行数: Number(receipts[0]?.n ?? 0),
      回执行内容字节: Number(receipts[0]?.b ?? 0),
      目录快照字节: Number(catalogRow[0]?.b ?? 0),
    },
    归档: {
      触发读取毫秒: archiveReadMs,
      快照字节: Number(snapshotRow[0]?.b ?? 0),
      快照步数: snapshot.operations.length,
      归档后表行数: afterArchive,
      归档后SQLite分配: allocAfterArchive,
      "下次Alarm(90天清理)": alarm === null ? null : new Date(alarm).toISOString(),
    },
    空记录房间: {
      清理后表行数: emptyTables,
      清理后SQLite分配: emptyAlloc,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}, 300_000);

it("有界示例规模：多房间同时持有与断开后的休眠条件", async () => {
  // 假设情景（非用户已确定规模）：ROOMS 间房，每房 3 成员 + 1 展示连接，
  // 各推进 1 步后全员保持在线；测量同时持有的消息量，随后全体断开，
  // 验证空房期限 Alarm（休眠信号）与离开时间。
  const ROOMS = 6;
  const totals = { rooms: ROOMS, members: 0, frames: 0, bytes: 0 };
  const rooms: Array<{ roomId: string; clients: TestWsClient[] }> = [];
  const started = now();

  for (let index = 0; index < ROOMS; index += 1) {
    const { room, roomId } = await connectRoom(`规模测量赛-${index + 1}`);
    const meter = new TrafficMeter([
      room.hostWs,
      room.aWs,
      room.bWs,
      room.spectatorWs,
      room.displayWs,
    ]);
    let bpVersion = 0;
    const send = async (client: TestWsClient, type: string, extra: Record<string, unknown>) => {
      const operationId = `scale-${type}-${crypto.randomUUID()}`;
      client.send({
        type,
        ...extra,
        operationId,
        expectedBpVersion: bpVersion,
        ...(type === "setTeamName" ? { expectedRevision: await currentRevisionOf(roomId) } : {}),
      });
      const result = await client.commandResult(operationId);
      if (!result.ok) throw new Error(`${type} 失败：${result.error?.code ?? "?"}`);
      bpVersion = result.bpVersion;
    };
    await send(room.hostWs, "setTeamName", { team: "A", teamName: "左方队" });
    await send(room.hostWs, "setTeamName", { team: "B", teamName: "右方队" });
    await send(room.hostWs, "assignSeat", { team: "A", targetMemberId: room.playerA.memberId });
    await send(room.hostWs, "assignSeat", { team: "B", targetMemberId: room.playerB.memberId });
    await send(room.hostWs, "startBp", {});
    const first = BP_STEP_ORDER[0];
    if (first !== undefined) {
      await send(room.aWs, "setPreselect", {
        slotId: first,
        agentId: agentCatalogData.agents[0]?.id ?? "",
      });
      await send(room.aWs, "confirmPreselect", { slotId: first });
    }
    const traffic = meter.read();
    totals.members += 4;
    totals.frames += traffic.frames;
    totals.bytes += traffic.bytes;
    rooms.push({
      roomId,
      clients: [room.hostWs, room.aWs, room.bWs, room.spectatorWs, room.displayWs],
    });
  }
  const concurrentMs = Math.round(now() - started);

  for (const { clients } of rooms) {
    for (const client of clients) client.close();
  }
  const idle: Array<{ roomId: string; alarmAt: string | null; leftAt: string }> = [];
  for (const { roomId } of rooms) {
    await waitLeftAt(roomId);
    const leftAt = String(
      (await queryRoomRows(roomId, "SELECT last_member_left_at FROM room_meta"))[0]
        ?.last_member_left_at,
    );
    const alarm = await currentAlarm(roomId);
    idle.push({
      roomId,
      leftAt,
      alarmAt: alarm === null ? null : new Date(alarm).toISOString(),
    });
  }
  // 每间空房的期限应为离开时间 + 12 小时（Alarm 是休眠下的下次唤醒）。
  for (const item of idle) {
    expect(item.alarmAt).not.toBeNull();
    expect(Date.parse(String(item.alarmAt)) - Date.parse(item.leftAt)).toBe(12 * 3600_000);
  }
  const idleRoomRows = await tableRows(rooms[0]?.roomId ?? "");

  console.log(
    JSON.stringify(
      {
        说明: "假设情景（有界本地示例），非用户已确定规模；房间保持在线至断开。",
        规模: {
          房间数: ROOMS,
          成员连接数: totals.members,
          展示连接数: ROOMS,
          同房连接总数: totals.members + ROOMS + ROOMS,
          持有期间总帧: totals.frames,
          持有期间总字节: totals.bytes,
          建满全部房间毫秒: concurrentMs,
        },
        断开后: {
          空房Alarm: idle,
          首房表行数: idleRoomRows,
        },
      },
      null,
      2,
    ),
  );
}, 300_000);
