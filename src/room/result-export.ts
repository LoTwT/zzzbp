import { BP_STEP_COUNT, type BpSlotId, type BpTeam } from "../../shared/bp/steps";
import type { ArchiveSnapshot } from "../../shared/contracts/records";
import type { BpPublicView } from "../../shared/contracts/views";
import type { AgentImageDisplay } from "./agent-image";
import {
  SECOND_BAN_ROUND_START_ORDINAL,
  SECOND_PICK_ROUND_START_ORDINAL,
  banStepsOfTeam,
  pickStepsOfTeam,
} from "./pick-layout";
import { recordAgentDisplay } from "./record-view";
import type { RoomCatalogModel } from "./room-catalog";
import { agentDisplayOf } from "./view-projections";
import { sideLabel } from "./host-panels";

/**
 * BP 结果导出的公开快照与文本格式（docs/specs/room-layout.md「BP 结果导出」）。
 *
 * 两个来源适配到同一份结果模型：实时房间用当前视图 + 房间固定目录，
 * 只读记录页用归档快照（名称/头像固定自归档，不查当前目录重解释）。
 * 构建时逐字段深拷贝公开数据（房间名、队名、代理人名称与图片引用），
 * 之后源对象的变化不影响已构建的快照；快照不含成员昵称/ID、凭据、
 * 预选、撤回/重开历史或房间链接。槽位顺序一律由 pick-layout 从权威
 * 顺序（BP_STEPS）推导，两轮边界（禁用 2|2、选用 6|3）复用同一组常量。
 */

/** 导出中的一名代理人：公开名称 + 图片展示解释的独立拷贝。 */
export interface ExportAgentEntry {
  readonly name: string;
  readonly image: AgentImageDisplay | null;
}

/** 一方的导出结果：4 个禁用槽与 9 个选用槽按本方权威顺序排列；null = 未提交。 */
export interface ExportTeamResult {
  readonly teamName: string;
  readonly bans: readonly (ExportAgentEntry | null)[];
  readonly picks: readonly (ExportAgentEntry | null)[];
}

/**
 * 一次导出的公开结果快照：点击导出时构建，内容固定不变。
 *
 * submittedCount 是当前有效提交数（未完成时 < 26），完成时恒为 26；
 * 与 completed 一起表达完成情况，未完成导出不伪造完整结果。
 */
export interface ExportResultSnapshot {
  readonly roomName: string;
  readonly completed: boolean;
  readonly submittedCount: number;
  readonly teams: Readonly<Record<BpTeam, ExportTeamResult>>;
}

/** 图片展示解释的独立拷贝（url/thumbUrl/crop 均为新建值）。 */
function copyAgentImage(image: AgentImageDisplay | null): AgentImageDisplay | null {
  if (image === null) return null;
  return {
    kind: image.kind,
    url: image.url,
    thumbUrl: image.thumbUrl,
    crop: image.crop === null ? null : { x: image.crop.x, y: image.crop.y },
  };
}

/** 目录条目到导出条目的拷贝；目录缺该条目时保留「未知代理人」名称兜底。 */
function exportEntryOfDisplay(
  display: { readonly name: string; readonly image: AgentImageDisplay | null } | null,
): ExportAgentEntry {
  return { name: display?.name ?? "未知代理人", image: copyAgentImage(display?.image ?? null) };
}

/** 未提交槽位的统一占位（文本与图片共用，未完成导出不虚构名称）。 */
export const EXPORT_UNSUBMITTED_TEXT = "未提交";

/**
 * 由实时房间的公开视图与房间固定目录构建导出快照。
 *
 * 名称与头像只能来自房间固定目录（room_catalog 快照），不用当前构建
 * 目录重解释；调用方负责可用性判定（已完成、连接同步、目录就绪）。
 */
export function buildLiveExportResult(
  view: BpPublicView,
  catalog: RoomCatalogModel | null,
): ExportResultSnapshot {
  const submissions = new Map<BpSlotId, string>(
    view.submissions.map((submission) => [submission.slotId, submission.agentId]),
  );
  const teams = {} as Record<BpTeam, ExportTeamResult>;
  for (const team of ["A", "B"] as const) {
    teams[team] = {
      teamName: view.teamNames[team],
      bans: banStepsOfTeam(team).map(({ slotId }) =>
        submissions.has(slotId)
          ? exportEntryOfDisplay(agentDisplayOf(catalog, submissions.get(slotId)))
          : null,
      ),
      picks: pickStepsOfTeam(team).map(({ slotId }) =>
        submissions.has(slotId)
          ? exportEntryOfDisplay(agentDisplayOf(catalog, submissions.get(slotId)))
          : null,
      ),
    };
  }
  return {
    roomName: view.roomName,
    completed: view.bpStatus === "completed",
    submittedCount: view.submissions.length,
    teams,
  };
}

/**
 * 由归档快照构建导出快照：直接导出保存的最后有效序列。
 *
 * 名称与头像固定自归档（agentName/agentAvatarUrl/agentAvatarCrop），
 * 不请求当前 catalog；未完成归档保留已提交部分，空槽为 null。
 */
