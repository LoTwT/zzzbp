import { DurableObject } from "cloudflare:workers";
import { agentCatalogSchema, type AgentCatalogData } from "../shared/agents/schema";
import { roomInfoSchema, type RoomInfo } from "../shared/api";
import type { RoomMemberView } from "../shared/contracts/views";
import { projectRoomMemberView } from "../shared/contracts/views";
import type { MemberId } from "../shared/ids";
import {
  createRoomRecord,
  ensureRoomSchema,
  findMemberIdByCredentialDigest,
  insertMember,
  loadRoomCatalog,
  loadRoomState,
  readRoomMeta,
  type RoomMeta,
  type RoomSql,
} from "./persistence";

/**
 * 房间 Durable Object：每个房间一个实例，存储引擎为内置 SQLite。
 *
 * 本文件只承担编排：表结构、行级读写与状态装配在 ./persistence.ts，
 * 视图投影与命令语义复用 shared/ 的纯函数。本类与一切房间读取只使用
 * 该实例的持久目录快照；全局目录仅在 Worker 建房入口作为创建输入
 * 注入一次（见 server/index.ts 的 handleCreateRoom）。
 *
 * 事务边界：每个业务方法把「schema 初始化 + 检查 + 写入 + 写入后的
 * 状态装配」整体包在 ctx.storage.transactionSync 的同步闭包内——闭包
 * 内任一步骤抛异常（SQL 故障、schema 校验失败、装配失败）时平台回滚
 * 整个事务，不留半建房或无凭据的孤儿成员。闭包必须同步完成（官方
 * SQLite Storage API 约束），本类内的 SQL 与装配均为同步操作；DO 的
 * 单线程执行与输入门只保证语句不被其他事件交错，不提供异常回滚。
 *
 * 所有业务方法在入口处幂等初始化表结构；未创建业务房间（room_meta
 * 无行）的实例只存在空表结构壳，任何读取都返回 not_found，不会因
 * GET 或错误 roomId 隐式创建业务房间。
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

  // ---- 业务房间 ----

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
   * 保证 schema 初始化写入的一致性与多次读取的一致快照。
   */
  async getRoomEntry(input: RoomCredentialInput): Promise<RoomEntryResult> {
    return this.ctx.storage.transactionSync((): RoomEntryResult => {
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
   * 否则以请求昵称创建新观众成员。新成员为离线状态（PR5 的 WS 接入才计
   * 在线）。成员写入与 revision 递增、写入后的视图装配同在一个事务闭包
   * 内：任一步骤失败整体回滚，不会留下无凭据交付的孤儿成员。
   */
  async joinRoom(input: JoinRoomInput): Promise<JoinRoomResult> {
    return this.ctx.storage.transactionSync((): JoinRoomResult => {
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
  }

  /** 读取该房间固定的目录快照（经 schema 校验）；未建房返回 null。 */
  async getRoomCatalog(): Promise<AgentCatalogData | null> {
    return this.ctx.storage.transactionSync((): AgentCatalogData | null => {
      ensureRoomSchema(this.sql);
      return loadRoomCatalog(this.sql);
    });
  }

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
}
