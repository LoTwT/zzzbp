import { DurableObject } from "cloudflare:workers";
import { toAgentCatalog } from "../shared/agents/catalog";
import { agentCatalogSchema, type AgentCatalogData } from "../shared/agents/schema";
import { roomInfoSchema, type RoomInfo } from "../shared/api";
import { BP_RULE_VERSION } from "../shared/bp/version";
import { roomCommandSchema, type RoomCommand, type RoomOperationError } from "../shared/commands";
import type { ApiErrorCode } from "../shared/contracts/http";
import type { CommandResultMessage } from "../shared/contracts/websocket";
import {
  projectDisplayView,
  projectHostManagementView,
  projectRoomMemberView,
} from "../shared/contracts/views";
import type { RoomMemberView } from "../shared/contracts/views";
import type { MemberId } from "../shared/ids";
import { applyRoomCommand, setMemberOnline } from "../shared/transitions";
import type { RoomState } from "../shared/room";
import { credentialDigest, readRoomCookieSecret } from "./credentials";
import {
  createRoomRecord,
  ensureRoomSchema,
  findCommandReceipt,
  findMemberIdByCredentialDigest,
  hasRoomSchema,
  insertCommandReceipt,
  insertMember,
  loadRoomCatalog,
  loadRoomState,
  persistRoomStateChange,
  readRoomMeta,
  readRoomVersionInfo,
  setLastMemberLeftAt,
  type CommandReceipt,
  type RoomMeta,
  type RoomSql,
  type RoomVersionInfo,
} from "./persistence";
import {
  canonicalCommandJson,
  COMMAND_RECEIPT_RETENTION,
  commandResultMessage,
  displayViewMessage,
  DISPLAY_TAG,
  hostViewMessage,
  MAX_WS_MESSAGE_BYTES,
  memberTag,
  memberViewMessage,
  messageByteLength,
  noticeMessage,
  parseWebSocketPath,
  readAttachment,
  type WsAttachment,
} from "./ws";

/**
 * 房间 Durable Object：每个房间一个实例，存储引擎为内置 SQLite。
 *
 * 本文件只承担编排：表结构、行级读写与状态装配在 ./persistence.ts，
 * WS 协议构件（路径/边界/附件/消息序列化）在 ./ws.ts，视图投影与命令
 * 语义复用 shared/ 的纯函数。本类与一切房间读取只使用该实例的持久目录
 * 快照；全局目录仅在 Worker 建房入口作为创建输入注入一次（见
 * server/index.ts 的 handleCreateRoom）。
 *
 * 事务边界：每个业务方法把「schema 初始化 + 检查 + 写入 + 写入后的
 * 状态装配」整体包在 ctx.storage.transactionSync 的同步闭包内——闭包
 * 内任一步骤抛异常（SQL 故障、schema 校验失败、装配失败）时平台回滚
 * 整个事务，不留半建房或无凭据的孤儿成员。命令处理同理：状态差异写入
 * 与 operationId 回执同事务提交或回滚，不存在半提交。闭包必须同步完成
 * （官方 SQLite Storage API 约束），本类内的 SQL 与装配均为同步操作；
 * DO 的单线程执行与输入门只保证语句不被其他事件交错，不提供异常回滚。
 *
 * 读取路径不初始化存储：getRoomEntry、joinRoom、getRoomCatalog 与 WS
 * 升级先用 hasRoomSchema 只读判断该实例是否已有业务表结构，从未建房的
 * 实例保持完全空存储，一切读取按不存在处理；随机或错误的 roomId 不会
 * 因 GET、失败入房或 WS 升级留下业务表与版本行。表结构已存在时（建房
 * 与既有房间）仍经 ensureRoomSchema 幂等校验或迁移，保证写入与必要迁移
 * 的事务保障不变。
 *
 * WebSocket（Hibernation API）：成员通道与展示通道都经本类 fetch 升级，
 * 连接身份（成员 ID 或 display）随附件持久化，休眠唤醒后不依赖实例内存；
 * 在线判定每次经 ctx.getWebSockets 的标签计数重算，不维护常驻计数器或
 * 定时器。命令操作者只来自连接附件中的可信身份，角色/席位/轮次/版本与
 * 名单每次从当前持久状态重新判断（见 processMemberCommand）。
 */

