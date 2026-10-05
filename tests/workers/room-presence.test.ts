import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { agentCatalogData } from "../../shared/agents/catalog";
import { BP_STEPS } from "../../shared/bp/steps";
import {
  currentAlarm,
  createRoomViaHttp,
  currentRevisionOf,
  execInRoom,
  joinMemberViaHttp,
  queryRoomRows,
  TestWsClient,
  waitForRoomQuery,
  type TestMember,
} from "./ws-helpers";

// Workers 集成测试：成员在线计数（多页面）、掉线暂停与观众区别、暂停
// 规则与换人、空房计时元数据、DO 实例重建与休眠（连接保留）语义。

const AGENT_IDS = agentCatalogData.agents.slice(0, BP_STEPS.length).map((agent) => agent.id);

/** 等待某成员的在线标志变为期望值（SQL 轮询观察真实持久状态）。 */
function waitMemberOnline(roomId: string, memberId: string, expected: 0 | 1, timeoutMs = 3000) {
  return waitForRoomQuery(
    roomId,
    `SELECT online FROM members WHERE member_id = '${memberId}'`,
    "online",
    expected,
    timeoutMs,
  );
}

/** 读取某成员的在线标志。 */
async function memberOnline(roomId: string, memberId: string): Promise<number> {
  const rows = await queryRoomRows(
    roomId,
    `SELECT online FROM members WHERE member_id = '${memberId}'`,
  );
  return Number(rows[0]?.online);
}

/** 房间入口的 lastMemberLeftAt（经 DO RPC 读取内部字段）。 */
async function lastMemberLeftAt(roomId: string): Promise<string | null> {
  const entry = await exports.Room.get(exports.Room.idFromName(roomId)).getRoomEntry({
    credentialDigest: null,
  });
  if (entry.kind !== "live") throw new Error("房间不存在");
  return entry.lastMemberLeftAt;
}

/** 已安装「关闭中连接仍被枚举」包装的房间 → 原 ctx（供恢复）。 */
const savedContexts = new Map<string, object>();

/**
 * 测试侧最小可恢复包装：复现线上观测到的 close 回调注册表边界。
 *
 * 线上证据（2026-10-05，preview）：close 回调触发时，被关闭的连接
 * readyState=2（CLOSING）且仍被 getWebSockets 枚举。本测试环境的 workerd
 * 在回调前已把连接移出注册表（关闭回调内 listed=false），因此这里把指定
 * 成员的真实连接对象追加进 getWebSockets 结果：回调期间该对象即为
 * CLOSING，完全关闭后为 CLOSED，从而在真实房间与真实关闭回调上复现
 * 「仍能枚举到 CLOSING/CLOSED 成员连接」这一线上 API 边界。包装只影响
 * 当前实例的注册表读取，可用 restoreRoomContext 还原。
 */
async function keepMemberSocketListed(roomId: string, memberId: string): Promise<void> {
  const stub = exports.Room.get(exports.Room.idFromName(roomId));
  await runInDurableObject(stub, (instance, state) => {
    const target = state.getWebSockets().find((socket) => {
      const attachment = socket.deserializeAttachment() as {
        kind?: unknown;
        memberId?: unknown;
      } | null;
      return attachment?.kind === "member" && attachment.memberId === memberId;
    });
    if (target === undefined) throw new Error(`未找到成员 ${memberId} 的连接`);

    const context = (instance as unknown as { ctx: object }).ctx;
    if (!savedContexts.has(roomId)) savedContexts.set(roomId, context);
    const patched = new Proxy(context, {
      get(targetCtx, property) {
        if (property === "getWebSockets") {
          return () =>
            (targetCtx as { getWebSockets(): WebSocket[] }).getWebSockets().concat(target);
        }
        const value = Reflect.get(targetCtx, property, targetCtx) as unknown;
        return typeof value === "function" ? value.bind(targetCtx) : value;
      },
    });
    Object.defineProperty(instance, "ctx", { value: patched, configurable: true });
  });
}

/** 还原被包装的 ctx；未包装时为无操作。 */
async function restoreRoomContext(roomId: string): Promise<void> {
  const original = savedContexts.get(roomId);
  if (original === undefined) return;
  savedContexts.delete(roomId);
  const stub = exports.Room.get(exports.Room.idFromName(roomId));
  await runInDurableObject(stub, (instance) => {
    Object.defineProperty(instance, "ctx", { value: original, configurable: true });
  });
}

