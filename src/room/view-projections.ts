import { getBpStep, type BpSlotId, type BpTeam } from "../../shared/bp/steps";
import type { BpPublicView } from "../../shared/contracts/views";
import type { RoomAgentDisplay, RoomCatalogModel, AgentDisplayBase } from "./room-catalog";
import { banStepsOfTeam, pickSlotRows } from "./pick-layout";

/**
 * 公开 BP 视图的界面投影：顶部禁用槽位、双方队伍标识、两侧选用区与
 * 公开预选的派生。
 *
 * 房间工作区、实时展示页与只读记录页共用同一份派生（单一事实来源）：
 * active 判定、空席队名占位、公开预选展示与队伍名规则在各场景保持
 * 一致，行结构一律由权威顺序（BP_STEPS）经 pick-layout 推导。输入是
 * 公开视图（RoomMemberView / DisplayView 同形），不含成员专属字段的
 * 依赖。只读记录页的快照投影见 record-view.ts（同一套行结构）。
 */

/** 单个禁用槽位的展示信息（顶部禁用区）。 */
export interface BanSlotView {
  readonly slotId: BpSlotId;
  readonly agent: AgentDisplayBase | null;
  readonly active: boolean;
}

/** 单个选用槽位的展示信息（PickColumn 渲染所需的最小集合）。 */
export interface PickSlotView {
  readonly slotId: BpSlotId;
  readonly step: PickSlotViewStep;
  readonly agent: AgentDisplayBase | null;
  readonly active: boolean;
}

interface PickSlotViewStep {
  readonly sideOrdinal: number;
}

/** 一方选用区的展示信息：九格竖排的行结构（每行 1 个槽位，填充卡片）。 */
export interface TeamPickColumnView {
  readonly rows: ReadonlyArray<ReadonlyArray<PickSlotView>>;
}

/**
 * 空席时顶部队伍标识的占位文案（本轮仅替换文案，不改判定）。是否使用它
 * 仍只由席位占用决定：已保存队名但席位为空时同样显示该占位，席位有人但
 * 队名未填写时仍可能为空；队名继续独立保留。选手空席的「待选择」是另一
 * 处文案（由房主面板单独维护），不随本次调整变化。
 */
export const EMPTY_TEAM_LABEL = "待设置";

/**
 * 双方队伍标识（顶部禁用区旁的队名）：以席位占用为准
 * （room-layout.md「双方队伍信息」）——空席一律显示「待设置」，队名
 * 独立保留；落座后显示队名（未命名时为空）。
 */
export function teamLabelsOfView(view: BpPublicView): Record<BpTeam, string> {
  return {
    A: view.seatOccupancy.A ? view.teamNames.A : EMPTY_TEAM_LABEL,
    B: view.seatOccupancy.B ? view.teamNames.B : EMPTY_TEAM_LABEL,
  };
}

/** 目录中查找代理人的展示信息；目录未就绪或条目缺失为 null。 */
export function agentDisplayOf(
  catalog: RoomCatalogModel | null,
  agentId: string | null | undefined,
): RoomAgentDisplay | null {
  if (agentId === null || agentId === undefined || catalog === null) return null;
  return catalog.byId.get(agentId) ?? null;
}

/** 当前操作位的公开预选代理人；无预选或目录未就绪为 null。 */
export function preselectAgentOf(
  view: BpPublicView,
  catalog: RoomCatalogModel | null,
): RoomAgentDisplay | null {
  return agentDisplayOf(catalog, view.preselect);
}

/** 双方禁用槽位（每方 4 个，按本方禁用序号），含 active 与已提交结果。 */
export function banSlotsOfView(
  view: BpPublicView,
  catalog: RoomCatalogModel | null,
): Record<BpTeam, ReadonlyArray<BanSlotView>> {
  const result = {} as Record<BpTeam, ReadonlyArray<BanSlotView>>;
  const submissions = new Map<BpSlotId, string>(view.submissions.map((s) => [s.slotId, s.agentId]));
  for (const team of ["A", "B"] as const) {
    result[team] = banStepsOfTeam(team).map(({ slotId }) => ({
      slotId,
      agent: agentDisplayOf(catalog, submissions.get(slotId)),
      active: view.currentSlotId === slotId,
    }));
  }
  return result;
}

/** 双方选用区：九格竖排，行结构由权威顺序推导；空槽保持空框。 */
export function pickColumnsOfView(
  view: BpPublicView,
  catalog: RoomCatalogModel | null,
): Record<BpTeam, TeamPickColumnView> {
  const result = {} as Record<BpTeam, TeamPickColumnView>;
  const submissions = new Map<BpSlotId, string>(view.submissions.map((s) => [s.slotId, s.agentId]));
  for (const team of ["A", "B"] as const) {
    const rows = pickSlotRows(team).map((row) =>
      row.map(({ slotId, step }) => ({
        slotId,
        step: { sideOrdinal: step.sideOrdinal },
        agent: agentDisplayOf(catalog, submissions.get(slotId)),
        active: view.currentSlotId === slotId,
      })),
    );
    result[team] = { rows };
  }
  return result;
}

/** 视图尚未到达时的空投影：首个权威视图到达前保持界面结构稳定。 */
export const EMPTY_BAN_SLOTS: Record<BpTeam, ReadonlyArray<BanSlotView>> = { A: [], B: [] };

export const EMPTY_TEAM_LABELS: Record<BpTeam, string> = {
  A: EMPTY_TEAM_LABEL,
  B: EMPTY_TEAM_LABEL,
};

export const EMPTY_PICK_COLUMNS: Record<BpTeam, TeamPickColumnView> = {
  A: { rows: [] },
  B: { rows: [] },
};

/** 当前操作位的步骤信息；视图缺失或无待确认位置（待开始/已完成）为 null。 */
export function currentStepOf(view: BpPublicView | null) {
  if (view === null || view.currentSlotId === null) return null;
  return getBpStep(view.currentSlotId);
}
