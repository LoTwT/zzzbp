import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// 两类测试使用独立项目配置：
// - rules：纯 TypeScript 规则与契约测试，运行在 Node 环境；
// - workers：房间对象与 Worker 集成测试，运行在真实 workerd（miniflare）。
//
// workers 项目通过 experimental.newConfig 直接读取 cloudflare.config.ts，
// 与 cf dev / cf build / cf deploy 保持同一份绑定与兼容性设置；
// 该组合已在初始化时实际运行验证（见 docs/development.md）。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "rules",
          environment: "node",
          include: ["tests/rules/**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            experimental: { newConfig: true },
          }),
        ],
        test: {
          name: "workers",
          include: ["tests/workers/**/*.test.ts"],
        },
      },
    ],
  },
});
