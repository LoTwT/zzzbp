import { describe, expect, it } from "vitest";
import { applyRoomCommand, setMemberOnline } from "../../shared/transitions";
import type { RoomCommand } from "../../shared/commands";
import {
  AUDIENCE_ID,
  HOST_ID,
  PLAYER_A_ID,
  PLAYER_B_ID,
  buildRoom,
  completedRoom,
  confirmStep,
  deepFreeze,
  expectError,
  expectOk,
  fixtureCatalog,
  nextOperationId,
  run,
  startedRoom,
} from "./room-fixture";
import { SPEC_BP_STEP_ORDER, SYNTHETIC_AGENT_IDS } from "./spec-bp-order";

describe("房主命令与操作者校验", () => {
  it("管理命令仅房主可用；非成员与离线操作者拒绝", () => {
    const state = buildRoom();
    for (const actor of [PLAYER_A_ID, PLAYER_B_ID, AUDIENCE_ID]) {
      expectError(run(state, actor, { type: "startBp" }), "NOT_HOST");
    }
    expectError(run(state, "member-unknown", { type: "startBp" }), "ACTOR_NOT_MEMBER");
    expectError(
      run(buildRoom({ offline: [HOST_ID] }), HOST_ID, { type: "startBp" }),
      "ACTOR_OFFLINE",
    );
    // 伪造载荷不能获得操作身份：观众指定自己上席仍然被拒
    expectError(
      run(state, AUDIENCE_ID, { type: "assignSeat", team: "A", targetMemberId: AUDIENCE_ID }),
      "NOT_HOST",
    );
    expectOk(run(state, HOST_ID, { type: "startBp" }));
  });

  it("开局条件：队名、席位与在线状态", () => {
    expectError(
      run(buildRoom({ teamNameA: "" }), HOST_ID, { type: "startBp" }),
      "START_CONDITIONS_UNMET",
    );
    expectError(
      run(buildRoom({ seatA: null }), HOST_ID, { type: "startBp" }),
      "START_CONDITIONS_UNMET",
    );
    expectError(
      run(buildRoom({ offline: [PLAYER_B_ID] }), HOST_ID, { type: "startBp" }),
      "START_CONDITIONS_UNMET",
    );
    const started = expectOk(run(buildRoom(), HOST_ID, { type: "startBp" }));
    expect(started.bp.status).toBe("running");
    // 重复开始被拒
    expectError(run(started, HOST_ID, { type: "startBp" }), "BP_NOT_WAITING");
  });

  it("暂停与手动继续", () => {
    let state = startedRoom();
    state = expectOk(run(state, HOST_ID, { type: "pauseBp" }));
    expect(state.bp.status).toBe("paused");
    expectError(run(state, HOST_ID, { type: "pauseBp" }), "BP_NOT_RUNNING");
    state = expectOk(run(state, HOST_ID, { type: "resumeBp" }));
    expect(state.bp.status).toBe("running");
    expectError(run(state, HOST_ID, { type: "resumeBp" }), "BP_NOT_PAUSED");
    // 待开始状态下暂停/继续均不适用
    expectError(run(buildRoom(), HOST_ID, { type: "pauseBp" }), "BP_NOT_RUNNING");
    expectError(run(buildRoom(), HOST_ID, { type: "resumeBp" }), "BP_NOT_PAUSED");
    // 非房主不能暂停
    expectError(run(startedRoom(), PLAYER_A_ID, { type: "pauseBp" }), "NOT_HOST");
  });

  it("修改队伍名：任何 BP 状态可用，仅推进公开 revision", () => {
    let state = startedRoom();
    const version = state.bp.version;
    const revision = state.revision;
    state = expectOk(run(state, HOST_ID, { type: "setTeamName", team: "A", teamName: "新左方" }));
    expect(state.teamNames.A).toBe("新左方");
    expect(state.bp.version).toBe(version);
    expect(state.revision).toBe(revision + 1);
    // 相同值：空操作，状态与版本不变
    expect(
      expectOk(run(state, HOST_ID, { type: "setTeamName", team: "A", teamName: "新左方" })),
    ).toBe(state);
  });
});

