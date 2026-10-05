import { defineConfig } from "vitest/config";

// E2E 浏览器验收（PR10）：Node 环境的 Vitest 项目，用 Playwright 驱动
// 真实 cf dev 服务（Vite 前端 + 本地 workerd Worker/DO/SQLite），不 mock
// 建房/入房/命令结果。与常规门禁分离（pnpm test 不包含本项目），
// 通过 pnpm test:e2e 单独执行；服务由 globalSetup 启动并在退出时收尾。
//
// 选型说明（docs/development.md「测试组织」）：多身份 Cookie 隔离、
// 多页面同步与 routeWebSocket 断线注入需要并行浏览器上下文与页面级
// 拦截，从 Node 驱动 Playwright 是最直接的方式；@vitest/browser-playwright
// 的测试代码运行在浏览器页面内，不适合作为多上下文编排入口，故未采用。
// 测试统一仍以 Vitest 为入口，不引入第二套门禁。
export default defineConfig({
  test: {
    name: "e2e",
    environment: "node",
    include: ["tests/e2e/**/*.spec.ts"],
    globalSetup: ["tests/e2e/global-setup.ts"],
    // 单条主线覆盖完整 26 步 + 撤回/重开，留足真实 workerd 往返余量。
    testTimeout: 240_000,
    hookTimeout: 120_000,
    // 共享同一个 dev 服务：按文件串行，避免多个浏览器实例互相争用资源。
    fileParallelism: false,
    // 失败即失败：不配置宽松重试。
    retry: 0,
  },
});
