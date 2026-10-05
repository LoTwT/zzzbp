import { mkdirSync, writeFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import type { Reporter } from "vitest/node";

// 本地资源测量（PR10）：在真实 workerd + SQLite 上运行有界的测量脚本，
// 为容量/预算估算提供可复现的本地基准。不进入常规门禁（pnpm test 不含
// tests/measure），通过 pnpm measure:rooms 单独执行；结果用于
// docs/specs/cloudflare-budget.md 的估算方法与 docs/release.md 的验收记录。
// 插件与 workers 门禁相同：直接加载 cloudflare.config.ts。
//
// 输出稳定性：测试用 ===MEASURE-REPORT-BEGIN=== / ===MEASURE-REPORT-END===
// 标记包裹 JSON 报告；下面的 reporter 把全部报告段持久化到
// node_modules/.tmp/measure-report.json 并向标准输出打印路径——即使终端
// 捕获或 reporter 行为差异导致 console 输出缺失，基准仍可留存与复查。

const REPORT_BEGIN = "===MEASURE-REPORT-BEGIN===";
const REPORT_END = "===MEASURE-REPORT-END===";
const REPORT_PATH = "node_modules/.tmp/measure-report.json";

function measureReportReporter(): Reporter {
  const logLines: string[] = [];
  return {
    onUserConsoleLog(log: { content: string }) {
      logLines.push(log.content);
    },
    onTestRunEnd() {
      const text = logLines.join("\n");
      const reports: unknown[] = [];
      let index = 0;
      for (;;) {
        const begin = text.indexOf(REPORT_BEGIN, index);
        if (begin < 0) break;
        const end = text.indexOf(REPORT_END, begin);
        if (end < 0) break;
        const body = text.slice(begin + REPORT_BEGIN.length, end).trim();
        try {
          reports.push(JSON.parse(body));
        } catch {
          reports.push({ raw: body });
        }
        index = end + REPORT_END.length;
      }
      mkdirSync("node_modules/.tmp", { recursive: true });
      writeFileSync(
        REPORT_PATH,
        `${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`,
      );
      // reporter 运行在 Node 主进程：直接写标准输出，不受 worker 日志管道影响。
      process.stdout.write(`[measure] 基准报告（${reports.length} 段）已写入 ${REPORT_PATH}\n`);
    },
  };
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      experimental: { newConfig: true },
    }),
  ],
  test: {
    name: "measure",
    include: ["tests/measure/**/*.test.ts"],
    reporters: ["default", measureReportReporter()],
    // 含多房间 26 步推进与真实 Alarm 触发，单测预算放宽。
    testTimeout: 300_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
