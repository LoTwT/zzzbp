import { z } from "zod";
import { bpSlotIdSchema, bpTeamSchema } from "./bp/steps";
import { agentIdSchema, memberIdSchema } from "./ids";
import { teamNameInputSchema, type RoomState } from "./room";

/**
 * 房间命令契约：客户端可发送的命令 schema 与统一的执行结果。
 *
 * 命令只表达操作意图：角色、席位与在线状态一律由服务端从房间状态派生，
 * 载荷中的自报字段会被 Zod 默认行为剥离，不存在可伪造身份的字段；
 * `targetMemberId` 仅是席位的被安排对象，不代表操作者。
 *
 * 所有命令携带 `operationId`（客户端生成的唯一操作标识，服务端按
 * room + member + operationId 持久化去重回执，见 shared/contracts/websocket.ts）
 * 与 `expectedBpVersion`（命令所依据的 bp.version，不匹配即视为过期命令）。
 * 预选与提交命令额外携带目标操作位，必须与当前操作位一致，防止跨位误用。
 */

/** 操作标识：客户端生成，仅要求 trim 后非空。 */
export const operationIdSchema = z.string().trim().min(1).max(100);

/** 命令公共字段。 */
const commandBaseSchema = {
  operationId: operationIdSchema,
  /** 命令发出时所依据的 BP 版本，必须与当前 bp.version 一致。 */
  expectedBpVersion: z.number().int().nonnegative(),
};

/** 修改队伍名：仅房主，任何 BP 状态下均可执行。
 *
 * 队伍名是唯一「产生可见变化但不推进 bp.version」的命令：回执窗口淘汰后
 * 的旧重发若仅靠值比较，可能把后来已确认的名称改回旧值。因此本命令额外
 * 携带 `expectedRevision`（命令发出时所依据的公开 revision），必须与当前
 * revision 严格一致；任何后续可见变化（含后续改名）都会使旧载荷过期
 * （STALE_REVISION），客户端需重新同步后以新 operationId 再发。
 */
export const setTeamNameCommandSchema = z.object({
  ...commandBaseSchema,
  type: z.literal("setTeamName"),
  team: bpTeamSchema,
  /** 填写/修改输入，trim 后 1 到 32 码点，不允许为空。 */
  teamName: teamNameInputSchema,
  /** 命令发出时所依据的公开 revision（视图同步用），必须与当前一致。 */
  expectedRevision: z.number().int().nonnegative(),
});
export type SetTeamNameCommand = z.infer<typeof setTeamNameCommandSchema>;

/**
 * 分配或替换席位：仅房主，待开始或已暂停状态可执行。
 * `targetMemberId` 是被安排上席的成员，须在线且未占据另一方席位。
 */
export const assignSeatCommandSchema = z.object({
  ...commandBaseSchema,
  type: z.literal("assignSeat"),
  team: bpTeamSchema,
  targetMemberId: memberIdSchema,
});
export type AssignSeatCommand = z.infer<typeof assignSeatCommandSchema>;

/** 开始 BP：仅房主，待开始状态且满足开局条件。 */
export const startBpCommandSchema = z.object({
  ...commandBaseSchema,
  type: z.literal("startBp"),
});
export type StartBpCommand = z.infer<typeof startBpCommandSchema>;

/** 主动暂停 BP：仅房主，进行中状态。 */
export const pauseBpCommandSchema = z.object({
  ...commandBaseSchema,
  type: z.literal("pauseBp"),
});
export type PauseBpCommand = z.infer<typeof pauseBpCommandSchema>;

/** 手动继续 BP：仅房主，已暂停状态；重连与换人均不自动继续。 */
export const resumeBpCommandSchema = z.object({
  ...commandBaseSchema,
  type: z.literal("resumeBp"),
});
export type ResumeBpCommand = z.infer<typeof resumeBpCommandSchema>;

/** 撤回最近一条有效提交：仅房主；完成状态撤回后转为已暂停。 */
export const undoBpStepCommandSchema = z.object({
  ...commandBaseSchema,
  type: z.literal("undoBpStep"),
});
export type UndoBpStepCommand = z.infer<typeof undoBpStepCommandSchema>;

/** 重开本局：仅房主；清空序列与预选回到待开始，保留房间配置，版本不重置。 */
export const restartBpCommandSchema = z.object({
  ...commandBaseSchema,
  type: z.literal("restartBp"),
});
export type RestartBpCommand = z.infer<typeof restartBpCommandSchema>;

/** 设置或更换预选：仅当前操作位的在席选手，进行中状态。 */
export const setPreselectCommandSchema = z.object({
  ...commandBaseSchema,
  type: z.literal("setPreselect"),
  /** 目标操作位：必须等于当前操作位。 */
  slotId: bpSlotIdSchema,
  /** 预选的代理人：必须在本场名单内且未被禁用或选用。 */
  agentId: agentIdSchema,
});
export type SetPreselectCommand = z.infer<typeof setPreselectCommandSchema>;

