import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_BASE_URL, E2E_PORT } from "./server";

/**
 * E2E 的服务生命周期：globalSetup 启动真实 `cf dev`（Vite 前端 + 本地
 * workerd），就绪后交给测试进程使用；teardown 只终止本任务启动的进程
 * 组并清理临时持久化目录。
 *
 * 进程纪律（docs/development.md「测试组织」）：
 * - 端口默认 4517（可用 ZZZBP_E2E_PORT 覆盖），不占用 5173，也不影响
 *   用户自己运行的任何实例；若端口已被占用则直接失败，绝不终止他人进程。
 * - cf dev 以独立进程组启动（detached），退出时对该进程组发信号，只
 *   管理自己启动的实例；SIGTERM 后有 SIGKILL 兜底。setup 失败同样回收。
 * - workerd 本地持久化使用一次性临时目录（vite.config.ts 读取
 *   ZZZBP_DEV_PERSIST_STATE 注入），测试房间数据与开发状态互不污染，
 *   目录随 teardown 删除。
 */
const READY_TIMEOUT_MS = 120_000;

let child: ChildProcess | null = null;
let stateDir: string | null = null;
let output = "";

function fail(message: string): never {
  throw new Error(`${message}\ncf dev 输出（截尾 4000 字符）：\n${output.slice(-4000)}`);
}

/** 端口占用检查（双栈）：被占用时立即失败，避免与任何已有服务冲突。 */
function assertPortFree(): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(
        new Error(
          `端口 ${E2E_PORT} 已被占用；请换用 ZZZBP_E2E_PORT 指定的其他端口，不要复用其他任务的服务。`,
        ),
      ),
    );
    probe.once("listening", () => probe.close(() => resolve()));
    // 不指定地址即双栈监听，能同时探测 IPv4/IPv6 上的既有占用。
    probe.listen(E2E_PORT);
  });
}

/** 轮询 /api/health 直到 Worker 就绪。 */
async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (child !== null && child.exitCode !== null) {
      fail(`cf dev 提前退出（exit ${child.exitCode}）`);
    }
    try {
      const response = await fetch(`${E2E_BASE_URL}/api/health`);
      if (response.ok) {
        await response.json();
        return;
      }
    } catch {
      // 尚未监听，继续等待。
    }
    if (Date.now() >= deadline) {
      fail(`cf dev 在 ${READY_TIMEOUT_MS}ms 内未就绪`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** 只向本任务启动的进程组发信号；SIGTERM 后 SIGKILL 兜底。 */
function terminateProcessGroup(): void {
  if (child === null || child.pid === undefined || child.exitCode !== null) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // 进程组可能已退出，交由下面的兜底轮询确认。
  }
  const deadline = Date.now() + 10_000;
  const killer = setInterval(() => {
    if (child?.exitCode !== null) {
      clearInterval(killer);
      return;
    }
    if (Date.now() >= deadline) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // 进程组已退出。
      }
      clearInterval(killer);
    }
  }, 500);
  // 兜底定时器不阻止 vitest 进程退出；子进程退出事件到达时立即清理。
  killer.unref();
  child.once("exit", () => clearInterval(killer));
}

function cleanupStateDir(): void {
  if (stateDir !== null) {
    rmSync(stateDir, { recursive: true, force: true });
    stateDir = null;
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  await assertPortFree();
  stateDir = mkdtempSync(join(tmpdir(), "zzzbp-e2e-state-"));
  child = spawn("pnpm", ["exec", "cf", "dev"], {
    cwd: join(fileURLToPath(new URL(".", import.meta.url)), "../.."),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ZZZBP_DEV_PORT: String(E2E_PORT),
      ZZZBP_DEV_PERSIST_STATE: stateDir,
    },
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  try {
    await waitUntilReady();
  } catch (error) {
    terminateProcessGroup();
    cleanupStateDir();
    throw error;
  }
  process.stdout.write(`[e2e] cf dev 就绪：${E2E_BASE_URL}（状态目录 ${stateDir}）\n`);

  return async () => {
    terminateProcessGroup();
    cleanupStateDir();
  };
}
