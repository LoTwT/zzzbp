/**
 * 房间成员身份凭据与 Cookie 的服务端实现。
 *
 * 边界（正文见 docs/architecture.md「身份与凭据边界」）：
 * - 凭据是服务端生成的强随机不可猜秘密（256 位），仅在 Set-Cookie 响应中
 *   向浏览器交付一次；服务端只保存其 SHA-256 摘要，原始秘密不进入任何
 *   JSON 响应、共享状态或日志。
 * - 每个房间一个独立命名的 Cookie，多房间身份互不覆盖；恢复身份时
 *   不轮换凭据。
 * - Durable Object 内部只按摘要等值查找（摘要唯一约束），原始秘密
 *   不跨 RPC 传递。
 */

/** 房间身份 Cookie 名称前缀；后接房间 ID，一房一 Cookie。 */
export const ROOM_COOKIE_PREFIX = "zzzbp_room_";

/**
 * Cookie 有效期：90 天。
 *
 * 覆盖房间最长保留窗口（live 期 + 12 小时空房 + 90 天只读快照）的量级；
 * 过期后浏览器丢失身份，按新观众重新入房，不影响房间数据。
 */
export const ROOM_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/** 房间身份 Cookie 的名称：按房间 ID 区分，多房间共存。 */
export function roomCookieName(roomId: string): string {
  return `${ROOM_COOKIE_PREFIX}${roomId}`;
}

/** 生成房间 ID：随机 UUID（122 位随机性，出现在房间链接中且不可猜）。 */
export function generateRoomId(): string {
  return crypto.randomUUID();
}

/** 生成成员 ID：随机 UUID，与昵称无关、不承载身份语义。 */
export function generateMemberId(): string {
  return crypto.randomUUID();
}

/** 生成成员凭据秘密：32 字节强随机，十六进制编码（Cookie 安全字符集）。 */
export function generateMemberSecret(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** 计算凭据摘要：SHA-256 十六进制；服务端只保存与比较摘要。 */
export async function credentialDigest(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return toHex(new Uint8Array(digest));
}

/** 序列化房间身份 Cookie；各属性的含义与取舍见 docs/architecture.md。 */
export function serializeRoomCookie(roomId: string, secret: string): string {
  return [
    `${roomCookieName(roomId)}=${secret}`,
    "Path=/",
    `Max-Age=${ROOM_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    // 部署入口为 HTTPS；本地 http://localhost 也被浏览器视为安全上下文。
    "Secure",
    // 顶层导航（打开房间链接）仍携带 Cookie 以恢复身份；跨站 POST 不携带，
    // 服务端另有同源 Origin 校验兜底。
    "SameSite=Lax",
  ].join("; ");
}

/**
 * 从请求 Cookie 头读取该房间的身份凭据秘密；不存在时返回 null。
 * 凭据值为十六进制，无需 URL 解码；读到的任意字符串只用于摘要计算，
 * 无法匹配即按匿名处理。
 */
export function readRoomCookieSecret(request: Request, roomId: string): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;

  const target = roomCookieName(roomId);
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    // 无 "=" 或空名称的片段直接跳过。
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator) === target) return trimmed.slice(separator + 1);
  }
  return null;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