export function buildArchiveExportResult(record: ArchiveSnapshot): ExportResultSnapshot {
  const operations = new Map(record.operations.map((operation) => [operation.slotId, operation]));
  const teams = {} as Record<BpTeam, ExportTeamResult>;
  for (const team of ["A", "B"] as const) {
    teams[team] = {
      teamName: record.teamNames[team],
      bans: banStepsOfTeam(team).map(({ slotId }) => {
        const operation = operations.get(slotId);
        return operation === undefined ? null : exportEntryOfDisplay(recordAgentDisplay(operation));
      }),
      picks: pickStepsOfTeam(team).map(({ slotId }) => {
        const operation = operations.get(slotId);
        return operation === undefined ? null : exportEntryOfDisplay(recordAgentDisplay(operation));
      }),
    };
  }
  return {
    roomName: record.roomName,
    completed: record.bpCompleted,
    submittedCount: record.operations.length,
    teams,
  };
}

/** 导出的完成情况文案：已完成 / 未完成 · 已提交 N 步。 */
export function exportCompletionText(snapshot: ExportResultSnapshot): string {
  return snapshot.completed ? "已完成" : `未完成 · 已提交 ${snapshot.submittedCount} 步`;
}

/** 某方禁用槽的两轮分组（前 2 / 后 2）；边界复用权威顺序常量。 */
export function exportBanRounds(
  team: ExportTeamResult,
): readonly [readonly (ExportAgentEntry | null)[], readonly (ExportAgentEntry | null)[]] {
  return [
    team.bans.filter((_, index) => index < SECOND_BAN_ROUND_START_ORDINAL - 1),
    team.bans.filter((_, index) => index >= SECOND_BAN_ROUND_START_ORDINAL - 1),
  ];
}

/** 某方选用槽的两轮分组（前 6 / 后 3）；边界复用权威顺序常量。 */
export function exportPickRounds(
  team: ExportTeamResult,
): readonly [readonly (ExportAgentEntry | null)[], readonly (ExportAgentEntry | null)[]] {
  return [
    team.picks.filter((_, index) => index < SECOND_PICK_ROUND_START_ORDINAL - 1),
    team.picks.filter((_, index) => index >= SECOND_PICK_ROUND_START_ORDINAL - 1),
  ];
}

/** 槽位条目的名称（未提交用统一占位文案）。 */
function slotName(entry: ExportAgentEntry | null): string {
  return entry?.name ?? EXPORT_UNSUBMITTED_TEXT;
}

/**
 * 导出结果的稳定内容指纹：序列化快照中真正决定导出输出（文本与 PNG）
 * 的全部字段——房间名、完成情况、双方队名、每个槽位的名称与图片引用
 * （kind/url/缩略图/裁切）。
 *
 * 用于图片导出前的来源一致性判定：观众加入、成员上下线等只递增房间
 * revision 但不改变导出内容的变化不会产生指纹差异；队名或有效提交
 * 结果变化（撤回/重开/新提交）一定产生差异。不比较整个视图对象、
 * 整个 revision 或对象引用。键序由本函数的固定字面量结构决定，
 * JSON 序列化稳定。
 */
export function exportResultFingerprint(snapshot: ExportResultSnapshot): string {
  const entry = (item: ExportAgentEntry | null): unknown =>
    item === null
      ? null
      : {
          name: item.name,
          image:
            item.image === null
              ? null
              : [
                  item.image.kind,
                  item.image.url,
                  item.image.thumbUrl,
                  item.image.crop === null ? null : [item.image.crop.x, item.image.crop.y],
                ],
        };
  const team = (result: ExportTeamResult): unknown => ({
    teamName: result.teamName,
    bans: result.bans.map(entry),
    picks: result.picks.map(entry),
  });
  return JSON.stringify({
    roomName: snapshot.roomName,
    completed: snapshot.completed,
    submittedCount: snapshot.submittedCount,
    teams: { A: team(snapshot.teams.A), B: team(snapshot.teams.B) },
  });
}

/**
 * 结果文本：房间名 + 完成情况 + 双方队名与 4 禁用 / 9 选用名称。
 *
 * 禁用与选用按本方权威顺序排列并保留两轮分隔（第 1 轮/第 2 轮）；
 * 不含成员信息、预选、操作位缩写、房间链接或时间线。
 */
export function formatResultText(snapshot: ExportResultSnapshot): string {
  const lines: string[] = [`${snapshot.roomName} BP 结果 · ${exportCompletionText(snapshot)}`];
  for (const team of ["A", "B"] as const) {
    const result = snapshot.teams[team];
    lines.push("");
    lines.push(
      result.teamName === "" ? sideLabel(team) : `${sideLabel(team)} · ${result.teamName}`,
    );
    const [banRound1, banRound2] = exportBanRounds(result);
    lines.push(`禁用 第 1 轮：${banRound1.map(slotName).join("、")}`);
    lines.push(`禁用 第 2 轮：${banRound2.map(slotName).join("、")}`);
    const [pickRound1, pickRound2] = exportPickRounds(result);
    lines.push(`选用 第 1 轮：${pickRound1.map(slotName).join("、")}`);
    lines.push(`选用 第 2 轮：${pickRound2.map(slotName).join("、")}`);
  }
  return lines.join("\n");
}

/** 完成情况与提交数的自洽性（防御性：构建路径之外的快照不伪造完整结果）。 */
export function isExportResultConsistent(snapshot: ExportResultSnapshot): boolean {
  return snapshot.completed === (snapshot.submittedCount === BP_STEP_COUNT);
}
