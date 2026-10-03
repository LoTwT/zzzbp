import { z } from "zod";

/*
 * 代理人目录数据的共享 schema。
 *
 * 本文件是生成脚本（scripts/generate-agent-catalog.ts，Node 类型剥离直接
 * 运行）与运行时的共同依赖，因此只允许导入 npm 包（zod），不引入仓库内
 * 其他相对路径模块，保证 Node 可以按 .ts 扩展名解析执行。
 *
 * 数据事实与字段映射依据见 docs/specs/agent-data.md；产品展示规则（排列、
 * 搜索筛选、缺头像处理）见 docs/specs/room-layout.md。
 */

/**
 * 来源 ID：上游数值 ID 的规范十进制字符串（无前导零、无符号、无小数点）。
 *
 * 上游 `data.id` 是 JSON 数值（如 1011），本站以规范字符串形式保存，
 * 与规则层 AgentId（shared/ids.ts 的 trim 后 1..100 码点字符串）兼容；
 * 数值语义用于排序（ID 升序），见下方 superRefine。
 */
export const agentSourceIdSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
export type AgentSourceId = z.infer<typeof agentSourceIdSchema>;

/** 分类 ID（属性/特性）：同为来源数值 ID 的规范十进制字符串。 */
export const agentClassificationIdSchema = agentSourceIdSchema;
export type AgentClassificationId = z.infer<typeof agentClassificationIdSchema>;

/**
 * 官方名称：trim 后 1 到 50 个 Unicode 码点。
 *
 * 取自数据包本地化详情的原值（简短名 `name` 与全名
 * `partnerInfo.fullName`）；约束为防御性上限，空名称在生成与
 * 加载时都会失败，不允许静默丢弃条目。
 */
export const officialAgentNameSchema = z.string().trim().min(1).max(50);

/**
 * 资源路径：数据包已记录的原样路径字符串，缺失为 null。
 *
 * 不根据图标编号拼接或推测补写；缺头像不影响 ID、名称与筛选资格
 * （见 docs/specs/room-layout.md「代理人头像」）。
 */
export const agentResourcePathSchema = z.string().min(1).nullable();

/** 属性或特性分类条目：筛选按钮与悬停名称由此派生。 */
export const agentClassificationSchema = z.object({
  /** 来源分类数值 ID 的规范十进制字符串。 */
  id: agentClassificationIdSchema,
  /** 数据包记录的官方中文名称（如「电属性」「击破」）。 */
  name: officialAgentNameSchema,
  /**
   * 分类图标的资源路径。当前数据包（@randomplay/data 0.2.1）未记录
   * 属性/特性图标字段，恒为 null；上游补齐后随数据更新接入。
   */
  iconPath: agentResourcePathSchema,
});
export type AgentClassification = z.infer<typeof agentClassificationSchema>;

/** 代理人条目：目录的最小展示与筛选单元。 */
export const agentEntrySchema = z.object({
  /** 稳定 ID：上游数值 ID 的规范十进制字符串。 */
  id: agentSourceIdSchema,
  /** 官方中文名称（简短展示名）。 */
  name: officialAgentNameSchema,
  /**
   * 官方中文全名：上游本地化详情 `partnerInfo.fullName` 的原值（如
   * 「星见雅」对应简短名「雅」）；来源未记录时为 null，不推测或合并
   * 变体身份。与简短名同为官方名称，均参与搜索包含匹配。
   */
  fullName: officialAgentNameSchema.nullable(),
  /** 头像路径；数据包未记录时为 null，展示留空。 */
  avatarPath: agentResourcePathSchema,
  /** 属性分类 ID（引用 catalog.elements）。 */
  elementId: agentClassificationIdSchema,
  /** 特性分类 ID（引用 catalog.specialties）。 */
  specialtyId: agentClassificationIdSchema,
});
export type AgentEntry = z.infer<typeof agentEntrySchema>;

/**
 * 目录来源记录：固定版本的可追溯证据，随产物提交。
 *
 * `packageVersion` 必须与 `agentDataVersion` 一致（见 superRefine），
 * 保证目录版本单一来源。
 */
export const agentCatalogSourceSchema = z.object({
  /** npm 包名（发布自 github.com/LoTwT/fairy 的 packages/data）。 */
  package: z.string().trim().min(1),
  /** 包版本，与 agentDataVersion 一致。 */
  packageVersion: z.string().trim().min(1).max(50),
  /** 上游声明的游戏数据版本（如 "3.1"）。 */
  gameVersion: z.string().trim().min(1).max(50),
  /** 上游来源数据集标识（如 "nanoka-zzz"）。 */
  sourceId: z.string().trim().min(1).max(50),
  /** 上游数据快照的内容哈希（如 "sha256:..."）。 */
  snapshotId: z.string().trim().min(1).max(100),
});
export type AgentCatalogSource = z.infer<typeof agentCatalogSourceSchema>;

/**
 * 代理人目录数据：构建时生成的只读产物（shared/agents/catalog.json）。
 *
 * `agentDataVersion` 与 shared/contracts/versions.ts 的
 * agentDataVersionSchema 同域（trim 后 1..50 码点），作为视图与归档记录
 * 随附的数据版本标识。
 */