/** 轮询等待空房期限 Alarm 写入（观察，不触发任何业务入口）。 */
async function waitForAlarm(roomId: string, timeoutMs = 3000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alarm = await currentAlarm(roomId);
    if (alarm !== null) return alarm;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 开局环境：房主 + 两名在席选手，全部已连接，BP 进行中。 */
async function runningRoom(roomName = "在线赛") {
  const host = await createRoomViaHttp(roomName, "主持人");
  const playerA = await joinMemberViaHttp(host.roomId, "选手甲");
  const playerB = await joinMemberViaHttp(host.roomId, "选手乙");

  const hostWs = await TestWsClient.connectMember(host.roomId, host.secret);
  const aWs = await TestWsClient.connectMember(host.roomId, playerA.secret);
  const bWs = await TestWsClient.connectMember(host.roomId, playerB.secret);
  await hostWs.next("hostView");
  await aWs.next("memberView");
  await bWs.next("memberView");

  // 掉线暂停等系统入口也会推进 bp.version，命令结果的本地跟踪不可靠；
  // 每次发送前从持久状态读取当前版本。
  const currentBpVersion = async (): Promise<number> =>
    Number(
      (await queryRoomRows(host.roomId, "SELECT bp_version FROM room_meta"))[0]?.bp_version ?? 0,
    );

  const send = async (
    client: TestWsClient,
    type: string,
    extra: Record<string, unknown>,
    member: TestMember,
  ) => {
    const operationId = `presence-${crypto.randomUUID()}`;
    client.send({
      type,
      ...extra,
      operationId,
      expectedBpVersion: await currentBpVersion(),
      // setTeamName 需要 revision 前置条件，缺省取当前值。
      ...(type === "setTeamName" ? { expectedRevision: await currentRevisionOf(host.roomId) } : {}),
    });
    const result = await client.commandResult(operationId);
    expect(result.ok, `${member.nickname} ${type} 应成功：${result.error?.code ?? ""}`).toBe(true);
    return result;
  };

  /** 以显式载荷发送（用于预期失败的命令）。 */
  const sendRaw = (
    client: TestWsClient,
    operationId: string,
    payload: Record<string, unknown>,
    version: number,
  ) => {
    client.send({ ...payload, operationId, expectedBpVersion: version });
  };

  await send(hostWs, "setTeamName", { team: "A", teamName: "左方" }, host);
  await send(hostWs, "setTeamName", { team: "B", teamName: "右方" }, host);
  await send(hostWs, "assignSeat", { team: "A", targetMemberId: playerA.memberId }, host);
  await send(hostWs, "assignSeat", { team: "B", targetMemberId: playerB.memberId }, host);
  await send(hostWs, "startBp", {}, host);

  /** 等待 hostWs 上满足条件的 hostView。 */
  const waitForHostView = (predicate: (view: Record<string, unknown>) => boolean, label: string) =>
    hostWs.waitFor((message) => {
      try {
        const parsed = JSON.parse(message ?? "") as {
          kind?: string;
          view?: Record<string, unknown>;
        };
        return parsed.kind === "hostView" && parsed.view !== undefined && predicate(parsed.view);
      } catch {
        return false;
      }
    }, label);

  return {
    host,
    playerA,
    playerB,
    hostWs,
    aWs,
    bWs,
    send,
    sendRaw,
    currentBpVersion,
    waitForHostView,
  };
}

describe("多页面在线计数", () => {
  it("至少一个页面在线则成员在线；最后一个断开才离线", async () => {
    const host = await createRoomViaHttp("多页面赛", "主持人");
    const page1 = await TestWsClient.connectMember(host.roomId, host.secret);
    await page1.next("hostView");
    expect(await memberOnline(host.roomId, host.memberId)).toBe(1);

    const page2 = await TestWsClient.connectMember(host.roomId, host.secret);
    await page2.next("hostView");
    expect(await memberOnline(host.roomId, host.memberId)).toBe(1);

    // 关闭其中一个页面：仍在线。
    page1.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await memberOnline(host.roomId, host.memberId)).toBe(1);

    // 关闭最后一个页面：离线。
    page2.close();
    expect(await waitMemberOnline(host.roomId, host.memberId, 0)).toBe(true);
  });

  it("房主管理视图实时反映成员在线状态变化", async () => {
    const host = await createRoomViaHttp("在线视图赛", "主持人");
    const member = await joinMemberViaHttp(host.roomId, "成员");
    const hostWs = await TestWsClient.connectMember(host.roomId, host.secret);
    await hostWs.next("hostView");

    const memberWs = await TestWsClient.connectMember(host.roomId, member.secret);
    await memberWs.next("memberView");
    expect(
      await hostWs.waitFor((message) => {
        try {
          const parsed = JSON.parse(message ?? "") as {
            kind?: string;
            view?: { members?: { memberId: string; online: boolean }[] };
          };
          return (
            parsed.kind === "hostView" &&
            parsed.view?.members?.some((m) => m.memberId === member.memberId && m.online) === true
          );
        } catch {
          return false;
        }
      }, "成员上线后的 hostView"),
    ).not.toBeNull();

    memberWs.close();
    expect(
      await hostWs.waitFor((message) => {
        try {
          const parsed = JSON.parse(message ?? "") as {
            kind?: string;
            view?: { members?: { memberId: string; online: boolean }[] };
          };
          return (
            parsed.kind === "hostView" &&
            parsed.view?.members?.some((m) => m.memberId === member.memberId && !m.online) === true
          );
        } catch {
          return false;
        }
      }, "成员离线后的 hostView"),
    ).not.toBeNull();
    hostWs.close();
  });
});

