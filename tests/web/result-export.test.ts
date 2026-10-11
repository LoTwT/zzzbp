import { expect, test } from "vitest";
import type { ArchiveSnapshot } from "../../shared/contracts/records";
import { archiveSnapshotSchema } from "../../shared/contracts/records";
import { BP_STEP_COUNT, BP_STEP_ORDER, type BpSlotId } from "../../shared/bp/steps";
import type { BpPublicView } from "../../shared/contracts/views";
import type { AgentImageDisplay } from "../../src/room/agent-image";
import type { RoomAgentDisplay, RoomCatalogModel } from "../../src/room/room-catalog";
import {
  EXPORT_UNSUBMITTED_TEXT,
  buildArchiveExportResult,
  buildLiveExportResult,
  exportBanRounds,
  exportCompletionText,
  exportPickRounds,
  exportResultFingerprint,
  formatResultText,
  isExportResultConsistent,
} from "../../src/room/result-export";

// BP 结果导出的纯投影与文本回归：
// - 两个来源（实时视图 + 房间目录 / 归档快照）适配到同一份结果模型，
//   槽位顺序与两轮分组由权威顺序（BP_STEPS）推导；
// - 已完成实时与完整归档产出一致文本；部分归档空槽为「未提交」且明确
//   标记未完成，不伪造完整结果；
// - 归档展示信息固定自快照，不经当前目录重解释；
// - 快照深拷贝公开数据，源对象后续修改不混入导出内容；
// - 内容指纹只随导出输出字段变化（无关 revision 变化不产生差异），
//   作为图片导出下载前的一致性判定依据；
// - 文本不含成员信息、预选、操作位缩写或房间链接。

const ROOM_NAME = "导出投影赛";
const TEAM_NAMES = { A: "甲队", B: "乙队" } as const;
const ARCHIVED_AT = "2026-10-05T00:00:00.000Z";
const EXPIRES_AT = "2027-01-03T00:00:00.000Z";

/** 26 步计划：目录条目 id 与名称一一对应（前 26 个），另有第 27 个做预选。 */
const PLAN = Array.from({ length: 27 }, (_, index) => ({
  id: `10${String(index + 1).padStart(2, "0")}`,
  name: `代理${String(index + 1).padStart(2, "0")}`,
}));

/** 每次调用生成全新的方图展示信息（crop 为独立对象，便于变异源数据）。 */
function squareImageOf(index: number): AgentImageDisplay {
  return {
    kind: "square",
    url: `/images/agents/2026-10-09/IconRoleCrop${index}.webp`,
    thumbUrl: `/images/agents/2026-10-09/IconRoleCrop${index}-128.webp`,
    crop: { x: 50, y: 41 },
  };
}

/** 构造房间目录展示模型：计划内条目 + 预选专用条目；图片形态按需注入。 */
function catalogOf(): RoomCatalogModel {
  const classification = { id: "203", name: "属性", iconUrl: null };
  const entryOf = (
    id: string,
    name: string,
    image: AgentImageDisplay | null,
  ): RoomAgentDisplay => ({
    id,
    name,
    fullName: `${name}全名`,
    avatarPath: null,
    image,
    elementId: "203",
    specialtyId: "2",
    element: classification,
    specialty: classification,
  });
  const imageOf = (index: number): AgentImageDisplay | null => {
    // 第 3 个条目无图片（占位兜底代表），第 6 个为旧圆图本地副本。
    if (index === 2) return null;
    if (index === 5) {
      return {
        kind: "circle",
        url: "/images/agents/legacy/IconRoleCircle01.webp",
        thumbUrl: null,
        crop: null,
      };
    }
    return squareImageOf(index);
  };
  const entries = PLAN.map((plan, index) => entryOf(plan.id, plan.name, imageOf(index)));
  return {
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    elements: [],
    specialties: [],
  };
}

/** 构造公开 BP 视图：前 count 步已提交，另设一个未提交预选。 */
function viewOf(count: number, bpStatus: BpPublicView["bpStatus"] = "running"): BpPublicView {
  return {
    roomName: ROOM_NAME,
    teamNames: { ...TEAM_NAMES },
    seatOccupancy: { A: true, B: true },
    bpStatus,
    currentSlotId: count === BP_STEP_COUNT ? null : (BP_STEP_ORDER[count] ?? null),
    submissions: BP_STEP_ORDER.slice(0, count).map((slotId, index) => ({
      slotId,
      agentId: PLAN[index]?.id ?? "",
    })),
    // 预选指向未提交的第 27 个条目：导出文本不得包含预选内容。
    preselect: PLAN[26]?.id ?? null,
    versions: { ruleVersion: "rules-test", agentDataVersion: "agents-test" },
    revision: count,
  };
}

