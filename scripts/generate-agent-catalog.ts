import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentNames, calculationDataVersion, loadAllAgents, loadIndex } from "@randomplay/data";
import {
  imageAssetsManifestSchema,
  type ImageAssetsManifest,
} from "../shared/agents/assets-schema.ts";
import {
  agentCatalogSchema,
  type AgentCatalogData,
  type AgentClassification,
  type AgentEntry,
} from "../shared/agents/schema.ts";

/*
 * 代理人目录生成脚本：从固定版本的 @randomplay/data 生成本站只读目录。
 *
 * 运行：pnpm run generate:agent-catalog
 * （Node ≥ 24.11.0（@randomplay/data 的 engines 要求）原生类型剥离执行；
 * 本脚本与 shared/agents/schema.ts 均不使用需要编译的 TypeScript 语法，
 * 相对导入显式带 .ts 扩展名。）
 *
 * 产物 shared/agents/catalog.json 提交入库，日常构建与测试只读取产物、
 * 不重新生成、不访问网络。数据来源、字段映射与版本更新办法见
 * docs/specs/agent-data.md。
 *
 * 图片资源引用（条目 iconAsset 与分类 iconAsset、目录 imageAssets 修订）
 * 读取本站图片资源清单 shared/agents/assets.json（由
 * pnpm run import:image-assets 产出并提交）；清单缺失条目时显式失败，
 * 不生成没有图片资源的目录，也不凭空猜测资源主干。
 */

/** 产物输出路径（相对本文件）。 */
const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../shared/agents/catalog.json",
);

/** 图片资源清单路径（导入脚本的产物，提交入库）。 */
const ASSETS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../shared/agents/assets.json",
);

/** 生成失败时带上下文抛出：数据异常必须显式暴露，不允许静默跳过条目。 */
function fail(context: string, detail: string): never {
  throw new Error(`生成代理人目录失败（${context}）：${detail}`);
}

/** 断言上游分类字段只有一个取值；多值或缺失属于来源歧义，交由人工确认。 */
function singleClassification(
  context: string,
  ids: readonly string[],
  field: "elementType" | "weaponType",
): string {
  if (ids.length !== 1) {
    fail(context, `classificationIds.${field} 应恰有一个取值，实际 ${JSON.stringify(ids)}`);
  }
  return ids[0] as string;
}

/** 读取分类的中文官方名称；缺失视为来源数据不完整。 */
function classificationName(
  context: string,
  names: Record<string, string>,
  id: string,
  field: "elementType" | "weaponType",
): string {
  const name = names[id];
  if (typeof name !== "string" || name.trim() === "") {
    fail(context, `details.${field} 缺少分类 ${id} 的中文名称`);
  }
  return name;
}

/** 由全部代理人条目推导属性/特性分类表，按 ID 数值升序排列。 */
function deriveClassifications(
  usages: ReadonlyMap<string, { name: string }>,
  kind: "属性" | "特性",
  assets: ImageAssetsManifest,
): AgentClassification[] {
  return [...usages.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([id, { name }]) => {
      if (name.trim() === "") fail(`推导${kind}分类`, `分类 ${id} 名称为空`);
      // 数据包未记录属性/特性图标资源字段（iconPath 恒为 null）；图标由
      // 本站图片资源清单按分类 ID 提供（见 loadImageAssets）。
      return {
        id,
        name,
        iconPath: null,
        iconAsset: classificationIconStem(assets, kind === "属性" ? "element" : "specialty", id),
      };
    });
}

/**
 * 读取并校验图片资源清单，返回当前修订与按主干索引的方图资源。
 *
 * 清单由导入脚本产出；目录生成只读取本地文件，不访问网络。方图主干的
 * 命名规则来自 fairy 上游消费库的已确认实现（data.icon 将 Role 替换为
 * RoleCrop），生成时逐条与清单比对，缺失即失败。
 */
