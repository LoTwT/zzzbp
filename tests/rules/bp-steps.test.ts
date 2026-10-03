import { describe, expect, it } from "vitest";
import {
  BP_ACTION_COUNTS,
  BP_PICK_SEGMENTS,
  BP_STEPS,
  BP_STEP_COUNT,
  BP_STEP_ORDER,
  bpSlotIdSchema,
  currentBpStep,
  getBpStep,
  getBpStepAt,
  type BpAction,
  type BpTeam,
} from "../../shared/bp/steps";
import { SPEC_BP_STEP_ORDER } from "./spec-bp-order";

/**
 * 按操作位标记的构成规则（阵营字母 + 动作字母 + 本方序号）独立解码，
 * 用于校验实现解析出的步骤信息；解码逻辑独立于实现。
 */
function decodeSlotId(slotId: string): {
  team: BpTeam;
  action: BpAction;
  sideOrdinal: number;
} {
  const team = slotId.slice(0, 1);
  const actionLetter = slotId.slice(1, 2);
  if (team !== "A" && team !== "B") throw new Error(`非法阵营：${slotId}`);
  if (actionLetter !== "B" && actionLetter !== "P") throw new Error(`非法动作：${slotId}`);
  return {
    team,
    action: actionLetter === "B" ? "ban" : "pick",
    sideOrdinal: Number(slotId.slice(2)),
  };
}

describe("BP 26 步权威定义", () => {
  it("顺序严格为规格确认的 26 个操作位，且无重复", () => {
    expect([...BP_STEP_ORDER]).toEqual([...SPEC_BP_STEP_ORDER]);
    expect([...bpSlotIdSchema.options]).toEqual([...SPEC_BP_STEP_ORDER]);
    expect(BP_STEP_COUNT).toBe(26);
    expect(new Set(BP_STEP_ORDER).size).toBe(26);
  });

  it("每步的阵营、动作与本方序号与操作位标记一致", () => {
    expect(BP_STEPS).toHaveLength(26);
    for (const step of BP_STEPS) {
      expect(step).toMatchObject({ ...decodeSlotId(step.slotId), slotId: step.slotId });
    }
    expect(BP_STEPS.map((step) => step.index)).toEqual(Array.from({ length: 26 }, (_, i) => i));
  });

  it("每方 4 个禁用位与 9 个选用位，本方序号从 1 连续编号", () => {
    for (const team of ["A", "B"] as const) {
      const banOrdinals = BP_STEPS.filter(
        (step) => step.team === team && step.action === "ban",
      ).map((step) => step.sideOrdinal);
      const pickOrdinals = BP_STEPS.filter(
        (step) => step.team === team && step.action === "pick",
      ).map((step) => step.sideOrdinal);
      expect(banOrdinals).toEqual([1, 2, 3, 4]);
      expect(pickOrdinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(BP_ACTION_COUNTS[team]).toEqual({ ban: 4, pick: 9 });
    }
  });

  it("每方连续选用段：A 6 段、B 5 段，行内容与房间布局规格一致", () => {
    expect(BP_PICK_SEGMENTS.A.map((segment) => segment.map((step) => step.slotId))).toEqual([
      ["AP1"],
      ["AP2", "AP3"],
      ["AP4", "AP5"],
      ["AP6"],
      ["AP7", "AP8"],
      ["AP9"],
    ]);
    expect(BP_PICK_SEGMENTS.B.map((segment) => segment.map((step) => step.slotId))).toEqual([
      ["BP1", "BP2"],
      ["BP3", "BP4"],
      ["BP5", "BP6"],
      ["BP7"],
      ["BP8", "BP9"],
    ]);
    for (const team of ["A", "B"] as const) {
      for (const segment of BP_PICK_SEGMENTS[team]) {
        for (const step of segment) {
          expect(step.action).toBe("pick");
          expect(step.team).toBe(team);
        }
      }
    }
  });

  it("当前操作位随确认数推进，全部确认后无当前位", () => {
    expect(currentBpStep(0)?.slotId).toBe("AB1");
    expect(currentBpStep(3)?.slotId).toBe("BB2");
    expect(currentBpStep(4)?.slotId).toBe("AP1");
    expect(currentBpStep(5)?.slotId).toBe("BP1");
    expect(currentBpStep(16)?.slotId).toBe("BB3");
    expect(currentBpStep(20)?.slotId).toBe("BP7");
    expect(currentBpStep(25)?.slotId).toBe("AP9");
    expect(currentBpStep(26)).toBeNull();
    // 与规格顺序逐位核对
    for (let confirmed = 0; confirmed < 26; confirmed += 1) {
      expect(currentBpStep(confirmed)?.slotId).toBe(SPEC_BP_STEP_ORDER[confirmed]);
    }
    expect(() => currentBpStep(-1)).toThrow(RangeError);
    expect(() => currentBpStep(27)).toThrow(RangeError);
    expect(() => currentBpStep(1.5)).toThrow(RangeError);
  });

  it("按操作位与下标查询步骤，非法输入快速失败", () => {
    expect(getBpStep("AB1").index).toBe(0);
    expect(getBpStep("AP9").index).toBe(25);
    expect(getBpStepAt(0).slotId).toBe("AB1");
    expect(getBpStepAt(25).slotId).toBe("AP9");
    expect(() => getBpStepAt(-1)).toThrow(RangeError);
    expect(() => getBpStepAt(26)).toThrow(RangeError);
    expect(() => getBpStep("XX9" as "AB1")).toThrow(/未知的 BP 操作位/);
  });

  it("操作位 schema 只接受 26 个标记", () => {
    expect(bpSlotIdSchema.parse("BP7")).toBe("BP7");
    for (const invalid of ["AB0", "AB10", "ab1", "AP", "", "AP9x"]) {
      expect(bpSlotIdSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
