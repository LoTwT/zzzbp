import { agentCatalogSchema, type AgentCatalogData } from "../shared/agents/schema";
import { roomOperationErrorCodeSchema, type RoomOperationErrorCode } from "../shared/commands";
import type { RoomLifecycle, RoomState } from "../shared/room";
import { roomStateSchema } from "../shared/room";

/**
 * 房间 Durable Object 的 SQLite 持久化模块。
 *
 * 职责与约束（表结构职责的正文见 docs/architecture.md「房间持久化与固定目录」）：
 * - 只使用 DO 内置 SQLite，不引入其他数据库；
 * - 按变化更新对应数据：成员加入只写一行 members 并递增 revision，
 *   不重写目录快照或其他成员；目录快照仅在建房时写入一次；
 * - 载入房间状态一律经 roomStateSchema / agentCatalogSchema 校验，
 *   不建立第二套 BP 规则；
 * - 命令执行（PR5）把「读取 → 纯函数转换 → 差异持久化 → 回执写入」交给
 *   调用方的 transactionSync 闭包；本模块提供行级差异写入与回执读写，
 *   不实现通用数据库框架。
 *
 * 并发与事务：以下函数均为同步 SQL 操作，本身不开事务。调用方
 * （server/room.ts）把每个业务单元连同写入后的状态装配包在
 * ctx.storage.transactionSync 的同步闭包内：闭包内任一步骤抛异常
 * （SQL 故障、schema 校验失败、装配失败）时平台回滚整个事务，不留
 * 半写入。DO 的单线程执行与输入门只保证语句不被其他事件交错，不提供
 * 异常回滚，两者不可混同（依据官方 SQLite Storage API 的
 * transactionSync 语义）。
 */

/** 房间业务表结构的当前版本；升级入口见 ensureRoomSchema。 */
const ROOM_SCHEMA_VERSION = 2;

/** 已初始化实例的事务标志表；它的存在等价于全部业务表已按当前结构建立。 */
const ROOM_SCHEMA_MARKER_TABLE = "schema_meta";

/** DO 内置 SQLite 的类型别名（ctx.storage.sql）。 */
export type RoomSql = DurableObjectState["storage"]["sql"];

/**
 * SQLite 行类型：显式列声明满足 exec 的 Record 约束，
 * 实际值仍以 schema 校验为最终防线。
 */
type SqlRow<T> = T & Record<string, SqlStorageValue>;

/** room_meta 单行记录的已装配视图（不含 BP 进度与成员，按需另行读取）。 */
export interface RoomMeta {
  readonly roomId: string;
  readonly name: string;
  readonly lifecycle: RoomLifecycle;
  readonly hostMemberId: string;
  readonly createdAt: string;
  readonly ruleVersion: string;
  readonly agentDataVersion: string;
  /** 最近一次全员离开时间；初始为创建时刻（语义见 docs/architecture.md）。 */
  readonly lastMemberLeftAt: string | null;
}

/** 新成员写入所需的最小字段；在线状态恒为离线（仅实际 WS 连接可改变）。 */
export interface NewMemberRecord {
  readonly memberId: string;
  readonly nickname: string;
  readonly credentialDigest: string;
  readonly joinedAt: string;
}

/**
 * 幂等初始化业务表结构，并维护结构版本。
 *
 * 这是 schema 初始化/版本升级的唯一入口：首次访问建表并记录版本；
 * 版本一致时为空操作；遇到更高版本拒绝加载（防降级误读）；更低版本在此
 * 按版本逐步迁移（当前唯一历史版本 1 → 2，见函数体）。由调用方在
 * transactionSync 闭包内调用，建表与版本记录随所在业务单元一起提交或
 * 回滚。读取路径调用前先用 hasRoomSchema 判断实例是否已有结构，避免为
 * 从未建房的 roomId 写入存储。引导期 /api/health 使用的 room_info 自检表
 * （shared/api.ts 合同）由 DO 的 health 方法单独维护，与本模块互不干扰。
 */
