import { classificationIconImageUrl } from "../../shared/agents/assets";
import type { AgentCatalogData, AgentEntry } from "../../shared/agents/schema";
import type { AgentId } from "../../shared/ids";
import { legacyAgentImage, squareAgentImage, type AgentImageDisplay } from "./agent-image";

/**
 * 房间代理人目录的展示模型。
 *
 * 名单永远来自房间创建时固定的 `/catalog` 快照（room_catalog 持久行），
 * 不导入当前构建目录取代房间名单（见 docs/architecture.md「房间持久化
 * 与固定目录」）。本模块只做一次性派生：ID → 条目的映射、图片展示解释
 * 与分类表，供代理人池、禁选槽位与控制面板共用。
 */

/**
 * 头像展示所需的最小代理人信息。
 *
 * 只读记录页的展示信息来自归档快照（归档时固定，无分类等实时目录
 * 字段）；RoomAgentDisplay 是本接口的结构超集，头像组件与槽位组件按
 * 最小接口声明依赖，两个数据来源共用同一套展示实现。
 */
export interface AgentDisplayBase {
  readonly id: AgentId;
  /** 官方中文名称（简短名）。 */
  readonly name: string;
  /** 图片展示信息；无图片资源时为 null，展示走占位兜底。 */
  readonly image: AgentImageDisplay | null;
}

/** 单个代理人的展示信息（含筛选所需的分类 ID，是 AgentDisplayBase 的结构超集）。 */
export interface RoomAgentDisplay extends AgentDisplayBase {
  /** 官方中文全名；来源未记录时为 null。 */
  readonly fullName: string | null;
  /** 数据包记录的原始头像路径；缺失为 null（旧目录图片解释见 image）。 */
  readonly avatarPath: string | null;
  /** 属性分类 ID（共享筛选维度，见 shared/agents/filter.ts）。 */
  readonly elementId: string;
  /** 特性分类 ID。 */
  readonly specialtyId: string;
  readonly element: RoomClassificationDisplay;
  readonly specialty: RoomClassificationDisplay;
}

/**
 * 分类（属性/特性）的展示信息。
 *
 * iconUrl 来自房间快照携带的图片资源引用（本站同源静态资源）；旧目录
 * 快照没有图标资源信息时为 null，筛选按钮回退为名称文字。
 */
export interface RoomClassificationDisplay {
  readonly id: string;
  /** 官方中文名称。 */
  readonly name: string;
  /** 分类图标 URL；旧目录快照缺图标资源时为 null。 */
  readonly iconUrl: string | null;
}

/** 目录展示模型：条目保持来源 ID 升序的权威排列。 */
export interface RoomCatalogModel {
  readonly entries: readonly RoomAgentDisplay[];
  readonly byId: ReadonlyMap<AgentId, RoomAgentDisplay>;
  readonly elements: readonly RoomClassificationDisplay[];
  readonly specialties: readonly RoomClassificationDisplay[];
}

function toDisplay(
  entry: AgentEntry,
  revision: string | null,
  elements: Map<string, RoomClassificationDisplay>,
  specialties: Map<string, RoomClassificationDisplay>,
): RoomAgentDisplay {
  const element = elements.get(entry.elementId);
  const specialty = specialties.get(entry.specialtyId);
  if (element === undefined || specialty === undefined) {
    // 目录 schema 已校验分类引用有效，这里只做防御性兜底。
    throw new Error(`代理人 ${entry.id} 的分类引用无效`);
  }
  // 图片解释：新目录走资源修订内的方图；旧目录缺引用时按原始
  // avatarPath 派生旧圆图 URL（映射到本地副本），两者不互相混用。
  const image =
    revision !== null && entry.iconAsset !== undefined
      ? squareAgentImage(revision, entry.iconAsset.icon, entry.iconAsset.crop)
      : legacyAgentImage(entry.avatarPath);
  return {
    id: entry.id,
    name: entry.name,
    fullName: entry.fullName,
    image,
    avatarPath: entry.avatarPath,
    elementId: entry.elementId,
    specialtyId: entry.specialtyId,
    element,
    specialty,
  };
}

function toClassificationDisplay(
  entry: { id: string; name: string; iconAsset?: string },
  revision: string | null,
): RoomClassificationDisplay {
  const iconUrl =
    revision !== null && entry.iconAsset !== undefined
      ? classificationIconImageUrl(revision, entry.iconAsset)
      : null;
  return { id: entry.id, name: entry.name, iconUrl };
}

/** 由房间目录快照构建展示模型；构建只依赖已通过 schema 校验的数据。 */
export function toRoomCatalogModel(data: AgentCatalogData): RoomCatalogModel {
  const revision = data.imageAssets?.revision ?? null;
  const elements = new Map(
    data.elements.map((entry) => [entry.id, toClassificationDisplay(entry, revision)]),
  );
  const specialties = new Map(
    data.specialties.map((entry) => [entry.id, toClassificationDisplay(entry, revision)]),
  );
  const entries = data.agents.map((entry) => toDisplay(entry, revision, elements, specialties));
  return {
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    elements: data.elements.map((entry) => toClassificationDisplay(entry, revision)),
    specialties: data.specialties.map((entry) => toClassificationDisplay(entry, revision)),
  };
}
