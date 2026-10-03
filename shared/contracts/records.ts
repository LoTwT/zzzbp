import { z } from "zod";
import { getBpStep, BP_STEP_COUNT, BP_STEP_ORDER } from "../bp/steps";
import { bpActionSchema, bpTeamSchema } from "../bp/steps";
import { agentIdSchema, roomIdSchema, type AgentId } from "../ids";
import { roomNameSchema, teamNamesSchema, type RoomState } from "../room";
import { versionInfoSchema, type VersionInfo } from "./versions";

/**
 * 生命周期与归档记录合同。
 *
 * 产品规则（12 小时空房保留、90 天只读快照、空记录清理）见
 * docs/specs/room-roles.md「房间保留与只读记录」；本文件只定义结构、
 * 时间常量与纯投影。实际计时、到期检查与归档执行由运行时 PR 实现：
 *
 * - 实际成员 WS 连接在期限前回来即取消本次 12 小时计时，下次全员离开
 *   重新计算；展示连接永不影响计时。
 * - 到期检查在 join/read/write 与 Alarm 中共用同一规则，不允许靠延迟
 *   Alarm 延长可写期限。
 * - 快照 90 天期限自转为只读起算，查看不延长。
 */

/** 全员离开后房间的保留期限：12 小时内无实际成员回来则按记录规则处理。 */
export const EMPTY_ROOM_RETENTION_MS = 12 * 60 * 60 * 1000;

/** 只读快照的保留期限：自转为只读起 90 天，查看不延长。 */
export const SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** 房间保留计时（服务端维护，不进入广播视图）。 */
export const roomRetentionSchema = z.object({
  /** 最近一次全员离开时间；当前有实际成员在线时为 null。 */
  lastMemberLeftAt: z.iso.datetime().nullable(),
});
export type RoomRetention = z.infer<typeof roomRetentionSchema>;

/** 全员离开后的空房到期时间：12 小时内无人回来则到期。 */
export function computeEmptyRoomDeadline(lastMemberLeftAt: string): string {
  return new Date(Date.parse(lastMemberLeftAt) + EMPTY_ROOM_RETENTION_MS).toISOString();
}

/** 只读快照到期时间：归档起 90 天，查看不延长。 */
export function computeSnapshotDeadline(archivedAt: string): string {
  return new Date(Date.parse(archivedAt) + SNAPSHOT_RETENTION_MS).toISOString();
}

/** 归档时固定的代理人展示信息；由数据接入层提供。 */
export interface AgentDisplayInfo {
  readonly name: string;
  readonly avatarUrl: string | null;
}
export type AgentDisplayLookup = ReadonlyMap<AgentId, AgentDisplayInfo>;

/**
 * 归档记录中的单条有效操作。
 *
 * 阵营与动作由操作位推导并与操作位一致；代理人名称与头像固定自归档时
 * 的数据，后续数据包更新不改变旧记录的解释。不含预选、成员凭据或
 * 撤回/重开历史。
 */
export const archivedOperationSchema = z.object({
  slotId: z.enum(BP_STEP_ORDER),
  team: bpTeamSchema,
  action: bpActionSchema,
  agentId: agentIdSchema,
  /** 归档时的代理人展示名称。 */
  agentName: z.string().trim().min(1),
  /** 归档时的头像路径；缺失为 null，展示留空。 */
  agentAvatarUrl: z.string().nullable(),
});
export type ArchivedOperation = z.infer<typeof archivedOperationSchema>;

/**
 * 只读归档快照：打开原房间链接经普通 HTTP 读取。
 *
 * 只保留最后一局的当前有效顺序；未完成 BP 保留已提交部分并保持
 * bpCompleted=false。空有效序列的房间不生成快照（直接清理）。
 */
