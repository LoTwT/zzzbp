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

/**
 * 上游已确认的图片资源固定前缀。
 *
 * 依据 fairy 上游 nanoka 来源规格（docs/specs/nanoka/source.md
 * 「已确认的图片地址规则」，2026-09-14 实测）：非空 `.png` 来源图片路径
 * 去掉首尾空白与原目录、扩展名改 `.webp` 后拼接该前缀。
 */
const AGENT_IMAGE_BASE_URL = "https://static.nanoka.cc/assets/zzz/";

/**
 * 由数据包记录的来源图片路径派生可加载的图片 URL。
 *
 * 这是上游文档记录的消费时转换，不是按图标编号猜文件名：原始路径保留
 * 在目录产物中，完整 URL 只在消费边界派生。归档映射与后续界面共用本
 * 函数，不在别处重复实现转换。
 *
 * 仅适用于非空、以 `.png` 结尾的来源图片路径；`live2_d` 等无图片扩展名
 * 的动画资源标识不适用。无来源路径或输入不满足规则时返回 null，不制造
 * 图片地址。浏览器与部署环境的实际可达性（含防盗链行为）由界面 PR
 * 验证，本函数不做网络请求。
 */
export function toAgentImageUrl(sourcePath: string | null): string | null {
  if (sourcePath === null) return null;
  const fileName = sourcePath.trim().split("/").pop() ?? "";
  if (!/^[^/]+\.png$/i.test(fileName)) return null;
  return `${AGENT_IMAGE_BASE_URL}${fileName.replace(/\.png$/i, ".webp")}`;
}

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
 * 供 projectArchiveSnapshot（shared/contracts/records.ts）在归档时
 * 固定每步的展示信息；头像 URL 由记录的来源路径经 toAgentImageUrl
 * 派生，缺头像代理人为 null，展示留空，不影响其身份与禁选结果
 * （见 docs/specs/room-layout.md「代理人头像」）。
 */
export function toAgentDisplayLookup(data: AgentCatalogData): AgentDisplayLookup {
  const lookup = new Map<AgentId, AgentDisplayInfo>();
  for (const entry of data.agents) {
    lookup.set(entry.id, { name: entry.name, avatarUrl: toAgentImageUrl(entry.avatarPath) });
  }
  return lookup;
}
