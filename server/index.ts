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

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** 非 2xx 响应的共享错误体（apiErrorResponseBodySchema）。 */
function apiError(status: number, code: ApiErrorCode, message: string): Response {
  const body: ApiErrorResponseBody = { error: { code, message } };
  return jsonResponse(status, body);
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

/** 解析 JSON 请求体；非法 JSON 返回 400 响应。 */
async function readJsonBody(
  request: Request,
): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
  let data: unknown;
  try {
    data = await request.json();
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

/** `/api/rooms/...` 路由参数；sub 为 null 表示房间本身。 */
interface RoomRoute {
  readonly roomId: string;
  readonly sub: string | null;
}

/**
 * 解析 `/api/rooms/:roomId[/:sub]` 形式的路径。
 * `route` 为 null 表示不匹配房间路由（按未知 /api 路径处理）；
 * `invalid` 为 true 表示 roomId 非法（无法解码或不符合 schema），
 * 由调用方返回 400。
 */
function matchRoomRoute(pathname: string): { invalid: boolean; route: RoomRoute | null } {
  const rest = pathname.slice("/api/rooms/".length);
  const segments = rest.split("/");
  const rawRoomId = segments[0] ?? "";
  if (rawRoomId === "") return { invalid: false, route: null };
  // 只接受 /api/rooms/:roomId 或 /api/rooms/:roomId/:sub，多余路径段按未知路径处理。
  if (segments.length > 2) return { invalid: false, route: null };

  let decodedRoomId: string;
  try {
    decodedRoomId = decodeURIComponent(rawRoomId);
  } catch {
    return { invalid: true, route: null };
  }
  const parsedRoomId = roomIdSchema.safeParse(decodedRoomId);
  if (!parsedRoomId.success) return { invalid: true, route: null };

  return {
    invalid: false,
    route: { roomId: parsedRoomId.data, sub: segments.length > 1 ? segments[1] : null },
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

export default {
  async fetch(request, _env, ctx): Promise<Response> {
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
        const { roomId, sub } = route;
        if (sub === null) {
          if (request.method !== "GET") {
            return apiError(405, "INVALID_REQUEST", "Method Not Allowed");
          }
          return handleRoomEntry(request, ctx, roomId);
        }
        if (sub === "members") {
          if (request.method !== "POST") {
            return apiError(405, "INVALID_REQUEST", "Method Not Allowed");
          }
          return handleJoinRoom(request, ctx, roomId);
        }
        if (sub === "catalog") {
          if (request.method !== "GET") {
            return apiError(405, "INVALID_REQUEST", "Method Not Allowed");
          }
          return handleRoomCatalog(ctx, roomId);
        }
        // 成员实时连接与展示连接（/ws、/display/ws）在 PR5 接入。
      }
    }

    return Response.json({ error: "Not Found" }, { status: 404, headers: JSON_HEADERS });
  },
} satisfies ExportedHandler<Env>;
