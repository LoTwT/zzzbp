import { expect } from "vitest";
import type { AgentCatalog } from "../../shared/bp/agents";
import type { BpSlotId } from "../../shared/bp/steps";
import type {
  RoomCommand,
  RoomOperationError,
  RoomOperationErrorCode,
  RoomOperationResult,
} from "../../shared/commands";
import { roomStateSchema, type RoomState } from "../../shared/room";
import { applyRoomCommand } from "../../shared/transitions";
import { SPEC_BP_STEP_ORDER, SYNTHETIC_AGENT_IDS } from "./spec-bp-order";

/**
 * 状态转换测试夹具：固定成员身份的合成房间与便捷执行入口。
 *
 * 房间状态一律用 roomStateSchema 校验后使用；对局推进通过真实命令
 * 序列完成，期望的操作位与代理人来自规格夹具 spec-bp-order。
 */

/** 夹具成员 ID。 */
export const HOST_ID = "member-host";
export const PLAYER_A_ID = "member-player-a";
export const PLAYER_B_ID = "member-player-b";
export const AUDIENCE_ID = "member-audience";

/** 合成代理人目录；真实名单由数据接入 PR 提供。 */
export const fixtureCatalog: AgentCatalog = { agentIds: SYNTHETIC_AGENT_IDS };

export interface RoomFixtureOptions {
  /** 生命周期，默认 live。 */
  lifecycle?: "live" | "archived";
  /** 队伍名；传空字符串表示未填写。 */
  teamNameA?: string;
  teamNameB?: string;
  /** 席位成员；null 表示空位，默认由 A/B 选手占席。 */
  seatA?: string | null;
  seatB?: string | null;
  /** 指定离线成员 ID。 */
  offline?: readonly string[];
}

/** 构建待开始、开局条件默认满足的房间。 */
export function buildRoom(options: RoomFixtureOptions = {}): RoomState {
  const offline = new Set(options.offline ?? []);
  return roomStateSchema.parse({
    roomId: "room-fixture",
    name: "夹具房间",
    lifecycle: options.lifecycle ?? "live",
    hostMemberId: HOST_ID,
    teamNames: { A: options.teamNameA ?? "左方", B: options.teamNameB ?? "右方" },
    seats: {
      A: options.seatA === undefined ? PLAYER_A_ID : options.seatA,
      B: options.seatB === undefined ? PLAYER_B_ID : options.seatB,
    },
    members: [
      { memberId: HOST_ID, nickname: "房主", online: !offline.has(HOST_ID) },
      { memberId: PLAYER_A_ID, nickname: "A 选手", online: !offline.has(PLAYER_A_ID) },
      { memberId: PLAYER_B_ID, nickname: "B 选手", online: !offline.has(PLAYER_B_ID) },
      { memberId: AUDIENCE_ID, nickname: "观众", online: !offline.has(AUDIENCE_ID) },
    ],
    revision: 0,
    bp: { status: "waiting", submissions: [], preselect: null, version: 0 },
  });
}

/** 生成互不重复的合成操作 ID。 */
let operationSequence = 0;
export function nextOperationId(): string {
  operationSequence += 1;
  return `fixture-op-${operationSequence}`;
}

/** 绑定合成目录与操作者的命令执行入口。 */
export function run(
  state: RoomState,
  actorMemberId: string,
  command: RoomCommandInput,
): RoomOperationResult {
  return applyRoomCommand(
    state,
    { memberId: actorMemberId },
    {
      ...command,
      operationId: command.operationId ?? nextOperationId(),
      expectedBpVersion: command.expectedBpVersion ?? state.bp.version,
    },
    fixtureCatalog,
  );
}

/** 便捷输入类型：省略 operationId，expectedBpVersion 缺省取当前版本。 */
export type RoomCommandInput = WithDefaults<RoomCommand>;
type WithDefaults<T> = T extends unknown
  ? Omit<T, "operationId" | "expectedBpVersion"> & {
      operationId?: string;
      expectedBpVersion?: number;
    }
  : never;

/** 断言成功并返回推进后的新状态。 */
export function expectOk(result: RoomOperationResult): RoomState {
  if (result.ok) return result.state;
  throw new Error(`预期命令成功，实际收到错误 ${result.error.code}：${result.error.message}`);
}

/** 断言失败且错误码一致，返回错误供进一步检查。 */
export function expectError(
  result: RoomOperationResult,
  code: RoomOperationErrorCode,
): RoomOperationError {
  if (result.ok) throw new Error(`预期错误 ${code}，实际成功`);
  expect(result.error.code).toBe(code);
  return result.error;
}

/** 从夹具房间开始 BP，返回进行中的房间。 */
export function startedRoom(options: RoomFixtureOptions = {}): RoomState {
  return expectOk(run(buildRoom(options), HOST_ID, { type: "startBp" }));
}

/** 当前操作方完成一次「预选 + 确认」，返回推进后的房间状态。 */
export function confirmStep(
  state: RoomState,
  actorMemberId: string,
  slotId: BpSlotId,
  agentId: string,
): RoomState {
  const preselected = expectOk(
    run(state, actorMemberId, { type: "setPreselect", slotId, agentId }),
  );
  return expectOk(run(preselected, actorMemberId, { type: "confirmPreselect", slotId }));
}

/** 按规格顺序完整执行 26 步，返回已完成的房间。 */
export function completedRoom(): RoomState {
  let state = startedRoom();
  for (let index = 0; index < SPEC_BP_STEP_ORDER.length; index += 1) {
    const slotId = SPEC_BP_STEP_ORDER[index];
    const actorMemberId = state.seats[slotId.slice(0, 1) === "A" ? "A" : "B"];
    if (actorMemberId === null) throw new Error("测试前提失败：进行中席位不应为空");
    state = confirmStep(state, actorMemberId, slotId, SYNTHETIC_AGENT_IDS[index]);
  }
  return state;
}

/** 递归冻结对象，用于验证引擎不会就地修改输入状态。 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    Object.freeze(record);
    for (const key of Object.keys(record)) {
      deepFreeze(record[key]);
    }
  }
  return value;
}
