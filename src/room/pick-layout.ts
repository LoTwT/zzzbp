import {
  BP_STEPS,
  getBpStep,
  type BpSlotId,
  type BpStep,
  type BpTeam,
} from "../../shared/bp/steps";

/**
 * 选用区槽位结构：九格竖排的行推导与两轮分隔位置。
 *
 * 行内容一律由权威顺序（BP_STEPS）推导，不另维护任何顺序数组：A、B
 * 两侧各自按本方选用序号排列，每行 1 个槽位，共 9 行（docs/specs/
 * room-layout.md「选用区布局」）。实时房间、展示页与记录页共用同一
 * 推导，两侧槽位语义一致。
 */

/** 单个选用槽位的引用信息。 */
export interface PickSlotRef {
  readonly slotId: BpSlotId;
  readonly step: BpStep;
}

/**
 * 第二轮禁用的起始本方序号：每方 4 个禁用位按前 2 位与后 2 位分两轮
 * （docs/specs/single-game-bp.md「已确认的操作顺序」）。
 */
export const SECOND_BAN_ROUND_START_ORDINAL = 3;

/**
 * 第二轮选用的起始本方序号：每方 9 个选用位按前 6 位与后 3 位分两轮。
 */
export const SECOND_PICK_ROUND_START_ORDINAL = 7;

/** 判定选用区轮次边界所需的最小槽位信息（实时投影与快照投影共用）。 */
export interface PickOrdinalSlot {
  readonly step: { readonly sideOrdinal: number };
}

/**
 * 两轮禁用之间的分隔位置：返回需要在其之前插入分隔线的槽位下标。
 *
 * 边界按权威操作位推导（本方第 3 个禁用位开启第二轮），与显示顺序无关；
 * 投影尚未到达或没有第二轮（返回 -1）时不显示分隔线。
 */
export function banRoundBreakIndex(slots: readonly { readonly slotId: BpSlotId }[]): number {
  return slots.findIndex(
    (slot) => getBpStep(slot.slotId).sideOrdinal >= SECOND_BAN_ROUND_START_ORDINAL,
  );
}

/**
 * 两轮选用之间的分隔位置：返回需要在其之前插入分隔线的行下标。
 *
 * 边界一律按本方的选用序号判断——第 7 个选用位开启第二轮，不按显示行数
 * 平分；九格竖排返回第 7 行下标（其前 6 行、其后 3 行）。
 */
export function pickRoundBreakIndex(rows: readonly (readonly PickOrdinalSlot[])[]): number {
  return rows.findIndex(
    (row) => row.length > 0 && row[0]!.step.sideOrdinal >= SECOND_PICK_ROUND_START_ORDINAL,
  );
}

/** 某方全部选用位，按权威顺序（sideOrdinal 1..9）排列。 */
export function pickStepsOfTeam(team: BpTeam): readonly PickSlotRef[] {
  return BP_STEPS.filter((step) => step.team === team && step.action === "pick").map((step) => ({
    slotId: step.slotId,
    step,
  }));
}

/** 某方全部禁用位，按权威顺序（sideOrdinal 1..4）排列。 */
export function banStepsOfTeam(team: BpTeam): readonly PickSlotRef[] {
  return BP_STEPS.filter((step) => step.team === team && step.action === "ban").map((step) => ({
    slotId: step.slotId,
    step,
  }));
}

/** 某方选用槽位的行结构：九格竖排，每行 1 个槽位，共 9 行。 */
export function pickSlotRows(team: BpTeam): readonly (readonly PickSlotRef[])[] {
  return pickStepsOfTeam(team).map((slot) => [slot]);
}
