import { describe, expect, it } from "vitest";
import type { BpSlotId } from "../../shared/bp/steps";
import { roomStateSchema } from "../../shared/room";
import { setMemberOnline } from "../../shared/transitions";
import {
  AUDIENCE_ID,
  HOST_ID,
  PLAYER_A_ID,
  PLAYER_B_ID,
  buildRoom,
  confirmStep,
  expectError,
  expectOk,
  run,
  startedRoom,
} from "./room-fixture";
import { SPEC_BP_STEP_ORDER, SYNTHETIC_AGENT_IDS } from "./spec-bp-order";

/** 由操作位标记推断所属阵营（测试内独立解码，不依赖实现工具）。 */
function teamOfSlot(slotId: string): "A" | "B" {
  return slotId.slice(0, 1) === "A" ? "A" : "B";
}

describe("完整 BP 对局", () => {
  it("26 步逐位预选并确认，AP9 提交后立即完成", () => {
    let state = startedRoom();
    expect(state.bp.status).toBe("running");

    for (let index = 0; index < SPEC_BP_STEP_ORDER.length; index += 1) {
      const slotId = SPEC_BP_STEP_ORDER[index];
      const actorMemberId = state.seats[teamOfSlot(slotId)];
      if (actorMemberId === null) throw new Error("测试前提失败：进行中席位不应为空");

      const versionBefore = state.bp.version;
      state = confirmStep(state, actorMemberId, slotId, SYNTHETIC_AGENT_IDS[index]);
      expect(state.bp.submissions).toHaveLength(index + 1);
      expect(state.bp.submissions[index]).toEqual({
        slotId,
        agentId: SYNTHETIC_AGENT_IDS[index],
      });
      // 预选 + 确认各推进一次版本；提交后本位预选清空
      expect(state.bp.version).toBe(versionBefore + 2);
      expect(state.bp.preselect).toBeNull();
      if (index < SPEC_BP_STEP_ORDER.length - 1) {
        expect(state.bp.status).toBe("running");
      }
    }

    expect(state.bp.status).toBe("completed");
    expect(state.bp.submissions).toHaveLength(26);
    // 引擎产出的最终状态仍满足全部状态不变量
    expect(roomStateSchema.safeParse(state).success).toBe(true);
    // 完成后不再有当前操作方：任何预选命令都被拒
    expectError(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AP9", agentId: "agent-27" }),
      "NOT_CURRENT_PLAYER",
    );
  });

  it("已禁用与已选用的代理人都不能再次预选；名单外拒绝", () => {
    let state = startedRoom();
    const baseVersion = state.bp.version;
    state = confirmStep(state, PLAYER_A_ID, "AB1", "agent-01");
    state = confirmStep(state, PLAYER_B_ID, "BB1", "agent-02");
    // 当前位 AB2：已被双方禁用的 agent-01 / agent-02 均不可用
    expectError(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB2", agentId: "agent-01" }),
      "AGENT_UNAVAILABLE",
    );
    expectError(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB2", agentId: "agent-02" }),
      "AGENT_UNAVAILABLE",
    );

    // 推进到选用阶段：AP1 选用 agent-05 后，B 方不能再选同一个
    state = confirmStep(state, PLAYER_A_ID, "AB2", "agent-03");
    state = confirmStep(state, PLAYER_B_ID, "BB2", "agent-04");
    state = confirmStep(state, PLAYER_A_ID, "AP1", "agent-05");
    expectError(
      run(state, PLAYER_B_ID, { type: "setPreselect", slotId: "BP1", agentId: "agent-05" }),
      "AGENT_UNAVAILABLE",
    );
    // 名单外代理人拒绝（合成名单共 30 人）
    expectError(
      run(state, PLAYER_B_ID, { type: "setPreselect", slotId: "BP1", agentId: "agent-99" }),
      "AGENT_NOT_IN_CATALOG",
    );
    // 失败命令不改变状态：5 次成功推进共 10 个版本
    expect(state.bp.submissions).toHaveLength(5);
    expect(state.bp.version).toBe(baseVersion + 10);
  });

  it("连续本方操作逐位确认：后一位须重新预选，目标位必须匹配", () => {
    let state = startedRoom();
    // 推进到第一轮选用：AB1 BB1 AB2 BB2 AP1 BP1
    const earlySlots: Array<[BpSlotId, string]> = [
      ["AB1", "agent-01"],
      ["BB1", "agent-02"],
      ["AB2", "agent-03"],
      ["BB2", "agent-04"],
      ["AP1", "agent-05"],
      ["BP1", "agent-06"],
    ];
    for (const [slotId, agentId] of earlySlots) {
      state = confirmStep(state, state.seats[teamOfSlot(slotId)] ?? "", slotId, agentId);
    }
    // 当前位 BP2 仍属 B 方：无预选时提交被拒
    expectError(
      run(state, PLAYER_B_ID, { type: "confirmPreselect", slotId: "BP2" }),
      "NO_PRESELECT",
    );
    // 预选目标位写错（仍是上一位 BP1）被拒
    expectError(
      run(state, PLAYER_B_ID, { type: "setPreselect", slotId: "BP1", agentId: "agent-07" }),
      "PRESELECT_SLOT_MISMATCH",
    );
    // 提交目标位写错同样被拒
    expectError(
      run(state, PLAYER_B_ID, { type: "confirmPreselect", slotId: "AP2" }),
      "PRESELECT_SLOT_MISMATCH",
    );
    state = confirmStep(state, PLAYER_B_ID, "BP2", "agent-07");
    expect(state.bp.submissions).toHaveLength(7);
    // 下一位 AP2 归 A 方：B 方操作被拒
    expectError(
      run(state, PLAYER_B_ID, { type: "setPreselect", slotId: "AP2", agentId: "agent-08" }),
      "NOT_CURRENT_PLAYER",
    );
  });

  it("越权与离线：观众、非当前方、未占席房主与离线者均拒绝", () => {
    const state = startedRoom();
    expectError(
      run(state, AUDIENCE_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
      "NOT_CURRENT_PLAYER",
    );
    expectError(
      run(state, PLAYER_B_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
      "NOT_CURRENT_PLAYER",
    );
    // 房主未占选手席位，同样不是当前操作方
    expectError(
      run(state, HOST_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
      "NOT_CURRENT_PLAYER",
    );

    // 观众掉线不影响进行中的 BP；当前方 A 仍可预选
    const audienceOffline = expectOk(setMemberOnline(state, AUDIENCE_ID, false));
    expect(audienceOffline.bp.status).toBe("running");
    const withPreselect = expectOk(
      run(audienceOffline, PLAYER_A_ID, {
        type: "setPreselect",
        slotId: "AB1",
        agentId: "agent-01",
      }),
    );

    // A 方掉线：进行中自动暂停；离线操作者一律拒绝
    const pausedByDisconnect = expectOk(setMemberOnline(withPreselect, PLAYER_A_ID, false));
    expect(pausedByDisconnect.bp.status).toBe("paused");
    expectError(
      run(pausedByDisconnect, PLAYER_A_ID, {
        type: "setPreselect",
        slotId: "AB1",
        agentId: "agent-02",
      }),
      "ACTOR_OFFLINE",
    );
  });

  it("暂停期间禁止一切预选变更与提交，已有预选保留", () => {
    let state = startedRoom();
    state = expectOk(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
    );
    state = expectOk(run(state, HOST_ID, { type: "pauseBp" }));
    expect(state.bp.status).toBe("paused");
    expect(state.bp.preselect).toBe("agent-01");

    // 换同值、换人、清空、提交全部拒绝
    expectError(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
      "BP_NOT_RUNNING",
    );
    expectError(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-02" }),
      "BP_NOT_RUNNING",
    );
    expectError(
      run(state, PLAYER_A_ID, { type: "clearPreselect", slotId: "AB1" }),
      "BP_NOT_RUNNING",
    );
    expectError(
      run(state, PLAYER_A_ID, { type: "confirmPreselect", slotId: "AB1" }),
      "BP_NOT_RUNNING",
    );
    expect(state.bp.preselect).toBe("agent-01");

    // 恢复后预选仍在，可直接提交
    state = expectOk(run(state, HOST_ID, { type: "resumeBp" }));
    expect(state.bp.preselect).toBe("agent-01");
    state = expectOk(run(state, PLAYER_A_ID, { type: "confirmPreselect", slotId: "AB1" }));
    expect(state.bp.submissions[0]).toEqual({ slotId: "AB1", agentId: "agent-01" });
  });

  it("暂停期间换人：保留有效提交与预选，仍为暂停，原选手立即失权", () => {
    let state = startedRoom();
    // 推进到 AP1（A 方当前操作位）并预选
    state = confirmStep(state, PLAYER_A_ID, "AB1", "agent-01");
    state = confirmStep(state, PLAYER_B_ID, "BB1", "agent-02");
    state = confirmStep(state, PLAYER_A_ID, "AB2", "agent-03");
    state = confirmStep(state, PLAYER_B_ID, "BB2", "agent-04");
    state = expectOk(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AP1", agentId: "agent-05" }),
    );
    state = expectOk(run(state, HOST_ID, { type: "pauseBp" }));

    // 暂停中把 A 席换成在线观众
    state = expectOk(
      run(state, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: AUDIENCE_ID }),
    );
    expect(state.bp.status).toBe("paused");
    expect(state.bp.submissions).toHaveLength(4);
    expect(state.bp.preselect).toBe("agent-05");
    // 原选手失去席位操作权
    expectError(
      run(state, PLAYER_A_ID, { type: "confirmPreselect", slotId: "AP1" }),
      "NOT_CURRENT_PLAYER",
    );
    // 暂停中新选手同样不能提交；恢复后凭保留的预选直接确认
    expectError(
      run(state, AUDIENCE_ID, { type: "confirmPreselect", slotId: "AP1" }),
      "BP_NOT_RUNNING",
    );
    state = expectOk(run(state, HOST_ID, { type: "resumeBp" }));
    state = expectOk(run(state, AUDIENCE_ID, { type: "confirmPreselect", slotId: "AP1" }));
    expect(state.bp.submissions[4]).toEqual({ slotId: "AP1", agentId: "agent-05" });
  });

  it("房主可在当前操作方离线时恢复，但离线方不能提交", () => {
    let state = startedRoom();
    state = expectOk(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
    );
    // A 方掉线触发自动暂停
    state = expectOk(setMemberOnline(state, PLAYER_A_ID, false));
    expect(state.bp.status).toBe("paused");
    // 房主在 A 仍离线时手动恢复
    state = expectOk(run(state, HOST_ID, { type: "resumeBp" }));
    expect(state.bp.status).toBe("running");
    // 离线的当前操作方不能提交，预选仍保留
    expectError(
      run(state, PLAYER_A_ID, { type: "confirmPreselect", slotId: "AB1" }),
      "ACTOR_OFFLINE",
    );
    expect(state.bp.preselect).toBe("agent-01");
    // 重连后即可提交
    state = expectOk(setMemberOnline(state, PLAYER_A_ID, true));
    state = expectOk(run(state, PLAYER_A_ID, { type: "confirmPreselect", slotId: "AB1" }));
    expect(state.bp.submissions[0]).toEqual({ slotId: "AB1", agentId: "agent-01" });
  });

  it("重开后旧命令过期；开始沿用保留的席位与队名", () => {
    let state = startedRoom();
    state = confirmStep(state, PLAYER_A_ID, "AB1", "agent-01");
    const versionBeforeRestart = state.bp.version;
    state = expectOk(run(state, HOST_ID, { type: "restartBp" }));
    expect(state.bp.status).toBe("waiting");
    // 使用重开前版本的命令已过期
    expectError(
      run(state, HOST_ID, { type: "startBp", expectedBpVersion: versionBeforeRestart }),
      "STALE_BP_VERSION",
    );
    // 当前版本的开始命令照常执行（席位与队名均保留）
    state = expectOk(run(state, HOST_ID, { type: "startBp" }));
    expect(state.bp.status).toBe("running");
    // 重开后的对局从头开始：第一提交仍是 AB1
    state = confirmStep(state, PLAYER_A_ID, "AB1", "agent-09");
    expect(state.bp.submissions[0]).toEqual({ slotId: "AB1", agentId: "agent-09" });
  });

  it("房主兼任选手时可执行选手命令", () => {
    let state = buildRoom();
    state = expectOk(
      run(state, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: HOST_ID }),
    );
    state = expectOk(run(state, HOST_ID, { type: "startBp" }));
    // 当前位 AB1 属 A 方：B 席选手不能代操作
    expectError(
      run(state, PLAYER_B_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-02" }),
      "NOT_CURRENT_PLAYER",
    );
    // 房主作为 A 席选手预选并确认
    state = expectOk(
      run(state, HOST_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
    );
    state = expectOk(run(state, HOST_ID, { type: "confirmPreselect", slotId: "AB1" }));
    expect(state.bp.submissions[0]).toEqual({ slotId: "AB1", agentId: "agent-01" });
    // 推进到 BB1 后轮到 B 席选手操作
    state = expectOk(
      run(state, PLAYER_B_ID, { type: "setPreselect", slotId: "BB1", agentId: "agent-02" }),
    );
    expect(state.bp.preselect).toBe("agent-02");
  });

  it("更换与清空预选：同值为空操作，清空后不可提交", () => {
    let state = startedRoom();
    state = expectOk(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
    );
    const version = state.bp.version;
    // 相同预选：空操作，版本不变
    expect(
      expectOk(
        run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
      ),
    ).toBe(state);
    expect(state.bp.version).toBe(version);
    // 更换预选推进版本
    state = expectOk(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-02" }),
    );
    expect(state.bp.preselect).toBe("agent-02");
    expect(state.bp.version).toBe(version + 1);
    // 清空后提交被拒；再次清空为空操作
    state = expectOk(run(state, PLAYER_A_ID, { type: "clearPreselect", slotId: "AB1" }));
    expect(state.bp.preselect).toBeNull();
    expectError(
      run(state, PLAYER_A_ID, { type: "confirmPreselect", slotId: "AB1" }),
      "NO_PRESELECT",
    );
    expect(expectOk(run(state, PLAYER_A_ID, { type: "clearPreselect", slotId: "AB1" }))).toBe(
      state,
    );
  });

  it("确认时复核预选：名单外代理人在确认阶段被拒（回归）", () => {
    // schema 只能保证结构合法，无法校验名单成员资格；服务端状态恢复或
    // 名单适配可能产生预选为名单外代理人的合法状态。构造仍满足全部
    // schema 不变量的进行中房间：当前位 AB1、预选 agent-99（合成名单外）。
    const base = startedRoom();
    const state = roomStateSchema.parse({
      ...base,
      bp: { ...base.bp, preselect: "agent-99" },
    });
    expect(state.bp.preselect).toBe("agent-99");
    expectError(
      run(state, PLAYER_A_ID, { type: "confirmPreselect", slotId: "AB1" }),
      "AGENT_NOT_IN_CATALOG",
    );
    // 失败不改变状态；重新预选名单内代理人后确认照常成功
    expect(state.bp.preselect).toBe("agent-99");
    let fixed = expectOk(
      run(state, PLAYER_A_ID, { type: "setPreselect", slotId: "AB1", agentId: "agent-01" }),
    );
    fixed = expectOk(run(fixed, PLAYER_A_ID, { type: "confirmPreselect", slotId: "AB1" }));
    expect(fixed.bp.submissions[0]).toEqual({ slotId: "AB1", agentId: "agent-01" });
  });
});
