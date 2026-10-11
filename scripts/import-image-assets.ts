import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentNames, loadAllAgents } from "@randomplay/data";
import sharp from "sharp";
import {
  imageAssetsManifestSchema,
  type AgentImageAsset,
  type AssetFile,
  type ImageAssetsManifest,
} from "../shared/agents/assets-schema.ts";
import { planImportWrite } from "../shared/agents/assets-import.ts";
import { toAgentImageUrl } from "../shared/agents/assets.ts";
import { imageCropSchema, type ImageCrop } from "../shared/agents/schema.ts";

/*
 * 图片资源导入脚本：把上游已核验的方图母图、分类图标与旧圆图副本整理为
 * 本站同源静态资源（public/images/...），由母图离线生成 128x128 缩略图，
 * 并产出可校验的资源清单 shared/agents/assets.json。
 *
 * 运行：pnpm run import:image-assets [-- --sources <dir>] [-- --crops <file>]
 *   [-- --revision <id>]
 * - --sources 指定本地已核验来源目录（上游核验缓存）时，方图母图、分类
 *   图标与未收录的旧圆图都从该目录读取（文件名与资源主干一致），缺失时
 *   显式失败、不回退网络；未提供目录则从上游 URL 下载（携带浏览器 UA 与
 *   Referer，可达性记录见 docs/specs/agent-data.md）。
 * - 缩略图由母图离线生成（sharp，固定参数保证同版本可复现）；母图与缩略
 *   图同资源修订。
 * - 宽幅裁切校准值来自 --crops 的校准文件（{ "<主干>": {x,y} }）；未提供
 *   时沿用现有清单中同一图标集的裁切值（二者均不可得则显式失败——裁切
 *   必须来自看图校准，不使用猜测默认值）。
 *
 * 资源不可变约定（写入前整批校验，见 shared/agents/assets-import.ts）：
 * - 版本目录按修订不可变：复用同一修订重跑必须与现有清单完全一致，图片
 *   或裁切校准的任何变化（含新增条目）都必须使用新 --revision；
 * - legacy 旧圆图副本跨修订只增不改：已收录的记录与文件原样保留，脚本
 *   不重新读取其来源，上游后续变化不回写；
 * - 任何冲突在写入任何资源或清单之前失败，不产生部分更新。
 *
 * 本脚本只在显式资源更新时运行（允许联网访问公开 GET 的资源源站）；日常
 * 构建、CI 与页面不运行、不联网。已导入文件与清单的一致性由
 * tests/rules/agent-image-assets.test.ts 校验。
 */

/** 仓库根（相对本文件）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 清单输出路径。 */
const MANIFEST_PATH = resolve(ROOT, "shared/agents/assets.json");
/** 静态资源根目录。 */
const PUBLIC_ROOT = resolve(ROOT, "public");
/** 旧圆图本地副本目录名（public/images/agents/legacy，跨修订保留）。 */
const LEGACY_DIR = "legacy";
/** 方图母图的固定边长（上游 IconRoleCrop 资源形态）。 */
const SQUARE_SIZE_PX = 384;
/** 缩略图边长（顶部禁用区 64 CSS px 在 2x 屏幕的清晰度）。 */
const THUMB_SIZE_PX = 128;
/** 缩略图 WebP 编码质量（固定参数保证同 sharp 版本字节可复现）。 */
const THUMB_QUALITY = 82;

/** 上游 Nanoka 静态资源基址（与 toAgentImageUrl 的产物同域）。 */
const NANOKA_BASE_URL = "https://static.nanoka.cc/assets/zzz/";

/** 上游下载请求头：可达性探测记录显示普通 HEAD 会被 403，需浏览器 UA 与 Referer。 */
const UPSTREAM_HEADERS: Readonly<Record<string, string>> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  referer: "https://zzz.nanoka.cc/",
};

/**
 * 分类图标的固定来源表：属性与特性分别按来源分类 ID 维护，主干名沿用
 * 上游资源名。来源核验记录见 docs/specs/agent-data.md「分类图标来源」；
 * 300 流明在 Nanoka 返回 404，使用 Gachabase 角色页分类资源（仅取分类
 * 图标本身，不引入该页面的角色名单或 ID）。
 */