describe("掉线暂停与观众区别", () => {
  it("在席选手全部页面断开立即暂停；观众断开不暂停；重连不自动恢复", async () => {
    const room = await runningRoom("掉线赛");
    expect(
      await room.waitForHostView((view) => view.bpStatus === "running", "开局后的 running 视图"),
    ).not.toBeNull();

    // 观众断开：不影响进行中的 BP。
    const spectator = await joinMemberViaHttp(room.host.roomId, "观众");
    const spectatorWs = await TestWsClient.connectMember(room.host.roomId, spectator.secret);
    await spectatorWs.next("memberView");
    spectatorWs.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await memberOnline(room.host.roomId, spectator.memberId)).toBe(0);
    const afterSpectator = await queryRoomRows(room.host.roomId, "SELECT bp_status FROM room_meta");
    expect(afterSpectator).toEqual([{ bp_status: "running" }]);

    // 选手 B 全部页面断开：立即暂停并广播。
    room.bWs.close();
    expect(
      await room.waitForHostView((view) => view.bpStatus === "paused", "掉线暂停后的 hostView"),
    ).not.toBeNull();
    expect(await queryRoomRows(room.host.roomId, "SELECT bp_status FROM room_meta")).toEqual([
      { bp_status: "paused" },
    ]);

    // B 重连：恢复身份与席位，但保持暂停（不自动恢复 BP）。
    const bReconnected = await TestWsClient.connectMember(room.host.roomId, room.playerB.secret);
    const bView = await bReconnected.next("memberView");
    expect(bView.view.self.seatTeam).toBe("B");
    expect(bView.view.bpStatus).toBe("paused");
    expect(await queryRoomRows(room.host.roomId, "SELECT bp_status FROM room_meta")).toEqual([
      { bp_status: "paused" },
    ]);

    // 房主手动恢复。
    await room.send(room.hostWs, "resumeBp", {}, room.host);
    expect(
      await room.waitForHostView((view) => view.bpStatus === "running", "恢复后的 hostView"),
    ).not.toBeNull();

    // 房主掉线（选手在线）：同样立即暂停。
    room.hostWs.close();
    expect(
      await bReconnected.waitFor((message) => {
        try {
          const parsed = JSON.parse(message ?? "") as {
            kind?: string;
            view?: { bpStatus?: string };
          };
          return parsed.kind === "memberView" && parsed.view?.bpStatus === "paused";
        } catch {
          return false;
        }
      }, "房主掉线后的暂停视图"),
    ).not.toBeNull();

    room.aWs.close();
    bReconnected.close();
  });
});

describe("暂停规则与换人（服务端规则）", () => {
  it("暂停保留预选、禁止新预选/提交；房主可把自己换上场且旧选手立即失权", async () => {
    const room = await runningRoom("换人赛");
    expect(
      (
        await room.send(
          room.aWs,
          "setPreselect",
          { slotId: "AB1", agentId: AGENT_IDS[0] },
          room.playerA,
        )
      ).ok,
    ).toBe(true);

    // 房主主动暂停：预选保留。
    await room.send(room.hostWs, "pauseBp", {}, room.host);
    expect(
      await room.waitForHostView(
        (view) => view.bpStatus === "paused" && view.preselect === AGENT_IDS[0],
        "暂停后保留预选的 hostView",
      ),
    ).not.toBeNull();

    // 暂停期间选手不能新建/更换预选，也不能提交。
    room.aWs.send({
      type: "setPreselect",
      slotId: "AB1",
      agentId: AGENT_IDS[1],
      operationId: "paused-preselect",
      expectedBpVersion: await room.currentBpVersion(),
    });
    const denied = await room.aWs.commandResult("paused-preselect");
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("BP_NOT_RUNNING");

    // 暂停期间房主把自己换上 A 席（房主未占席）。
    await room.send(
      room.hostWs,
      "assignSeat",
      { team: "A", targetMemberId: room.host.memberId },
      room.host,
    );

    // 旧选手立即失去席位操作权：以最新版本发送提交仍被拒。
    room.sendRaw(
      room.aWs,
      "old-player-confirm",
      { type: "confirmPreselect", slotId: "AB1" },
      await room.currentBpVersion(),
    );
    const revoked = await room.aWs.commandResult("old-player-confirm");
    expect(revoked.ok).toBe(false);
    expect(revoked.error?.code).toBe("NOT_CURRENT_PLAYER");
    // 视图中旧选手变回观众，预选保留给新操作者处理。
    const revokedView = await room.aWs.next("memberView");
    expect(revokedView.view.self.seatTeam).toBeNull();

    // 房主不能再占第二席。
    room.sendRaw(
      room.hostWs,
      "second-seat",
      { type: "assignSeat", team: "B", targetMemberId: room.host.memberId },
      await room.currentBpVersion(),
    );
    const secondSeat = await room.hostWs.commandResult("second-seat");
    expect(secondSeat.ok).toBe(false);
    expect(secondSeat.error?.code).toBe("SEAT_TARGET_ALREADY_SEATED");

    // 暂停期间新任 A 席选手（房主）同样不能预选：暂停限制对所有操作者生效。
    room.sendRaw(
      room.hostWs,
      "host-preselect-while-paused",
      { type: "setPreselect", slotId: "AB1", agentId: AGENT_IDS[0] },
      await room.currentBpVersion(),
    );
    const hostDenied = await room.hostWs.commandResult("host-preselect-while-paused");
    expect(hostDenied.ok).toBe(false);
    expect(hostDenied.error?.code).toBe("BP_NOT_RUNNING");

    // 恢复后新任选手操作当前位并提交。
    await room.send(room.hostWs, "resumeBp", {}, room.host);
    await room.send(
      room.hostWs,
      "setPreselect",
      { slotId: "AB1", agentId: AGENT_IDS[0] },
      room.host,
    );
    expect(
      (await room.send(room.hostWs, "confirmPreselect", { slotId: "AB1" }, room.host)).ok,
    ).toBe(true);
    expect(
      await room.waitForHostView(
        (view) => Array.isArray(view.submissions) && view.submissions.length === 1,
        "换人后提交成功的 hostView",
      ),
    ).not.toBeNull();

    room.aWs.close();
    room.bWs.close();
    room.hostWs.close();
  });
});

