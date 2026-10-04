import { ref, shallowRef } from "vue";
import { roomCommandSchema, type RoomCommand } from "../../shared/commands";
import type { HostManagementView, RoomMemberView } from "../../shared/contracts/views";
import {
  memberServerMessageSchema,
  type CommandResultMessage,
} from "../../shared/contracts/websocket";
import {
  CONNECTION_LOST,
  IDENTITY_CHANGED,
  UNKNOWN_OUTCOME,
  roomClientErrorText,
  type RoomClientErrorCode,
} from "./command-errors";

/**
 * 常规成员 WebSocket 客户端会话（PR7 恢复收口）。
 *
 * 职责与边界（docs/architecture.md「WebSocket 通道」）：
 * - 同源真实 WebSocket，服务端消息全部经共享 schema 校验后才进入状态；
 * - HTTP 入口取得的成员视图作为初值，WS 视图按公开 revision 单调覆盖：
 *   revision 落后的视图不覆盖新视图（也不作为本连接的同步依据），
 *   commandResult 不回写视图，视图只由 memberView/hostView 消息推进；
 * - 「已连接」以本连接首个合法权威视图为同步点：单纯 WebSocket open
 *   不放行操作与动效，每次尝试有覆盖握手与首帧的期限，期限内无有效
 *   首帧按失败收口；退避失败计数只在真正取得同步后清零，避免反复
 *   open-即断的空转把失败计数伪装成恢复；
 * - 每条命令生成唯一 operationId，携带发送时视图的 expectedBpVersion
 *   （setTeamName 另带 expectedRevision），序列化为确切字节后发送；
 *   同 scope 挂起期间拒绝新命令（防盲目重复由会话层兜底）；
 * - 结果未知（回执超时或连接中断）的命令转入「核对中」：保留原
 *   operationId 与原载荷字节，重新同步后按协议重发，由服务端持久化
 *   去重回执对同载荷幂等返回原结果。核对重发收到的失败回执不能证明
 *   原命令失败（可能是本次核对执行的新拒绝——原命令可能已生效且其
 *   回执已越出保留窗口，也可能是核对处理的技术故障，客户端无法与
 *   原回执的幂等重放区分），统一按「结果未知」诚实反馈，不伪造成功
 *   或失败；用户以最新状态重新操作，若同样的条件仍在，新命令的首发
 *   错误会给出准确原因。首发的失败回执仍是原操作的明确结论，按对应
 *   错误结算。回执超时会主动断开当前连接（半开连接检测），恢复后
 *   统一走核对路径；
 * - 挂起命令绑定发送时的成员 ID（权威视图 self.memberId，非秘密）：
 *   视图携带的身份变化（如凭据被换、以新成员重新入房，不经
 *   AUTH_FAILED）时，旧身份的待核对命令按「身份已变化、原结果未知」
 *   明确放弃，绝不以新身份重发；同一 memberId 的席位/角色变化不构成
 *   身份变化。HTTP 初值与每代连接的首个视图都经此边界；放弃同时设置
 *   任何角色可见的通用身份提示（逐 scope 错误可能处于新身份不可见的
 *   面板），由用户发送新命令或会话结束清除；
 * - 「结果未知 / 身份已变化」是原操作的结论，不随操作位推进清理
 *   （旧回合的普通失败仍按需清理）：结论必须实际可见，避免把身份
 *   放弃或未知结果伪装成无提示的成功；
 * - 断线保留最后确认画面（view 不清除），状态进入 reconnecting/
 *   interrupted，调用方据此停动效并禁用一切服务器操作；本地搜索、
 *   筛选与布局不受连接状态影响；退避自动重连，身份按当前房主/席位
 *   由服务端视图恢复，绝不自动 resume BP；
 * - AUTH_FAILED 明确结束原身份会话：终止重连与核对重发，页面回首次
 *   入房流程（凭据仅经 HttpOnly Cookie 由浏览器携带，会话不读取身份
 *   秘密，也不以昵称推断身份）；ROOM_NOT_FOUND 与 ROOM_ARCHIVED 同为
 *   终态但分开表达：前者按不存在收口，后者由页面沿原房间链接转入
 *   只读记录（归档不是消失，不能误报「不存在或已过期」）；
 * - 组件卸载必须调用 stop()：清理重连、首帧与回执计时器，挂起命令
 *   视为放弃且不落任何存储；刷新后按服务器当前状态恢复，不猜测重放。
 */

