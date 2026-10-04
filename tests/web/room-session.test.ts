import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HostManagementView, RoomMemberView } from "../../shared/contracts/views";
import { RoomSession, type RoomSocketHandle, type RoomView } from "../../src/room/room-session";
import { UNKNOWN_OUTCOME } from "../../src/room/command-errors";

// 常规成员 WS 会话的核心行为回归：
// - HTTP 初值保留到首个 WS 视图；revision 落后的视图不覆盖新视图；
// - 命令补齐 operationId / expectedBpVersion（setTeamName 另带
//   expectedRevision），回执解除 pending、失败写入中文错误提示；
// - 断线进入重连状态并按退避重试（interrupted 阈值），重连成功恢复；
// - 换连接后的首份视图核对遗留 pending：效果可见按成功收敛，否则按
//   「结果未知」失败收敛；
// - AUTH_FAILED / ROOM_NOT_FOUND 通知终止重连并进入终态。

class FakeHandle implements RoomSocketHandle {
  readonly sent: string[] = [];
  private readonly openListeners: (() => void)[] = [];
  private readonly messageListeners: ((data: unknown) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];
  closed = false;

  readonly socket = {
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

function memberView(overrides: Partial<RoomMemberView> = {}): RoomMemberView {
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
    self: { memberId: "m1", nickname: "选手", isHost: false, seatTeam: "A" },
    bpVersion: 7,
    ...overrides,
  };
}

function hostView(overrides: Partial<HostManagementView> = {}): HostManagementView {
  return {
    ...memberView(),
    self: { memberId: "host", nickname: "房主", isHost: true, seatTeam: null },
    members: [
      { memberId: "host", nickname: "房主", isHost: true, seatTeam: null, online: true },
      { memberId: "m1", nickname: "选手", isHost: false, seatTeam: "A", online: true },
    ],
    ...overrides,
  } as HostManagementView;
}

let handles: FakeHandle[] = [];

function opener(): FakeHandle {
  const handle = new FakeHandle();
  handles.push(handle);
  return handle;
}

function createSession(
  initialView?: RoomView,
  overrides: Partial<{ onError: (message: string) => void }> = {},
): RoomSession {
  handles = [];
  return new RoomSession({
    url: "ws://localhost/api/rooms/r1/ws",
    initialView,
    openSocket: opener,
    generateOperationId: (() => {
      let counter = 0;
      return () => `op-${(counter += 1)}`;
    })(),
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

function connect(session: RoomSession): FakeHandle {
  session.connect();
  const handle = handles[0]!;
  handle.open();
  return handle;
}

test("HTTP 初值保留；首个 WS 视图按 revision 应用", () => {
  const session = createSession(memberView({ revision: 3 }));
  expect(session.view.value?.revision).toBe(3);
  const handle = connect(session);
  expect(session.status.value).toBe("connected");
  handle.receive({ kind: "memberView", view: memberView({ revision: 4 }) });
  expect(session.view.value?.revision).toBe(4);
});

test("revision 落后的视图不覆盖新视图", () => {
  const session = createSession();
  const handle = connect(session);
  handle.receive({ kind: "memberView", view: memberView({ revision: 5 }) });
  handle.receive({ kind: "memberView", view: memberView({ revision: 4, roomName: "旧房名" }) });
  expect(session.view.value?.revision).toBe(5);
  expect(session.view.value?.roomName).toBe("测试杯");
});

test("房主连接接收 hostView 并按同一 revision 门应用", () => {
  const session = createSession();
  const handle = connect(session);
  handle.receive({ kind: "hostView", view: hostView({ revision: 6 }) });
  expect(session.view.value?.revision).toBe(6);
  expect("members" in session.view.value! && session.view.value.members.length).toBe(2);
});

test("命令补齐 operationId 与版本前置条件，pending 期间防重复", () => {
  const session = createSession(memberView({ bpVersion: 7, revision: 3 }));
  const handle = connect(session);
  const result = session.sendCommand({ type: "setPreselect", slotId: "AB1", agentId: "1011" });
  expect(result.sent).toBe(true);
  expect(handle.sent).toHaveLength(1);
  const sent = JSON.parse(handle.sent[0]!) as Record<string, unknown>;
  expect(sent).toMatchObject({
    type: "setPreselect",
    slotId: "AB1",
    agentId: "1011",
    operationId: "op-1",
    expectedBpVersion: 7,
  });
  expect("expectedRevision" in sent).toBe(false);
  expect(session.isScopePending("setPreselect")).toBe(true);

  // 回执按 operationId 精确匹配；同区域第二条命令独立排队。
  session.sendCommand({ type: "setPreselect", slotId: "AB1", agentId: "1241" });
  handle.receive({
    kind: "commandResult",
    operationId: "op-1",
    ok: true,
    error: null,
    bpVersion: 8,
    revision: 4,
  });
  expect(session.pending.value.get("op-1")).toBeUndefined();
  expect(session.isScopePending("setPreselect")).toBe(true);
  handle.receive({
    kind: "commandResult",
    operationId: "op-2",
    ok: true,
    error: null,
    bpVersion: 8,
    revision: 4,
  });
  expect(session.isScopePending("setPreselect")).toBe(false);
});

test("setTeamName 额外携带 expectedRevision", () => {
  const session = createSession(hostView({ bpVersion: 7, revision: 9 }));
  const handle = connect(session);
  session.sendCommand({ type: "setTeamName", team: "A", teamName: "新队名" });
  const sent = JSON.parse(handle.sent[0]!) as Record<string, unknown>;
  expect(sent).toMatchObject({
    type: "setTeamName",
    team: "A",
    teamName: "新队名",
    operationId: "op-1",
    expectedBpVersion: 7,
    expectedRevision: 9,
  });
});

test("未连接时不发送命令", () => {
  const session = createSession(memberView());
  expect(session.sendCommand({ type: "startBp" })).toEqual({ sent: false });
});

test("失败回执写入区域错误并显示中文文案；重发清除旧错误", () => {
  const session = createSession(memberView());
  const handle = connect(session);
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  handle.receive({
    kind: "commandResult",
    operationId: "op-1",
    ok: false,
    error: { code: "STALE_BP_VERSION", message: "..." },
    bpVersion: 9,
    revision: 4,
  });
  const error = session.scopeError("confirmPreselect");
  expect(error?.code).toBe("STALE_BP_VERSION");
  expect(error?.text).toBe("页面状态已更新，请按最新状态重试");

  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  expect(session.scopeError("confirmPreselect")).toBeNull();
});

test("操作位推进后清除预选与提交区域的旧错误", () => {
  const session = createSession(memberView({ currentSlotId: "AB1" }));
  const handle = connect(session);
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  handle.receive({
    kind: "commandResult",
    operationId: "op-1",
    ok: false,
    error: { code: "NO_PRESELECT", message: "..." },
    bpVersion: 7,
    revision: 3,
  });
  expect(session.scopeError("confirmPreselect")).not.toBeNull();
  handle.receive({ kind: "memberView", view: memberView({ currentSlotId: "BB1", revision: 4 }) });
  expect(session.scopeError("confirmPreselect")).toBeNull();
});

test("AUTH_FAILED 通知进入终态，连接关闭后不再重连", () => {
  const session = createSession(memberView());
  const handle = connect(session);
  handle.receive({ kind: "notice", code: "AUTH_FAILED", message: "身份无效" });
  expect(session.status.value).toBe("auth-failed");
  handle.close();
  vi.advanceTimersByTime(60_000);
  expect(handles).toHaveLength(1);
});

test("ROOM_NOT_FOUND 通知进入 room-gone 终态", () => {
  const session = createSession(memberView());
  const handle = connect(session);
  handle.receive({ kind: "notice", code: "ROOM_NOT_FOUND", message: "房间不存在" });
  expect(session.status.value).toBe("room-gone");
  handle.close();
  vi.advanceTimersByTime(60_000);
  expect(handles).toHaveLength(1);
});

test("断线进入重连：两次失败后显示中断，成功重连恢复连接", () => {
  const session = createSession(memberView());
  const first = connect(session);
  first.close();
  expect(session.status.value).toBe("reconnecting");

  vi.advanceTimersByTime(600);
  expect(handles).toHaveLength(2);
  const second = handles[1]!;
  second.close();
  expect(session.status.value).toBe("interrupted");

  vi.advanceTimersByTime(1_200);
  expect(handles).toHaveLength(3);
  const third = handles[2]!;
  third.open();
  expect(session.status.value).toBe("connected");
  third.receive({ kind: "memberView", view: memberView({ revision: 5 }) });
  expect(session.view.value?.revision).toBe(5);
});

test("断线期间保留最后确认画面与 pending 状态", () => {
  const session = createSession(memberView({ revision: 3 }));
  const handle = connect(session);
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  handle.close();
  expect(session.view.value?.revision).toBe(3);
  expect(session.isScopePending("confirmPreselect")).toBe(true);
  session.stop();
});

test("重连后的首份视图核对遗留命令：效果可见按成功收敛", () => {
  const session = createSession(memberView({ revision: 3, bpVersion: 7 }));
  const first = connect(session);
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  first.close();

  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.open();
  // 新视图显示该操作位已提交：按权威事实视为成功。
  second.receive({
    kind: "memberView",
    view: memberView({
      revision: 4,
      bpVersion: 8,
      currentSlotId: "BB1",
      submissions: [{ slotId: "AB1", agentId: "1011" }],
    }),
  });
  expect(session.isScopePending("confirmPreselect")).toBe(false);
  expect(session.scopeError("confirmPreselect")).toBeNull();
});

test("重连后的首份视图核对遗留命令：效果不可见按结果未知失败收敛", () => {
  const session = createSession(memberView({ revision: 3, bpVersion: 7 }));
  const first = connect(session);
  session.sendCommand({ type: "setPreselect", slotId: "AB1", agentId: "1241" });
  first.close();

  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.open();
  second.receive({
    kind: "memberView",
    view: memberView({ revision: 3, bpVersion: 7, preselect: null }),
  });
  expect(session.isScopePending("setPreselect")).toBe(false);
  const error = session.scopeError("setPreselect");
  expect(error?.code).toBe(UNKNOWN_OUTCOME);
  expect(error?.text).toContain("结果未知");
});

test("undoBpStep 的核对按发送时序列快照判断生效", () => {
  const session = createSession(
    hostView({
      revision: 3,
      bpVersion: 7,
      bpStatus: "running",
      currentSlotId: "AP1",
      submissions: [
        { slotId: "AB1", agentId: "1011" },
        { slotId: "BB1", agentId: "1241" },
      ],
    }),
  );
  const first = connect(session);
  session.sendCommand({ type: "undoBpStep" });
  first.close();

  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.open();
  second.receive({
    kind: "hostView",
    view: hostView({
      revision: 4,
      bpVersion: 8,
      currentSlotId: "BB1",
      submissions: [{ slotId: "AB1", agentId: "1011" }],
    }),
  });
  expect(session.isScopePending("undoBpStep")).toBe(false);
  expect(session.scopeError("undoBpStep")).toBeNull();
});

test("不符合共享 schema 的服务端消息被忽略，不覆盖视图", () => {
  const errors: string[] = [];
  const session = createSession(memberView({ revision: 3 }), {
    onError: (message) => {
      errors.push(message);
    },
  });
  const handle = connect(session);
  handle.receive({ kind: "memberView", view: { roomName: 42 } });
  expect(session.view.value?.revision).toBe(3);
  handle.receive("not-json{");
  expect(session.view.value?.revision).toBe(3);
  expect(errors.length).toBeGreaterThan(0);
});

test("stop 后不再建立新连接", () => {
  const session = createSession(memberView());
  const handle = connect(session);
  session.stop();
  handle.close();
  vi.advanceTimersByTime(120_000);
  expect(handles).toHaveLength(1);
  expect(session.status.value).toBe("stopped");
});

test("assignSeat 的核对要求房主视图成员席位匹配", () => {
  const session = createSession(
    hostView({
      revision: 3,
      bpVersion: 7,
      bpStatus: "waiting",
      currentSlotId: null,
    }),
  );
  const first = connect(session);
  session.sendCommand({ type: "assignSeat", team: "A", targetMemberId: "m1" });
  first.close();

  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.open();
  // 成员 m1 已在 A 席：视为生效。
  second.receive({
    kind: "hostView",
    view: hostView({
      revision: 4,
      bpVersion: 8,
      members: [
        { memberId: "host", nickname: "房主", isHost: true, seatTeam: null, online: true },
        { memberId: "m1", nickname: "选手", isHost: false, seatTeam: "A", online: true },
      ],
    }),
  });
  expect(session.isScopePending("assignSeat:A")).toBe(false);
  expect(session.scopeError("assignSeat:A")).toBeNull();
});
