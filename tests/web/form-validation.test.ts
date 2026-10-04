import { expect, test } from "vitest";
import {
  validateNickname,
  validateRoomName,
  validateTeamName,
} from "../../src/lib/form-validation";

// 表单字段校验：复用共享 schema 的 trim 与 Unicode 码点边界
// （房名 80、队名 32、昵称 24），输出中文文案。

test("房间名：空白输入按 trim 判空", () => {
  expect(validateRoomName("   ")).toBe("房间名不能为空");
  expect(validateRoomName("　")).toBe("房间名不能为空");
  expect(validateRoomName("  XX 杯  ")).toBeNull();
});

test("房间名：80 码点边界（含增补平面字符按码点计数）", () => {
  const exactly80 = "🐙".repeat(80);
  const over80 = "🐙".repeat(81);
  expect(validateRoomName(exactly80)).toBeNull();
  expect(validateRoomName(over80)).toBe("房间名不能超过 80 个字符");
});

test("昵称：24 码点边界与空值文案", () => {
  expect(validateNickname("")).toBe("昵称不能为空");
  expect(validateNickname("小鱼")).toBeNull();
  expect(validateNickname("a".repeat(24))).toBeNull();
  expect(validateNickname("a".repeat(25))).toBe("昵称不能超过 24 个字符");
});

test("队伍名：不允许为空，32 码点边界", () => {
  expect(validateTeamName(" ")).toBe("队伍名不能为空");
  expect(validateTeamName("A 队")).toBeNull();
  expect(validateTeamName("队".repeat(32))).toBeNull();
  expect(validateTeamName("队".repeat(33))).toBe("队伍名不能超过 32 个字符");
});