/** 构造归档快照（前 count 步，展示信息可自定义）；经 schema 校验保证合法。 */
function snapshotOf(
  count: number,
  agentNameOf: (index: number) => string = (index) => PLAN[index]?.name ?? "",
  avatarUrlOf: (index: number) => string | null = () =>
    "/images/agents/2026-10-09/IconRoleCrop01.webp",
): ArchiveSnapshot {
  return archiveSnapshotSchema.parse({
    roomId: "room-export-1",
    roomName: ROOM_NAME,
    teamNames: { ...TEAM_NAMES },
    bpCompleted: count === BP_STEP_COUNT,
    operations: BP_STEP_ORDER.slice(0, count).map((slotId, index) => ({
      slotId,
      team: slotId[0] === "A" ? ("A" as const) : ("B" as const),
      action: slotId[1] === "B" ? ("ban" as const) : ("pick" as const),
      agentId: PLAN[index]?.id ?? "",
      agentName: agentNameOf(index),
      agentAvatarUrl: avatarUrlOf(index),
      agentAvatarCrop: { x: 50, y: 36 },
    })),
    versions: { ruleVersion: "rules-test", agentDataVersion: "agents-test" },
    archivedAt: ARCHIVED_AT,
    expiresAt: EXPIRES_AT,
  });
}

/** 某方某动作在权威顺序中的操作位列表（期望值由 BP_STEP_ORDER 独立推导）。 */
function sideSlots(team: "A" | "B", action: "ban" | "pick"): BpSlotId[] {
  return BP_STEP_ORDER.filter(
    (slotId) => slotId[0] === team && slotId[1] === (action === "ban" ? "B" : "P"),
  );
}

test("实时完整结果：每方 4 禁用 + 9 选用按本方权威顺序，两轮分组 2|2 与 6|3", () => {
  const snapshot = buildLiveExportResult(viewOf(BP_STEP_COUNT, "completed"), catalogOf());
  expect(snapshot.completed).toBe(true);
  expect(snapshot.submittedCount).toBe(BP_STEP_COUNT);
  expect(snapshot.roomName).toBe(ROOM_NAME);

  for (const team of ["A", "B"] as const) {
    const bans = sideSlots(team, "ban");
    const picks = sideSlots(team, "pick");
    expect(bans).toHaveLength(4);
    expect(picks).toHaveLength(9);
    // 锚定权威顺序（首个禁用位与末个选用位），其余按 sideOrdinal 推导。
    expect(bans[0]).toBe(team === "A" ? "AB1" : "BB1");
    expect(picks[8]).toBe(team === "A" ? "AP9" : "BP9");
    const result = snapshot.teams[team];
    expect(result.teamName).toBe(TEAM_NAMES[team]);
    // 名称按提交到对应操作位的代理人（目录名称）排列。
    expect(result.bans.map((entry) => entry?.name)).toEqual(
      bans.map((slotId) => PLAN[BP_STEP_ORDER.indexOf(slotId)]?.name),
    );
    expect(result.picks.map((entry) => entry?.name)).toEqual(
      picks.map((slotId) => PLAN[BP_STEP_ORDER.indexOf(slotId)]?.name),
    );
    expect(result.bans.every((entry) => entry !== null)).toBe(true);
    expect(result.picks.every((entry) => entry !== null)).toBe(true);
    // 两轮分组：禁用前 2 / 后 2，选用前 6 / 后 3。
    expect(exportBanRounds(result).map((round) => round.length)).toEqual([2, 2]);
    expect(exportPickRounds(result).map((round) => round.length)).toEqual([6, 3]);
    expect(exportBanRounds(result)[0]?.map((entry) => entry?.name)).toEqual(
      bans.slice(0, 2).map((slotId) => PLAN[BP_STEP_ORDER.indexOf(slotId)]?.name),
    );
    expect(exportPickRounds(result)[1]?.map((entry) => entry?.name)).toEqual(
      picks.slice(6).map((slotId) => PLAN[BP_STEP_ORDER.indexOf(slotId)]?.name),
    );
  }

  // 完成情况与提交数自洽。
  expect(exportCompletionText(snapshot)).toBe("已完成");
  expect(isExportResultConsistent(snapshot)).toBe(true);
});

