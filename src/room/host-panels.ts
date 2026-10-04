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

/** 席位选择列表：目标队伍现任选手 + 可指派的在线候选（含未占另一席的房主）。 */
export function seatSelectionRows(
  view: HostManagementView,
  team: BpTeam,
): {
  readonly current: ManagedMember | null;
  readonly candidates: readonly ManagedMember[];
} {
  const current = view.members.find((member) => member.seatTeam === team) ?? null;
  const otherTeam: BpTeam = team === "A" ? "B" : "A";
  const candidates = view.members.filter(
    (member) =>
      member.online && member.seatTeam !== otherTeam && member.memberId !== current?.memberId,
  );
  return { current, candidates };
}

/** 其他成员列表：双方选手以外的全部成员（含房主未占席时），在线与离线都展示。 */
export function otherMemberRows(view: HostManagementView): readonly ManagedMember[] {
  return view.members.filter((member) => member.seatTeam === null);
}
