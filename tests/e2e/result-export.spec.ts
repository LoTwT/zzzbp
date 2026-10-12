import { expect, test } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Download, Page, Route } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCatalogData } from "../../shared/agents/catalog";
import type { BpSlotId } from "../../shared/bp/steps";
import {
  AGENTS,
  AGENT_DATA_VERSION,
  BP_ORDER,
  assertNoOverflow,
  closePanel,
  createRoomViaUi,
  expectDisabled,
  expectEnabled,
  expectVisible,
  joinRoomViaUi,
  newRoomContext,
  openPanel,
  panel,
  assignSeatViaUi,
  saveTeamName,
  stepOf,
  submitStep,
  waitForStatus,
} from "./helpers";
import { E2E_BASE_URL } from "./server";

/**
 * BP 结果导出端到端验收（浏览器本地文本 + PNG）。
 *
 * 实时房间走真实后端完成 26 步：未完成时导出禁用并给出原因；完成后
 * 房主/观众复制文本与剪贴板内容一致（按规格独立推导期望文本），选手在
 * 1024×768 下载 1600×1200 的可解码 PNG；慢图期间发生撤回（结果变化）、
 * 关闭面板（组件卸载）或页面离开时不触发旧任务下载。
 *
 * 记录页沿用分层证据：注入合法固定快照验证完整/未完成导出、混合图片
 * （方图/缺图/旧圆图本地副本/未收录跨域/同源 404）占位下仍可导出、
 * 剪贴板拒绝时的可复制文本兜底；导出不建立 WS、不请求 catalog。真实的
 * 12 小时归档裁决由 tests/workers 覆盖，浏览器不冒称自然归档验收。
 */

/** 未提交槽位的展示文案（规格常量，E2E 侧独立维护以验证实现）。 */
const UNSUBMITTED = "未提交";
/** 分享图固定尺寸（docs/specs/room-layout.md「BP 结果导出」）。 */
const EXPORT_PNG_WIDTH = 1600;
const EXPORT_PNG_HEIGHT = 1200;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 任务临时产物目录：默认一次性（测试后删除）；设置 ZZZBP_EXPORT_ARTIFACTS_DIR 保留复检。 */
function makeArtifactsDir(): { readonly dir: string; readonly owned: boolean } {
  const configured = process.env.ZZZBP_EXPORT_ARTIFACTS_DIR;
  return configured === undefined || configured === ""
    ? { dir: mkdtempSync(join(tmpdir(), "zzzbp-export-e2e-")), owned: true }
    : { dir: configured, owned: false };
}

/** 一局 26 步的代理人分配：目录顺序前 26 名，替换缺上游头像与最长名代表。 */
function planAgents(): string[] {
  const names = AGENTS.slice(0, 26).map((entry) => entry.name);
  const replace = (index: number, entry: { readonly name: string } | undefined): void => {
    if (entry !== undefined && !names.includes(entry.name)) names[index] = entry.name;
  };
  const noAvatar = AGENTS.find((entry) => entry.avatarPath === null);
  const longest = AGENTS.reduce((a, b) => (b.name.length > a.name.length ? b : a));
  replace(6, noAvatar);
  replace(12, longest);
  return names;
}

/** 期望文本按规格独立推导：房间名/完成情况/队名/两轮分组与未提交占位。 */
function expectedResultText(input: {
  readonly roomName: string;
  readonly teams: Readonly<Record<"A" | "B", string>>;
  readonly plan: readonly string[];
  readonly submittedCount: number;
}): string {
  const completion =
    input.submittedCount === BP_ORDER.length
      ? "已完成"
      : `未完成 · 已提交 ${input.submittedCount} 步`;
  const slotName = (slotId: BpSlotId): string => {
    const index = BP_ORDER.indexOf(slotId);
    return index >= 0 && index < input.submittedCount ? (input.plan[index] ?? "") : UNSUBMITTED;
  };
  const line = (team: "A" | "B", action: "ban" | "pick", round: 1 | 2) => {
    const slots = BP_ORDER.filter(
      (slotId) => slotId[0] === team && slotId[1] === (action === "ban" ? "B" : "P"),
    );
    const split = action === "ban" ? 2 : 6;
    const names = (round === 1 ? slots.slice(0, split) : slots.slice(split)).map(slotName);
    return `${action === "ban" ? "禁用" : "选用"} 第 ${round} 轮：${names.join("、")}`;
  };
  return [
    `${input.roomName} BP 结果 · ${completion}`,
    "",
    `左方 · ${input.teams.A}`,
    line("A", "ban", 1),
    line("A", "ban", 2),
    line("A", "pick", 1),
    line("A", "pick", 2),
    "",
    `右方 · ${input.teams.B}`,
    line("B", "ban", 1),
    line("B", "ban", 2),
    line("B", "pick", 1),
    line("B", "pick", 2),
  ].join("\n");
}

async function grantClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(E2E_BASE_URL).origin,
  });
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

function trackDownloads(page: Page): Download[] {
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));
  return downloads;
}

/** PNG 结构（签名/IHDR 尺寸/IEND）+ 真实浏览器解码双重验证，不只看 MIME。 */
async function assertValidPng(browser: Browser, filePath: string, label: string): Promise<void> {
  const buffer = await readFile(filePath);
  expect(buffer.length, `${label} PNG 大小`).toBeGreaterThan(10_000);
  expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE), `${label} PNG 签名`).toBe(true);
  expect(buffer.readUInt32BE(16), `${label} PNG 宽度`).toBe(EXPORT_PNG_WIDTH);
  expect(buffer.readUInt32BE(20), `${label} PNG 高度`).toBe(EXPORT_PNG_HEIGHT);
  expect(buffer.subarray(-8, -4).toString("latin1"), `${label} PNG IEND`).toBe("IEND");
  const decodePage = await browser.newPage();
  try {
    const dims = await decodePage.evaluate(async (base64) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    }, buffer.toString("base64"));
    expect(dims, `${label} PNG 浏览器解码`).toEqual({
      width: EXPORT_PNG_WIDTH,
      height: EXPORT_PNG_HEIGHT,
    });
  } finally {
    await decodePage.close();
  }
}

