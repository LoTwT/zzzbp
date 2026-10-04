import { afterEach, expect, test } from "vitest";
import {
  DISPLAY_LAYOUT_QUERY_KEY,
  displayLayoutFromQuery,
  displayPagePath,
} from "../../src/room/display-url";
import { PICK_LAYOUT_STORAGE_KEY, writePickLayoutPreference } from "../../src/room/pick-layout";

// 展示页 URL 合同：打开展示页时把当前布局冻结进查询参数；展示页只在
// 挂载时校验读取一次，缺失或非法回退本地偏好。展示页不写回存储。

afterEach(() => {
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

test("展示页路径显式携带当前布局（冻结继承的载体）", () => {
  expect(displayPagePath("r1", "vertical")).toBe(
    `/rooms/r1/display?${DISPLAY_LAYOUT_QUERY_KEY}=vertical`,
  );
  expect(displayPagePath("r2", "byPick")).toBe(
    `/rooms/r2/display?${DISPLAY_LAYOUT_QUERY_KEY}=byPick`,
  );
  // roomId 参与路径编码，不注入路径结构。
  expect(displayPagePath("a b", "vertical")).toBe(
    `/rooms/a%20b/display?${DISPLAY_LAYOUT_QUERY_KEY}=vertical`,
  );
});

test("合法查询值直接采用，不读取本地偏好", () => {
  installStorage({ [PICK_LAYOUT_STORAGE_KEY]: "byPick" });
  expect(displayLayoutFromQuery("vertical")).toBe("vertical");
  expect(displayLayoutFromQuery("byPick")).toBe("byPick");
});

test("缺失、非法与数组形态回退本地偏好", () => {
  installStorage({ [PICK_LAYOUT_STORAGE_KEY]: "byPick" });
  expect(displayLayoutFromQuery(null)).toBe("byPick");
  expect(displayLayoutFromQuery("nonsense")).toBe("byPick");
  expect(displayLayoutFromQuery("")).toBe("byPick");
  expect(displayLayoutFromQuery(["vertical", "byPick"])).toBe("byPick");
});

test("偏好也缺失/非法时最终回退默认竖排", () => {
  installStorage({ [PICK_LAYOUT_STORAGE_KEY]: "nonsense" });
  expect(displayLayoutFromQuery(null)).toBe("vertical");
  delete (globalThis as { localStorage?: unknown }).localStorage;
  expect(displayLayoutFromQuery(null)).toBe("vertical");
});

test("读取路径不写回存储：本地偏好保持原值", () => {
  installStorage({ [PICK_LAYOUT_STORAGE_KEY]: "byPick" });
  expect(displayLayoutFromQuery("vertical")).toBe("vertical");
  const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
  expect(storage?.getItem(PICK_LAYOUT_STORAGE_KEY)).toBe("byPick");
  // 对照：偏好写入仍正常（仅操作页使用）。
  writePickLayoutPreference("byPick");
  expect(storage?.getItem(PICK_LAYOUT_STORAGE_KEY)).toBe("byPick");
});

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
