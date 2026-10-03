import { describe, expect, it } from "vitest";
import {
  bpPublicViewSchema,
  displayViewSchema,
  hostManagementViewSchema,
  projectBpPublicView,
  projectDisplayView,
  projectHostManagementView,
  projectRoomMemberView,
  roomMemberViewSchema,
} from "../../../shared/contracts/views";
import type { VersionInfo } from "../../../shared/contracts/versions";
import type { RoomState } from "../../../shared/room";
import {
  AUDIENCE_ID,
  HOST_ID,
  PLAYER_A_ID,
  PLAYER_B_ID,
  buildRoom,
  completedRoom,
  confirmStep,
  expectOk,
  run,
  startedRoom,
} from "../room-fixture";
import { SPEC_BP_STEP_ORDER } from "../spec-bp-order";

const versions: VersionInfo = { ruleVersion: "rules-test", agentDataVersion: "agents-test" };

describe("视图投影：白名单与隐私", () => {
  it("公开/展示视图只含公开字段，不泄漏任何成员数据", () => {
    const state = startedRoom();
    const view = projectBpPublicView(state, versions);
    expect(bpPublicViewSchema.parse(view)).toEqual(view);
    expect(displayViewSchema.parse(projectDisplayView(state, versions))).toEqual(view);

    // 白名单：字段集合固定
    expect(Object.keys(view).sort()).toEqual([
      "bpStatus",
      "currentSlotId",
      "preselect",
      "revision",
      "roomName",
      "seatOccupancy",
      "submissions",
      "teamNames",
      "versions",
    ]);
    // 嵌套对象字段集合同样固定
    expect(Object.keys(view.teamNames).sort()).toEqual(["A", "B"]);
    expect(Object.keys(view.seatOccupancy).sort()).toEqual(["A", "B"]);
    expect(Object.keys(view.versions).sort()).toEqual(["agentDataVersion", "ruleVersion"]);
    // 序列化结果不含成员 ID、昵称、在线数据或席位成员
    const serialized = JSON.stringify(view);
    for (const secret of [
      HOST_ID,
      PLAYER_A_ID,
      PLAYER_B_ID,
      AUDIENCE_ID,
      "房主",
      "A 选手",
      "online",
      "seats",
    ]) {
      expect(serialized.includes(secret)).toBe(false);
    }
  });

  it("嵌套对象按白名单重建：各层注入的内部字段均不泄漏", () => {
    let state = startedRoom();
    state = confirmStep(state, PLAYER_A_ID, "AB1", "agent-01");
    // 模拟服务端异常在状态各层与版本信息上挂内部字段（合成 token）
    const tainted = {
      ...state,
      credential: "token-top-level",
      teamNames: { ...state.teamNames, credential: "token-team-names" },
      bp: {
        ...state.bp,
        submissions: state.bp.submissions.map((submission) => ({
          ...submission,
          credential: "token-submission",
        })),
      },
    } as unknown as RoomState;
    const taintedVersions = {
      ...versions,
      credential: "token-versions",
    } as VersionInfo;

    const view = projectBpPublicView(tainted, taintedVersions);
    const serialized = JSON.stringify(view);
    for (const token of [
      "token-top-level",
      "token-team-names",
      "token-submission",
      "token-versions",
      "credential",
    ]) {
      expect(serialized.includes(token)).toBe(false);
    }
    // 重建后的嵌套内容与原值一致，且提交条目只含白名单字段
    expect(view.teamNames).toEqual({ A: "左方", B: "右方" });
    expect(view.submissions).toEqual([{ slotId: "AB1", agentId: "agent-01" }]);
    expect(Object.keys(view.submissions[0]).sort()).toEqual(["agentId", "slotId"]);
    expect(view.versions).toEqual({ ruleVersion: "rules-test", agentDataVersion: "agents-test" });
  });

  it("修改视图输出的嵌套数据不会污染输入状态与版本信息", () => {
    const state = startedRoom();
    const before = structuredClone(state);
    const view = projectBpPublicView(state, versions);
    // 视图与输入不共享嵌套引用
    expect(view.teamNames).not.toBe(state.teamNames);
    expect(view.submissions).not.toBe(state.bp.submissions);
    expect(view.versions).not.toBe(versions);
    // 修改输出后输入保持不变
    view.teamNames.A = "被修改";
    view.seatOccupancy.A = false;
    view.versions.ruleVersion = "被修改";
    expect(state).toEqual(before);
    expect(versions).toEqual({ ruleVersion: "rules-test", agentDataVersion: "agents-test" });
  });

  it("席位占用：空席与已占席在公开视图中可区分且不泄漏成员", () => {
    // 同房名、同队名、同 revision 的待开始房间，仅 A 席有无选手不同
    const occupied = buildRoom();
    const emptySeat = buildRoom({ seatA: null });
    const occupiedView = projectBpPublicView(occupied, versions);
    const emptyView = projectBpPublicView(emptySeat, versions);
    expect(occupiedView.seatOccupancy).toEqual({ A: true, B: true });
    expect(emptyView.seatOccupancy).toEqual({ A: false, B: true });
    // 除席位占用外其余公开内容完全一致
    expect({ ...emptyView, seatOccupancy: occupiedView.seatOccupancy }).toEqual(occupiedView);
    // 席位占用不携带成员身份
    const serialized = JSON.stringify(emptyView) + JSON.stringify(occupiedView);
    for (const secret of [HOST_ID, PLAYER_A_ID, PLAYER_B_ID, AUDIENCE_ID, "房主", "A 选手"]) {
      expect(serialized.includes(secret)).toBe(false);
    }
  });

  it("状态对象上多出的内部字段不会泄漏进视图", () => {
    const state = startedRoom();
    // 模拟服务端异常把凭据挂在状态对象上：投影按白名单构造，不转发原对象
    const tainted = { ...state, credential: "secret-token" } as unknown as RoomState;
    const view = projectBpPublicView(tainted, versions);
    const serialized = JSON.stringify(view);
    expect(serialized.includes("secret-token")).toBe(false);
    expect(serialized.includes("credential")).toBe(false);
  });

  it("当前操作位随进度推进：待开始为空、完成后为空", () => {
    expect(projectBpPublicView(buildRoom(), versions).currentSlotId).toBeNull();
    let state = startedRoom();
    expect(projectBpPublicView(state, versions).currentSlotId).toBe("AB1");
    state = confirmStep(state, PLAYER_A_ID, "AB1", "agent-01");
    state = confirmStep(state, PLAYER_B_ID, "BB1", "agent-02");
    expect(projectBpPublicView(state, versions).currentSlotId).toBe(SPEC_BP_STEP_ORDER[2]);
    const completed = completedRoom();
    const completedView = projectBpPublicView(completed, versions);
    expect(completedView.currentSlotId).toBeNull();
    expect(completedView.submissions).toHaveLength(26);
    expect(completedView.bpStatus).toBe("completed");
  });
});