/**
 * 挂起指定代理人的方图母图请求：禁用网络缓存后注册挂起路由，保证导出的
 * new Image() 真正走网络并被拦截（否则可能命中缓存、竞态无从构造）。
 * held() 报告已到达并被挂起的请求数——注册路由不等于请求已挂起，竞态
 * 断言前必须先等它 ≥ 1；release() 继续被挂起的请求并恢复路由/会话。
 */
interface HangHandle {
  readonly held: () => number;
  readonly release: () => Promise<void>;
}

async function hangAgentMasterImage(page: Page, agentName: string): Promise<HangHandle> {
  const revision = agentCatalogData.imageAssets?.revision;
  const icon = AGENTS.find((entry) => entry.name === agentName)?.iconAsset?.icon;
  if (revision === undefined || icon === undefined) {
    throw new Error(`找不到 ${agentName} 的方图资源`);
  }
  const pattern = `**/images/agents/${revision}/${icon}.webp`;
  const session = await page.context().newCDPSession(page);
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  const pending: Route[] = [];
  await page.context().route(pattern, (route) => {
    pending.push(route);
  });
  return {
    held: () => pending.length,
    release: async () => {
      await Promise.allSettled(pending.map((route) => route.continue()));
      await page.context().unroute(pattern);
      await session.detach().catch(() => {});
    },
  };
}

/** 等到挂起的图片请求确实到达（导出确已进入异步等待阶段）。 */
async function waitForHeld(handle: HangHandle): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (handle.held() === 0) {
    if (Date.now() > deadline) throw new Error("挂起的图片请求未到达（15s 超时）");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 页内包装 canvas.toBlob 并统计回调完成次数：让测试能观察到「图片渲染
 * 与 PNG 编码已实际完成」这一异步阶段，取消类断言等到编码完成后才判定
 * （固定短睡眠会在编码尚未完成时假绿）。SPA 应用内导航不重载 document，
 * 包装在同一 JS realm 内持续有效；生产代码无感知。
 */
async function injectToBlobProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __zzzbpExportProbe?: { toBlobDone: number } };
    if (w.__zzzbpExportProbe !== undefined) return;
    w.__zzzbpExportProbe = { toBlobDone: 0 };
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      type?: string,
      quality?: number,
    ) {
      return original.call(
        this,
        (blob) => {
          try {
            callback(blob);
          } finally {
            w.__zzzbpExportProbe!.toBlobDone += 1;
          }
        },
        type,
        quality,
      );
    };
  });
}

/** 当前已完成的 PNG 编码次数（探针注入后有效）。 */
async function toBlobCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as typeof window & { __zzzbpExportProbe?: { toBlobDone: number } }).__zzzbpExportProbe
        ?.toBlobDone ?? 0,
  );
}

/** 等到 PNG 编码回调实际完成至少 minimum 次（取消类断言的确定性信号）。 */
async function waitForToBlobCount(page: Page, minimum: number): Promise<void> {
  await page.waitForFunction(
    (min) => {
      const probe = (window as typeof window & { __zzzbpExportProbe?: { toBlobDone: number } })
        .__zzzbpExportProbe;
      return probe !== undefined && probe.toBlobDone >= min;
    },
    minimum,
    { timeout: 20_000, polling: 200 },
  );
}

/** 页内临时拒绝两级剪贴板（Clipboard API reject + execCommand false/throw），可恢复。 */
async function denyClipboardViaDom(page: Page, mode: "return-false" | "throw"): Promise<void> {
  await page.evaluate((m) => {
    const w = window as typeof window & {
      __zzzbpClipboardDenied?: boolean;
      __zzzbpDeniedExecCommand?: typeof document.execCommand;
    };
    if (w.__zzzbpClipboardDenied === true) return;
    w.__zzzbpClipboardDenied = true;
    w.__zzzbpDeniedExecCommand = document.execCommand.bind(document);
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
    });
    Document.prototype.execCommand =
      m === "throw"
        ? () => {
            throw new Error("execCommand denied");
          }
        : () => false;
  }, mode);
}

async function restoreClipboardViaDom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & {
      __zzzbpClipboardDenied?: boolean;
      __zzzbpDeniedExecCommand?: typeof document.execCommand;
    };
    if (w.__zzzbpClipboardDenied !== true) return;
    w.__zzzbpClipboardDenied = false;
    // 实例上的遮蔽属性可删除，恢复原型上的真实 writeText。
    Reflect.deleteProperty(navigator.clipboard, "writeText");
    if (w.__zzzbpDeniedExecCommand !== undefined) {
      Document.prototype.execCommand = w.__zzzbpDeniedExecCommand;
    }
  });
}

