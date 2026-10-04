import { expect, test } from "vitest";
import { pendingOperationText } from "../../src/room/operation-feedback";

// 与操作入口可见性解耦的挂起操作反馈：入口（确认按钮、比赛控制按钮、
// 席位行按钮）因操作位轮换/完成/被换下/状态切换而消失时，已发出命令
// 的提交中/核对中状态仍要有可见文案。

test("无挂起命令时无反馈文案", () => {
  expect(pendingOperationText(false, false)).toBeNull();
  expect(pendingOperationText(false, true)).toBeNull();
});

test("首发在途显示「上一操作提交中…」", () => {
  expect(pendingOperationText(true, false)).toBe("上一操作提交中…");
});

test("结果未知核对中显示「正在核对上一操作结果…」", () => {
  expect(pendingOperationText(true, true)).toBe("正在核对上一操作结果…");
});
