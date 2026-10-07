import { expect, test } from "vitest";
import {
  formatLocalDate,
  formatLocalDateTime,
  roomHistoryEntryAction,
  roomHistoryExpiresText,
  roomHistoryStatusOf,
  roomHistoryStatusText,
} from "../../src/room/history-status";
import type { RoomHistoryStatus } from "../../src/room/history-status";

// 首页「最近参与」清单的状态映射回归：四种状态的文案、操作入口与到期日，
// 以及「真正的 404」与「暂时无法确认」的区分（docs/specs/room-layout.md
// 「首页与首次入房」）。

const ARCHIVED_AT = "2027-01-03T02:00:00.000Z";

test("状态映射：未归档 / 已归档（附到期日）/ 不存在 / 暂时无法确认", () => {
  expect(roomHistoryStatusOf({ ok: true, value: { kind: "live", roomName: "赛事甲" } })).toEqual({
    kind: "live",
  });
  expect(
    roomHistoryStatusOf({
      ok: true,
      value: { kind: "archived", roomName: "赛事甲", expiresAt: ARCHIVED_AT },
    }),
  ).toEqual({ kind: "archived", expiresAt: ARCHIVED_AT });
  expect(roomHistoryStatusOf({ ok: false, reason: "not-found" })).toEqual({ kind: "missing" });
  // 网络、服务端、协议（invalid）与竞态归档（GET 正常是 200 快照）都按
  // 可重试的未知处理：不能当成 404 自动删除记录。
  for (const reason of ["network", "server", "invalid", "archived"] as const) {
    expect(roomHistoryStatusOf({ ok: false, reason })).toEqual({ kind: "unknown" });
  }
});

test("状态文案与操作入口", () => {
  const archived: RoomHistoryStatus = { kind: "archived", expiresAt: ARCHIVED_AT };
  expect(roomHistoryStatusText({ kind: "live" })).toBe("未归档");
  expect(roomHistoryStatusText(archived)).toBe("已归档");
  expect(roomHistoryStatusText({ kind: "missing" })).toBe("不存在或已过期");
  expect(roomHistoryStatusText({ kind: "unknown" })).toBe("暂时无法确认");

  expect(roomHistoryEntryAction({ kind: "live" })).toBe("enter");
  expect(roomHistoryEntryAction({ kind: "unknown" })).toBe("enter");
  expect(roomHistoryEntryAction(archived)).toBe("record");
  // 不存在或已过期：保留条目与移除操作，但没有进入入口。
  expect(roomHistoryEntryAction({ kind: "missing" })).toBe("none");
});

test("已归档记录展示服务端给出的记录到期日，其余状态不展示", () => {
  expect(roomHistoryExpiresText({ kind: "archived", expiresAt: ARCHIVED_AT })).toBe(
    `记录保留至 ${formatLocalDate(ARCHIVED_AT)}`,
  );
  expect(roomHistoryExpiresText({ kind: "live" })).toBeNull();
  expect(roomHistoryExpiresText({ kind: "missing" })).toBeNull();
  expect(roomHistoryExpiresText({ kind: "unknown" })).toBeNull();
});

test("时间文案按本机时区格式化（日期与「日期 时分」）", () => {
  const local = new Date(2026, 9, 7, 14, 32);
  expect(formatLocalDateTime(local.toISOString())).toBe("2026-10-07 14:32");
  expect(formatLocalDate(local.toISOString())).toBe("2026-10-07");
});
