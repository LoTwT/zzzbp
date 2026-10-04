import { agentCatalogData } from "../shared/agents/catalog";
import { BP_RULE_VERSION } from "../shared/bp/version";
import type { ApiErrorResponseBody, ApiErrorCode } from "../shared/contracts/http";
import { createRoomRequestSchema } from "../shared/contracts/http";
import { joinRoomRequestSchema } from "../shared/contracts/http";
import { roomIdSchema } from "../shared/ids";
import {
  credentialDigest,
  generateMemberId,
  generateMemberSecret,
  generateRoomId,
  readRoomCookieSecret,
  serializeRoomCookie,
} from "./credentials";
import { Room } from "./room";

export { Room };

/**
 * Worker 动态入口。静态资源与 SPA 回退由静态资源层处理，这里只负责
 * `/api/*`；路由分流规则见 cloudflare.config.ts。
 *
 * Worker 承担路由、输入校验、身份 Cookie 的生成与读取；房间对象拥有
 * 最终决定权：角色、席位与成员视图一律由房间持久状态派生（见
 * server/room.ts 与 docs/architecture.md）。
 */

/** `/api/*` JSON 响应的公共头：明确不缓存。 */
const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

/**
 * JSON 请求体的字节上限：8 KiB。
 *
 * 当前两个表单（房名 80 码点、昵称 24 码点，UTF-8 最长约 416 字节）
 * 远小于该值，这些入口没有接收大 body 的需求；超限请求在流式读取时
 * 尽早拒绝，避免把任意大小的 body 完整缓冲进 128 MiB 的 isolate 内存。
 */
const MAX_JSON_BODY_BYTES = 8 * 1024;

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/**
 * 统一错误边界的结构化诊断：只输出静态分类与请求关联信息。
 *
 * 记录字段固定为白名单：事件名、本次请求生成的 requestId、HTTP 方法、
 * 路径（不含查询串）与静态分类 `internal`。错误自身的 message、name、
 * cause、stack 及任何原始错误值一律不写入应用日志：统一边界无法甄别
 * 任意异常内容，这些字段可能携带上游或请求相关的敏感输入（例如请求体
 * 流读取失败的异常消息）；可自定义的 error.name 不是可信分类。需要更细
 * 的稳定分类时应在抛出点定义，不由边界透传错误自带字段。请求头、Cookie、
 * 请求体、凭据秘密或摘要同样不记录。客户端继续只收到通用 500 错误体，
 * 响应通过 X-Request-Id 头返回同一 requestId，便于把现场报告与这条
 * 日志对照。
 */
function logInternalError(request: Request, requestId: string): void {
  console.error(
    JSON.stringify({
      event: "api.internal_error",
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      errorKind: "internal",
    }),
  );
}

/** 非 2xx 响应的共享错误体（apiErrorResponseBodySchema）。 */
function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  headers?: Record<string, string>,
): Response {
  const body: ApiErrorResponseBody = { error: { code, message } };
  return jsonResponse(status, body, headers);
}

/**
 * 同源校验：带凭据的写请求不得来自第三方 Origin。
 * 浏览器同源请求可能不带 Origin（如无 CORS 的表单/工具请求），此时放行，
 * 跨站防护由 SameSite=Lax Cookie 与本检查共同承担；携带 Origin 且与请求
 * URL 不同源时拒绝。
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/**
 * 解析 JSON 请求体：按实际字节数流式读取，超限尽早拒绝（413）；
 * 非法 JSON 返回 400。Content-Length 只用于快速拒绝明确超限的声明，
 * 缺失或不真实的 header 不能绕过流式计数。
 */
async function readJsonBody(
  request: Request,
): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > MAX_JSON_BODY_BYTES) {
      return { ok: false, response: apiError(413, "INVALID_REQUEST", "请求体过大") };
    }
  }

  let receivedBytes = 0;
  let text = "";
  if (request.body !== null) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_JSON_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // 取消剩余传输失败不影响拒绝响应。
        }
        return { ok: false, response: apiError(413, "INVALID_REQUEST", "请求体过大") };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, response: apiError(400, "INVALID_REQUEST", "请求体必须是合法 JSON") };
  }
  return { ok: true, data };
}