test("实时房间：未完成禁用、完成后多角色文本/PNG 导出与慢图竞态收口", async () => {
  const browser = await chromium.launch();
  const artifacts = makeArtifactsDir();
  try {
    const host = await newRoomContext(browser, "host", { width: 1440, height: 900 });
    const playerA = await newRoomContext(browser, "playerA", { width: 1440, height: 900 });
    const playerB = await newRoomContext(browser, "playerB", { width: 1024, height: 768 });
    const spectator = await newRoomContext(browser, "spectator", { width: 1440, height: 900 });
    for (const ctx of [host, playerA, playerB, spectator]) {
      await grantClipboard(ctx.context);
    }
    const hostDownloads = trackDownloads(host.page);
    const playerADownloads = trackDownloads(playerA.page);
    const playerBDownloads = trackDownloads(playerB.page);

    // ---- 建房、入房、分席开局 ----
    const roomName = "首版验收·导出赛";
    const teams = { A: "甲队", B: "乙队" } as const;
    const roomUrl = await createRoomViaUi(host, roomName, "主办小鱼");
    await joinRoomViaUi(playerA, roomUrl, "选手甲");
    await joinRoomViaUi(playerB, roomUrl, "选手乙");
    await joinRoomViaUi(spectator, roomUrl, "观众星河");
    await openPanel(host.page);
    await saveTeamName(host.page, "A", teams.A);
    await saveTeamName(host.page, "B", teams.B);
    await assignSeatViaUi(host.page, "A", "选手甲");
    await assignSeatViaUi(host.page, "B", "选手乙");
    await host.page.getByRole("button", { name: "开始 BP", exact: true }).click();
    await closePanel(host.page);
    for (const ctx of [host, playerA, playerB, spectator]) {
      await waitForStatus(ctx.page, "进行中");
    }

    // ---- 未完成：导出禁用并给出简短原因 ----
    const plan = planAgents();
    await submitStep(playerA.page, "AB1", plan[0] ?? "");
    await submitStep(playerB.page, "BB1", plan[1] ?? "");
    await openPanel(host.page);
    await expectDisabled(
      panel(host.page).getByRole("button", { name: "复制结果文本", exact: true }),
    );
    await expectDisabled(
      panel(host.page).getByRole("button", { name: "下载结果图片", exact: true }),
    );
    await expectVisible(panel(host.page).getByText("BP 完成后可导出结果", { exact: true }));
    await closePanel(host.page);

    // ---- 完整 26 步 ----
    for (let index = 2; index < BP_ORDER.length; index += 1) {
      const slotId = BP_ORDER[index] ?? "";
      const operator = stepOf(slotId).team === "A" ? playerA.page : playerB.page;
      await submitStep(operator, slotId, plan[index] ?? "");
    }
    for (const ctx of [host, playerA, playerB, spectator]) {
      await waitForStatus(ctx.page, "已完成");
    }
    const expectedText = expectedResultText({
      roomName,
      teams,
      plan,
      submittedCount: BP_ORDER.length,
    });

    // ---- 房主复制结果文本：剪贴板内容与规格文本一致 ----
    await host.page.bringToFront();
    await openPanel(host.page);
    await panel(host.page).getByRole("button", { name: "复制结果文本", exact: true }).click();
    await expectVisible(panel(host.page).getByRole("button", { name: "已复制", exact: true }));
    expect(await readClipboard(host.page)).toBe(expectedText);
    await closePanel(host.page);

    // ---- 观众复制结果文本：与房主一致（角色无关） ----
    await spectator.page.bringToFront();
    await openPanel(spectator.page);
    await panel(spectator.page).getByRole("button", { name: "复制结果文本", exact: true }).click();
    await expectVisible(panel(spectator.page).getByRole("button", { name: "已复制", exact: true }));
    expect(await readClipboard(spectator.page)).toBe(expectedText);
    await closePanel(spectator.page);

    // ---- 选手（1024×768）下载 PNG：结构 + 浏览器解码 + 面板无整页溢出 ----
    // 先注入 toBlob 探针：取消类断言以「PNG 编码实际完成」为确定性信号。
    for (const ctx of [host, playerA, playerB]) {
      await injectToBlobProbe(ctx.page);
    }
    await openPanel(playerB.page);
    await expectEnabled(
      panel(playerB.page).getByRole("button", { name: "复制结果文本", exact: true }),
    );
    const downloadPromise = playerB.page.waitForEvent("download");
    await panel(playerB.page).getByRole("button", { name: "下载结果图片", exact: true }).click();
    const download = await downloadPromise;
    expect(playerBDownloads).toHaveLength(1);
    expect(download.suggestedFilename()).toMatch(/^BP结果-.+\.png$/);
    const livePng = join(artifacts.dir, "live-completed.png");
    await download.saveAs(livePng);
    await assertValidPng(browser, livePng, "实时完成");
    await assertNoOverflow(playerB.page, "实时房间 面板打开 1024x768");
    await closePanel(playerB.page);

    // ---- 实时面板（1024×768）剪贴板双路径拒绝：兜底文本框可键盘复制、
    //      无隐藏残留、不撑破 shrink-0 分享底栏，管理内容仍可见可操作 ----
    await host.page.setViewportSize({ width: 1024, height: 768 });
    await denyClipboardViaDom(host.page, "return-false");
    await openPanel(host.page);
    await panel(host.page).getByRole("button", { name: "复制结果文本", exact: true }).click();
    await expectVisible(
      panel(host.page).getByText("复制失败，请手动复制下方文本", { exact: true }),
    );
    const fallback = panel(host.page).getByLabel("结果文本");
    await expectVisible(fallback);
    expect(await fallback.inputValue()).toBe(expectedText);
    // 临时 textarea 已回收：页面只有兜底文本框一个 textarea（无隐藏残留）。
    expect(
      await host.page.evaluate(() => document.querySelectorAll("textarea").length),
      "不得残留隐藏 textarea",
    ).toBe(1);
    // 失败兜底自动聚焦（focus 触发全选），键盘可直接复制。
    await host.page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "结果文本",
      undefined,
      { timeout: 10_000, polling: 100 },
    );
    await assertNoOverflow(host.page, "实时面板 复制兜底 1024x768");
    // 面板管理内容仍可操作：中间滚动区未分享底栏挤没——「队伍与成员」
    // 分组滚动到可视位置后仍完整落在面板边界内（重开按钮等管理操作可达）。
    await expectVisible(panel(host.page).getByText("比赛控制", { exact: true }));
    const manageable = await host.page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="控制面板"]');
      const section = dialog?.querySelector('section[aria-label="队伍与成员"]');
      if (!(dialog instanceof HTMLElement) || !(section instanceof HTMLElement)) return false;
      section.scrollIntoView({ block: "nearest" });
      const dialogBox = dialog.getBoundingClientRect();
      const box = section.getBoundingClientRect();
      return box.top >= dialogBox.top - 1 && box.bottom <= dialogBox.bottom + 1;
    });
    expect(manageable, "队伍与成员分组滚动后仍在面板内可操作").toBe(true);
    await expectVisible(panel(host.page).getByRole("button", { name: "重开本局", exact: true }));
    await restoreClipboardViaDom(host.page);
    await host.page.setViewportSize({ width: 1440, height: 900 });
    await closePanel(host.page);

    // ---- 竞态 1a：慢图期间无关成员状态变化（B 选手页面断开，revision 递增
    //      但导出内容不变）→ 下载前内容一致 → 仍完成下载，不误取消 ----
    const hangA = await hangAgentMasterImage(host.page, plan[4] ?? "");
    await host.page.bringToFront();
    await openPanel(host.page);
    await panel(host.page).getByRole("button", { name: "下载结果图片", exact: true }).click();
    await waitForHeld(hangA);
    await playerB.page.close();
    // revision 已变的可见信号：房主面板 B 方选手行转「离线」。
    await panel(host.page).getByText("离线", { exact: true }).waitFor({ state: "visible" });
    await hangA.release();
    await host.page.waitForEvent("download", { timeout: 20_000 });
    expect(
      await panel(host.page).getByText("结果已变化，请重新导出", { exact: true }).count(),
      "无关状态变化不得误取消",
    ).toBe(0);

    // ---- 竞态 1b：慢图期间撤回（导出内容变化）→ 编码完成后终止下载并提示 ----
    const toBlobBefore1b = await toBlobCount(host.page);
    const hangB = await hangAgentMasterImage(host.page, plan[10] ?? "");
    await panel(host.page).getByRole("button", { name: "下载结果图片", exact: true }).click();
    await expectVisible(
      panel(host.page).getByRole("button", { name: "正在生成图片…", exact: true }),
    );
    // 忙碌互斥：图片导出期间文本导出按钮禁用。
    await expectDisabled(
      panel(host.page).getByRole("button", { name: "复制结果文本", exact: true }),
    );
    await waitForHeld(hangB);
    await panel(host.page).getByRole("button", { name: "撤回上一步", exact: true }).click();
    await waitForStatus(host.page, "已暂停");
    await hangB.release();
    // 等 PNG 编码实际完成（渲染未被取消，取消发生在编码之后），再判定无下载。
    await waitForToBlobCount(host.page, toBlobBefore1b + 1);
    await expectVisible(panel(host.page).getByText("结果已变化，请重新导出", { exact: true }));
    expect(hostDownloads, "结果变化后不得触发旧任务下载").toHaveLength(1); // 仅竞态 1a 那一次

    // ---- 恢复并重新完成（AP9 由 A 方重新提交；B 选手离线不影响 A 方操作） ----
    await host.page.getByRole("button", { name: "继续 BP", exact: true }).click();
    await closePanel(host.page);
    await waitForStatus(playerA.page, "进行中");
    await submitStep(playerA.page, "AP9", plan[25] ?? "");
    await waitForStatus(host.page, "已完成");

    // ---- 竞态 2：慢图期间关闭面板（组件卸载）→ 编码完成后不下载 ----
    const toBlobBefore2 = await toBlobCount(host.page);
    const hangC = await hangAgentMasterImage(host.page, plan[12] ?? "");
    await openPanel(host.page);
    await panel(host.page).getByRole("button", { name: "下载结果图片", exact: true }).click();
    await waitForHeld(hangC);
    await closePanel(host.page);
    await hangC.release();
    await waitForToBlobCount(host.page, toBlobBefore2 + 1);
    expect(hostDownloads, "面板关闭后不得下载").toHaveLength(1);

    // ---- 竞态 3：慢图期间应用内导航离开（同一 JS realm 内卸载组件）→ 不下载 ----
    const toBlobBefore3 = await toBlobCount(playerA.page);
    const hangD = await hangAgentMasterImage(playerA.page, plan[15] ?? "");
    await openPanel(playerA.page);
    await panel(playerA.page).getByRole("button", { name: "下载结果图片", exact: true }).click();
    await waitForHeld(hangD);
    // 键盘激活「返回首页」（Enter 不触发面板的外部点击拦截，面板保持
    // 打开的同时完成应用内导航）：RoomPage/组件在同一 JS realm 内卸载，
    // 导出的 disposed 守卫在真实导航路径上被执行与观察。
    await playerA.page.getByRole("link", { name: "返回首页" }).focus();
    await playerA.page.keyboard.press("Enter");
    await playerA.page.waitForURL((url) => url.pathname === "/");
    await hangD.release();
    await waitForToBlobCount(playerA.page, toBlobBefore3 + 1);
    expect(playerADownloads, "页面离开后不得下载").toHaveLength(0);

    expect(host.errors).toHaveLength(0);
    expect(playerA.errors).toHaveLength(0);
    expect(playerB.errors).toHaveLength(0);
    expect(spectator.errors).toHaveLength(0);
    process.stdout.write(`[export-e2e] 实时房间产物：${livePng}\n`);
  } finally {
    if (artifacts.owned) rmSync(artifacts.dir, { recursive: true, force: true });
    await browser.close();
  }
}, 480_000);

