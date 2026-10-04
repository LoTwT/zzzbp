import {
  BP_PICK_SEGMENTS,
  BP_STEPS,
  type BpSlotId,
  type BpStep,
  type BpTeam,
} from "../../shared/bp/steps";

/**
 * 选用区布局：个人的两档显示设置与槽位行推导。
 *
 * 行内容一律由权威顺序推导（BP_STEPS / BP_PICK_SEGMENTS），不另维护任何
 * 顺序数组；「按 Pick 分行」直接消费 shared/bp/steps.ts 的连续选用段。
 * 布局是个人显示偏好：只影响自己页面，A、B 两侧一起切换，切换只重排
 * 槽位，不改变 BP 进度、已提交结果、预选对象与 active 位置（见
 * docs/specs/room-layout.md「选用区布局」）。
 */

/** 布局标识：vertical 为默认 9 格竖排，byPick 为按 Pick 分行。 */
export type PickLayout = "vertical" | "byPick";

/** 全部布局及其界面文案，顺序即面板中的展示顺序。 */
export const PICK_LAYOUT_LABELS: ReadonlyArray<{
  readonly id: PickLayout;
  readonly label: string;
}> = [
  { id: "vertical", label: "9 格竖排" },
  { id: "byPick", label: "按 Pick 分行" },
];

/** 个人布局偏好的存储键（localStorage，不涉及任何身份凭据）。 */
export const PICK_LAYOUT_STORAGE_KEY = "zzzbp.pick-layout";

/** 浏览器 localStorage 的最小结构视图：避免在本模块引入 DOM 类型依赖。 */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  const candidate = (globalThis as { localStorage?: unknown }).localStorage;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as StorageLike).getItem === "function" &&
    typeof (candidate as StorageLike).setItem === "function"
  ) {
    return candidate as StorageLike;
  }
  return null;
}

/**
 * 读取个人布局偏好：无存储、不可用或值非法时回退默认竖排。
 *
 * 实时展示页（PR8）打开时通过本函数继承原页面的布局设置；读取不修改
 * 存储，展示页后续独立保留该值。
 */
export function readPickLayoutPreference(): PickLayout {
  const storage = browserStorage();
  if (storage === null) return "vertical";
  try {
    const raw = storage.getItem(PICK_LAYOUT_STORAGE_KEY);
    return raw === "byPick" ? "byPick" : "vertical";
  } catch {
    return "vertical";
  }
}

/** 写入个人布局偏好；存储不可用（隐私模式等）时静默跳过，不影响当前会话。 */
export function writePickLayoutPreference(layout: PickLayout): void {
  const storage = browserStorage();
  if (storage === null) return;
  try {
    storage.setItem(PICK_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // 忽略写入失败：布局设置只影响本页显示，会话内仍生效。
  }
}

/** 单个选用槽位的引用信息。 */
export interface PickSlotRef {
  readonly slotId: BpSlotId;
  readonly step: BpStep;
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

/**
 * 按布局推导某方选用槽位的行结构。
 *
 * vertical：每行 1 个，共 9 行；byPick：每段连续同方选用为一行，直接使用
 * BP_PICK_SEGMENTS 的静态推导（A 方 6 行、B 方 5 行）。
 */
export function pickSlotRows(
  team: BpTeam,
  layout: PickLayout,
): readonly (readonly PickSlotRef[])[] {
  if (layout === "byPick") {
    return BP_PICK_SEGMENTS[team].map((segment) =>
      segment.map((step) => ({ slotId: step.slotId, step })),
    );
  }
  return pickStepsOfTeam(team).map((slot) => [slot]);
}
