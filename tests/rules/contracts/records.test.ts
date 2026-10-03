import { describe, expect, it } from "vitest";
import {
  EMPTY_ROOM_RETENTION_MS,
  SNAPSHOT_RETENTION_MS,
  archiveSnapshotSchema,
  computeEmptyRoomDeadline,
  computeSnapshotDeadline,
  projectArchiveSnapshot,
  roomRetentionSchema,
  type AgentDisplayLookup,
} from "../../../shared/contracts/records";
import type { VersionInfo } from "../../../shared/contracts/versions";
import {
  HOST_ID,
  PLAYER_A_ID,
  buildRoom,
  completedRoom,
  confirmStep,
  expectOk,
  run,
  startedRoom,
} from "../room-fixture";
import { SPEC_BP_STEP_ORDER, SYNTHETIC_AGENT_IDS } from "../spec-bp-order";

const versions: VersionInfo = { ruleVersion: "rules-test", agentDataVersion: "agents-test" };
const archivedAt = "2026-10-05T00:00:00.000Z";

/** 全量合成代理人的展示信息表；每 3 个留一个空头像覆盖缺失场景。 */
const agentDisplay: AgentDisplayLookup = new Map(
  SYNTHETIC_AGENT_IDS.map((agentId): [string, { name: string; avatarUrl: string | null }] => [
    agentId,
    {
      name: `代理人 ${agentId}`,
      avatarUrl: agentId.endsWith("3") ? null : `/avatars/${agentId}.png`,
    },
  ]),
);