/** `createRoom` 输入：房间与房主成员的持久化材料（秘密不跨 RPC，只传摘要）。 */
export interface CreateRoomInput {
  readonly roomId: string;
  readonly name: string;
  readonly hostMemberId: string;
  readonly nickname: string;
  readonly credentialDigest: string;
  readonly ruleVersion: string;
  /** 建房时固定的目录快照（JSON 文本，落库前经 schema 校验）。 */
  readonly catalogJson: string;
}

/** `createRoom` 结果。 */
export type CreateRoomResult =
  | { readonly kind: "created"; readonly memberView: RoomMemberView }
  /** 该 DO 实例已有业务房间（房间 ID 冲突，理论上不可达，防御性返回）。 */
  | { readonly kind: "already_exists" };

/** `getRoomEntry` 输入：携带的身份凭据摘要；匿名为 null。 */
export interface RoomCredentialInput {
  readonly credentialDigest: string | null;
}

/**
 * `getRoomEntry` 结果。
 *
 * `createdAt` 与 `lastMemberLeftAt` 是内部字段：HTTP 层暂不透出，用于
 * 保留计时的初始化语义验证，PR9 的到期检查也从这里取得。
 */
export type RoomEntryResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "archived" }
  | {
      readonly kind: "live";
      readonly roomName: string;
      readonly memberView: RoomMemberView | null;
      readonly createdAt: string;
      readonly lastMemberLeftAt: string | null;
    };

/** `joinRoom` 输入：凭据无效时以新身份写入 newMemberId/newCredentialDigest。 */
export interface JoinRoomInput {
  /** 已验证的昵称；恢复原成员时被忽略（昵称仅首次入房设置）。 */
  readonly nickname: string;
  readonly credentialDigest: string | null;
  readonly newMemberId: string;
  readonly newCredentialDigest: string;
}

/** `joinRoom` 结果：restored 不轮换凭据；created 由调用方下发新 Cookie。 */
export type JoinRoomResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "archived" }
  | { readonly kind: "restored"; readonly memberView: RoomMemberView }
  | { readonly kind: "created"; readonly memberView: RoomMemberView };

/** 命令处理事务的判别结果（成功提交后由 processMemberCommand 分发）。 */
type CommandOutcome =
  /** 房间数据消失（当前无删除路径，防御；按连接通知处理）。 */
  | { readonly kind: "not_found" }
  | { readonly kind: "archived"; readonly versions: RoomVersionInfo }
  | { readonly kind: "unsupported_rule_version"; readonly versions: RoomVersionInfo }
  /** 回执命中且载荷一致：返回原结果，不再执行。 */
  | { readonly kind: "replayed"; readonly receipt: CommandReceipt }
  /** 回执命中但载荷不同：以稳定错误码拒绝。 */
  | { readonly kind: "conflict"; readonly versions: RoomVersionInfo }
  | {
      readonly kind: "executed";
      readonly changed: boolean;
      readonly ok: boolean;
      readonly error: RoomOperationError | null;
      readonly after: RoomState;
      readonly meta: RoomMeta;
    };

/** 成员在线转移事务的结果：changed 为 false 时不广播。 */
interface PresenceOutcome {
  readonly changed: boolean;
  readonly state: RoomState | null;
  readonly meta: RoomMeta | null;
}

export class Room extends DurableObject {
  private get sql(): RoomSql {
    return this.ctx.storage.sql;
  }

  // ---- 引导期 /api/health 自检（legacy room_info，shared/api.ts 合同） ----

