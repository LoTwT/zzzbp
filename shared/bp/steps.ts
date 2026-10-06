import { z } from "zod";

/**
 * BP 阵营：A 为先手方，B 为后手方，同时也是固定的 A/B 席位方向。
 * 依据 docs/specs/single-game-bp.md「操作标记」。
 */
export const bpTeamSchema = z.enum(["A", "B"]);
export type BpTeam = z.infer<typeof bpTeamSchema>;

/** BP 动作：ban 为禁用，pick 为选用；操作位标记中分别用字母 B 和 P 表示。 */
export const bpActionSchema = z.enum(["ban", "pick"]);
export type BpAction = z.infer<typeof bpActionSchema>;

/**
 * 26 步操作位的权威顺序，是本仓库的唯一事实来源。
 *
 * 顺序与四阶段分组依据 docs/specs/single-game-bp.md「已确认的操作顺序」。
 * 操作位 ID 的构成为：阵营字母 + 动作字母 + 本方累计序号，
 * 例如 `AB1` 表示 A 方第 1 个禁用位，`BP7` 表示 B 方第 7 个选用位。
 */
export const BP_STEP_ORDER = [
  // 第一轮禁用
  "AB1",
  "BB1",
  "AB2",
  "BB2",
  // 第一轮选用
  "AP1",
  "BP1",
  "BP2",
  "AP2",
  "AP3",
  "BP3",
  "BP4",
  "AP4",
  "AP5",
  "BP5",
  "BP6",
  "AP6",
  // 第二轮禁用
  "BB3",
  "AB3",
  "BB4",
  "AB4",
  // 第二轮选用
  "BP7",
  "AP7",
  "AP8",
  "BP8",
  "BP9",
  "AP9",
] as const;

/** 操作位 ID 的校验 schema：合法值即权威顺序中的 26 个标记。 */
export const bpSlotIdSchema = z.enum(BP_STEP_ORDER);
export type BpSlotId = z.infer<typeof bpSlotIdSchema>;

/** 全程操作位置总数。 */
export const BP_STEP_COUNT = BP_STEP_ORDER.length;

/** 单个操作位置的静态信息。 */
export interface BpStep {
  /** 在权威顺序中的位置，从 0 开始。 */
  readonly index: number;
  /** 操作位 ID，如 `AB1`。 */
  readonly slotId: BpSlotId;
  /** 执行该操作的一方。 */
  readonly team: BpTeam;
  /** 禁用或选用。 */
  readonly action: BpAction;
  /** 本方该动作的累计序号，从 1 开始；禁用为 1-4，选用为 1-9。 */
  readonly sideOrdinal: number;
}

const SLOT_ID_PATTERN = /^([AB])([BP])([1-9])$/;

/**
 * 按操作位标记的构成规则解析阵营、动作与本方序号。
 * 仅用于初始化权威顺序本身；输入不合法时直接抛错，暴露定义处的笔误。
 */
function parseSlotId(
  slotId: string,
  position: number,
): { team: BpTeam; action: BpAction; sideOrdinal: number } {
  const match = SLOT_ID_PATTERN.exec(slotId);
  if (!match) {
    throw new Error(`BP_STEP_ORDER 第 ${position} 项「${slotId}」不是合法的操作位 ID`);
  }
  const team = match[1] as BpTeam;
  const action = match[2] === "B" ? "ban" : "pick";
  const sideOrdinal = Number(match[3]);
  return { team, action, sideOrdinal };
}

/** 权威顺序解析后的完整步骤信息；`BP_STEPS[i].index === i`。 */
export const BP_STEPS: readonly BpStep[] = BP_STEP_ORDER.map((slotId, index) => ({
  index,
  slotId,
  ...parseSlotId(slotId, index),
}));

const stepBySlotId: ReadonlyMap<BpSlotId, BpStep> = new Map(
  BP_STEPS.map((step) => [step.slotId, step]),
);

/** 查询操作位 ID 对应的步骤信息；未知 ID 属于调用方错误，直接抛错。 */
export function getBpStep(slotId: BpSlotId): BpStep {
  const step = stepBySlotId.get(slotId);
  if (!step) {
    throw new Error(`未知的 BP 操作位 ID：${slotId}`);
  }
  return step;
}

/** 查询全局顺序中第 index（0 起）个步骤；越界属于调用方错误，直接抛错。 */
export function getBpStepAt(index: number): BpStep {
  if (!Number.isInteger(index) || index < 0 || index >= BP_STEP_COUNT) {
    throw new RangeError(`BP 步骤下标应为 0 到 ${BP_STEP_COUNT - 1}，收到：${index}`);
  }
  return BP_STEPS[index];
}

/**
 * 当前操作位：已确认 `confirmedCount` 个提交后，下一个待确认的位置。
 *
 * `confirmedCount` 必须是 0 到 26 的整数；全部确认后返回 null，表示本局
 * 已完成，不再有可操作位置。暂停不影响当前操作位，恢复后仍从该位置继续。
 */
export function currentBpStep(confirmedCount: number): BpStep | null {
  if (!Number.isInteger(confirmedCount) || confirmedCount < 0 || confirmedCount > BP_STEP_COUNT) {
    throw new RangeError(`已确认提交数应为 0 到 ${BP_STEP_COUNT} 的整数，收到：${confirmedCount}`);
  }
  return confirmedCount === BP_STEP_COUNT ? null : getBpStepAt(confirmedCount);
}

/** 每方各动作的操作位数量（禁用 4、选用 9），由权威顺序推导。 */
function computeActionCounts(): Readonly<Record<BpTeam, Readonly<Record<BpAction, number>>>> {
  const counts: Record<BpTeam, Record<BpAction, number>> = {
    A: { ban: 0, pick: 0 },
    B: { ban: 0, pick: 0 },
  };
  for (const step of BP_STEPS) {
    counts[step.team][step.action] += 1;
  }
  return counts;
}

/** 每方的动作数量（禁用 4、选用 9），由权威顺序推导。 */
export const BP_ACTION_COUNTS = computeActionCounts();