describe("席位调整", () => {
  it("待开始可分配在线观众；相同任命是空操作", () => {
    const state = buildRoom();
    const replaced = expectOk(
      run(state, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: AUDIENCE_ID }),
    );
    expect(replaced.seats.A).toBe(AUDIENCE_ID);
    // 相同任命：返回同一引用，无任何变化
    const again = expectOk(
      run(replaced, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: AUDIENCE_ID }),
    );
    expect(again).toBe(replaced);
  });

  it("席位候选资格：在线、本房间成员、不占对方席位", () => {
    const state = buildRoom();
    expectError(
      run(state, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: "member-unknown" }),
      "SEAT_TARGET_NOT_MEMBER",
    );
    expectError(
      run(buildRoom({ offline: [AUDIENCE_ID] }), HOST_ID, {
        type: "assignSeat",
        team: "A",
        targetMemberId: AUDIENCE_ID,
      }),
      "SEAT_TARGET_OFFLINE",
    );
    // B 方在席选手不能同时占 A 席
    expectError(
      run(state, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: PLAYER_B_ID }),
      "SEAT_TARGET_ALREADY_SEATED",
    );
    // 观众上席后不能再占另一方席位
    const replaced = expectOk(
      run(state, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: AUDIENCE_ID }),
    );
    expectError(
      run(replaced, HOST_ID, { type: "assignSeat", team: "B", targetMemberId: AUDIENCE_ID }),
      "SEAT_TARGET_ALREADY_SEATED",
    );
  });

  it("进行中与完成状态不允许换人，暂停可换", () => {
    const running = startedRoom();
    expectError(
      run(running, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: AUDIENCE_ID }),
      "SEAT_CHANGE_FORBIDDEN",
    );
    const completed = completedRoom();
    expectError(
      run(completed, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: AUDIENCE_ID }),
      "SEAT_CHANGE_FORBIDDEN",
    );
    const paused = expectOk(run(running, HOST_ID, { type: "pauseBp" }));
    expectOk(run(paused, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: AUDIENCE_ID }));
  });

  it("房主兼任、被换下与重新上场", () => {
    let state = buildRoom();
    // 房主自己上 A 席
    state = expectOk(
      run(state, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: HOST_ID }),
    );
    expect(state.seats.A).toBe(HOST_ID);
    expect(state.hostMemberId).toBe(HOST_ID);
    // 房主持 A 席时不能再占 B 席
    expectError(
      run(state, HOST_ID, { type: "assignSeat", team: "B", targetMemberId: HOST_ID }),
      "SEAT_TARGET_ALREADY_SEATED",
    );
    // 换下房主：房主身份保留，仍可控场
    state = expectOk(
      run(state, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: PLAYER_A_ID }),
    );
    expect(state.seats.A).toBe(PLAYER_A_ID);
    expect(state.hostMemberId).toBe(HOST_ID);
    const running = expectOk(run(state, HOST_ID, { type: "startBp" }));
    const paused = expectOk(run(running, HOST_ID, { type: "pauseBp" }));
    expect(paused.bp.status).toBe("paused");
  });

  it("暂停中未占席房主把自己换上当前席：保留预选与结果、仍暂停、不能占双席", () => {
    let state = startedRoom();
    // A 方当前位 AB1 已预选后暂停
    state = expectOk(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
    );
    state = expectOk(run(state, HOST_ID, { type: "pauseBp" }));

    // 未占席房主把自己换上 A 席（当前操作位所属席位）
    state = expectOk(
      run(state, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: HOST_ID }),
    );
    expect(state.bp.status).toBe("paused");
    expect(state.seats).toEqual({ A: HOST_ID, B: PLAYER_B_ID });
    expect(state.bp.preselect).toBe("agent-01");
    expect(state.bp.submissions).toHaveLength(0);
    // 已占 A 席后不能再占 B 席
    expectError(
      run(state, HOST_ID, { type: "assignSeat", team: "B", targetMemberId: HOST_ID }),
      "SEAT_TARGET_ALREADY_SEATED",
    );
    // 原选手立即失去操作权；暂停中兼任房主也不能提交
    expectError(
      run(state, PLAYER_A_ID, { type: "confirmPreselect", slotId: "AB1" }),
      "NOT_CURRENT_PLAYER",
    );
    expectError(run(state, HOST_ID, { type: "confirmPreselect", slotId: "AB1" }), "BP_NOT_RUNNING");
    // 手动恢复后，兼任选手的房主凭保留的预选直接确认
    state = expectOk(run(state, HOST_ID, { type: "resumeBp" }));
    state = expectOk(run(state, HOST_ID, { type: "confirmPreselect", slotId: "AB1" }));
    expect(state.bp.submissions[0]).toEqual({ slotId: "AB1", agentId: "agent-01" });
  });

  it("席位权限变化使旧 BP 命令过期", () => {
    const state = buildRoom();
    const replaced = expectOk(
      run(state, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: AUDIENCE_ID }),
    );
    // 房主使用席位变更前的版本发起开始：版本已过期
    expectError(
      run(replaced, HOST_ID, { type: "startBp", expectedBpVersion: state.bp.version }),
      "STALE_BP_VERSION",
    );
    // 原选手已不在席：权限检查先于版本门
    expectError(
      run(replaced, PLAYER_A_ID, {
        type: "setPreselect",
        slotId: "AB1",
        agentId: "agent-01",
      }),
      "NOT_CURRENT_PLAYER",
    );
  });
});

