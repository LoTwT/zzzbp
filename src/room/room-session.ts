import { ref, shallowRef } from "vue";
import { roomCommandSchema, type RoomCommand } from "../../shared/commands";
import type { HostManagementView, RoomMemberView } from "../../shared/contracts/views";
import {
  memberServerMessageSchema,
  type CommandResultMessage,
} from "../../shared/contracts/websocket";
import {
  CONNECTION_LOST,
  UNKNOWN_OUTCOME,
  roomClientErrorText,
  type RoomClientErrorCode,
} from "./command-errors";

/**
 * 常规成员 WebSocket 客户端会话。
 *
 * 职责与边界（docs/specs/implementation-plan.md PR6，完整恢复场景归 PR7）：
 * - 同源真实 WebSocket，服务端消息全部经共享 schema 校验后才进入状态；
 * - HTTP 入口取得的成员视图作为初值，WS 视图按公开 revision 单调覆盖：
 *   revision 落后的视图不覆盖新视图，commandResult 也不回写视图（旧回执
 *   版本不会把视图回退，视图只由 memberView/hostView 消息推进）；
 * - 每条命令生成唯一 operationId，携带发送时视图的 expectedBpVersion
 *   （setTeamName 另带 expectedRevision）；防重复提交由调用方按 pending
 *   状态禁用入口实现；
 * - 断线保留最后确认画面（view 不清除），状态进入 reconnecting/
 *   interrupted，调用方据此停动效并禁用一切服务器操作；基础重连按
 *   退避持续尝试，身份失效（AUTH_FAILED）与房间消失（ROOM_NOT_FOUND/
 *   ROOM_ARCHIVED）终止重试并交由页面切换形态；
 * - 连接换新后收到的第一份新视图会核对遗留 pending 命令：效果可在权威
 *   视图中确认的按成功收敛，否则按「结果未知」失败收敛并提示用户按当前
 *   界面重新操作（不自动重发；结果未知的同 operationId 重发收口在 PR7）。
 */

/** 会话状态。auth-failed/room-gone/stopped 为终态，不再自动重连。 */
export type RoomSessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "interrupted"
  | "auth-failed"
  | "room-gone"
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

/** 命令发送时的视图快照：断线后核对效果使用。 */
interface CommandSnapshot {
  readonly bpVersion: number;
  readonly status: RoomView["bpStatus"];
  readonly submissionsLength: number;
}

/** 一条已发送、尚未收到回执的命令。 */
export interface PendingRoomCommand {
  readonly operationId: string;
  readonly command: RoomCommand;
  readonly scope: string;
  readonly snapshot: CommandSnapshot;
  /** 发送时所处连接的代次：换连接后的视图据此核对遗留命令。 */
  readonly epoch: number;
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

/** 判定命令效果是否已体现在新视图中（结果未知时的本地核对）。 */
function commandEffectVisible(command: RoomCommand, view: RoomView): boolean {
  switch (command.type) {
    case "setPreselect":
      return view.currentSlotId === command.slotId && view.preselect === command.agentId;
    case "clearPreselect":
      return view.currentSlotId === command.slotId && view.preselect === null;
    case "confirmPreselect":
      return view.submissions.some((submission) => submission.slotId === command.slotId);
    case "setTeamName":
      return view.teamNames[command.team] === command.teamName;
    case "assignSeat":
      return (
        isHostManagementView(view) &&
        view.members.some(
          (member) =>
            member.memberId === command.targetMemberId && member.seatTeam === command.team,
        )
      );
    case "startBp":
      return view.bpStatus === "running";
    case "pauseBp":
      return view.bpStatus === "paused";
    case "resumeBp":
      return view.bpStatus === "running";
    case "restartBp":
      return view.bpStatus === "waiting" && view.submissions.length === 0;
    default:
      // undoBpStep 在调用方按发送时序列快照核对（序列变短即生效）。
      return false;
  }
}

/**
 * 房间会话。用 stop() 结束生命周期；组件卸载时必须调用，避免泄漏重连定时器。
 */
export class RoomSession {
  readonly status = ref<RoomSessionStatus>("idle");
  readonly view = shallowRef<RoomView | null>(null);
  /** 已发送未回执的命令（按 operationId）；UI 据此防重复提交。 */
  readonly pending = shallowRef<ReadonlyMap<string, PendingRoomCommand>>(new Map());
  /** 各操作区域的最近一次失败提示；成功或重发时清除。 */
  readonly scopeErrors = shallowRef<Readonly<Record<string, RoomClientError>>>({});
  /** 连接层全局提示（如服务端连接通知），随最新视图清除。 */
  readonly globalNotice = shallowRef<string | null>(null);

