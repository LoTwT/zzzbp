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

/**
 * 整页不超出工作区基准（docs/specs/room-layout.md「设备支持范围」：
 * 工作区宽 = max(可用内容区宽度, 1024px)，高 = max(可用内容区高度, 768px)）——
 * 视口低于对应基准时允许且仅允许整页滚动到该基准，超过即视为内容把工作区
 * 撑开。各区域内部列表的滚动仍由布局约束，不在此断言。
 */
export async function assertNoOverflow(page: Page, label: string): Promise<void> {
  const info = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    vw: window.innerWidth,
    vh: window.innerHeight,
  }));
  const maxPageHeight = Math.max(info.vh, 768);
  const maxPageWidth = Math.max(info.vw, 1024);
  if (info.scrollW > maxPageWidth + 1 || info.scrollH > maxPageHeight + 1) {
    throw new Error(
      `${label} 页面出现整页越界（${info.scrollW}x${info.scrollH} vs ${info.vw}x${info.vh}，横向上限 ${maxPageWidth}、纵向上限 ${maxPageHeight}）`,
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

// ---- 两轮分隔与选用槽位内容（实时房间、展示页、记录页共用同一几何断言） ----

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** 在页面内量取槽位/分隔线矩形所需的原始数据。 */
async function readSlotGeometry(
  page: Page,
  side: "A" | "B",
): Promise<{
  readonly banBreakCount: number;
  readonly pickBreakCount: number;
  readonly banBreak: Rect | null;
  readonly banBefore: Rect | null;
  readonly banAfter: Rect | null;
  readonly pickBreak: Rect | null;
  readonly pickBefore: Rect | null;
  readonly pickAfter: Rect | null;
}> {
  return page.evaluate((team) => {
    const toRect = (element: Element | null): Rect | null => {
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    };
    const banArea = document.querySelector(`[aria-label="${team} 方禁用区"]`);
    const pickArea = document.querySelector(`[aria-label="${team} 方选用区"]`);
    const banBreaks = banArea?.querySelectorAll('[data-round-break="ban"]') ?? [];
    const pickBreaks = pickArea?.querySelectorAll('[data-round-break="pick"]') ?? [];
    return {
      banBreakCount: banBreaks.length,
      pickBreakCount: pickBreaks.length,
      banBreak: toRect(banBreaks[0] ?? null),
      banBefore: toRect(banArea?.querySelector(`[data-slot-id="${team}B2"]`) ?? null),
      banAfter: toRect(banArea?.querySelector(`[data-slot-id="${team}B3"]`) ?? null),
      pickBreak: toRect(pickBreaks[0] ?? null),
      pickBefore: toRect(pickArea?.querySelector(`[data-slot-id="${team}P6"]`) ?? null),
      pickAfter: toRect(pickArea?.querySelector(`[data-slot-id="${team}P7"]`) ?? null),
    };
  }, side);
}

/**
 * 两轮分隔的几何断言：每方禁用区恰有一条竖线落在第 2、3 个禁用位之间，
 * 每方选用区恰有一条横线落在第 6、7 个选用位之间（与布局无关，按权威
 * 槽位判定；实时房间、展示页、记录页一致）。
 */
export async function assertRoundBreaks(page: Page, label: string): Promise<void> {
  for (const side of ["A", "B"] as const) {
    const geometry = await readSlotGeometry(page, side);
    if (geometry.banBreakCount !== 1 || geometry.pickBreakCount !== 1) {
      throw new Error(
        `${label} ${side} 方分隔线数量异常（禁用 ${geometry.banBreakCount}、选用 ${geometry.pickBreakCount}）`,
      );
    }
    const { banBreak, banBefore, banAfter, pickBreak, pickBefore, pickAfter } = geometry;
    if (banBreak === null || banBefore === null || banAfter === null) {
      throw new Error(`${label} ${side} 方缺少禁用槽位或分隔线`);
    }
    if (!(banBreak.left >= banBefore.right && banBreak.right <= banAfter.left)) {
      throw new Error(`${label} ${side} 方禁用分隔线未落在第 2、3 个禁用位之间`);
    }
    if (pickBreak === null || pickBefore === null || pickAfter === null) {
      throw new Error(`${label} ${side} 方缺少选用槽位或分隔线`);
    }
    if (!(pickBreak.top >= pickBefore.bottom && pickBreak.bottom <= pickAfter.top)) {
      throw new Error(`${label} ${side} 方选用分隔线未落在第 6、7 个选用位之间`);
    }
  }
}

/**
 * 选用槽位的可见文本：跳过 sr-only（读屏专用）文案，得到用户实际看到
 * 的文字。槽位不显示数字角标，因此可见文本只能是代理人名称或空串。
 */
export async function pickCardVisibleTexts(page: Page, side: "A" | "B"): Promise<string[]> {
  return page.evaluate((team) => {
    const visibleTextOf = (element: Element): string => {
      let text = "";
      for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent ?? "";
          continue;
        }
        if (!(node instanceof HTMLElement) || node.classList.contains("sr-only")) continue;
        text += visibleTextOf(node);
      }
      return text;
    };
    const cards = document.querySelectorAll(`[aria-label="${team} 方选用区"] [data-slot-id]`);
    return [...cards].map((card) => visibleTextOf(card).trim());
  }, side);
}

