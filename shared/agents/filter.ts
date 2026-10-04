import type { AgentEntry } from "./schema";

/**
 * 代理人池的纯数据搜索与筛选。
 *
 * 匹配规则依据 docs/specs/room-layout.md「代理人池搜索与筛选」：
 *
 * - 仅匹配代理人官方名称（简短名与数据包提供的官方全名 fullName），
 *   包含匹配，不扩展社区昵称、别名、拼音或首字母；查询文本 trim 后
 *   为空则不限制。
 * - 属性与特性两个维度内多选满足任意一项即可（OR）；不同维度与名称
 *   搜索之间需同时满足（AND）；未设置的条件不限制结果。
 * - 输入应包含全部状态的代理人；本函数不感知禁用/选用等业务状态，
 *   是否参与点击由调用方依据互斥池状态另行判断。
 * - 结果保持输入顺序；目录数据的输入顺序即来源 ID 数值升序的
 *   固定排列（见 ./schema.ts 的校验不变量），本函数不重排。
 */

/** 代理人池查询条件；全部字段均可留空表示不限制。 */
export interface AgentPoolQuery {
  /** 名称搜索文本；trim 后为空（含仅空白）则不限制。 */
  readonly name: string;
  /** 属性分类 ID 多选；空数组不限制。 */
  readonly elementIds: readonly string[];
  /** 特性分类 ID 多选；空数组不限制。 */
  readonly specialtyIds: readonly string[];
}

/** 空查询：不做任何限制。 */
export const EMPTY_AGENT_POOL_QUERY: AgentPoolQuery = {
  name: "",
  elementIds: [],
  specialtyIds: [],
};

/** 按查询条件筛选代理人条目，保持输入顺序。支持 AgentEntry 的结构超集（展示模型）。 */
export function filterAgentEntries<T extends AgentEntry>(
  agents: readonly T[],
  query: AgentPoolQuery,
): readonly T[] {
  const name = query.name.trim();
  const elementIds = query.elementIds.length > 0 ? new Set(query.elementIds) : null;
  const specialtyIds = query.specialtyIds.length > 0 ? new Set(query.specialtyIds) : null;

  return agents.filter((entry) => {
    if (
      name !== "" &&
      !entry.name.includes(name) &&
      !(entry.fullName !== null && entry.fullName.includes(name))
    ) {
      return false;
    }
    if (elementIds !== null && !elementIds.has(entry.elementId)) return false;
    if (specialtyIds !== null && !specialtyIds.has(entry.specialtyId)) return false;
    return true;
  });
}
