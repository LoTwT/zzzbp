import { expect, test } from "vitest";
import {
  banRoundBreakIndex,
  banStepsOfTeam,
  pickRoundBreakIndex,
  pickSlotRows,
  pickStepsOfTeam,
} from "../../src/room/pick-layout";

// 选用区槽位结构：九格竖排的行结构必须由 BP_STEPS 推导（不另维护顺序
// 数组）；两轮分隔位置按权威本方序号推导（禁用 2 | 2、选用前 6 后 3）。

test("竖排：每方 9 行、每行 1 个，按本方选用序号排列", () => {
  for (const team of ["A", "B"] as const) {
    const rows = pickSlotRows(team);
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.length === 1)).toBe(true);
    expect(rows.map((row) => row[0]!.slotId)).toEqual(
      pickStepsOfTeam(team).map((slot) => slot.slotId),
    );
  }
});

test("禁用位与选用位按本方序号排列", () => {
  expect(banStepsOfTeam("A").map((slot) => slot.slotId)).toEqual(["AB1", "AB2", "AB3", "AB4"]);
  expect(banStepsOfTeam("B").map((slot) => slot.slotId)).toEqual(["BB1", "BB2", "BB3", "BB4"]);
  expect(pickStepsOfTeam("A").map((slot) => slot.step.sideOrdinal)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
});

test("轮次分隔：禁用区在 2、3 格之间，边界由权威禁用序号推导", () => {
  for (const team of ["A", "B"] as const) {
    const slots = banStepsOfTeam(team);
    const index = banRoundBreakIndex(slots);
    // 前 2 位为第一轮、后 2 位为第二轮：分隔线落在第 3 个槽位之前。
    expect(index).toBe(2);
    expect(slots.slice(0, index).map((slot) => slot.step.sideOrdinal)).toEqual([1, 2]);
    expect(slots.slice(index).map((slot) => slot.step.sideOrdinal)).toEqual([3, 4]);
  }
});

test("轮次分隔：选用区落在第 6、7 格之间，按本方序号而非行数平分", () => {
  for (const team of ["A", "B"] as const) {
    const rows = pickSlotRows(team);
    const index = pickRoundBreakIndex(rows);
    // 9 行里第 7 行（下标 6）开启第二轮：前 6 后 3。
    expect(index).toBe(6);
    expect(rows[index]?.[0]?.step.sideOrdinal).toBe(7);
    expect(rows[index - 1]?.[0]?.step.sideOrdinal).toBe(6);
  }
});

test("轮次分隔：投影尚未到达时不显示分隔线", () => {
  expect(banRoundBreakIndex([])).toBe(-1);
  expect(pickRoundBreakIndex([])).toBe(-1);
});
