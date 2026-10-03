import { describe, expect, it } from "vitest";
import {
  computeAgentPoolStatuses,
  computeAgentPoolUsage,
  getAgentPoolStatus,
  type AgentCatalog,
} from "../../shared/bp/agents";
import { currentBpStep } from "../../shared/bp/steps";
import type { BpSubmission } from "../../shared/bp/state";
import { SPEC_BP_STEP_ORDER, SYNTHETIC_AGENT_IDS, specSubmissions } from "./spec-bp-order";

/** 合成代理人目录；真实名单由数据接入 PR 提供。 */
const catalog: AgentCatalog = { agentIds: SYNTHETIC_AGENT_IDS };

describe("共用互斥代理人池", () => {
  it("未使用的代理人为可选", () => {
    const usage = computeAgentPoolUsage([]);
    expect(getAgentPoolStatus(usage, "agent-07")).toBe("available");
    expect(computeAgentPoolStatuses(catalog, []).get("agent-07")).toBe("available");
  });

  it("任意一方禁用后，双方都不能再禁用或选用该代理人", () => {
    // A 方第 1 个禁用位禁用 agent-01
    const submissions: BpSubmission[] = [{ slotId: "AB1", agentId: "agent-01" }];
    const usage = computeAgentPoolUsage(submissions);
    expect(usage.bannedAgentIds.has("agent-01")).toBe(true);
    expect(getAgentPoolStatus(usage, "agent-01")).toBe("banned");
    // 可用性判定不分阵营与动作：对 B 方的禁用与选用同样不可用
    const statuses = computeAgentPoolStatuses(catalog, submissions);
    expect(statuses.get("agent-01")).toBe("banned");
    expect(statuses.get("agent-02")).toBe("available");
  });

  it("任意一方选用后，另一方不能选用，任何一方也不能再禁用", () => {
    const submissions: BpSubmission[] = [
      { slotId: "AP1", agentId: "agent-01" },
      { slotId: "BP1", agentId: "agent-02" },
    ];
    const usage = computeAgentPoolUsage(submissions);
    expect(getAgentPoolStatus(usage, "agent-01")).toBe("picked");
    expect(getAgentPoolStatus(usage, "agent-02")).toBe("picked");
    expect(usage.pickedByTeam).toEqual({ A: ["agent-01"], B: ["agent-02"] });
  });

  it("同一方也不能重复选用已选代理人", () => {
    const usage = computeAgentPoolUsage([{ slotId: "AP1", agentId: "agent-01" }]);
    expect(getAgentPoolStatus(usage, "agent-01")).not.toBe("available");
  });

  it("各方选用结果按确认顺序保留", () => {
    const usage = computeAgentPoolUsage(specSubmissions(4));
    // 前四步依次为 AB1 BB1 AB2 BB2，均为禁用
    expect(usage.pickedByTeam).toEqual({ A: [], B: [] });
    const withPicks = computeAgentPoolUsage(specSubmissions(8));
    // 前八步为 AB1 BB1 AB2 BB2 AP1 BP1 BP2 AP2
    expect(withPicks.pickedByTeam.A).toEqual(["agent-05", "agent-08"]);
    expect(withPicks.pickedByTeam.B).toEqual(["agent-06", "agent-07"]);
  });

  it("完整 26 步后：8 名禁用、18 名选用，名单内前 26 人均不可再用", () => {
    const submissions = specSubmissions(26);
    expect(submissions).toHaveLength(SPEC_BP_STEP_ORDER.length);
    const usage = computeAgentPoolUsage(submissions);
    expect(usage.bannedAgentIds.size).toBe(8);
    expect(usage.pickedAgentIds.size).toBe(18);
    expect(usage.pickedByTeam.A).toHaveLength(9);
    expect(usage.pickedByTeam.B).toHaveLength(9);
    for (const agentId of SYNTHETIC_AGENT_IDS.slice(0, 26)) {
      expect(getAgentPoolStatus(usage, agentId)).not.toBe("available");
    }
    for (const agentId of SYNTHETIC_AGENT_IDS.slice(26)) {
      expect(getAgentPoolStatus(usage, agentId)).toBe("available");
    }

    const statuses = computeAgentPoolStatuses(catalog, submissions);
    expect(statuses.size).toBe(30);
    expect([...statuses.values()].filter((status) => status === "banned")).toHaveLength(8);
    expect([...statuses.values()].filter((status) => status === "picked")).toHaveLength(18);
    expect([...statuses.values()].filter((status) => status === "available")).toHaveLength(4);
    // 最后一个位置 AP9 提交后不再有当前操作位
    expect(currentBpStep(submissions.length)).toBeNull();
  });
});
