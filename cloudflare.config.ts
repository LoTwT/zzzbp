import { defineConfig, exports } from "cf/config";
import * as entrypoint from "./server/index.ts" with { type: "cf-worker" };

// 单一部署单元：一个 Worker 同时分发静态资源并处理 /api/* 动态请求。
// 前端静态资源来自 Vite 客户端构建产物，cf 会自动接线，无需在此声明目录。
//
// 预发布目标（操作步骤见 docs/deployment.md）：`cf deploy -m preview` 使用独立
// Worker 名 zzzbp-preview，从而获得独立的 Durable Object 命名空间与房间存储，
// 不触碰正式名 zzzbp 及其将来可能的线上数据；未指定或其它 mode 沿用 zzzbp。
// cf 官方支持在配置工厂中按 ctx.mode 派生名称。
export default defineConfig(({ mode }) => ({
  worker: {
    name: mode === "preview" ? "zzzbp-preview" : "zzzbp",
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
    // 可观测性按低成本约束显式配置，不依赖平台或账户默认值（语义见
    // docs/architecture.md「可观测性与错误诊断」）。日志开启并保留
    // 100% 头部采样，使错误诊断不会被随机丢弃，但关闭逐请求 invocation
    // log：成功请求不产生日志，只保留应用主动输出的结构化错误日志。
    // trace 开启并按 5% 头部采样，控制存储与 2026-12-01 起的计费用量；
    // 日志与 trace 中的查询串一律脱敏。
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: {
        enabled: true,
        headSamplingRate: 1,
        invocationLogs: false,
      },
      traces: {
        enabled: true,
        headSamplingRate: 0.05,
      },
    },
  },
}));
