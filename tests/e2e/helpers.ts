import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { agentCatalogData, toAgentImageUrl } from "../../shared/agents/catalog";
import type { AgentEntry } from "../../shared/agents/schema";
import type { BpSlotId } from "../../shared/bp/steps";
import { SPEC_BP_STEP_ORDER } from "../rules/spec-bp-order";
import { E2E_BASE_URL } from "./server";

/**
 * E2E 浏览器验收共享辅助（PR10）。
 *
 * 断言使用界面的可访问名称/角色与 sr-only 文案，不依赖布局实现细节；
 * 第三方头像 CDN（static.nanoka.cc）在测试上下文中统一拦截，验收不依赖
 * 外部网络，也不向第三方资产源发请求（界面渲染不依赖图片加载成功，
 * 见 docs/specs/room-layout.md「代理人头像」）。
 */

export const AGENTS: readonly AgentEntry[] = agentCatalogData.agents;
export const AGENT_DATA_VERSION = agentCatalogData.agentDataVersion;
/** 缺头像代理人（界面留空后备，不删除、不影响操作）。 */
export const NO_AVATAR_AGENTS = AGENTS.filter((entry) => entry.avatarPath === null);
/** 名称最长的代理人（长名称展示代表）。 */
export const LONGEST_NAME_AGENT = AGENTS.reduce((a, b) => (b.name.length > a.name.length ? b : a));

/** 规格来源的 26 步顺序（tests/rules/spec-bp-order.ts，独立于实现导出）。 */
export const BP_ORDER: readonly BpSlotId[] = SPEC_BP_STEP_ORDER;

/** 由操作位推导阵营与动作（与[操作标记]定义一致）。 */
export function stepOf(slotId: BpSlotId): { team: "A" | "B"; action: "ban" | "pick" } {
  return { team: slotId[0] === "A" ? "A" : "B", action: slotId[1] === "B" ? "ban" : "pick" };
}

/** 快照/界面共用的头像 URL 派生（供注入合法快照使用）。 */
export function avatarUrlOf(entry: AgentEntry): string | null {
  return toAgentImageUrl(entry.avatarPath);
}

export interface RoomContext {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly label: string;
  readonly errors: string[];
}

/**
 * 页面错误收集：pageerror 与 console.error 全程记录，收尾统一断言为空。
 * 「Failed to load resource」是被本套件主动拦截的头像 CDN 请求产生的
 * 预期资源加载失败（界面不依赖图片加载成功），不计入错误。
 */
