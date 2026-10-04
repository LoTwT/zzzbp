import { evictDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agentCatalogData } from "../../shared/agents/catalog";
import { BP_STEPS } from "../../shared/bp/steps";
import {
  controlledCredential,
  createRoomViaHttp,
  execInRoom,
  joinMemberViaHttp,
  queryRoomRows,
  TestWsClient,
  type TestMember,
} from "./ws-helpers";

// Workers 集成测试：命令处理管线——完整 26 步 BP、权限与前提失败、
// operationId 持久化去重回执、SQL 故障原子回滚与规则版本门。
// 通道边界与在线计数见 room-websocket.test.ts 与 room-presence.test.ts。

/** 全流程使用的固定名单：26 名互不重复的代理人（来自构建目录产物）。 */
const FLOW_AGENT_IDS = agentCatalogData.agents.slice(0, BP_STEPS.length).map((agent) => agent.id);

/** 一间已开局房间的完整连接环境。 */
interface StartedRoom {
  readonly host: TestMember;
  readonly playerA: TestMember;
  readonly playerB: TestMember;
  readonly hostWs: TestWsClient;
  readonly aWs: TestWsClient;
  readonly bWs: TestWsClient;
  /** 当前 bp.version（随成功命令推进）。 */
  bpVersion: number;
  /** 已发出的 operationId 计数。 */
  operationCounter: number;
}

/**
 * 建房 → 两名选手入房 → 三方 WS 连接 → 设队名、分席、开始 BP。
 * 返回后房间处于 running、AB1 待操作。
 */