/** 记录页夹具的混合头像：方图真实路径 / null / 旧圆图本地副本 / 未收录跨域 / 同源 404。 */
const RECORD_REVISION = agentCatalogData.imageAssets?.revision ?? "";
function recordAvatarOf(index: number): {
  readonly url: string | null;
  readonly crop: { readonly x: number; readonly y: number } | null;
} {
  const entry = AGENTS[index];
  if (entry === undefined || entry.iconAsset === undefined) return { url: null, crop: null };
  switch (index % 6) {
    case 1:
      return { url: null, crop: null };
    case 2:
      return { url: "/images/agents/legacy/IconRoleCircle01.webp", crop: null };
    case 3:
      return { url: "https://static.nanoka.cc/assets/zzz/IconRoleCircle02.webp", crop: null };
    case 4:
      return {
        url: `/images/agents/${RECORD_REVISION}/IconRoleCropNotExists.webp`,
        crop: { x: 50, y: 50 },
      };
    default:
      return {
        url: `/images/agents/${RECORD_REVISION}/${entry.iconAsset.icon}.webp`,
        crop: entry.iconAsset.crop,
      };
  }
}

/** 归档快照构造：前 count 步按权威顺序与目录条目生成（经 UI 消费的同一合同）。 */
function buildRecordSnapshot(
  roomId: string,
  roomName: string,
  teams: Readonly<Record<"A" | "B", string>>,
  count: number,
) {
  return {
    roomId,
    roomName,
    teamNames: teams,
    bpCompleted: count === BP_ORDER.length,
    operations: BP_ORDER.slice(0, count).map((slotId, index) => {
      const avatar = recordAvatarOf(index);
      return {
        slotId,
        team: stepOf(slotId).team,
        action: stepOf(slotId).action,
        agentId: AGENTS[index]?.id ?? "",
        agentName: AGENTS[index]?.name ?? "",
        agentAvatarUrl: avatar.url,
        agentAvatarCrop: avatar.crop,
      };
    }),
    versions: { ruleVersion: "1", agentDataVersion: AGENT_DATA_VERSION },
    archivedAt: "2026-10-05T02:00:00.000Z",
    expiresAt: "2027-01-03T02:00:00.000Z",
  };
}