/** 会话状态。auth-failed/room-gone/room-archived/stopped 为终态，不再自动重连。 */
export type RoomSessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "interrupted"
  | "auth-failed"
  | "room-gone"
  | "room-archived"
  | "stopped";

/** 房间视图联合：普通成员视图或房主管理视图（后者是其超集）。 */
export type RoomView = RoomMemberView | HostManagementView;

/** 房主管理视图判别：仅房主连接收到含成员列表的视图。 */
export function isHostManagementView(view: RoomView): view is HostManagementView {
  return "members" in view;
}

/** 传输层最小接口：浏览器 WebSocket 由默认工厂包装，测试注入假实现。 */
export interface RoomSocket {
  send(text: string): void;
  close(): void;
}

/** 会话需要的 socket 事件挂载点。 */
export interface RoomSocketHandle {
  readonly socket: RoomSocket;
  onOpen(listener: () => void): void;
  onMessage(listener: (data: unknown) => void): void;
  onClose(listener: () => void): void;
  onError(listener: () => void): void;
}

export type RoomSocketOpener = (url: string) => RoomSocketHandle;

/** 命令输入：不带协议公共字段，由会话统一补齐。 */
export type RoomCommandInput = DistributiveOmit<
  RoomCommand,
  "operationId" | "expectedBpVersion" | "expectedRevision"
>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 挂起命令的核对阶段：决定界面提示与恢复后的处理方式。 */
export type PendingCommandPhase = "inflight" | "checking";

/**
 * 一条已发送、尚未得到权威结论的命令。
 *
 * `payloadJson` 是发送的确切字节：核对重发复用同一 operationId 与同一
 * 载荷（含发送时的 expectedBpVersion/expectedRevision），不为网络重试
 * 生成新 ID 或修改载荷。`memberId` 是发送时的成员身份（非秘密 ID，
 * 来自权威视图 self）：会话身份变化后旧命令绝不以新身份重发。
 */
export interface PendingRoomCommand {
  readonly operationId: string;
  readonly command: RoomCommand;
  /** 已发送的序列化字节；核对重发原样复用。 */
  readonly payloadJson: string;
  readonly scope: string;
  /** 发送时的成员 ID；身份变化（视图 self.memberId 不同）后不再重发。 */
  readonly memberId: string;
  /** inflight：本次连接首发、等待回执；checking：结果未知、待同步后重发核对。 */
  readonly phase: PendingCommandPhase;
  /** 是否已按核对路径重发过：其后的失败回执不能证明原命令失败。 */
  readonly wasResent: boolean;
}

/** 面向用户展示的错误：稳定码 + 中文文案。 */
export interface RoomClientError {
  readonly code: RoomClientErrorCode;
  readonly text: string;
}

const RECONNECT_BASE_DELAY_MS = 600;
const RECONNECT_MAX_DELAY_MS = 10_000;
/** 连续失败达到该次数后界面显示「连接中断」，但仍按上限间隔持续重试。 */
const INTERRUPTED_AFTER_FAILURES = 2;
/** 单次连接尝试期限：覆盖握手与首个合法视图；到期按失败计并退避重试。 */
const SYNC_TIMEOUT_MS = 8_000;
/** 单条命令的回执期限；到期转「核对中」并主动断开，恢复后同 ID 重发核对。 */
const RESULT_TIMEOUT_MS = 10_000;

function defaultOperationId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 浏览器默认传输：包装同源 WebSocket 为会话所需的最小事件接口。 */
export function browserWebSocketOpener(url: string): RoomSocketHandle {
  const socket = new WebSocket(url);
  return {
    socket: {
      send: (text) => socket.send(text),
      close: () => socket.close(),
    },
    onOpen: (listener) => socket.addEventListener("open", () => listener()),
    onMessage: (listener) =>
      socket.addEventListener("message", (event) => listener((event as MessageEvent).data)),
    onClose: (listener) => socket.addEventListener("close", () => listener()),
    onError: (listener) => socket.addEventListener("error", () => listener()),
  };
}

