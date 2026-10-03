import { z } from "zod";
import { agentIdSchema } from "../ids";
import { BP_STEP_COUNT, BP_STEP_ORDER, bpSlotIdSchema } from "./steps";

/**
 * BP 的四种状态：waiting 待开始、running 进行中、paused 已暂停、completed 已完成。
 *
 * 依据 docs/specs/single-game-bp.md「房间状态与完成」；与房间生命周期
 * （live/archived，见 shared/room.ts）是两个独立维度。
 */
export const bpStatusSchema = z.enum(["waiting", "running", "paused", "completed"]);
export type BpStatus = z.infer<typeof bpStatusSchema>;

/**
 * 一条已确认的禁/选提交。
 *
 * 阵营与动作由操作位 ID 唯一确定，不单独冗余存储；只读记录页所需的
 * 「所属队伍、禁用或选用类型」均从 `slotId` 推导。
 */
export const bpSubmissionSchema = z.object({
  slotId: bpSlotIdSchema,
  agentId: agentIdSchema,
});
export type BpSubmission = z.infer<typeof bpSubmissionSchema>;

/**
 * BP 进度的核心状态。
 *
 * - `submissions`：当前有效序列，必须是权威顺序的前缀；提交按既定流程
 *   逐步确认，撤回从末尾移除，重开清空。同一代理人不得在序列中重复出现
 *   （禁用与选用共用互斥池）。
 * - `preselect`：当前操作位对全房间公开的预选；未预选为 null，槽位推进
 *   或重开时清空，暂停期间保留。已在本局中被禁用或选用的代理人不能成为
 *   预选（名单成员资格由规则入口校验，不在 schema 层检查）。
 * - `version`：单调递增的 BP 版本，用于命令去重与过期提交判断；预选、
 *   提交、控制命令与席位权限变化都会使其失效，重开不重置。递增时机
 *   由状态转换层保证。
 */
export const bpProgressSchema = z
  .object({
    status: bpStatusSchema,
    submissions: z.array(bpSubmissionSchema).max(BP_STEP_COUNT),
    preselect: agentIdSchema.nullable(),
    version: z.number().int().nonnegative(),
  })
  .superRefine((progress, ctx) => {
    const { status, submissions, preselect } = progress;
    const confirmed = submissions.length;

    // 有效序列必须是权威顺序的前缀。
    for (let index = 0; index < confirmed; index += 1) {
      const expected = BP_STEP_ORDER[index];
      if (submissions[index].slotId !== expected) {
        ctx.addIssue({
          code: "custom",
          message: `第 ${index + 1} 条提交的操作位应为 ${expected}，收到 ${submissions[index].slotId}`,
          path: ["submissions", index, "slotId"],
          input: submissions[index].slotId,
        });
      }
    }

    // 有效提交不得重复使用同一代理人。
    const usedAgentIds = new Set<string>();
    for (let index = 0; index < confirmed; index += 1) {
      const submission = submissions[index];
      if (usedAgentIds.has(submission.agentId)) {
        ctx.addIssue({
          code: "custom",
          message: `第 ${index + 1} 条提交重复使用代理人 ${submission.agentId}`,
          path: ["submissions", index, "agentId"],
          input: submission.agentId,
        });
      }
      usedAgentIds.add(submission.agentId);
    }

    // 预选不能是已被禁用或选用的代理人。
    if (preselect !== null && usedAgentIds.has(preselect)) {
      ctx.addIssue({
        code: "custom",
        message: `预选的代理人 ${preselect} 已在本局中使用`,
        path: ["preselect"],
        input: preselect,
      });
    }

    if (status === "waiting") {
      if (confirmed > 0) {
        ctx.addIssue({
          code: "custom",
          message: "待开始状态不允许存在已确认提交",
          path: ["submissions"],
          input: submissions,
        });
      }
      if (preselect !== null) {
        ctx.addIssue({
          code: "custom",
          message: "待开始状态不允许存在预选",
          path: ["preselect"],
          input: preselect,
        });
      }
    } else if (status === "completed") {
      if (confirmed !== BP_STEP_COUNT) {
        ctx.addIssue({
          code: "custom",
          message: `已完成状态应恰有 ${BP_STEP_COUNT} 条确认提交，收到 ${confirmed} 条`,
          path: ["submissions"],
          input: submissions,
        });
      }
      if (preselect !== null) {
        ctx.addIssue({
          code: "custom",
          message: "已完成状态不允许存在预选",
          path: ["preselect"],
          input: preselect,
        });
      }
    } else if (confirmed >= BP_STEP_COUNT) {
      // running / paused：最后一个位置提交成功后立即转为 completed。
      ctx.addIssue({
        code: "custom",
        message: `进行中或已暂停状态的确认提交数应少于 ${BP_STEP_COUNT}，收到 ${confirmed} 条`,
        path: ["submissions"],
        input: submissions,
      });
    }
  });
export type BpProgress = z.infer<typeof bpProgressSchema>;