/** 取 Zod 校验失败的首条 issue 描述（路径 + 消息），供 400 响应体使用。 */
function zodIssueSummary(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  const issue = error.issues[0];
  if (issue === undefined) return "格式不正确";
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}：${issue.message}`;
}

/** `/api/rooms/...` 路由参数；subPath 为 null 表示房间本身。 */
interface RoomRoute {
  readonly roomId: string;
  readonly subPath: string | null;
}

/**
 * 解析 `/api/rooms/:roomId[/:subPath]` 形式的路径，subPath 最多两段
 * （覆盖 `display/ws`）。
 * `route` 为 null 表示不匹配房间路由（按未知 /api 路径处理）；
 * `invalid` 为 true 表示 roomId 非法（无法解码或不符合 schema），
 * 由调用方返回 400。
 */
function matchRoomRoute(pathname: string): { invalid: boolean; route: RoomRoute | null } {
  const rest = pathname.slice("/api/rooms/".length);
  const segments = rest.split("/");
  const rawRoomId = segments[0] ?? "";
  if (rawRoomId === "") return { invalid: false, route: null };
  // 只接受 /api/rooms/:roomId、/:roomId/:sub 或 /:roomId/:sub/:sub2，
  // 更多路径段按未知路径处理。
  if (segments.length > 3) return { invalid: false, route: null };

  let decodedRoomId: string;
  try {
    decodedRoomId = decodeURIComponent(rawRoomId);
  } catch {
    return { invalid: true, route: null };
  }
  const parsedRoomId = roomIdSchema.safeParse(decodedRoomId);
  if (!parsedRoomId.success) return { invalid: true, route: null };

  const subPath = segments.length > 1 ? segments.slice(1).join("/") : null;
  return {
    invalid: false,
    route: { roomId: parsedRoomId.data, subPath },
  };
}

function roomStub(ctx: ExecutionContext, roomId: string) {
  const id = ctx.exports.Room.idFromName(roomId);
  return ctx.exports.Room.get(id);
}

/** 读取请求携带的房间身份凭据并计算摘要；无凭据返回 null。 */
async function requestCredentialDigest(request: Request, roomId: string): Promise<string | null> {
  const secret = readRoomCookieSecret(request, roomId);
  return secret === null ? null : await credentialDigest(secret);
}

/** POST /api/rooms：创建房间 + 首位房主成员，下发房主身份 Cookie。 */
async function handleCreateRoom(request: Request, ctx: ExecutionContext): Promise<Response> {
  if (!isSameOrigin(request)) {
    return apiError(403, "INVALID_REQUEST", "拒绝跨源请求");
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = createRoomRequestSchema.safeParse(body.data);
  if (!parsed.success) {
    return apiError(400, "INVALID_REQUEST", `建房请求不合法：${zodIssueSummary(parsed.error)}`);
  }

  // 房间/成员 ID 与凭据均由服务端生成；载荷中的自报字段已被 schema 剥离。
  const roomId = generateRoomId();
  const hostMemberId = generateMemberId();
  const secret = generateMemberSecret();
  const digest = await credentialDigest(secret);

  const result = await roomStub(ctx, roomId).createRoom({
    roomId,
    name: parsed.data.roomName,
    hostMemberId,
    nickname: parsed.data.nickname,
    credentialDigest: digest,
    ruleVersion: BP_RULE_VERSION,
    // 建房时固定当前部署的目录快照；此后该房间不再读全局目录。
    catalogJson: JSON.stringify(agentCatalogData),
  });
  if (result.kind !== "created") {
    return apiError(500, "INTERNAL", "房间创建失败，请重试");
  }

  return jsonResponse(
    201,
    { roomId, memberView: result.memberView },
    { "Set-Cookie": serializeRoomCookie(roomId, secret) },
  );
}

/** GET /api/rooms/:roomId：按生命周期分流；live 按身份返回成员视图。 */
async function handleRoomEntry(
  request: Request,
  ctx: ExecutionContext,
  roomId: string,
): Promise<Response> {
  const credentialDigestValue = await requestCredentialDigest(request, roomId);
  const entry = await roomStub(ctx, roomId).getRoomEntry({
    credentialDigest: credentialDigestValue,
  });

  if (entry.kind === "not_found") {
    return apiError(404, "ROOM_NOT_FOUND", "房间不存在");
  }
  if (entry.kind === "archived") {
    // 防御分支：本 PR 没有任何把房间转为 archived 的路径；只读快照的读取
    // 由 PR9 实现并替换本分支。
    return apiError(410, "ROOM_ARCHIVED", "房间已归档");
  }

  return jsonResponse(200, {
    kind: "live",
    roomName: entry.roomName,
    memberView: entry.memberView,
  });
}

/** POST /api/rooms/:roomId/members：新观众加入或恢复原身份。 */
async function handleJoinRoom(
  request: Request,
  ctx: ExecutionContext,
  roomId: string,
): Promise<Response> {
  if (!isSameOrigin(request)) {
    return apiError(403, "INVALID_REQUEST", "拒绝跨源请求");
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = joinRoomRequestSchema.safeParse(body.data);
  if (!parsed.success) {
    return apiError(400, "INVALID_REQUEST", `入房请求不合法：${zodIssueSummary(parsed.error)}`);
  }

  const credentialDigestValue = await requestCredentialDigest(request, roomId);
  // 预生成新身份材料：凭据无效时由房间对象写入，恢复原身份时丢弃，不轮换。
  const newMemberId = generateMemberId();
  const newSecret = generateMemberSecret();
  const newDigest = await credentialDigest(newSecret);

  const result = await roomStub(ctx, roomId).joinRoom({
    nickname: parsed.data.nickname,
    credentialDigest: credentialDigestValue,
    newMemberId,
    newCredentialDigest: newDigest,
  });
  if (result.kind === "not_found") {
    return apiError(404, "ROOM_NOT_FOUND", "房间不存在");
  }
  if (result.kind === "archived") {
    return apiError(410, "ROOM_ARCHIVED", "房间已归档");
  }

  if (result.kind === "restored") {
    // 恢复身份不轮换凭据，不下发新 Cookie。
    return jsonResponse(200, { memberView: result.memberView });
  }
  return jsonResponse(
    200,
    { memberView: result.memberView },
    { "Set-Cookie": serializeRoomCookie(roomId, newSecret) },
  );
}

/** GET /api/rooms/:roomId/catalog：该房间固定的目录快照（只读，无需身份）。 */
async function handleRoomCatalog(ctx: ExecutionContext, roomId: string): Promise<Response> {
  const catalog = await roomStub(ctx, roomId).getRoomCatalog();
  if (catalog === null) {
    return apiError(404, "ROOM_NOT_FOUND", "房间不存在");
  }
  return jsonResponse(200, catalog);
}

/**
 * 房间实时连接升级（成员 `/ws` 与展示 `/display/ws`）。
 *
 * Worker 只做协议级校验（方法、Upgrade 头、同源 Origin）并把原始请求
 * 转发给房间 DO；房间存在性、生命周期与成员身份由 DO 在升级时判断
 * （见 server/room.ts 的 fetch）。非升级请求不进入 DO。
 */
async function handleRoomWebSocket(
  request: Request,
  ctx: ExecutionContext,
  roomId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return apiError(405, "INVALID_REQUEST", "Method Not Allowed");
  }
  const upgrade = request.headers.get("Upgrade");
  if (upgrade === null || upgrade.toLowerCase() !== "websocket") {
    return apiError(426, "INVALID_REQUEST", "WebSocket 升级需要 Upgrade: websocket 头");
  }
  if (!isSameOrigin(request)) {
    return apiError(403, "INVALID_REQUEST", "拒绝跨源请求");
  }
  return roomStub(ctx, roomId).fetch(request);
}

/** `/api/*` 路由分发；未预期异常由 fetch 的统一错误边界捕获。 */
async function handleApiRequest(request: Request, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (!pathname.startsWith("/api/")) {
    // 不属于动态入口的未匹配请求：交回静态资源层处理（含 SPA 回退）。
    return new Response(null, { status: 404 });
  }

  // 引导期存储链路自检（既有契约，见 shared/api.ts）。
  if (pathname === "/api/health") {
    if (request.method !== "GET") {
      return apiError(405, "INVALID_REQUEST", "Method Not Allowed");
    }
    const id = ctx.exports.Room.idFromName("bootstrap-health");
    const room = ctx.exports.Room.get(id);
    const info = await room.ensureCreated();
    return jsonResponse(200, { ok: true, room: info });
  }

  if (pathname === "/api/rooms" || pathname === "/api/rooms/") {
    if (request.method !== "POST") {
      return apiError(405, "INVALID_REQUEST", "Method Not Allowed");
    }
    return handleCreateRoom(request, ctx);
  }

  if (pathname.startsWith("/api/rooms/")) {
    const { invalid, route } = matchRoomRoute(pathname);
    if (invalid) {
      return apiError(400, "INVALID_REQUEST", "非法的房间 ID");
    }
    if (route !== null) {
      const { roomId, subPath } = route;
      if (subPath === null) {
        if (request.method !== "GET") {
          return apiError(405, "INVALID_REQUEST", "Method Not Allowed");
        }
        return handleRoomEntry(request, ctx, roomId);
      }
      if (subPath === "members") {
        if (request.method !== "POST") {
          return apiError(405, "INVALID_REQUEST", "Method Not Allowed");
        }
        return handleJoinRoom(request, ctx, roomId);
      }
      if (subPath === "catalog") {
        if (request.method !== "GET") {
          return apiError(405, "INVALID_REQUEST", "Method Not Allowed");
        }
        return handleRoomCatalog(ctx, roomId);
      }
      if (subPath === "ws" || subPath === "display/ws") {
        return handleRoomWebSocket(request, ctx, roomId);
      }
    }
  }

  return Response.json({ error: "Not Found" }, { status: 404, headers: JSON_HEADERS });
}

export default {
  async fetch(request, _env, ctx): Promise<Response> {
    try {
      // 异步路由必须在边界内被 await：只包 return 不 await 捕不到异步 reject。
      return await handleApiRequest(request, ctx);
    } catch {
      // 统一错误边界：任何未预期异常（DO RPC、SQLite、状态装配、请求体
      // 读取等）只向客户端返回通用 500 共享错误体与 X-Request-Id 关联
      // ID，不泄漏 SQL 错误、内部状态或凭据，也不交付 Cookie；服务端只
      // 记录静态分类与请求关联字段，不记录错误内容、请求头、Cookie 或
      // 请求体。
      const requestId = crypto.randomUUID();
      logInternalError(request, requestId);
      return apiError(500, "INTERNAL", "服务器内部错误，请稍后重试", {
        "X-Request-Id": requestId,
      });
    }
  },
} satisfies ExportedHandler<Env>;