/** 会话配置。 */
export interface RoomSessionOptions {
  /** 完整的成员 WS 地址（含 ws/wss 协议与路径）。 */
  readonly url: string;
  /** HTTP 入口取得的成员视图；无身份时省略。 */
  readonly initialView?: RoomView;
  readonly openSocket?: RoomSocketOpener;
  readonly generateOperationId?: () => string;
  readonly onError?: (message: string) => void;
}

/**
 * 房间会话。用 stop() 结束生命周期；组件卸载时必须调用，避免泄漏重连、
 * 首帧与回执计时器。
 */
export class RoomSession {
  readonly status = ref<RoomSessionStatus>("idle");
  readonly view = shallowRef<RoomView | null>(null);
  /** 已发送未得到权威结论的命令（按 operationId）；UI 据此防重复提交。 */
  readonly pending = shallowRef<ReadonlyMap<string, PendingRoomCommand>>(new Map());
  /** 各操作区域的最近一次失败提示；成功或重发时清除。 */
  readonly scopeErrors = shallowRef<Readonly<Record<string, RoomClientError>>>({});
  /** 连接层全局提示（如服务端连接通知），随最新视图清除。 */
  readonly globalNotice = shallowRef<string | null>(null);
  /**
   * 身份变化提示：旧身份挂起命令被放弃时的通用结论（不暴露旧命令
   * 内容），任何角色都可见；用户发送新命令或会话结束时清除，不随
   * 视图推进清掉。
   */
  readonly identityNotice = shallowRef<string | null>(null);

