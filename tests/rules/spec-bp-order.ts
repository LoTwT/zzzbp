import type { BpSlotId } from "../../shared/bp/steps";
import type { BpSubmission } from "../../shared/bp/state";

/**
 * 规格来源的测试夹具。
 *
 * 26 步操作顺序独立抄自 docs/specs/single-game-bp.md「已确认的操作顺序」，
 * 不从实现导出值，避免用实现自身充当测试预期；仅引用实现的类型做静态约束，
 * 使夹具中的字面量必须落在合法操作位集合内。
 */
export const SPEC_BP_STEP_ORDER: readonly BpSlotId[] = [
  "AB1",
  "BB1",
  "AB2",
  "BB2",
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
  "BB3",
  "AB3",
  "BB4",
  "AB4",
  "BP7",
  "AP7",
  "AP8",
  "BP8",
  "BP9",
  "AP9",
];

/** 合成代理人 ID（30 个，覆盖一局 26 步仍有余量）；真实名单由数据接入 PR 提供。 */
export const SYNTHETIC_AGENT_IDS: readonly string[] = Array.from(
  { length: 30 },
  (_, index) => `agent-${String(index + 1).padStart(2, "0")}`,
);

/**
 * 按规格顺序的前 count 步构造合成提交：第 i 步使用 SYNTHETIC_AGENT_IDS[i]，
 * 保证一局之内代理人互不重复。
 */
export function specSubmissions(count: number): BpSubmission[] {
  if (!Number.isInteger(count) || count < 0 || count > SPEC_BP_STEP_ORDER.length) {
    throw new RangeError(`提交数应为 0 到 ${SPEC_BP_STEP_ORDER.length} 的整数，收到：${count}`);
  }
  return SPEC_BP_STEP_ORDER.slice(0, count).map((slotId, index) => ({
    slotId,
    agentId: SYNTHETIC_AGENT_IDS[index],
  }));
}
