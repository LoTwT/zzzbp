import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DisplayView } from "../../shared/contracts/views";
import { DisplaySession } from "../../src/room/display-session";
import type { RoomSocketHandle } from "../../src/room/room-session";

// 展示页只读 WS 会话的核心行为回归（PR8）：
// - 同步门：open 不放行动效，本连接首个合法且不落后的 displayView 才是
//   「已连接」；首帧期限内无有效视图按失败收口并退避，退避计数只在
//   真正同步后清零；
// - revision 单调：落后视图不覆盖新视图、也不作为同步依据；
// - 断线保留最后画面（view 不清除），自动退避重连；
// - ROOM_NOT_FOUND / ROOM_ARCHIVED 终态：不再重连；INTERNAL 只提示并
//   继续重试；
// - 不符合合同的消息不进入状态、不作为同步依据；
// - 旧连接的迟到事件被隔离，stop() 清理全部计时器。

class FakeHandle implements RoomSocketHandle {
  readonly sent: string[] = [];
  private readonly openListeners: (() => void)[] = [];
  private readonly messageListeners: ((data: unknown) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];
  closed = false;

  readonly socket = {
    // 展示会话没有发送入口；保留实现以捕获意外发送（应当为零）。
    send: (text: string) => {
      this.sent.push(text);
    },
    close: () => {
      if (this.closed) return;
      this.closed = true;
      for (const listener of this.closeListeners) listener();
    },
  };

  onOpen(listener: () => void): void {
    this.openListeners.push(listener);
  }
  onMessage(listener: (data: unknown) => void): void {
    this.messageListeners.push(listener);
  }
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }
  onError(_listener: () => void): void {}

  open(): void {
    for (const listener of this.openListeners) listener();
  }
  /** 以服务端口径推送一条消息（对象会序列化）。 */
  receive(message: unknown): void {
    for (const listener of this.messageListeners) listener(JSON.stringify(message));
  }
  close(): void {
    this.socket.close();
  }
}

function displayView(overrides: Partial<DisplayView> = {}): DisplayView {
  return {
    roomName: "测试杯",
    teamNames: { A: "甲队", B: "乙队" },
    seatOccupancy: { A: true, B: true },
    bpStatus: "running",
    currentSlotId: "AB1",
    submissions: [],
    preselect: null,
    versions: { ruleVersion: "test-rule", agentDataVersion: "0.2.1" },
    revision: 3,
    ...overrides,
  };
}

let handles: FakeHandle[] = [];

function opener(): FakeHandle {
  const handle = new FakeHandle();
  handles.push(handle);
  return handle;
}

