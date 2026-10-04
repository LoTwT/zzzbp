import { evictDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agentCatalogData } from "../../shared/agents/catalog";
import { BP_STEPS } from "../../shared/bp/steps";
import {
  currentAlarm,
  createRoomViaHttp,
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
    client.send({ type, ...extra, operationId, expectedBpVersion: await currentBpVersion() });
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

describe("空房计时元数据（PR9 前：只记录，无 Alarm/到期执行）", () => {
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

  it("连接与断开路径不设置任何 Alarm（到期执行与裁决在 PR9）", async () => {
    const host = await createRoomViaHttp("无 Alarm 赛", "主持人");
    const client = await TestWsClient.connectMember(host.roomId, host.secret);
    await client.next("hostView");
    expect(await currentAlarm(host.roomId)).toBeNull();
    client.close();
    expect(await waitMemberOnline(host.roomId, host.memberId, 0)).toBe(true);
    expect(await currentAlarm(host.roomId)).toBeNull();
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