describe("空房计时元数据与 Alarm 调度（PR9 生命周期）", () => {
  it("成员连接取消计时；最后一名成员离开重新记录；展示与 HTTP 读取不影响", async () => {
    const host = await createRoomViaHttp("计时赛", "主持人");
    const roomId = host.roomId;
    // 初始：last_member_left_at = 创建时刻。
    const createdAt = (await queryRoomRows(roomId, "SELECT created_at FROM room_meta"))[0]
      ?.created_at;
    expect(await lastMemberLeftAt(roomId)).toBe(createdAt);

    // 匿名 HTTP 读取与目录读取不取消计时。
    await exports.default.fetch(`http://localhost/api/rooms/${roomId}`);
    await exports.default.fetch(`http://localhost/api/rooms/${roomId}/catalog`);
    expect(await lastMemberLeftAt(roomId)).toBe(createdAt);

    // 成员连接：取消计时。
    const hostWs = await TestWsClient.connectMember(roomId, host.secret);
    await hostWs.next("hostView");
    expect(await lastMemberLeftAt(roomId)).toBeNull();

    // 展示连接不影响（成员仍在线，计时已取消）。
    const display = await TestWsClient.connectDisplay(roomId);
    await display.next("displayView");
    expect(await lastMemberLeftAt(roomId)).toBeNull();

    // 全员离开：写计时；展示连接仍在也不阻止记录。
    hostWs.close();
    expect(await waitMemberOnline(roomId, host.memberId, 0)).toBe(true);
    const leftAt = await lastMemberLeftAt(roomId);
    expect(leftAt).not.toBeNull();
    expect(leftAt === createdAt).toBe(false);

    // 只有展示连接时再次读取：计时不变。
    await exports.default.fetch(`http://localhost/api/rooms/${roomId}`);
    expect(await lastMemberLeftAt(roomId)).toBe(leftAt);
    display.close();

    // 成员再次连接：取消本次计时；再次全员离开：重新记录（新值）。
    const reconnected = await TestWsClient.connectMember(roomId, host.secret);
    await reconnected.next("hostView");
    expect(await lastMemberLeftAt(roomId)).toBeNull();
    reconnected.close();
    expect(await waitMemberOnline(roomId, host.memberId, 0)).toBe(true);
    const leftAgain = await lastMemberLeftAt(roomId);
    expect(leftAgain).not.toBeNull();
  });

  it("Alarm 随生命周期调度：建防空房期限、连接取消、全员离开按新期限重设", async () => {
    const host = await createRoomViaHttp("Alarm 调度赛", "主持人");
    const roomId = host.roomId;

    // 建房即调度空房期限：createdAt + 12h（从未有成员连接的自创建起计）。
    const createdAt = Date.parse(
      String((await queryRoomRows(roomId, "SELECT created_at FROM room_meta"))[0]?.created_at),
    );
    const createdAlarm = await currentAlarm(roomId);
    expect(createdAlarm).not.toBeNull();
    expect(Math.abs((createdAlarm ?? 0) - (createdAt + 12 * 60 * 60 * 1000))).toBeLessThanOrEqual(
      5_000,
    );

    // 成员连接：取消计时与 Alarm（期限前回归取消本次到期）。
    const client = await TestWsClient.connectMember(roomId, host.secret);
    await client.next("hostView");
    expect(await lastMemberLeftAt(roomId)).toBeNull();
    expect(await currentAlarm(roomId)).toBeNull();

    // 全员离开：按新的离开时间重设 Alarm（不沿用建房的旧期限）。
    client.close();
    expect(await waitMemberOnline(roomId, host.memberId, 0)).toBe(true);
    const leftAt = Date.parse(String(await lastMemberLeftAt(roomId)));
    const leftAlarm = await currentAlarm(roomId);
    expect(leftAlarm).not.toBeNull();
    expect(Math.abs((leftAlarm ?? 0) - (leftAt + 12 * 60 * 60 * 1000))).toBeLessThanOrEqual(5_000);
    expect(leftAlarm ?? 0).toBeGreaterThan(createdAt + 12 * 60 * 60 * 1000);
  });
});

