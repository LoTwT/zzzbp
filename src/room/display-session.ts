import { ref, shallowRef } from "vue";
import type { DisplayView } from "../../shared/contracts/views";
import { displayServerMessageSchema } from "../../shared/contracts/websocket";
import {
  browserWebSocketOpener,
  type RoomSocketHandle,
  type RoomSocketOpener,
} from "./room-session";

/**
 * 展示页只读 WebSocket 会话。
 *
 * 与常规成员会话（room-session.ts）共用的连接纪律，去掉全部写路径：
 * - 只连接展示通道，消费 displayServerMessageSchema（displayView / notice），
 *   没有任何命令发送入口、挂起命令与身份恢复逻辑；展示 WS 地址由页面
 *   构建后传入（同源 location 属浏览器环境，测试环境经 openSocket 注入）；
 * - 「已同步」以本连接首个合法且不落后的权威 displayView 为准：单纯
 *   WebSocket open 不放行动效（恢复呼吸动效必须先重新取得权威视图）；
 *   每次尝试有覆盖握手与首帧的期限，期限内无有效视图按失败收口并退避；
 * - 视图按公开 revision 单调应用：落后视图（含旧重放）不覆盖已应用的
 *   更新视图，也不作为本连接的同步依据；
 * - 断线保留最后收到的画面（view 不清除），状态进入 reconnecting/
 *   interrupted，调用方据此停用动效并展示「正在重连…/连接中断」；
 *   自动退避重连，旧连接的迟到事件被 handle 守卫隔离；
 * - ROOM_NOT_FOUND / ROOM_ARCHIVED 是终态：停止一切重试（页面分别按
 *   「不存在」与「已归档」收口；归档不冒充不存在，记录入口由页面保留）；
 *   INTERNAL 通知只提示并继续重试；
 * - 组件卸载必须调用 stop()：清理重连与首帧计时器。
 *
 * 服务端边界（docs/architecture.md「WebSocket 通道」）：展示连接永远没有
 * 写入口，不计任何成员在线、不影响保留计时；本会话不读取也不发送身份
 * 凭据，浏览器 Cookie 由网络层自动携带但展示通道一律忽略。
 */

/** 会话状态。room-gone/archived/stopped 为终态，不再自动重连。 */
export type DisplaySessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "interrupted"
  | "room-gone"
  | "archived"
  | "stopped";

/** 会话配置。 */
export interface DisplaySessionOptions {
  /** 完整的展示 WS 地址（含 ws/wss 协议与路径）。 */
  readonly url: string;
  readonly openSocket?: RoomSocketOpener;
  readonly onError?: (message: string) => void;
}

const RECONNECT_BASE_DELAY_MS = 600;
const RECONNECT_MAX_DELAY_MS = 10_000;
/** 连续失败达到该次数后界面显示「连接中断」，但仍按上限间隔持续重试。 */
const INTERRUPTED_AFTER_FAILURES = 2;
/** 单次连接尝试期限：覆盖握手与首个合法视图；到期按失败计并退避重试。 */
const SYNC_TIMEOUT_MS = 8_000;

/** 展示页只读会话。用 stop() 结束生命周期；组件卸载时必须调用。 */
export class DisplaySession {
  readonly status = ref<DisplaySessionStatus>("idle");
  readonly view = shallowRef<DisplayView | null>(null);
  /** 连接层提示（如服务端连接通知）；随最新视图清除。 */
  readonly notice = shallowRef<string | null>(null);

  private readonly url: string;
  private readonly openSocket: RoomSocketOpener;
  private readonly reportError: (message: string) => void;
  private appliedRevision = -1;
  private started = false;
  private manualStop = false;
  private handle: RoomSocketHandle | null = null;
  /** 当前连接是否已取得合法权威视图：动效放行的条件。 */
  private synced = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DisplaySessionOptions) {
    this.url = options.url;
    this.openSocket = options.openSocket ?? browserWebSocketOpener;
    this.reportError = options.onError ?? ((message) => console.error(message));
  }

  /** 开始连接；重复调用无效果。 */
  connect(): void {
    if (this.started) return;
    this.started = true;
    this.manualStop = false;
    this.status.value = "connecting";
    this.openCurrentSocket();
  }

  /** 终止会话：关闭连接并停止一切计时器；最后画面保留在 view 中。 */
  stop(): void {
    this.started = false;
    this.manualStop = true;
    this.clearReconnectTimer();
    this.clearSyncTimer();
    if (this.handle !== null) {
      this.handle.socket.close();
      this.handle = null;
    }
    this.synced = false;
    this.status.value = "stopped";
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
      // 旧连接的迟到事件被 handle 守卫隔离。
      if (!this.started || this.handle !== handle) return;
      this.handleSocketMessage(data);
    });
    handle.onClose(() => {
      if (this.handle !== handle) return;
      this.handle = null;
      this.scheduleReconnect();
    });
    handle.onError(() => {
      // error 之后必有 close；统一在 close 处理，避免双重退避。
    });
  }

  /**
   * 主动结束当前连接尝试并进入退避重连：先摘除 handle 再关闭，close
   * 事件被守卫忽略，重连只调度一次。
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
      this.status.value === "room-gone" ||
      this.status.value === "archived" ||
      this.status.value === "stopped"
    ) {
      return;
    }
    this.clearSyncTimer();
    this.synced = false;
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
    const message = displayServerMessageSchema.safeParse(parsed);
    if (!message.success) {
      // 不符合合同的消息不进入状态，也绝不覆盖已有视图、不能作为同步依据。
      this.reportError("服务端消息不符合共享 schema");
      return;
    }
    const payload = message.data;
    if (payload.kind === "displayView") {
      this.applyView(payload.view);
      return;
    }
    this.applyNotice(payload.code);
  }

  private applyView(view: DisplayView): void {
    // revision 单调门：落后视图不覆盖已应用的更新视图，也不能作为本连接
    // 的同步依据。
    if (view.revision < this.appliedRevision) return;
    this.view.value = view;
    this.appliedRevision = view.revision;
    this.notice.value = null;
    this.markSynced();
  }

  /** 本连接取得首个合法权威视图：放行动效，失败计数只在同步后清零。 */
  private markSynced(): void {
    if (this.synced) return;
    this.synced = true;
    this.clearSyncTimer();
    this.reconnectAttempts = 0;
    this.status.value = "connected";
  }

  private applyNotice(code: string): void {
    switch (code) {
      case "ROOM_NOT_FOUND":
        this.terminateSession("room-gone");
        return;
      case "ROOM_ARCHIVED":
        this.terminateSession("archived");
        return;
      case "INTERNAL":
        this.notice.value = "服务器连接异常，正在重试";
        return;
      case "INVALID_MESSAGE":
        this.notice.value = "上一条消息不符合协议，已忽略";
        return;
      default:
        this.reportError(`未知连接通知：${code}`);
    }
  }

  /** 进入终态：停止一切计时器与连接，不再重连；最后画面保留。 */
  private terminateSession(status: DisplaySessionStatus): void {
    this.clearReconnectTimer();
    this.clearSyncTimer();
    const handle = this.handle;
    this.handle = null;
    this.synced = false;
    if (handle !== null) {
      handle.socket.close();
    }
    this.status.value = status;
  }
}