/** 断言选定槽位没有可见的数字角标（只允许空串或代理人名称）。 */
export async function assertNoSlotNumbers(
  page: Page,
  label: string,
  expectedNames: ReadonlySet<string>,
): Promise<void> {
  for (const side of ["A", "B"] as const) {
    const texts = await pickCardVisibleTexts(page, side);
    for (const text of texts) {
      if (text === "" || expectedNames.has(text)) continue;
      throw new Error(`${label} ${side} 方选用槽位出现非名称可见内容：「${text}」`);
    }
  }
}

/**
 * 顶部优先级：空间不足时先收缩队名，中央赛事信息保持可读。
 *
 * 量测：中央列剩余宽度（房间名/状态所在列，含 12rem 下限）、连接提示与
 * 状态是否仍单行渲染（不出现逐字竖排）、双方队名是否已截断（说明先收缩
 * 的是队名而不是中央信息）。
 */
export async function assertHeaderPrioritizesCenter(page: Page, label: string): Promise<void> {
  const geometry = await page.evaluate(() => {
    const header = document.querySelector("header");
    if (!(header instanceof HTMLElement)) throw new Error("未找到顶部区域");
    const title = header.querySelector("h1");
    const center = title?.parentElement ?? null;
    if (!(center instanceof HTMLElement)) throw new Error("未找到中央赛事信息列");
    const centerBox = center.getBoundingClientRect();
    const singleLine = (element: Element | null): number | null =>
      element instanceof HTMLElement ? Math.round(element.getBoundingClientRect().height) : null;
    const names = [...header.querySelectorAll("p[title]")].filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    return {
      centerWidth: Math.round(centerBox.width),
      statusHeight: singleLine(header.querySelector("h1")?.nextElementSibling ?? null),
      noticeHeight: singleLine(header.querySelector('[role="status"]')),
      names: names.map((element) => ({
        text: (element.textContent ?? "").trim(),
        truncated: element.scrollWidth > element.clientWidth,
        width: Math.round(element.getBoundingClientRect().width),
      })),
    };
  });
  if (geometry.centerWidth < 176) {
    throw new Error(`${label} 中央赛事信息列被挤压到 ${geometry.centerWidth}px（下限 11rem）`);
  }
  if (geometry.statusHeight !== null && geometry.statusHeight > 28) {
    throw new Error(`${label} 状态行高度 ${geometry.statusHeight}px，出现换行/竖排`);
  }
  if (geometry.noticeHeight !== null && geometry.noticeHeight > 28) {
    throw new Error(`${label} 连接提示高度 ${geometry.noticeHeight}px，出现换行/竖排`);
  }
  if (geometry.names.length !== 2 || geometry.names.some((entry) => !entry.truncated)) {
    const detail = geometry.names
      .map((entry) => `${entry.text.slice(0, 6)}…(${entry.width}px,truncated=${entry.truncated})`)
      .join(" ");
    throw new Error(`${label} 长队名没有先收缩/截断：${detail}`);
  }
}

/**
 * 确认按钮不被面板覆盖：面板只覆盖池区，底部操作区保持独立（见
 * docs/specs/room-layout.md「控制面板」「桌面端滚动方式」）。用矩形相交
 * 判定，与页面是否滚动无关（低于最小高度时操作区可能位于首屏之外）。
 */
export async function assertConfirmNotCovered(page: Page, label: string): Promise<void> {
  await expectVisible(confirmButton(page));
  const result = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="控制面板"]');
    const button = [...document.querySelectorAll("button")].find((candidate) =>
      /确认禁用|确认选用/.test(candidate.textContent ?? ""),
    );
    if (!(dialog instanceof HTMLElement) || !(button instanceof HTMLElement)) {
      throw new Error("未找到控制面板或确认按钮");
    }
    const panel = dialog.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    return {
      overlaps:
        box.left < panel.right &&
        box.right > panel.left &&
        box.top < panel.bottom &&
        box.bottom > panel.top,
    };
  });
  if (result.overlaps) throw new Error(`${label} 控制面板覆盖了确认按钮`);
}

