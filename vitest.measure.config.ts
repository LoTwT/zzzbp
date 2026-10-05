import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// 本地资源测量（PR10）：在真实 workerd + SQLite 上运行有界的测量脚本，
// 为容量/预算估算提供可复现的本地基准。不进入常规门禁（pnpm test 不含
// tests/measure），通过 pnpm measure:rooms 单独执行；结果用于
// docs/specs/cloudflare-budget.md 的估算方法与 docs/release.md 的验收记录。
// 插件与 workers 门禁相同：直接加载 cloudflare.config.ts。
export default defineConfig({
  plugins: [
    cloudflareTest({
      experimental: { newConfig: true },
    }),
  ],
  test: {
    name: "measure",
    include: ["tests/measure/**/*.test.ts"],
    // 测量含多房间 26 步推进与真实 Alarm 触发，单测预算放宽。
    testTimeout: 300_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
