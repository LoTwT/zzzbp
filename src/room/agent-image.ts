import {
  agentSquareImageUrl,
  agentThumbImageUrl,
  isLegacyCircleImageUrl,
  localizeLegacyAgentImageUrl,
  parseAgentSquareImageUrl,
} from "../../shared/agents/assets";
import { localLegacyCircleFileNames, toAgentImageUrl } from "../../shared/agents/catalog";
import type { ImageCrop } from "../../shared/agents/schema";

/**
 * 代理人图片的展示解释：把数据来源（新目录的图片资源引用、旧目录的
 * avatarPath、归档保存的稳定路径/URL）统一翻译为共用图片组件可消费的
 * 形态（docs/specs/room-layout.md「代理人头像」）。
 *
 * - 新目录条目与归档的方图稳定路径 → kind "square"：池内方图与选用区
 *   宽幅裁切（object-fit: cover + 逐角色 object-position）共用同一母图，
 *   顶部禁用区使用同修订的 128 缩略图；
 * - 旧圆图（远程 URL 或本地副本）→ kind "circle"：按素材原比例完整
 *   contain 展示，不裁切放大；
 * - 其余未知 URL → kind "external"：原样加载、contain 展示，加载失败走
 *   占位兜底，不推测新路径、不重新热链。
 */

/** 共用图片组件消费的图片展示信息；无任何图片资源时为 null（占位兜底）。 */
export interface AgentImageDisplay {
  readonly kind: "square" | "circle" | "external";
  /** 主图 URL：方图为 384x384 母图，其余为可直接加载的图片地址。 */
  readonly url: string;
  /** 128x128 缩略图 URL（仅方图；顶部禁用区使用，缺省回退主图）。 */
  readonly thumbUrl: string | null;
  /** 宽幅槽位的 object-position 百分比（仅方图；其余为 null）。 */
  readonly crop: ImageCrop | null;
}

/** 旧目录条目的图片解释：avatarPath 派生旧圆图 URL，仅已收录者映射本地副本。 */
export function legacyAgentImage(avatarPath: string | null): AgentImageDisplay | null {
  const remote = toAgentImageUrl(avatarPath);
  if (remote === null) return null;
  const url = localizeLegacyAgentImageUrl(remote, localLegacyCircleFileNames);
  return {
    kind: isLegacyCircleImageUrl(url) ? "circle" : "external",
    url,
    thumbUrl: null,
    crop: null,
  };
}

/** 新目录条目的图片解释：资源修订内的方图母图、缩略图与宽幅裁切。 */
export function squareAgentImage(
  revision: string,
  icon: string,
  crop: ImageCrop,
): AgentImageDisplay {
  return {
    kind: "square",
    url: agentSquareImageUrl(revision, icon),
    thumbUrl: agentThumbImageUrl(revision, icon),
    crop,
  };
}

/**
 * 归档保存地址的图片解释（只读记录页）。
 *
 * 方图稳定路径携带修订与主干（缩略图由此派生）；旧远程圆图 URL 映射到
 * 本地副本；裁切位置取归档时固定的 agentAvatarCrop，旧快照缺省为 null
 * （方图退回默认居中裁切，不依赖当前最新目录或可变默认配置）。
 */
export function agentImageFromSavedUrl(
  url: string | null,
  crop: ImageCrop | null | undefined,
): AgentImageDisplay | null {
  if (url === null) return null;
  const square = parseAgentSquareImageUrl(url);
  if (square !== null) {
    return {
      kind: "square",
      url,
      thumbUrl: agentThumbImageUrl(square.revision, square.icon),
      crop: crop ?? null,
    };
  }
  const resolved = localizeLegacyAgentImageUrl(url, localLegacyCircleFileNames);
  return {
    kind: isLegacyCircleImageUrl(resolved) ? "circle" : "external",
    url: resolved,
    thumbUrl: null,
    crop: null,
  };
}