/** 清空当前操作位的预选：仅当前操作位的在席选手，进行中状态。 */
export const clearPreselectCommandSchema = z.object({
  ...commandBaseSchema,
  type: z.literal("clearPreselect"),
  slotId: bpSlotIdSchema,
});
export type ClearPreselectCommand = z.infer<typeof clearPreselectCommandSchema>;

/** 确认当前预选并推进操作位：仅当前操作位的在席选手，进行中状态。 */
export const confirmPreselectCommandSchema = z.object({
  ...commandBaseSchema,
  type: z.literal("confirmPreselect"),
  slotId: bpSlotIdSchema,
});
export type ConfirmPreselectCommand = z.infer<typeof confirmPreselectCommandSchema>;

/** 房间命令的判别联合。 */
export const roomCommandSchema = z.discriminatedUnion("type", [
  setTeamNameCommandSchema,
  assignSeatCommandSchema,
  startBpCommandSchema,
  pauseBpCommandSchema,
  resumeBpCommandSchema,
  undoBpStepCommandSchema,
  restartBpCommandSchema,
  setPreselectCommandSchema,
  clearPreselectCommandSchema,
  confirmPreselectCommandSchema,
]);
export type RoomCommand = z.infer<typeof roomCommandSchema>;

/**
 * 写操作的稳定错误码。
 *
 * - ACTOR_NOT_MEMBER / ACTOR_OFFLINE / MEMBER_NOT_FOUND：操作者或目标成员身份问题；
 * - ROOM_ARCHIVED：归档房间拒绝一切写操作；
 * - NOT_HOST / NOT_CURRENT_PLAYER：权限不足；
 * - STALE_BP_VERSION：命令所依据的 BP 版本已过期；
 * - STALE_REVISION：命令所依据的公开 revision 已过期（用于不推进
 *   bp.version 的可见写入，如 setTeamName 的 expectedRevision 前置条件）；
 * - BP_NOT_WAITING / BP_NOT_RUNNING / BP_NOT_PAUSED：BP 状态不满足命令前提；
 * - START_CONDITIONS_UNMET：开局条件未满足；
 * - SEAT_CHANGE_FORBIDDEN / SEAT_TARGET_*：席位调整相关；
 * - PRESELECT_SLOT_MISMATCH / NO_PRESELECT：预选与提交的目标位问题；
 * - AGENT_NOT_IN_CATALOG / AGENT_UNAVAILABLE：代理人名单或互斥池；
 * - NOTHING_TO_UNDO：无可撤回提交；
 * - OPERATION_ID_CONFLICT：同一 operationId 被用于不同的命令载荷（去重回执边界，
 *   见 shared/contracts/websocket.ts）；
 * - RULE_VERSION_UNSUPPORTED：房间持久规则版本不受当前引擎支持，拒绝执行；
 * - INTERNAL：命令处理中的未预期内部故障（存储或状态装配），状态保持原样，
 *   客户端可凭同一 operationId 重试。
 */
export const roomOperationErrorCodeSchema = z.enum([
  "ACTOR_NOT_MEMBER",
  "ACTOR_OFFLINE",
  "MEMBER_NOT_FOUND",
  "ROOM_ARCHIVED",
  "NOT_HOST",
  "NOT_CURRENT_PLAYER",
  "STALE_BP_VERSION",
  "STALE_REVISION",
  "BP_NOT_WAITING",
  "BP_NOT_RUNNING",
  "BP_NOT_PAUSED",
  "START_CONDITIONS_UNMET",
  "SEAT_CHANGE_FORBIDDEN",
  "SEAT_TARGET_NOT_MEMBER",
  "SEAT_TARGET_OFFLINE",
  "SEAT_TARGET_ALREADY_SEATED",
  "PRESELECT_SLOT_MISMATCH",
  "AGENT_NOT_IN_CATALOG",
  "AGENT_UNAVAILABLE",
  "NO_PRESELECT",
  "NOTHING_TO_UNDO",
  "OPERATION_ID_CONFLICT",
  "RULE_VERSION_UNSUPPORTED",
  "INTERNAL",
]);
export type RoomOperationErrorCode = z.infer<typeof roomOperationErrorCodeSchema>;

/** 命令或系统入口的执行错误：code 稳定，message 供日志与调试。 */
export const roomOperationErrorSchema = z.object({
  code: roomOperationErrorCodeSchema,
  message: z.string(),
});
export type RoomOperationError = z.infer<typeof roomOperationErrorSchema>;

/**
 * 房间写操作结果：成功返回推进后的新状态（输入状态不被修改），
 * 失败只返回错误，不产生任何状态或版本变化。
 */
export type RoomOperationResult =
  | { readonly ok: true; readonly state: RoomState }
  | { readonly ok: false; readonly error: RoomOperationError };
