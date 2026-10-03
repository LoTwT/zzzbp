import { z } from "zod";
import { bpSlotIdSchema, bpTeamSchema, currentBpStep } from "../bp/steps";
import { bpStatusSchema, bpSubmissionSchema } from "../bp/state";
import { agentIdSchema, memberIdSchema, type MemberId } from "../ids";
import { nicknameSchema, roomNameSchema, teamNamesSchema, type RoomState } from "../room";
import { versionInfoSchema, type VersionInfo } from "./versions";

/**
 * 视图投影合同：服务端向客户端与展示连接下发的可见内容。
 *
 * 投影按显式白名单构造，绝不直接转发 RoomState；成员凭据、成员列表、
 * 在线管理数据只进入有权查看的视图。产品展示规则见
 * docs/specs/room-layout.md，此处只维护数据边界。
 */

/**
 * 公开 BP 视图：所有查看者可见的最小集合。
 *
 * 含房名、队名、BP 状态、当前操作位、已确认公开结果、公开预选、
 * 规则与数据版本、公开 revision；不含任何成员数据或凭据。
 */
export const bpPublicViewSchema = z.object({
  roomName: roomNameSchema,
  teamNames: teamNamesSchema,
  bpStatus: bpStatusSchema,
  /** 当前操作位；无待确认位置（待开始/已完成）时为 null。 */
  currentSlotId: bpSlotIdSchema.nullable(),
  /** 已确认的公开禁选结果（当前有效序列）。 */
  submissions: z.array(bpSubmissionSchema),
  /** 当前操作位对全房间公开的预选。 */
  preselect: agentIdSchema.nullable(),
  versions: versionInfoSchema,
  /** 公开视图 revision：随任何可见状态变化递增。 */
  revision: z.number().int().nonnegative(),
});
export type BpPublicView = z.infer<typeof bpPublicViewSchema>;

/** 成员自身信息：仅本人视图可见，不含其他成员数据。 */
export const memberSelfInfoSchema = z.object({
  memberId: memberIdSchema,
  nickname: nicknameSchema,
  /** 是否房主；被换下席位后仍为 true。 */
  isHost: z.boolean(),
  /** 本人当前所在席位；未占席为 null。 */
  seatTeam: bpTeamSchema.nullable(),
});
export type MemberSelfInfo = z.infer<typeof memberSelfInfoSchema>;

/**
 * 普通成员视图：公开 BP 内容 + 自身身份与席位 + 发送命令所需的
 * 当前 bp.version。没有成员列表与在线管理数据。
 */
export const roomMemberViewSchema = bpPublicViewSchema.extend({
  self: memberSelfInfoSchema,
  /** 命令的 expectedBpVersion 依据；展示视图不含此字段。 */
  bpVersion: z.number().int().nonnegative(),
});
export type RoomMemberView = z.infer<typeof roomMemberViewSchema>;

/** 房主管理视图中的成员条目：含席位与在线状态，仅房主可见。 */
export const managedMemberSchema = z.object({
  memberId: memberIdSchema,
  nickname: nicknameSchema,
  isHost: z.boolean(),
  seatTeam: bpTeamSchema.nullable(),
  online: z.boolean(),
});
export type ManagedMember = z.infer<typeof managedMemberSchema>;

/** 房主管理视图：成员视图 + 全体成员管理信息（含席位分配所需的成员 ID）。 */
export const hostManagementViewSchema = roomMemberViewSchema.extend({
  members: z.array(managedMemberSchema),
});
export type HostManagementView = z.infer<typeof hostManagementViewSchema>;

/** 匿名展示视图：与公开 BP 视图同形，无任何成员数据与写入口。 */
export const displayViewSchema = bpPublicViewSchema;
export type DisplayView = z.infer<typeof displayViewSchema>;

/** 由成员 ID 推导其所在席位；未占席为 null。 */
function seatTeamOf(state: RoomState, memberId: MemberId) {
  if (state.seats.A === memberId) return "A" as const;
  if (state.seats.B === memberId) return "B" as const;
  return null;
}

/** 投影公开 BP 视图（展示视图同形）。 */
export function projectBpPublicView(state: RoomState, versions: VersionInfo): BpPublicView {
  const step = currentBpStep(state.bp.submissions.length);
  // 仅进行中与已暂停有当前操作位：待开始未开局、已完成无待确认位置；
  // 暂停时保留当前槽位（含高亮与预选展示）。
  const hasActiveSlot = state.bp.status === "running" || state.bp.status === "paused";
  return {
    roomName: state.name,
    teamNames: state.teamNames,
    bpStatus: state.bp.status,
    currentSlotId: hasActiveSlot && step !== null ? step.slotId : null,
    submissions: state.bp.submissions,
    preselect: state.bp.preselect,
    versions,
    revision: state.revision,
  };
}

/** 投影匿名展示视图。 */
export function projectDisplayView(state: RoomState, versions: VersionInfo): DisplayView {
  return projectBpPublicView(state, versions);
}

/**
 * 投影普通成员视图。
 *
 * 查看者必须是房间成员，否则返回 null（由调用方拒绝连接或请求）。
 */
export function projectRoomMemberView(
  state: RoomState,
  viewerMemberId: MemberId,
  versions: VersionInfo,
): RoomMemberView | null {
  const member = state.members.find((candidate) => candidate.memberId === viewerMemberId);
  if (!member) return null;
  return {
    ...projectBpPublicView(state, versions),
    self: {
      memberId: member.memberId,
      nickname: member.nickname,
      isHost: state.hostMemberId === viewerMemberId,
      seatTeam: seatTeamOf(state, viewerMemberId),
    },
    bpVersion: state.bp.version,
  };
}

/**
 * 投影房主管理视图。
 *
 * 查看者必须是房主（且为房间成员），否则返回 null；房主被换下席位后
 * 仍获得本视图，isHost 与 self.seatTeam 分别表达控场身份与席位。
 */
export function projectHostManagementView(
  state: RoomState,
  viewerMemberId: MemberId,
  versions: VersionInfo,
): HostManagementView | null {
  if (viewerMemberId !== state.hostMemberId) return null;
  const memberView = projectRoomMemberView(state, viewerMemberId, versions);
  if (memberView === null) return null;
  return {
    ...memberView,
    members: state.members.map((member) => ({
      memberId: member.memberId,
      nickname: member.nickname,
      isHost: member.memberId === state.hostMemberId,
      seatTeam: seatTeamOf(state, member.memberId),
      online: member.online,
    })),
  };
}