test("实时文本：房间名/完成情况/队名/名称与轮次齐全；无预选、操作码、链接或成员信息", () => {
  const text = formatResultText(
    buildLiveExportResult(viewOf(BP_STEP_COUNT, "completed"), catalogOf()),
  );
  const line = (team: "A" | "B", action: "ban" | "pick", round: 1 | 2) => {
    const slots = sideSlots(team, action);
    const names = slots.map((slotId) => PLAN[BP_STEP_ORDER.indexOf(slotId)]?.name);
    const split = action === "ban" ? 2 : 6;
    const part = round === 1 ? names.slice(0, split) : names.slice(split);
    const label = action === "ban" ? "禁用" : "选用";
    return `${label} 第 ${round} 轮：${part.join("、")}`;
  };
  expect(text).toBe(
    [
      `${ROOM_NAME} BP 结果 · 已完成`,
      "",
      `左方 · ${TEAM_NAMES.A}`,
      line("A", "ban", 1),
      line("A", "ban", 2),
      line("A", "pick", 1),
      line("A", "pick", 2),
      "",
      `右方 · ${TEAM_NAMES.B}`,
      line("B", "ban", 1),
      line("B", "ban", 2),
      line("B", "pick", 1),
      line("B", "pick", 2),
    ].join("\n"),
  );
  // 预选（未提交的第 27 名）不进入结果；操作位缩写与链接同样不出现。
  expect(text.includes(PLAN[26]?.name ?? "代理27")).toBe(false);
  expect(text).not.toMatch(/[AB][BP]\d/);
  expect(text.includes("/rooms/")).toBe(false);
  expect(text.includes("http")).toBe(false);
});

test("已完成实时与完整归档文本一致；归档展示信息固定自快照", () => {
  const liveText = formatResultText(
    buildLiveExportResult(viewOf(BP_STEP_COUNT, "completed"), catalogOf()),
  );
  const archiveText = formatResultText(buildArchiveExportResult(snapshotOf(BP_STEP_COUNT)));
  expect(archiveText).toBe(liveText);

  // 归档名称与头像固定自快照：改名/旧地址不被当前目录解释替换。
  const renamed = snapshotOf(
    1,
    (index) => `旧名称${index}`,
    () => "https://static.nanoka.cc/assets/zzz/IconRoleCircle01.webp",
  );
  const renamedSnapshot = buildArchiveExportResult(renamed);
  const entry = renamedSnapshot.teams.A.bans[0];
  expect(entry?.name).toBe("旧名称0");
  expect(entry?.image?.url).toBe("/images/agents/legacy/IconRoleCircle01.webp");
  expect(entry?.image?.kind).toBe("circle");
  // null 头像保留为 null（占位兜底），不虚构图片。
  const noImage = buildArchiveExportResult(snapshotOf(1, undefined, () => null));
  expect(noImage.teams.A.bans[0]?.image).toBeNull();
});

test("部分归档：未完成标记、空槽为未提交、不伪造完整结果", () => {
  // 前 7 步：AB1、BB1、AB2、BB2（禁用）与 AP1、BP1、BP2（选用）。
  const snapshot = buildArchiveExportResult(snapshotOf(7));
  expect(snapshot.completed).toBe(false);
  expect(snapshot.submittedCount).toBe(7);
  expect(exportCompletionText(snapshot)).toBe("未完成 · 已提交 7 步");
  expect(isExportResultConsistent(snapshot)).toBe(true);

  // 空槽为 null；文本以「未提交」占位。
  expect(snapshot.teams.A.bans.map((entry) => entry === null)).toEqual([false, false, true, true]);
  expect(snapshot.teams.A.picks.map((entry) => entry === null)).toEqual([
    false,
    ...Array.from({ length: 8 }, () => true),
  ]);
  expect(snapshot.teams.B.picks.map((entry) => entry === null)).toEqual([
    false,
    false,
    ...Array.from({ length: 7 }, () => true),
  ]);
  const text = formatResultText(snapshot);
  expect(text).toContain(`禁用 第 2 轮：${EXPORT_UNSUBMITTED_TEXT}、${EXPORT_UNSUBMITTED_TEXT}`);
  expect(text).toContain(
    `选用 第 1 轮：${PLAN[4]?.name}、${Array.from({ length: 5 }, () => EXPORT_UNSUBMITTED_TEXT).join("、")}`,
  );
  // 未提交计数：26 - 7 = 19。
  expect(text.split(EXPORT_UNSUBMITTED_TEXT).length - 1).toBe(19);
  // 未完成导出不声称已完成。
  expect(text).toContain("未完成 · 已提交 7 步");
  expect(text).not.toContain("已完成");
});

