import { expect, test } from "vitest";
import { displayPagePath } from "../../src/room/display-url";

// 展示页 URL 合同：只构建房间的展示页路径（固定九格竖排，没有可继承的
// 布局参数）；roomId 参与路径编码，不注入路径结构。

test("展示页路径由房间 ID 构成并编码", () => {
  expect(displayPagePath("r1")).toBe("/rooms/r1/display");
  expect(displayPagePath("a b")).toBe("/rooms/a%20b/display");
  expect(displayPagePath("a/b?c")).toBe("/rooms/a%2Fb%3Fc/display");
});
