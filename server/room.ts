import { DurableObject } from "cloudflare:workers";
import { toAgentCatalog, toAgentDisplayLookup } from "../shared/agents/catalog";
import { agentCatalogSchema, type AgentCatalogData } from "../shared/agents/schema";
import { roomInfoSchema, type RoomInfo } from "../shared/api";
import { BP_RULE_VERSION } from "../shared/bp/version";
import { roomCommandSchema, type RoomCommand, type RoomOperationError } from "../shared/commands";
import type { ApiErrorCode } from "../shared/contracts/http";
import {
  computeEmptyRoomDeadline,
  EMPTY_ROOM_RETENTION_MS,
  projectArchiveSnapshot,
  type ArchiveSnapshot,
} from "../shared/contracts/records";
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
  deleteRoomOperationalData,
  ensureRoomSchema,
  findCommandReceipt,
  findMemberIdByCredentialDigest,
  hasRoomSchema,
  insertCommandReceipt,
  insertMember,
  loadRoomCatalog,
  loadRoomState,
  persistRoomStateChange,
  readArchiveSnapshot,
  readRoomMeta,
  readRoomVersionInfo,
  setLastMemberLeftAt,
  setRoomLifecycle,
  writeArchiveSnapshot,
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
 * Alarm 是异步存储操作，不进入 transactionSync：生命周期裁决（含归档
 * 转换的 SQL 部分）在事务内原子完成，Alarm 应用在事务提交后执行，失败
 * 时上抛（读取路径 500、Alarm 处理器交平台重试、断开路径交有界重试链），
 * 不留下「对外成功但不再有唤醒信号」的状态。
 *
 * 生命周期（PR9）：全员实际成员连接离开后保留 12 小时；期限前回归取消
 * 计时，到期由读取（含目录）、入房、WS 接纳、命令与 Alarm 共用同一
 * 裁决（adjudicateLifecycleInTransaction）——now >= 期限必须先完成
 * 裁决再考虑入房或命令，注册新连接不能清掉已过期期限，也不能靠延迟
 * Alarm 延长可操作时间。Alarm 只是唤醒信号：每次触发都按当前持久状态
 * 与当前实际连接重判，重复/过早的触发收敛到应设的下一期限，不重复
 * 归档、不提早清理。
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
 * 在线状态以连接注册表为唯一权威，成员连接、断开、每条业务命令与 HTTP
 * 入房都会先把存储投影与注册表对齐（在线协调），短暂存储故障由有界
 * 重试链补偿，不维护常驻计数器、权限缓存或轮询定时器。命令操作者只来
 * 自连接附件中的可信身份，角色/席位/轮次/版本与名单每次从当前持久状态
 * 重新判断（见 processMemberCommand）。
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
 * 保留计时的初始化语义验证与生命周期裁决的观测。
 */
export type RoomEntryResult =
  | { readonly kind: "not_found" }
  | {
      /** 已归档：原链接返回同一份只读快照（原房主、成员与匿名一致）。 */
      readonly kind: "archived";
      readonly record: ArchiveSnapshot;
    }
  | {
      readonly kind: "live";
      readonly roomName: string;
      readonly memberView: RoomMemberView | null;
      readonly createdAt: string;
      readonly lastMemberLeftAt: string | null;
    };

/** `getRoomCatalog` 结果：live 房间携带固定目录，归档房间不再提供实时目录。 */
export type RoomCatalogResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "archived" }
  | { readonly kind: "catalog"; readonly data: AgentCatalogData };

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
  /** 房间数据消失（已清理或防御）：按连接通知处理。 */
  | { readonly kind: "not_found" }
  /** 房间到期且无有效记录：需要事务外的原子 deleteAll 清理。 */
  | { readonly kind: "room_cleanup" }
  | {
      readonly kind: "archived";
      readonly versions: RoomVersionInfo;
    }
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

/**
 * 生命周期裁决结果（SQL 部分在 transactionSync 内原子完成）。
 *
 * `alarm` 是按裁决后的持久状态应设的下一 Alarm 时刻（毫秒），null 表示
 * 不应有 Alarm（成员在线、房间不存在或待清理）。
 */
type LifecycleAdjudication =
  | { readonly kind: "not_found"; readonly alarm: null }
  | { readonly kind: "live"; readonly alarm: number | null }
  | {
      readonly kind: "archived";
      readonly snapshot: ArchiveSnapshot;
      /** 本次事件刚完成归档转换（持久成功后才通知现存连接）。 */
      readonly transitioned: boolean;
      readonly alarm: number;
    }
  /** 空房到期且无有效提交，或快照到期：由调用方在事务外原子清理。 */
  | { readonly kind: "cleanup"; readonly alarm: null };

/** 裁决收口后的对外结果：cleanup 统一折叠为 not_found。 */
type LifecycleEffective =
  | { readonly kind: "not_found" }
  | { readonly kind: "live" }
  | { readonly kind: "archived"; readonly snapshot: ArchiveSnapshot };

/** 成员在线转移事务的结果：changed 为 false 时不广播。 */
interface PresenceOutcome {
  readonly changed: boolean;
  readonly state: RoomState | null;
  readonly meta: RoomMeta | null;
}

/**
 * 在线协调失败后的有界重试退避序列（毫秒）。
 *
 * 覆盖短暂存储故障（约 6 分钟内的恢复都能补齐暂停/离线/全员离开时间），
 * 链结束（成功或用尽）后不再持有 timer，不阻止休眠；这不是常驻轮询。
 */
const PRESENCE_RETRY_DELAYS_MS = [250, 1000, 4000, 16000, 60000, 300000] as const;