describe("保留计时合同", () => {
  it("时间常量：空房 12 小时、快照 90 天", () => {
    expect(EMPTY_ROOM_RETENTION_MS).toBe(12 * 60 * 60 * 1000);
    expect(SNAPSHOT_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("到期时间由时间戳加常量推导", () => {
    const lastLeft = "2026-10-04T12:00:00.000Z";
    expect(computeEmptyRoomDeadline(lastLeft)).toBe(
      new Date(Date.parse(lastLeft) + 12 * 60 * 60 * 1000).toISOString(),
    );
    expect(computeSnapshotDeadline(archivedAt)).toBe(
      new Date(Date.parse(archivedAt) + 90 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("保留计时结构：全员离开时间可为空", () => {
    expect(roomRetentionSchema.parse({ lastMemberLeftAt: null })).toEqual({
      lastMemberLeftAt: null,
    });
    expect(roomRetentionSchema.parse({ lastMemberLeftAt: archivedAt })).toEqual({
      lastMemberLeftAt: archivedAt,
    });
    expect(roomRetentionSchema.safeParse({ lastMemberLeftAt: "not-a-date" }).success).toBe(false);
  });
});

describe("归档快照投影", () => {
  it("完整对局生成完整快照：26 步、已完成、到期为归档时间 + 90 天", () => {
    const completed = completedRoom();
    const snapshot = projectArchiveSnapshot({
      state: completed,
      agentDisplay,
      versions,
      archivedAt,
    });
    if (snapshot === null) throw new Error("完整对局应生成快照");
    expect(archiveSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.bpCompleted).toBe(true);
    expect(snapshot.operations).toHaveLength(26);
    expect(snapshot.operations[0]).toEqual({
      slotId: "AB1",
      team: "A",
      action: "ban",
      agentId: SYNTHETIC_AGENT_IDS[0],
      agentName: `代理人 ${SYNTHETIC_AGENT_IDS[0]}`,
      agentAvatarUrl: `/avatars/${SYNTHETIC_AGENT_IDS[0]}.png`,
    });
    expect(snapshot.expiresAt).toBe(
      new Date(Date.parse(archivedAt) + 90 * 24 * 60 * 60 * 1000).toISOString(),
    );
    // 快照不含成员、预选或凭据数据
    const serialized = JSON.stringify(snapshot);
    for (const secret of ["preselect", "member", "credential", HOST_ID, "房主"]) {
      expect(serialized.includes(secret)).toBe(false);
    }
  });

  it("未完成对局保留已提交部分并标记未完成", () => {
    let state = startedRoom();
    for (let index = 0; index < 5; index += 1) {
      const slotId = SPEC_BP_STEP_ORDER[index];
      const actor = slotId.startsWith("A") ? PLAYER_A_ID : state.seats.B;
      if (actor === null) throw new Error("测试前提失败：席位为空");
      state = confirmStep(state, actor, slotId, SYNTHETIC_AGENT_IDS[index]);
    }
    // 暂停中到期归档：保留已提交部分
    state = expectOk(run(state, HOST_ID, { type: "pauseBp" }));
    const snapshot = projectArchiveSnapshot({ state, agentDisplay, versions, archivedAt });
    if (snapshot === null) throw new Error("有有效提交的房间应生成快照");
    expect(snapshot.bpCompleted).toBe(false);
    expect(snapshot.operations).toHaveLength(5);
    expect(archiveSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("空有效序列不生成快照；缺失展示信息视为数据错误", () => {
    expect(
      projectArchiveSnapshot({ state: buildRoom(), agentDisplay, versions, archivedAt }),
    ).toBeNull();
    // 撤回到空序列的进行中房间同样无快照
    let state = startedRoom();
    state = confirmStep(state, PLAYER_A_ID, "AB1", "agent-01");
    state = expectOk(run(state, HOST_ID, { type: "undoBpStep" }));
    expect(projectArchiveSnapshot({ state, agentDisplay, versions, archivedAt })).toBeNull();

    const emptyDisplay: AgentDisplayLookup = new Map();
    expect(() =>
      projectArchiveSnapshot({
        state: completedRoom(),
        agentDisplay: emptyDisplay,
        versions,
        archivedAt,
      }),
    ).toThrow(/展示信息/);
  });
});

describe("归档快照 schema 拒绝非法记录", () => {
  /** 以完整快照为基准构造变体。 */
  function completedSnapshot() {
    const snapshot = projectArchiveSnapshot({
      state: completedRoom(),
      agentDisplay,
      versions,
      archivedAt,
    });
    if (snapshot === null) throw new Error("完整对局应生成快照");
    return snapshot;
  }

  it("拒绝空序列、重复代理人与乱序", () => {
    const base = completedSnapshot();
    expect(archiveSnapshotSchema.safeParse({ ...base, operations: [] }).success).toBe(false);

    const duplicated = base.operations.map((operation, index) =>
      index === 1 ? { ...operation, agentId: base.operations[0].agentId } : operation,
    );
    expect(archiveSnapshotSchema.safeParse({ ...base, operations: duplicated }).success).toBe(
      false,
    );

    const swapped = [...base.operations];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(archiveSnapshotSchema.safeParse({ ...base, operations: swapped }).success).toBe(false);
  });

  it("拒绝阵营/动作与操作位不符、完成标记不一致与错误到期时间", () => {
    const base = completedSnapshot();
    // AB1 记录为 B 方
    const wrongTeam = base.operations.map((operation, index) =>
      index === 0 ? { ...operation, team: "B" as const } : operation,
    );
    expect(archiveSnapshotSchema.safeParse({ ...base, operations: wrongTeam }).success).toBe(false);
    // 26 步却标记未完成
    expect(archiveSnapshotSchema.safeParse({ ...base, bpCompleted: false }).success).toBe(false);
    // 少于 26 步却标记已完成
    const partial = { ...base, operations: base.operations.slice(0, 25), bpCompleted: true };
    expect(archiveSnapshotSchema.safeParse(partial).success).toBe(false);
    // 到期时间不是归档时间 + 90 天
    expect(
      archiveSnapshotSchema.safeParse({
        ...base,
        expiresAt: new Date(Date.parse(archivedAt) + 89 * 24 * 60 * 60 * 1000).toISOString(),
      }).success,
    ).toBe(false);
  });
});
