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
 * 有界示例规模下的数据量、消息量与 SQL 行成本，为
 * docs/specs/cloudflare-budget.md 的容量估算提供可复现输入。
 *
 * 口径与边界：
 * - 消息为各连接累计的逻辑 JSON 字节（UTF-8）；存储同时给出内容 UTF-8
 *   字节（`LENGTH(CAST(... AS BLOB))`，不是 SQLite 的字符计数）、表行数与
 *   `databaseSize` 分配（分配 ≠ 内容字节，删除不一定立即缩小）。
 * - SQL 行成本来自真实执行路径：在测试侧透明包装房间实例的 `sql`
 *   （原样转发每条 `exec`、保留 cursor），按阶段统计 `cursor.rowsRead` /
 *   `cursor.rowsWritten`，不做语句复制或乘数推算；`setAlarm` 不经 SQL exec
 *   未计入，平台内部元数据、Alarm 内部行为与线上计费边界不在本地观测内。
 * - 耗时是本地 wall-clock，包含测试客户端的 20ms 轮询间隔，**不是** DO
 *   活动时长或计费 CPU，不用于换算 GB-s。
 * - 示例规模（房间数/连接数/预选频率）是假设情景，不是用户已确定规模。
 *
 * 用法：pnpm measure:rooms。测试输出以 ===MEASURE-REPORT-BEGIN=== /
 * ===MEASURE-REPORT-END=== 标记包裹；配置内的报告 reporter 会同时把
 * 全部报告段写入 node_modules/.tmp/measure-report.json（终端输出不可靠时
 * 的稳定出口）。
 */

const REPORT_BEGIN = "===MEASURE-REPORT-BEGIN===";
const REPORT_END = "===MEASURE-REPORT-END===";

const encoder = new TextEncoder();
function bytes(text: string): number {
  return encoder.encode(text).length;
}