async function startBpRoom(roomName = "命令管线赛"): Promise<StartedRoom> {
  const host = await createRoomViaHttp(roomName, "主持人");
  const playerA = await joinMemberViaHttp(host.roomId, "选手甲");
  const playerB = await joinMemberViaHttp(host.roomId, "选手乙");

  const hostWs = await TestWsClient.connectMember(host.roomId, host.secret);
  const aWs = await TestWsClient.connectMember(host.roomId, playerA.secret);
  const bWs = await TestWsClient.connectMember(host.roomId, playerB.secret);
  // 消费初始视图，避免与后续广播混淆。
  await hostWs.next("hostView");
  await aWs.next("memberView");
  await bWs.next("memberView");

  const room: StartedRoom = {
    host,
    playerA,
    playerB,
    hostWs,
    aWs,
    bWs,
    bpVersion: 0,
    operationCounter: 0,
  };

  expect(
    (await roomCommand(room, room.hostWs, "setTeamName", { team: "A", teamName: "左方" })).ok,
  ).toBe(true);
  expect(
    (await roomCommand(room, room.hostWs, "setTeamName", { team: "B", teamName: "右方" })).ok,
  ).toBe(true);
  expect(
    (
      await roomCommand(room, room.hostWs, "assignSeat", {
        team: "A",
        targetMemberId: playerA.memberId,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await roomCommand(room, room.hostWs, "assignSeat", {
        team: "B",
        targetMemberId: playerB.memberId,
      })
    ).ok,
  ).toBe(true);
  expect((await roomCommand(room, room.hostWs, "startBp", {})).ok).toBe(true);
  return room;
}

/** 发送一条命令并等待结果；成功时推进本地 bpVersion 视图。 */
async function command(
  client: TestWsClient,
  type: string,
  extra: Record<string, unknown>,
  options: { expectedBpVersion: number; operationId?: string },
): Promise<{
  ok: boolean;
  error: { code: string; message: string } | null;
  bpVersion: number;
  revision: number;
}> {
  const operationId = options.operationId ?? `op-${crypto.randomUUID()}`;
  client.send({
    type,
    ...extra,
    operationId,
    expectedBpVersion: options.expectedBpVersion,
  });
  return await client.commandResult(operationId);
}

/** 按 StartedRoom 的当前版本发送命令。 */
async function roomCommand(
  room: StartedRoom,
  client: TestWsClient,
  type: string,
  extra: Record<string, unknown>,
  options: { expectedBpVersion?: number; operationId?: string } = {},
) {
  const result = await command(client, type, extra, {
    ...options,
    expectedBpVersion: options.expectedBpVersion ?? room.bpVersion,
  });
  if (result.ok) {
    room.bpVersion = result.bpVersion;
  }
  return result;
}
/** 以指定 operationId 发送命令（用于重发/去重场景，可显式控制版本）。 */
function sendWith(
  client: TestWsClient,
  operationId: string,
  payload: Record<string, unknown>,
  expectedBpVersion: number,
): void {
  client.send({ ...payload, operationId, expectedBpVersion });
}

describe("完整 BP 流程（建房 → 分席 → 26 步预选与确认 → 完成 → 撤回/重开）", () => {
  it("真实连接上完成全部 26 步并逐位校验版本与结果", async () => {
    const room = await startBpRoom();

    for (const [index, step] of BP_STEPS.entries()) {
      const client = step.team === "A" ? room.aWs : room.bWs;
      const agentId = FLOW_AGENT_IDS[index];
      if (agentId === undefined) throw new Error("测试名单不足");

      const preselect = await roomCommand(room, client, "setPreselect", {
        slotId: step.slotId,
        agentId,
      });
      expect(preselect.ok, `第 ${index + 1} 步预选 ${step.slotId}`).toBe(true);
      expect(preselect.bpVersion).toBe(room.bpVersion);

      const confirm = await roomCommand(room, client, "confirmPreselect", {
        slotId: step.slotId,
      });
      expect(confirm.ok, `第 ${index + 1} 步确认 ${step.slotId}`).toBe(true);

      // 期间会有预选广播等多次视图，按内容定位「该步已确认」的视图。
      const finished = index + 1 === BP_STEPS.length;
      const hostViewRaw = await room.hostWs.waitFor(
        (message) => {
          try {
            const parsed = JSON.parse(message ?? "") as {
              kind?: string;
              view?: { submissions?: unknown[]; bpStatus?: string };
            };
            return (
              parsed.kind === "hostView" &&
              parsed.view?.submissions?.length === index + 1 &&
              parsed.view.bpStatus === (finished ? "completed" : "running")
            );
          } catch {
            return false;
          }
        },
        `第 ${index + 1} 步后的 hostView`,
      );
      const hostView = JSON.parse(hostViewRaw ?? "{}") as {
        view: {
          submissions: { slotId: string; agentId: string }[];
          currentSlotId: string | null;
        };
      };
      expect(hostView.view.submissions).toHaveLength(index + 1);
      expect(hostView.view.currentSlotId).toBe(
        finished ? null : (BP_STEPS[index + 1]?.slotId ?? null),
      );
      const last = hostView.view.submissions[index];
      expect(last?.slotId).toBe(step.slotId);
      expect(last?.agentId).toBe(agentId);
    }

    // 完成后撤回：转 paused，序列少一条；重开：回 waiting、清空序列，版本不重置。
    const versionBeforeUndo = room.bpVersion;
    const undo = await roomCommand(room, room.hostWs, "undoBpStep", {});
    expect(undo.ok).toBe(true);
    expect(undo.bpVersion).toBe(versionBeforeUndo + 1);
    const afterUndoRaw = await room.hostWs.waitFor((message) => {
      try {
        const parsed = JSON.parse(message ?? "") as {
          kind?: string;
          view?: { bpStatus?: string; submissions?: unknown[] };
        };
        return (
          parsed.kind === "hostView" &&
          parsed.view?.bpStatus === "paused" &&
          parsed.view?.submissions?.length === BP_STEPS.length - 1
        );
      } catch {
        return false;
      }
    }, "撤回后的 hostView");
    const afterUndo = JSON.parse(afterUndoRaw ?? "{}") as { view: { submissions: unknown[] } };
    expect(afterUndo.view.submissions).toHaveLength(BP_STEPS.length - 1);

    const restart = await roomCommand(room, room.hostWs, "restartBp", {});
    expect(restart.ok).toBe(true);
    expect(restart.bpVersion).toBe(versionBeforeUndo + 2); // 版本单调，不重置
    const afterRestartRaw = await room.hostWs.waitFor((message) => {
      try {
        const parsed = JSON.parse(message ?? "") as {
          kind?: string;
          view?: { bpStatus?: string; submissions?: unknown[]; currentSlotId?: string | null };
        };
        return (
          parsed.kind === "hostView" &&
          parsed.view?.bpStatus === "waiting" &&
          parsed.view?.submissions?.length === 0
        );
      } catch {
        return false;
      }
    }, "重开后的 hostView");
    const afterRestart = JSON.parse(afterRestartRaw ?? "{}") as {
      view: { currentSlotId: string | null };
    };
    expect(afterRestart.view.currentSlotId).toBeNull();
  });

  it("过期与重复提交不推进：旧版本命令被版本门拒绝", async () => {
    const room = await startBpRoom("版本门赛");
    const versionAtStart = room.bpVersion;

    // 未预选直接确认 → NO_PRESELECT。
    const noPreselect = await roomCommand(room, room.aWs, "confirmPreselect", { slotId: "AB1" });
    expect(noPreselect.ok).toBe(false);
    expect(noPreselect.error?.code).toBe("NO_PRESELECT");

    // 预选 AB1 后版本已推进：用旧版本再发同一命令（新 operationId）→ 过期。
    expect(
      (
        await roomCommand(room, room.aWs, "setPreselect", {
          slotId: "AB1",
          agentId: FLOW_AGENT_IDS[0],
        })
      ).ok,
    ).toBe(true);
    const stale = await command(
      room.aWs,
      "setPreselect",
      { slotId: "AB1", agentId: FLOW_AGENT_IDS[1] },
      { expectedBpVersion: versionAtStart },
    );
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("STALE_BP_VERSION");

    // 确认后重复确认（旧版本）：步位已推进到 B 方，权限检查先于版本门，
    // 因此 A 方重复确认被拒为 NOT_CURRENT_PLAYER（同样不会推进）。
    const confirmVersion = room.bpVersion;
    expect((await roomCommand(room, room.aWs, "confirmPreselect", { slotId: "AB1" })).ok).toBe(
      true,
    );
    const duplicate = await command(
      room.aWs,
      "confirmPreselect",
      { slotId: "AB1" },
      { expectedBpVersion: confirmVersion },
    );
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error?.code).toBe("NOT_CURRENT_PLAYER");
    const count = await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM bp_submissions");
    expect(count).toEqual([{ n: 1 }]);
  });

  it("同一身份两个页面近同时提交：只有一次生效", async () => {
    const room = await startBpRoom("近同时赛");
    expect(
      (
        await roomCommand(room, room.aWs, "setPreselect", {
          slotId: "AB1",
          agentId: FLOW_AGENT_IDS[0],
        })
      ).ok,
    ).toBe(true);
    const version = room.bpVersion;

    // 第二个页面同一成员连接后，两页几乎同时提交同一操作位。
    const secondPage = await TestWsClient.connectMember(room.host.roomId, room.playerA.secret);
    await secondPage.next("memberView");
    sendWith(room.aWs, "near-simultaneous-1", { type: "confirmPreselect", slotId: "AB1" }, version);
    sendWith(
      secondPage,
      "near-simultaneous-2",
      { type: "confirmPreselect", slotId: "AB1" },
      version,
    );

    const first = await room.aWs.commandResult("near-simultaneous-1");
    const second = await secondPage.commandResult("near-simultaneous-2");
    const successes = [first.ok, second.ok].filter(Boolean);
    expect(successes).toHaveLength(1);
    // 失败的一方是确定性规则拒绝（权限先于版本门检查：步位推进后不再
    // 是当前操作方，或版本门过期），不是内部错误。
    for (const result of [first, second]) {
      if (!result.ok) {
        expect(["STALE_BP_VERSION", "NOT_CURRENT_PLAYER"]).toContain(result.error?.code);
      }
    }
    const count = await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM bp_submissions");
    expect(count).toEqual([{ n: 1 }]);
    secondPage.close();
  });
});

describe("权限与前提失败", () => {
  it("越权命令被稳定错误码拒绝且不产生回执外的状态变化", async () => {
    const room = await startBpRoom("越权赛");

    // 观众执行任何管理/选手命令都被拒。
    const spectator = await joinMemberViaHttp(room.host.roomId, "观众");
    const spectatorWs = await TestWsClient.connectMember(room.host.roomId, spectator.secret);
    await spectatorWs.next("memberView");

    const notHost = await command(
      spectatorWs,
      "startBp",
      {},
      { expectedBpVersion: room.bpVersion },
    );
    expect(notHost.ok).toBe(false);
    expect(notHost.error?.code).toBe("NOT_HOST");

    // 选手越权：B 方选手在 A 方操作位预选。
    const wrongPlayer = await command(
      room.bWs,
      "setPreselect",
      { slotId: "AB1", agentId: FLOW_AGENT_IDS[0] },
      { expectedBpVersion: room.bpVersion },
    );
    expect(wrongPlayer.ok).toBe(false);
    expect(wrongPlayer.error?.code).toBe("NOT_CURRENT_PLAYER");

    // 房主目标席位不在线/名单外成员被拒。
    const offlineTarget = await command(
      room.hostWs,
      "assignSeat",
      { team: "A", targetMemberId: spectator.memberId },
      { expectedBpVersion: room.bpVersion },
    );
    expect(offlineTarget.ok).toBe(false);
    // running 状态本就不能换席。
    expect(offlineTarget.error?.code).toBe("SEAT_CHANGE_FORBIDDEN");
    spectatorWs.close();
  });

  it("名单外代理人与互斥池拒绝", async () => {
    const room = await startBpRoom("名单赛");
    // 目录产物内的名单固定；用一个确定不在名单内的 ID。
    const notInCatalog = "agent-not-in-catalog-000";
    expect(agentCatalogData.agents.some((agent) => agent.id === notInCatalog)).toBe(false);

    const outside = await command(
      room.aWs,
      "setPreselect",
      { slotId: "AB1", agentId: notInCatalog },
      { expectedBpVersion: room.bpVersion },
    );
    expect(outside.ok).toBe(false);
    expect(outside.error?.code).toBe("AGENT_NOT_IN_CATALOG");

    // AB1 禁用 agent0 后，B 方在 BB1 不能再禁用或预选同一代理人。
    expect(
      (
        await roomCommand(room, room.aWs, "setPreselect", {
          slotId: "AB1",
          agentId: FLOW_AGENT_IDS[0],
        })
      ).ok,
    ).toBe(true);
    expect((await roomCommand(room, room.aWs, "confirmPreselect", { slotId: "AB1" })).ok).toBe(
      true,
    );
    const banned = await command(
      room.bWs,
      "setPreselect",
      { slotId: "BB1", agentId: FLOW_AGENT_IDS[0] },
      { expectedBpVersion: room.bpVersion },
    );
    expect(banned.ok).toBe(false);
    expect(banned.error?.code).toBe("AGENT_UNAVAILABLE");
  });

  it("房间持久规则版本不受当前引擎支持时拒绝执行命令，状态与回执不变", async () => {
    // 直接驱动 DO 建一间「未来规则版本」的房间（模拟升级后降级部署）。
    const roomId = `future-rule-${crypto.randomUUID()}`;
    const credential = await controlledCredential(roomId, "host");
    const stub = exports.Room.get(exports.Room.idFromName(roomId));
    const created = await stub.createRoom({
      roomId,
      name: "未来规则房",
      hostMemberId: crypto.randomUUID(),
      nickname: "房主",
      credentialDigest: credential.digest,
      ruleVersion: "999-future",
      catalogJson: JSON.stringify(agentCatalogData),
    });
    expect(created.kind).toBe("created");

    const client = await TestWsClient.connectMember(roomId, credential.secret);
    // 视图不过滤规则版本：房间状态是事实，可以恢复查看（房主收 hostView）。
    const view = await client.next("hostView");
    expect(view.view.roomName).toBe("未来规则房");
    expect(view.view.versions.ruleVersion).toBe("999-future");
    expect(view.view.self.isHost).toBe(true);

    client.send({
      type: "setTeamName",
      team: "A",
      teamName: "尝试修改",
      operationId: "op-rule-version",
      expectedBpVersion: 0,
    });
    const result = await client.commandResult("op-rule-version");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("RULE_VERSION_UNSUPPORTED");

    // 无状态变化、无回执写入。
    expect(await queryRoomRows(roomId, "SELECT name FROM team_names WHERE team = 'A'")).toEqual([
      { name: "" },
    ]);
    expect(await queryRoomRows(roomId, "SELECT COUNT(*) AS n FROM command_receipts")).toEqual([
      { n: 0 },
    ]);
  });
});

describe("operationId 持久化去重回执", () => {
  it("同一载荷重发返回原结果；同 ID 不同载荷被拒；键序不同不算不同载荷", async () => {
    const room = await startBpRoom("去重赛");
    const operationId = "dedup-team-name";
    sendWith(
      room.hostWs,
      operationId,
      { type: "setTeamName", team: "A", teamName: "去重队" },
      room.bpVersion,
    );
    const first = await room.hostWs.commandResult(operationId);
    expect(first.ok).toBe(true);
    const revisionAfterFirst = first.revision;

    // 完全相同的重发：返回原结果（同一 revision），不再执行。
    sendWith(
      room.hostWs,
      operationId,
      { type: "setTeamName", team: "A", teamName: "去重队" },
      room.bpVersion,
    );
    const replay = await room.hostWs.commandResult(operationId);
    expect(replay.ok).toBe(true);
    expect(replay.revision).toBe(revisionAfterFirst);

    // JSON 键顺序不同：规范化后是同一载荷，仍返回原结果。
    room.hostWs.socket.send(
      `{"expectedBpVersion":${room.bpVersion},"teamName":"去重队","team":"A","type":"setTeamName","operationId":"${operationId}"}`,
    );
    const reordered = await room.hostWs.commandResult(operationId);
    expect(reordered.ok).toBe(true);
    expect(reordered.revision).toBe(revisionAfterFirst);

    // 同 ID 不同载荷：稳定拒绝。
    sendWith(
      room.hostWs,
      operationId,
      { type: "setTeamName", team: "A", teamName: "另一个值" },
      room.bpVersion,
    );
    const conflict = await room.hostWs.commandResult(operationId);
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.code).toBe("OPERATION_ID_CONFLICT");

    // 重发后房间 revision 没有被重复推进。
    const meta = await queryRoomRows(room.host.roomId, "SELECT revision FROM room_meta");
    expect(Number(meta[0]?.revision)).toBe(revisionAfterFirst);
  });

  it("断开后结果未知的重发：另一页面取得原结果，不重复推进", async () => {
    const room = await startBpRoom("重发赛");
    expect(
      (
        await roomCommand(room, room.aWs, "setPreselect", {
          slotId: "AB1",
          agentId: FLOW_AGENT_IDS[0],
        })
      ).ok,
    ).toBe(true);
    const version = room.bpVersion;

    const secondPage = await TestWsClient.connectMember(room.host.roomId, room.playerA.secret);
    await secondPage.next("memberView");

    // 第一页提交后立即断开（结果未知）。
    sendWith(room.aWs, "retry-after-drop", { type: "confirmPreselect", slotId: "AB1" }, version);
    room.aWs.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 同一成员另一页面重发同一命令：返回原成功结果。
    sendWith(secondPage, "retry-after-drop", { type: "confirmPreselect", slotId: "AB1" }, version);
    const replayed = await secondPage.commandResult("retry-after-drop");
    expect(replayed.ok).toBe(true);

    // 序列只推进一次；重发后推送的最新视图也反映同一步。
    const count = await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM bp_submissions");
    expect(count).toEqual([{ n: 1 }]);
    secondPage.close();
  });

  it("DO 实例重建后回执仍有效：重发不再次执行", async () => {
    const room = await startBpRoom("重建回执赛");
    const operationId = "rebuild-receipt";
    sendWith(
      room.hostWs,
      operationId,
      { type: "setTeamName", team: "A", teamName: "重建前队名" },
      room.bpVersion,
    );
    const original = await room.hostWs.commandResult(operationId);
    expect(original.ok).toBe(true);

    // 拆除实例（保留持久存储）：模拟平台重建/休眠后新实例。
    await evictDurableObject(exports.Room.get(exports.Room.idFromName(room.host.roomId)));

    const client = await TestWsClient.connectMember(room.host.roomId, room.host.secret);
    sendWith(
      client,
      operationId,
      { type: "setTeamName", team: "A", teamName: "重建前队名" },
      room.bpVersion,
    );
    const replayed = await client.commandResult(operationId);
    expect(replayed.ok).toBe(true);
    expect(replayed.revision).toBe(original.revision);
    // 队名未被重写（仍是原命令设置的值）。
    expect(
      await queryRoomRows(room.host.roomId, "SELECT name FROM team_names WHERE team = 'A'"),
    ).toEqual([{ name: "重建前队名" }]);
    client.close();
  });

  it("回执窗口淘汰后的重发按新命令处理：版本门保护旧确认不再次推进", async () => {
    const room = await startBpRoom("窗口赛");
    expect(
      (
        await roomCommand(room, room.aWs, "setPreselect", {
          slotId: "AB1",
          agentId: FLOW_AGENT_IDS[0],
        })
      ).ok,
    ).toBe(true);
    const versionAtConfirm = room.bpVersion;
    const operationId = "evicted-receipt";
    sendWith(room.aWs, operationId, { type: "confirmPreselect", slotId: "AB1" }, versionAtConfirm);
    const original = await room.aWs.commandResult(operationId);
    expect(original.ok).toBe(true);
    room.bpVersion = original.bpVersion;

    // 注入填充回执，使后续一次真实命令把全部既有回执（含本测试的确认
    // 回执）挤出保留窗口。填充数 = 上限 - 1：插入后总数为 R + 2047，
    // 下一条真实命令写入后裁剪到 2048，恰好淘汰最旧的 R 条（全部真实回执）。
    const realReceipts = Number(
      (await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM command_receipts"))[0]?.n,
    );
    for (let batch = 0; batch < 4; batch += 1) {
      const rowsInBatch = batch === 3 ? 2047 - 3 * 512 : 512;
      const values = Array.from(
        { length: rowsInBatch },
        (_, index) =>
          `('filler', 'filler-b${batch}-${index}', '{}', 1, NULL, NULL, 0, 0, '2026-01-01T00:00:00.000Z')`,
      );
      await execInRoom(
        room.host.roomId,
        `INSERT INTO command_receipts (member_id, operation_id, payload_json, ok, error_code, error_message, bp_version, revision, created_at) VALUES ${values.join(",")}`,
      );
    }
    const before = await queryRoomRows(
      room.host.roomId,
      "SELECT COUNT(*) AS n FROM command_receipts",
    );
    expect(before).toEqual([{ n: realReceipts + 2047 }]);

    // 新命令触发窗口裁剪到 2048，全部真实回执（最旧）被淘汰。
    const fresh = await roomCommand(room, room.hostWs, "setTeamName", {
      team: "B",
      teamName: "触发裁剪",
    });
    expect(fresh.ok).toBe(true);
    expect(
      await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM command_receipts"),
    ).toEqual([{ n: 2048 }]);
    expect(
      await queryRoomRows(
        room.host.roomId,
        `SELECT COUNT(*) AS n FROM command_receipts WHERE operation_id = '${operationId}'`,
      ),
    ).toEqual([{ n: 0 }]);

    // 被淘汰后的重发按新命令处理：确定性规则拒绝（步位已推进到 B 方，
    // 权限检查先于版本门），不会再次推进。
    sendWith(room.aWs, operationId, { type: "confirmPreselect", slotId: "AB1" }, versionAtConfirm);
    const retried = await room.aWs.commandResult(operationId);
    expect(retried.ok).toBe(false);
    expect(["STALE_BP_VERSION", "NOT_CURRENT_PLAYER"]).toContain(retried.error?.code);
    const count = await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM bp_submissions");
    expect(count).toEqual([{ n: 1 }]);
  });
});

describe("SQL 故障下的命令原子性", () => {
  it("提交中途 SQL 故障：状态与回执一起回滚、无成功广播、移除故障后可重试", async () => {
    const room = await startBpRoom("故障赛");
    expect(
      (
        await roomCommand(room, room.aWs, "setPreselect", {
          slotId: "AB1",
          agentId: FLOW_AGENT_IDS[0],
        })
      ).ok,
    ).toBe(true);
    const version = room.bpVersion;
    // 观众连接用于观察广播（其加入与上线会推进 revision，基线在连接后读取）。
    const spectator = await joinMemberViaHttp(room.host.roomId, "观众");
    const spectatorWs = await TestWsClient.connectMember(room.host.roomId, spectator.secret);
    await spectatorWs.next("memberView");
    const spectatorMessages = spectatorWs.received.length;
    const revisionBefore = Number(
      (await queryRoomRows(room.host.roomId, "SELECT revision FROM room_meta"))[0]?.revision,
    );

    // 注入故障：有效序列写入一律失败。
    await execInRoom(
      room.host.roomId,
      "CREATE TRIGGER test_fail_submission_insert BEFORE INSERT ON bp_submissions BEGIN SELECT RAISE(ABORT, 'test injected submission failure'); END",
    );

    const operationId = "fault-confirm";
    sendWith(room.aWs, operationId, { type: "confirmPreselect", slotId: "AB1" }, version);
    const failed = await room.aWs.commandResult(operationId);
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("INTERNAL");

    // 状态未变：无提交、预选保留、版本与 revision 未动。
    expect(
      await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM bp_submissions"),
    ).toEqual([{ n: 0 }]);
    expect(await queryRoomRows(room.host.roomId, "SELECT bp_preselect FROM room_meta")).toEqual([
      { bp_preselect: FLOW_AGENT_IDS[0] },
    ]);
    expect(
      Number(
        (await queryRoomRows(room.host.roomId, "SELECT revision FROM room_meta"))[0]?.revision,
      ),
    ).toBe(revisionBefore);

    // 回执与状态同事务：故障命令没有留下回执。
    expect(
      await queryRoomRows(
        room.host.roomId,
        `SELECT COUNT(*) AS n FROM command_receipts WHERE operation_id = '${operationId}'`,
      ),
    ).toEqual([{ n: 0 }]);

    // 其他连接没有收到成功广播（DO 同步处理后短等确认）。
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(spectatorWs.received.length).toBe(spectatorMessages);

    // 移除故障后同一 operationId 重试成功（若失败回执已落库则会返回原失败）。
    await execInRoom(room.host.roomId, "DROP TRIGGER test_fail_submission_insert");
    sendWith(room.aWs, operationId, { type: "confirmPreselect", slotId: "AB1" }, version);
    const retried = await room.aWs.commandResult(operationId);
    expect(retried.ok).toBe(true);
    expect(
      await queryRoomRows(room.host.roomId, "SELECT COUNT(*) AS n FROM bp_submissions"),
    ).toEqual([{ n: 1 }]);
    // 重试成功后其他连接收到最新视图。
    expect(
      await spectatorWs.waitFor((message) => {
        try {
          const parsed = JSON.parse(message ?? "") as {
            kind?: string;
            view?: { submissions?: unknown[] };
          };
          return parsed.kind === "memberView" && (parsed.view?.submissions?.length ?? 0) === 1;
        } catch {
          return false;
        }
      }, "观众收到提交后的视图"),
    ).not.toBeNull();
    spectatorWs.close();
  });

  it("预选命令中途故障同样整体回滚且可重试", async () => {
    const room = await startBpRoom("预选故障赛");
    await execInRoom(
      room.host.roomId,
      "CREATE TRIGGER test_fail_meta_update BEFORE UPDATE OF bp_preselect ON room_meta BEGIN SELECT RAISE(ABORT, 'test injected preselect failure'); END",
    );

    const operationId = "fault-preselect";
    sendWith(
      room.aWs,
      operationId,
      { type: "setPreselect", slotId: "AB1", agentId: FLOW_AGENT_IDS[0] },
      room.bpVersion,
    );
    const failed = await room.aWs.commandResult(operationId);
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("INTERNAL");
    expect(await queryRoomRows(room.host.roomId, "SELECT bp_preselect FROM room_meta")).toEqual([
      { bp_preselect: null },
    ]);
    expect(
      await queryRoomRows(
        room.host.roomId,
        `SELECT COUNT(*) AS n FROM command_receipts WHERE operation_id = '${operationId}'`,
      ),
    ).toEqual([{ n: 0 }]);

    await execInRoom(room.host.roomId, "DROP TRIGGER test_fail_meta_update");
    sendWith(
      room.aWs,
      operationId,
      { type: "setPreselect", slotId: "AB1", agentId: FLOW_AGENT_IDS[0] },
      room.bpVersion,
    );
    const retried = await room.aWs.commandResult(operationId);
    expect(retried.ok).toBe(true);
    expect(await queryRoomRows(room.host.roomId, "SELECT bp_preselect FROM room_meta")).toEqual([
      { bp_preselect: FLOW_AGENT_IDS[0] },
    ]);
  });
});