function createSession(
  overrides: Partial<{ onError: (message: string) => void }> = {},
): DisplaySession {
  handles = [];
  return new DisplaySession({
    url: "ws://localhost/api/rooms/r1/display/ws",
    openSocket: opener,
    onError:
      overrides.onError ??
      ((message) => {
        throw new Error(`unexpected session error: ${message}`);
      }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- 同步门与视图应用 ----

test("open 不代表已同步；首个合法 displayView 成为同步点", () => {
  const session = createSession();
  session.connect();
  const handle = handles[0]!;
  handle.open();
  expect(session.status.value).toBe("connecting");
  expect(session.view.value).toBeNull();
  handle.receive({ kind: "displayView", view: displayView({ revision: 3 }) });
  expect(session.status.value).toBe("connected");
  expect(session.view.value?.revision).toBe(3);
});

test("首帧期限内无有效视图按失败收口并退避重试", () => {
  const session = createSession();
  session.connect();
  const first = handles[0]!;
  first.open();
  vi.advanceTimersByTime(8_000);
  expect(first.closed).toBe(true);
  expect(session.status.value).toBe("reconnecting");
  vi.advanceTimersByTime(600);
  expect(handles).toHaveLength(2);
  const second = handles[1]!;
  second.receive({ kind: "displayView", view: displayView({ revision: 4 }) });
  expect(session.status.value).toBe("connected");
});

test("open-即断反复失败后显示中断；取得同步后计数清零", () => {
  const session = createSession();
  session.connect();
  handles[0]!.open();
  handles[0]!.close();
  expect(session.status.value).toBe("reconnecting");
  vi.advanceTimersByTime(600);
  handles[1]!.open();
  handles[1]!.close();
  expect(session.status.value).toBe("interrupted");
  // 中断后仍按上限间隔持续重试。
  vi.advanceTimersByTime(1_200);
  expect(handles).toHaveLength(3);
  handles[2]!.receive({ kind: "displayView", view: displayView({ revision: 4 }) });
  expect(session.status.value).toBe("connected");
  handles[2]!.close();
  expect(session.status.value).toBe("reconnecting");
});

test("revision 落后的视图不覆盖新视图，也不作为同步依据", () => {
  const session = createSession();
  session.connect();
  const handle = handles[0]!;
  handle.receive({ kind: "displayView", view: displayView({ revision: 5 }) });
  expect(session.status.value).toBe("connected");
  handle.receive({ kind: "displayView", view: displayView({ revision: 4, roomName: "旧房名" }) });
  expect(session.view.value?.revision).toBe(5);
  expect(session.view.value?.roomName).toBe("测试杯");
  // 同 revision 的重放不视为回归，但也不破坏已同步状态。
  handle.receive({ kind: "displayView", view: displayView({ revision: 5 }) });
  expect(session.status.value).toBe("connected");
});

test("断线保留最后画面：视图不清除，恢复同步后继续应用新视图", () => {
  const session = createSession();
  session.connect();
  const first = handles[0]!;
  first.receive({ kind: "displayView", view: displayView({ revision: 3 }) });
  first.close();
  expect(session.status.value).toBe("reconnecting");
  expect(session.view.value?.revision).toBe(3);
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.receive({ kind: "displayView", view: displayView({ revision: 6, bpStatus: "paused" }) });
  expect(session.status.value).toBe("connected");
  expect(session.view.value?.bpStatus).toBe("paused");
});

test("旧连接的迟到事件被隔离：不驱动新连接的状态", () => {
  const session = createSession();
  session.connect();
  const first = handles[0]!;
  first.receive({ kind: "displayView", view: displayView({ revision: 3 }) });
  first.close();
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  // 旧连接迟到的落后视图：不得覆盖或触发任何状态变化。
  first.receive({ kind: "displayView", view: displayView({ revision: 99, roomName: "迟到帧" }) });
  expect(session.view.value?.roomName).toBe("测试杯");
  expect(session.status.value).toBe("reconnecting");
  second.receive({ kind: "displayView", view: displayView({ revision: 4 }) });
  expect(session.view.value?.revision).toBe(4);
  expect(session.status.value).toBe("connected");
});

test("不符合合同的消息不进入状态、不作为同步依据", () => {
  const errors: string[] = [];
  const session = createSession({ onError: (message) => errors.push(message) });
  session.connect();
  const handle = handles[0]!;
  handle.open();
  handle.receive("not json");
  handle.receive({ kind: "displayView", view: { ...displayView(), revision: "x" } });
  handle.receive({ kind: "memberView", view: {} });
  expect(session.status.value).toBe("connecting");
  expect(session.view.value).toBeNull();
  expect(errors).toHaveLength(3);
  // 合法首帧随后到达仍能完成同步。
  handle.receive({ kind: "displayView", view: displayView({ revision: 2 }) });
  expect(session.status.value).toBe("connected");
});

// ---- 通知与终态 ----

test("ROOM_NOT_FOUND 终态：停止重连，不再建立新连接", () => {
  const session = createSession();
  session.connect();
  const handle = handles[0]!;
  handle.receive({ kind: "displayView", view: displayView({ revision: 3 }) });
  handle.receive({ kind: "notice", code: "ROOM_NOT_FOUND", message: "房间不存在" });
  expect(session.status.value).toBe("room-gone");
  expect(handle.closed).toBe(true);
  vi.advanceTimersByTime(60_000);
  expect(handles).toHaveLength(1);
  // 终态保留最后画面（页面自行决定收口展示）。
  expect(session.view.value?.revision).toBe(3);
});

test("ROOM_ARCHIVED 终态：停止实时重试，与不存在区分", () => {
  const session = createSession();
  session.connect();
  const handle = handles[0]!;
  handle.receive({ kind: "displayView", view: displayView({ revision: 3 }) });
  handle.receive({ kind: "notice", code: "ROOM_ARCHIVED", message: "房间已归档" });
  expect(session.status.value).toBe("archived");
  vi.advanceTimersByTime(60_000);
  expect(handles).toHaveLength(1);
});

test("INTERNAL 通知只提示并继续重试；提示随最新视图清除", () => {
  const session = createSession();
  session.connect();
  const handle = handles[0]!;
  handle.receive({ kind: "notice", code: "INTERNAL", message: "服务器连接异常" });
  expect(session.notice.value).toBe("服务器连接异常，正在重试");
  expect(session.status.value).toBe("connecting");
  handle.receive({ kind: "displayView", view: displayView({ revision: 2 }) });
  expect(session.notice.value).toBeNull();
  expect(session.status.value).toBe("connected");
});

// ---- 生命周期 ----

test("stop() 关闭连接并清理计时器；挂起不再重连", () => {
  const session = createSession();
  session.connect();
  const handle = handles[0]!;
  handle.receive({ kind: "displayView", view: displayView({ revision: 3 }) });
  session.stop();
  expect(session.status.value).toBe("stopped");
  expect(handle.closed).toBe(true);
  vi.advanceTimersByTime(120_000);
  expect(handles).toHaveLength(1);
  // 最后画面保留。
  expect(session.view.value?.revision).toBe(3);
});

test("展示会话不发送任何客户端消息", () => {
  const session = createSession();
  session.connect();
  const handle = handles[0]!;
  handle.receive({ kind: "displayView", view: displayView({ revision: 3 }) });
  vi.advanceTimersByTime(30_000);
  for (const h of handles) {
    expect(h.sent).toEqual([]);
  }
  session.stop();
});

test("终态后 connect 也不复活会话（页面收口负责后续）", () => {
  const session = createSession();
  session.connect();
  handles[0]!.receive({ kind: "notice", code: "ROOM_NOT_FOUND", message: "房间不存在" });
  expect(session.status.value).toBe("room-gone");
  session.connect();
  vi.advanceTimersByTime(60_000);
  expect(handles).toHaveLength(1);
});