describe("成员在线状态系统入口", () => {
  it("进行中：观众掉线不暂停，也不使 BP 命令过期", () => {
    const state = startedRoom();
    const version = state.bp.version;
    const revision = state.revision;
    const updated = expectOk(setMemberOnline(state, AUDIENCE_ID, false));
    expect(updated.bp.status).toBe("running");
    expect(updated.bp.version).toBe(version);
    expect(updated.revision).toBe(revision + 1);
    // 观众掉线后，同版本的管理命令照常执行
    expectOk(run(updated, HOST_ID, { type: "pauseBp", expectedBpVersion: version }));
  });

  it("进行中：在席选手或房主掉线立即暂停，上线不自动恢复", () => {
    let state = startedRoom();
    const version = state.bp.version;
    state = expectOk(setMemberOnline(state, PLAYER_A_ID, false));
    expect(state.bp.status).toBe("paused");
    expect(state.bp.version).toBe(version + 1);
    // 选手重连：仍暂停，由房主手动恢复
    state = expectOk(setMemberOnline(state, PLAYER_A_ID, true));
    expect(state.bp.status).toBe("paused");
    state = expectOk(run(state, HOST_ID, { type: "resumeBp" }));
    expect(state.bp.status).toBe("running");

    // 房主掉线同样暂停（未兼任选手）
    state = expectOk(setMemberOnline(state, HOST_ID, false));
    expect(state.bp.status).toBe("paused");
    // 离线房主不能操作
    expectError(run(state, HOST_ID, { type: "resumeBp" }), "ACTOR_OFFLINE");
    state = expectOk(setMemberOnline(state, HOST_ID, true));
    expect(state.bp.status).toBe("paused");
    expectOk(run(state, HOST_ID, { type: "resumeBp" }));
  });

  it("非进行中掉线不触发暂停；未知成员与同值判定", () => {
    const waitingOffline = expectOk(setMemberOnline(buildRoom(), PLAYER_A_ID, false));
    expect(waitingOffline.bp.status).toBe("waiting");
    const paused = expectOk(run(startedRoom(), HOST_ID, { type: "pauseBp" }));
    const stillPaused = expectOk(setMemberOnline(paused, PLAYER_B_ID, false));
    expect(stillPaused.bp.status).toBe("paused");
    expectError(setMemberOnline(buildRoom(), "member-unknown", true), "MEMBER_NOT_FOUND");
    // 与当前判定一致：空操作，revision 不变（同一引用返回）
    const waiting = buildRoom();
    expect(expectOk(setMemberOnline(waiting, HOST_ID, true))).toBe(waiting);
  });
});

