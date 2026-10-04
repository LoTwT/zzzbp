import { expect, test } from "vitest";
import { BP_STEP_ORDER } from "../../shared/bp/steps";
import type { HostManagementView } from "../../shared/contracts/views";
import {
  memberRoleText,
  otherMemberRows,
  seatSelectionRows,
  sideLabel,
  startBlockers,
  undoTargetDescription,
} from "../../src/room/host-panels";

// 房主面板派生逻辑：开局条件文案、席位候选、成员列表与撤回描述。

function member(
  memberId: string,
  overrides: Partial<HostManagementView["members"][number]> = {},
): HostManagementView["members"][number] {
  return {
    memberId,
    nickname: `成员${memberId}`,
    isHost: false,
    seatTeam: null,
    online: true,
    ...overrides,
  };
}

function hostView(overrides: Partial<HostManagementView> = {}): HostManagementView {
  return {
    roomName: "测试杯",
    teamNames: { A: "", B: "" },
    seatOccupancy: { A: false, B: false },
    bpStatus: "waiting",
    currentSlotId: null,
    submissions: [],
    preselect: null,
    versions: { ruleVersion: "test-rule", agentDataVersion: "0.2.1" },
    revision: 1,
    self: { memberId: "host", nickname: "房主", isHost: true, seatTeam: null },
    bpVersion: 0,
    members: [member("host", { isHost: true, nickname: "房主" })],
    ...overrides,
  } as HostManagementView;
}

test("startBlockers：未命名时用左方/右方指位，按队名/席位/在线分别列出", () => {
  const blockers = startBlockers(
    hostView({
      teamNames: { A: "甲队", B: "" },
      members: [
        member("host", { isHost: true }),
        member("p1", { seatTeam: "A", nickname: "选手甲" }),
      ],
      seatOccupancy: { A: true, B: false },
    }),
  );
  expect(blockers).toEqual(["右方队伍名未填写", "右方席位无选手"]);
});

test("startBlockers：命名后用队名指位，离线选手被列出", () => {
  const blockers = startBlockers(
    hostView({
      teamNames: { A: "甲队", B: "乙队" },
      members: [
        member("host", { isHost: true }),
        member("p1", { seatTeam: "A", online: false }),
        member("p2", { seatTeam: "B" }),
      ],
      seatOccupancy: { A: true, B: true },
    }),
  );
  expect(blockers).toEqual(["甲队选手不在线"]);
});

test("startBlockers：条件满足时为空", () => {
  expect(
    startBlockers(
      hostView({
        teamNames: { A: "甲队", B: "乙队" },
        members: [
          member("host", { isHost: true }),
          member("p1", { seatTeam: "A" }),
          member("p2", { seatTeam: "B" }),
        ],
        seatOccupancy: { A: true, B: true },
      }),
    ),
  ).toEqual([]);
});

test("seatSelectionRows：按成员顺序原位排列；现任选手保留、另一队选手与离线者不进入候选", () => {
  const view = hostView({
    bpStatus: "paused",
    members: [
      member("host", { isHost: true, nickname: "房主" }),
      member("pa", { seatTeam: "A", nickname: "现任" }),
      member("pb", { seatTeam: "B", nickname: "对方选手" }),
      member("off", { online: false }),
      member("sub1"),
      member("sub2"),
    ],
  });
  const rows = seatSelectionRows(view, "A");
  // 行序沿成员顺序（服务端按加入顺序返回），不以当前选手置顶。
  expect(rows.map((row) => row.member.memberId)).toEqual(["host", "pa", "sub1", "sub2"]);
  expect(rows.map((row) => row.isCurrent)).toEqual([false, true, false, false]);
  expect(rows.map((row) => row.eligible)).toEqual([true, false, true, true]);
});

test("seatSelectionRows：空席时无现任行，仍列出候选", () => {
  const rows = seatSelectionRows(hostView(), "A");
  expect(rows.map((row) => row.member.memberId)).toEqual(["host"]);
  expect(rows.every((row) => !row.isCurrent && row.eligible)).toBe(true);
});

test("seatSelectionRows：离线现任选手保留原行（按钮由视图层禁用）", () => {
  const rows = seatSelectionRows(
    hostView({
      bpStatus: "paused",
      members: [
        member("host", { isHost: true }),
        member("pa", { seatTeam: "A", online: false }),
        member("sub1"),
      ],
    }),
    "A",
  );
  expect(rows.map((row) => row.member.memberId)).toEqual(["host", "pa", "sub1"]);
  const current = rows.find((row) => row.member.memberId === "pa")!;
  expect(current.isCurrent).toBe(true);
  expect(current.eligible).toBe(false);
});

