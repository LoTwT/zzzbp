import type { AgentId } from "../ids";
import { getBpStep, type BpTeam } from "./steps";
import type { BpSubmission } from "./state";

/**
 * 代理人目录的最小接口。
 *
 * BP 规则只依赖「本场名单包含哪些代理人」；真实名单与头像、属性等展示
 * 数据由后续数据接入 PR 提供，测试使用合成名单。名单内 ID 应唯一且稳定。
 */
export interface AgentCatalog {
  /** 本场名单内的全部代理人 ID。 */
  readonly agentIds: readonly AgentId[];
}

/** 代理人在共用互斥池中的状态。 */
export type AgentPoolStatus = "available" | "banned" | "picked";

/**
 * 由当前有效序列推导的互斥池占用情况。
 *
 * 禁用对双方生效，选用与禁用互斥：任意一方禁用或选定某代理人后，双方都
 * 不能再对其禁用或选用（依据 docs/specs/single-game-bp.md「代理人可用性」，
 * 含「已选代理人不再允许禁用」）。
 */
export interface AgentPoolUsage {
  /** 已被禁用的代理人。 */
  readonly bannedAgentIds: ReadonlySet<AgentId>;
  /** 已被选用的代理人（双方合并）。 */
  readonly pickedAgentIds: ReadonlySet<AgentId>;
  /** 各方按选用顺序已确认的代理人。 */
  readonly pickedByTeam: Readonly<Record<BpTeam, readonly AgentId[]>>;
}

/**
 * 汇总当前有效序列对互斥池的占用。
 *
 * 输入应是服务端已确认的有效序列；本函数只做汇总，不校验序列本身的
 * 合法性（提交合法性由状态转换层负责）。
 */
export function computeAgentPoolUsage(submissions: readonly BpSubmission[]): AgentPoolUsage {
  const bannedAgentIds = new Set<AgentId>();
  const pickedAgentIds = new Set<AgentId>();
  const pickedByTeam: Record<BpTeam, AgentId[]> = { A: [], B: [] };

  for (const submission of submissions) {
    const { action, team } = getBpStep(submission.slotId);
    if (action === "ban") {
      bannedAgentIds.add(submission.agentId);
    } else {
      pickedAgentIds.add(submission.agentId);
      pickedByTeam[team].push(submission.agentId);
    }
  }

  return { bannedAgentIds, pickedAgentIds, pickedByTeam };
}

/**
 * 查询单个代理人的互斥池状态。
 *
 * 已禁用或已选用的代理人对任何一方的任何动作都不可再用；未出现在有效
 * 序列中的代理人为可选。可用性与名单成员资格是两回事：是否属于本场
 * 名单由 AgentCatalog 判断。
 */
export function getAgentPoolStatus(usage: AgentPoolUsage, agentId: AgentId): AgentPoolStatus {
  if (usage.bannedAgentIds.has(agentId)) return "banned";
  if (usage.pickedAgentIds.has(agentId)) return "picked";
  return "available";
}

/**
 * 计算整场名单的互斥池状态视图：名单内每个代理人在当前序列下的状态。
 * 代理人池与两侧禁选区的展示均可由此派生。
 */
export function computeAgentPoolStatuses(
  catalog: AgentCatalog,
  submissions: readonly BpSubmission[],
): ReadonlyMap<AgentId, AgentPoolStatus> {
  const usage = computeAgentPoolUsage(submissions);
  const statuses = new Map<AgentId, AgentPoolStatus>();
  for (const agentId of catalog.agentIds) {
    statuses.set(agentId, getAgentPoolStatus(usage, agentId));
  }
  return statuses;
}