const CLASSIFICATION_ICON_SOURCES: ReadonlyArray<{
  kind: "element" | "specialty";
  id: string;
  stem: string;
  sourceUrl: string;
}> = [
  {
    kind: "element",
    id: "200",
    stem: "IconPhysical",
    sourceUrl: `${NANOKA_BASE_URL}IconPhysical.webp`,
  },
  { kind: "element", id: "201", stem: "IconFire", sourceUrl: `${NANOKA_BASE_URL}IconFire.webp` },
  { kind: "element", id: "202", stem: "IconIce", sourceUrl: `${NANOKA_BASE_URL}IconIce.webp` },
  {
    kind: "element",
    id: "203",
    stem: "IconElectric",
    sourceUrl: `${NANOKA_BASE_URL}IconElectric.webp`,
  },
  { kind: "element", id: "204", stem: "IconWind", sourceUrl: `${NANOKA_BASE_URL}IconWind.webp` },
  { kind: "element", id: "205", stem: "IconEther", sourceUrl: `${NANOKA_BASE_URL}IconEther.webp` },
  {
    kind: "element",
    id: "300",
    stem: "IconLumiflux",
    sourceUrl:
      "https://i.gachabase.net/WZ6dz2m66KusU0_Ir9Fjrtp9kP47RTv9U45GZPL33f8/q:50/f:webp/plain/zzz/assets/1ed527ad8b2d3f7015071c429a92c3ae.png",
  },
  {
    kind: "specialty",
    id: "1",
    stem: "IconAttackType",
    sourceUrl: `${NANOKA_BASE_URL}IconAttackType.webp`,
  },
  { kind: "specialty", id: "2", stem: "IconStun", sourceUrl: `${NANOKA_BASE_URL}IconStun.webp` },
  {
    kind: "specialty",
    id: "3",
    stem: "IconAnomaly",
    sourceUrl: `${NANOKA_BASE_URL}IconAnomaly.webp`,
  },
  {
    kind: "specialty",
    id: "4",
    stem: "IconSupport",
    sourceUrl: `${NANOKA_BASE_URL}IconSupport.webp`,
  },
  {
    kind: "specialty",
    id: "5",
    stem: "IconDefense",
    sourceUrl: `${NANOKA_BASE_URL}IconDefense.webp`,
  },
  {
    kind: "specialty",
    id: "6",
    stem: "IconRupture",
    sourceUrl: `${NANOKA_BASE_URL}IconRupture.webp`,
  },
];

/** 生成失败时带上下文抛出：数据异常必须显式暴露，不允许静默跳过。 */
function fail(context: string, detail: string): never {
  throw new Error(`导入图片资源失败（${context}）：${detail}`);
}

interface Options {
  readonly sourcesDir: string | null;
  readonly cropsPath: string | null;
  readonly revision: string;
}

/** 默认修订标识：导入日期（同日多次导入需显式指定不同 id）。 */
function defaultRevision(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseOptions(argv: readonly string[]): Options {
  let options: Options = { sourcesDir: null, cropsPath: null, revision: defaultRevision() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // pnpm run 透传参数时保留「--」分隔符，直接调用 node 时不含，两者都接受。
    if (arg === "--") continue;
    const value = argv[index + 1];
    if (arg === "--sources" && value !== undefined) {
      options = { ...options, sourcesDir: value };
      index += 1;
    } else if (arg === "--crops" && value !== undefined) {
      options = { ...options, cropsPath: value };
      index += 1;
    } else if (arg === "--revision" && value !== undefined) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        fail("解析参数", `--revision 必须是安全资源段：${JSON.stringify(value)}`);
      }
      options = { ...options, revision: value };
      index += 1;
    } else {
      fail("解析参数", `未知参数或缺少取值：${JSON.stringify(arg)}`);
    }
  }
  return options;
}

/** 下载上游资源（带浏览器头与有限重试）；非 200 或内容为空视为失败。 */
async function download(url: string): Promise<Buffer> {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: UPSTREAM_HEADERS, redirect: "follow" });
      if (response.status === 200) {
        const body = Buffer.from(await response.arrayBuffer());
        if (body.byteLength > 0) return body;
        lastError = `响应体为空（${body.byteLength} 字节）`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  fail("下载", `${url}：${lastError}`);
}

/**
 * 读取一个来源文件的字节：--sources 指定本地已核验目录时从该目录读取
 * （文件名与资源主干一致，缺失显式失败、不回退网络，保证重跑可离线且
 * 不依赖上游变化）；否则按远程 URL 下载。
 */
