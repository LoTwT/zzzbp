import { Room } from "./room";

export { Room };

/**
 * Worker 动态入口。静态资源与 SPA 回退由静态资源层处理，
 * 这里只负责 `/api/*`；路由分流规则见 cloudflare.config.ts。
 */
export default {
  async fetch(request, _env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/health") {
      // 用一个固定的房间名做存储链路自检：真实房间按房间 ID 定位。
      const id = ctx.exports.Room.idFromName("bootstrap-health");
      const room = ctx.exports.Room.get(id);
      const info = await room.ensureCreated();
      return Response.json({ ok: true, room: info });
    }

    if (pathname.startsWith("/api/")) {
      return Response.json({ error: "Not Found" }, { status: 404 });
    }

    // 不属于动态入口的未匹配请求：交回静态资源层处理（含 SPA 回退）。
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
