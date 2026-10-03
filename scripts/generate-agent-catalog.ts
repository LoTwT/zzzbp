import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentNames, calculationDataVersion, loadAllAgents, loadIndex } from "@randomplay/data";
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
 * （Node ≥ 24 原生类型剥离执行；本脚本与 shared/agents/schema.ts 均不
 * 使用需要编译的 TypeScript 语法，相对导入显式带 .ts 扩展名。）
 *
 * 产物 shared/agents/catalog.json 提交入库，日常构建与测试只读取产物、
 * 不重新生成、不访问网络。数据来源、字段映射与版本更新办法见
 * docs/specs/agent-data.md。
 */

/** 产物输出路径（相对本文件）。 */
const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../shared/agents/catalog.json",
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
): AgentClassification[] {
  return [...usages.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([id, { name }]) => {
      if (name.trim() === "") fail(`推导${kind}分类`, `分类 ${id} 名称为空`);
      // 当前数据包未记录属性/特性图标资源字段，只能为 null；
      // 上游补齐后在此处改为读取实际字段，不拼接、不制造图标。
      return { id, name, iconPath: null };
    });
}

async function main(): Promise<void> {
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

    // 官方中文名称。
    const officialName = details.name;
    if (typeof officialName !== "string" || officialName.trim() === "") {
      fail(context, "缺少官方中文名称");
    }

    // 头像：数据包已记录的路径（公共字段优先，其次中文详情独有原值）；
    // 均缺失时为 null，不根据图标编号拼接或推测补写。
    const avatarPath = data.partnerInfo.iconPath ?? details.partnerInfo.iconPath ?? null;
    if (avatarPath !== null && avatarPath === "") {
      fail(context, "头像路径记录为空字符串，应视为缺失（null）还是异常需人工确认");
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

    entries.push({ id, name: officialName, avatarPath, elementId, specialtyId });
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
    elements: deriveClassifications(elements, "属性"),
    specialties: deriveClassifications(specialties, "特性"),
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