async function loadImageAssets(): Promise<ImageAssetsManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(ASSETS_PATH, "utf8"));
  } catch (error) {
    fail(
      "读取图片资源清单",
      `${ASSETS_PATH} 不可读（先运行 pnpm run import:image-assets）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = imageAssetsManifestSchema.safeParse(parsed);
  if (!result.success) {
    fail("读取图片资源清单", `清单未通过 schema 校验：${result.error.message}`);
  }
  return result.data;
}

/** 读取分类图标主干（element-<id> / specialty-<id>）；缺失即失败。 */
function classificationIconStem(assets: ImageAssetsManifest, kind: string, id: string): string {
  const asset = assets.classifications[`${kind}-${id}`];
  if (asset === undefined) {
    fail(
      "图片资源清单",
      `分类 ${kind}-${id} 没有图标资源记录；先在导入脚本的来源表中补充并重新导入`,
    );
  }
  return asset.stem;
}

async function main(): Promise<void> {
  const assets = await loadImageAssets();
  const agents = await loadAllAgents("zh");
  const snapshotIndex = await loadIndex();
  if (snapshotIndex.source.version !== calculationDataVersion.gameVersion) {
    fail(
      "读取来源版本",
      `索引来源版本 ${snapshotIndex.source.version} 与计算数据版本 ${calculationDataVersion.gameVersion} 不一致`,
    );
  }

  const elements = new Map<string, { name: string }>();
  const specialties = new Map<string, { name: string }>();
  const entries: AgentEntry[] = [];

  for (const name of agentNames) {
    const localized = agents[name];
    if (localized === undefined) {
      fail("读取代理人", `agentNames 包含 ${name}，但 loadAllAgents 未返回对应资料`);
    }
    const { data, details } = localized;
    const context = `代理人 ${data.id}（${name}）`;

    // 稳定 ID：来源数值 ID 的规范十进制字符串。
    const id = String(data.id);
    if (!/^(?:0|[1-9][0-9]*)$/.test(id)) {
      fail(context, `来源 ID ${id} 不是规范十进制数`);
    }

    // 官方中文名称（简短展示名）与官方全名（来源未记录时为 null，
    // 不推测或合并变体身份）。
    const officialName = details.name;
    if (typeof officialName !== "string" || officialName.trim() === "") {
      fail(context, "缺少官方中文名称");
    }
    const fullNameSource = details.partnerInfo.fullName;
    const fullName =
      typeof fullNameSource === "string" && fullNameSource.trim() !== "" ? fullNameSource : null;

    // 头像：数据包已记录的路径（公共字段优先，其次中文详情独有原值）；
    // 均缺失时为 null，不根据图标编号拼接或推测补写。产物保留原始路径，
    // 可加载的图片 URL 在消费边界派生（见 shared/agents/catalog.ts）。
    const avatarPath = data.partnerInfo.iconPath ?? details.partnerInfo.iconPath ?? null;
    if (avatarPath !== null && avatarPath === "") {
      fail(context, "头像路径记录为空字符串，应视为缺失（null）还是异常需人工确认");
    }

    // 图片资源引用：主干按上游已确认规则由 data.icon 推导（Role →
    // RoleCrop），与图片资源清单逐条比对（含宽幅裁切校准值）；1381/
    // 1531/1551 缺 avatarPath 但有 data.icon，其方图资源由清单提供，
    // 不伪造它们的旧来源路径。
    const icon = data.icon;
    if (typeof icon !== "string" || !/^IconRole[0-9]+$/.test(icon)) {
      fail(context, `data.icon 不是 IconRoleNN 形态：${JSON.stringify(icon)}`);
    }
    const iconStem = icon.replace("Role", "RoleCrop");
    const imageAsset = assets.agents[iconStem];
    if (imageAsset === undefined || !imageAsset.agentIds.includes(id)) {
      fail(
        context,
        `图片资源清单缺少主干 ${iconStem}（或未登记该代理人）；先运行 pnpm run import:image-assets`,
      );
    }

    // 属性与特性：classificationIds 取唯一分类，名称读中文详情原值。
    const elementId = singleClassification(
      context,
      data.classificationIds.elementType,
      "elementType",
    );
    const specialtyId = singleClassification(
      context,
      data.classificationIds.weaponType,
      "weaponType",
    );
    if (!elements.has(elementId)) {
      elements.set(elementId, {
        name: classificationName(context, details.elementType, elementId, "elementType"),
      });
    }
    if (!specialties.has(specialtyId)) {
      specialties.set(specialtyId, {
        name: classificationName(context, details.weaponType, specialtyId, "weaponType"),
      });
    }

    entries.push({
      id,
      name: officialName,
      fullName,
      avatarPath,
      iconAsset: { icon: iconStem, crop: imageAsset.crop },
      elementId,
      specialtyId,
    });
  }

  // 按来源 ID 数值升序固定排列（目录默认排列的权威顺序）。
  entries.sort((left, right) => Number(left.id) - Number(right.id));

  const catalog: AgentCatalogData = {
    agentDataVersion: calculationDataVersion.packageVersion,
    source: {
      package: "@randomplay/data",
      packageVersion: calculationDataVersion.packageVersion,
      gameVersion: calculationDataVersion.gameVersion,
      sourceId: snapshotIndex.source.id,
      snapshotId: calculationDataVersion.snapshotId,
    },
    imageAssets: {
      revision: assets.revision,
      // 已收录旧圆图本地副本的文件名摘要（清单为单一事实来源，此处按
      // 排序嵌入供运行时收录判断；对齐由 tests/rules 校验，不允许漂移）。
      legacyCircleFileNames: Object.keys(assets.legacyCircles).sort(),
    },
    elements: deriveClassifications(elements, "属性", assets),
    specialties: deriveClassifications(specialties, "特性", assets),
    agents: entries,
  };

  // 写入前用共享 schema 完整校验（含 ID 唯一、升序、引用有效等不变量）。
  const validated = agentCatalogSchema.parse(catalog);
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(validated, null, 2)}\n`, "utf8");

  console.log(
    `已生成 ${OUTPUT_PATH}：${validated.agents.length} 名代理人，` +
      `${validated.elements.length} 项属性，${validated.specialties.length} 项特性，` +
      `数据版本 ${validated.agentDataVersion}（${validated.source.gameVersion}）。`,
  );
}

await main();