/**
 * 队伍标识位置：队名紧邻各自禁用区靠近中间的一侧（A 在禁用格右侧、
 * B 在禁用格左侧，两队名称分列赛事信息两旁），同处顶部区域且与禁用区
 * 同一行；文本与期望一致（空席为「待选择」）。
 */
export async function assertTeamNameBesideBans(
  page: Page,
  label: string,
  expected: Readonly<Record<"A" | "B", string>>,
): Promise<void> {
  const geometry = await page.evaluate(() => {
    const header = document.querySelector("header");
    const read = (team: "A" | "B") => {
      const ban = header?.querySelector(`[aria-label="${team} 方禁用区"]`);
      if (!(ban instanceof HTMLElement)) return null;
      const name = team === "A" ? ban.nextElementSibling : ban.previousElementSibling;
      if (!(name instanceof HTMLElement)) return null;
      const banBox = ban.getBoundingClientRect();
      const nameBox = name.getBoundingClientRect();
      return {
        text: (name.textContent ?? "").trim(),
        insideHeader: header?.contains(name) === true,
        sameRow: nameBox.top < banBox.bottom && nameBox.bottom > banBox.top,
        // A 方队名在禁用格右侧、B 方在左侧（都靠中间）。
        innerA: team === "A" ? nameBox.left >= banBox.right - 1 : true,
        innerB: team === "B" ? nameBox.right <= banBox.left + 1 : true,
      };
    };
    return { A: read("A"), B: read("B") };
  });
  for (const side of ["A", "B"] as const) {
    const entry = geometry[side];
    if (entry === null) throw new Error(`${label} ${side} 方缺少队名或禁用区`);
    if (!entry.insideHeader) throw new Error(`${label} ${side} 方队名不在顶部区域`);
    if (!entry.sameRow) throw new Error(`${label} ${side} 方队名与禁用区不在同一行`);
    if (!entry.innerA || !entry.innerB) {
      throw new Error(`${label} ${side} 方队名没有落在禁用区靠中间的一侧`);
    }
    if (entry.text !== expected[side]) {
      throw new Error(`${label} ${side} 方队名显示「${entry.text}」，期望「${expected[side]}」`);
    }
  }
}

/**
 * 选用区与中央区域同高：两侧选用槽位（九行填充卡片）的上下边界与中央
 * 面板对齐——顶部不含队名条（队名在顶部禁用区旁），底部由最后一行撑满，
 * 偏差不超过 8px（列内边距与两轮分隔线）。
 * 中央区域的 aria-label 在实时房间/展示页为「代理人池」，记录页为「禁选顺序」。
 */
export async function assertPickColumnsMatchPool(
  page: Page,
  label: string,
  centerAriaLabel = "代理人池",
): Promise<void> {
  const geometry = await page.evaluate((centerLabel) => {
    const panel = document.querySelector(`section[aria-label="${centerLabel}"]`);
    if (!(panel instanceof HTMLElement)) throw new Error(`未找到中央区域：${centerLabel}`);
    const panelBox = panel.getBoundingClientRect();
    const sides = (["A", "B"] as const).map((team) => {
      const cards = [
        ...document.querySelectorAll(`[aria-label="${team} 方选用区"] [data-slot-id]`),
      ];
      if (cards.length === 0) throw new Error(`未找到 ${team} 方选用槽位`);
      const boxes = cards.map((card) => card.getBoundingClientRect());
      return {
        count: cards.length,
        top: Math.min(...boxes.map((box) => box.top)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
        card: { w: Math.round(boxes[0]!.width), h: Math.round(boxes[0]!.height) },
      };
    });
    return { panel: { top: panelBox.top, bottom: panelBox.bottom }, sides };
  }, centerAriaLabel);
  for (const [index, side] of geometry.sides.entries()) {
    const name = index === 0 ? "A" : "B";
    if (side.count !== 9) {
      throw new Error(`${label} ${name} 方选用槽位应为 9 个，实际 ${side.count} 个`);
    }
    if (Math.abs(side.top - geometry.panel.top) > 8) {
      throw new Error(
        `${label} ${name} 方选用槽位顶部与中央区域不齐（${side.top.toFixed(1)} vs ${geometry.panel.top.toFixed(1)}，槽位 ${side.card.w}×${side.card.h}）`,
      );
    }
    if (Math.abs(side.bottom - geometry.panel.bottom) > 8) {
      throw new Error(
        `${label} ${name} 方选用槽位底部与中央区域不齐（${side.bottom.toFixed(1)} vs ${geometry.panel.bottom.toFixed(1)}）`,
      );
    }
  }
}
