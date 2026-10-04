import { expect, test } from "vitest";
import type { ArchiveSnapshot } from "../../shared/contracts/records";
import { archiveSnapshotSchema } from "../../shared/contracts/records";
import { BP_STEP_ORDER } from "../../shared/bp/steps";
import {
  formatRecordExpiry,
  recordActionText,
  recordAgentDisplay,
  recordBanSlots,
  recordPickColumns,
  recordStatusText,
} from "../../src/room/record-view";

// 只读记录页的快照投影：禁用/选用槽位、行结构与文案全部由快照与权威
// 顺序推导；展示信息（名称/头像）固定自快照，不读当前目录。
// 快照操作必须构成权威顺序的前缀（archiveSnapshotSchema 校验），测试
// 夹具按 BP_STEP_ORDER 前 N 步构造。

const archivedAt = "2026-10-05T00:00:00.000Z";

/** 构造权威顺序前 count 步的快照操作。 */
function prefixOperations(count: number): ArchiveSnapshot["operations"] {
  return BP_STEP_ORDER.slice(0, count).map((slotId, index) => {
    const agentId = `90${String(index + 1).padStart(2, "0")}`;
    return {
      slotId,
      team: slotId.startsWith("A") ? ("A" as const) : ("B" as const),
      action: slotId[1] === "B" ? ("ban" as const) : ("pick" as const),
      agentId,
      agentName: `代理人 ${agentId}`,
      agentAvatarUrl: agentId.endsWith("3") ? null : `https://example.com/${agentId}.webp`,
    };
  });
}

/** 由前缀长度构造合法快照（bpCompleted 随长度推导）。 */
function snapshotOf(count: number): ArchiveSnapshot {
  return archiveSnapshotSchema.parse({
    roomId: "room-record-1",
    roomName: "记录投影赛",
    teamNames: { A: "左方队", B: "右方队" },
    bpCompleted: count === BP_STEP_ORDER.length,
    operations: prefixOperations(count),
    versions: { ruleVersion: "rules-test", agentDataVersion: "agents-test" },
    archivedAt,
    expiresAt: "2027-01-03T00:00:00.000Z",
  });
}

test("状态与操作文案：只读记录 + 完成情况；左右方动作不含操作位缩写", () => {
  // 前 6 步：AB1、BB1、AB2、BB2（禁用）与 AP1、BP1（选用）。
  const partial = snapshotOf(6);
  expect(recordStatusText(partial)).toBe("只读记录 · 未完成");
  expect(recordActionText(partial.operations[0]!)).toBe("左方禁用");
  expect(recordActionText(partial.operations[1]!)).toBe("右方禁用");
  expect(recordActionText(partial.operations[4]!)).toBe("左方选用");
  expect(recordActionText(partial.operations[5]!)).toBe("右方选用");
  // 展示信息固定自快照：名称与头像 URL（缺失为 null），不查目录。
  expect(recordAgentDisplay(partial.operations[0]!)).toEqual({
    id: "9001",
    name: "代理人 9001",
    avatarUrl: "https://example.com/9001.webp",
  });
  expect(recordAgentDisplay(partial.operations[2]!).avatarUrl).toBeNull();
});

test("禁用槽位：每方 4 个、未提交保持空槽、无 active", () => {
  // 前 2 步：AB1 与 BB1 已提交；同方其余禁用位与对方后位保持空槽。
  const partial = snapshotOf(2);
  const banSlots = recordBanSlots(partial);
  expect(banSlots.A.map((slot) => slot.slotId)).toEqual(["AB1", "AB2", "AB3", "AB4"]);
  expect(banSlots.A[0]?.agent?.name).toBe("代理人 9001");
  expect(banSlots.A[1]?.agent).toBeNull();
  expect(banSlots.B[0]?.agent?.name).toBe("代理人 9002");
  expect(banSlots.B[1]?.agent).toBeNull();
  expect(banSlots.A.every((slot) => slot.active === false)).toBe(true);
  expect(banSlots.B.every((slot) => slot.active === false)).toBe(true);
});

test("选用区：默认竖排每方 9 行，byPick 按连续选用段分行；队名来自快照", () => {
  // 前 6 步：AP1（A 方第 1 选用）与 BP1（B 方第 1 选用）已提交。
  const partial = snapshotOf(6);
  const vertical = recordPickColumns(partial, "vertical");
  expect(vertical.A.rows).toHaveLength(9);
  expect(vertical.A.rows.every((row) => row.length === 1)).toBe(true);
  expect(vertical.A.teamName).toBe("左方队");
  expect(vertical.B.teamName).toBe("右方队");
  expect(vertical.A.rows[0]?.[0]?.agent?.name).toBe("代理人 9005");
  expect(vertical.A.rows[1]?.[0]?.agent).toBeNull();
  expect(vertical.B.rows[0]?.[0]?.agent?.name).toBe("代理人 9006");

  // byPick：A 方 6 行、B 方 5 行（行结构与实时房间同一权威推导）。
  const byPick = recordPickColumns(partial, "byPick");
  expect(byPick.A.rows).toHaveLength(6);
  expect(byPick.B.rows).toHaveLength(5);
  expect(byPick.A.rows.every((row) => row.every((slot) => slot.active === false))).toBe(true);
});

test("到期时间格式化为本地日期；非法值兜底", () => {
  expect(formatRecordExpiry("2027-01-03T00:00:00.000Z")).toMatch(
    /^\d{4} 年 \d{1,2} 月 \d{1,2} 日$/,
  );
  expect(formatRecordExpiry("not-a-date")).toBe("未知");
});