async function readSourceBytes(
  context: string,
  options: Options,
  fileName: string,
  remoteUrl: string,
): Promise<Buffer> {
  if (options.sourcesDir !== null) {
    const localPath = resolve(options.sourcesDir, fileName);
    try {
      return await readFile(localPath);
    } catch (error) {
      fail(
        "读取来源文件",
        `${context}：本地来源目录缺少 ${fileName}（${options.sourcesDir}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return download(remoteUrl);
}

/** 读取现有清单：文件缺失视为 null（首次导入）；存在但不可解析是显式失败，
 * 不允许在校验基础不明的情况下覆盖资源。 */
async function loadExistingManifest(): Promise<ImageAssetsManifest | null> {
  let raw: string;
  try {
    raw = await readFile(MANIFEST_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail(
      "读取现有清单",
      `${MANIFEST_PATH}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(
      "读取现有清单",
      `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = imageAssetsManifestSchema.safeParse(parsed);
  if (!result.success) {
    fail("读取现有清单", `未通过 schema 校验：${result.error.message}`);
  }
  return result.data;
}

/** 计算 SHA-256 内容哈希（十六进制）。 */
function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 读取图片元数据并核验为 WebP；返回宽高。 */
async function inspectWebp(
  context: string,
  data: Buffer,
): Promise<{ width: number; height: number }> {
  try {
    const metadata = await sharp(data).metadata();
    if (metadata.format !== "webp") {
      fail(context, `资源不是 WebP（实际 ${String(metadata.format)}）`);
    }
    if (metadata.width === undefined || metadata.height === undefined) {
      fail(context, "无法读取图片尺寸");
    }
    return { width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("导入图片资源失败")) throw error;
    fail(context, `解码失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 构造资源文件事实（路径 + 字节数 + 哈希 + 尺寸）。 */
function toAssetFile(path: string, data: Buffer, width: number, height: number): AssetFile {
  return { path, bytes: data.byteLength, sha256: sha256Hex(data), width, height };
}

/** 由母图生成 128x128 缩略图（固定参数，母图与缩略图同修订）。 */
async function renderThumb(context: string, master: Buffer): Promise<Buffer> {
  const thumb = await sharp(master)
    .resize(THUMB_SIZE_PX, THUMB_SIZE_PX, { fit: "cover" })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();
  const info = await inspectWebp(`${context} 缩略图`, thumb);
  if (info.width !== THUMB_SIZE_PX || info.height !== THUMB_SIZE_PX) {
    fail(
      `${context} 缩略图`,
      `期望 ${THUMB_SIZE_PX}x${THUMB_SIZE_PX}，实际 ${info.width}x${info.height}`,
    );
  }
  return thumb;
}

interface AgentRow {
  readonly id: string;
  readonly stem: string;
  readonly avatarUrl: string | null;
}

/** 从固定版本数据包读取代理人清单：稳定 ID、母图主干与旧头像 URL。 */
async function loadAgentRows(): Promise<AgentRow[]> {
  const agents = await loadAllAgents("zh");
  const rows: AgentRow[] = [];
  for (const name of agentNames) {
    const localized = agents[name];
    if (localized === undefined) {
      fail("读取代理人", `agentNames 包含 ${name}，但 loadAllAgents 未返回对应资料`);
    }
    const { data, details } = localized;
    const icon = data.icon;
    if (typeof icon !== "string" || !/^IconRole[0-9]+$/.test(icon)) {
      fail(
        "读取代理人",
        `代理人 ${String(data.id)} 的 data.icon 不是 IconRoleNN 形态：${JSON.stringify(icon)}`,
      );
    }
    // 上游已确认的裁切规则：data.icon 将 Role 替换为 RoleCrop（读取实际
    // 字段，不是按角色 ID 猜编号；见 docs/specs/agent-data.md）。
    const stem = icon.replace("Role", "RoleCrop");
    const avatarPath = data.partnerInfo.iconPath ?? details.partnerInfo.iconPath ?? null;
    rows.push({ id: String(data.id), stem, avatarUrl: toAgentImageUrl(avatarPath) });
  }
  rows.sort((left, right) => Number(left.id) - Number(right.id));
  const stems = new Set(rows.map((row) => row.stem));
  if (stems.size !== rows.length) fail("母图主干", "不同代理人映射到同一母图主干，需人工确认来源");
  return rows;
}

/** 读取宽幅裁切校准值：--crops 校准文件，或沿用现有清单的同一图标集。 */
async function loadCrops(
  options: Options,
  existing: ImageAssetsManifest | null,
): Promise<Record<string, ImageCrop>> {
  if (options.cropsPath !== null) {
    const parsed: unknown = JSON.parse(await readFile(options.cropsPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") fail("裁切校准文件", "顶层必须是对象");
    const crops: Record<string, ImageCrop> = {};
    for (const [stem, value] of Object.entries(parsed as Record<string, unknown>)) {
      const crop = imageCropSchema.safeParse(value);
      if (!crop.success) fail("裁切校准文件", `${stem} 的裁切值非法：${JSON.stringify(value)}`);
      crops[stem] = crop.data;
    }
    return crops;
  }
  if (existing === null) {
    fail("裁切校准文件", "没有 --crops 且不存在可沿用的现有清单；首次导入必须提供看图校准文件");
  }
  const crops: Record<string, ImageCrop> = {};
  for (const [stem, asset] of Object.entries(existing.agents)) {
    crops[stem] = asset.crop;
  }
  return crops;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const rows = await loadAgentRows();
  const existing = await loadExistingManifest();

  // ---- 分类图标来源表必须覆盖数据包内的全部分类 ----
  const elementIds = new Set<string>();
  const specialtyIds = new Set<string>();
  const agents = await loadAllAgents("zh");
  for (const name of agentNames) {
    const localized = agents[name];
    if (localized === undefined) continue;
    for (const id of localized.data.classificationIds.elementType) elementIds.add(id);
    for (const id of localized.data.classificationIds.weaponType) specialtyIds.add(id);
  }
  for (const [ids, kind] of [
    [elementIds, "element"],
    [specialtyIds, "specialty"],
  ] as const) {
    for (const id of ids) {
      if (!CLASSIFICATION_ICON_SOURCES.some((source) => source.kind === kind && source.id === id)) {
        fail(
          "分类图标来源表",
          `数据包${kind === "element" ? "属性" : "特性"}分类 ${id} 没有对应的图标来源记录`,
        );
      }
    }
  }

  // ---- 宽幅裁切校准值必须覆盖全部主干（不使用猜测默认值） ----
  const stems = new Set(rows.map((row) => row.stem));
  const crops = await loadCrops(options, existing);
  for (const stem of stems) {
    if (crops[stem] === undefined) {
      fail("裁切校准文件", `母图 ${stem} 缺少裁切校准值（必须覆盖全部 ${stems.size} 个主干）`);
    }
  }
  for (const stem of Object.keys(crops)) {
    if (!stems.has(stem)) {
      fail("裁切校准文件", `裁切值包含未知主干 ${stem}（应与当前代理人一一对应）`);
    }
  }

  // ---- 组装计划（公开路径 -> 字节）与清单记录；一切校验完成后才写入 ----
  const files = new Map<string, Buffer>();
  const agentsRecord: Record<string, AgentImageAsset> = {};
  for (const row of rows) {
    const context = `代理人 ${row.id}（${row.stem}）`;
    const master = await readSourceBytes(
      `${context} 母图`,
      options,
      `${row.stem}.webp`,
      `${NANOKA_BASE_URL}${row.stem}.webp`,
    );
    const masterInfo = await inspectWebp(`${context} 母图`, master);
    if (masterInfo.width !== SQUARE_SIZE_PX || masterInfo.height !== SQUARE_SIZE_PX) {
      fail(
        `${context} 母图`,
        `期望 ${SQUARE_SIZE_PX}x${SQUARE_SIZE_PX}，实际 ${masterInfo.width}x${masterInfo.height}`,
      );
    }
    const thumb = await renderThumb(context, master);
    const squarePath = `/images/agents/${options.revision}/${row.stem}.webp`;
    const thumbPath = `/images/agents/${options.revision}/${row.stem}-128.webp`;
    files.set(squarePath, master);
    files.set(thumbPath, thumb);
    agentsRecord[row.stem] = {
      agentIds: [row.id],
      sourceUrl: `${NANOKA_BASE_URL}${row.stem}.webp`,
      crop: crops[row.stem],
      square: toAssetFile(squarePath, master, masterInfo.width, masterInfo.height),
      thumb: toAssetFile(thumbPath, thumb, THUMB_SIZE_PX, THUMB_SIZE_PX),
    };
  }

  const classificationsRecord: Record<
    string,
    { stem: string; sourceUrl: string; file: AssetFile }
  > = {};
  for (const source of CLASSIFICATION_ICON_SOURCES) {
    const context = `分类 ${source.kind}-${source.id}（${source.stem}）`;
    const data = await readSourceBytes(context, options, `${source.stem}.webp`, source.sourceUrl);
    const info = await inspectWebp(context, data);
    if (info.width > 128 || info.height > 128) {
      fail(context, `分类图标尺寸异常（${info.width}x${info.height}），来源可能变化需人工确认`);
    }
    const path = `/images/classifications/${options.revision}/${source.stem}.webp`;
    files.set(path, data);
    classificationsRecord[`${source.kind}-${source.id}`] = {
      stem: source.stem,
      sourceUrl: source.sourceUrl,
      file: toAssetFile(path, data, info.width, info.height),
    };
  }

  // 旧圆图副本跨修订只增不改：现有清单已收录的记录原样保留、不重新读取
  // 来源（上游后续变化不回写副本）；仅未收录的文件名读取来源并新增记录。
  const existingLegacyCount = existing === null ? 0 : Object.keys(existing.legacyCircles).length;
  const legacyRecord: Record<string, { sourceUrl: string; file: AssetFile }> = {
    ...existing?.legacyCircles,
  };
  for (const row of rows) {
    if (row.avatarUrl === null) continue;
    const fileName = row.avatarUrl.slice(row.avatarUrl.lastIndexOf("/") + 1);
    if (legacyRecord[fileName] !== undefined) continue;
    const context = `旧圆图 ${fileName}`;
    const data = await readSourceBytes(context, options, fileName, row.avatarUrl);
    const info = await inspectWebp(context, data);
    const path = `/images/agents/${LEGACY_DIR}/${fileName}`;
    files.set(path, data);
    legacyRecord[fileName] = {
      sourceUrl: row.avatarUrl,
      file: toAssetFile(path, data, info.width, info.height),
    };
  }

  // ---- 组装并校验清单（schema 含路径与修订目录的耦合不变量） ----
  const manifest: ImageAssetsManifest = imageAssetsManifestSchema.parse({
    revision: options.revision,
    agents: Object.fromEntries(Object.entries(agentsRecord).sort(([a], [b]) => a.localeCompare(b))),
    classifications: classificationsRecord,
    legacyCircles: Object.fromEntries(
      Object.entries(legacyRecord).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });

  // ---- 写入前整批校验（shared/agents/assets-import.ts）：冲突在任何写入
  // 之前失败；通过后仅写入磁盘上缺失的文件，内容一致的文件不重写。 ----
  const plan = await planImportWrite({
    plannedManifest: manifest,
    plannedWritePaths: new Set(files.keys()),
    existingManifest: existing,
    readDiskSha256: async (path) => {
      try {
        return sha256Hex(await readFile(publicFilePath(path)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  });

  for (const path of plan.writes) {
    const data = files.get(path);
    if (data === undefined) {
      fail("写入文件", `${path} 不在本次计划内（校验与写入不一致）`);
    }
    const target = publicFilePath(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: "wx" });
    // 写入后核对字节数，避免部分写入。
    const written = await stat(target);
    if (written.size !== data.byteLength) {
      fail("写入文件", `${target} 写入不完整（${written.size}/${data.byteLength}）`);
    }
  }

  // 清单仅在内容变化时写入（同批幂等重跑不更新文件时间戳）。
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  let currentText: string | null = null;
  try {
    currentText = await readFile(MANIFEST_PATH, "utf8");
  } catch {
    currentText = null;
  }
  if (currentText !== manifestText) {
    await mkdir(dirname(MANIFEST_PATH), { recursive: true });
    await writeFile(MANIFEST_PATH, manifestText, "utf8");
  }

  const newLegacyCount = Object.keys(manifest.legacyCircles).length - existingLegacyCount;
  console.log(
    `已导入图片资源修订 ${options.revision}：${Object.keys(manifest.agents).length} 张方图母图与缩略图、` +
      `${Object.keys(manifest.classifications).length} 个分类图标、` +
      `${Object.keys(manifest.legacyCircles).length} 张旧圆图副本（新收录 ${newLegacyCount}）；` +
      `写入 ${plan.writes.length} 个文件、${plan.unchanged.length} 个内容一致跳过；清单 ${MANIFEST_PATH}。`,
  );
}

/** 清单公开路径 → 仓库内文件系统路径；越界或路径穿越视为数据错误显式失败。 */
function publicFilePath(path: string): string {
  const target = resolve(PUBLIC_ROOT, `.${path}`);
  if (!target.startsWith(`${PUBLIC_ROOT}/`)) {
    fail("公开路径", `路径越界或非法：${JSON.stringify(path)}`);
  }
  return target;
}

void main();
