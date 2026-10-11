import type { AgentCatalog } from "../bp/agents";
import type { AgentDisplayInfo, AgentDisplayLookup } from "../contracts/records";
import type { AgentId } from "../ids";
import { agentSquareImageUrl, localizeLegacyAgentImageUrl, toAgentImageUrl } from "./assets";
import catalogJson from "./catalog.json";
import { agentCatalogSchema, type AgentCatalogData, type AgentEntry } from "./schema";

// toAgentImageUrl 的实现随图片 URL 布局统一维护在 ./assets.ts（Node 原生
// 类型剥离可执行，供导入/生成脚本直接复用）；此处再导出保持既有导入
// 路径稳定，不产生第二份转换实现。
export { toAgentImageUrl } from "./assets";

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

/**
 * 当前部署已收录旧圆图本地副本的文件名集合（目录产物内嵌的清单摘要，
 * 由图片资源清单生成并经测试对齐）。legacy 副本跨修订只增不改，当前
 * 构建的摘要是历史摘要的超集，因此旧目录快照与旧归档也按本集合判断
 * 收录情况（详见 shared/agents/assets.ts 的 localizeLegacyAgentImageUrl）。
 */
export const localLegacyCircleFileNames: ReadonlySet<string> = new Set(
  agentCatalogData.imageAssets?.legacyCircleFileNames ?? [],
);

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
 * 由目录派生归档展示信息表：代理人 ID → 官方名称与头像图片 URL。
 *
 * 供 projectArchiveSnapshot（shared/contracts/records.ts）在归档时固定
 * 每步的展示信息。带图片资源引用的条目保存稳定的本地方图路径（含宽幅
 * 裁切位置，归档快照自足解释）；旧目录条目按原始 avatarPath 派生旧圆图
 * URL，仅已收录者映射到同源本地副本。条目同时缺图片资源引用和
 * avatarPath 时为 null，展示走占位，不影响其身份与禁选结果
 * （见 docs/specs/room-layout.md「代理人头像」）。
 */
export function toAgentDisplayLookup(data: AgentCatalogData): AgentDisplayLookup {
  const revision = data.imageAssets?.revision ?? null;
  const lookup = new Map<AgentId, AgentDisplayInfo>();
  for (const entry of data.agents) {
    lookup.set(entry.id, {
      name: entry.name,
      avatarUrl: toArchiveImageUrl(revision, entry),
      avatarCrop: revision !== null && entry.iconAsset !== undefined ? entry.iconAsset.crop : null,
    });
  }
  return lookup;
}

/**
 * 归档保存的稳定头像 URL：新条目取资源修订内的本地方图路径；旧条目按
 * 原始 avatarPath 派生旧圆图 URL，已收录者映射到同源本地副本，未收录
 * 者保留原 URL（旧圆图不替换为新方图，归档不保存当前机器地址）。
 */
function toArchiveImageUrl(revision: string | null, entry: AgentEntry): string | null {
  if (revision !== null && entry.iconAsset !== undefined) {
    return agentSquareImageUrl(revision, entry.iconAsset.icon);
  }
  const remote = toAgentImageUrl(entry.avatarPath);
  if (remote === null) return null;
  return localizeLegacyAgentImageUrl(remote, localLegacyCircleFileNames);
}
