import type { ImageAssetsManifest } from "./assets-schema.ts";

/*
 * 图片资源导入批次（scripts/import-image-assets.ts）的写入前校验。
 *
 * 不可变资源约定（docs/specs/agent-data.md「图片资源导入流程」）：
 * - 版本目录（/images/agents/<修订>/、/images/classifications/<修订>/）按
 *   修订不可变：复用同一修订重跑时清单必须与现有清单完全一致，图片或
 *   裁切校准的任何变化都必须使用新修订；
 * - legacy 旧圆图副本（/images/agents/legacy/）跨修订只增不改：已收录的
 *   记录与文件原样保留，上游后续变化不回写；
 * - 一切冲突在写入任何资源或清单之前失败，不产生部分更新。
 *
 * 本模块只做纯数据校验（磁盘状态经注入的读取器获得），供导入脚本与
 * tests/rules/agent-image-import.test.ts 共用；不进入任何运行时 bundle。
 */

/** 批次校验通过的写入计划。 */
export interface ImportWritePlan {
  /** 磁盘上不存在、需要写入的公开路径。 */
  readonly writes: readonly string[];
  /** 磁盘上已有相同内容、幂等跳过不重写的公开路径。 */
  readonly unchanged: readonly string[];
}

/** 收集清单引用的全部文件（公开路径 → 记录的内容哈希）。 */
function manifestFiles(manifest: ImageAssetsManifest): Map<string, string> {
  const files = new Map<string, string>();
  for (const asset of Object.values(manifest.agents)) {
    files.set(asset.square.path, asset.square.sha256);
    files.set(asset.thumb.path, asset.thumb.sha256);
  }
  for (const asset of Object.values(manifest.classifications)) {
    files.set(asset.file.path, asset.file.sha256);
  }
  for (const asset of Object.values(manifest.legacyCircles)) {
    files.set(asset.file.path, asset.file.sha256);
  }
  return files;
}

/** 递归按键名排序的稳定序列化（比较两份 JSON 事实，忽略键序）。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 同修订不变量：两份清单的实质差异描述；完全一致返回 null。
 *
 * 键序不参与比较（生成端排序演进不改事实），条目增删与记录变化都算差异
 * ——同修订下任何变化都要求改用新修订，包括新增条目。
 */
function manifestDifference(
  planned: ImageAssetsManifest,
  existing: ImageAssetsManifest,
): string | null {
  for (const table of ["agents", "classifications", "legacyCircles"] as const) {
    const left = planned[table];
    const right = existing[table];
    for (const key of Object.keys(left)) {
      if (!(key in right)) return `${table}.${key} 是新增条目`;
    }
    for (const key of Object.keys(right)) {
      if (!(key in left)) return `${table}.${key} 被移除`;
      if (stableJson(left[key]) !== stableJson(right[key])) {
        return `${table}.${key} 的记录不同（图片内容、尺寸或裁切校准变化）`;
      }
    }
  }
  return null;
}

/**
 * 校验导入批次并产出写入计划；任何冲突在返回前抛出，调用方据此保证
 * 「先整批校验、后写入」，失败时不写入任何资源或清单。
 *
 * - plannedManifest：本次组装的完整清单（legacy 部分应已并入现有收录）；
 * - plannedWritePaths：本次计划写入磁盘的公开路径（沿用现有 legacy 记录
 *   的文件不在其内，它们不重新读取来源）；
 * - existingManifest：磁盘上的现有清单（null 表示尚无清单）；
 * - readDiskSha256：公开路径 → 磁盘内容哈希；文件不存在返回 null。
 */
export async function planImportWrite(input: {
  readonly plannedManifest: ImageAssetsManifest;
  readonly plannedWritePaths: ReadonlySet<string>;
  readonly existingManifest: ImageAssetsManifest | null;
  readonly readDiskSha256: (path: string) => Promise<string | null>;
}): Promise<ImportWritePlan> {
  const { plannedManifest, plannedWritePaths, existingManifest, readDiskSha256 } = input;

  // 计划写入的路径必须被清单引用（编排一致性，属编程错误防线）。
  const referenced = manifestFiles(plannedManifest);
  for (const path of plannedWritePaths) {
    if (!referenced.has(path)) {
      throw new Error(`计划写入的 ${path} 未被清单引用（导入编排错误）`);
    }
  }

  // legacy 收录只增不改：现有清单的每条记录都必须原样进入计划清单。
  if (existingManifest !== null) {
    for (const [fileName, record] of Object.entries(existingManifest.legacyCircles)) {
      const planned = plannedManifest.legacyCircles[fileName];
      if (planned === undefined || stableJson(planned) !== stableJson(record)) {
        throw new Error(`旧圆图 ${fileName} 的收录记录被改动（legacy 副本跨修订只增不改）`);
      }
    }
  }

  // 同修订不可变：复用同一修订时，清单必须与现有清单完全一致。
  if (existingManifest !== null && plannedManifest.revision === existingManifest.revision) {
    const difference = manifestDifference(plannedManifest, existingManifest);
    if (difference !== null) {
      throw new Error(
        `修订 ${plannedManifest.revision} 已存在且${difference}；图片或裁切校准的变化必须使用新的 --revision`,
      );
    }
  }

  // 磁盘状态整批核对：引用的每个文件要么已在磁盘且内容与清单一致（幂等
  // 跳过），要么在计划写入内且目标路径当前不存在（新写入）；任何「已存在
  // 但内容不同」都是冲突——稳定路径的内容保持不变，变化必须使用新修订。
  const writes: string[] = [];
  const unchanged: string[] = [];
  for (const [path, recordSha256] of [...referenced.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const planned = plannedWritePaths.has(path);
    const diskSha256 = await readDiskSha256(path);
    if (diskSha256 === null) {
      if (!planned) {
        throw new Error(
          `清单引用的 ${path} 磁盘上不存在且不在本次写入计划内（现有清单与磁盘不一致，需人工处理）`,
        );
      }
      writes.push(path);
      continue;
    }
    if (diskSha256 === recordSha256) {
      unchanged.push(path);
      continue;
    }
    if (planned) {
      throw new Error(
        `${path} 磁盘上已有不同内容（磁盘 ${diskSha256.slice(0, 12)}…，本次 ${recordSha256.slice(0, 12)}…）；稳定路径的内容保持不变，变化必须使用新的 --revision`,
      );
    }
    throw new Error(
      `${path} 磁盘内容与清单记录不符（磁盘 ${diskSha256.slice(0, 12)}…，清单 ${recordSha256.slice(0, 12)}…）；需人工核对后处理`,
    );
  }
  return { writes, unchanged };
}