  private readonly url: string;
  private readonly openSocket: RoomSocketOpener;
  private readonly generateOperationId: () => string;
  private readonly reportError: (message: string) => void;
  private appliedRevision = -1;
  private started = false;
  private manualStop = false;
  private handle: RoomSocketHandle | null = null;
  private epoch = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RoomSessionOptions) {
    this.url = options.url;
    this.openSocket = options.openSocket ?? browserWebSocketOpener;
    this.generateOperationId = options.generateOperationId ?? defaultOperationId;
    this.reportError = options.onError ?? ((message) => console.error(message));
    if (options.initialView !== undefined) {
      this.view.value = options.initialView;
      this.appliedRevision = options.initialView.revision;
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

  /** 终止会话：关闭连接并停止重连；挂起命令视为放弃（视图保留）。 */
  stop(): void {
    this.started = false;
    this.manualStop = true;
    this.clearReconnectTimer();
    if (this.handle !== null) {
      this.handle.socket.close();
      this.handle = null;
    }
    this.status.value = "stopped";
    this.pending.value = new Map();
  }

  /** 是否有指定区域的命令正在等待回执。 */
  isScopePending(scope: string): boolean {
    for (const entry of this.pending.value.values()) {
      if (entry.scope === scope) return true;
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
   * 未连接、尚无视图或同 scope 已有命令在途时不发送——同一操作区域的
   * 防重复由会话层兜底，调用方同时按 pending 状态禁用入口；跨 scope 的
   * 互斥（如预选与确认）由调用方的派发入口约束。
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
    // 同 scope 已有命令在途时直接拒绝（不消耗 operationId）。
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
    const entry: PendingRoomCommand = {
      operationId,
      command,
      scope,
      snapshot: {
        bpVersion: view.bpVersion,
        status: view.bpStatus,
        submissionsLength: view.submissions.length,
      },
      epoch: this.epoch,
    };
    const pending = new Map(this.pending.value);
    pending.set(operationId, entry);
    this.pending.value = pending;
    this.clearScopeError(entry.scope);
    try {
      this.handle.socket.send(JSON.stringify(validated.data));
    } catch {
      this.resolvePending(operationId, { ok: false, code: CONNECTION_LOST });
      return { sent: false };
    }
    return { sent: true };
  }

  // ---- 内部状态机 ----

  private openCurrentSocket(): void {
    if (!this.started) return;
    try {
      const handle = this.openSocket(this.url);
      this.handle = handle;
      handle.onOpen(() => {
        if (!this.started || this.handle !== handle) return;
        this.epoch += 1;
        this.reconnectAttempts = 0;
        this.status.value = "connected";
      });
      handle.onMessage((data) => {
        if (!this.started || this.handle !== handle) return;
        this.handleSocketMessage(data);
      });
      handle.onClose(() => {
        if (this.handle !== handle) return;
        this.handle = null;
        this.scheduleReconnect();
      });
      handle.onError(() => {
        // error 之后必有 close；这里不重复处理，避免双重退避。
      });
    } catch {
      this.handle = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.manualStop) return;
    if (
      this.status.value === "auth-failed" ||
      this.status.value === "room-gone" ||
      this.status.value === "stopped"
    ) {
      return;
    }
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
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
    // revision 单调门：落后视图（含等价旧重放）不覆盖已应用的更新视图。
    if (view.revision < this.appliedRevision) return;
    const previous = this.view.value;
    this.view.value = view;
    this.appliedRevision = view.revision;
    this.globalNotice.value = null;
    // 操作位推进后，预选/提交相关的旧失败提示不再适用。
    if (previous !== null && previous.currentSlotId !== view.currentSlotId) {
      this.clearScopeError("setPreselect");
      this.clearScopeError("clearPreselect");
      this.clearScopeError("confirmPreselect");
    }
    this.reconcilePendingAfterReconnect(view);
  }

  private applyCommandResult(result: CommandResultMessage): void {
    const entry = this.pending.value.get(result.operationId);
    if (entry === undefined) return;
    if (result.ok) {
      this.resolvePending(result.operationId, { ok: true });
    } else {
      // schema 已保证失败结果携带稳定错误码。
      const code = result.error?.code ?? "INTERNAL";
      this.resolvePending(result.operationId, { ok: false, code });
    }
  }

  private applyNotice(code: string, message: string): void {
    switch (code) {
      case "AUTH_FAILED":
        this.status.value = "auth-failed";
        this.clearReconnectTimer();
        return;
      case "ROOM_NOT_FOUND":
      case "ROOM_ARCHIVED":
        this.status.value = "room-gone";
        this.clearReconnectTimer();
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

  private resolvePending(
    operationId: string,
    outcome: { readonly ok: true } | { readonly ok: false; readonly code: RoomClientErrorCode },
  ): void {
    const entry = this.pending.value.get(operationId);
    if (entry === undefined) return;
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

  /**
   * 换连接后的视图核对：只处理旧连接代次遗留的 pending 命令。
   * 效果可见 → 按成功收敛（权威事实）；否则按「结果未知」失败收敛。
   * 完整的「正在核对结果…」流程与同 operationId 重发由 PR7 收口。
   */
  private reconcilePendingAfterReconnect(view: RoomView): void {
    if (this.pending.value.size === 0) return;
    const staleEntries = [...this.pending.value.values()].filter(
      (entry) => entry.epoch < this.epoch,
    );
    for (const entry of staleEntries) {
      const visible = isUndoCommand(entry)
        ? view.submissions.length < entry.snapshot.submissionsLength
        : commandEffectVisible(entry.command, view);
      if (visible) {
        this.resolvePending(entry.operationId, { ok: true });
      } else {
        this.resolvePending(entry.operationId, { ok: false, code: UNKNOWN_OUTCOME });
      }
    }
  }
}

function isUndoCommand(entry: PendingRoomCommand): boolean {
  return entry.command.type === "undoBpStep";
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
