import { readPickLayoutPreference, type PickLayout } from "./pick-layout";

/**
 * 实时展示页的 URL 合同：布局冻结的唯一入口。
 *
 * 原页面「打开展示页」把当时的选用区布局显式写入查询参数；展示页只在
 * 打开时校验并读取一次该参数，之后不再跟随原页面或其他标签页的布局
 * 切换，刷新同一 URL 仍保留打开时的布局。参数缺失或非法时回退读取
 * 本地偏好（readPickLayoutPreference）；展示页绝不把布局写回存储或
 * 共享房间状态（行为见 docs/specs/room-layout.md「实时展示页」）。
 */

/** 布局查询参数名。 */
export const DISPLAY_LAYOUT_QUERY_KEY = "layout";

/** 构建展示页路径：显式携带当前布局，供新标签页打开时冻结继承。 */
export function displayPagePath(roomId: string, layout: PickLayout): string {
  return `/rooms/${encodeURIComponent(roomId)}/display?${DISPLAY_LAYOUT_QUERY_KEY}=${layout}`;
}

/**
 * 从 URL 查询值解析展示页布局：合法值直接采用；缺失、非法（含数组形态
 * 的重复参数）回退本地偏好。只应在展示页挂载时调用一次。
 */
export function displayLayoutFromQuery(value: string | readonly string[] | null): PickLayout {
  if (value === "vertical" || value === "byPick") return value;
  return readPickLayoutPreference();
}