  private readonly url: string;
  private readonly openSocket: RoomSocketOpener;
  private readonly generateOperationId: () => string;
  private readonly reportError: (message: string) => void;
  private appliedRevision = -1;
  private started = false;
  private manualStop = false;
  private handle: RoomSocketHandle | null = null;
  /** 当前连接是否已取得合法权威视图：操作与动效的放行条件。 */
  private synced = false;
  /**
   * 当前会话绑定的成员身份（权威视图 self.memberId，非秘密 ID）。
   * 挂起命令按发送时的身份绑定；身份变化（如凭据被换、以新成员重新
   * 入房，不经 AUTH_FAILED）时旧命令被明确放弃，绝不以新身份重发。
   */
  private identityMemberId: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly resultTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: RoomSessionOptions) {
    this.url = options.url;
    this.openSocket = options.openSocket ?? browserWebSocketOpener;
    this.generateOperationId = options.generateOperationId ?? defaultOperationId;
    this.reportError = options.onError ?? ((message) => console.error(message));
    if (options.initialView !== undefined) {
      this.view.value = options.initialView;
      this.appliedRevision = options.initialView.revision;
      // HTTP 初值即身份边界：后续挂起命令绑定该成员 ID。
      this.identityMemberId = options.initialView.self.memberId;
    }
  }

  /** 开始连接；重复调用无效果。 */
  connect(): void {
    if (this.started) return;
    this.started = true;
    this.manualStop = false;
    this.status.value = "connecting";
    this.openCurrentSocket();
  }

  /** 终止会话：关闭连接并停止一切计时器；挂起命令视为放弃（视图保留）。 */
  stop(): void {
    this.started = false;
    this.manualStop = true;
    this.clearReconnectTimer();
    this.clearSyncTimer();
    this.clearAllResultTimers();
    if (this.handle !== null) {
      this.handle.socket.close();
      this.handle = null;
    }
    this.synced = false;
    this.status.value = "stopped";
    this.pending.value = new Map();
    this.identityNotice.value = null;
  }

  /** 是否有指定区域的命令尚未得到权威结论。 */
  isScopePending(scope: string): boolean {
    for (const entry of this.pending.value.values()) {
      if (entry.scope === scope) return true;
    }
    return false;
  }

  /** 指定区域是否有命令处于「结果未知、正在核对」阶段。 */
  isScopeChecking(scope: string): boolean {
    for (const entry of this.pending.value.values()) {
      if (entry.scope === scope && entry.phase === "checking") return true;
    }
    return false;
  }

  /** 指定区域最近一次失败提示；无失败为 null。 */
  scopeError(scope: string): RoomClientError | null {
    return this.scopeErrors.value[scope] ?? null;
  }

  /** 手动清除某区域的失败提示（如用户开始修改输入）。 */
  clearScopeError(scope: string): void {
    if (this.scopeErrors.value[scope] === undefined) return;
    const next = { ...this.scopeErrors.value };
    delete next[scope];
    this.scopeErrors.value = next;
  }

  /**
   * 发送业务命令：补齐唯一 operationId 与 expectedBpVersion（setTeamName
   * 另补 expectedRevision），经共享 schema 校验后序列化发送。
   * 未同步、尚无视图或同 scope 已有命令在途（含核对中）时不发送——同一
   * 操作区域的防重复由会话层兜底，调用方同时按 pending 状态禁用入口；
   * 跨 scope 的互斥（如预选与确认）由调用方的派发入口约束。
   */
  sendCommand(input: RoomCommandInput): { readonly sent: boolean } {
    const view = this.view.value;
    if (
      !this.started ||
      this.status.value !== "connected" ||
      view === null ||
      this.handle === null
    ) {
      return { sent: false };
    }
    // 同 scope 已有命令在途或待核对时直接拒绝（不消耗 operationId）。
    const scope = scopeOfCommand(input);
    if (this.isScopePending(scope)) {
      return { sent: false };
    }
    const operationId = this.generateOperationId();
    const command: RoomCommand = {
      ...input,
      operationId,
      expectedBpVersion: view.bpVersion,
      ...(input.type === "setTeamName" ? { expectedRevision: view.revision } : {}),
    } as RoomCommand;
    const validated = roomCommandSchema.safeParse(command);
    if (!validated.success) {
      this.reportError(`命令不符合共享 schema：${input.type}`);
      return { sent: false };
    }
    const payloadJson = JSON.stringify(validated.data);
    // 用户以当前身份发起新操作：身份变化提示完成使命（原操作已按
    // 「结果未知」结论结算并保持可见至此）。
    this.identityNotice.value = null;
    const entry: PendingRoomCommand = {
      operationId,
      command: validated.data,
      payloadJson,
      scope,
      memberId: view.self.memberId,
      phase: "inflight",
      wasResent: false,
    };
    const pending = new Map(this.pending.value);
    pending.set(operationId, entry);
    this.pending.value = pending;
    this.clearScopeError(entry.scope);
    try {
      this.handle.socket.send(payloadJson);
    } catch {
      // 同步发送失败：命令确定未离开本机，按连接中断失败收敛。
      this.resolvePending(operationId, { ok: false, code: CONNECTION_LOST });
      return { sent: false };
    }
    this.armResultTimer(operationId);
    return { sent: true };
  }

  // ---- 内部状态机 ----

  private openCurrentSocket(): void {
    if (!this.started) return;
    let handle: RoomSocketHandle;
    try {
      handle = this.openSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.handle = handle;
    this.armSyncTimer(handle);
    handle.onMessage((data) => {
      if (!this.started || this.handle !== handle) return;
      this.handleSocketMessage(data);
    });
    handle.onClose(() => {
      // 旧连接的迟到事件被 handle 守卫隔离；当前连接关闭走统一重连路径。
      // open 本身不改变状态：连接可用性以首个合法视图为同步点。
      if (this.handle !== handle) return;
      this.handle = null;
      this.scheduleReconnect();
    });
    handle.onError(() => {
      // error 之后必有 close；统一在 close 处理，避免双重退避。
    });
  }

  /**
   * 主动结束当前连接尝试并进入退避重连。
   *
   * 先摘除 handle 再关闭：close 事件（可能迟到或不达）被 handle 守卫
   * 忽略，重连只从这里调度一次，半开连接不会留下悬挂的等待。
   */
  private failCurrentConnection(): void {
    const handle = this.handle;
    this.handle = null;
    if (handle !== null) {
      handle.socket.close();
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.started || this.manualStop) return;
    if (
      this.status.value === "auth-failed" ||
      this.status.value === "room-gone" ||
      this.status.value === "room-archived" ||
      this.status.value === "stopped"
    ) {
      return;
    }
    this.clearSyncTimer();
    this.synced = false;
    // 在途命令结果未知：转入核对态，待重新同步后按原 ID 原载荷重发核对。
    this.markInflightAsChecking();
    this.reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    this.status.value =
      this.reconnectAttempts >= INTERRUPTED_AFTER_FAILURES ? "interrupted" : "reconnecting";
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.started || this.manualStop) return;
      this.status.value = "reconnecting";
      this.openCurrentSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private armSyncTimer(handle: RoomSocketHandle): void {
    this.clearSyncTimer();
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (this.handle !== handle || this.synced) return;
      // 期限内未取得合法首帧（握手失败、open 后立即被服务端关闭、无有效
      // 视图）：按一次失败收口并退避重试。
      this.failCurrentConnection();
    }, SYNC_TIMEOUT_MS);
  }

  private clearSyncTimer(): void {
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private handleSocketMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.reportError("服务端消息不是合法 JSON");
      return;
    }
    const message = memberServerMessageSchema.safeParse(parsed);
    if (!message.success) {
      // 不符合合同的消息不进入状态，也绝不覆盖已有视图。
      this.reportError("服务端消息不符合共享 schema");
      return;
    }
    const payload = message.data;
    switch (payload.kind) {
      case "memberView":
        this.applyView(payload.view);
        break;
      case "hostView":
        this.applyView(payload.view);
        break;
      case "commandResult":
        this.applyCommandResult(payload);
        break;
      case "notice":
        this.applyNotice(payload.code, payload.message);
        break;
    }
  }

  private applyView(view: RoomView): void {
    // revision 单调门：落后视图（含等价旧重放）不覆盖已应用的更新视图，
    // 也不能作为本连接的同步依据。
    if (view.revision < this.appliedRevision) return;
    // 身份边界先于核对重发：旧身份的挂起命令在进入新身份流程前被放弃。
    this.abandonPendingOnIdentityChange(view.self.memberId);
    const previous = this.view.value;
    this.view.value = view;
    this.appliedRevision = view.revision;
    this.globalNotice.value = null;
    // 操作位推进后，针对旧操作位的普通失败提示不再适用；但「结果未知 /
    // 身份已变化」这类原操作结论必须实际可见，由用户开始新的相关操作
    // 或会话结束时结算，不能被视图推进悄悄清掉（否则身份放弃会被伪装
    // 成无提示的成功）。
    if (previous !== null && previous.currentSlotId !== view.currentSlotId) {
      this.clearSlotErrorUnlessConclusion("setPreselect");
      this.clearSlotErrorUnlessConclusion("clearPreselect");
      this.clearSlotErrorUnlessConclusion("confirmPreselect");
    }
    this.markSynced();
  }

  /**
   * 原操作结论类本地错误码：语义是「上一个命令的最终/当前结论」，
   * 不随操作位推进清理。
   */
  private isDurableConclusion(code: RoomClientErrorCode): boolean {
    return code === IDENTITY_CHANGED || code === UNKNOWN_OUTCOME;
  }

  /** 清理旧操作位的普通失败提示；原操作结论（未知/身份变化）保留。 */
  private clearSlotErrorUnlessConclusion(scope: string): void {
    const error = this.scopeErrors.value[scope];
    if (error === undefined || this.isDurableConclusion(error.code)) return;
    this.clearScopeError(scope);
  }

  /**
   * 身份边界：挂起命令绑定发送时的成员 ID。
   *
   * 视图携带的身份变化（浏览器凭据被更换后以新成员重新入房等，此时
   * 服务端直接返回新身份的有效视图，不经 AUTH_FAILED）时，旧身份的
   * 待核对命令绝不能以新身份重发——按「身份已变化、原结果未知」明确
   * 放弃（诚实收敛，不伪成功）；同一 memberId 的席位/角色变化不构成
   * 身份变化，照常核对。每份视图（含 HTTP 初值、每代连接的首个视图）
   * 都经此边界。
   *
   * 放弃同时设置通用身份提示：被放弃的可能是不对新身份可见的操作
   * （如旧身份是房主的 setTeamName/assignSeat，新身份是观众），逐
   * scope 错误可能没有可见出口，由这条不暴露旧命令内容的提示承接；
   * 用户发送任一新命令（以新身份继续操作）或会话结束时清除。
   */
  private abandonPendingOnIdentityChange(memberId: string): void {
    if (this.identityMemberId === null) {
      // 尚无绑定（无 HTTP 初值的会话）：首份视图绑定身份，无挂起可放弃。
      this.identityMemberId = memberId;
      return;
    }
    if (this.identityMemberId === memberId) return;
    const stale = [...this.pending.value.values()].filter((entry) => entry.memberId !== memberId);
    for (const entry of stale) {
      this.resolvePending(entry.operationId, { ok: false, code: IDENTITY_CHANGED });
    }
    this.identityMemberId = memberId;
    if (stale.length > 0) {
      this.identityNotice.value = roomClientErrorText(IDENTITY_CHANGED);
    }
  }

  /** 本连接取得首个合法权威视图：开放操作与动效，并核对遗留待定命令。 */
  private markSynced(): void {
    if (this.synced) return;
    this.synced = true;
    this.clearSyncTimer();
    // 退避计数只在真正取得同步后清零：open 本身不代表已同步。
    this.reconnectAttempts = 0;
    this.status.value = "connected";
    this.resendChecking();
  }

  private applyCommandResult(result: CommandResultMessage): void {
    const entry = this.pending.value.get(result.operationId);
    if (entry === undefined) return;
    if (result.ok) {
      this.resolvePending(result.operationId, { ok: true });
      return;
    }
    // schema 已保证失败结果携带稳定错误码。
    const code = result.error?.code ?? "INTERNAL";
    if (entry.wasResent) {
      // 核对重发收到的失败回执不能证明原命令失败：它可能是本次核对
      // 执行的新拒绝——原命令可能早已生效且其回执已越出每房间的保留
      // 窗口（规则在版本门前先判权限与状态，如 NOT_CURRENT_PLAYER、
      // BP_NOT_RUNNING、SEAT_TARGET_OFFLINE），也可能是核对处理本身的
      // 技术故障（INTERNAL：本次事务回滚，原命令成败未知）——还可能
      // 是原失败回执的幂等重放（客户端无法区分重放与新执行）。统一按
      // 「结果未知」诚实收敛，不伪造成功或失败；用户以最新状态重新
      // 操作，若同样的条件仍在，新命令的首发错误会给出准确原因。
      this.resolvePending(result.operationId, { ok: false, code: UNKNOWN_OUTCOME });
      return;
    }
    // 首发的失败回执是原操作的明确结论：按对应错误结算，用户以最新
    // 状态生成新 operationId 重试。
    this.resolvePending(result.operationId, { ok: false, code });
  }

  private applyNotice(code: string, message: string): void {
    switch (code) {
      case "AUTH_FAILED":
        // 原身份会话明确结束：终止重连与核对重发；挂起命令保持原样
        // （绝不能以新身份重发），页面回首次入房流程，随组件销毁清理。
        this.terminateSession("auth-failed");
        return;
      case "ROOM_NOT_FOUND":
        this.terminateSession("room-gone");
        return;
      case "ROOM_ARCHIVED":
        // 房间归档：终止实时会话，页面沿原房间链接转入只读记录。
        this.terminateSession("room-archived");
        return;
      case "INTERNAL":
        this.globalNotice.value = "服务器连接异常，正在重试";
        return;
      case "INVALID_MESSAGE":
        this.globalNotice.value = "上一条消息不符合协议，已忽略";
        return;
      default:
        this.reportError(`未知连接通知：${code} ${message}`);
    }
  }

  /** 进入终态：停止一切计时器与连接，不再重连、不再重发核对命令。 */
  private terminateSession(status: RoomSessionStatus): void {
    this.clearReconnectTimer();
    this.clearSyncTimer();
    this.clearAllResultTimers();
    const handle = this.handle;
    this.handle = null;
    this.synced = false;
    if (handle !== null) {
      handle.socket.close();
    }
    this.status.value = status;
  }

  private resolvePending(
    operationId: string,
    outcome: { readonly ok: true } | { readonly ok: false; readonly code: RoomClientErrorCode },
  ): void {
    const entry = this.pending.value.get(operationId);
    if (entry === undefined) return;
    this.clearResultTimer(operationId);
    const pending = new Map(this.pending.value);
    pending.delete(operationId);
    this.pending.value = pending;
    if (!outcome.ok) {
      this.scopeErrors.value = {
        ...this.scopeErrors.value,
        [entry.scope]: { code: outcome.code, text: roomClientErrorText(outcome.code) },
      };
    } else {
      this.clearScopeError(entry.scope);
    }
  }

  private updateEntry(operationId: string, patch: Partial<PendingRoomCommand>): void {
    const entry = this.pending.value.get(operationId);
    if (entry === undefined) return;
    const pending = new Map(this.pending.value);
    pending.set(operationId, { ...entry, ...patch });
    this.pending.value = pending;
  }

  private markInflightAsChecking(): void {
    let changed = false;
    const next = new Map(this.pending.value);
    for (const [operationId, entry] of next) {
      if (entry.phase === "inflight") {
        next.set(operationId, { ...entry, phase: "checking" });
        changed = true;
      }
    }
    if (changed) this.pending.value = next;
  }

  private armResultTimer(operationId: string): void {
    this.clearResultTimer(operationId);
    this.resultTimers.set(
      operationId,
      setTimeout(() => {
        this.resultTimers.delete(operationId);
        const entry = this.pending.value.get(operationId);
        if (entry === undefined) return;
        // 回执超时：结果未知，转「核对中」；当前连接已不可信（半开或
        // 服务端无响应），主动断开，重新同步后按原 ID 原载荷重发核对。
        this.updateEntry(operationId, { phase: "checking" });
        if (this.handle !== null) this.failCurrentConnection();
      }, RESULT_TIMEOUT_MS),
    );
  }

  private clearResultTimer(operationId: string): void {
    const timer = this.resultTimers.get(operationId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.resultTimers.delete(operationId);
    }
  }

  private clearAllResultTimers(): void {
    for (const timer of this.resultTimers.values()) clearTimeout(timer);
    this.resultTimers.clear();
  }

  /**
   * 重新同步后核对遗留命令：同 operationId + 原载荷字节重发，且只重发
   * 绑定当前成员身份的命令（身份变化已在 applyView 中放弃旧命令，此处
   * 再按身份过滤兜底）。服务端持久化去重回执对同载荷幂等返回原结果；
   * 回执窗口外的重发按新命令执行，其中任何失败回执都不能证明原命令
   * 失败，在 applyCommandResult 中统一按「结果未知」收敛。
   */
  private resendChecking(): void {
    if (!this.started || this.status.value !== "connected" || this.handle === null) return;
    const identity = this.view.value?.self.memberId ?? null;
    const entries = [...this.pending.value.values()];
    for (const entry of entries) {
      if (entry.phase !== "checking") continue;
      // 旧身份的待核对命令绝不以新身份重发。
      if (identity !== null && entry.memberId !== identity) continue;
      // 先标记 wasResent 再发送：随后到达的回执按核对路径结算。
      this.updateEntry(entry.operationId, { wasResent: true });
      this.armResultTimer(entry.operationId);
      try {
        this.handle.socket.send(entry.payloadJson);
      } catch {
        // 刚同步即发送失败：连接已不可用，走统一失败路径，下次同步再核对。
        this.failCurrentConnection();
        return;
      }
    }
  }
}

/**
 * 命令的操作区域标识：同一区域的 pending/错误互斥展示。
 * 接受命令输入或补齐协议字段后的完整命令（判别字段相同）。
 */
export function scopeOfCommand(command: RoomCommandInput | RoomCommand): string {
  switch (command.type) {
    case "setTeamName":
      return `setTeamName:${command.team}`;
    case "assignSeat":
      return `assignSeat:${command.team}`;
    default:
      return command.type;
  }
}
