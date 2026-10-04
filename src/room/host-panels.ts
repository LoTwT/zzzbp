import { getBpStep, type BpTeam } from "../../shared/bp/steps";
import type { HostManagementView, ManagedMember } from "../../shared/contracts/views";
import type { AgentId } from "../../shared/ids";

/**
 * 房主控制面板的纯派生逻辑：开局条件、撤回目标描述与成员列表。
 *
 * 输入是房主管理视图（含成员、席位与在线状态），输出仅用于展示与候选
 * 判断；真正的权限与前提始终由服务端命令管线裁决，这里不复制规则。
 */

/** 对外展示的方位文案：A 为左方、B 为右方（与只读记录页一致）。 */
export function sideLabel(team: BpTeam): string {
  return team === "A" ? "左方" : "右方";
}

/** 未填写队名时用左方/右方指位；已填写时优先用队名。 */
function teamLabelOf(view: HostManagementView, team: BpTeam): string {
  const name = view.teamNames[team];
  return name === "" ? sideLabel(team) : name;
}

/** 待开始状态下的开局未满足条件（用于「开始 BP」附近的说明）。 */
export function startBlockers(view: HostManagementView): readonly string[] {
  const blockers: string[] = [];
  for (const team of ["A", "B"] as const) {
    const label = teamLabelOf(view, team);
    if (view.teamNames[team] === "") blockers.push(`${label}队伍名未填写`);
    const seated = view.members.find((member) => member.seatTeam === team) ?? null;
    if (seated === null) blockers.push(`${label}席位无选手`);
    else if (!seated.online) blockers.push(`${label}选手不在线`);
  }
  return blockers;
}

/**
 * 撤回目标的描述文案：第几步、左右方动作与代理人官方名称。
 *
 * 无可撤回提交时返回 null。描述方式与只读记录页一致（左方/右方 + 禁用/选用）。
 */
export function undoTargetDescription(
  view: HostManagementView,
  agentNameOf: (agentId: AgentId) => string,
): string | null {
  const last = view.submissions.at(-1);
  if (last === undefined) return null;
  const step = getBpStep(last.slotId);
  const action = step.action === "ban" ? "禁用" : "选用";
  return `第 ${view.submissions.length} 步 · ${sideLabel(step.team)}${action} · ${agentNameOf(last.agentId)}`;
}

/** 成员的角色展示文案。 */
export function memberRoleText(member: {
  readonly isHost: boolean;
  readonly seatTeam: BpTeam | null;
}): string {
  if (member.isHost) return member.seatTeam === null ? "房主" : "房主 · 选手";
  return member.seatTeam === null ? "观众" : "选手";
}

/**
 * 席位选择/换人列表的稳定行。
 *
 * 行序沿用房主管理视图的成员顺序（服务端按加入顺序返回）：换人、资格
 * 变化都只在原行上更新角色文案与按钮，不重排、不把新选手抽到列表顶部
 * （docs/specs/room-layout.md「成员列表与换人」，线框更换选手 v3
 * before/after：两名成员始终位于相同行）。
 */
export interface SeatSelectionRow {
  readonly member: ManagedMember;
  /** 该队现任选手；即使离线也保留在本列表中，按钮禁用为「当前选手」。 */
  readonly isCurrent: boolean;
  /** 当前可指派：在线且未占另一席（未占席的房主本人也在候选内）。 */
  readonly eligible: boolean;
}

/**
 * 席位选择列表行：目标队现任选手 + 合格候选，按成员顺序原位排列。
 *
 * 另一方的在席选手不进入本队列表；候选要求在线。`retainedMemberIds` 是
 * 本列表已展示过的成员：资格消失（如离线、被安排到另一席之外的调整）
 * 后保留原行并禁用按钮，避免行在待处理期间闪烁消失；不含在其中的
 * 离线成员（从未展示过）不进入列表。真正的权限与前提始终由服务端
 * 命令管线裁决，这里只做展示派生。
 */
export function seatSelectionRows(
  view: HostManagementView,
  team: BpTeam,
  retainedMemberIds: ReadonlySet<string> = new Set(),
): readonly SeatSelectionRow[] {
  const otherTeam: BpTeam = team === "A" ? "B" : "A";
  const currentMemberId = view.members.find((member) => member.seatTeam === team)?.memberId ?? null;
  const rows: SeatSelectionRow[] = [];
  for (const member of view.members) {
    if (member.seatTeam === otherTeam) continue;
    const isCurrent = member.memberId === currentMemberId;
    const eligible =
      member.online && member.seatTeam === null && member.memberId !== currentMemberId;
    if (!isCurrent && !eligible && !retainedMemberIds.has(member.memberId)) continue;
    rows.push({ member, isCurrent, eligible });
  }
  return rows;
}

/** 其他成员列表：双方选手以外的全部成员（含房主未占席时），在线与离线都展示。 */
export function otherMemberRows(view: HostManagementView): readonly ManagedMember[] {
  return view.members.filter((member) => member.seatTeam === null);
}
