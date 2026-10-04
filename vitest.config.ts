import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// 三类测试使用独立项目配置：
// - rules：纯 TypeScript 规则与契约测试，运行在 Node 环境；
// - web：浏览器端纯逻辑回归（表单校验、布局推导、房主面板派生与
//   WS 会话状态机，通过注入假传输驱动），不依赖真实浏览器；
// - workers：房间对象与 Worker 集成测试，运行在真实 workerd（miniflare）。
//
// workers 项目通过 experimental.newConfig 直接读取 cloudflare.config.ts，
// 与 cf dev / cf build / cf deploy 保持同一份绑定与兼容性设置；
// 该组合已在初始化时实际运行验证（见 docs/development.md）。
// 真实浏览器交互验证（多身份上下文、Cookie 隔离与布局截图）按
// docs/development.md「浏览器验收」以本地脚本驱动 cf dev 执行，
// PR10 再决定是否纳入常规门禁与 CI 浏览器准备。
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
        test: {
          name: "web",
          environment: "node",
          include: ["tests/web/**/*.test.ts"],
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