describe("撤回", () => {
  it("空序列拒绝；进行中撤回保持进行中并释放代理人", () => {
    expectError(run(startedRoom(), HOST_ID, { type: "undoBpStep" }), "NOTHING_TO_UNDO");
    expectError(run(startedRoom(), AUDIENCE_ID, { type: "undoBpStep" }), "NOT_HOST");

    let state = startedRoom();
    state = confirmStep(state, PLAYER_A_ID, "AB1", "agent-01");
    // 当前位 BB1，B 方已预选
    state = expectOk(
      run(state, PLAYER_B_ID, { type: "setPreselect", slotId: "BB1", agentId: "agent-02" }),
    );
    expect(state.bp.preselect).toBe("agent-02");

    state = expectOk(run(state, HOST_ID, { type: "undoBpStep" }));
    expect(state.bp.status).toBe("running");
    expect(state.bp.submissions).toHaveLength(0);
    // 操作位回退清除旧位预选
    expect(state.bp.preselect).toBeNull();
    // 被释放的 agent-01 可再次被预选（当前位回到 AB1）
    state = expectOk(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
    );
    expect(state.bp.preselect).toBe("agent-01");
  });

  it("完成状态撤回转暂停，可连续逐步回退并释放代理人", () => {
    const completed = completedRoom();
    expect(completed.bp.status).toBe("completed");
    let state = expectOk(run(completed, HOST_ID, { type: "undoBpStep" }));
    expect(state.bp.status).toBe("paused");
    expect(state.bp.submissions).toHaveLength(25);
    // AP9 的代理人（第 26 步）已被释放
    expect(state.bp.submissions.some((s) => s.agentId === SYNTHETIC_AGENT_IDS[25])).toBe(false);
    // 暂停状态继续撤回：保持暂停
    state = expectOk(run(state, HOST_ID, { type: "undoBpStep" }));
    expect(state.bp.status).toBe("paused");
    expect(state.bp.submissions).toHaveLength(24);
    // 恢复后，被释放的第 25 步代理人可被当前操作方预选
    state = expectOk(run(state, HOST_ID, { type: "resumeBp" }));
    const currentSlotId = SPEC_BP_STEP_ORDER[24];
    const currentTeam = currentSlotId.slice(0, 1) === "A" ? PLAYER_A_ID : PLAYER_B_ID;
    state = expectOk(
      run(state, currentTeam, {
        type: "setPreselect",
        slotId: currentSlotId,
        agentId: SYNTHETIC_AGENT_IDS[24],
      }),
    );
    expect(state.bp.preselect).toBe(SYNTHETIC_AGENT_IDS[24]);
  });
});

describe("重开", () => {
  it("清空序列与预选回到待开始，保留房间配置，版本不重置", () => {
    let state = startedRoom();
    state = confirmStep(state, PLAYER_A_ID, "AB1", "agent-01");
    state = expectOk(
      run(state, PLAYER_B_ID, { type: "setPreselect", slotId: "BB1", agentId: "agent-02" }),
    );
    const versionBefore = state.bp.version;
    const revisionBefore = state.revision;

    state = expectOk(run(state, HOST_ID, { type: "restartBp" }));
    expect(state.bp.status).toBe("waiting");
    expect(state.bp.submissions).toHaveLength(0);
    expect(state.bp.preselect).toBeNull();
    expect(state.bp.version).toBe(versionBefore + 1);
    expect(state.revision).toBe(revisionBefore + 1);
    // 保留房间、成员、房主、席位与队伍名
    expect(state.hostMemberId).toBe(HOST_ID);
    expect(state.seats).toEqual({ A: PLAYER_A_ID, B: PLAYER_B_ID });
    expect(state.teamNames).toEqual({ A: "左方", B: "右方" });
    expect(state.members).toHaveLength(4);
    // 重开后可再次开始
    state = expectOk(run(state, HOST_ID, { type: "startBp" }));
    expect(state.bp.status).toBe("running");
    // 旧版本命令已过期
    expectError(
      run(state, HOST_ID, { type: "pauseBp", expectedBpVersion: versionBefore }),
      "STALE_BP_VERSION",
    );
  });

  it("待开始时重开是空操作；非房主拒绝", () => {
    const waiting = buildRoom();
    expect(expectOk(run(waiting, HOST_ID, { type: "restartBp" }))).toBe(waiting);
    expectError(run(waiting, AUDIENCE_ID, { type: "restartBp" }), "NOT_HOST");
  });
});