describe("DO 实例重建与休眠恢复", () => {
  it("拆除实例后重连：状态、席位、预选与身份全部从 SQLite 恢复", async () => {
    const room = await runningRoom("重建赛");
    // 推进两步并留下未确认的预选。
    await room.send(
      room.aWs,
      "setPreselect",
      { slotId: "AB1", agentId: AGENT_IDS[0] },
      room.playerA,
    );
    await room.send(room.aWs, "confirmPreselect", { slotId: "AB1" }, room.playerA);
    await room.send(
      room.bWs,
      "setPreselect",
      { slotId: "BB1", agentId: AGENT_IDS[1] },
      room.playerB,
    );
    await room.waitForHostView((view) => view.preselect === AGENT_IDS[1], "预选设置后的 hostView");

    room.hostWs.close();
    room.aWs.close();
    room.bWs.close();
    await waitMemberOnline(room.host.roomId, room.host.memberId, 0);
    await waitMemberOnline(room.host.roomId, room.playerA.memberId, 0);
    await waitMemberOnline(room.host.roomId, room.playerB.memberId, 0);

    // 拆除实例（保留持久存储）。
    await evictDurableObject(exports.Room.get(exports.Room.idFromName(room.host.roomId)));

    // 重连：最新持久视图恢复。全员断开时掉线暂停已生效，重连不自动恢复。
    const hostWs = await TestWsClient.connectMember(room.host.roomId, room.host.secret);
    const view = await hostWs.next("hostView");
    expect(view.view.bpStatus).toBe("paused");
    expect(view.view.currentSlotId).toBe("BB1");
    expect(view.view.submissions).toHaveLength(1);
    expect(view.view.preselect).toBe(AGENT_IDS[1]);
    expect(
      view.view.members.find((member) => member.memberId === room.playerA.memberId)?.seatTeam,
    ).toBe("A");
    expect(view.view.members.find((member) => member.memberId === room.host.memberId)?.online).toBe(
      true,
    );

    // 选手身份恢复：B 方选手重连取得席位与版本，房主手动恢复后完成提交。
    const bWs = await TestWsClient.connectMember(room.host.roomId, room.playerB.secret);
    const bView = await bWs.next("memberView");
    expect(bView.view.self.seatTeam).toBe("B");
    expect(bView.view.bpStatus).toBe("paused");

    hostWs.send({
      type: "resumeBp",
      operationId: "after-rebuild-resume",
      expectedBpVersion: view.view.bpVersion,
    });
    const resumed = await hostWs.commandResult("after-rebuild-resume");
    expect(resumed.ok).toBe(true);

    bWs.send({
      type: "confirmPreselect",
      slotId: "BB1",
      operationId: "after-rebuild-confirm",
      expectedBpVersion: resumed.bpVersion,
    });
    const confirm = await bWs.commandResult("after-rebuild-confirm");
    expect(confirm.ok).toBe(true);

    hostWs.close();
    bWs.close();
  });

  it("休眠语义：实例重建但连接保留——附件身份唤醒命令，断开由重建实例清理", async () => {
    const host = await createRoomViaHttp("休眠赛", "主持人");
    const client = await TestWsClient.connectMember(host.roomId, host.secret);
    await client.next("hostView");

    // 拆除实例：连接由运行时保留（真实休眠机制，非模拟）。
    await evictDurableObject(exports.Room.get(exports.Room.idFromName(host.roomId)));

    // 原连接上发送命令：唤醒新实例，身份从附件恢复，命令照常执行。
    client.send({
      type: "setTeamName",
      team: "A",
      teamName: "唤醒后队名",
      operationId: "wake-command",
      expectedBpVersion: 0,
      expectedRevision: await currentRevisionOf(host.roomId),
    });
    const woken = await client.commandResult("wake-command");
    expect(woken.ok).toBe(true);
    expect(
      await queryRoomRows(host.roomId, "SELECT name FROM team_names WHERE team = 'A'"),
    ).toEqual([{ name: "唤醒后队名" }]);
    // 唤醒不重复计入在线（成员保持在线，没有第二次上线转移）。
    expect(await memberOnline(host.roomId, host.memberId)).toBe(1);

    // 唤醒后的视图推送反映最新状态。
    const view = await client.next("hostView");
    expect(view.view.teamNames.A).toBe("唤醒后队名");

    // 连接断开：由重建后的实例处理 close，在线与计时正常清理。
    client.close();
    expect(await waitMemberOnline(host.roomId, host.memberId, 0)).toBe(true);
    expect(await lastMemberLeftAt(host.roomId)).not.toBeNull();
  });
});