export const agentCatalogSchema = z
  .object({
    agentDataVersion: z.string().trim().min(1).max(50),
    source: agentCatalogSourceSchema,
    /** 属性分类表；由代理人条目推导，不做手工维护。 */
    elements: z.array(agentClassificationSchema).min(1),
    /** 特性分类表；由代理人条目推导，不做手工维护。 */
    specialties: z.array(agentClassificationSchema).min(1),
    /** 全部代理人条目，按来源 ID 数值严格升序固定排列。 */
    agents: z.array(agentEntrySchema).min(1),
  })
  .superRefine((catalog, ctx) => {
    // 版本与来源记录一致：目录版本以包版本为单一事实。
    if (catalog.agentDataVersion !== catalog.source.packageVersion) {
      ctx.addIssue({
        code: "custom",
        message: `agentDataVersion (${catalog.agentDataVersion}) 与来源包版本 (${catalog.source.packageVersion}) 不一致`,
        path: ["agentDataVersion"],
        input: catalog.agentDataVersion,
      });
    }

    for (const [tableField, table] of [
      ["elements", catalog.elements],
      ["specialties", catalog.specialties],
    ] as const) {
      // 分类 ID 不得重复。
      const seenIds = new Set<string>();
      // 分类名称不得重复：筛选按钮按名称展示，重名无法辨认。
      const seenNames = new Set<string>();
      for (let index = 0; index < table.length; index += 1) {
        const classification = table[index];
        if (seenIds.has(classification.id)) {
          ctx.addIssue({
            code: "custom",
            message: `分类 ID 重复：${classification.id}`,
            path: [tableField, index, "id"],
            input: classification.id,
          });
        }
        seenIds.add(classification.id);
        if (seenNames.has(classification.name)) {
          ctx.addIssue({
            code: "custom",
            message: `分类名称重复：${classification.name}`,
            path: [tableField, index, "name"],
            input: classification.name,
          });
        }
        seenNames.add(classification.name);
      }
    }

    // 分类表按 ID 数值升序排列（与代理人排列同一语义）。
    if (classificationIdsUnordered(catalog.elements)) {
      ctx.addIssue({
        code: "custom",
        message: "elements 未按 ID 数值升序排列",
        path: ["elements"],
        input: catalog.elements,
      });
    }
    if (classificationIdsUnordered(catalog.specialties)) {
      ctx.addIssue({
        code: "custom",
        message: "specialties 未按 ID 数值升序排列",
        path: ["specialties"],
        input: catalog.specialties,
      });
    }

    const elementIds = new Set(catalog.elements.map((entry) => entry.id));
    const specialtyIds = new Set(catalog.specialties.map((entry) => entry.id));
    const usedElementIds = new Set<string>();
    const usedSpecialtyIds = new Set<string>();
    const seenAgentIds = new Set<string>();

    for (let index = 0; index < catalog.agents.length; index += 1) {
      const agent = catalog.agents[index];
      // ID 唯一。
      if (seenAgentIds.has(agent.id)) {
        ctx.addIssue({
          code: "custom",
          message: `代理人 ID 重复：${agent.id}`,
          path: ["agents", index, "id"],
          input: agent.id,
        });
      }
      seenAgentIds.add(agent.id);
      // ID 按数值严格升序（默认排列的固定语义）。
      if (index > 0) {
        const previous = catalog.agents[index - 1];
        if (Number(previous.id) >= Number(agent.id)) {
          ctx.addIssue({
            code: "custom",
            message: `代理人未按 ID 数值升序排列：${previous.id} 之后出现 ${agent.id}`,
            path: ["agents", index, "id"],
            input: agent.id,
          });
        }
      }
      // 分类引用有效。
      if (!elementIds.has(agent.elementId)) {
        ctx.addIssue({
          code: "custom",
          message: `代理人 ${agent.id} 引用了不存在的属性分类 ${agent.elementId}`,
          path: ["agents", index, "elementId"],
          input: agent.elementId,
        });
      }
      if (!specialtyIds.has(agent.specialtyId)) {
        ctx.addIssue({
          code: "custom",
          message: `代理人 ${agent.id} 引用了不存在的特性分类 ${agent.specialtyId}`,
          path: ["agents", index, "specialtyId"],
          input: agent.specialtyId,
        });
      }
      usedElementIds.add(agent.elementId);
      usedSpecialtyIds.add(agent.specialtyId);
    }

    // 分类表必须由条目推导：不允许存在无人使用的分类项。
    for (const [tableField, table, usedIds] of [
      ["elements", catalog.elements, usedElementIds],
      ["specialties", catalog.specialties, usedSpecialtyIds],
    ] as const) {
      for (let index = 0; index < table.length; index += 1) {
        const classification = table[index];
        if (!usedIds.has(classification.id)) {
          ctx.addIssue({
            code: "custom",
            message: `分类 ${classification.id}（${classification.name}）未被任何代理人使用`,
            path: [tableField, index],
            input: classification,
          });
        }
      }
    }
  });
export type AgentCatalogData = z.infer<typeof agentCatalogSchema>;

/** 检查分类表是否未按 ID 数值升序排列。 */
function classificationIdsUnordered(table: readonly AgentClassification[]): boolean {
  for (let index = 1; index < table.length; index += 1) {
    if (Number(table[index - 1].id) >= Number(table[index].id)) return true;
  }
  return false;
}