test("快照深拷贝：源视图/目录后续修改不改变已构建的导出内容", () => {
  const view = viewOf(BP_STEP_COUNT, "completed");
  const catalog = catalogOf();
  const snapshot = buildLiveExportResult(view, catalog);
  const textBefore = formatResultText(snapshot);

  // 修改源对象：队名、追加提交、改目录名称与图片字段（含共享裁切对象）。
  // readonly 是接口约束，测试以可写视图刻意变异源数据，验证快照独立性。
  view.teamNames.A = "新队名";
  view.submissions.push({ slotId: "AB1", agentId: "1099" });
  const catalogEntry = catalog.byId.get(PLAN[0]?.id ?? "") as RoomAgentDisplay & {
    name: string;
    image: (AgentImageDisplay & { url: string; thumbUrl: string; crop: { x: number } }) | null;
  };
  catalogEntry.name = "被改的目录名";
  const sourceImage = catalogEntry.image;
  if (sourceImage !== null) {
    sourceImage.url = "/changed.webp";
    sourceImage.thumbUrl = "/changed-128.webp";
    if (sourceImage.crop !== null) sourceImage.crop.x = 99;
  }

  expect(formatResultText(snapshot)).toBe(textBefore);
  expect(snapshot.teams.A.teamName).toBe(TEAM_NAMES.A);
  expect(snapshot.teams.A.bans[0]?.name).toBe(PLAN[0]?.name);
  // 快照内图片是独立拷贝：源 url/缩略图/裁切修改不影响快照值。
  expect(snapshot.teams.A.bans[0]?.image?.url).toBe("/images/agents/2026-10-09/IconRoleCrop0.webp");
  expect(snapshot.teams.A.bans[0]?.image?.thumbUrl).toBe(
    "/images/agents/2026-10-09/IconRoleCrop0-128.webp",
  );
  expect(snapshot.teams.A.bans[0]?.image?.crop).toEqual({ x: 50, y: 41 });
  // 目录中该条目无图片（第 3 个计划条目）时快照保留 null，名称仍可读。
  expect(snapshot.teams.A.bans[1]?.image).toBeNull();
  expect(snapshot.teams.A.bans[1]?.name).toBe(PLAN[2]?.name);
});

test("内容指纹：只随导出输出字段变化，无关 revision 变化不产生差异", () => {
  const catalog = catalogOf();
  // 观众加入/上下线等只递增 revision：导出内容（房名/队名/完成情况/提交
  // 结果）完全相同时指纹一致——图片导出不因此误取消。
  const at64 = buildLiveExportResult(viewOf(BP_STEP_COUNT, "completed"), catalog);
  const at65 = buildLiveExportResult(
    { ...viewOf(BP_STEP_COUNT, "completed"), revision: 65 },
    catalog,
  );
  expect(exportResultFingerprint(at65)).toBe(exportResultFingerprint(at64));

  // 队名变化、有效提交变化（撤回：少最后一步）、完成情况变化都会改变指纹。
  const renamed = buildLiveExportResult(
    { ...viewOf(BP_STEP_COUNT, "completed"), teamNames: { ...TEAM_NAMES, A: "改名队" } },
    catalog,
  );
  expect(exportResultFingerprint(renamed)).not.toBe(exportResultFingerprint(at64));

  const undone = buildLiveExportResult(viewOf(BP_STEP_COUNT - 1, "completed"), catalog);
  expect(exportResultFingerprint(undone)).not.toBe(exportResultFingerprint(at64));

  const paused = buildLiveExportResult(viewOf(BP_STEP_COUNT, "paused"), catalog);
  expect(exportResultFingerprint(paused)).not.toBe(exportResultFingerprint(at64));

  // 图片引用（裁切校准）属于导出输出依赖：变化也改变指纹。
  const reCropped = buildLiveExportResult(viewOf(BP_STEP_COUNT, "completed"), {
    ...catalog,
    byId: new Map(
      [...catalog.byId.entries()].map(([id, entry]) => [
        id,
        entry.image?.kind === "square" && entry.image.crop !== null
          ? { ...entry, image: { ...entry.image, crop: { ...entry.image.crop, y: 90 } } }
          : entry,
      ]),
    ),
  });
  expect(exportResultFingerprint(reCropped)).not.toBe(exportResultFingerprint(at64));

  // 归档来源同样按内容判定：同一快照两次构建指纹一致，内容不同则不同。
  const record = snapshotOf(BP_STEP_COUNT);
  expect(exportResultFingerprint(buildArchiveExportResult(record))).toBe(
    exportResultFingerprint(buildArchiveExportResult(record)),
  );
  expect(exportResultFingerprint(buildArchiveExportResult(snapshotOf(10)))).not.toBe(
    exportResultFingerprint(buildArchiveExportResult(record)),
  );
});
