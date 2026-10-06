import type { BpTeam } from "../../shared/bp/steps";
import type { ArchivedOperation, ArchiveSnapshot } from "../../shared/contracts/records";
import type { AgentDisplayBase } from "./room-catalog";
import { banStepsOfTeam, pickSlotRows } from "./pick-layout";
import type { BanSlotView, PickSlotView, TeamPickColumnView } from "./view-projections";

/**
 * 只读记录页的快照投影（docs/specs/room-layout.md「只读记录页」）。
 *
 * 归档快照是唯一数据来源：不请求当前 catalog 重解释旧名称或头像，
 * 代理人展示信息在归档时已固定在快照中（agentName/agentAvatarUrl）。
 * 行结构沿用 pick-layout 的权威顺序推导（九格竖排），与实时房间/
 * 展示页同一套槽位语义；所有槽位静态展示（无 active、无预选、无动效）。
 */

/** 由快照单步构造最小代理人展示信息（AgentAvatar/状态视觉共用）。 */
export function recordAgentDisplay(operation: ArchivedOperation): AgentDisplayBase {
  return { id: operation.agentId, name: operation.agentName, avatarUrl: operation.agentAvatarUrl };
}

/**
 * 快照单步的操作文案：左方/右方 + 禁用/选用。
 *
 * 左方、右方对应本局固定的 A、B 席位，与页面两侧位置一致；不显示
 * AB1/AP1 等操作位缩写，也不逐行重复队伍名。
 */
export function recordActionText(operation: ArchivedOperation): string {
  const side = operation.team === "A" ? "左方" : "右方";
  const action = operation.action === "ban" ? "禁用" : "选用";
  return `${side}${action}`;
}

/** 顶部状态文案：记录模式及归档时的完成情况，不扩展实时房间的四种状态。 */
export function recordStatusText(snapshot: ArchiveSnapshot): string {
  return snapshot.bpCompleted ? "只读记录 · 已完成" : "只读记录 · 未完成";
}

/** 双方禁用槽位（每方 4 个，按本方禁用序号）；未提交的禁用位保持空槽。 */
export function recordBanSlots(
  snapshot: ArchiveSnapshot,
): Record<BpTeam, ReadonlyArray<BanSlotView>> {
  const result = {} as Record<BpTeam, ReadonlyArray<BanSlotView>>;
  const bySlot = new Map(snapshot.operations.map((operation) => [operation.slotId, operation]));
  for (const team of ["A", "B"] as const) {
    result[team] = banStepsOfTeam(team).map(({ slotId }) => {
      const operation = bySlot.get(slotId);
      return {
        slotId,
        agent: operation === undefined ? null : recordAgentDisplay(operation),
        active: false,
      };
    });
  }
  return result;
}

/**
 * 双方队伍标识（顶部禁用区旁的队名）：直接来自快照（开局要求双方队名
 * 已填写，实际不为空）；空值按原样展示，不用「待选择」占位（归档房间
 * 的席位不再变化）。
 */
export function recordTeamLabels(snapshot: ArchiveSnapshot): Record<BpTeam, string> {
  return { A: snapshot.teamNames.A, B: snapshot.teamNames.B };
}

/** 双方选用区（九格竖排）；未完成的槽位保持空白。 */
export function recordPickColumns(snapshot: ArchiveSnapshot): Record<BpTeam, TeamPickColumnView> {
  const result = {} as Record<BpTeam, TeamPickColumnView>;
  const bySlot = new Map(snapshot.operations.map((operation) => [operation.slotId, operation]));
  for (const team of ["A", "B"] as const) {
    const rows = pickSlotRows(team).map((row) =>
      row.map(({ slotId, step }): PickSlotView => {
        const operation = bySlot.get(slotId);
        return {
          slotId,
          step: { sideOrdinal: step.sideOrdinal },
          agent: operation === undefined ? null : recordAgentDisplay(operation),
          active: false,
        };
      }),
    );
    result[team] = { rows };
  }
  return result;
}

/**
 * 控制面板中的记录到期时间文案（本地时区日期）。
 *
 * 到期时间来自快照（自实际转为只读起 90 天），查看记录不延长期限；
 * 页面静态展示该时间，不做倒计时或轮询。
 */
export function formatRecordExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "未知";
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}