describe("在线协调与故障恢复（以实际连接为权威）", () => {
  it("断线写入失败留下幽灵在线：命令拒绝推进，存储恢复后协调补齐暂停", async () => {
    const room = await runningRoom("幽灵在线赛");
    expect(
      (
        await room.send(
          room.aWs,
          "setPreselect",
          { slotId: "AB1", agentId: AGENT_IDS[0] },
          room.playerA,
        )
      ).ok,
    ).toBe(true);

    // 注入故障：成员在线标志更新失败（断线协调会失败并留下幽灵在线）。
    await execInRoom(
      room.host.roomId,
      "CREATE TRIGGER test_presence_fault BEFORE UPDATE OF online ON members BEGIN SELECT RAISE(ABORT, 'test injected presence failure'); END",
    );

    // 选手 B 断开：close 协调失败（事件不丢弃，有界重试链启动并持续失败）。
    room.bWs.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 幽灵在线：注册表里 B 已无连接，但存储仍在线，BP 仍视为进行中。
    expect(await memberOnline(room.host.roomId, room.playerB.memberId)).toBe(1);
    expect(await queryRoomRows(room.host.roomId, "SELECT bp_status FROM room_meta")).toEqual([
      { bp_status: "running" },
    ]);

    // 故障未恢复期间，下一业务命令无法确认在线状态：整体回滚，拒绝推进。
    room.sendRaw(
      room.aWs,
      "ghost-confirm",
      { type: "confirmPreselect", slotId: "AB1" },
      await room.currentBpVersion(),
    );
    const refused = await room.aWs.commandResult("ghost-confirm");
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("INTERNAL");
    expect(
      await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM bp_submissions"),
    ).toEqual([{ n: 0 }]);

    // 存储恢复（移除故障）后再发命令：执行前的在线协调把 B 修正为离线
    // （进行中在席选手掉线立即暂停），确认命令在修正后的暂停状态上被
    // 规则拒绝（有界重试链若先到也是同一结果）。
    await execInRoom(room.host.roomId, "DROP TRIGGER test_presence_fault");
    room.sendRaw(
      room.aWs,
      "ghost-confirm-retry",
      { type: "confirmPreselect", slotId: "AB1" },
      await room.currentBpVersion(),
    );
    const result = await room.aWs.commandResult("ghost-confirm-retry");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BP_NOT_RUNNING");

    // 存储与实际连接对齐：B 离线、BP 暂停、序列未推进。
    expect(await memberOnline(room.host.roomId, room.playerB.memberId)).toBe(0);
    expect(await queryRoomRows(room.host.roomId, "SELECT bp_status FROM room_meta")).toEqual([
      { bp_status: "paused" },
    ]);
    expect(
      await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM bp_submissions"),
    ).toEqual([{ n: 0 }]);

    // 正常恢复仍手动继续：房主 resume 后当前位提交成功。
    await room.send(room.hostWs, "resumeBp", {}, room.host);
    expect(
      (await room.send(room.aWs, "confirmPreselect", { slotId: "AB1" }, room.playerA)).ok,
    ).toBe(true);
    expect(
      await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM bp_submissions"),
    ).toEqual([{ n: 1 }]);
    room.hostWs.close();
    room.aWs.close();
  });

  it("全员离开恰遇短暂故障：有界重试在存储恢复后补齐离线、暂停与全员离开时间", async () => {
    const room = await runningRoom("离线故障赛");
    const roomId = room.host.roomId;

    // 注入故障：任何成员在线标志更新失败（断线与上线转移都会失败）。
    await execInRoom(
      roomId,
      "CREATE TRIGGER test_presence_fault BEFORE UPDATE OF online ON members BEGIN SELECT RAISE(ABORT, 'test injected presence failure'); END",
    );

    // 全员断开：close 协调失败，事件不被丢弃（有界重试链启动）。
    // 用结构化日志 spy 证实 close 回调确实运行且失败（白名单字段，无错误正文）。
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    room.aWs.close();
    room.bWs.close();
    room.hostWs.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const closeFailures = errorSpy.mock.calls.filter(([message]) =>
      String(message).includes('"phase":"close"'),
    );
    expect(closeFailures.length).toBeGreaterThanOrEqual(1);
    errorSpy.mockRestore();

    // 故障期间：存储停留在幽灵在线，BP 仍视为进行中，且保留计时未开始。
    expect(await memberOnline(roomId, room.host.memberId)).toBe(1);
    expect(await queryRoomRows(roomId, "SELECT bp_status FROM room_meta")).toEqual([
      { bp_status: "running" },
    ]);
    expect(await lastMemberLeftAt(roomId)).toBeNull();

    // 存储恢复（移除故障）：重试链在下一次退避点补齐全部状态。
    await execInRoom(roomId, "DROP TRIGGER test_presence_fault");
    expect(
      await waitForRoomQuery(
        roomId,
        `SELECT online FROM members WHERE member_id = '${room.host.memberId}'`,
        "online",
        0,
        8000,
      ),
    ).toBe(true);
    expect(await memberOnline(roomId, room.playerA.memberId)).toBe(0);
    expect(await memberOnline(roomId, room.playerB.memberId)).toBe(0);
    // 掉线暂停补齐，全员离开时间写入（此前因故障从未记录）。
    expect(await queryRoomRows(roomId, "SELECT bp_status FROM room_meta")).toEqual([
      { bp_status: "paused" },
    ]);
    expect(await lastMemberLeftAt(roomId)).not.toBeNull();
  });

  it("首次上线写入失败：连接以 INTERNAL 通知明确关闭，恢复后重连正常上线", async () => {
    const host = await createRoomViaHttp("上线故障赛", "主持人");
    const roomId = host.roomId;
    await execInRoom(
      roomId,
      "CREATE TRIGGER test_connect_fault BEFORE UPDATE OF online ON members WHEN NEW.online = 1 BEGIN SELECT RAISE(ABORT, 'test injected connect failure'); END",
    );

    const client = await TestWsClient.connectMember(roomId, host.secret);
    const notice = await client.next("notice");
    expect(notice.code).toBe("INTERNAL");
    expect((await client.waitForClose("上线失败关闭")).code).toBe(1011);

    // 失败的连接不留下任何有效在线状态：存储仍离线，保留计时未取消。
    expect(await memberOnline(roomId, host.memberId)).toBe(0);
    expect(await lastMemberLeftAt(roomId)).not.toBeNull();

    // 存储恢复后同一身份重连：上线成功、可正常执行命令（不再 ACTOR_OFFLINE）。
    await execInRoom(roomId, "DROP TRIGGER test_connect_fault");
    const reconnected = await TestWsClient.connectMember(roomId, host.secret);
    await reconnected.next("hostView");
    expect(await memberOnline(roomId, host.memberId)).toBe(1);
    expect(await lastMemberLeftAt(roomId)).toBeNull();

    reconnected.send({
      type: "setTeamName",
      team: "A",
      teamName: "恢复后队名",
      operationId: "recovered-team-name",
      expectedBpVersion: 0,
      expectedRevision: await currentRevisionOf(roomId),
    });
    const result = await reconnected.commandResult("recovered-team-name");
    expect(result.ok).toBe(true);
    reconnected.close();
  });

  it("故障期间的掉线不能被快速重连吞掉：重连被拒，恢复后接入前先补暂停", async () => {
    const room = await runningRoom("重连吞暂停赛");
    expect(
      (
        await room.send(
          room.aWs,
          "setPreselect",
          { slotId: "AB1", agentId: AGENT_IDS[0] },
          room.playerA,
        )
      ).ok,
    ).toBe(true);

    // 注入故障：离线写入（NEW.online = 0）失败。
    await execInRoom(
      room.host.roomId,
      "CREATE TRIGGER test_offline_fault BEFORE UPDATE OF online ON members WHEN NEW.online = 0 BEGIN SELECT RAISE(ABORT, 'test injected offline failure'); END",
    );

    // 选手 B 断开最后连接：close 协调失败（已观测离线未落库），重试链启动。
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    room.bWs.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const closeFailures = errorSpy.mock.calls.filter(([message]) =>
      String(message).includes('"phase":"close"'),
    );
    expect(closeFailures.length).toBeGreaterThanOrEqual(1);
    errorSpy.mockRestore();

    // 幽灵在线：B 无连接但存储在线，BP 仍进行中。
    expect(await memberOnline(room.host.roomId, room.playerB.memberId)).toBe(1);
    expect(await queryRoomRows(room.host.roomId, "SELECT bp_status FROM room_meta")).toEqual([
      { bp_status: "running" },
    ]);

    // 故障未恢复期间同凭据重连：接纳前无法确认离线差异，拒绝正常接入
    // （INTERNAL 通知 + 关闭），不留 running 通道。
    const refused = await TestWsClient.connectMember(room.host.roomId, room.playerB.secret);
    const notice = await refused.next("notice");
    expect(notice.code).toBe("INTERNAL");
    expect((await refused.waitForClose("重连被拒")).code).toBe(1011);
    expect(await queryRoomRows(room.host.roomId, "SELECT bp_status FROM room_meta")).toEqual([
      { bp_status: "running" },
    ]);

    // 存储恢复后重连：先补齐 B 的离线与掉线暂停，再接纳上线；视图为
    // paused 且预选保留（不自动恢复）。
    await execInRoom(room.host.roomId, "DROP TRIGGER test_offline_fault");
    const recovered = await TestWsClient.connectMember(room.host.roomId, room.playerB.secret);
    const view = await recovered.next("memberView");
    expect(view.view.self.seatTeam).toBe("B");
    expect(view.view.self.nickname).toBe("选手乙");
    expect(view.view.bpStatus).toBe("paused");
    expect(view.view.preselect).toBe(AGENT_IDS[0]);
    expect(view.view.currentSlotId).toBe("AB1");
    // 存储对齐：B 重新在线，BP 暂停（房主与 A 也收到暂停广播）。
    expect(await memberOnline(room.host.roomId, room.playerB.memberId)).toBe(1);
    expect(await queryRoomRows(room.host.roomId, "SELECT bp_status FROM room_meta")).toEqual([
      { bp_status: "paused" },
    ]);
    expect(
      await room.waitForHostView((view) => view.bpStatus === "paused", "重连补暂停后的 hostView"),
    ).not.toBeNull();

    // 手动 resume 前 confirm 被拒；房主 resume 后当前位提交成功。
    room.sendRaw(
      room.aWs,
      "confirm-before-resume",
      { type: "confirmPreselect", slotId: "AB1" },
      await room.currentBpVersion(),
    );
    const denied = await room.aWs.commandResult("confirm-before-resume");
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("BP_NOT_RUNNING");

    await room.send(room.hostWs, "resumeBp", {}, room.host);
    expect(
      (await room.send(room.aWs, "confirmPreselect", { slotId: "AB1" }, room.playerA)).ok,
    ).toBe(true);
    expect(
      await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM bp_submissions"),
    ).toEqual([{ n: 1 }]);
    recovered.close();
    room.hostWs.close();
    room.aWs.close();
  });

  it("房主掉线重连沿用同一接纳语义：恢复后接入前先补暂停", async () => {
    const room = await runningRoom("房主重连赛");
    await execInRoom(
      room.host.roomId,
      "CREATE TRIGGER test_offline_fault BEFORE UPDATE OF online ON members WHEN NEW.online = 0 BEGIN SELECT RAISE(ABORT, 'test injected offline failure'); END",
    );

    // 房主断开（不占席，房主掉线同样应暂停）：协调失败留下幽灵在线。
    room.hostWs.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await memberOnline(room.host.roomId, room.host.memberId)).toBe(1);

    // 故障期间重连被拒；恢复后重连拿到 paused 的房主视图，手动 resume 前不继续。
    const refused = await TestWsClient.connectMember(room.host.roomId, room.host.secret);
    expect((await refused.next("notice")).code).toBe("INTERNAL");
    await refused.waitForClose("重连被拒");

    await execInRoom(room.host.roomId, "DROP TRIGGER test_offline_fault");
    const recovered = await TestWsClient.connectMember(room.host.roomId, room.host.secret);
    const view = await recovered.next("hostView");
    expect(view.view.bpStatus).toBe("paused");
    await room.send(recovered, "resumeBp", {}, room.host);
    expect(
      await room.waitForHostView((view) => view.bpStatus === "running", "房主恢复后的 hostView"),
    ).not.toBeNull();
    room.aWs.close();
    room.bWs.close();
    recovered.close();
  });
});

