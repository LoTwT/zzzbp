import { defineConfig, exports } from "cf/config";
import * as entrypoint from "./server/index.ts" with { type: "cf-worker" };

// 单一部署单元：一个 Worker 同时分发静态资源并处理 /api/* 动态请求。
// 前端静态资源来自 Vite 客户端构建产物，cf 会自动接线，无需在此声明目录。
export default defineConfig({
  worker: {
    name: "zzzbp",
    entrypoint,
    compatibilityDate: "2026-09-01",
    assets: {
      // 未匹配静态资源的导航请求回退到 index.html，支持 SPA 前端路由。
      notFoundHandling: "single-page-application",
      // /api/* 始终先进入 Worker，不参与静态资源匹配，也不受 SPA 回退影响。
      runWorkerFirst: ["/api/*"],
    },
    exports: {
      // 每个房间一个 SQLite Durable Object；生命周期由 exports 声明统一维护。
      Room: exports.durableObject({ storage: "sqlite" }),
    },
  },
});
