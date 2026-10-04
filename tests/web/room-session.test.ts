import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HostManagementView, RoomMemberView } from "../../shared/contracts/views";
import {
  RoomSession,
  isHostManagementView,
  type RoomSocketHandle,
  type RoomView,
} from "../../src/room/room-session";
import { IDENTITY_CHANGED, UNKNOWN_OUTCOME } from "../../src/room/command-errors";

// 常规成员 WS 会话的核心行为回归（PR7 恢复收口）：
// - 同步门：open 不放行操作与动效，本连接首个合法视图才是「已连接」；
//   首帧期限内无有效视图按失败收口，退避计数只在同步后清零；
// - revision 单调：落后视图不覆盖新视图、也不作为同步依据；
// - 命令补齐 operationId / 版本前置条件，序列化字节被原样保留；
// - 结果未知核对：回执超时或断线转「核对中」，重新同步后按同一
//   operationId 与同一载荷字节重发；核对重发收到的失败回执（含
//   INTERNAL、权限/状态类拒绝与 STALE_*）都不能证明原命令失败，
//   统一按「结果未知」诚实收敛，首发的失败回执才按对应错误结算；
// - 身份边界：挂起命令绑定发送时的 memberId，视图携带的身份变化
//   （同昵称不同 ID，不经 AUTH_FAILED）时旧命令被明确放弃，绝不以
//   新身份重发；同一 memberId 的席位/角色变化照常核对；
// - 身份失效 / 房间消失进入终态：不再重连、不再重发核对命令；
// - 旧连接的迟到事件被隔离，stop() 清理全部计时器。

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