export function ensureRoomSchema(sql: RoomSql): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS room_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      room_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('live', 'archived')),
      host_member_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      bp_status TEXT NOT NULL,
      bp_version INTEGER NOT NULL,
      bp_preselect TEXT,
      created_at TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      agent_data_version TEXT NOT NULL,
      last_member_left_at TEXT
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS members (
      member_id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      credential_digest TEXT NOT NULL UNIQUE,
      joined_at TEXT NOT NULL,
      online INTEGER NOT NULL DEFAULT 0
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      team TEXT PRIMARY KEY CHECK (team IN ('A', 'B')),
      member_id TEXT
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS team_names (
      team TEXT PRIMARY KEY CHECK (team IN ('A', 'B')),
      name TEXT NOT NULL DEFAULT ''
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS bp_submissions (
      position INTEGER PRIMARY KEY,
      slot_id TEXT NOT NULL,
      agent_id TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS room_catalog (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      catalog_json TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS command_receipts (
      member_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      ok INTEGER NOT NULL,
      error_code TEXT,
      error_message TEXT,
      bp_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (member_id, operation_id)
    )
  `);

  const row = sql
    .exec<SqlRow<{ version: number }>>("SELECT version FROM schema_meta WHERE id = 1")
    .toArray()[0];
  if (row === undefined) {
    sql.exec("INSERT INTO schema_meta (id, version) VALUES (1, ?)", ROOM_SCHEMA_VERSION);
    return;
  }

  const version = Number(row.version);
  if (version > ROOM_SCHEMA_VERSION) {
    throw new Error(
      `房间存储结构版本 ${version} 高于当前实现支持的 ${ROOM_SCHEMA_VERSION}，拒绝加载`,
    );
  }
  if (version < ROOM_SCHEMA_VERSION) {
    // 版本升级入口：按版本逐步迁移。v1 → v2 只新增 command_receipts 表
    // （上方 IF NOT EXISTS 已建立，无历史数据需要搬移），更新版本号即可；
    // 迁移与所在业务单元同事务提交或回滚。未来结构变更在此追加步骤。
    sql.exec("UPDATE schema_meta SET version = ? WHERE id = 1", ROOM_SCHEMA_VERSION);
  }
}

/**
 * 只读判断该实例是否已有业务表结构（`schema_meta` 表是否存在），不产生
 * 任何写入。
 *
 * 读取路径（房间入口、目录、入房失败前）先经此检查：从未建房的实例
 * 保持完全空存储，随机或错误的 roomId 不会因一次 GET/入房失败就建立
 * 7 张业务表与版本行、留下永不回收的持久数据（依据见 docs/architecture.md
 * 「房间持久化与固定目录」）。表结构已存在时才调用 ensureRoomSchema 做
 * 幂等校验或迁移，建房与既有房间的事务语义不变。
 *
 * `schema_meta` 与业务表由 ensureRoomSchema 在同一事务内创建，事务提交
 * 保证二者同时存在；因此该表存在即可安全认定为结构完整。
 */
export function hasRoomSchema(sql: RoomSql): boolean {
  const row = sql
    .exec<SqlRow<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ROOM_SCHEMA_MARKER_TABLE,
    )
    .toArray()[0];
  return row !== undefined;
}

/** room_meta 行类型（SQLite 返回值）。 */
interface RoomMetaRow {
  room_id: string;
  name: string;
  lifecycle: string;
  host_member_id: string;
  revision: number;
  bp_status: string;
  bp_version: number;
  bp_preselect: string | null;
  created_at: string;
  rule_version: string;
  agent_data_version: string;
  last_member_left_at: string | null;
}

/** 读取 room_meta；房间尚未创建时返回 null。 */
export function readRoomMeta(sql: RoomSql): RoomMeta | null {
  const row = sql
    .exec<SqlRow<RoomMetaRow>>(
      "SELECT room_id, name, lifecycle, host_member_id, revision, bp_status, bp_version, bp_preselect, created_at, rule_version, agent_data_version, last_member_left_at FROM room_meta WHERE id = 1",
    )
    .toArray()[0];
  if (row === undefined) return null;

  return {
    roomId: row.room_id,
    name: row.name,
    lifecycle: row.lifecycle === "archived" ? "archived" : "live",
    hostMemberId: row.host_member_id,
    createdAt: row.created_at,
    ruleVersion: row.rule_version,
    agentDataVersion: row.agent_data_version,
    lastMemberLeftAt: row.last_member_left_at,
  };
}

/**
 * 建房写入：房间行 + 首位房主成员 + 席位 + 队名 + 目录快照。
 * 在调用方的 transactionSync 闭包内执行，任一语句失败时整体回滚。
 *
 * 初始状态：live、waiting、空席位、空队名、无提交无预选、revision 与
 * bp.version 为 0；规则与数据版本、目录快照在建房时固定；
 * last_member_left_at 初始化为创建时刻（从未有成员连接的空房自创建起
 * 开始 12 小时保留窗口的计时，仅实际成员 WS 连接可取消，见
 * docs/architecture.md「生命周期与归档记录」）。
 */
export function createRoomRecord(
  sql: RoomSql,
  input: {
    readonly roomId: string;
    readonly name: string;
    readonly hostMemberId: string;
    readonly nickname: string;
    readonly credentialDigest: string;
    readonly ruleVersion: string;
    readonly agentDataVersion: string;
    readonly catalogJson: string;
  },
): void {
  const createdAt = new Date().toISOString();
  sql.exec(
    `INSERT INTO room_meta
      (id, room_id, name, lifecycle, host_member_id, revision, bp_status, bp_version, bp_preselect, created_at, rule_version, agent_data_version, last_member_left_at)
     VALUES (1, ?, ?, 'live', ?, 0, 'waiting', 0, NULL, ?, ?, ?, ?)`,
    input.roomId,
    input.name,
    input.hostMemberId,
    createdAt,
    input.ruleVersion,
    input.agentDataVersion,
    // 空房无人时间的可追溯起点：创建时刻。
    createdAt,
  );
  sql.exec(
    "INSERT INTO members (member_id, nickname, credential_digest, joined_at, online) VALUES (?, ?, ?, ?, 0)",
    input.hostMemberId,
    input.nickname,
    input.credentialDigest,
    createdAt,
  );
  sql.exec("INSERT INTO seats (team, member_id) VALUES ('A', NULL), ('B', NULL)");
  sql.exec("INSERT INTO team_names (team, name) VALUES ('A', ''), ('B', '')");
  sql.exec("INSERT INTO room_catalog (id, catalog_json) VALUES (1, ?)", input.catalogJson);
}

/**
 * 写入新成员（观众身份；角色与席位始终从房间状态派生）并递增公开
 * revision。新成员在线状态为离线：只有实际 WS 连接（PR5）会将其置为在线。
 * 在调用方的 transactionSync 闭包内执行：成员行与 revision 更新要么同时
 * 提交，要么整体回滚。
 */
export function insertMember(sql: RoomSql, member: NewMemberRecord): void {
  sql.exec(
    "INSERT INTO members (member_id, nickname, credential_digest, joined_at, online) VALUES (?, ?, ?, ?, 0)",
    member.memberId,
    member.nickname,
    member.credentialDigest,
    member.joinedAt,
  );
  // 成员加入是可见状态变化（房主管理视图的成员列表），递增公开 revision；
  // 不使 BP 命令过期（bp.version 不变）。
  sql.exec("UPDATE room_meta SET revision = revision + 1 WHERE id = 1");
}

/** 按凭据摘要查找成员 ID；无匹配返回 null。摘要有唯一约束，匹配即唯一。 */
export function findMemberIdByCredentialDigest(sql: RoomSql, digest: string): string | null {
  const row = sql
    .exec<SqlRow<{ member_id: string }>>(
      "SELECT member_id FROM members WHERE credential_digest = ?",
      digest,
    )
    .toArray()[0];
  return row === undefined ? null : row.member_id;
}

/** 从 SQLite 装配并经 roomStateSchema 校验的房间核心状态；未建房返回 null。 */
export function loadRoomState(sql: RoomSql): RoomState | null {
  const meta = sql
    .exec<SqlRow<RoomMetaRow>>(
      "SELECT room_id, name, lifecycle, host_member_id, revision, bp_status, bp_version, bp_preselect FROM room_meta WHERE id = 1",
    )
    .toArray()[0];
  if (meta === undefined) return null;

  const memberRows = sql
    .exec<SqlRow<{ member_id: string; nickname: string; online: number }>>(
      "SELECT member_id, nickname, online FROM members ORDER BY rowid",
    )
    .toArray();
  const seatRows = sql
    .exec<SqlRow<{ team: string; member_id: string | null }>>("SELECT team, member_id FROM seats")
    .toArray();
  const teamNameRows = sql
    .exec<SqlRow<{ team: string; name: string }>>("SELECT team, name FROM team_names")
    .toArray();
  const submissionRows = sql
    .exec<SqlRow<{ slot_id: string; agent_id: string }>>(
      "SELECT slot_id, agent_id FROM bp_submissions ORDER BY position",
    )
    .toArray();

  const seatOf = (team: "A" | "B"): string | null => {
    const row = seatRows.find((candidate) => candidate.team === team);
    return row === undefined ? null : row.member_id;
  };
  const teamNameOf = (team: "A" | "B"): string => {
    const row = teamNameRows.find((candidate) => candidate.team === team);
    return row === undefined ? "" : row.name;
  };

  return roomStateSchema.parse({
    roomId: meta.room_id,
    name: meta.name,
    lifecycle: meta.lifecycle === "archived" ? "archived" : "live",
    hostMemberId: meta.host_member_id,
    teamNames: { A: teamNameOf("A"), B: teamNameOf("B") },
    seats: { A: seatOf("A"), B: seatOf("B") },
    members: memberRows.map((row) => ({
      memberId: row.member_id,
      nickname: row.nickname,
      online: Number(row.online) === 1,
    })),
    revision: Number(meta.revision),
    bp: {
      status: meta.bp_status,
      submissions: submissionRows.map((row) => ({ slotId: row.slot_id, agentId: row.agent_id })),
      preselect: meta.bp_preselect,
      version: Number(meta.bp_version),
    },
  });
}

/**
 * 载入该房间固定的目录快照并经 agentCatalogSchema 校验。
 *
 * 这是后续运行时（PR5 规则命令的名单校验、PR9 归档展示 lookup）派生
 * 目录相关数据的唯一入口；读取只来自本行持久快照，不读全局当前目录。
 */
export function loadRoomCatalog(sql: RoomSql): AgentCatalogData | null {
  const row = sql
    .exec<SqlRow<{ catalog_json: string }>>("SELECT catalog_json FROM room_catalog WHERE id = 1")
    .toArray()[0];
  if (row === undefined) return null;
  return agentCatalogSchema.parse(JSON.parse(row.catalog_json));
}

/**
 * 按变化持久化一次状态转换：只写与 before 不同的行，不重写固定目录或
 * 无关成员。空操作（转换层返回原引用）不产生任何写入。
 *
 * 有效序列按前缀对比：追加只 INSERT 新位置，撤回/重开只 DELETE 多余
 * 位置，不整表重写。由调用方在 transactionSync 闭包内调用，与回执写入
 * 同事务：任一语句失败时整体回滚，不存在「状态已变而回执缺失」或反向
 * 的半提交。
 */
export function persistRoomStateChange(sql: RoomSql, before: RoomState, after: RoomState): void {
  if (before === after) return;

  sql.exec(
    "UPDATE room_meta SET revision = ?, bp_status = ?, bp_version = ?, bp_preselect = ? WHERE id = 1",
    after.revision,
    after.bp.status,
    after.bp.version,
    after.bp.preselect,
  );

  for (const team of ["A", "B"] as const) {
    if (before.teamNames[team] !== after.teamNames[team]) {
      sql.exec("UPDATE team_names SET name = ? WHERE team = ?", after.teamNames[team], team);
    }
    if (before.seats[team] !== after.seats[team]) {
      sql.exec("UPDATE seats SET member_id = ? WHERE team = ?", after.seats[team], team);
    }
  }

  // 成员在线标志：只写发生变化的成员行（转换层不增删成员、不换顺序）。
  const beforeOnline = new Map(before.members.map((member) => [member.memberId, member.online]));
  for (const member of after.members) {
    if (beforeOnline.get(member.memberId) !== member.online) {
      sql.exec(
        "UPDATE members SET online = ? WHERE member_id = ?",
        member.online ? 1 : 0,
        member.memberId,
      );
    }
  }

  const common = commonSubmissionCount(before.bp.submissions, after.bp.submissions);
  if (after.bp.submissions.length < before.bp.submissions.length) {
    sql.exec("DELETE FROM bp_submissions WHERE position >= ?", after.bp.submissions.length);
  }
  for (let position = common; position < after.bp.submissions.length; position += 1) {
    const submission = after.bp.submissions[position];
    if (submission === undefined) continue;
    sql.exec(
      "INSERT INTO bp_submissions (position, slot_id, agent_id) VALUES (?, ?, ?)",
      position,
      submission.slotId,
      submission.agentId,
    );
  }
}

function commonSubmissionCount(
  before: readonly { slotId: string; agentId: string }[],
  after: readonly { slotId: string; agentId: string }[],
): number {
  let common = 0;
  while (
    common < before.length &&
    common < after.length &&
    before[common]?.slotId === after[common]?.slotId &&
    before[common]?.agentId === after[common]?.agentId
  ) {
    common += 1;
  }
  return common;
}

/**
 * 更新空房计时元数据（room_meta.last_member_left_at）。
 *
 * 语义见 docs/architecture.md「生命周期与归档记录」：实际成员连接把计时
 * 取消（置 NULL），最后一名在线成员离开时写入当前时刻；展示连接与
 * HTTP 读写不触碰该字段。到期执行与 Alarm 在 PR9。
 */
export function setLastMemberLeftAt(sql: RoomSql, value: string | null): void {
  sql.exec("UPDATE room_meta SET last_member_left_at = ? WHERE id = 1", value);
}

/** 房间当前版本信息：命令结果与错误回执关联的 bp.version / revision。 */
export interface RoomVersionInfo {
  readonly bpVersion: number;
  readonly revision: number;
}

/** 只读房间当前版本信息；房间尚未创建时返回 null。 */
export function readRoomVersionInfo(sql: RoomSql): RoomVersionInfo | null {
  const row = sql
    .exec<SqlRow<{ revision: number; bp_version: number }>>(
      "SELECT revision, bp_version FROM room_meta WHERE id = 1",
    )
    .toArray()[0];
  if (row === undefined) return null;
  return { bpVersion: Number(row.bp_version), revision: Number(row.revision) };
}

/** 命令去重回执的已装配记录：重发时原样返回，不再次执行。 */
export interface CommandReceipt {
  readonly ok: boolean;
  readonly errorCode: RoomOperationErrorCode | null;
  readonly errorMessage: string | null;
  readonly bpVersion: number;
  readonly revision: number;
}

/**
 * 按 room + member + operationId 查找回执；无记录返回 null。
 *
 * 错误码在读取时重新经 schema 校验：回执由本模块写入时总是合法枚举，
 * 读取失败（存储损坏）按 INTERNAL 降级，不把任意字符串透传给客户端。
 */
export function findCommandReceipt(
  sql: RoomSql,
  memberId: string,
  operationId: string,
): { payloadJson: string; receipt: CommandReceipt } | null {
  const row = sql
    .exec<
      SqlRow<{
        payload_json: string;
        ok: number;
        error_code: string | null;
        error_message: string | null;
        bp_version: number;
        revision: number;
      }>
    >(
      "SELECT payload_json, ok, error_code, error_message, bp_version, revision FROM command_receipts WHERE member_id = ? AND operation_id = ?",
      memberId,
      operationId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  let errorCode: RoomOperationErrorCode | null = null;
  if (row.error_code !== null) {
    const parsed = roomOperationErrorCodeSchema.safeParse(row.error_code);
    errorCode = parsed.success ? parsed.data : "INTERNAL";
  }
  return {
    payloadJson: row.payload_json,
    receipt: {
      ok: Number(row.ok) === 1,
      errorCode,
      errorMessage: row.error_message,
      bpVersion: Number(row.bp_version),
      revision: Number(row.revision),
    },
  };
}

/**
 * 写入一条命令回执，并把回执窗口裁剪到保留上限（按写入顺序保留最近
 * retention 条，淘汰最旧）。
 *
 * 回执与状态更新由调用方放在同一 transactionSync 闭包内：故障时一起
 * 回滚，不会留下「已成功」回执而状态未变。窗口边界语义见
 * server/ws.ts 的 COMMAND_RECEIPT_RETENTION 注释。
 */
export function insertCommandReceipt(
  sql: RoomSql,
  input: {
    readonly memberId: string;
    readonly operationId: string;
    readonly payloadJson: string;
    readonly receipt: CommandReceipt;
    readonly retention: number;
  },
): void {
  sql.exec(
    `INSERT INTO command_receipts
      (member_id, operation_id, payload_json, ok, error_code, error_message, bp_version, revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.memberId,
    input.operationId,
    input.payloadJson,
    input.receipt.ok ? 1 : 0,
    input.receipt.errorCode,
    input.receipt.errorMessage,
    input.receipt.bpVersion,
    input.receipt.revision,
    new Date().toISOString(),
  );
  sql.exec(
    `DELETE FROM command_receipts WHERE rowid IN (
       SELECT rowid FROM command_receipts ORDER BY rowid DESC LIMIT -1 OFFSET ?
     )`,
    input.retention,
  );
}
