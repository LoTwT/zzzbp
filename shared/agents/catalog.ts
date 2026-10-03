import type { AgentCatalog } from "../bp/agents";
import type { AgentDisplayInfo, AgentDisplayLookup } from "../contracts/records";
import type { AgentId } from "../ids";
import catalogJson from "./catalog.json";
import { agentCatalogSchema, type AgentCatalogData, type AgentEntry } from "./schema";

/**
 * 代理人目录的运行时入口。
 *
 * 权威数据是构建时生成并提交的只读产物 shared/agents/catalog.json
 * （生成脚本 scripts/generate-agent-catalog.ts，来源与字段映射见
 * docs/specs/agent-data.md）。本模块在加载时用共享 schema 完整校验，
 * 产物非法则立即失败，不做降级或部分加载。
 *
 * 规则层的 AgentCatalog（名单成员资格）与归档展示的
 * AgentDisplayLookup 都从同一份校验后的目录派生，保证两端一致；
 * 前端展示与筛选同理（见 ./filter.ts）。
 */

/** 校验并固定的代理人目录数据。 */
export const agentCatalogData: AgentCatalogData = agentCatalogSchema.parse(catalogJson);

/** 当前目录的代理人数据版本；随视图与归档记录（VersionInfo）携带。 */
export const agentDataVersion: string = agentCatalogData.agentDataVersion;

/** 查询单个代理人的目录条目；不在名单内时返回 null。 */
export function getAgentEntry(data: AgentCatalogData, agentId: AgentId): AgentEntry | null {
  for (const entry of data.agents) {
    if (entry.id === agentId) return entry;
  }
  return null;
}

/**
 * 由目录派生规则层的 AgentCatalog：本场名单包含的代理人 ID。
 *
 * ID 顺序即目录的权威排列（来源 ID 数值升序），供 BP 互斥池与
 * 名单成员资格检查使用（见 shared/bp/agents.ts）。
 */
export function toAgentCatalog(data: AgentCatalogData): AgentCatalog {
  return { agentIds: data.agents.map((entry) => entry.id) };
}

/**
 * 由目录派生归档展示信息表：代理人 ID → 官方名称与头像路径。
 *
 * 供 projectArchiveSnapshot（shared/contracts/records.ts）在归档时
 * 固定每步的展示信息；缺头像代理人的 avatarUrl 为 null，展示留空，
 * 不影响其身份与禁选结果（见 docs/specs/room-layout.md「代理人头像」）。
 */
export function toAgentDisplayLookup(data: AgentCatalogData): AgentDisplayLookup {
  const lookup = new Map<AgentId, AgentDisplayInfo>();
  for (const entry of data.agents) {
    lookup.set(entry.id, { name: entry.name, avatarUrl: entry.avatarPath });
  }
  return lookup;
}
