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
  recordTeamLabels,
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
  // 展示信息固定自快照：名称与图片解释（缺失为 null），不查目录。
  expect(recordAgentDisplay(partial.operations[0]!)).toEqual({
    id: "9001",
    name: "代理人 9001",
    image: { kind: "external", url: "https://example.com/9001.webp", thumbUrl: null, crop: null },
  });
  expect(recordAgentDisplay(partial.operations[2]!).image).toBeNull();
});

test("图片解释：方图稳定路径携带修订与缩略图；旧远程圆图映射本地副本", () => {
  const square = archiveSnapshotSchema.parse({
    ...snapshotOf(1),
    operations: [
      {
        ...snapshotOf(1).operations[0]!,
        agentAvatarUrl: "/images/agents/2026-10-09/IconRoleCrop01.webp",
        agentAvatarCrop: { x: 50, y: 36 },
      },
    ],
  });
  expect(recordAgentDisplay(square.operations[0]!).image).toEqual({
    kind: "square",
    url: "/images/agents/2026-10-09/IconRoleCrop01.webp",
    thumbUrl: "/images/agents/2026-10-09/IconRoleCrop01-128.webp",
    crop: { x: 50, y: 36 },
  });

  // 旧归档的远程圆图 URL 精确映射到同源本地副本（不替换为新方图）。
  const legacy = archiveSnapshotSchema.parse({
    ...snapshotOf(1),
    operations: [
      {
        ...snapshotOf(1).operations[0]!,
        agentAvatarUrl: "https://static.nanoka.cc/assets/zzz/IconRoleCircle01.webp",
      },
    ],
  });
  expect(recordAgentDisplay(legacy.operations[0]!).image).toEqual({
    kind: "circle",
    url: "/images/agents/legacy/IconRoleCircle01.webp",
    thumbUrl: null,
    crop: null,
  });

  // 旧归档缺少裁切字段：方图退回 null 裁切（默认居中），不依赖当前目录。
  const noCrop = archiveSnapshotSchema.parse({
    ...snapshotOf(1),
    operations: [
      {
        ...snapshotOf(1).operations[0]!,
        agentAvatarUrl: "/images/agents/2026-10-09/IconRoleCrop01.webp",
      },
    ],
  });
  const withoutCrop = noCrop.operations[0] as { agentAvatarCrop?: unknown };
  delete withoutCrop.agentAvatarCrop;
  expect(recordAgentDisplay(noCrop.operations[0]!).image).toEqual({
    kind: "square",
    url: "/images/agents/2026-10-09/IconRoleCrop01.webp",
    thumbUrl: "/images/agents/2026-10-09/IconRoleCrop01-128.webp",
    crop: null,
  });
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

test("选用区：每方九格竖排（每行 1 个）；队名标识来自快照", () => {
  // 前 6 步：AP1（A 方第 1 选用）与 BP1（B 方第 1 选用）已提交。
  const partial = snapshotOf(6);
  const columns = recordPickColumns(partial);
  expect(columns.A.rows).toHaveLength(9);
  expect(columns.A.rows.every((row) => row.length === 1)).toBe(true);
  expect(columns.B.rows).toHaveLength(9);
  expect(columns.A.rows[0]?.[0]?.slotId).toBe("AP1");
  expect(columns.A.rows[0]?.[0]?.agent?.name).toBe("代理人 9005");
  expect(columns.A.rows[1]?.[0]?.agent).toBeNull();
  expect(columns.B.rows[0]?.[0]?.agent?.name).toBe("代理人 9006");
  expect(columns.A.rows.every((row) => row.every((slot) => slot.active === false))).toBe(true);
  // 队伍标识（顶部禁用区旁）直接来自快照。
  expect(recordTeamLabels(partial)).toEqual({ A: "左方队", B: "右方队" });
});

test("到期时间格式化为本地日期；非法值兜底", () => {
  expect(formatRecordExpiry("2027-01-03T00:00:00.000Z")).toMatch(
    /^\d{4} 年 \d{1,2} 月 \d{1,2} 日$/,
  );
  expect(formatRecordExpiry("not-a-date")).toBe("未知");
});
