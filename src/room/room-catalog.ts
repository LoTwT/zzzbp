import { toAgentImageUrl } from "../../shared/agents/catalog";
import type { AgentCatalogData, AgentClassification, AgentEntry } from "../../shared/agents/schema";
import type { AgentId } from "../../shared/ids";

/**
 * 房间代理人目录的展示模型。
 *
 * 名单永远来自房间创建时固定的 `/catalog` 快照（room_catalog 持久行），
 * 不导入当前构建目录取代房间名单（见 docs/architecture.md「房间持久化
 * 与固定目录」）。本模块只做一次性派生：ID → 条目的映射、头像 URL 派生
 * 与分类表，供代理人池、禁选槽位与控制面板共用。
 */

/** 单个代理人的展示信息（含筛选所需的分类 ID，是 AgentEntry 的结构超集）。 */
export interface RoomAgentDisplay {
  readonly id: AgentId;
  /** 官方中文名称（简短名）。 */
  readonly name: string;
  /** 官方中文全名；来源未记录时为 null。 */
  readonly fullName: string | null;
  /** 由来源路径派生的头像 URL；缺头像为 null，展示走占位后备。 */
  readonly avatarUrl: string | null;
  /** 数据包记录的原始头像路径；缺失为 null（展示派生见 avatarUrl）。 */
  readonly avatarPath: string | null;
  /** 属性分类 ID（共享筛选维度，见 shared/agents/filter.ts）。 */
  readonly elementId: string;
  /** 特性分类 ID。 */
  readonly specialtyId: string;
  readonly element: AgentClassification;
  readonly specialty: AgentClassification;
}

/** 目录展示模型：条目保持来源 ID 升序的权威排列。 */
export interface RoomCatalogModel {
  readonly entries: readonly RoomAgentDisplay[];
  readonly byId: ReadonlyMap<AgentId, RoomAgentDisplay>;
  readonly elements: readonly AgentClassification[];
  readonly specialties: readonly AgentClassification[];
}

function toDisplay(
  entry: AgentEntry,
  elements: Map<string, AgentClassification>,
  specialties: Map<string, AgentClassification>,
): RoomAgentDisplay {
  const element = elements.get(entry.elementId);
  const specialty = specialties.get(entry.specialtyId);
  if (element === undefined || specialty === undefined) {
    // 目录 schema 已校验分类引用有效，这里只做防御性兜底。
    throw new Error(`代理人 ${entry.id} 的分类引用无效`);
  }
  return {
    id: entry.id,
    name: entry.name,
    fullName: entry.fullName,
    avatarUrl: toAgentImageUrl(entry.avatarPath),
    avatarPath: entry.avatarPath,
    elementId: entry.elementId,
    specialtyId: entry.specialtyId,
    element,
    specialty,
  };
}

/** 由房间目录快照构建展示模型；构建只依赖已通过 schema 校验的数据。 */
export function toRoomCatalogModel(data: AgentCatalogData): RoomCatalogModel {
  const elements = new Map(data.elements.map((entry) => [entry.id, entry]));
  const specialties = new Map(data.specialties.map((entry) => [entry.id, entry]));
  const entries = data.agents.map((entry) => toDisplay(entry, elements, specialties));
  return {
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    elements: data.elements,
    specialties: data.specialties,
  };
}