describe("关闭回调的注册表边界（线上观测复现）", () => {
  it("关闭中成员连接仍被枚举时：在席选手掉线立即暂停并广播，全员离开后计时与 Alarm 正常", async () => {
    const room = await runningRoom("关闭边界赛");
    const roomId = room.host.roomId;
    expect(
      await room.waitForHostView((view) => view.bpStatus === "running", "开局后的 running 视图"),
    ).not.toBeNull();
    const display = await TestWsClient.connectDisplay(roomId);
    await display.next("displayView");

    // 复现线上边界：B 的关闭中连接在 close 回调期间仍会被 getWebSockets 枚举。
    await keepMemberSocketListed(roomId, room.playerB.memberId);

    // B（在席选手）全部页面断开：close 路径应立即判离线并暂停，直接向
    // host/display 广播最新视图；不依赖 HTTP 读取或新命令触发补偿。
    room.bWs.close();
    expect(
      await room.waitForHostView((view) => view.bpStatus === "paused", "B 掉线后的 hostView"),
    ).not.toBeNull();
    expect(
      await display.waitFor((message) => {
        try {
          const parsed = JSON.parse(message ?? "") as {
            kind?: string;
            view?: { bpStatus?: string };
          };
          return parsed.kind === "displayView" && parsed.view?.bpStatus === "paused";
        } catch {
          return false;
        }
      }, "B 掉线后的 displayView（暂停）"),
    ).not.toBeNull();
    expect(await queryRoomRows(roomId, "SELECT bp_status FROM room_meta")).toEqual([
      { bp_status: "paused" },
    ]);
    expect(await memberOnline(roomId, room.playerB.memberId)).toBe(0);

    // 全员离开：追加枚举的关闭连接（此时已是 CLOSED）不阻止全员离开计时，
    // 空房期限 Alarm 按新的离开时间调度。
    room.hostWs.close();
    room.aWs.close();
    expect(await waitMemberOnline(roomId, room.playerA.memberId, 0)).toBe(true);
    expect(await waitMemberOnline(roomId, room.host.memberId, 0)).toBe(true);
    const leftAt = await lastMemberLeftAt(roomId);
    expect(leftAt).not.toBeNull();
    const alarm = await waitForAlarm(roomId);
    expect(alarm).not.toBeNull();
    expect(
      Math.abs((alarm ?? 0) - (Date.parse(leftAt ?? "") + 12 * 60 * 60 * 1000)),
    ).toBeLessThanOrEqual(5_000);

    display.close(1000);
    const displayClose = await display.waitForClose("展示连接关闭");
    expect(displayClose.wasClean).toBe(true);
    expect(displayClose.code).toBe(1000);
    await restoreRoomContext(roomId);
  });

  it("关闭中页面仍被枚举时同身份其他 OPEN 页面保持在线，最后一页离开才离线", async () => {
    const host = await createRoomViaHttp("多页面边界赛", "主持人");
    const roomId = host.roomId;
    const page1 = await TestWsClient.connectMember(roomId, host.secret);
    await page1.next("hostView");
    const page2 = await TestWsClient.connectMember(roomId, host.secret);
    await page2.next("hostView");
    expect(await memberOnline(roomId, host.memberId)).toBe(1);

    await keepMemberSocketListed(roomId, host.memberId);
    // 关闭其中一个页面：仍有一个 OPEN 页面，成员保持在线（多页面语义）。
    page1.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await memberOnline(roomId, host.memberId)).toBe(1);

    // 最后一页离开：关闭中/已关闭的残留连接不能把成员继续算作在线。
    page2.close();
    expect(await waitMemberOnline(roomId, host.memberId, 0)).toBe(true);
    expect(await lastMemberLeftAt(roomId)).not.toBeNull();
    await restoreRoomContext(roomId);
  });
});
