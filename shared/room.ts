import { z } from "zod";
import type { BpTeam } from "./bp/steps";
import { bpProgressSchema } from "./bp/state";
import { memberIdSchema, roomIdSchema } from "./ids";

/*
 * 展示名称的字段约束：trim 后按 Unicode 码点计数（Zod 4 的长度检查原生
 * 按码点而非 UTF-16 单元计数），长度上限为已确认的常规选择：
 * 房间名 80、队伍名 32、昵称 24。
 */

/** 房间名（赛事名）：trim 后 1 到 80 码点。 */
export const roomNameSchema = z.string().trim().min(1).max(80);

/**
 * 队伍名（存储态）：trim 后 0 到 32 码点。
 * 房间初始未填写的队伍名允许为空字符串；填写与修改走 teamNameInputSchema。
 */
export const teamNameSchema = z.string().trim().max(32);

/** 队伍名（填写/修改输入）：trim 后 1 到 32 码点，不允许为空。 */
export const teamNameInputSchema = z.string().trim().min(1).max(32);

/** 昵称：trim 后 1 到 24 码点；仅用于展示，不承载身份。 */
export const nicknameSchema = z.string().trim().min(1).max(24);

/**
 * 房间生命周期：live 为可操作房间，archived 为到期归档后的只读记录。
 *
 * 生命周期表达房间的存续阶段，与 BP 四状态（bpStatusSchema）分离：
 * 归档不把未完成的 BP 强制改为已完成，到期前已完成的房间也保持原状态。
 */
export const roomLifecycleSchema = z.enum(["live", "archived"]);
export type RoomLifecycle = z.infer<typeof roomLifecycleSchema>;

/**
 * 房间成员。
 *
 * 角色（房主/选手/观众）由 hostMemberId 与席位派生，不单独存储；
 * `online` 表示该成员在当前房间至少有一个页面保持连接。
 */
export const roomMemberSchema = z.object({
  memberId: memberIdSchema,
  nickname: nicknameSchema,
  online: z.boolean(),
});
export type RoomMember = z.infer<typeof roomMemberSchema>;

/** 双方队伍名；A/B 沿用 BP 阵营定义。 */
export const teamNamesSchema = z.object({
  A: teamNameSchema,
  B: teamNameSchema,
} satisfies Record<BpTeam, z.ZodType>);
export type TeamNames = z.infer<typeof teamNamesSchema>;

/**
 * A/B 席位：值为占据席位的成员 ID，空位为 null。
 * 同一成员最多占一个席位（见 roomStateSchema 的校验）。
 */
export const seatAssignmentSchema = z.object({
  A: memberIdSchema.nullable(),
  B: memberIdSchema.nullable(),
} satisfies Record<BpTeam, z.ZodType>);
export type SeatAssignment = z.infer<typeof seatAssignmentSchema>;

/**
 * 房间核心状态。
 *
 * 房主身份（hostMemberId）与席位（seats）分开管理：房主可以兼任选手或
 * 不占席位，席位被替换不移交房主权限；成员在线信息与 BP 进度同处一个
 * 快照。持久化由后续 PR 落在房间 Durable Object 的 SQLite 上。
 *
 * `revision` 与 `bp.version` 职责分开：revision 随任何可见状态变化递增
 * （含成员在线变化），用于公开视图同步；bp.version 只随 BP 流程与席位
 * 权限变化递增，用于命令过期判断，两者均不因重开重置。
 */
export const roomStateSchema = z
  .object({
    roomId: roomIdSchema,
    name: roomNameSchema,
    lifecycle: roomLifecycleSchema,
    hostMemberId: memberIdSchema,
    teamNames: teamNamesSchema,
    seats: seatAssignmentSchema,
    members: z.array(roomMemberSchema),
    /** 公开视图 revision：随任何可见状态变化单调递增。 */
    revision: z.number().int().nonnegative(),
    bp: bpProgressSchema,
  })
  .superRefine((room, ctx) => {
    const memberIds = new Set(room.members.map((member) => member.memberId));

    if (room.members.length !== memberIds.size) {
      ctx.addIssue({
        code: "custom",
        message: "成员 ID 重复",
        path: ["members"],
        input: room.members,
      });
    }
    if (!memberIds.has(room.hostMemberId)) {
      ctx.addIssue({
        code: "custom",
        message: "房主必须是房间成员",
        path: ["hostMemberId"],
        input: room.hostMemberId,
      });
    }
    for (const team of ["A", "B"] as const) {
      const seatMemberId = room.seats[team];
      if (seatMemberId !== null && !memberIds.has(seatMemberId)) {
        ctx.addIssue({
          code: "custom",
          message: "席位成员必须是房间成员",
          path: ["seats", team],
          input: seatMemberId,
        });
      }
    }
    if (room.seats.A !== null && room.seats.A === room.seats.B) {
      ctx.addIssue({
        code: "custom",
        message: "同一成员最多占一个席位",
        path: ["seats"],
        input: room.seats,
      });
    }
  });
export type RoomState = z.infer<typeof roomStateSchema>;
