import { describe, expect, it } from "vitest";
import { roomCommandSchema } from "../../shared/commands";
import { nextOperationId } from "./room-fixture";

/**
 * 命令 schema 契约：只接受操作意图本身；角色、在线状态等自报字段
 * 一律剥离，不进入命令结构。
 */
const base = { operationId: nextOperationId(), expectedBpVersion: 3 };

describe("房间命令 schema", () => {
  it("解析全部十类命令", () => {
    const samples = [
      { type: "setTeamName", team: "A", teamName: "左方", expectedRevision: 5 },
      { type: "assignSeat", team: "B", targetMemberId: "member-1" },
      { type: "startBp" },
      { type: "pauseBp" },
      { type: "resumeBp" },
      { type: "undoBpStep" },
      { type: "restartBp" },
      { type: "setPreselect", slotId: "AB1", agentId: "agent-01" },
      { type: "clearPreselect", slotId: "AB1" },
      { type: "confirmPreselect", slotId: "AB1" },
    ];
    for (const sample of samples) {
      const result = roomCommandSchema.safeParse({ ...base, ...sample });
      expect(result.success).toBe(true);
    }
  });

  it("剥离客户端自报的角色、在线状态与身份字段", () => {
    const parsed = roomCommandSchema.parse({
      ...base,
      type: "startBp",
      role: "host",
      online: true,
      memberId: "member-forged",
      hostMemberId: "member-forged",
    });
    expect(parsed).toEqual({
      operationId: base.operationId,
      expectedBpVersion: 3,
      type: "startBp",
    });
    expect("role" in parsed).toBe(false);
    expect("memberId" in parsed).toBe(false);
  });

  it("拒绝未知命令类型与缺失字段", () => {
    expect(roomCommandSchema.safeParse({ ...base, type: "unknownCommand" }).success).toBe(false);
    expect(roomCommandSchema.safeParse({ type: "startBp" }).success).toBe(false);
    expect(roomCommandSchema.safeParse({ ...base, operationId: "", type: "startBp" }).success).toBe(
      false,
    );
    expect(
      roomCommandSchema.safeParse({ ...base, type: "setPreselect", agentId: "agent-01" }).success,
    ).toBe(false);
  });

  it("校验公共字段与各命令的字段约束", () => {
    // operationId：trim 后非空
    expect(
      roomCommandSchema.safeParse({ ...base, operationId: "  ", type: "startBp" }).success,
    ).toBe(false);
    // expectedBpVersion：非负整数
    for (const expectedBpVersion of [-1, 1.5, "3"]) {
      expect(
        roomCommandSchema.safeParse({ ...base, expectedBpVersion, type: "startBp" }).success,
      ).toBe(false);
    }
    // 队伍名输入：非空、最长 32 码点、自动 trim
    expect(
      roomCommandSchema.safeParse({
        ...base,
        type: "setTeamName",
        team: "A",
        teamName: "   ",
        expectedRevision: 5,
      }).success,
    ).toBe(false);
    expect(
      roomCommandSchema.safeParse({
        ...base,
        type: "setTeamName",
        team: "A",
        teamName: "x".repeat(33),
        expectedRevision: 5,
      }).success,
    ).toBe(false);
    expect(
      roomCommandSchema.parse({
        ...base,
        type: "setTeamName",
        team: "A",
        teamName: " 左方 ",
        expectedRevision: 5,
      }),
    ).toMatchObject({ teamName: "左方" });
    // expectedRevision：setTeamName 必填且为非负整数（其余命令不接受该字段）
    expect(
      roomCommandSchema.safeParse({ ...base, type: "setTeamName", team: "A", teamName: "左方" })
        .success,
    ).toBe(false);
    for (const expectedRevision of [-1, 1.5, "5"]) {
      expect(
        roomCommandSchema.safeParse({
          ...base,
          type: "setTeamName",
          team: "A",
          teamName: "左方",
          expectedRevision,
        }).success,
      ).toBe(false);
    }
    // 阵营与操作位枚举
    expect(
      roomCommandSchema.safeParse({
        ...base,
        type: "assignSeat",
        team: "C",
        targetMemberId: "member-1",
      }).success,
    ).toBe(false);
    expect(
      roomCommandSchema.safeParse({
        ...base,
        type: "setPreselect",
        slotId: "XX1",
        agentId: "agent-01",
      }).success,
    ).toBe(false);
  });
});
