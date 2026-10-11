/*
 * 图片资源的运行时公开路径构造与旧远程地址解析。
 *
 * 本模块是图片 URL 布局的唯一所有者：方图母图、128 缩略图与分类图标的
 * 公开路径构造、方图稳定路径的反向解析、旧远程圆图 URL 到同源本地副本的
 * 精确映射都集中在此，组件与投影不自行拼接。文件事实（来源、字节数、
 * 哈希、尺寸、裁切校准值）由 shared/agents/assets.json 维护，只在导入/
 * 生成脚本与测试中使用，不进入任何运行时 bundle。
 *
 * URL 布局与不可变修订的约定见 docs/specs/agent-data.md「图片资源清单」：
 * - 方图与缩略图：/images/agents/<修订>/<主干>.webp 与 <主干>-128.webp；
 * - 分类图标：/images/classifications/<修订>/<主干>.webp；
 * - 旧圆图本地副本：/images/agents/legacy/<原文件名>.webp（保留旧房间与
 *   归档仍引用的文件，不按发布期限删除）。
 */

/** 安全的资源段（与 shared/agents/schema.ts 的 imageAssetNameSchema 同域）。 */
const ASSET_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 旧远程圆图来源的固定前缀（toAgentImageUrl 派生产物的域名）。 */
const LEGACY_REMOTE_BASE_URL = "https://static.nanoka.cc/assets/zzz/";

/**
 * 上游已确认的图片资源固定前缀。
 *
 * 依据 fairy 上游 nanoka 来源规格（docs/specs/nanoka/source.md
 * 「已确认的图片地址规则」，2026-09-14 实测）：非空 `.png` 来源图片路径
 * 去掉首尾空白与原目录、扩展名改 `.webp` 后拼接该前缀。
 */
const AGENT_IMAGE_BASE_URL = LEGACY_REMOTE_BASE_URL;

/**
 * 由数据包记录的来源图片路径派生可加载的图片 URL。
 *
 * 这是上游文档记录的消费时转换，不是按图标编号猜文件名：原始路径保留
 * 在目录产物中，完整 URL 只在消费边界派生。归档映射与后续界面共用本
 * 函数，不在别处重复实现转换。
 *
 * 仅适用于非空、以 `.png` 结尾的来源图片路径；`live2_d` 等无图片扩展名
 * 的动画资源标识不适用。无来源路径或输入不满足规则时返回 null，不制造
 * 图片地址。浏览器与部署环境的实际可达性由资源导入
 * （scripts/import-image-assets.ts）在显式更新时核验，本函数不做网络请求。
 */
export function toAgentImageUrl(sourcePath: string | null): string | null {
  if (sourcePath === null) return null;
  const fileName = sourcePath.trim().split("/").pop() ?? "";
  if (!/^[^/]+\.png$/i.test(fileName)) return null;
  return `${AGENT_IMAGE_BASE_URL}${fileName.replace(/\.png$/i, ".webp")}`;
}

/** 旧圆图本地副本的根路径。 */
const LEGACY_CIRCLE_LOCAL_DIR = "/images/agents/legacy";

/** 旧圆图文件名形态：IconRoleCircleNN.webp。 */
const LEGACY_CIRCLE_FILE_PATTERN = /^IconRoleCircle[0-9]+\.webp$/;

/** 方图稳定路径形态：/images/agents/<修订>/<主干>.webp（legacy 目录除外）。 */
const SQUARE_URL_PATTERN =
  /^\/images\/agents\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.webp$/;

/** 校验资源段；非法输入是编程错误（调用方的数据已经过 schema 校验），显式失败。 */
function requireAssetSegment(name: string): string {
  if (!ASSET_SEGMENT_PATTERN.test(name)) {
    throw new Error(`非法的图片资源段：${JSON.stringify(name)}`);
  }
  return name;
}

/** 384x384 方图母图的公开路径（选用区宽幅裁切与池内方图共用同一母图）。 */
export function agentSquareImageUrl(revision: string, icon: string): string {
  return `/images/agents/${requireAssetSegment(revision)}/${requireAssetSegment(icon)}.webp`;
}

/** 128x128 缩略图的公开路径（与母图同一资源修订，供顶部禁用区使用）。 */
export function agentThumbImageUrl(revision: string, icon: string): string {
  return `/images/agents/${requireAssetSegment(revision)}/${requireAssetSegment(icon)}-128.webp`;
}

/** 分类图标的公开路径（源图保持比例显示，不要求正方形素材）。 */
export function classificationIconImageUrl(revision: string, icon: string): string {
  return `/images/classifications/${requireAssetSegment(revision)}/${requireAssetSegment(icon)}.webp`;
}

/**
 * 旧远程圆图 URL 精确映射到同源本地副本（仅限实际已收录的文件）。
 *
 * 只重写 toAgentImageUrl 域内、文件名完全匹配 IconRoleCircleNN.webp 且
 * localFileNames 已收录该文件名的地址（文件名保持不变，不按角色 ID 推测
 * 新路径）；localFileNames 是目录产物内嵌的清单摘要，legacy 副本跨修订
 * 只增不改，当前构建的摘要对旧目录/旧归档同样成立。未收录的 URL 原样
 * 返回，由展示层按外部图片处理（失败走占位兜底，不自动重试热链）——
 * 形似而未收录的文件名不得被误指向不存在的本地路径。
 */
export function localizeLegacyAgentImageUrl(
  url: string,
  localFileNames: ReadonlySet<string>,
): string {
  if (!url.startsWith(LEGACY_REMOTE_BASE_URL)) return url;
  const fileName = url.slice(LEGACY_REMOTE_BASE_URL.length);
  if (!LEGACY_CIRCLE_FILE_PATTERN.test(fileName)) return url;
  return localFileNames.has(fileName) ? `${LEGACY_CIRCLE_LOCAL_DIR}/${fileName}` : url;
}

/** URL 是否为旧圆图的本地副本路径。 */
export function isLegacyCircleImageUrl(url: string): boolean {
  if (!url.startsWith(`${LEGACY_CIRCLE_LOCAL_DIR}/`)) return false;
  return LEGACY_CIRCLE_FILE_PATTERN.test(url.slice(LEGACY_CIRCLE_LOCAL_DIR.length + 1));
}

/**
 * 从方图稳定路径反向解析（修订, 主干）；非本站方图路径返回 null。
 *
 * 旧记录页从归档保存的稳定路径定位缩略图（<主干>-128.webp）与所属资源
 * 修订；legacy 目录不是方图修订，返回 null。
 */
export function parseAgentSquareImageUrl(url: string): { revision: string; icon: string } | null {
  const match = SQUARE_URL_PATTERN.exec(url);
  if (match === null || match[1] === LEGACY_CIRCLE_LOCAL_DIR.split("/").at(-1)) return null;
  return { revision: match[1], icon: match[2] };
}
