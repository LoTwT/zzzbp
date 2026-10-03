import { describe, expect, it } from "vitest";
import {
  nicknameSchema,
  roomLifecycleSchema,
  roomNameSchema,
  roomStateSchema,
  teamNameInputSchema,
  teamNameSchema,
} from "../../shared/room";
import { specSubmissions } from "./spec-bp-order";

/**
 * 名称字段的码点边界用增补平面字符（如 U+1F600「😀」）验证：
 * 每个 emoji 是 1 个码点、2 个 UTF-16 单元，若实现误用 UTF-16
 * .length 计数，这些用例会失败。
 */
describe("展示名称字段约束", () => {
  it("房间名：trim 后 1 到 80 码点", () => {
    expect(roomNameSchema.parse("  绝区零 BP  ")).toBe("绝区零 BP");
    expect(roomNameSchema.safeParse("a".repeat(80)).success).toBe(true);
    expect(roomNameSchema.safeParse("a".repeat(81)).success).toBe(false);
    expect("😀".repeat(80).length).toBe(160);
    expect(roomNameSchema.safeParse("😀".repeat(80)).success).toBe(true);
    expect(roomNameSchema.safeParse("😀".repeat(81)).success).toBe(false);
    expect(roomNameSchema.safeParse("   ").success).toBe(false);
    expect(roomNameSchema.safeParse("").success).toBe(false);
  });

  it("队伍名存储态：允许为空，最长 32 码点", () => {
    expect(teamNameSchema.parse("")).toBe("");
    expect(teamNameSchema.parse("  ")).toBe("");
    expect(teamNameSchema.safeParse("队".repeat(32)).success).toBe(true);
    expect(teamNameSchema.safeParse("队".repeat(33)).success).toBe(false);
    expect(teamNameSchema.safeParse("😀".repeat(32)).success).toBe(true);
    expect(teamNameSchema.safeParse("😀".repeat(33)).success).toBe(false);
  });

  it("队伍名填写/修改输入：trim 后 1 到 32 码点，不允许为空", () => {
    expect(teamNameInputSchema.parse(" A 队 ")).toBe("A 队");
    expect(teamNameInputSchema.safeParse("A".repeat(32)).success).toBe(true);
    expect(teamNameInputSchema.safeParse("A".repeat(33)).success).toBe(false);
    expect(teamNameInputSchema.safeParse("").success).toBe(false);
    expect(teamNameInputSchema.safeParse("   ").success).toBe(false);
  });

  it("昵称：trim 后 1 到 24 码点", () => {
    expect(nicknameSchema.parse(" 小鱼 ")).toBe("小鱼");
    expect(nicknameSchema.safeParse("鱼".repeat(24)).success).toBe(true);
    expect(nicknameSchema.safeParse("鱼".repeat(25)).success).toBe(false);
    expect(nicknameSchema.safeParse("😀".repeat(24)).success).toBe(true);
    expect(nicknameSchema.safeParse("😀".repeat(25)).success).toBe(false);
    expect(nicknameSchema.safeParse("  ").success).toBe(false);
  });
});

/** 合法房间：房主兼任 A 方选手，B 队名尚未填写，BP 待开始。 */
const liveRoom = {
  roomId: "room-1",
  name: "拓金杯 BP",
  lifecycle: "live",
  hostMemberId: "member-1",
  teamNames: { A: "左方", B: "" },
  seats: { A: "member-1", B: "member-2" },
  members: [
    { memberId: "member-1", nickname: "房主兼选手", online: true },
    { memberId: "member-2", nickname: "B 方选手", online: false },
    { memberId: "member-3", nickname: "观众", online: true },
  ],
  revision: 0,
  bp: { status: "waiting", submissions: [], preselect: null, version: 0 },
} as const;

describe("房间核心状态", () => {
  it("接受合法的 live 房间：房主兼任选手、席位成员可为离线、队名可空", () => {
    expect(roomStateSchema.parse(liveRoom)).toEqual(liveRoom);
  });

  it("生命周期与 BP 状态分离：归档不改写 BP 状态", () => {
    const archivedCompleted = {
      ...liveRoom,
      lifecycle: "archived",
      bp: { status: "completed", submissions: specSubmissions(26), preselect: null, version: 9 },
    };
    expect(roomStateSchema.parse(archivedCompleted)).toEqual(archivedCompleted);

    // 未完成 BP 的房间同样可以归档，BP 状态保持原样
    const archivedUnfinished = {
      ...liveRoom,
      lifecycle: "archived",
      bp: { status: "paused", submissions: specSubmissions(3), preselect: null, version: 9 },
    };
    expect(roomStateSchema.parse(archivedUnfinished)).toEqual(archivedUnfinished);
  });

  it("席位为空合法", () => {
    expect(roomStateSchema.safeParse({ ...liveRoom, seats: { A: null, B: null } }).success).toBe(
      true,
    );
    expect(
      roomStateSchema.safeParse({ ...liveRoom, seats: { A: "member-3", B: null } }).success,
    ).toBe(true);
  });

  it("同一成员最多占一个席位", () => {
    expect(
      roomStateSchema.safeParse({ ...liveRoom, seats: { A: "member-3", B: "member-3" } }).success,
    ).toBe(false);
  });

  it("房主必须是房间成员", () => {
    expect(roomStateSchema.safeParse({ ...liveRoom, hostMemberId: "member-x" }).success).toBe(
      false,
    );
  });

  it("席位成员必须是房间成员", () => {
    expect(
      roomStateSchema.safeParse({ ...liveRoom, seats: { A: "member-x", B: "member-2" } }).success,
    ).toBe(false);
  });

  it("成员 ID 不得重复", () => {
    const duplicated = {
      ...liveRoom,
      members: [...liveRoom.members, { memberId: "member-1", nickname: "重复成员", online: false }],
    };
    expect(roomStateSchema.safeParse(duplicated).success).toBe(false);
  });

  it("生命周期取值：live 与 archived", () => {
    expect(roomLifecycleSchema.parse("live")).toBe("live");
    expect(roomLifecycleSchema.parse("archived")).toBe("archived");
    expect(roomLifecycleSchema.safeParse("closed").success).toBe(false);
    expect(roomLifecycleSchema.safeParse("live ").success).toBe(false);
  });

  it("公开 revision：非负整数", () => {
    expect(roomStateSchema.safeParse({ ...liveRoom, revision: 7 }).success).toBe(true);
    expect(roomStateSchema.safeParse({ ...liveRoom, revision: -1 }).success).toBe(false);
    expect(roomStateSchema.safeParse({ ...liveRoom, revision: 1.5 }).success).toBe(false);
    expect(roomStateSchema.safeParse({ ...liveRoom, revision: "3" }).success).toBe(false);
    // 缺失 revision 同样被拒绝
    expect(roomStateSchema.safeParse({ ...liveRoom, revision: undefined }).success).toBe(false);
  });
});