test("记录页：完整/未完成导出、混合图片占位与剪贴板兜底（1024×768 与 1440×900）", async () => {
  const browser = await chromium.launch();
  const artifacts = makeArtifactsDir();
  try {
    const plan = AGENTS.slice(0, 26).map((entry) => entry.name);
    const roomName = "归档导出验收赛";
    const teams = { A: "甲队", B: "乙".repeat(32) } as const;

    // ---- 完整记录（26 步）：1440×900，文本 + PNG + 边界（无 WS/无 catalog） ----
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(20_000);
    await context.route("**/static.nanoka.cc/**", (route) => route.abort());
    await grantClipboard(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (message.text().startsWith("Failed to load resource")) return;
      errors.push(`console.error: ${message.text()}`);
    });
    const requests: Array<{ url: string; method: string }> = [];
    page.on("request", (request) =>
      requests.push({ url: request.url(), method: request.method() }),
    );
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));

    const roomId = "44444444-4444-4444-8444-444444444444";
    await context.route(`**/api/rooms/${roomId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({
          kind: "archived",
          record: buildRecordSnapshot(roomId, roomName, teams, BP_ORDER.length),
        }),
      });
    });
    await page.goto(`${E2E_BASE_URL}/rooms/${roomId}`);
    await page.getByText("只读记录 · 已完成", { exact: true }).waitFor();

    // 页面图片先稳定（懒加载收敛），再统计跨域请求数：导出不得新增外部图片请求。
    await page.waitForTimeout(800);
    const externalBefore = requests.filter((item) => item.url.includes("static.nanoka.cc")).length;

    await openPanel(page);
    await panel(page).getByRole("button", { name: "复制结果文本", exact: true }).click();
    await expectVisible(panel(page).getByRole("button", { name: "已复制", exact: true }));
    expect(await readClipboard(page)).toBe(
      expectedResultText({ roomName, teams, plan, submittedCount: BP_ORDER.length }),
    );

    const downloadPromise = page.waitForEvent("download");
    await panel(page).getByRole("button", { name: "下载结果图片", exact: true }).click();
    const download = await downloadPromise;
    const archivePng = join(artifacts.dir, "archive-completed.png");
    await download.saveAs(archivePng);
    await assertValidPng(browser, archivePng, "归档完整");
    await closePanel(page);

    // 导出边界：零 WS、零房间 catalog API 请求、零新增跨域图片请求。
    // （dev server 的 /src/**、/shared/** 源码模块请求不是房间目录 API。）
    expect(sockets.filter((url) => url.endsWith("/ws"))).toHaveLength(0);
    expect(
      requests.some(
        (item) => item.method === "GET" && /\/api\/rooms\/[^/]+\/catalog$/.test(item.url),
      ),
      "归档导出不得请求房间目录 API",
    ).toBe(false);
    const externalAfter = requests.filter((item) => item.url.includes("static.nanoka.cc")).length;
    expect(externalAfter, "导出不请求跨域旧图").toBe(externalBefore);
    expect(errors).toHaveLength(0);
    await context.close();

    // ---- 未完成记录（10 步）：1024×768，剪贴板拒绝 → 可复制文本兜底 + PNG ----
    const contextSmall = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    contextSmall.setDefaultTimeout(20_000);
    await contextSmall.route("**/static.nanoka.cc/**", (route) => route.abort());
    // 双路径剪贴板均被拒（Clipboard API 拒绝 + execCommand 失败）：必须给出可复制文本。
    await contextSmall.addInitScript(() => {
      const clipboard = navigator.clipboard;
      if (clipboard !== undefined) {
        Object.defineProperty(clipboard, "writeText", {
          configurable: true,
          value: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
        });
      }
      Document.prototype.execCommand = () => false;
    });
    const smallPage = await contextSmall.newPage();
    const smallErrors: string[] = [];
    smallPage.on("pageerror", (error) => smallErrors.push(`pageerror: ${error.message}`));
    smallPage.on("console", (message) => {
      if (message.type() !== "error") return;
      if (message.text().startsWith("Failed to load resource")) return;
      smallErrors.push(`console.error: ${message.text()}`);
    });

    const partialRoomId = "55555555-5555-4555-8555-555555555555";
    await contextSmall.route(`**/api/rooms/${partialRoomId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({
          kind: "archived",
          record: buildRecordSnapshot(partialRoomId, roomName, teams, 10),
        }),
      });
    });
    await smallPage.goto(`${E2E_BASE_URL}/rooms/${partialRoomId}`);
    await smallPage.getByText("只读记录 · 未完成", { exact: true }).waitFor();

    const expectedPartialText = expectedResultText({
      roomName,
      teams,
      plan,
      submittedCount: 10,
    });
    await openPanel(smallPage);
    await panel(smallPage).getByRole("button", { name: "复制结果文本", exact: true }).click();
    await expectVisible(
      panel(smallPage).getByText("复制失败，请手动复制下方文本", { exact: true }),
    );
    // 不虚报成功：按钮未显示「已复制」，完整文本出现在可选择复制的 textarea。
    await expectVisible(
      panel(smallPage).getByRole("button", { name: "复制结果文本", exact: true }),
    );
    expect(await panel(smallPage).getByLabel("结果文本").inputValue()).toBe(expectedPartialText);
    // 临时 textarea 已回收：页面只有兜底文本框一个 textarea（无隐藏残留），
    // 且兜底文本框自动聚焦（focus 触发全选，键盘可直接复制）。
    expect(
      await smallPage.evaluate(() => document.querySelectorAll("textarea").length),
      "不得残留隐藏 textarea",
    ).toBe(1);
    await smallPage.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "结果文本",
      undefined,
      { timeout: 10_000, polling: 100 },
    );
    await assertNoOverflow(smallPage, "记录页 面板+文本兜底 1024x768");

    // 重复失败：再次点击仍走兜底，不新增隐藏残留、反馈保持正确。
    await panel(smallPage).getByRole("button", { name: "复制结果文本", exact: true }).click();
    await expectVisible(
      panel(smallPage).getByText("复制失败，请手动复制下方文本", { exact: true }),
    );
    expect(
      await smallPage.evaluate(() => document.querySelectorAll("textarea").length),
      "重复失败后仍不得残留隐藏 textarea",
    ).toBe(1);

    const partialDownloadPromise = smallPage.waitForEvent("download");
    await panel(smallPage).getByRole("button", { name: "下载结果图片", exact: true }).click();
    const partialDownload = await partialDownloadPromise;
    const partialPng = join(artifacts.dir, "archive-partial.png");
    await partialDownload.saveAs(partialPng);
    await assertValidPng(browser, partialPng, "归档未完成");
    expect(smallErrors).toHaveLength(0);
    await contextSmall.close();

    // ---- 未完成记录（10 步）：execCommand 抛异常路径同样兜底且无残留 ----
    const contextThrow = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contextThrow.setDefaultTimeout(20_000);
    await contextThrow.route("**/static.nanoka.cc/**", (route) => route.abort());
    await contextThrow.addInitScript(() => {
      const clipboard = navigator.clipboard;
      if (clipboard !== undefined) {
        Object.defineProperty(clipboard, "writeText", {
          configurable: true,
          value: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
        });
      }
      Document.prototype.execCommand = () => {
        throw new Error("execCommand denied");
      };
    });
    const throwPage = await contextThrow.newPage();
    const throwErrors: string[] = [];
    throwPage.on("pageerror", (error) => throwErrors.push(`pageerror: ${error.message}`));
    throwPage.on("console", (message) => {
      if (message.type() !== "error") return;
      if (message.text().startsWith("Failed to load resource")) return;
      throwErrors.push(`console.error: ${message.text()}`);
    });
    const throwRoomId = "88888888-8888-4888-8888-888888888888";
    await contextThrow.route(`**/api/rooms/${throwRoomId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({
          kind: "archived",
          record: buildRecordSnapshot(throwRoomId, roomName, teams, 10),
        }),
      });
    });
    await throwPage.goto(`${E2E_BASE_URL}/rooms/${throwRoomId}`);
    await throwPage.getByText("只读记录 · 未完成", { exact: true }).waitFor();
    await openPanel(throwPage);
    await panel(throwPage).getByRole("button", { name: "复制结果文本", exact: true }).click();
    await expectVisible(
      panel(throwPage).getByText("复制失败，请手动复制下方文本", { exact: true }),
    );
    expect(await panel(throwPage).getByLabel("结果文本").inputValue()).toBe(expectedPartialText);
    expect(
      await throwPage.evaluate(() => document.querySelectorAll("textarea").length),
      "execCommand 抛异常后不得残留隐藏 textarea",
    ).toBe(1);
    await throwPage.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "结果文本",
      undefined,
      { timeout: 10_000, polling: 100 },
    );
    expect(throwErrors).toHaveLength(0);
    await contextThrow.close();

    // ---- 完整记录（26 步）：Clipboard API 拒绝但真实 execCommand 成功的
    //      旧路径成功回归——成功不虚报、无任何 textarea 残留，且触发按钮
    //      在 busy 清除并重新启用后恢复焦点（旧实现会丢在 BODY）。 ----
    const contextLegacy = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contextLegacy.setDefaultTimeout(20_000);
    await contextLegacy.route("**/static.nanoka.cc/**", (route) => route.abort());
    // 仅拒绝 Clipboard API：execCommand 保留真实实现（点击的用户激活内有效）。
    await contextLegacy.addInitScript(() => {
      const clipboard = navigator.clipboard;
      if (clipboard !== undefined) {
        Object.defineProperty(clipboard, "writeText", {
          configurable: true,
          value: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
        });
      }
    });
    const legacyPage = await contextLegacy.newPage();
    const legacyErrors: string[] = [];
    legacyPage.on("pageerror", (error) => legacyErrors.push(`pageerror: ${error.message}`));
    legacyPage.on("console", (message) => {
      if (message.type() !== "error") return;
      if (message.text().startsWith("Failed to load resource")) return;
      legacyErrors.push(`console.error: ${message.text()}`);
    });
    const legacyRoomId = "99999999-9999-4999-8999-999999999999";
    await contextLegacy.route(`**/api/rooms/${legacyRoomId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({
          kind: "archived",
          record: buildRecordSnapshot(legacyRoomId, roomName, teams, BP_ORDER.length),
        }),
      });
    });
    await legacyPage.goto(`${E2E_BASE_URL}/rooms/${legacyRoomId}`);
    await legacyPage.getByText("只读记录 · 已完成", { exact: true }).waitFor();
    await openPanel(legacyPage);
    await panel(legacyPage).getByRole("button", { name: "复制结果文本", exact: true }).click();
    await expectVisible(panel(legacyPage).getByRole("button", { name: "已复制", exact: true }));
    // 旧路径成功：不出现兜底文本框，也不残留隐藏的临时节点。
    expect(
      await legacyPage.evaluate(() => document.querySelectorAll("textarea").length),
      "旧路径成功不得残留 textarea",
    ).toBe(0);
    // 焦点收口：临时节点移除、busy 清除且按钮重新启用后恢复到触发按钮。
    await legacyPage.waitForFunction(
      () => {
        const exportButton = [...document.querySelectorAll("button")].find((button) => {
          const label = (button.textContent ?? "").trim();
          return label === "已复制" || label === "复制结果文本";
        });
        return exportButton !== undefined && document.activeElement === exportButton;
      },
      undefined,
      { timeout: 10_000, polling: 100 },
    );
    expect(legacyErrors).toHaveLength(0);
    await contextLegacy.close();

    // ---- 焦点契约全链路（可控 Promise 驱动时序；C 由上方 false/throw 场景覆盖）：
    //      A native 拒绝 + legacy 真实成功：未移焦恢复触发按钮；等待中移焦
    //      到「复制房间链接」则保持该按钮（用户主动目标优先）。
    //      B native 成功：未移焦与移焦均保留合理焦点（不抢回）。
    //      A3/B3 复制期间焦点在面板容器：容器不视作用户目标，成功后
    //      恢复触发按钮；以程序化移焦覆盖这一恢复分支。
    //      B4 Safari/WebKit 点击不聚焦按钮的复现（焦点保持容器时程序化
    //      激活）：触发元素按事件目标解析，成功后恢复触发按钮。
    //      D native 等待中卸载（关闭面板）后再放行拒绝：不走 legacy、
    //      不新增 textarea、不抢焦点（保持面板关闭的入口焦点语义）。 ----
    const contextFocus = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contextFocus.setDefaultTimeout(20_000);
    await contextFocus.route("**/static.nanoka.cc/**", (route) => route.abort());
    // 可控 writeText：显式 release("reject"|"resolve") 决定放行时刻与结果，
    // 比固定延时更能证明顺序（等待中移焦、卸载后再放行）。execCommand 保留
    // 真实实现，legacy 路径真实复制。
    await contextFocus.addInitScript(() => {
      const pending: Array<(kind: "reject" | "resolve") => void> = [];
      Object.defineProperty(window, "__zzzbpCopyControl", {
        value: {
          release(kind: "reject" | "resolve"): void {
            const waiting = pending.splice(0);
            for (const settle of waiting) settle(kind);
          },
        },
      });
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: (): Promise<void> =>
          new Promise<void>((resolve, reject) => {
            pending.push((kind) => {
              if (kind === "reject") reject(new DOMException("denied", "NotAllowedError"));
              else resolve();
            });
          }),
      });
    });
    const focusPage = await contextFocus.newPage();
    const focusErrors: string[] = [];
    focusPage.on("pageerror", (error) => focusErrors.push(`pageerror: ${error.message}`));
    const focusRoomId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await contextFocus.route(`**/api/rooms/${focusRoomId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({
          kind: "archived",
          record: buildRecordSnapshot(focusRoomId, roomName, teams, BP_ORDER.length),
        }),
      });
    });
    await focusPage.goto(`${E2E_BASE_URL}/rooms/${focusRoomId}`);
    await focusPage.getByText("只读记录 · 已完成", { exact: true }).waitFor();
    await openPanel(focusPage);

    /** 触发按钮（2s 反馈窗口内 label 为「已复制」，之后回落）。 */
    const copyButton = panel(focusPage).getByRole("button", { name: /^(复制结果文本|已复制)$/ });
    /** busy=text 的可见信号：writeText 已被调用且挂起。 */
    const copyPending = panel(focusPage).getByRole("button", { name: "正在复制…", exact: true });
    const linkButton = panel(focusPage).getByRole("button", { name: "复制房间链接", exact: true });
    const release = (kind: "reject" | "resolve"): Promise<unknown> =>
      focusPage.evaluate(
        (k) =>
          (
            window as typeof window & {
              __zzzbpCopyControl?: { release(kind: "reject" | "resolve"): void };
            }
          ).__zzzbpCopyControl?.release(k),
        kind,
      );
    /** 等待 activeElement 的可见文本命中期望集合（BODY/空文本不命中）。 */
    const waitForActiveLabel = async (labels: readonly string[]): Promise<void> => {
      await focusPage.waitForFunction(
        (expected) => {
          const el = document.activeElement;
          if (el === null || el === document.body) return false;
          return expected.includes((el.textContent ?? "").trim());
        },
        [...labels],
        { timeout: 10_000, polling: 100 },
      );
    };

    // A1：legacy 成功、未移焦 → 恢复触发按钮，无任何 textarea 残留。
    await copyButton.click();
    await expectVisible(copyPending);
    await release("reject");
    await expectVisible(panel(focusPage).getByRole("button", { name: "已复制", exact: true }));
    expect(await focusPage.evaluate(() => document.querySelectorAll("textarea").length)).toBe(0);
    await waitForActiveLabel(["已复制", "复制结果文本"]);

    // A2：legacy 成功、等待中主动移焦到「复制房间链接」→ 保持该按钮。
    await copyButton.click();
    await expectVisible(copyPending);
    await linkButton.focus();
    await release("reject");
    await expectVisible(panel(focusPage).getByRole("button", { name: "已复制", exact: true }));
    expect(await focusPage.evaluate(() => document.querySelectorAll("textarea").length)).toBe(0);
    await waitForActiveLabel(["复制房间链接"]);

    // B1：native 成功、未移焦 → 焦点保持在触发按钮（Chromium 保焦）。
    await copyButton.click();
    await expectVisible(copyPending);
    await release("resolve");
    await expectVisible(panel(focusPage).getByRole("button", { name: "已复制", exact: true }));
    await waitForActiveLabel(["已复制", "复制结果文本"]);

    // B2：native 成功、等待中主动移焦 → 不抢回，保持用户目标。
    await copyButton.click();
    await expectVisible(copyPending);
    await linkButton.focus();
    await release("resolve");
    await expectVisible(panel(focusPage).getByRole("button", { name: "已复制", exact: true }));
    await waitForActiveLabel(["复制房间链接"]);

    // A3/B3：主动构造复制期间焦点在 tabindex="-1" 面板容器的状态。
    // native 或 legacy 成功后均恢复触发按钮，不把焦点留在（或恢复到）
    // 非交互容器上。点击不聚焦按钮的事件目标语义另由 B4 覆盖。
    const focusPanelContainer = (): Promise<void> =>
      focusPage.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-label="控制面板"]');
        if (dialog instanceof HTMLElement) dialog.focus();
      });

    // A3：legacy 成功 + 焦点在容器：容器不得被当作恢复目标。
    await copyButton.click();
    await expectVisible(copyPending);
    await focusPanelContainer();
    await release("reject");
    await expectVisible(panel(focusPage).getByRole("button", { name: "已复制", exact: true }));
    expect(await focusPage.evaluate(() => document.querySelectorAll("textarea").length)).toBe(0);
    await waitForActiveLabel(["已复制", "复制结果文本"]);

    // B3：native 成功 + 焦点在容器：恢复到触发按钮。
    await copyButton.click();
    await expectVisible(copyPending);
    await focusPanelContainer();
    await release("resolve");
    await expectVisible(panel(focusPage).getByRole("button", { name: "已复制", exact: true }));
    await waitForActiveLabel(["已复制", "复制结果文本"]);

    // B4：Safari/WebKit 点击不聚焦按钮的行为复现——焦点保持在容器上时
    // 程序化激活按钮（等价于 macOS Safari 的鼠标点击）：触发元素按事件
    // 目标解析（而非 activeElement），成功后恢复到触发按钮。
    await focusPage.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="控制面板"]');
      if (dialog instanceof HTMLElement) dialog.focus();
      const exportButton = [...document.querySelectorAll("button")].find((button) => {
        const label = (button.textContent ?? "").trim();
        return label === "复制结果文本" || label === "已复制";
      });
      exportButton?.click();
    });
    await expectVisible(copyPending);
    await release("resolve");
    await expectVisible(panel(focusPage).getByRole("button", { name: "已复制", exact: true }));
    await waitForActiveLabel(["已复制", "复制结果文本"]);

    // D：native 等待中关闭面板（组件卸载）后再放行拒绝 → 不走 legacy、
    // 不新增 textarea、焦点保持面板关闭的入口语义。
    await copyButton.click();
    await expectVisible(copyPending);
    await closePanel(focusPage);
    await release("reject");
    expect(
      await focusPage.evaluate(() => document.querySelectorAll("textarea").length),
      "卸载后放行拒绝不得新增 textarea",
    ).toBe(0);
    await waitForActiveLabel(["控制面板"]);

    expect(focusErrors).toHaveLength(0);
    await contextFocus.close();

    process.stdout.write(`[export-e2e] 记录页产物：${archivePng}、${partialPng}\n`);
  } finally {
    if (artifacts.owned) rmSync(artifacts.dir, { recursive: true, force: true });
    await browser.close();
  }
}, 240_000);