describe("版本与不可变性", () => {
  it("过期版本命令拒绝且不改变状态", () => {
    const state = startedRoom();
    const snapshot = structuredClone(state);
    expectError(
      run(state, PLAYER_A_ID, {
        type: "setPreselect",
        slotId: "AB1",
        agentId: "agent-01",
        expectedBpVersion: state.bp.version - 1,
      }),
      "STALE_BP_VERSION",
    );
    expect(state).toEqual(snapshot);
    // 当前版本一致则成功
    expectOk(run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }));
  });

  it("成功与失败的调用都不就地修改原状态", () => {
    const started = startedRoom();
    const withPreselect = expectOk(
      run(started, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
    );
    const snapshot = structuredClone(withPreselect);
    const frozen = deepFreeze(structuredClone(withPreselect));

    // 成功路径：在冻结状态上执行，任何就地写入都会抛错
    const confirmed = expectOk(
      applyRoomCommand(
        frozen,
        { memberId: PLAYER_A_ID },
        {
          type: "confirmPreselect",
          slotId: "AB1",
          operationId: nextOperationId(),
          expectedBpVersion: frozen.bp.version,
        },
        fixtureCatalog,
      ),
    );
    expect(confirmed.bp.submissions).toHaveLength(1);
    expect(confirmed).not.toBe(frozen);
    expect(frozen).toEqual(snapshot);

    // 失败路径：权限、版本与状态类失败均不写入
    expectError(
      applyRoomCommand(
        frozen,
        { memberId: PLAYER_B_ID },
        {
          type: "setPreselect",
          slotId: "AB1",
          agentId: "agent-02",
          operationId: nextOperationId(),
          expectedBpVersion: frozen.bp.version,
        },
        fixtureCatalog,
      ),
      "NOT_CURRENT_PLAYER",
    );
    expectError(
      applyRoomCommand(
        frozen,
        { memberId: HOST_ID },
        {
          type: "pauseBp",
          operationId: nextOperationId(),
          expectedBpVersion: frozen.bp.version - 1,
        },
        fixtureCatalog,
      ),
      "STALE_BP_VERSION",
    );
    expect(frozen).toEqual(snapshot);

    // 系统入口同样不就地修改
    expectOk(setMemberOnline(frozen, PLAYER_A_ID, false));
    expect(frozen).toEqual(snapshot);
  });
});

describe("归档房间", () => {
  it("拒绝一切写命令与在线状态更新", () => {
    const state = buildRoom({ lifecycle: "archived" });
    const commands: RoomCommand[] = [
      {
        type: "setTeamName",
        team: "A",
        teamName: "新名",
        operationId: nextOperationId(),
        expectedBpVersion: 0,
      },
      {
        type: "assignSeat",
        team: "A",
        targetMemberId: AUDIENCE_ID,
        operationId: nextOperationId(),
        expectedBpVersion: 0,
      },
      { type: "startBp", operationId: nextOperationId(), expectedBpVersion: 0 },
      { type: "pauseBp", operationId: nextOperationId(), expectedBpVersion: 0 },
      { type: "resumeBp", operationId: nextOperationId(), expectedBpVersion: 0 },
      { type: "undoBpStep", operationId: nextOperationId(), expectedBpVersion: 0 },
      { type: "restartBp", operationId: nextOperationId(), expectedBpVersion: 0 },
      {
        type: "setPreselect",
        slotId: "AB1",
        agentId: "agent-01",
        operationId: nextOperationId(),
        expectedBpVersion: 0,
      },
      {
        type: "clearPreselect",
        slotId: "AB1",
        operationId: nextOperationId(),
        expectedBpVersion: 0,
      },
      {
        type: "confirmPreselect",
        slotId: "AB1",
        operationId: nextOperationId(),
        expectedBpVersion: 0,
      },
    ];
    for (const command of commands) {
      expectError(run(state, HOST_ID, command), "ROOM_ARCHIVED");
    }
    expectError(setMemberOnline(state, HOST_ID, false), "ROOM_ARCHIVED");
  });
});