export class Room extends DurableObject {
  /** 是否已有在途的在线协调重试链（单实例内去重；实例重建后自然复位）。 */
  private presenceRetryScheduled = false;

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
   *
   * 空房期限 Alarm 先于事务设置：Alarm 是异步操作不能进 transactionSync，
   * 而建放在提交后再补设一旦失败，客户端重试会生成新 roomId，旧房间
   * 成为无人再访问的孤儿（永久不再清理）。全新实例先设 Alarm（自创建
   * 起 12 小时，见 last_member_left_at 初始化语义），任何失败路径都
   * 收敛——事务回滚时实例无房间，该 Alarm 触发后按无房间自清；事务
   * 成功后按持久 createdAt 对齐精确期限（先设的 Alarm 只早不晚，对齐
   * 失败只影响毫秒级精度，不影响清理保证）。
   */
  async createRoom(input: CreateRoomInput): Promise<CreateRoomResult> {
    const freshInstance = !hasRoomSchema(this.sql);
    if (freshInstance) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_RETENTION_MS);
    }
    const result = this.ctx.storage.transactionSync((): CreateRoomResult => {
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
    if (result.kind === "created" || result.kind === "already_exists") {
      try {
        await this.applyLifecycleAlarm(this.desiredLifecycleAlarmMs());
      } catch {
        // 预设 Alarm 已保证清理；对齐失败只影响精度，不使建房对外失败。
        this.logLifecycleInternalError("create-align");
      }
    }
    return result;
  }

  /**
   * 读取房间入口数据：按生命周期分流——live 返回房名与身份视图（凭据
   * 有效时恢复角色，否则匿名）；archived 返回同一份只读快照（原房主、
   * 成员与匿名访客一致，读取不建立成员/展示连接、不刷新快照期限）。
   *
   * 读取同样先做生命周期裁决：到期房间在读路径上完成归档或清理（不能
   * 等 Alarm），未到期时按当前状态收敛 Alarm（含既有 v2 房间迁移后的
   * 首次补设）。普通读取不改变在线状态与保留计时。从未建房的实例不做
   * 任何写入（不建表、不动 Alarm），直接按 not_found 返回。
   */
  async getRoomEntry(input: RoomCredentialInput): Promise<RoomEntryResult> {
    const outcome = this.ctx.storage.transactionSync(
      (): {
        adjudication: LifecycleAdjudication;
        live: {
          readonly roomName: string;
          readonly memberView: RoomMemberView | null;
          readonly createdAt: string;
          readonly lastMemberLeftAt: string | null;
        } | null;
      } => {
        if (!hasRoomSchema(this.sql)) {
          return { adjudication: { kind: "not_found", alarm: null }, live: null };
        }
        ensureRoomSchema(this.sql);
        const adjudication = this.adjudicateLifecycleInTransaction(this.connectedMemberIds());
        if (adjudication.kind !== "live") return { adjudication, live: null };

        const meta = readRoomMeta(this.sql);
        if (meta === null) {
          // 防御：live 裁决依赖 room_meta，二者不一致属于存储异常。
          throw new Error("live 裁决后房间元信息缺失，存储状态异常");
        }
        const viewerMemberId = this.resolveCredential(input.credentialDigest);
        const memberView = viewerMemberId === null ? null : this.projectMemberView(viewerMemberId);
        return {
          adjudication,
          live: {
            roomName: meta.name,
            memberView,
            createdAt: meta.createdAt,
            lastMemberLeftAt: meta.lastMemberLeftAt,
          },
        };
      },
    );

    const effective = await this.settleLifecycle(outcome.adjudication);
    if (effective.kind === "not_found") return { kind: "not_found" };
    if (effective.kind === "archived") return { kind: "archived", record: effective.snapshot };
    if (outcome.live === null) {
      // settleLifecycle 的 live 结果只能来自 live 裁决，此处不可达（防御）。
      throw new Error("live 裁决后缺少入口数据，存储状态异常");
    }
    return { kind: "live", ...outcome.live };
  }

  /**
   * 入房：有效凭据恢复原成员（忽略请求昵称，不轮换凭据、不重复建成员）；
   * 否则以请求昵称创建新观众成员。新成员为离线状态（只有实际成员 WS
   * 连接会计在线）。
   *
   * 两阶段结构（修复「Alarm 收敛失败留下无凭据孤儿成员」）：
   * - 阶段一（前置生命周期收敛）：会失败的异步 Alarm 应用放在成员写入
   *   之前——失败时上抛，HTTP 500、零成员写入、无凭据交付（保持 PR4
   *   的失败零写入契约，客户端重试不产生孤儿）。先做在线协调再裁决：
   *   协调可能修复「存储在线但实际无连接」的持久残留（最后断开写入
   *   失败且重试链/实例已丢失）并补写全员离开时间，裁决的 Alarm 期望
   *   值因此按协调后的最终期限推导——新期限的 Alarm 与协调写入都在
   *   成员事务之前完成。到期房间在此完成归档/清理（含终态连接收口）
   *   并按终态拒绝入房。
   * - 阶段二（入房事务）：先重新裁决守住到期/存在性边界——阶段一的
   *   await 期间时钟推进或连接事件都可能改变结论，到期在此归档并
   *   拒绝，不能因前置已判定 live 而让过期房间被入房复活；live 时做
   *   兜底协调（阶段一之后的事件间隙若再留下分叉在此修复，正常无
   *   变化），成员写入与 revision 递增、写入后的视图装配在一个事务
   *   闭包内，任一步骤失败整体回滚。
   * - 阶段三（收口）：终态（归档/清理）走统一收口；live 不再应用
   *   Alarm——阶段一已按协调后的状态收敛，兜底协调若再写计时，其
   *   源头断开事件的重试链负责收敛（持久残留由下一个入房的阶段一
   *   兜底），此处重复应用一旦失败会把已提交成员变成无凭据孤儿。
   *
   * HTTP 身份登记本身不取消、不延长保留期限（last_member_left_at 只由
   * 实际成员 WS 连接维护）；未建房的实例不做任何写入（不建表、不动
   * Alarm），直接按 not_found 返回。新成员写入成功、或任一阶段协调修复
   * 了历史分叉时，向已连接的成员/展示连接广播最新视图（房主的成员
   * 列表因此实时更新）。
   */
  async joinRoom(input: JoinRoomInput): Promise<JoinRoomResult> {
    // 阶段一：前置生命周期收敛（在线协调 + 裁决 + Alarm 应用 + 终态收口）。
    const pre = this.ctx.storage.transactionSync(
      (): {
        adjudication: LifecycleAdjudication;
        reconciled: boolean;
      } => {
        if (!hasRoomSchema(this.sql)) {
          return { adjudication: { kind: "not_found", alarm: null }, reconciled: false };
        }
        ensureRoomSchema(this.sql);
        // 协调先于裁决（见方法注释）：非 live/未建房时协调零写入跳过。
        const presence = this.reconcilePresenceInTransaction();
        const adjudication = this.adjudicateLifecycleInTransaction(this.connectedMemberIds());
        return { adjudication, reconciled: presence.changed };
      },
    );
    const preEffective = await this.settleLifecycle(pre.adjudication);
    if (preEffective.kind === "not_found") return { kind: "not_found" };
    if (preEffective.kind === "archived") return { kind: "archived" };

    // 阶段二：入房事务（重新裁决守住到期/存在性边界 + 兜底协调 + 成员写入）。
    const outcome = this.ctx.storage.transactionSync(
      (): {
        result: JoinRoomResult | null;
        adjudication: LifecycleAdjudication;
        reconciled: boolean;
      } => {
        if (!hasRoomSchema(this.sql)) {
          return {
            result: null,
            adjudication: { kind: "not_found", alarm: null },
            reconciled: false,
          };
        }
        ensureRoomSchema(this.sql);
        const adjudication = this.adjudicateLifecycleInTransaction(this.connectedMemberIds());
        if (adjudication.kind === "archived") {
          return { result: { kind: "archived" }, adjudication, reconciled: false };
        }
        if (adjudication.kind === "cleanup") {
          return { result: null, adjudication, reconciled: false };
        }

        // live：兜底在线协调（以实际连接为权威），与成员写入同事务提交
        // 或回滚；阶段一刚协调过，正常无变化。
        const presence = this.reconcilePresenceInTransaction();

        const existingMemberId = this.resolveCredential(input.credentialDigest);
        if (existingMemberId !== null) {
          const memberView = this.projectMemberView(existingMemberId);
          if (memberView === null) {
            throw new Error("成员凭据指向的成员不在房间内，存储状态异常");
          }
          return {
            result: { kind: "restored", memberView },
            adjudication,
            reconciled: presence.changed,
          };
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
        return {
          result: { kind: "created", memberView },
          adjudication,
          reconciled: presence.changed,
        };
      },
    );

    // 阶段三：终态收口（清理/Alarm/终态通知；live 不重复应用 Alarm，见
    // 方法注释）。终态路径没有成员写入，Alarm 失败上抛不产生孤儿。
    if (outcome.adjudication.kind !== "live") {
      const effective = await this.settleLifecycle(outcome.adjudication);
      if (effective.kind === "not_found") return { kind: "not_found" };
      if (effective.kind === "archived") return { kind: "archived" };
      // settleLifecycle 的 live 结果只能来自 live 裁决，此处不可达（防御）。
      throw new Error("生命周期收口结果与裁决不一致");
    }
    if (outcome.result === null) {
      throw new Error("live 裁决后缺少入房结果，存储状态异常");
    }

    // 新成员加入或任一阶段的在线协调修复了分叉时，向已连接的成员/展示
    // 连接广播最新视图（房主的成员列表因此实时更新）；单纯恢复身份不
    // 产生广播。
    if (outcome.result.kind === "created" || outcome.reconciled || pre.reconciled) {
      this.broadcastCurrentViews();
    }
    return outcome.result;
  }

  /**
   * 读取该房间固定的目录快照（经 schema 校验）；未建房返回 not_found
   * 且不写入存储。归档房间不再提供实时目录（归档时目录行已随操作期
   * 数据清理，只读记录的一切展示信息固定在快照内）——返回 archived
   * 由 HTTP 层转为 410，展示页据此按「已归档」而非「不存在」收口。
   * 目录读取同样先做生命周期裁决并收敛 Alarm，但不改变保留计时。
   */
  async getRoomCatalog(): Promise<RoomCatalogResult> {
    const outcome = this.ctx.storage.transactionSync(
      (): {
        adjudication: LifecycleAdjudication;
        catalog: AgentCatalogData | null;
      } => {
        if (!hasRoomSchema(this.sql)) {
          return { adjudication: { kind: "not_found", alarm: null }, catalog: null };
        }
        ensureRoomSchema(this.sql);
        const adjudication = this.adjudicateLifecycleInTransaction(this.connectedMemberIds());
        const catalog = adjudication.kind === "live" ? loadRoomCatalog(this.sql) : null;
        return { adjudication, catalog };
      },
    );

    const effective = await this.settleLifecycle(outcome.adjudication);
    if (effective.kind === "not_found") return { kind: "not_found" };
    if (effective.kind === "archived") return { kind: "archived" };
    if (outcome.catalog === null) {
      throw new Error("live 房间目录快照缺失，存储状态异常");
    }
    return { kind: "catalog", data: outcome.catalog };
  }

  // ---- 生命周期：到期裁决、归档转换与 Alarm ----

  /**
   * 生命周期裁决（调用方已在 transactionSync 闭包内、schema 已确保）。
   *
   * 规则单一来源，读取（含目录）、入房、WS 接纳、命令与 Alarm 共用：
   * - live 且有实际成员连接（或 lastMemberLeftAt 为 null，即计时未启动）：
   *   继续保留，期望无 Alarm（旧 Alarm 触发时按此重判自清）；
   * - live 空房且 now < lastMemberLeftAt + 12h：保留，期望 Alarm 设在期限；
   * - live 空房到期：当前局有有效提交则在同一事务内完成归档转换
   *   （快照生成 + 生命周期标记 + 操作期数据清理，任一步失败整体回滚，
   *   不留半归档）；无有效提交（仅预选、全部撤回、重开未提交）不生成
   *   空快照，返回 cleanup 由调用方在事务外原子清理；
   * - archived 且 now < 快照 expiresAt：服务快照，期望 Alarm 设在到期；
   * - archived 快照到期：返回 cleanup。
   *
   * 快照用该房间持久目录（非全局目录）与建房时固定的版本生成；90 天自
   * 本次实际转为只读起算，重复读取或 Alarm 不刷新起点。
   */
  private adjudicateLifecycleInTransaction(connected: ReadonlySet<string>): LifecycleAdjudication {
    const meta = readRoomMeta(this.sql);
    if (meta === null) return { kind: "not_found", alarm: null };

    if (meta.lifecycle === "archived") {
      const snapshot = readArchiveSnapshot(this.sql);
      if (snapshot === null) {
        // 归档转换原子写入标记与快照；缺快照属存储完整性异常，按 INTERNAL
        // 收口，不把有记录的房间伪装成不存在或已过期。
        throw new Error("已归档房间缺少快照，存储状态异常");
      }
      if (Date.now() >= Date.parse(snapshot.expiresAt)) {
        return { kind: "cleanup", alarm: null };
      }
      return {
        kind: "archived",
        snapshot,
        transitioned: false,
        alarm: Date.parse(snapshot.expiresAt),
      };
    }

    if (connected.size > 0 || meta.lastMemberLeftAt === null) {
      // 实际成员连接是保留的权威依据：期限前回归即取消本次计时，
      // 不能因存储投影的暂时分叉误判到期（在线协调会修复投影）。
      return { kind: "live", alarm: null };
    }
    const deadlineMs = Date.parse(computeEmptyRoomDeadline(meta.lastMemberLeftAt));
    if (Date.now() < deadlineMs) {
      return { kind: "live", alarm: deadlineMs };
    }

    // 空房到期：按当前有效提交决定归档或清理。
    const state = loadRoomState(this.sql);
    if (state === null) throw new Error("到期裁决前状态装配失败");
    const catalog = loadRoomCatalog(this.sql);
    if (catalog === null) throw new Error("到期裁决前目录快照缺失");
    const snapshot = projectArchiveSnapshot({
      state,
      agentDisplay: toAgentDisplayLookup(catalog),
      versions: this.versionsOf(meta),
      archivedAt: new Date().toISOString(),
    });
    if (snapshot === null) {
      return { kind: "cleanup", alarm: null };
    }
    setRoomLifecycle(this.sql, "archived");
    writeArchiveSnapshot(this.sql, snapshot);
    deleteRoomOperationalData(this.sql);
    return {
      kind: "archived",
      snapshot,
      transitioned: true,
      alarm: Date.parse(snapshot.expiresAt),
    };
  }

  /**
   * 按当前持久状态与实际连接推导应设的生命周期 Alarm（毫秒）。
   *
   * 与 adjudicateLifecycleInTransaction 的 alarm 推导保持一致，供不需
   * 要完整裁决的收敛路径使用（在线协调重试链、断开后的 Alarm 补设、
   * 建房后的期限对齐）。live 空房为空房期限（可能已过：setAlarm 设为
   * 过去时间会立即触发裁决）；成员在线、房间不存在或已归档缺快照
   * （完整性异常，读取路径会按 INTERNAL 收口）为 null。
   */
  private desiredLifecycleAlarmMs(): number | null {
    const meta = readRoomMeta(this.sql);
    if (meta === null) return null;
    if (meta.lifecycle === "archived") {
      const snapshot = readArchiveSnapshot(this.sql);
      return snapshot === null ? null : Date.parse(snapshot.expiresAt);
    }
    if (meta.lastMemberLeftAt === null || this.connectedMemberIds().size > 0) return null;
    return Date.parse(computeEmptyRoomDeadline(meta.lastMemberLeftAt));
  }

  /**
   * 把 Alarm 收敛到期望状态（事务提交后调用；Alarm 是异步存储操作，不能
   * 进入 transactionSync）。
   *
   * - 期望 null（成员在线/房间已删）：残留的旧 Alarm 触发时会按当前状态
   *   重判并自清，删除失败不阻塞业务（读取不应因清理残留失败而 500），
   *   交给下一事件收敛；
   * - 期望有值：与当前一致则不动（不覆盖已设的下一期限），不一致时覆盖
   *   为按当前持久状态推导的期限；setAlarm 失败必须上抛——调用方不能在
   *   「不再有唤醒信号」的状态下对外返回成功（读取路径 500、Alarm 处理
   *   器交给平台 at-least-once 重试、断开路径交给有界重试链）。
   */
  private async applyLifecycleAlarm(desired: number | null): Promise<void> {
    if (desired === null) {
      try {
        if ((await this.ctx.storage.getAlarm()) !== null) {
          await this.ctx.storage.deleteAlarm();
        }
      } catch {
        this.logLifecycleInternalError("alarm-clear");
      }
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === desired) return;
    await this.ctx.storage.setAlarm(desired);
  }

  /**
   * 裁决的事务外收口：清理（原子 deleteAll 回收整个 SQLite，含业务表、
   * KV 与兼容日期 2026-09-01 起的 Active Alarm；仍显式 deleteAlarm 兜底
   * 旧运行时语义）、Alarm 应用与终态连接收口。返回对调用方的最终结果
   * （cleanup 折叠为 not_found）。
   *
   * 终态连接收口（concludeConnections）不依赖 transitioned：归档/清理
   * 一旦持久成立，任何入口（读取、入房、目录、WS 接纳、命令、Alarm
   * 及其故障后的重试）重放收口都向现存实时连接发送终态通知并关闭——
   * 无心跳的展示客户端不会自己发现房间已终态，遗漏一次通知就会永远
   * 保留「已连接」的旧画面。not_found 同样收口：未知房间没有连接可发
   * （升级即拒，conclude 是无存储写入的空操作），而「deleteAll 已成功、
   * 冗余 deleteAlarm 失败」的半收口故障会留下旧实时连接，后续任何
   * not_found 重放都要能幂等补齐。幂等：通知/关闭只影响仍存活的连接。
   * SQL 归档/清理失败（事务回滚/deleteAll 抛错）不会到达收口，不发假
   * 终态；Alarm 应用失败时在通知之前上抛，由平台重试或下一事件在
   * 恢复后完成通知（持久终态不变，重放结论相同）。
   *
   * `beforeConclude` 供命令通道保序：commandResult 必须先于终态通知与
   * 关闭送达操作者连接（挂起命令以服务端回执结算，随后连接按终态
   * 收口）。
   */
  private async settleLifecycle(
    adjudication: LifecycleAdjudication,
    options?: { readonly beforeConclude?: () => void },
  ): Promise<LifecycleEffective> {
    switch (adjudication.kind) {
      case "not_found":
        // 幂等补齐半收口故障遗留的旧连接；不触碰 Alarm 与存储（未知
        // 房间保持零写入，空实例的孤立 Alarm 由 alarm() 触发时自清）。
        this.concludeConnections("ROOM_NOT_FOUND", "房间不存在或已过期");
        return { kind: "not_found" };
      case "cleanup":
        // deleteAll 原子成功即持久终态成立：先收口连接，再做冗余的
        // Alarm 显式清理。deleteAlarm 失败不阻止终态通知——本兼容日期
        // 下 deleteAll 已删除 Active Alarm，残留（旧运行时语义）触发时
        // 由 alarm() 按 not_found 自清；deleteAll 自身失败在此前抛出，
        // 不发假终态。
        await this.ctx.storage.deleteAll();
        this.concludeConnections("ROOM_NOT_FOUND", "房间不存在或已过期");
        try {
          await this.ctx.storage.deleteAlarm();
        } catch {
          this.logLifecycleInternalError("cleanup-alarm-clear");
        }
        return { kind: "not_found" };
      case "live":
        await this.applyLifecycleAlarm(adjudication.alarm);
        return { kind: "live" };
      case "archived":
        await this.applyLifecycleAlarm(adjudication.alarm);
        options?.beforeConclude?.();
        this.concludeConnections("ROOM_ARCHIVED", "房间已归档");
        return { kind: "archived", snapshot: adjudication.snapshot };
    }
  }

  /**
   * 终态连接收口：向现存的成员/展示连接发送终态通知并关闭（1008）。
   *
   * 只在持久终态成立后调用（见 settleLifecycle）：归档 → ROOM_ARCHIVED；
   * 清理 → ROOM_NOT_FOUND（原房间链接按不存在收口，客户端不再重连）。
   * rejected 连接（升级时即被拒绝的）跳过；发送/关闭失败只影响该连接。
   */
  private concludeConnections(code: "ROOM_ARCHIVED" | "ROOM_NOT_FOUND", message: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (attachment === null || attachment.kind === "rejected") continue;
      this.safeSend(socket, noticeMessage(code, message));
      this.safeClose(socket, 1008, code);
    }
  }

  /**
   * 生命周期 Alarm 处理器：平台按存储的 Alarm 时间唤醒实例。
   *
   * Alarm 只是唤醒信号，不是期限本身：每次触发都按当前持久状态与实际
   * 连接重新裁决（与读取/入房/命令共用同一裁决），重复、过早或延迟的
   * 触发都收敛到当前应设的下一期限——不重复归档、不提早清理、不覆盖
   * 已设的下一期限、不靠延迟触发延长可操作时间（期限由各入口的裁决
   * 强制，Alarm 只负责无人访问时的推进）。终态连接收口同样幂等：即使
   * 上一次执行的归档已提交而 Alarm 写入失败，本次重试（或任何入口）
   * 仍会对现存连接完成终态通知。
   *
   * SQL 裁决在 transactionSync 内原子完成；其后的 Alarm 收敛或收口失败
   * 时抛出，由平台 at-least-once 语义重试（2 秒起指数退避，最多 6 次），
   * 进程崩溃时在另一实例上从头重跑（见官方 Alarms API）。
   */
  async alarm(): Promise<void> {
    const adjudication = this.ctx.storage.transactionSync((): LifecycleAdjudication => {
      if (!hasRoomSchema(this.sql)) return { kind: "not_found", alarm: null };
      ensureRoomSchema(this.sql);
      return this.adjudicateLifecycleInTransaction(this.connectedMemberIds());
    });
    await this.settleLifecycle(adjudication);
  }

  /** 生命周期路径内部故障的结构化诊断（白名单字段，不含错误内容）。 */
  private logLifecycleInternalError(phase: string): void {
    console.error(
      JSON.stringify({
        event: "room_lifecycle.internal_error",
        phase,
        errorKind: "internal",
      }),
    );
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
   *
   * 升级前先做生命周期裁决（此时新连接尚未计入注册表）：到期房间在
   * 接纳前完成归档或清理，归档按 ROOM_ARCHIVED 拒绝——注册新连接不能
   * 清掉已过期期限。未到期时按当前状态收敛 Alarm；展示通道不计成员、
   * 不影响保留计时。
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
      | { readonly kind: "display" }
      | { readonly kind: "auth_failed" }
      | { readonly kind: "member"; readonly memberId: MemberId };

    const resolved = this.ctx.storage.transactionSync(
      (): {
        adjudication: LifecycleAdjudication;
        resolution: UpgradeResolution;
      } => {
        if (!hasRoomSchema(this.sql)) {
          return {
            adjudication: { kind: "not_found", alarm: null },
            resolution: { kind: "missing" },
          };
        }
        ensureRoomSchema(this.sql);
        const adjudication = this.adjudicateLifecycleInTransaction(this.connectedMemberIds());
        if (adjudication.kind !== "live") {
          return { adjudication, resolution: { kind: "missing" } };
        }
        if (route.channel === "display") {
          return { adjudication, resolution: { kind: "display" } };
        }
        const memberId = digest === null ? null : findMemberIdByCredentialDigest(this.sql, digest);
        return {
          adjudication,
          resolution: memberId === null ? { kind: "auth_failed" } : { kind: "member", memberId },
        };
      },
    );

    // 生命周期收口：清理失败或 Alarm 收敛失败都上抛（升级请求由平台的
    // 统一错误边界收口为 5xx，不产生假成功连接）；终态时现存实时连接
    // 在此一并收口（幂等，不依赖本次是否发生转换），随后拒绝新连接。
    const effective = await this.settleLifecycle(resolved.adjudication);
    if (effective.kind === "not_found") {
      return this.acceptRejectedConnection("ROOM_NOT_FOUND", "房间不存在");
    }
    if (effective.kind === "archived") {
      return this.acceptRejectedConnection("ROOM_ARCHIVED", "房间已归档");
    }

    switch (resolved.resolution.kind) {
      case "missing":
        // live 裁决下不可达（防御）：按不存在拒绝。
        return this.acceptRejectedConnection("ROOM_NOT_FOUND", "房间不存在");
      case "auth_failed":
        return this.acceptRejectedConnection("AUTH_FAILED", "成员身份无效，请重新入房");
      case "display":
        return this.acceptDisplayConnection();
      case "member":
        return this.acceptMemberConnection(resolved.resolution.memberId);
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
   *
   * 接纳顺序是正确性的关键：先在「新连接尚未计入注册表」的状态下做一次
   * 在线协调，把已观测到的离线差异（存储在线但已无连接，含掉线暂停与
   * 计时补写）落库，再注册新连接并做常规协调（首个连接使成员上线并
   * 取消空房计时，同时修复其他分叉）。若先注册再比较最终快照，故障期间
   * 的快速重连会让快照重新一致，吞掉已观测的掉线及其待补的暂停。
   *
   * 两次协调任一写入失败时，连接都不能被当成有效在线凭据：以 INTERNAL
   * 通知明确失败并关闭；存储恢复后重连即恢复（重连会重新协调并补齐暂停）。
   */
  private acceptMemberConnection(memberId: MemberId): Response {
    const [client, server] = Object.values(new WebSocketPair());

    // 前置协调：新连接未注册，注册表反映既有连接的真实在线集合。
    try {
      const pre = this.reconcilePresence();
      if (pre.changed && pre.state !== null && pre.meta !== null) {
        // 广播补齐的暂停/离线（此时新连接尚未注册，不在广播之列）。
        this.broadcastViews(pre.state, pre.meta);
      }
    } catch {
      // 无法确认在线状态：拒绝正常接入，不留有效在线连接；有界重试链
      // 保证存储恢复后状态补齐，客户端届时重连即可。
      this.logRealtimeInternalError("connect");
      this.schedulePresenceRetry();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ kind: "rejected" } satisfies WsAttachment);
      this.safeSend(server, noticeMessage("INTERNAL", "成员在线状态写入失败，请稍后重连"));
      this.safeClose(server, 1011, "presence write failed");
      return new Response(null, { status: 101, webSocket: client });
    }

    this.ctx.acceptWebSocket(server, [memberTag(memberId)]);
    server.serializeAttachment({ kind: "member", memberId } satisfies WsAttachment);

    try {
      const outcome = this.reconcilePresence();
      if (outcome.changed && outcome.state !== null && outcome.meta !== null) {
        // 广播覆盖含新连接在内的全部连接；新连接的初始视图即最新视图。
        this.broadcastViews(outcome.state, outcome.meta);
      } else {
        this.sendCurrentViewTo(server);
      }
    } catch {
      this.logRealtimeInternalError("connect");
      this.safeSend(server, noticeMessage("INTERNAL", "成员在线状态写入失败，请稍后重连"));
      this.safeClose(server, 1011, "presence write failed");
      return new Response(null, { status: 101, webSocket: client });
    }

    // 注册成功后成员在线：期望无 Alarm，清理空房期限的旧 Alarm（取消
    // 本次计时）。失败无害（旧 Alarm 触发时按当前状态重判自清），交由
    // 有界重试链兜底，不影响已被正确接纳的连接。
    void (async () => {
      try {
        await this.applyLifecycleAlarm(this.desiredLifecycleAlarmMs());
      } catch {
        this.logLifecycleInternalError("connect-alarm");
        this.schedulePresenceRetry();
      }
    })();
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 由连接注册表推导实际在线的成员集合。
   *
   * 注册表由运行时维护，休眠/实例重建后依然准确；这是在线状态的唯一
   * 权威来源，存储中的 online 标志只是它的持久投影。
   *
   * 只统计 readyState 为 OPEN 的连接：close 回调触发时连接可能仍处于
   * CLOSING/CLOSED 且仍被 getWebSockets 枚举（见 handleConnectionEnded），
   * 关闭中的连接已不可用，计为在线会吞掉掉线暂停与全员离开计时；同一
   * 身份其他 OPEN 页面仍使成员在线（多页面语义不变），展示与被拒连接
   * 从不计入。
   */
  private connectedMemberIds(): Set<string> {
    const ids = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = readAttachment(socket);
      if (attachment?.kind === "member") {
        ids.add(attachment.memberId);
      }
    }
    return ids;
  }

  /**
   * 在线协调的事务体：把存储的 online 标志对齐到实际连接，并同步计时
   * 与暂停语义。可独立提交，也可嵌入其他业务事务（命令处理、HTTP 入房）
   * 内联执行——嵌入时与所在业务单元同事务提交或回滚。
   *
   * 规则：
   * - 非 live（归档）房间直接跳过：成员、席位等操作期数据已清理，
   *   无法也不应按 live 状态装配/投影；终态连接收口触发的 close 回调
   *   到这里零写入返回，不制造无意义重试（清理后的房间无业务表，
   *   hasRoomSchema 分支同样零写入）。
   * - 存储在线但已无连接：视为离线（进行中房主/在席选手触发掉线暂停）；
   * - 存储离线但仍有连接（如上线写入曾失败后由其他事件补偿）：视为在线
   *   并取消空房计时；
   * - 全员离线且计时未记录时补写 last_member_left_at（覆盖全员离开瞬间
   *   恰遇短暂故障的场景）；
   * - 无分叉时不产生任何写入（重算幂等，不会重复离线/暂停）。
   */
  private reconcilePresenceInTransaction(): PresenceOutcome {
    if (!hasRoomSchema(this.sql)) return { changed: false, state: null, meta: null };
    ensureRoomSchema(this.sql);
    const meta = readRoomMeta(this.sql);
    if (meta === null) return { changed: false, state: null, meta: null };
    if (meta.lifecycle !== "live") return { changed: false, state: null, meta };
    const state = loadRoomState(this.sql);
    if (state === null) throw new Error("在线协调前状态装配失败");

    const connected = this.connectedMemberIds();
    let current = state;
    for (const member of state.members) {
      const actuallyOnline = connected.has(member.memberId);
      if (member.online === actuallyOnline) continue;
      const result = setMemberOnline(current, member.memberId, actuallyOnline);
      if (!result.ok) {
        // 防御：成员来自当前状态，MEMBER_NOT_FOUND/ROOM_ARCHIVED 不可达。
        continue;
      }
      current = result.state;
    }
    if (current === state) {
      return { changed: false, state, meta };
    }
    persistRoomStateChange(this.sql, state, current);

    let leftAt: string | null = meta.lastMemberLeftAt;
    if (current.members.some((member) => member.online)) {
      if (leftAt !== null) {
        setLastMemberLeftAt(this.sql, null);
        leftAt = null;
      }
    } else if (leftAt === null) {
      const now = new Date().toISOString();
      setLastMemberLeftAt(this.sql, now);
      leftAt = now;
    }
    return { changed: true, state: current, meta: { ...meta, lastMemberLeftAt: leftAt } };
  }

  /** 独立提交一次在线协调。 */
  private reconcilePresence(): PresenceOutcome {
    return this.ctx.storage.transactionSync((): PresenceOutcome =>
      this.reconcilePresenceInTransaction(),
    );
  }

  /**
   * 在线协调失败后的有界重试链：按固定退避序列重试「协调 + 生命周期
   * Alarm 收敛」，覆盖短暂存储故障；链结束（成功或用尽）后不再占用任何
   * timer，休眠行为不受影响，这不是常驻轮询。重试成功会把暂停/离线/
   * 全员离开时间与空房期限 Alarm 一次性补齐；重试链随实例驱逐丢失时，
   * 下一次连接/断开/命令/入房/读取事件的协调与裁决仍是最终防线
   * （Alarm 处理器只负责无人访问时的推进）。
   */
  private schedulePresenceRetry(): void {
    if (this.presenceRetryScheduled) return;
    this.presenceRetryScheduled = true;
    const delays = [...PRESENCE_RETRY_DELAYS_MS];
    const attempt = (): void => {
      void (async () => {
        try {
          const outcome = this.reconcilePresence();
          await this.applyLifecycleAlarm(this.desiredLifecycleAlarmMs());
          this.presenceRetryScheduled = false;
          if (outcome.changed && outcome.state !== null && outcome.meta !== null) {
            this.broadcastViews(outcome.state, outcome.meta);
          }
        } catch {
          const delay = delays.shift();
          if (delay === undefined) {
            this.presenceRetryScheduled = false;
            this.logRealtimeInternalError("presence-retry");
            return;
          }
          setTimeout(attempt, delay);
        }
      })();
    };
    setTimeout(attempt, delays.shift() ?? 250);
  }

  // ---- WebSocket：连接事件（Hibernation 回调） ----

  /**
   * 成员消息：解析为命令后进入统一处理管线。展示连接是只读通道，任何
   * 客户端消息都不被接受；二进制与超限消息按边界拒绝并关闭连接。
   * SQL 部分在 transactionSync 内同步执行；其后的生命周期收口（清理或
   * Alarm 应用）与消息发送在事务提交后进行，处理期间的失败由运行时
   * 收口，不会与其他事件交错产生半提交。
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
    await this.processMemberCommand(ws, attachment.memberId, command.data);
  }

  /**
   * 连接关闭：先幂等完成关闭回应（见 completeCloseHandshake），再做
   * 成员在线清理。不假设 runtime 按兼容日期自动完成 close 握手：线上
   * 观测（2026-10-05，preview）close 回调触发时被关闭连接 readyState 仍
   * 为 CLOSING、仍被 getWebSockets 枚举，客户端在应用未回应时收不到
   * 关闭事件；关闭回应与在线判定都不依赖注册表在回调时已移除连接。
   */
  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.completeCloseHandshake(ws, code);
    this.handleConnectionEnded(ws);
  }

  /**
   * 幂等、安全地完成关闭回应：对端发起的关闭需要一条关回帧才完成握手，
   * 本兼容日期不保证 runtime 自动代发（证据同上）。只回合法状态码——
   * 1000 或 3000–4999 原样回显，其余（1005/1006 等保留码、无状态码）
   * 回不带状态码的关闭帧，不直接复制对端 code；不回显对端 reason
   * （无需输出用户 reason，也避免超长 reason 触发新异常）。连接已
   * CLOSED、重复回调或平台拒绝重复关闭都安全跳过。成员、展示与被拒
   * 连接一视同仁，不产生任何存储或在线状态写入。
   */
  private completeCloseHandshake(ws: WebSocket, code: number): void {
    if (ws.readyState === WebSocket.CLOSED) return;
    try {
      if (code === 1000 || (code >= 3000 && code <= 4999)) {
        ws.close(code);
      } else {
        ws.close();
      }
    } catch {
      // 关闭已在途或平台拒绝重复关闭：不影响成员在线清理。
    }
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
   * 连接结束后的在线处理：运行时可能在回调期间仍枚举关闭中/已关闭的
   * 连接（线上观测：readyState=2 且 listed=true），因此在线判定只认
   * OPEN（connectedMemberIds），不假设回调时注册表已移除该连接；休眠
   * （实例驱逐但连接保留）不会触发本回调，因此不会把休眠当成掉线。
   *
   * 处理方式是整房在线协调（见 reconcilePresenceInTransaction）：以实际
   * 连接为权威，最后一个连接离开才使成员下线（含掉线暂停与计时补写），
   * 同时修复任何历史分叉。协调成功后按新的持久状态收敛生命周期 Alarm
   * （全员离开写入空房期限，成员在线则清除旧期限）；任一失败不丢弃
   * 事件：启动有界重试链补偿，且任何后续业务命令在执行前都会再次协调，
   * 无法确认时拒绝推进。
   */
  private handleConnectionEnded(ws: WebSocket): void {
    const attachment = readAttachment(ws);
    if (attachment?.kind !== "member") return;

    void (async () => {
      try {
        const outcome = this.reconcilePresence();
        await this.applyLifecycleAlarm(this.desiredLifecycleAlarmMs());
        if (outcome.changed && outcome.state !== null && outcome.meta !== null) {
          this.broadcastViews(outcome.state, outcome.meta);
        }
      } catch {
        this.logRealtimeInternalError("close");
        this.schedulePresenceRetry();
      }
    })();
  }

  // ---- 命令处理管线 ----

  /**
   * 统一命令处理：生命周期裁决 → 读取当前状态 → 回执去重 → 规则版本门
   * → 在线协调 → applyRoomCommand → 按变化持久化 → 写回执，整体在一个
   * transactionSync 闭包内原子提交；写成功后才发送 commandResult 与广播
   * （失败不广播、不回执）。裁决在命令之前：到期房间先完成归档或清理，
   * 归档房间拒绝一切写操作（命令不能推进、也不能清掉已过期期限）。
   *
   * - 操作者来自连接附件；角色/席位/轮次/状态/版本每次从当前持久状态
   *   重新判断，名单来自该房间的持久目录快照（不读全局当前目录）。
   * - 房间持久 ruleVersion 不受当前引擎支持时拒绝执行（不能拿当前语义
   *   解释未知版本的已保存状态）；归档裁决先于版本门（生命周期不受
   *   规则版本影响）。
   * - 执行前先做在线协调：以实际连接为权威修复存储中的陈旧在线标志
   *   （如断线写入曾失败留下的幽灵在线），协调与命令同事务；协调写入
   *   失败（存储故障未恢复）时整个事务回滚，命令以 INTERNAL 拒绝，
   *   不基于无法确认的在线状态判权或推进。回执去重命中时不执行命令，
   *   不触发协调写入。
   * - 同一 operationId 且同一规范化载荷：返回原回执结果，不再执行；
   *   同 ID 不同载荷以 OPERATION_ID_CONFLICT 拒绝。回执与状态更新同
   *   事务，SQL 故障时一起回滚，重试不受已回滚回执影响。
   * - executed 结果不做 Alarm 收敛：命令必然来自在线成员连接，期望
   *   Alarm 恒为 null（在线协调已在同事务内取消计时），无需额外写。
   */
  private async processMemberCommand(
    ws: WebSocket,
    memberId: MemberId,
    command: RoomCommand,
  ): Promise<void> {
    const payloadJson = canonicalCommandJson(command);
    let outcome: CommandOutcome;
    let adjudication: LifecycleAdjudication;
    try {
      const transactionResult = this.ctx.storage.transactionSync(
        (): {
          outcome: CommandOutcome;
          adjudication: LifecycleAdjudication;
        } => {
          if (!hasRoomSchema(this.sql)) {
            return {
              outcome: { kind: "not_found" } as const,
              adjudication: { kind: "not_found", alarm: null } as const,
            };
          }
          ensureRoomSchema(this.sql);
          const meta = readRoomMeta(this.sql);
          if (meta === null) {
            return {
              outcome: { kind: "not_found" } as const,
              adjudication: { kind: "not_found", alarm: null } as const,
            };
          }
          const adjudication = this.adjudicateLifecycleInTransaction(this.connectedMemberIds());
          if (adjudication.kind === "cleanup") {
            return { outcome: { kind: "room_cleanup" } as const, adjudication };
          }
          if (adjudication.kind === "archived") {
            const versions = readRoomVersionInfo(this.sql);
            if (versions === null) throw new Error("命令处理前房间元信息缺失");
            return {
              outcome: { kind: "archived", versions } as const,
              adjudication,
            };
          }
          if (meta.ruleVersion !== BP_RULE_VERSION) {
            const versions = readRoomVersionInfo(this.sql);
            if (versions === null) throw new Error("命令处理前房间元信息缺失");
            return {
              outcome: { kind: "unsupported_rule_version", versions } as const,
              adjudication,
            };
          }

          const existing = findCommandReceipt(this.sql, memberId, command.operationId);
          if (existing !== null) {
            if (existing.payloadJson !== payloadJson) {
              const versions = readRoomVersionInfo(this.sql);
              if (versions === null) throw new Error("命令回执冲突检查前房间元信息缺失");
              return { outcome: { kind: "conflict", versions } as const, adjudication };
            }
            return {
              outcome: { kind: "replayed", receipt: existing.receipt } as const,
              adjudication,
            };
          }

          // 在线协调：以实际连接为权威，修复后命令基于确认过的在线状态执行。
          const presence = this.reconcilePresenceInTransaction();
          const state = presence.state;
          if (state === null) throw new Error("命令处理前状态装配失败");
          const catalogData = loadRoomCatalog(this.sql);
          if (catalogData === null) throw new Error("房间目录快照缺失");

          const applied = applyRoomCommand(
            state,
            { memberId },
            command,
            toAgentCatalog(catalogData),
          );
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
            outcome: {
              kind: "executed",
              changed: after !== state || presence.changed,
              ok: applied.ok,
              error: applied.ok ? null : applied.error,
              after,
              meta: presence.meta ?? meta,
            } as const,
            adjudication,
          };
        },
      );
      outcome = transactionResult.outcome;
      adjudication = transactionResult.adjudication;
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
      case "room_cleanup": {
        // 空房到期且无有效记录：事务外原子清理；收口内含终态连接收口
        // （ROOM_NOT_FOUND + 1008，含本连接），无需重复通知。
        await this.settleLifecycle(adjudication);
        return;
      }
      case "archived": {
        // Alarm 收敛失败会上抛（webSocketMessage 由运行时收口），不发送
        // 假归档回执；成功后经 beforeConclude 先回执挂起命令，再对全部
        // 现存实时通道（含本连接）按终态通知并关闭——无论归档是本次
        // 转换还是早已成立（防御路径），收口幂等一致。
        await this.settleLifecycle(adjudication, {
          beforeConclude: () => {
            this.sendCommandResult(ws, command.operationId, {
              ok: false,
              error: { code: "ROOM_ARCHIVED", message: "房间已归档，拒绝一切写操作" },
              versions: outcome.versions,
            });
          },
        });
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