function receipt(operationId: string, ok: boolean, extra: Record<string, unknown> = {}) {
  return {
    kind: "commandResult",
    operationId,
    ok,
    ...(ok ? { error: null } : {}),
    ...(!ok ? { error: { code: "INTERNAL", message: "..." } } : {}),
    bpVersion: 8,
    revision: 4,
    ...extra,
  };
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

function connectAndSync(session: RoomSession, view: RoomView): FakeHandle {
  session.connect();
  const handle = handles[0]!;
  handle.receive({ kind: isHostManagementView(view) ? "hostView" : "memberView", view });
  return handle;
}

// ---- 视图与同步门 ----

test("HTTP 初值保留；WS 首个合法视图应用并成为同步点", () => {
  const session = createSession(memberView({ revision: 3 }));
  expect(session.view.value?.revision).toBe(3);
  session.connect();
  const handle = handles[0]!;
  // open 本身不代表已同步：连接可用性以首个合法视图为同步点。
  handle.open();
  expect(session.status.value).toBe("connecting");
  handle.receive({ kind: "memberView", view: memberView({ revision: 4 }) });
  expect(session.status.value).toBe("connected");
  expect(session.view.value?.revision).toBe(4);
});

test("open 未同步不放行：连接打开但无视图时不能发送命令", () => {
  const session = createSession(memberView());
  session.connect();
  handles[0]!.open();
  expect(session.status.value).not.toBe("connected");
  expect(session.sendCommand({ type: "setPreselect", slotId: "AB1", agentId: "1011" })).toEqual({
    sent: false,
  });
});

test("首帧期限内无有效视图按失败收口并退避重试", () => {
  const session = createSession(memberView());
  session.connect();
  const first = handles[0]!;
  first.open();
  // 8s 同步期限内没有任何视图：按一次失败处理，主动断开并退避。
  vi.advanceTimersByTime(8_000);
  expect(first.closed).toBe(true);
  expect(session.status.value).toBe("reconnecting");
  vi.advanceTimersByTime(600);
  expect(handles).toHaveLength(2);
  // 第二次尝试取得合法视图后恢复。
  const second = handles[1]!;
  second.receive({ kind: "memberView", view: memberView({ revision: 4 }) });
  expect(session.status.value).toBe("connected");
});

test("退避计数不因 open 而清零：open-即断反复失败后显示中断", () => {
  const session = createSession(memberView());
  session.connect();
  // 第一次尝试：open 后立即被服务端关闭（无有效首帧）。
  handles[0]!.open();
  handles[0]!.close();
  expect(session.status.value).toBe("reconnecting");
  vi.advanceTimersByTime(600);
  // 第二次尝试：同样 open 后立即关闭——失败计数继续累积。
  handles[1]!.open();
  handles[1]!.close();
  expect(session.status.value).toBe("interrupted");
  vi.advanceTimersByTime(1_200);
  // 第三次尝试在期限内取得合法视图：计数清零并恢复连接。
  const third = handles[2]!;
  third.receive({ kind: "memberView", view: memberView({ revision: 4 }) });
  expect(session.status.value).toBe("connected");
  third.close();
  expect(session.status.value).toBe("reconnecting");
});

test("revision 落后的视图不覆盖新视图，也不作为同步依据", () => {
  const session = createSession(memberView({ revision: 5 }));
  session.connect();
  const handle = handles[0]!;
  handle.receive({ kind: "memberView", view: memberView({ revision: 4, roomName: "旧房名" }) });
  expect(session.view.value?.revision).toBe(5);
  expect(session.view.value?.roomName).toBe("测试杯");
  // 落后首帧不是有效同步：期限内按失败收口。
  expect(session.status.value).toBe("connecting");
  vi.advanceTimersByTime(8_000);
  expect(session.status.value).toBe("reconnecting");
});

test("房主连接接收 hostView 并按同一 revision 门应用", () => {
  const session = createSession();
  connectAndSync(session, hostView({ revision: 6 }));
  expect(session.view.value?.revision).toBe(6);
  expect("members" in session.view.value! && session.view.value.members.length).toBe(2);
});

// ---- 命令发送 ----

test("命令补齐 operationId 与版本前置条件，pending 期间防重复", () => {
  const session = createSession(memberView({ bpVersion: 7, revision: 3 }));
  const handle = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
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

  // 同 scope 已有命令在途时会话层拒绝重复发送（UI 亦禁用入口，此处兜底）。
  const duplicate = session.sendCommand({ type: "setPreselect", slotId: "AB1", agentId: "1241" });
  expect(duplicate).toEqual({ sent: false });
  expect(handle.sent).toHaveLength(1);
  handle.receive(receipt("op-1", true));
  expect(session.pending.value.get("op-1")).toBeUndefined();
  expect(session.isScopePending("setPreselect")).toBe(false);
  // 回执解除挂起后同 scope 可再次发送，并携带新的唯一 operationId。
  const next = session.sendCommand({ type: "setPreselect", slotId: "AB1", agentId: "1241" });
  expect(next).toEqual({ sent: true });
  expect(handle.sent).toHaveLength(2);
  expect(JSON.parse(handle.sent[1]!)).toMatchObject({
    type: "setPreselect",
    agentId: "1241",
    operationId: "op-2",
    expectedBpVersion: 7,
  });
  handle.receive(receipt("op-2", true));
  expect(session.isScopePending("setPreselect")).toBe(false);
});

test("setTeamName 额外携带 expectedRevision", () => {
  const session = createSession();
  const handle = connectAndSync(session, hostView({ bpVersion: 7, revision: 9 }));
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
  const session = createSession();
  const handle = connectAndSync(session, memberView());
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
  const session = createSession();
  const handle = connectAndSync(session, memberView({ currentSlotId: "AB1" }));
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

// ---- 结果未知与同 ID 重发核对 ----

test("断线后命令转「核对中」，同步后按同一 operationId 与原载荷字节重发", () => {
  const session = createSession();
  const first = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({
    type: "setTeamName",
    team: "A",
    teamName: "新队名",
  });
  expect(session.isScopeChecking("setTeamName:A")).toBe(false);
  first.close();
  expect(session.isScopePending("setTeamName:A")).toBe(true);
  expect(session.isScopeChecking("setTeamName:A")).toBe(true);

  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  // 重发前必须先取得本连接的合法视图（open 不触发重发）。
  second.open();
  expect(second.sent).toHaveLength(0);
  // 同一身份（m1）的视图：memberView 与 hostView 的 self 不同，混用会
  // 触发身份边界（跨身份用例另测）。
  second.receive({
    kind: "memberView",
    view: memberView({
      revision: 5,
      bpVersion: 7,
      self: { memberId: "m1", nickname: "选手", isHost: false, seatTeam: null },
    }),
  });
  // 同 ID + 同载荷（含原 expectedRevision/expectedBpVersion）原样重发。
  expect(second.sent).toHaveLength(1);
  expect(second.sent[0]).toBe(first.sent[0]);
  expect(session.isScopeChecking("setTeamName:A")).toBe(true);
  // 服务端持久化去重回执返回原结果，按成功收敛。
  second.receive(receipt("op-1", true));
  expect(session.isScopePending("setTeamName:A")).toBe(false);
  expect(session.scopeError("setTeamName:A")).toBeNull();
});

test("结果等待超时：连接未断也转「核对中」并主动重连核对", () => {
  const session = createSession();
  const first = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  expect(session.isScopeChecking("confirmPreselect")).toBe(false);
  // 回执迟迟未到（半开连接或服务端无响应）：10s 后转核对并断开重连。
  vi.advanceTimersByTime(10_000);
  expect(first.closed).toBe(true);
  expect(session.isScopeChecking("confirmPreselect")).toBe(true);
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.receive({ kind: "memberView", view: memberView({ revision: 3, bpVersion: 7 }) });
  expect(second.sent).toHaveLength(1);
  expect(second.sent[0]).toBe(first.sent[0]);
  second.receive(receipt("op-1", true));
  expect(session.isScopePending("confirmPreselect")).toBe(false);
});

test("重发后 STALE_* 拒绝按「结果未知」诚实收敛，不伪造成败", () => {
  for (const code of ["STALE_BP_VERSION", "STALE_REVISION"] as const) {
    const session = createSession();
    const first = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
    session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
    first.close();
    vi.advanceTimersByTime(600);
    const second = handles[1]!;
    second.receive({ kind: "memberView", view: memberView({ revision: 3, bpVersion: 7 }) });
    expect(second.sent).toHaveLength(1);
    second.receive({
      kind: "commandResult",
      operationId: "op-1",
      ok: false,
      error: { code, message: "..." },
      bpVersion: 8,
      revision: 4,
    });
    expect(session.isScopePending("confirmPreselect")).toBe(false);
    const error = session.scopeError("confirmPreselect");
    expect(error?.code).toBe(UNKNOWN_OUTCOME);
    expect(error?.text).toContain("结果未知");
  }
});

test("核对重发后的业务拒绝不能证明原命令失败，按结果未知收敛", () => {
  const session = createSession();
  const first = connectAndSync(session, hostView({ bpStatus: "waiting", currentSlotId: null }));
  session.sendCommand({ type: "assignSeat", team: "A", targetMemberId: "m1" });
  first.close();
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.receive({
    kind: "hostView",
    view: hostView({ bpStatus: "waiting", currentSlotId: null, revision: 3 }),
  });
  expect(second.sent).toHaveLength(1);
  // 原命令可能已生效但回执越出保留窗口后被按新命令拒绝（规则在版本门
  // 前先判权限/状态），也可能是原失败回执的幂等重放——客户端无法区分，
  // 不能把该拒绝当成原操作的明确失败。
  second.receive({
    kind: "commandResult",
    operationId: "op-1",
    ok: false,
    error: { code: "SEAT_TARGET_OFFLINE", message: "..." },
    bpVersion: 0,
    revision: 4,
  });
  expect(session.isScopePending("assignSeat:A")).toBe(false);
  const error = session.scopeError("assignSeat:A");
  expect(error?.code).toBe(UNKNOWN_OUTCOME);
  expect(error?.text).toContain("结果未知");
  // 收敛后允许以新 operationId 重新发起（首发错误才显示准确原因）。
  expect(session.sendCommand({ type: "assignSeat", team: "A", targetMemberId: "m1" }).sent).toBe(
    true,
  );
  expect(JSON.parse(second.sent[1]!)).toMatchObject({ operationId: "op-2" });
});

test("核对重发遇到 INTERNAL（本次核对的事务故障）不证明原命令失败", () => {
  const session = createSession();
  const first = connectAndSync(session, hostView({ bpStatus: "paused", currentSlotId: "BB1" }));
  session.sendCommand({ type: "undoBpStep" });
  first.close();
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.receive({
    kind: "hostView",
    view: hostView({ bpStatus: "paused", currentSlotId: "BB1", revision: 3 }),
  });
  expect(second.sent[0]).toBe(first.sent[0]);
  // 回执查询/处理故障使本次核对整体回滚：只是核对未取得原结论，原命令
  // 可能早已成功，不能显示为原操作失败并诱导盲目重试。
  second.receive(receipt("op-1", false, { error: { code: "INTERNAL", message: "..." } }));
  expect(session.isScopePending("undoBpStep")).toBe(false);
  const error = session.scopeError("undoBpStep");
  expect(error?.code).toBe(UNKNOWN_OUTCOME);
  expect(error?.text).toContain("结果未知");
});

test("首发命令的 STALE_BP_VERSION 仍按普通过期错误结算（非结果未知）", () => {
  const session = createSession();
  const handle = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  handle.receive({
    kind: "commandResult",
    operationId: "op-1",
    ok: false,
    error: { code: "STALE_BP_VERSION", message: "..." },
    bpVersion: 8,
    revision: 4,
  });
  expect(session.scopeError("confirmPreselect")?.code).toBe("STALE_BP_VERSION");
});

test("待核对期间同 scope 拒绝新命令（禁止盲目重复）", () => {
  const session = createSession();
  const first = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  first.close();
  expect(session.sendCommand({ type: "confirmPreselect", slotId: "AB1" })).toEqual({ sent: false });
  // 重连同步后（核对重发已发出、尚未回执）依旧拒绝，直到权威结论到达。
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.receive({ kind: "memberView", view: memberView({ revision: 3, bpVersion: 7 }) });
  expect(session.sendCommand({ type: "confirmPreselect", slotId: "AB1" })).toEqual({ sent: false });
  second.receive(receipt("op-1", true));
  expect(session.sendCommand({ type: "confirmPreselect", slotId: "AB1" }).sent).toBe(true);
});

test("断线期间保留最后确认画面与 pending 状态", () => {
  const session = createSession(memberView({ revision: 3 }));
  const handle = connectAndSync(session, memberView({ revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  handle.close();
  expect(session.view.value?.revision).toBe(3);
  expect(session.isScopePending("confirmPreselect")).toBe(true);
  session.stop();
});

test("多个不同 scope 的待核对命令在同步后一并重发", () => {
  const session = createSession();
  const first = connectAndSync(session, hostView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({ type: "setTeamName", team: "A", teamName: "新队名" });
  session.sendCommand({ type: "pauseBp" });
  first.close();
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.receive({ kind: "hostView", view: hostView({ revision: 3, bpVersion: 7 }) });
  expect(second.sent).toHaveLength(2);
  expect(second.sent[0]).toBe(first.sent[0]);
  expect(second.sent[1]).toBe(first.sent[1]);
});

test("核对重发再次断线：下次同步继续按原 ID 原载荷重发", () => {
  const session = createSession();
  const first = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  first.close();
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.receive({ kind: "memberView", view: memberView({ revision: 3, bpVersion: 7 }) });
  expect(second.sent).toHaveLength(1);
  // 核对重发后连接再次中断：命令保持核对态。
  second.close();
  vi.advanceTimersByTime(1_200);
  const third = handles[2]!;
  third.receive({ kind: "memberView", view: memberView({ revision: 3, bpVersion: 7 }) });
  expect(third.sent).toHaveLength(1);
  expect(third.sent[0]).toBe(first.sent[0]);
  third.receive(receipt("op-1", true));
  expect(session.isScopePending("confirmPreselect")).toBe(false);
});

// ---- 身份边界（跨身份不重发） ----

test("身份变化（同昵称不同 memberId）后旧身份命令绝不以新身份重发", () => {
  const session = createSession(memberView());
  const first = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  first.close();
  expect(session.isScopeChecking("confirmPreselect")).toBe(true);
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  // 浏览器凭据被更换后以新成员重新入房（同昵称）：服务端直接返回新身份
  // 的有效视图，不经 AUTH_FAILED。
  second.receive({
    kind: "memberView",
    view: memberView({
      revision: 4,
      self: { memberId: "m2", nickname: "选手", isHost: false, seatTeam: null },
    }),
  });
  // 旧命令被明确放弃：不重发、不伪成功，按「身份已变化、结果未知」收敛。
  expect(second.sent).toHaveLength(0);
  expect(session.isScopePending("confirmPreselect")).toBe(false);
  const error = session.scopeError("confirmPreselect");
  expect(error?.code).toBe(IDENTITY_CHANGED);
  expect(error?.text).toContain("身份已变化");
  // 新身份流程正常：可发送新命令（新 operationId，绑定新身份）。
  expect(session.sendCommand({ type: "startBp" }).sent).toBe(true);
  const sent = JSON.parse(second.sent[0]!) as Record<string, unknown>;
  expect(sent.operationId).toBe("op-2");
  second.receive(receipt("op-2", true));
  expect(session.isScopePending("startBp")).toBe(false);
});

test("HTTP 初值与首个 WS 视图之间的身份变化也经边界绑定", () => {
  const session = createSession(memberView()); // HTTP 初值身份 m1
  session.connect();
  const handle = handles[0]!;
  // WS 升级时凭据已被更换：首个视图即新身份 m2。
  handle.receive({
    kind: "memberView",
    view: memberView({
      revision: 3,
      self: { memberId: "m2", nickname: "选手", isHost: false, seatTeam: null },
    }),
  });
  expect(session.view.value?.self.memberId).toBe("m2");
  // 新身份的命令正常发送；不存在旧身份挂起可重发。
  expect(session.sendCommand({ type: "setPreselect", slotId: "AB1", agentId: "1011" }).sent).toBe(
    true,
  );
  handle.receive(receipt("op-1", true));
  expect(session.isScopePending("setPreselect")).toBe(false);
});

test("同一 memberId 的席位变化不构成身份变化，照常按原 ID 核对", () => {
  const session = createSession(memberView());
  const first = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  first.close();
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  // 同一成员 m1 被换下席位（seatTeam A → null）：身份未变，照常重发核对。
  second.receive({
    kind: "memberView",
    view: memberView({
      revision: 4,
      self: { memberId: "m1", nickname: "选手", isHost: false, seatTeam: null },
    }),
  });
  expect(second.sent).toHaveLength(1);
  expect(second.sent[0]).toBe(first.sent[0]);
  expect(session.scopeError("confirmPreselect")).toBeNull();
});

test("身份变化时多个旧身份挂起命令一并放弃，新身份可继续操作", () => {
  const session = createSession();
  const first = connectAndSync(
    session,
    hostView({ bpStatus: "running", currentSlotId: "AB1", bpVersion: 7, revision: 3 }),
  );
  session.sendCommand({ type: "setTeamName", team: "A", teamName: "新队名" });
  session.sendCommand({ type: "pauseBp" });
  first.close();
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.receive({
    kind: "memberView",
    view: memberView({
      revision: 4,
      self: { memberId: "m9", nickname: "新观众", isHost: false, seatTeam: null },
    }),
  });
  expect(second.sent).toHaveLength(0);
  expect(session.isScopePending("setTeamName:A")).toBe(false);
  expect(session.isScopePending("pauseBp")).toBe(false);
  expect(session.scopeError("setTeamName:A")?.code).toBe(IDENTITY_CHANGED);
  expect(session.scopeError("pauseBp")?.code).toBe(IDENTITY_CHANGED);
});

// ---- 身份结论与结果未知结论的生命周期 ----

test("身份变化与操作位推进同时出现在重连首帧时，身份结论不被清掉", () => {
  const session = createSession(memberView());
  const first = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  // 断线时该命令的结果与广播均未到达本页（仍认为当前位是 AB1）。
  first.close();
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  // 重连首帧同时携带新身份与操作位推进（原命令实际已生效、房间因
  // 掉线暂停）：身份结论必须实际可见，不能被同一份视图的旧回合错误
  // 清理吞掉。
  second.receive({
    kind: "memberView",
    view: memberView({
      revision: 5,
      bpVersion: 9,
      bpStatus: "paused",
      currentSlotId: "BB1",
      submissions: [{ slotId: "AB1", agentId: "1011" }],
      self: { memberId: "m2", nickname: "选手", isHost: false, seatTeam: null },
    }),
  });
  expect(second.sent).toHaveLength(0);
  expect(session.pending.value.size).toBe(0);
  const error = session.scopeError("confirmPreselect");
  expect(error?.code).toBe(IDENTITY_CHANGED);
  expect(error?.text).toContain("身份已变化");
  // 通用身份提示同步设置（新身份可能看不到逐 scope 出口）。
  expect(session.identityNotice.value).toContain("身份已变化");
});

test("结果未知结论随后的视图推进不被吞掉，用户开始新操作时结算", () => {
  const session = createSession();
  const first = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  first.close();
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.receive({
    kind: "memberView",
    view: memberView({ revision: 4, bpVersion: 7, currentSlotId: "AB1" }),
  });
  second.receive(receipt("op-1", false, { error: { code: "INTERNAL", message: "..." } }));
  expect(session.scopeError("confirmPreselect")?.code).toBe(UNKNOWN_OUTCOME);
  // 之后对方完成提交、操作位推进：旧回合的普通失败会被清理，但
  // 「结果未知」是原操作结论，必须保持可见。
  second.receive({
    kind: "memberView",
    view: memberView({ revision: 5, bpVersion: 8, currentSlotId: "AP1" }),
  });
  expect(session.scopeError("confirmPreselect")?.code).toBe(UNKNOWN_OUTCOME);
  // 相邻操作（预选）不结算确认命令的结论；用户重新确认时才清除。
  session.sendCommand({ type: "setPreselect", slotId: "AP1", agentId: "1011" });
  expect(session.scopeError("confirmPreselect")?.code).toBe(UNKNOWN_OUTCOME);
  session.sendCommand({ type: "confirmPreselect", slotId: "AP1" });
  expect(session.scopeError("confirmPreselect")).toBeNull();
});

test("旧房主管理命令被放弃时，新观众可见通用身份提示", () => {
  const session = createSession();
  const first = connectAndSync(
    session,
    hostView({ bpStatus: "running", currentSlotId: "AB1", bpVersion: 7, revision: 3 }),
  );
  session.sendCommand({ type: "setTeamName", team: "A", teamName: "新队名" });
  first.close();
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  // 新身份是普通观众：房主面板与其中的 setTeamName 错误出口均不可见，
  // 通用身份提示是唯一可见渠道。
  second.receive({
    kind: "memberView",
    view: memberView({
      revision: 4,
      self: { memberId: "m5", nickname: "新观众", isHost: false, seatTeam: null },
    }),
  });
  expect(second.sent).toHaveLength(0);
  expect(session.identityNotice.value).toBe("身份已变化，原操作结果未知；请按当前界面继续");
  expect(session.scopeError("setTeamName:A")?.code).toBe(IDENTITY_CHANGED);
  // 用户以新身份发送任一新命令后提示完成使命。
  session.sendCommand({ type: "startBp" });
  expect(session.identityNotice.value).toBeNull();
});

test("无挂起命令的静默身份变化不产生提示", () => {
  const session = createSession(memberView());
  const first = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  first.close();
  vi.advanceTimersByTime(600);
  handles[1]!.receive({
    kind: "memberView",
    view: memberView({
      revision: 4,
      self: { memberId: "m3", nickname: "新观众", isHost: false, seatTeam: null },
    }),
  });
  expect(session.identityNotice.value).toBeNull();
  expect(session.pending.value.size).toBe(0);
});

// ---- 终态与隔离 ----

test("AUTH_FAILED 通知进入终态：不再重连、不再重发核对命令", () => {
  const session = createSession();
  const first = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  first.receive({ kind: "notice", code: "AUTH_FAILED", message: "身份无效" });
  expect(session.status.value).toBe("auth-failed");
  first.close();
  vi.advanceTimersByTime(60_000);
  expect(handles).toHaveLength(1);
  // 挂起命令保持原样（绝不以任何身份重发），由组件销毁时清理。
  expect(session.isScopePending("confirmPreselect")).toBe(true);
});

test("ROOM_NOT_FOUND 通知进入 room-gone 终态", () => {
  const session = createSession();
  const handle = connectAndSync(session, memberView());
  handle.receive({ kind: "notice", code: "ROOM_NOT_FOUND", message: "房间不存在" });
  expect(session.status.value).toBe("room-gone");
  handle.close();
  vi.advanceTimersByTime(60_000);
  expect(handles).toHaveLength(1);
});

test("旧连接的迟到消息被隔离：不覆盖视图、不触发重发", () => {
  const session = createSession(memberView({ revision: 3 }));
  const first = connectAndSync(session, memberView({ revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  first.close();
  vi.advanceTimersByTime(600);
  const second = handles[1]!;
  second.receive({ kind: "memberView", view: memberView({ revision: 4 }) });
  expect(second.sent).toHaveLength(1);
  // 第一条连接已被替换：其迟到视图/回执不再影响会话。
  first.receive({ kind: "memberView", view: memberView({ revision: 9, roomName: "污染" }) });
  expect(session.view.value?.revision).toBe(4);
  expect(session.view.value?.roomName).toBe("测试杯");
  first.receive(receipt("op-1", false));
  expect(session.isScopePending("confirmPreselect")).toBe(true);
});

test("不符合共享 schema 的服务端消息被忽略，不覆盖视图", () => {
  const errors: string[] = [];
  const session = createSession(memberView({ revision: 3 }), {
    onError: (message) => {
      errors.push(message);
    },
  });
  const handle = connectAndSync(session, memberView({ revision: 3 }));
  handle.receive({ kind: "memberView", view: { roomName: 42 } });
  expect(session.view.value?.revision).toBe(3);
  handle.receive("not-json{");
  expect(session.view.value?.revision).toBe(3);
  expect(errors.length).toBeGreaterThan(0);
});

test("stop 后不再建立新连接，全部计时器清理", () => {
  const session = createSession();
  const handle = connectAndSync(session, memberView({ bpVersion: 7, revision: 3 }));
  session.sendCommand({ type: "confirmPreselect", slotId: "AB1" });
  session.stop();
  handle.close();
  vi.advanceTimersByTime(120_000);
  expect(handles).toHaveLength(1);
  expect(session.status.value).toBe("stopped");
  // 回执期限计时器已清理：挂起命令被放弃，不再产生任何状态变化。
  expect(session.pending.value.size).toBe(0);
});