export const archiveSnapshotSchema = z
  .object({
    roomId: roomIdSchema,
    roomName: roomNameSchema,
    teamNames: teamNamesSchema,
    /** 原 BP 完成情况：只表达记录时的状态，不改写 BP 语义。 */
    bpCompleted: z.boolean(),
    /** 最后一局当前有效顺序；至少一条有效提交。 */
    operations: z.array(archivedOperationSchema).min(1),
    /** 归档时的规则与数据版本。 */
    versions: versionInfoSchema,
    /** 转为只读的时刻。 */
    archivedAt: z.iso.datetime(),
    /** 只读保留到期时间：archivedAt + 90 天。 */
    expiresAt: z.iso.datetime(),
  })
  .superRefine((snapshot, ctx) => {
    const seenAgentIds = new Set<string>();
    for (let index = 0; index < snapshot.operations.length; index += 1) {
      const operation = snapshot.operations[index];
      // 操作必须构成权威顺序的前缀。
      if (operation.slotId !== BP_STEP_ORDER[index]) {
        ctx.addIssue({
          code: "custom",
          message: `第 ${index + 1} 条操作应为 ${BP_STEP_ORDER[index]}，收到 ${operation.slotId}`,
          path: ["operations", index, "slotId"],
          input: operation.slotId,
        });
      }
      // 阵营与动作由操作位唯一确定。
      const step = getBpStep(operation.slotId);
      if (operation.team !== step.team || operation.action !== step.action) {
        ctx.addIssue({
          code: "custom",
          message: `操作位 ${operation.slotId} 的阵营/动作与记录不符`,
          path: ["operations", index],
          input: operation,
        });
      }
      // 代理人不得重复。
      if (seenAgentIds.has(operation.agentId)) {
        ctx.addIssue({
          code: "custom",
          message: `第 ${index + 1} 条操作重复使用代理人 ${operation.agentId}`,
          path: ["operations", index, "agentId"],
          input: operation.agentId,
        });
      }
      seenAgentIds.add(operation.agentId);
    }
    // 完成标记与序列长度一致。
    if (snapshot.bpCompleted !== (snapshot.operations.length === BP_STEP_COUNT)) {
      ctx.addIssue({
        code: "custom",
        message: `完成标记与序列长度不符：${snapshot.operations.length} 条操作标记为 ${
          snapshot.bpCompleted ? "已完成" : "未完成"
        }`,
        path: ["bpCompleted"],
        input: snapshot.bpCompleted,
      });
    }
    // 到期时间必须恰为归档时间 + 90 天。
    if (
      Date.parse(snapshot.expiresAt) - Date.parse(snapshot.archivedAt) !==
      SNAPSHOT_RETENTION_MS
    ) {
      ctx.addIssue({
        code: "custom",
        message: "到期时间必须为归档时间加 90 天",
        path: ["expiresAt"],
        input: snapshot.expiresAt,
      });
    }
  });
export type ArchiveSnapshot = z.infer<typeof archiveSnapshotSchema>;

/**
 * 由归档前的房间状态生成只读快照。
 *
 * 当前局没有任何有效提交时返回 null（空记录房间按规则直接清理）。
 * 代理人展示信息缺失视为数据错误并抛出，避免生成不完整记录。
 */
export function projectArchiveSnapshot(input: {
  readonly state: RoomState;
  readonly agentDisplay: AgentDisplayLookup;
  readonly versions: VersionInfo;
  readonly archivedAt: string;
}): ArchiveSnapshot | null {
  const { state, agentDisplay, versions, archivedAt } = input;
  if (state.bp.submissions.length === 0) return null;

  const operations = state.bp.submissions.map((submission) => {
    const step = getBpStep(submission.slotId);
    const display = agentDisplay.get(submission.agentId);
    if (!display) {
      throw new Error(`缺少代理人 ${submission.agentId} 的展示信息，无法生成归档快照`);
    }
    return {
      slotId: submission.slotId,
      team: step.team,
      action: step.action,
      agentId: submission.agentId,
      agentName: display.name,
      agentAvatarUrl: display.avatarUrl,
    };
  });

  return archiveSnapshotSchema.parse({
    roomId: state.roomId,
    roomName: state.name,
    teamNames: state.teamNames,
    bpCompleted: state.bp.status === "completed",
    operations,
    versions,
    archivedAt,
    expiresAt: computeSnapshotDeadline(archivedAt),
  });
}