test("seatSelectionRows：房主占另一席时不进入本队候选", () => {
  const rows = seatSelectionRows(
    hostView({
      bpStatus: "paused",
      members: [
        member("host", { isHost: true, seatTeam: "B" }),
        member("pa", { seatTeam: "A" }),
        member("sub1"),
      ],
    }),
    "A",
  );
  // 房主已占 B 席：不出现在 A 队列表（服务端也按此拒绝）。
  expect(rows.map((row) => row.member.memberId)).toEqual(["pa", "sub1"]);
});

test("seatSelectionRows：已展示过的行在资格消失后保留（如离线），未展示的离线成员不进入", () => {
  const view = hostView({
    bpStatus: "paused",
    members: [
      member("host", { isHost: true }),
      member("pa", { seatTeam: "A" }),
      member("wasShown", { online: false }),
      member("neverShown", { online: false }),
      member("sub1"),
    ],
  });
  const rows = seatSelectionRows(view, "A", new Set(["wasShown"]));
  expect(rows.map((row) => row.member.memberId)).toEqual(["host", "pa", "wasShown", "sub1"]);
  const retained = rows.find((row) => row.member.memberId === "wasShown")!;
  expect(retained.isCurrent).toBe(false);
  expect(retained.eligible).toBe(false);
});

test("seatSelectionRows：换人后行序不变，仅原行角色变化（稳定行序回归）", () => {
  const before = hostView({
    bpStatus: "paused",
    members: [
      member("host", { isHost: true }),
      member("oldPlayer", { seatTeam: "A", nickname: "选手 01" }),
      member("newPlayer", { nickname: "小鱼" }),
      member("sub1"),
    ],
  });
  const after = hostView({
    bpStatus: "paused",
    revision: before.revision + 1,
    members: [
      member("host", { isHost: true }),
      member("oldPlayer", { nickname: "选手 01" }),
      member("newPlayer", { seatTeam: "A", nickname: "小鱼" }),
      member("sub1"),
    ],
  });
  const rowsBefore = seatSelectionRows(before, "A");
  const rowsAfter = seatSelectionRows(
    after,
    "A",
    new Set(rowsBefore.map((r) => r.member.memberId)),
  );
  // 换人前后各成员行位置完全一致（线框更换选手 v3 before/after）。
  expect(rowsAfter.map((row) => row.member.memberId)).toEqual(
    rowsBefore.map((row) => row.member.memberId),
  );
  expect(rowsAfter.find((row) => row.member.memberId === "oldPlayer")?.eligible).toBe(true);
  expect(rowsAfter.find((row) => row.member.memberId === "newPlayer")?.isCurrent).toBe(true);
});

test("otherMemberRows：仅双方选手以外成员（未占席房主计入，含离线）", () => {
  const view = hostView({
    members: [
      member("host", { isHost: true }),
      member("pa", { seatTeam: "A" }),
      member("pb", { seatTeam: "B" }),
      member("sub", { online: false }),
    ],
  });
  expect(otherMemberRows(view).map((row) => row.memberId)).toEqual(["host", "sub"]);
});

test("memberRoleText：房主兼任与普通成员的四种角色文案", () => {
  expect(memberRoleText({ isHost: true, seatTeam: null })).toBe("房主");
  expect(memberRoleText({ isHost: true, seatTeam: "A" })).toBe("房主 · 选手");
  expect(memberRoleText({ isHost: false, seatTeam: "B" })).toBe("选手");
  expect(memberRoleText({ isHost: false, seatTeam: null })).toBe("观众");
});

test("sideLabel：A 为左方、B 为右方", () => {
  expect(sideLabel("A")).toBe("左方");
  expect(sideLabel("B")).toBe("右方");
});

test("undoTargetDescription：第几步 + 左右方动作 + 代理人名称；无提交为 null", () => {
  expect(undoTargetDescription(hostView(), () => "雅")).toBeNull();
  const view = hostView({
    bpStatus: "running",
    currentSlotId: "BP1",
    submissions: [
      { slotId: "AB1", agentId: "1011" },
      { slotId: "BB1", agentId: "1241" },
    ],
  });
  expect(undoTargetDescription(view, (agentId) => (agentId === "1241" ? "猫又" : "未知"))).toBe(
    "第 2 步 · 右方禁用 · 猫又",
  );
});

test("undoTargetDescription：选用动作描述", () => {
  const view = hostView({
    bpStatus: "running",
    currentSlotId: "BP1",
    submissions: [{ slotId: "AP1", agentId: "1591" }],
  });
  expect(undoTargetDescription(view, () => "希格莉德")).toBe("第 1 步 · 左方选用 · 希格莉德");
});

// 提交序列前缀与权威顺序一致（视图 schema 不变量），这里直接复用其顺序。
test("BP_STEP_ORDER 首位为 AB1，保证测试步骤语义稳定", () => {
  expect(BP_STEP_ORDER[0]).toBe("AB1");
});