  private ensureInfoTable(): void {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS room_info (id INTEGER PRIMARY KEY CHECK (id = 1), created_at TEXT NOT NULL)",
    );
  }

  /** 幂等地初始化房间记录并返回房间信息。 */
  async ensureCreated(): Promise<RoomInfo> {
    this.ensureInfoTable();
    const existing = await this.readInfo();
    if (existing) return existing;

    const createdAt = new Date().toISOString();
    this.sql.exec("INSERT INTO room_info (id, created_at) VALUES (1, ?)", createdAt);
    return roomInfoSchema.parse({ createdAt });
  }

  /** 读取房间信息；房间尚未初始化时返回 null。 */
  async readInfo(): Promise<RoomInfo | null> {
    this.ensureInfoTable();
    const cursor = this.sql.exec("SELECT created_at FROM room_info WHERE id = 1");
    const row = cursor.toArray()[0];
    if (!row) return null;

    const createdAt = row.created_at;
    if (typeof createdAt !== "string") {
      throw new Error("room_info.created_at 应为 TEXT 类型的 ISO 时间");
    }
    return roomInfoSchema.parse({ createdAt });
  }

  // ---- 业务房间：HTTP RPC ----

  /**
   * 创建业务房间：整个单元（schema 初始化、存在性检查、目录校验、
   * 房间行 + 首位房主成员 + 席位 + 队名 + 目录快照写入、写入后的视图
   * 装配）在一个同步事务闭包内，任一步骤抛异常整体回滚。目录快照先经
   * agentCatalogSchema 校验再落库，保证持久目录永远是合法快照；重复
   * 创建（房间 ID 冲突）不产生任何写入。
   */
  async createRoom(input: CreateRoomInput): Promise<CreateRoomResult> {
    return this.ctx.storage.transactionSync((): CreateRoomResult => {
      ensureRoomSchema(this.sql);
      if (readRoomMeta(this.sql) !== null) {
        return { kind: "already_exists" };
      }

      const catalog: AgentCatalogData = agentCatalogSchema.parse(JSON.parse(input.catalogJson));
      createRoomRecord(this.sql, {
        roomId: input.roomId,
        name: input.name,
        hostMemberId: input.hostMemberId,
        nickname: input.nickname,
        credentialDigest: input.credentialDigest,
        ruleVersion: input.ruleVersion,
        agentDataVersion: catalog.agentDataVersion,
        catalogJson: input.catalogJson,
      });

      const memberView = this.projectMemberView(input.hostMemberId);
      if (memberView === null) {
        throw new Error("建房后房主成员视图装配失败，存储状态异常");
      }
      return { kind: "created", memberView };
    });
  }

  /**
   * 读取房间入口数据：凭据有效时返回该成员视图，否则匿名。
   * 普通读取不影响在线状态与保留计时；读路径同样在事务闭包内，
   * 保证多次读取的一致快照。从未建房的实例不做任何写入（不建表），
   * 直接按 not_found 返回。
   */
  async getRoomEntry(input: RoomCredentialInput): Promise<RoomEntryResult> {
    return this.ctx.storage.transactionSync((): RoomEntryResult => {
      if (!hasRoomSchema(this.sql)) return { kind: "not_found" };
      ensureRoomSchema(this.sql);
      const meta = readRoomMeta(this.sql);
      if (meta === null) return { kind: "not_found" };
      if (meta.lifecycle !== "live") return { kind: "archived" };

      const viewerMemberId = this.resolveCredential(input.credentialDigest);
      const memberView = viewerMemberId === null ? null : this.projectMemberView(viewerMemberId);
      return {
        kind: "live",
        roomName: meta.name,
        memberView,
        createdAt: meta.createdAt,
        lastMemberLeftAt: meta.lastMemberLeftAt,
      };
    });
  }

  /**
   * 入房：有效凭据恢复原成员（忽略请求昵称，不轮换凭据、不重复建成员）；
   * 否则以请求昵称创建新观众成员。新成员为离线状态（只有实际成员 WS
   * 连接会计在线）。成员写入与 revision 递增、写入后的视图装配同在一个
   * 事务闭包内：任一步骤失败整体回滚，不会留下无凭据交付的孤儿成员。
   * 未建房的实例不做任何写入（不建表），直接按 not_found 返回。
   * 新成员写入成功后向已连接的成员/展示连接广播最新视图（房主的成员
   * 列表因此实时更新）。
   */
  async joinRoom(input: JoinRoomInput): Promise<JoinRoomResult> {
    const result = this.ctx.storage.transactionSync((): JoinRoomResult => {
      if (!hasRoomSchema(this.sql)) return { kind: "not_found" };
      ensureRoomSchema(this.sql);
      const meta = readRoomMeta(this.sql);
      if (meta === null) return { kind: "not_found" };
      if (meta.lifecycle !== "live") return { kind: "archived" };

      const existingMemberId = this.resolveCredential(input.credentialDigest);
      if (existingMemberId !== null) {
        const memberView = this.projectMemberView(existingMemberId);
        if (memberView === null) {
          throw new Error("成员凭据指向的成员不在房间内，存储状态异常");
        }
        return { kind: "restored", memberView };
      }

      insertMember(this.sql, {
        memberId: input.newMemberId,
        nickname: input.nickname,
        credentialDigest: input.newCredentialDigest,
        joinedAt: new Date().toISOString(),
      });
      const memberView = this.projectMemberView(input.newMemberId);
      if (memberView === null) {
        throw new Error("新成员写入后视图装配失败，存储状态异常");
      }
      return { kind: "created", memberView };
    });

    if (result.kind === "created") {
      this.broadcastCurrentViews();
    }
    return result;
  }

  /** 读取该房间固定的目录快照（经 schema 校验）；未建房返回 null 且不写入存储。 */
  async getRoomCatalog(): Promise<AgentCatalogData | null> {
    return this.ctx.storage.transactionSync((): AgentCatalogData | null => {
      if (!hasRoomSchema(this.sql)) return null;
      ensureRoomSchema(this.sql);
      return loadRoomCatalog(this.sql);
    });
  }

  // ---- WebSocket：升级入口（Worker 已完成方法/Upgrade/Origin 校验） ----

  /**
   * 处理成员/展示通道的升级请求。
   *
   * 房间级判断先经只读的 hasRoomSchema 探测：未知房间的实例保持完全空
   * 存储，升级被接受后立即以 ROOM_NOT_FOUND 通知并关闭（浏览器拿不到
   * 握手状态码，通知比 HTTP 404 更可用，且不产生任何持久写入）。归档
   * 房间与无效凭据同样以通知拒绝。凭据只在升级时读取一次；升级后的
   * 命令操作者一律来自连接附件。
   */
  async fetch(request: Request): Promise<Response> {
    const ownRoomId = this.ctx.id.name;
    if (ownRoomId === undefined) return this.wsHttpResponse(404, "INVALID_REQUEST", "未知路径");

    const { pathname } = new URL(request.url);
    const route = parseWebSocketPath(pathname, ownRoomId);
    if (route === null) return this.wsHttpResponse(404, "INVALID_REQUEST", "未知路径");
    if (request.method !== "GET") {
      return this.wsHttpResponse(405, "INVALID_REQUEST", "Method Not Allowed");
    }
    const upgrade = request.headers.get("Upgrade");
    if (upgrade === null || upgrade.toLowerCase() !== "websocket") {
      return this.wsHttpResponse(426, "INVALID_REQUEST", "WebSocket 升级需要 Upgrade 头");
    }

    // 凭据摘要是异步计算：先算好再进入同步事务闭包。
    const secret = route.channel === "member" ? readRoomCookieSecret(request, route.roomId) : null;
    const digest = secret === null ? null : await credentialDigest(secret);

    type UpgradeResolution =
      | { readonly kind: "missing" }
      | { readonly kind: "archived" }
      | { readonly kind: "auth_failed" }
      | { readonly kind: "display" }
      | { readonly kind: "member"; readonly memberId: MemberId };

    const resolved = this.ctx.storage.transactionSync((): UpgradeResolution => {
      if (!hasRoomSchema(this.sql)) return { kind: "missing" };
      ensureRoomSchema(this.sql);
      const meta = readRoomMeta(this.sql);
      if (meta === null) return { kind: "missing" };
      if (meta.lifecycle !== "live") return { kind: "archived" };
      if (route.channel === "display") return { kind: "display" };
      const memberId = digest === null ? null : findMemberIdByCredentialDigest(this.sql, digest);
      return memberId === null ? { kind: "auth_failed" } : { kind: "member", memberId };
    });

    switch (resolved.kind) {
      case "missing":
        return this.acceptRejectedConnection("ROOM_NOT_FOUND", "房间不存在");
      case "archived":
        return this.acceptRejectedConnection("ROOM_ARCHIVED", "房间已归档");
      case "auth_failed":
        return this.acceptRejectedConnection("AUTH_FAILED", "成员身份无效，请重新入房");
      case "display":
        return this.acceptDisplayConnection();
      case "member":
        return this.acceptMemberConnection(resolved.memberId);
    }
  }

  /** WS 升级前的 HTTP 层错误（共享错误体，不进入连接阶段）。 */
  private wsHttpResponse(status: number, code: ApiErrorCode, message: string): Response {
    return new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  /**
   * 接受连接并以通知拒绝后关闭：为让拒绝通知可靠送达（即使实例随后被
   * 驱逐），连接同样经 Hibernation 接入并标记为 rejected；其关闭事件按
   * 附件识别后忽略。存储不产生任何写入。
   */
  private acceptRejectedConnection(
    code: "ROOM_NOT_FOUND" | "ROOM_ARCHIVED" | "AUTH_FAILED",
    message: string,
  ): Response {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ kind: "rejected" } satisfies WsAttachment);
    this.safeSend(server, noticeMessage(code, message));
    this.safeClose(server, 1008, code);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 接受展示连接：无身份、只读，不计任何成员在线、不影响保留计时；
   * 即使升级请求携带有效房主 Cookie 也只按展示处理。连接后立即下发
   * 最新展示视图。
   */
  private acceptDisplayConnection(): Response {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [DISPLAY_TAG]);
    server.serializeAttachment({ kind: "display" } satisfies WsAttachment);
    this.sendCurrentViewTo(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 接受成员连接：身份（成员 ID）持久化到附件，操作者只来自这里。
   * 首个连接使成员上线（setMemberOnline(true)）并取消空房计时；其余
   * 页面连接不改状态。上线转移与视图下发在提交后同步完成，避免与
   * 其他事件交错。
   */
  private acceptMemberConnection(memberId: MemberId): Response {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [memberTag(memberId)]);
    server.serializeAttachment({ kind: "member", memberId } satisfies WsAttachment);

    // 在线判定：标签计数来自运行时连接注册表，休眠/重建后仍准确。
    const otherConnections = this.ctx
      .getWebSockets(memberTag(memberId))
      .filter((socket) => socket !== server).length;

    if (otherConnections > 0) {
      this.sendCurrentViewTo(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    let broadcasted = false;
    try {
      const outcome = this.transitionMemberOnline(memberId);
      if (outcome.changed && outcome.state !== null && outcome.meta !== null) {
        this.broadcastViews(outcome.state, outcome.meta);
        broadcasted = true;
      }
    } catch {
      this.logRealtimeInternalError("connect");
    }
    if (!broadcasted) {
      this.sendCurrentViewTo(server);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 成员上线转移：状态差异写入与空房计时取消（last_member_left_at
   * 置 NULL）同事务；已是上线的重复输入是空操作，不产生写入。
   */
  private transitionMemberOnline(memberId: MemberId): PresenceOutcome {
    return this.ctx.storage.transactionSync((): PresenceOutcome => {
      if (!hasRoomSchema(this.sql)) return { changed: false, state: null, meta: null };
      ensureRoomSchema(this.sql);
      const meta = readRoomMeta(this.sql);
      if (meta === null) return { changed: false, state: null, meta: null };
      const state = loadRoomState(this.sql);
      if (state === null) throw new Error("成员上线前状态装配失败");

      const result = setMemberOnline(state, memberId, true);
      if (!result.ok || result.state === state) {
        // 空操作或防御性失败（升级时刚验证过成员身份）：不改状态。
        return { changed: false, state, meta };
      }
      persistRoomStateChange(this.sql, state, result.state);
      setLastMemberLeftAt(this.sql, null);
      return { changed: true, state: result.state, meta };
    });
  }

  // ---- WebSocket：连接事件（Hibernation 回调） ----

  /**
   * 成员消息：解析为命令后进入统一处理管线。展示连接是只读通道，任何
   * 客户端消息都不被接受；二进制与超限消息按边界拒绝并关闭连接。
   * 本方法从头到尾同步执行（transactionSync 与 send 均为同步），不与
   * 其他事件交错。
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.safeSend(ws, noticeMessage("INVALID_MESSAGE", "二进制消息不被支持"));
      this.safeClose(ws, 1003, "binary");
      return;
    }
    if (
      message.length > MAX_WS_MESSAGE_BYTES ||
      messageByteLength(message) > MAX_WS_MESSAGE_BYTES
    ) {
      this.safeSend(ws, noticeMessage("INVALID_MESSAGE", "消息过大"));
      this.safeClose(ws, 1009, "too big");
      return;
    }

    const attachment = readAttachment(ws);
    if (attachment === null || attachment.kind === "rejected") return;
    if (attachment.kind === "display") {
      this.safeSend(ws, noticeMessage("INVALID_MESSAGE", "展示连接为只读通道"));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.safeSend(ws, noticeMessage("INVALID_MESSAGE", "消息必须是合法 JSON"));
      return;
    }
    const command = roomCommandSchema.safeParse(parsed);
    if (!command.success) {
      this.safeSend(ws, noticeMessage("INVALID_MESSAGE", "消息不符合命令契约"));
      return;
    }
    this.processMemberCommand(ws, attachment.memberId, command.data);
  }

  /**
   * 连接关闭：清理完全依赖运行时的断开语义——本兼容日期下 webSocketClose
   * 触发前 runtime 已完成 close 握手，关闭的连接不再出现在 getWebSockets；
   * 休眠（实例驱逐但连接保留）不会触发本回调，因此不会把休眠当成掉线。
   * 只处理成员连接的「最后一个连接离开」。
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    this.handleConnectionEnded(ws);
  }

  /**
   * 非断线类错误：主动终止该连接，清理统一交给 webSocketClose（断开时
   * 必被调用）。错误对象不进入日志（诊断白名单约束见
   * docs/architecture.md「错误诊断与可观测性」）。
   */
  async webSocketError(ws: WebSocket): Promise<void> {
    this.safeClose(ws, 1011, "error");
  }

  /**
   * 连接结束后的在线重算：按成员标签统计剩余连接（显式排除本 socket，
   * 兼容错误路径下尚未移出注册表的情形），最后一个连接离开才使成员
   * 下线。重算式清理天然幂等，错误与关闭回调不会双重扣减。
   */
  private handleConnectionEnded(ws: WebSocket): void {
    const attachment = readAttachment(ws);
    if (attachment?.kind !== "member") return;

    const remaining = this.ctx
      .getWebSockets(memberTag(attachment.memberId))
      .filter((socket) => socket !== ws).length;
    if (remaining > 0) return;

    try {
      const outcome = this.ctx.storage.transactionSync((): PresenceOutcome => {
        if (!hasRoomSchema(this.sql)) return { changed: false, state: null, meta: null };
        ensureRoomSchema(this.sql);
        const meta = readRoomMeta(this.sql);
        if (meta === null) return { changed: false, state: null, meta: null };
        const state = loadRoomState(this.sql);
        if (state === null) throw new Error("成员离线前状态装配失败");

        const result = setMemberOnline(state, attachment.memberId, false);
        if (!result.ok || result.state === state) {
          return { changed: false, state, meta };
        }
        persistRoomStateChange(this.sql, state, result.state);
        // 最后一名在线成员离开：记录空房计时起点（下次成员连接时取消）。
        if (!result.state.members.some((member) => member.online)) {
          setLastMemberLeftAt(this.sql, new Date().toISOString());
        }
        return { changed: true, state: result.state, meta };
      });
      if (outcome.changed && outcome.state !== null && outcome.meta !== null) {
        this.broadcastViews(outcome.state, outcome.meta);
      }
    } catch {
      this.logRealtimeInternalError("close");
    }
  }

  // ---- 命令处理管线 ----

  /**
   * 统一命令处理：读取当前状态 → 回执去重 → 规则版本门 → applyRoomCommand
   * → 按变化持久化 → 写回执，整体在一个 transactionSync 闭包内原子提交；
   * 写成功后才发送 commandResult 与广播（失败不广播、不回执）。
   *
   * - 操作者来自连接附件；角色/席位/轮次/状态/版本每次从当前持久状态
   *   重新判断，名单来自该房间的持久目录快照（不读全局当前目录）。
   * - 房间持久 ruleVersion 不受当前引擎支持时拒绝执行（不能拿当前语义
   *   解释未知版本的已保存状态）。
   * - 同一 operationId 且同一规范化载荷：返回原回执结果，不再执行；
   *   同 ID 不同载荷以 OPERATION_ID_CONFLICT 拒绝。回执与状态更新同
   *   事务，SQL 故障时一起回滚，重试不受已回滚回执影响。
   */
  private processMemberCommand(ws: WebSocket, memberId: MemberId, command: RoomCommand): void {
    const payloadJson = canonicalCommandJson(command);
    let outcome: CommandOutcome;
    try {
      outcome = this.ctx.storage.transactionSync((): CommandOutcome => {
        if (!hasRoomSchema(this.sql)) return { kind: "not_found" };
        ensureRoomSchema(this.sql);
        const meta = readRoomMeta(this.sql);
        if (meta === null) return { kind: "not_found" };
        if (meta.lifecycle !== "live") {
          const versions = readRoomVersionInfo(this.sql);
          if (versions === null) throw new Error("命令处理前房间元信息缺失");
          return { kind: "archived", versions };
        }
        if (meta.ruleVersion !== BP_RULE_VERSION) {
          const versions = readRoomVersionInfo(this.sql);
          if (versions === null) throw new Error("命令处理前房间元信息缺失");
          return { kind: "unsupported_rule_version", versions };
        }

        const existing = findCommandReceipt(this.sql, memberId, command.operationId);
        if (existing !== null) {
          if (existing.payloadJson !== payloadJson) {
            const versions = readRoomVersionInfo(this.sql);
            if (versions === null) throw new Error("命令回执冲突检查前房间元信息缺失");
            return { kind: "conflict", versions };
          }
          return { kind: "replayed", receipt: existing.receipt };
        }

        const state = loadRoomState(this.sql);
        if (state === null) throw new Error("命令处理前状态装配失败");
        const catalogData = loadRoomCatalog(this.sql);
        if (catalogData === null) throw new Error("房间目录快照缺失");

        const applied = applyRoomCommand(state, { memberId }, command, toAgentCatalog(catalogData));
        const after = applied.ok ? applied.state : state;
        persistRoomStateChange(this.sql, state, after);
        insertCommandReceipt(this.sql, {
          memberId,
          operationId: command.operationId,
          payloadJson,
          receipt: {
            ok: applied.ok,
            errorCode: applied.ok ? null : applied.error.code,
            errorMessage: applied.ok ? null : applied.error.message,
            bpVersion: after.bp.version,
            revision: after.revision,
          },
          retention: COMMAND_RECEIPT_RETENTION,
        });
        return {
          kind: "executed",
          changed: after !== state,
          ok: applied.ok,
          error: applied.ok ? null : applied.error,
          after,
          meta,
        };
      });
    } catch {
      // SQL/装配故障：事务整体回滚（状态与回执都未变更），按 INTERNAL
      // 结果回执；单个连接的失败不影响其他连接。
      this.logRealtimeInternalError("message");
      this.sendInternalFailure(ws, command.operationId);
      return;
    }

    switch (outcome.kind) {
      case "not_found": {
        this.safeSend(ws, noticeMessage("ROOM_NOT_FOUND", "房间不存在"));
        this.safeClose(ws, 1008, "ROOM_NOT_FOUND");
        return;
      }
      case "archived": {
        this.sendCommandResult(ws, command.operationId, {
          ok: false,
          error: { code: "ROOM_ARCHIVED", message: "房间已归档，拒绝一切写操作" },
          versions: outcome.versions,
        });
        this.sendCurrentViewTo(ws);
        return;
      }
      case "unsupported_rule_version": {
        this.sendCommandResult(ws, command.operationId, {
          ok: false,
          error: {
            code: "RULE_VERSION_UNSUPPORTED",
            message: "房间的规则版本不受当前实现支持，拒绝执行命令",
          },
          versions: outcome.versions,
        });
        this.sendCurrentViewTo(ws);
        return;
      }
      case "replayed": {
        this.sendCommandResult(ws, command.operationId, {
          ok: outcome.receipt.ok,
          error:
            outcome.receipt.ok || outcome.receipt.errorCode === null
              ? null
              : {
                  code: outcome.receipt.errorCode,
                  message: outcome.receipt.errorMessage ?? "",
                },
          versions: {
            bpVersion: outcome.receipt.bpVersion,
            revision: outcome.receipt.revision,
          },
        });
        // 幂等重发：原回执的版本可能已落后，推送最新视图帮助客户端同步。
        this.sendCurrentViewTo(ws);
        return;
      }
      case "conflict": {
        this.sendCommandResult(ws, command.operationId, {
          ok: false,
          error: {
            code: "OPERATION_ID_CONFLICT",
            message: "同一 operationId 已被不同的命令载荷使用",
          },
          versions: outcome.versions,
        });
        this.sendCurrentViewTo(ws);
        return;
      }
      case "executed": {
        this.sendCommandResult(ws, command.operationId, {
          ok: outcome.ok,
          error: outcome.error,
          versions: { bpVersion: outcome.after.bp.version, revision: outcome.after.revision },
        });
        // 结果之后推送最新视图：状态变化 → 全体连接（含操作者）；
        // 未变化的空操作 → 仅操作者连接（视图幂等，便于统一处理）。
        if (outcome.changed) {
          this.broadcastViews(outcome.after, outcome.meta);
        } else {
          this.sendCurrentViewTo(ws);
        }
      }
    }
  }

  /** 组装并发送 commandResult；发送失败只影响该连接（命令已提交）。 */
  private sendCommandResult(
    ws: WebSocket,
    operationId: string,
    result: {
      readonly ok: boolean;
      readonly error: RoomOperationError | null;
      readonly versions: RoomVersionInfo;
    },
  ): void {
    const message: CommandResultMessage = {
      kind: "commandResult",
      operationId,
      ok: result.ok,
      error: result.error,
      bpVersion: result.versions.bpVersion,
      revision: result.versions.revision,
    };
    this.safeSend(ws, commandResultMessage(message));
  }

  /**
   * 内部故障回执：状态与回执已随事务回滚，客户端可用同一 operationId
   * 重试。版本字段尽力从当前存储读取；连读取都失败时（存储整体不可用）
   * 关闭连接，由客户端重连。
   */
  private sendInternalFailure(ws: WebSocket, operationId: string): void {
    let versions: RoomVersionInfo | null = null;
    try {
      versions = readRoomVersionInfo(this.sql);
    } catch {
      versions = null;
    }
    if (versions === null) {
      this.safeClose(ws, 1011, "internal");
      return;
    }
    this.sendCommandResult(ws, operationId, {
      ok: false,
      error: { code: "INTERNAL", message: "命令处理失败，请稍后重试" },
      versions,
    });
    this.sendCurrentViewTo(ws);
  }

  // ---- 视图广播 ----

  /**
   * 向全部连接按身份推送最新视图：房主连接收 hostView，普通成员连接收
   * memberView，展示连接收 displayView，rejected 连接跳过。单个连接
   * 发送失败不影响其他连接，也不影响已提交的命令。
   */
  private broadcastViews(state: RoomState, meta: RoomMeta): void {
    for (const socket of this.ctx.getWebSockets()) {
      const message = this.viewMessageFor(socket, state, meta);
      if (message !== null) {
        this.safeSend(socket, message);
      }
    }
  }

  /** 从当前持久状态读取并向单个连接推送其视图（连接建立与命令回执后）。 */
  private sendCurrentViewTo(ws: WebSocket): void {
    let message: string | null = null;
    try {
      const meta = readRoomMeta(this.sql);
      if (meta !== null) {
        const state = loadRoomState(this.sql);
        if (state !== null) {
          message = this.viewMessageFor(ws, state, meta);
        }
      }
    } catch {
      this.logRealtimeInternalError("view");
    }
    if (message !== null) {
      this.safeSend(ws, message);
    }
  }

  /** 重新读取当前状态并向全部连接广播（HTTP 可见变化后调用）。 */
  private broadcastCurrentViews(): void {
    try {
      const meta = readRoomMeta(this.sql);
      if (meta === null) return;
      const state = loadRoomState(this.sql);
      if (state === null) return;
      this.broadcastViews(state, meta);
    } catch {
      this.logRealtimeInternalError("join");
    }
  }

  /** 按连接附件构造该连接的视图消息；无身份或成员已不在房间时为 null。 */
  private viewMessageFor(ws: WebSocket, state: RoomState, meta: RoomMeta): string | null {
    const attachment = readAttachment(ws);
    if (attachment === null || (attachment.kind !== "member" && attachment.kind !== "display")) {
      return null;
    }
    const versions = this.versionsOf(meta);
    if (attachment.kind === "display") {
      return displayViewMessage(projectDisplayView(state, versions));
    }
    const hostView = projectHostManagementView(state, attachment.memberId, versions);
    if (hostView !== null) {
      return hostViewMessage(hostView);
    }
    const memberView = projectRoomMemberView(state, attachment.memberId, versions);
    return memberView === null ? null : memberViewMessage(memberView);
  }

  // ---- 通用辅助 ----

  /** 解析凭据摘要为成员 ID；无效或缺失返回 null（按匿名处理）。 */
  private resolveCredential(digest: string | null): MemberId | null {
    if (digest === null) return null;
    return findMemberIdByCredentialDigest(this.sql, digest);
  }

  /** 投影指定成员的当前视图；成员不在房间（或未建房）返回 null。 */
  private projectMemberView(memberId: MemberId): RoomMemberView | null {
    const meta = readRoomMeta(this.sql);
    if (meta === null) return null;
    const state = loadRoomState(this.sql);
    if (state === null) return null;
    return projectRoomMemberView(state, memberId, this.versionsOf(meta));
  }

  private versionsOf(meta: RoomMeta) {
    return { ruleVersion: meta.ruleVersion, agentDataVersion: meta.agentDataVersion };
  }

  /** 发送失败（连接已断开/缓冲满）只影响该连接；清理交给关闭事件。 */
  private safeSend(ws: WebSocket, message: string): void {
    try {
      ws.send(message);
    } catch {
      // 已提交命令的对外结果不因单个连接失败而回滚或阻塞其他连接。
    }
  }

  private safeClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // 连接可能已关闭；重复关闭是空操作。
    }
  }

  /**
   * WS 路径内部故障的结构化诊断：只输出静态白名单字段（事件、阶段、
   * 静态分类），不记录异常内容、连接身份或消息内容（约束见
   * docs/architecture.md「错误诊断与可观测性」）。
   */
  private logRealtimeInternalError(phase: string): void {
    console.error(
      JSON.stringify({
        event: "room_ws.internal_error",
        phase,
        errorKind: "internal",
      }),
    );
  }
}
