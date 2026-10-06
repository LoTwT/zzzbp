/**
 * 实时展示页的 URL 合同。
 *
 * 展示页沿用与操作页一致的九格竖排选用区，没有可继承的布局设置：
 * 「打开展示页」只构建房间的展示页路径，展示页不做布局参数解析，也
 * 不读写本地偏好（行为见 docs/specs/room-layout.md「实时展示页」）。
 */

/** 构建展示页路径：房间 ID 参与路径编码，不注入路径结构。 */
export function displayPagePath(roomId: string): string {
  return `/rooms/${encodeURIComponent(roomId)}/display`;
}
