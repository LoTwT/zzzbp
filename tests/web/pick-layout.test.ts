import { afterEach, expect, test } from "vitest";
import {
  banStepsOfTeam,
  pickSlotRows,
  pickStepsOfTeam,
  readPickLayoutPreference,
  writePickLayoutPreference,
  PICK_LAYOUT_STORAGE_KEY,
} from "../../src/room/pick-layout";

// 选用区布局：行结构必须由 BP_STEPS / BP_PICK_SEGMENTS 推导（不另维护
// 顺序数组），个人偏好的存储读写与非法值回退。

afterEach(() => {
  // 清理测试注入的存储，避免用例间串扰。
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

function installStorage(entries: Record<string, string>): void {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => entries[key] ?? null,
    setItem: (key: string, value: string) => {
      entries[key] = value;
    },
  };
}

test("竖排：每方 9 行、每行 1 个，按本方选用序号排列", () => {
  for (const team of ["A", "B"] as const) {
    const rows = pickSlotRows(team, "vertical");
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.length === 1)).toBe(true);
    expect(rows.map((row) => row[0]!.slotId)).toEqual(
      pickStepsOfTeam(team).map((slot) => slot.slotId),
    );
  }
});

test("按 Pick 分行：A 方 6 行、B 方 5 行，行内容由权威顺序推导", () => {
  expect(pickSlotRows("A", "byPick").map((row) => row.map((slot) => slot.slotId))).toEqual([
    ["AP1"],
    ["AP2", "AP3"],
    ["AP4", "AP5"],
    ["AP6"],
    ["AP7", "AP8"],
    ["AP9"],
  ]);
  expect(pickSlotRows("B", "byPick").map((row) => row.map((slot) => slot.slotId))).toEqual([
    ["BP1", "BP2"],
    ["BP3", "BP4"],
    ["BP5", "BP6"],
    ["BP7"],
    ["BP8", "BP9"],
  ]);
});

test("禁用位与选用位按本方序号排列", () => {
  expect(banStepsOfTeam("A").map((slot) => slot.slotId)).toEqual(["AB1", "AB2", "AB3", "AB4"]);
  expect(banStepsOfTeam("B").map((slot) => slot.slotId)).toEqual(["BB1", "BB2", "BB3", "BB4"]);
  expect(pickStepsOfTeam("A").map((slot) => slot.step.sideOrdinal)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
});

test("布局偏好：无存储或非法值回退竖排，合法值可读写", () => {
  expect(readPickLayoutPreference()).toBe("vertical");
  installStorage({ [PICK_LAYOUT_STORAGE_KEY]: "nonsense" });
  expect(readPickLayoutPreference()).toBe("vertical");
  installStorage({});
  writePickLayoutPreference("byPick");
  expect(readPickLayoutPreference()).toBe("byPick");
});

test("布局偏好：存储不可用时写入静默跳过，读取回退默认", () => {
  installStorage({});
  // 读取后移除存储再写入，不应抛错。
  expect(readPickLayoutPreference()).toBe("vertical");
  delete (globalThis as { localStorage?: unknown }).localStorage;
  expect(() => writePickLayoutPreference("byPick")).not.toThrow();
  expect(readPickLayoutPreference()).toBe("vertical");
});