export function attachPageLogging(page: Page, sink: string[], label: string): void {
  page.on("pageerror", (error) => sink.push(`[${label}] pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.text().startsWith("Failed to load resource")) return;
    sink.push(`[${label}] console.error: ${message.text()}`);
  });
}

/** 建立一个隔离身份的浏览器上下文（Cookie 独立），拦截头像 CDN。 */
export async function newRoomContext(
  browser: Browser,
  label: string,
  viewport: { width: number; height: number },
): Promise<RoomContext> {
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(20_000);
  await context.route("**/static.nanoka.cc/**", (route) => route.abort());
  const page = await context.newPage();
  const errors: string[] = [];
  attachPageLogging(page, errors, label);
  return { browser, context, page, label, errors };
}

/** 同一上下文的第二个页面（同身份多页面场景）。 */
export async function newSameIdentityPage(context: RoomContext, label: string): Promise<Page> {
  const page = await context.context.newPage();
  page.setDefaultTimeout(20_000);
  attachPageLogging(page, context.errors, label);
  return page;
}

/** 整页无横向/纵向越界（页面级滚动被布局约束，仅内部列表滚动）。 */
export async function assertNoOverflow(page: Page, label: string): Promise<void> {
  const info = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    vw: window.innerWidth,
    vh: window.innerHeight,
  }));
  if (info.scrollW > info.vw + 1 || info.scrollH > info.vh + 1) {
    throw new Error(
      `${label} 页面出现整页越界（${info.scrollW}x${info.scrollH} vs ${info.vw}x${info.vh}）`,
    );
  }
}

/** 代理人池卡片：可选为「名称」，禁用/选用为「名称（已禁用/已选用）」。 */
export function agentCard(page: Page, name: string, state?: "已禁用" | "已选用"): Locator {
  const label = state === undefined ? name : `${name}（${state}）`;
  return page.getByRole("button", { name: label, exact: true });
}

/** 当前操作位公开预选（任意页面可见，sr-only 文案）。 */
export function preselectText(page: Page, name: string): Locator {
  return page.getByText(`当前操作位，预选：${name}`, { exact: true });
}

/** 控制面板（右侧覆盖 dialog）。 */
export function panel(page: Page): Locator {
  return page.getByRole("dialog", { name: "控制面板" });
}

export async function openPanel(page: Page): Promise<Locator> {
  const target = panel(page);
  if ((await target.count()) === 0) {
    await page.getByRole("button", { name: "控制面板", exact: true }).click();
  }
  await target.waitFor({ state: "visible" });
  return target;
}

export async function closePanel(page: Page): Promise<void> {
  const target = panel(page);
  if ((await target.count()) > 0) {
    await page.getByRole("button", { name: "关闭控制面板", exact: true }).click();
    await target.waitFor({ state: "detached" });
  }
}

/** 首页 UI 建房：返回房间 URL。 */
export async function createRoomViaUi(
  ctx: RoomContext,
  roomName: string,
  nickname: string,
): Promise<string> {
  await ctx.page.goto(`${E2E_BASE_URL}/`);
  await ctx.page.fill("#home-room-name", roomName);
  await ctx.page.fill("#home-nickname", nickname);
  await ctx.page.getByRole("button", { name: "创建房间", exact: true }).click();
  await ctx.page.waitForURL(/\/rooms\//);
  await ctx.page.getByRole("heading", { name: roomName }).waitFor();
  return ctx.page.url();
}

/** 打开房间链接，以观众身份完成首次入房。 */
export async function joinRoomViaUi(
  ctx: RoomContext,
  roomUrl: string,
  nickname: string,
): Promise<void> {
  await ctx.page.goto(roomUrl);
  await ctx.page.getByRole("heading", { name: "进入房间" }).waitFor();
  await ctx.page.fill("#join-nickname", nickname);
  await ctx.page.getByRole("button", { name: "进入房间", exact: true }).click();
  await ctx.page.getByRole("heading", { name: "进入房间" }).waitFor({ state: "detached" });
}

/** 房主面板：保存一队队名（队名行内第 N 个「保存」按钮）。 */
export async function saveTeamName(hostPage: Page, team: "A" | "B", name: string): Promise<void> {
  await hostPage.fill(`#team-name-${team}`, name);
  await panel(hostPage)
    .getByRole("button", { name: "保存", exact: true })
    .nth(team === "A" ? 0 : 1)
    .click();
}

/** 房主面板：目标队伍的席位入口（空席「选择选手」，已有人「更换选手」）。 */
export function seatEntryButton(hostPage: Page, team: "A" | "B"): Locator {
  return panel(hostPage)
    .getByRole("button", { name: /选择选手|更换选手/ })
    .nth(team === "A" ? 0 : 1);
}

/**
 * 为目标队伍分配选手（待开始分配与暂停换人共用同一列表）。
 * candidateNickname 在候选列表中必须可唯一定位。完成后返回主面板，
 * 便于连续调用与后续比赛控制操作。
 */
export async function assignSeatViaUi(
  hostPage: Page,
  team: "A" | "B",
  candidateNickname: string,
): Promise<void> {
  await seatEntryButton(hostPage, team).click();
  const target = panel(hostPage);
  await target.getByText("当前选手：", { exact: false }).first().waitFor();
  await target
    .getByRole("listitem")
    .filter({ hasText: candidateNickname })
    .getByRole("button", { name: "设为选手", exact: true })
    .click();
  // 原位反馈：列表顶部当前选手更新为该成员（列表保持打开）。
  await target.getByText(`当前选手：${candidateNickname}`).waitFor();
  // 返回主面板（子视图的返回入口）。
  await target.getByRole("button", { name: "返回", exact: true }).click();
  await target.getByText("当前选手：", { exact: false }).waitFor({ state: "detached" });
}

/** 等待顶部状态文案出现（「待开始」「进行中」「已暂停」「已完成」）。 */
export async function waitForStatus(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().waitFor({ state: "visible" });
}

/** 确认按钮（仅当前操作方可见，按动作显示确认禁用/确认选用）。 */
export function confirmButton(page: Page): Locator {
  return page.getByRole("button", { name: /确认禁用|确认选用|提交中…|正在核对结果…|确认提交/ });
}

interface SubmitStepOptions {
  /** 需要确认公开预选可见的其他页面（跨页预选同步断言）。 */
  readonly expectOn?: Page;
}

/**
 * 当前操作方页面完成一步禁选：预选 →（可选跨页预选断言）→ 确认 →
 * 等待本页出现该代理人的已提交状态。返回最终卡片状态。
 */
export async function submitStep(
  operatorPage: Page,
  slotId: BpSlotId,
  agentName: string,
  options: SubmitStepOptions = {},
): Promise<"已禁用" | "已选用"> {
  const state = stepOf(slotId).action === "ban" ? "已禁用" : "已选用";
  await agentCard(operatorPage, agentName).click();
  if (options.expectOn !== undefined) {
    await preselectText(options.expectOn, agentName).waitFor({ state: "visible" });
  }
  await confirmButton(operatorPage).click();
  await agentCard(operatorPage, agentName, state).waitFor({ state: "visible" });
  return state;
}

/** 页面收尾断言：无未处理页面错误与 console.error。 */
export function assertNoPageErrors(context: RoomContext): void {
  if (context.errors.length > 0) {
    throw new Error(`页面错误（${context.label}）：\n${context.errors.join("\n")}`);
  }
}

// ---- Locator 断言助手（vitest 的 expect 不含 Playwright matcher；
// ---- 这些轻量轮询实现保持自动等待语义，不为 matcher 引入 @playwright/test）。

/** 等待 locator 可见。 */
export async function expectVisible(locator: Locator): Promise<void> {
  await locator.waitFor({ state: "visible" });
}

/** 等待 locator 不可见（不存在或被隐藏）。 */
export async function expectHidden(locator: Locator): Promise<void> {
  await locator.waitFor({ state: "hidden" });
}

/** 轮询直到 locator 匹配的元素数量等于期望值。 */
export async function expectCount(locator: Locator, count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const actual = await locator.count();
    if (actual === count) return;
    if (Date.now() >= deadline) {
      throw new Error(`期望匹配 ${count} 个元素，实际 ${actual} 个（20s 超时）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** 轮询直到 locator 处于启用状态。 */
export async function expectEnabled(locator: Locator): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (await locator.isEnabled()) return;
    if (Date.now() >= deadline) {
      throw new Error("期望元素可用，仍处于禁用状态（20s 超时）");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** 断言 locator 当前处于禁用状态（先等待可见）。 */
export async function expectDisabled(locator: Locator): Promise<void> {
  await expectVisible(locator);
  if (!(await locator.isDisabled())) {
    throw new Error("期望元素禁用，实际可用");
  }
}