describe("成员与房主视图差异", () => {
  it("普通成员视图：仅含自身身份与席位，含命令所需 bpVersion", () => {
    const state = startedRoom();
    const view = projectRoomMemberView(state, PLAYER_A_ID, versions);
    if (view === null) throw new Error("成员视图不应为空");
    expect(roomMemberViewSchema.parse(view)).toEqual(view);
    expect(view.self).toEqual({
      memberId: PLAYER_A_ID,
      nickname: "A 选手",
      isHost: false,
      seatTeam: "A",
    });
    expect(view.bpVersion).toBe(state.bp.version);
    // 只含本人成员 ID 与昵称，不含其他成员
    const serialized = JSON.stringify(view);
    expect(serialized.includes(PLAYER_A_ID)).toBe(true);
    for (const other of [HOST_ID, PLAYER_B_ID, AUDIENCE_ID, "房主", "B 选手", "观众"]) {
      expect(serialized.includes(other)).toBe(false);
    }
    // 未知查看者没有视图
    expect(projectRoomMemberView(state, "member-unknown", versions)).toBeNull();
  });

  it("展示视图没有 bpVersion 与自身信息", () => {
    const state = startedRoom();
    const display = projectDisplayView(state, versions);
    expect("bpVersion" in display).toBe(false);
    expect("self" in display).toBe(false);
    expect("members" in display).toBe(false);
  });

  it("房主视图：成员列表含席位与在线状态；非房主没有该视图", () => {
    const state = startedRoom();
    expect(projectHostManagementView(state, PLAYER_A_ID, versions)).toBeNull();
    expect(projectHostManagementView(state, AUDIENCE_ID, versions)).toBeNull();

    const view = projectHostManagementView(state, HOST_ID, versions);
    if (view === null) throw new Error("房主视图不应为空");
    expect(hostManagementViewSchema.parse(view)).toEqual(view);
    expect(view.members).toHaveLength(4);
    const seatA = view.members.find((member) => member.memberId === PLAYER_A_ID);
    expect(seatA).toMatchObject({ seatTeam: "A", online: true, isHost: false });
    const host = view.members.find((member) => member.memberId === HOST_ID);
    expect(host).toMatchObject({ seatTeam: null, isHost: true });
  });

  it("房主兼任与被换下后的投影仍然正确", () => {
    // 房主兼任 A 席
    let state = expectOk(
      run(buildRoom(), HOST_ID, { type: "assignSeat", team: "A", targetMemberId: HOST_ID }),
    );
    const hostAsPlayer = projectRoomMemberView(state, HOST_ID, versions);
    expect(hostAsPlayer?.self).toEqual({
      memberId: HOST_ID,
      nickname: "房主",
      isHost: true,
      seatTeam: "A",
    });
    // 房主被换下：仍为房主，但不再占席
    state = expectOk(
      run(state, HOST_ID, { type: "assignSeat", team: "A", targetMemberId: PLAYER_A_ID }),
    );
    const replacedHost = projectRoomMemberView(state, HOST_ID, versions);
    expect(replacedHost?.self.isHost).toBe(true);
    expect(replacedHost?.self.seatTeam).toBeNull();
    // 仍能获得房主管理视图
    const management = projectHostManagementView(state, HOST_ID, versions);
    expect(management?.self.seatTeam).toBeNull();
    expect(management?.members.find((m) => m.memberId === PLAYER_A_ID)?.seatTeam).toBe("A");
    // 接任选手视图正确
    const newPlayer = projectRoomMemberView(state, PLAYER_A_ID, versions);
    expect(newPlayer?.self).toMatchObject({ isHost: false, seatTeam: "A" });
  });
});
