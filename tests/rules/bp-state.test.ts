import { describe, expect, it } from "vitest";
import { bpProgressSchema, bpStatusSchema, bpSubmissionSchema } from "../../shared/bp/state";
import { specSubmissions } from "./spec-bp-order";

/** 最小合法进度：待开始、无提交、无预选、版本 0。 */
const waitingProgress = {
  status: "waiting",
  submissions: [],
  preselect: null,
  version: 0,
} as const;

describe("BP 进度核心状态", () => {
  it("接受且仅接受四种状态值", () => {
    for (const status of ["waiting", "running", "paused", "completed"] as const) {
      expect(bpStatusSchema.parse(status)).toBe(status);
    }
    for (const invalid of ["pending", "finished", "live", ""]) {
      expect(bpStatusSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("待开始：不允许已确认提交，也不允许预选", () => {
    expect(bpProgressSchema.parse(waitingProgress)).toEqual(waitingProgress);
    expect(
      bpProgressSchema.safeParse({ ...waitingProgress, submissions: specSubmissions(1) }).success,
    ).toBe(false);
    expect(bpProgressSchema.safeParse({ ...waitingProgress, preselect: "agent-01" }).success).toBe(
      false,
    );
  });

  it("进行中/已暂停：确认数少于 26，预选可有可无", () => {
    expect(
      bpProgressSchema.safeParse({
        status: "running",
        submissions: [],
        preselect: null,
        version: 3,
      }).success,
    ).toBe(true);
    expect(
      bpProgressSchema.safeParse({
        status: "running",
        submissions: specSubmissions(1),
        preselect: "agent-09",
        version: 4,
      }).success,
    ).toBe(true);
    // 已完成状态撤回最后一步后的形态：25 条提交 + 暂停
    expect(
      bpProgressSchema.safeParse({
        status: "paused",
        submissions: specSubmissions(25),
        preselect: null,
        version: 40,
      }).success,
    ).toBe(true);
    expect(
      bpProgressSchema.safeParse({
        status: "running",
        submissions: specSubmissions(26),
        preselect: null,
        version: 41,
      }).success,
    ).toBe(false);
    expect(
      bpProgressSchema.safeParse({
        status: "paused",
        submissions: specSubmissions(26),
        preselect: "agent-09",
        version: 42,
      }).success,
    ).toBe(false);
  });

  it("已完成：恰 26 条提交且无预选", () => {
    const completed = {
      status: "completed",
      submissions: specSubmissions(26),
      preselect: null,
      version: 50,
    };
    expect(bpProgressSchema.parse(completed)).toEqual(completed);
    expect(
      bpProgressSchema.safeParse({ ...completed, submissions: specSubmissions(25) }).success,
    ).toBe(false);
    expect(bpProgressSchema.safeParse({ ...completed, preselect: "agent-01" }).success).toBe(false);
  });

  it("有效序列必须是既定顺序的前缀", () => {
    const wrongFirst = [{ slotId: "BB1", agentId: "agent-01" }];
    expect(
      bpProgressSchema.safeParse({
        status: "running",
        submissions: wrongFirst,
        preselect: null,
        version: 1,
      }).success,
    ).toBe(false);

    const wrongSecond = [
      { slotId: "AB1", agentId: "agent-01" },
      { slotId: "AP1", agentId: "agent-02" },
    ];
    expect(
      bpProgressSchema.safeParse({
        status: "running",
        submissions: wrongSecond,
        preselect: null,
        version: 1,
      }).success,
    ).toBe(false);
  });

  it("有效提交不得重复使用同一代理人", () => {
    const duplicated = [
      { slotId: "AB1", agentId: "agent-01" },
      { slotId: "BB1", agentId: "agent-01" },
    ];
    expect(
      bpProgressSchema.safeParse({
        status: "running",
        submissions: duplicated,
        preselect: null,
        version: 1,
      }).success,
    ).toBe(false);
    // 禁用与选用同样互斥：已禁用的不能再被选用
    const bannedThenPicked = [
      { slotId: "AB1", agentId: "agent-01" },
      { slotId: "AP1", agentId: "agent-01" },
    ];
    expect(
      bpProgressSchema.safeParse({
        status: "running",
        submissions: bannedThenPicked,
        preselect: null,
        version: 1,
      }).success,
    ).toBe(false);
  });

  it("预选不能是已在本局使用的代理人", () => {
    expect(
      bpProgressSchema.safeParse({
        status: "running",
        submissions: specSubmissions(1),
        preselect: "agent-01",
        version: 1,
      }).success,
    ).toBe(false);
    // 未使用的代理人可以成为预选
    expect(
      bpProgressSchema.safeParse({
        status: "running",
        submissions: specSubmissions(1),
        preselect: "agent-09",
        version: 1,
      }).success,
    ).toBe(true);
  });

  it("版本必须是非负整数", () => {
    for (const version of [0, 7, 1000]) {
      expect(bpProgressSchema.safeParse({ ...waitingProgress, version }).success).toBe(true);
    }
    for (const version of [-1, 1.5, "3", null]) {
      expect(bpProgressSchema.safeParse({ ...waitingProgress, version }).success).toBe(false);
    }
  });

  it("提交条目：非法操作位或空白代理人 ID 被拒绝", () => {
    expect(bpSubmissionSchema.safeParse({ slotId: "AB1", agentId: "agent-01" }).success).toBe(true);
    expect(bpSubmissionSchema.safeParse({ slotId: "XX1", agentId: "agent-01" }).success).toBe(
      false,
    );
    expect(bpSubmissionSchema.safeParse({ slotId: "AB1", agentId: "  " }).success).toBe(false);
    expect(bpSubmissionSchema.safeParse({ slotId: "AB1" }).success).toBe(false);
  });
});