function emitReport(report: Record<string, unknown>): void {
  console.log(`${REPORT_BEGIN}\n${JSON.stringify(report, null, 2)}\n${REPORT_END}`);
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

/** SQLite 存储分配大小：DO SQL 的 databaseSize（分配口径，非内容长度）。 */
async function sqliteAlloc(roomId: string): Promise<number | null> {
  const stub = exports.Room.get(exports.Room.idFromName(roomId));
  return runInDurableObject(stub, (_room, state) => state.storage.sql.databaseSize);
}

/** 读取单行文本列的内容度量：UTF-8 字节与 Unicode 码点（非 UTF-16 码元）。 */
async function textColumnMetrics(
  roomId: string,
  table: string,
  column: string,
): Promise<{ codePoints: number; utf8Bytes: number } | null> {
  const rows = await queryRoomRows(roomId, `SELECT ${column} AS t FROM ${table} WHERE id = 1`);
  const value = rows[0]?.t;
  if (typeof value !== "string") return null;
  return { codePoints: Array.from(value).length, utf8Bytes: bytes(value) };
}

interface TracedStatement {
  readonly sql: string;
  readonly read: number;
  readonly write: number;
}

/** 包装期间保留的语句与 cursor：行读计数在完整迭代后才最终化，须在命令结束后读取。 */
interface TracedCursor {
  readonly sql: string;
  readonly cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
}

/**
 * 真实执行路径的 SQL 计量器：在测试侧透明包装房间实例的 `sql`，原样转发
 * 每条 `exec` 并保留 cursor 计数；不改变 SQL、不产生任何业务写。
 *
 * 段边界由测试侧 `take()` 控制（取走并清空当前段）；`restore()` 在 finally
 * 中卸载包装，避免影响后续阶段。计数覆盖经由该实例 `sql` 的全部执行路径
 * （WS 命令、HTTP 入房与归档读取/清理）；测试自身的查询、受控时间戳注入与
 * `setAlarm` 不经过该包装，天然排除。
 */
class SqlExecutionMeter {
  private stub: ReturnType<typeof exports.Room.get> | null = null;
  private readonly traced: TracedCursor[] = [];
  private installed = false;

  async install(roomId: string): Promise<void> {
    const stub = exports.Room.get(exports.Room.idFromName(roomId));
    const traced = this.traced;
    await runInDurableObject(stub, (instance, state) => {
      const target = state.storage.sql;
      const wrapper = new Proxy(target, {
        get(sqlTarget, key): unknown {
          if (key === "exec") {
            return (statement: string, ...params: unknown[]) => {
              const cursor = sqlTarget.exec(statement, ...params);
              // 只保留 cursor；行读计数在语句被完整消费后才最终化，
              // 在命令结束（take）时统一读取，避免过早取样低估。
              traced.push({ sql: statement.replace(/\s+/g, " ").trim(), cursor });
              return cursor;
            };
          }
          return Reflect.get(sqlTarget, key, sqlTarget);
        },
      });
      Object.defineProperty(instance, "sql", { get: () => wrapper, configurable: true });
    });
    this.stub = stub;
    this.installed = true;
  }

  async restore(): Promise<void> {
    if (!this.installed || this.stub === null) return;
    const stub = this.stub;
    await runInDurableObject(stub, (instance) => {
      Reflect.deleteProperty(instance, "sql");
    });
    this.installed = false;
    this.stub = null;
  }

  /**
   * 取走当前段并清空（段内语句按执行顺序返回）。段结束时语句已被完整
   * 消费，此处读取的 rowsRead/rowsWritten 为最终值。
   */
  take(): TracedStatement[] {
    const taken = this.traced.map(({ sql, cursor }) => ({
      sql,
      read: cursor.rowsRead,
      write: cursor.rowsWritten,
    }));
    this.traced.length = 0;
    return taken;
  }
}

function totals(trace: readonly TracedStatement[]): { reads: number; writes: number } {
  let reads = 0;
  let writes = 0;
  for (const statement of trace) {
    reads += statement.read;
    writes += statement.write;
  }
  return { reads, writes };
}

/** 按规范化 SQL 文本聚合语句次数与行成本（按行读降序）。 */
function aggregateStatements(
  trace: readonly TracedStatement[],
): Array<{ sql: string; count: number; reads: number; writes: number }> {
  const map = new Map<string, { count: number; reads: number; writes: number }>();
  for (const statement of trace) {
    const entry = map.get(statement.sql) ?? { count: 0, reads: 0, writes: 0 };
    entry.count += 1;
    entry.reads += statement.read;
    entry.writes += statement.write;
    map.set(statement.sql, entry);
  }
  return [...map.entries()]
    .map(([sql, entry]) => ({ sql, ...entry }))
    .sort((a, b) => b.reads - a.reads || b.writes - a.writes || a.sql.localeCompare(b.sql));
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

/**
 * 建房 + 三人入房 + 四个成员连接 + 一个展示连接（每房 5 个连接）。
 * 传入计量器时在建房后立即安装，用于单独统计「入房与连接」阶段。
 */
async function connectRoom(
  roomName: string,
  meter?: SqlExecutionMeter,
): Promise<{ room: MemberSet; roomId: string; joinMs: number[] }> {
  const host = await createRoomViaHttp(roomName, "主持人");
  const roomId = host.roomId;
  await meter?.install(roomId);
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

interface CommandRecord {
  readonly type: string;
  readonly reads: number;
  readonly writes: number;
  readonly statements: TracedStatement[];
}

/**
 * 开局并推进全部 26 步。每步的公开预选频率示例为：首次预选 + 2 次更换
 * （首步 5 次）+ 换回目标 + 确认 = 5 条命令（首步 8 条）；26 步共 133 条
 * BP 命令，加开局 5 条共 138 条命令（与回执行数一致）。
 * 每条命令的 SQL 行成本由计量器按真实执行路径逐条记录。
 */
async function playFullGame(room: MemberSet, roomId: string, meter: SqlExecutionMeter) {
  const traffic = new TrafficMeter([
    room.hostWs,
    room.aWs,
    room.bWs,
    room.spectatorWs,
    room.displayWs,
  ]);
  const steps: Array<{ slot: string; ms: number; frames: number; bytes: number }> = [];
  const commands: CommandRecord[] = [];

  let bpVersion = 0;
  async function send(client: TestWsClient, type: string, extra: Record<string, unknown>) {
    const operationId = `measure-${type}-${crypto.randomUUID()}`;
    const payload = {
      type,
      ...extra,
      operationId,
      expectedBpVersion: bpVersion,
      ...(type === "setTeamName" ? { expectedRevision: await currentRevisionOf(roomId) } : {}),
    };
    meter.take(); // 丢弃残留，确保段内只含本次命令
    client.send(payload);
    const result = await client.commandResult(operationId);
    if (!result.ok) throw new Error(`${type} 失败：${result.error?.code ?? "?"}`);
    bpVersion = result.bpVersion;
    const statements = meter.take();
    commands.push({ type, ...totals(statements), statements });
    return result;
  }

  const setupStart = now();
  await send(room.hostWs, "setTeamName", { team: "A", teamName: "左方队" });
  await send(room.hostWs, "setTeamName", { team: "B", teamName: "右方队" });
  await send(room.hostWs, "assignSeat", { team: "A", targetMemberId: room.playerA.memberId });
  await send(room.hostWs, "assignSeat", { team: "B", targetMemberId: room.playerB.memberId });
  await send(room.hostWs, "startBp", {});
  const setupMs = Math.round(now() - setupStart);
  const setupTraffic = traffic.read();

  const agentIds = agentCatalogData.agents.map((agent) => agent.id);
  let preselectFrames = 0;
  let preselectBytes = 0;
  for (const [index, step] of BP_STEP_ORDER.entries()) {
    const client = step.startsWith("A") ? room.aWs : room.bWs;
    const agentId = agentIds[index];
    if (agentId === undefined) throw new Error("名单不足");
    traffic.reset();
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
    const preRead = traffic.read();
    preselectFrames += preRead.frames;
    preselectBytes += preRead.bytes;
    await send(client, "confirmPreselect", { slotId: step });
    const stepTraffic = traffic.read();
    steps.push({
      slot: step,
      ms: Math.round(now() - started),
      frames: stepTraffic.frames,
      bytes: stepTraffic.bytes,
    });
  }

  return { steps, setupMs, setupTraffic, preselectFrames, preselectBytes, commands };
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

/** 把空房计时改写为已过期（受控时间戳，与生命周期测试同一手法；不经实例包装）。 */
async function expireEmptyRoom(roomId: string): Promise<void> {
  await execInRoom(
    roomId,
    `UPDATE room_meta SET last_member_left_at = '${new Date(Date.now() - 13 * 3600_000).toISOString()}'`,
  );
}

/** 命令类型聚合：次数与行成本合计、单命令平均。 */
function byCommandType(
  commands: readonly CommandRecord[],
): Record<
  string,
  { 次数: number; 行读: number; 行写: number; 平均行读: number; 平均行写: number }
> {
  const map = new Map<string, { count: number; reads: number; writes: number }>();
  for (const command of commands) {
    const entry = map.get(command.type) ?? { count: 0, reads: 0, writes: 0 };
    entry.count += 1;
    entry.reads += command.reads;
    entry.writes += command.writes;
    map.set(command.type, entry);
  }
  const result: Record<
    string,
    { 次数: number; 行读: number; 行写: number; 平均行读: number; 平均行写: number }
  > = {};
  for (const [type, entry] of map) {
    result[type] = {
      次数: entry.count,
      行读: entry.reads,
      行写: entry.writes,
      平均行读: Math.round((entry.reads / entry.count) * 10) / 10,
      平均行写: Math.round((entry.writes / entry.count) * 10) / 10,
    };
  }
  return result;
}

it("典型房间分阶段资源测量（含归档与清理）", async () => {
  const report: Record<string, unknown> = {
    说明: "本地 workerd + SQLite 观测，非 Cloudflare 计费实测；字节为 UTF-8 内容字节，SQL 行成本为真实执行路径的 cursor 实测，分配为 databaseSize。",
  };

  // ---- 典型房间：建房、入房、连接、开局、26 步、归档（SQL 计量全程） ----
  const meter = new SqlExecutionMeter();
  try {
    const created = await connectRoom("资源测量赛", meter);
    const { room, roomId, joinMs } = created;
    const joinStage = meter.take();
    const play = await playFullGame(room, roomId, meter);

    const afterBp = await tableRows(roomId);
    const allocAfterBp = await sqliteAlloc(roomId);
    const receipts = await queryRoomRows(
      roomId,
      `SELECT COUNT(*) AS n,
         COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS payload_bytes,
         COALESCE(SUM(LENGTH(CAST(COALESCE(error_message, '') AS BLOB))), 0) AS error_message_bytes,
         COALESCE(SUM(LENGTH(CAST(COALESCE(error_code, '') AS BLOB))), 0) AS error_code_bytes,
         COALESCE(SUM(LENGTH(CAST(operation_id AS BLOB))), 0) AS operation_id_bytes,
         COALESCE(SUM(LENGTH(CAST(member_id AS BLOB))), 0) AS member_id_bytes,
         COALESCE(SUM(LENGTH(CAST(created_at AS BLOB))), 0) AS created_at_bytes
       FROM command_receipts`,
    );
    const receiptRow = receipts[0] ?? {};
    const receiptBytes =
      Number(receiptRow.payload_bytes ?? 0) +
      Number(receiptRow.error_message_bytes ?? 0) +
      Number(receiptRow.error_code_bytes ?? 0) +
      Number(receiptRow.operation_id_bytes ?? 0) +
      Number(receiptRow.member_id_bytes ?? 0) +
      Number(receiptRow.created_at_bytes ?? 0);
    const catalogMetrics = await textColumnMetrics(roomId, "room_catalog", "catalog_json");

    // ---- 归档：全员断开 → 到期裁决（真实读取路径，经实例包装计量） ----
    meter.take(); // 丢弃命令段残留，单独计量断开路径
    for (const client of [room.hostWs, room.aWs, room.bWs, room.spectatorWs, room.displayWs]) {
      client.close();
    }
    await waitLeftAt(roomId);
    const disconnectStage = meter.take();
    await expireEmptyRoom(roomId);
    meter.take(); // 丢弃受控时间戳注入段，仅保留随后的读取/清理路径
    const readStart = now();
    const archivedKind = await fetchEntryKind(`/api/rooms/${roomId}`);
    const archiveReadMs = Math.round(now() - readStart);
    const archiveStage = meter.take();
    const snapshotMetrics = await textColumnMetrics(roomId, "archive_snapshot", "snapshot_json");
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

    const setupCommands = play.commands.slice(0, 5);
    const bpCommands = play.commands.slice(5);
    const setupTrace = setupCommands.flatMap((command) => command.statements);
    const bpTrace = bpCommands.flatMap((command) => command.statements);
    const allTrace = play.commands.flatMap((command) => command.statements);
    const aggregate = aggregateStatements(allTrace);

    report["典型房间"] = {
      命令数: {
        开局: 5,
        "BP(26步×5+首步额外3)": 133,
        合计: 138,
        说明: "与回执行数一致；每步含首次预选、2 次更换（首步 5 次）、换回与确认。",
      },
      入房毫秒: joinMs,
      "开局阶段(5 命令)": {
        ms: play.setupMs,
        frames: play.setupTraffic.frames,
        bytes: play.setupTraffic.bytes,
        说明: "含 5 条命令回执与各连接视图广播。",
      },
      "26步": play.steps,
      "预选阶段消息(含首次/更换/换回/回执/广播)": {
        总帧: play.preselectFrames,
        总字节: play.preselectBytes,
        说明: "每步 2 次更换（首步 5 次）期间的全部消息；包含 commandResult 与全部连接的视图广播，不是“额外广播”净值。",
      },
      "26步后表行数": afterBp,
      "26步后SQLite分配(字节)": allocAfterBp,
      会话追加: {
        回执行数: Number(receiptRow.n ?? 0),
        "回执选定字段字节(payload+错误码/文本+操作ID+成员ID+时间戳)": receiptBytes,
        目录快照UTF8字节: catalogMetrics?.utf8Bytes ?? null,
        目录快照码点数: catalogMetrics?.codePoints ?? null,
        说明: "字段字节不含 SQLite 行与索引分配开销，分配另见 databaseSize。",
      },
      "SQL实际执行计量(测试侧透明包装)": {
        范围与口径:
          "在测试侧透明包装房间实例 sql 并原样转发每条 exec、保留 cursor；统计真实执行路径（入房与连接、开局、BP 26 步、归档读取与清理）的 rowsRead/rowsWritten。" +
          "包装在 finally 中卸载；测试自身的查询、受控时间戳注入与 setAlarm 不经该包装。平台内部元数据、Alarm 内部行为与线上计费边界不在本地观测内。",
        阶段: {
          "入房与连接(建房后 3 次入房 + 5 条 WS 接入)": {
            statements: joinStage.length,
            ...totals(joinStage),
          },
          "开局(5 命令)": { statements: setupTrace.length, ...totals(setupTrace) },
          "BP(133 命令)": { statements: bpTrace.length, ...totals(bpTrace) },
          "命令合计(138 条)": { statements: allTrace.length, ...totals(allTrace) },
          "断开与空房计时(真实关闭路径)": {
            statements: disconnectStage.length,
            ...totals(disconnectStage),
          },
          "归档读取与清理(到期 GET 触发)": {
            statements: archiveStage.length,
            ...totals(archiveStage),
          },
        },
        命令类型: byCommandType(play.commands),
        语句聚合: aggregate,
        样例命令: {
          首次改名: setupCommands[0]?.statements ?? [],
          首次预选: bpCommands[0]?.statements ?? [],
          末次确认: bpCommands.at(-1)?.statements ?? [],
        },
      },
      归档: {
        触发读取毫秒: archiveReadMs,
        快照UTF8字节: snapshotMetrics?.utf8Bytes ?? null,
        快照码点数: snapshotMetrics?.codePoints ?? null,
        快照步数: snapshot.operations.length,
        归档后表行数: afterArchive,
        "归档后SQLite分配(字节)": allocAfterArchive,
        "下次Alarm(90天清理)": alarm === null ? null : new Date(alarm).toISOString(),
      },
    };
  } finally {
    await meter.restore();
  }

  // ---- 空记录房间（仅预选、无确认）：到期直接清理（不计入典型房间计量） ----
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
  (report["典型房间"] as Record<string, unknown>)["空记录房间"] = {
    清理后表行数: emptyTables,
    "清理后SQLite分配(字节)": emptyAlloc,
  };

  emitReport(report);
}, 300_000);

it("有界示例规模：多房间同时持有与断开后的休眠条件", async () => {
  // 假设情景（非用户已确定规模）：ROOMS 间房，每房 4 名成员 + 1 个展示
  // 连接；各推进 1 步后全员保持在线；测量同时持有的消息量，随后全体断开，
  // 验证空房期限 Alarm（休眠信号）与离开时间。
  const ROOMS = 6;
  const totalsSummary = { rooms: ROOMS, members: 0, frames: 0, bytes: 0 };
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
    totalsSummary.members += 4;
    totalsSummary.frames += traffic.frames;
    totalsSummary.bytes += traffic.bytes;
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

  emitReport({
    说明: "假设情景（有界本地示例），非用户已确定规模；房间保持在线至断开。",
    规模: {
      房间数: ROOMS,
      每房连接: "4 名成员（房主 + 2 选手 + 1 观众）+ 1 展示",
      成员连接数: totalsSummary.members,
      展示连接数: ROOMS,
      连接总数: totalsSummary.members + ROOMS,
      持有期间总帧: totalsSummary.frames,
      持有期间总字节: totalsSummary.bytes,
      建满全部房间毫秒: concurrentMs,
    },
    断开后: {
      空房Alarm: idle,
      首房表行数: idleRoomRows,
    },
  });
}, 300_000);
