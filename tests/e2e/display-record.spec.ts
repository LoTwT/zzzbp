import { expect, test } from "vitest";
import { chromium } from "playwright";
import type { Page } from "playwright";
import type { AgentEntry } from "../../shared/agents/schema";
import {
  AGENTS,
  AGENT_DATA_VERSION,
  BP_ORDER,
  LONGEST_NAME_AGENT,
  NO_AVATAR_AGENTS,
  agentCard,
  assertNoOverflow,
  assertNoPageErrors,
  avatarUrlOf,
  closePanel,
  createRoomViaUi,
  expectCount,
  expectVisible,
  joinRoomViaUi,
  newRoomContext,
  openPanel,
  preselectText,
  saveTeamName,
  assignSeatViaUi,
  stepOf,
  submitStep,
  waitForStatus,
} from "./helpers";
import { E2E_BASE_URL } from "./server";

/**
 * 展示页与只读记录页端到端验收（PR10）。
 *
 * 展示页走真实后端：匿名直开（无昵称、无入房表单）、URL 冻结布局、
 * 公开预选与禁选结果实时同步、全量代理人同屏（卡片数量 + 裁剪容器无
 * 内部滚动 + 网格与末卡片几何包含，两种代表布局）、无搜索/确认/面板
 * 入口、不建立成员身份（websocket 事件观测：仅展示 WS；请求观测：
 * 零 POST /api/rooms）。
 *
 * 记录页采用分层证据：浏览器侧注入「合法固定快照响应」验证记录界面
 * 与终态分流（与 PR9 验收同一手法）；真实的 12 小时到期裁决、Alarm
 * 归档与 90 天清理由真实 workerd 集成测试证明（tests/workers/
 * room-lifecycle.test.ts），浏览器不冒称端到端自然到期。真实 404
 * （随机 roomId）不注入，走真实后端验证统一不存在页。
 */

const AVATAR_CDN_PATTERN = "**/static.nanoka.cc/**";

/** 展示页卡片（非交互 li，aria-label 命名）。 */
function displayCard(page: Page, name: string, state?: "已禁用" | "已选用") {
  const label = state === undefined ? name : `${name}（${state}）`;
  return page.locator(`li[aria-label="${label}"]`);
}

/** 归档快照构造：前 count 步按权威顺序与目录条目生成合法快照。 */
function buildSnapshot(roomId: string, count: number) {
  const archivedAt = "2026-10-05T02:00:00.000Z";
  const operations = BP_ORDER.slice(0, count).map((slotId, index) => {
    // 前缀内代理人唯一；掺入缺头像与最长名称代理人作为展示代表。
    let entry: AgentEntry | undefined = AGENTS[index];
    if (index === 2) entry = NO_AVATAR_AGENTS[0];
    if (index === 5) entry = LONGEST_NAME_AGENT;
    const { team, action } = stepOf(slotId);
    return {
      slotId,
      team,
      action,
      agentId: entry?.id ?? "",
      agentName: entry?.name ?? "",
      agentAvatarUrl: entry === undefined ? null : avatarUrlOf(entry),
    };
  });
  return {
    roomId,
    roomName: "归档验收赛",
    teamNames: { A: "甲队", B: "乙".repeat(32) },
    bpCompleted: count === BP_ORDER.length,
    operations,
    versions: { ruleVersion: "1", agentDataVersion: AGENT_DATA_VERSION },
    archivedAt,
    expiresAt: "2027-01-03T02:00:00.000Z",
  };
}

/** 页面级网络记录：业务 WS 与 POST /api/rooms 的判定基础。 */
function watchNetwork(page: Page, sink: Array<{ url: string; method: string }>): void {
  page.on("request", (request) => {
    sink.push({ url: request.url(), method: request.method() });
  });
}

/**
 * 展示池几何断言：DOM 数量只能证明"渲染了 58 张卡片"，不能排除内部裁切
 * 或内部滚动。这里基于实际几何检查：裁剪容器（overflow-hidden 的网格
 * 边界）无滚动溢出，网格与末卡片完整落在容器矩形内（±1px 取整容差）。
 */
async function assertDisplayPoolFits(page: Page, label: string): Promise<void> {
  const geometry = await page.evaluate(() => {
    const section = document.querySelector('section[aria-label="代理人池"]');
    const container = section?.firstElementChild;
    const grid = section?.querySelector('ul[aria-label="代理人池"]');
    if (!(container instanceof HTMLElement) || !(grid instanceof HTMLElement)) {
      throw new Error("未找到展示池容器或网格");
    }
    const cards = grid.querySelectorAll("li");
    const last = cards[cards.length - 1] ?? null;
    const box = container.getBoundingClientRect();
    const gridBox = grid.getBoundingClientRect();
    const lastBox = last instanceof HTMLElement ? last.getBoundingClientRect() : null;
    const within = (inner: DOMRect): boolean =>
      inner.top >= box.top - 1 &&
      inner.bottom <= box.bottom + 1 &&
      inner.left >= box.left - 1 &&
      inner.right <= box.right + 1;
    return {
      cards: cards.length,
      scrollW: container.scrollWidth,
      scrollH: container.scrollHeight,
      clientW: container.clientWidth,
      clientH: container.clientHeight,
      gridWithin: within(gridBox),
      lastWithin: lastBox !== null && within(lastBox),
    };
  });
  if (geometry.scrollW > geometry.clientW + 1 || geometry.scrollH > geometry.clientH + 1) {
    throw new Error(
      `${label} 展示池内部出现滚动/裁切（${geometry.scrollW}x${geometry.scrollH} vs ${geometry.clientW}x${geometry.clientH}）`,
    );
  }
  if (!geometry.gridWithin) throw new Error(`${label} 展示网格超出裁剪容器`);
  if (!geometry.lastWithin) throw new Error(`${label} 末卡片超出裁剪容器（可能被裁切）`);
}

test("展示页：匿名直开、布局冻结、实时同步且不建立成员身份", async () => {
  const browser = await chromium.launch();
  try {
    // ---- 真实后端：建房开局并推进三步 ----
    const host = await newRoomContext(browser, "host", { width: 1440, height: 900 });
    const roomUrl = await createRoomViaUi(host, "首版验收·展示赛", "主办小鱼");
    const roomId = /\/rooms\/([^/?#]+)/.exec(roomUrl)?.[1] ?? "";
    const playerA = await newRoomContext(browser, "playerA", { width: 1440, height: 900 });
    const playerB = await newRoomContext(browser, "playerB", { width: 1280, height: 640 });
    await joinRoomViaUi(playerA, roomUrl, "选手甲");
    await joinRoomViaUi(playerB, roomUrl, "选手乙");
    await openPanel(host.page);
    await saveTeamName(host.page, "A", "甲队");
    await saveTeamName(host.page, "B", "乙队");
    await assignSeatViaUi(host.page, "A", "选手甲");
    await assignSeatViaUi(host.page, "B", "选手乙");
    await host.page.getByRole("button", { name: "开始 BP", exact: true }).click();
    await closePanel(host.page);

    const plan = AGENTS.slice(0, 26).map((entry) => entry.name);
    await submitStep(playerA.page, "AB1", plan[0] ?? "");
    await submitStep(playerB.page, "BB1", plan[1] ?? "");

    // ---- 匿名上下文直开展示页（URL 冻结布局 byPick，1280×640） ----
    const display = await newRoomContext(browser, "display", { width: 1280, height: 640 });
    const displayRequests: Array<{ url: string; method: string }> = [];
    watchNetwork(display.page, displayRequests);
    const displaySockets: string[] = [];
    display.page.on("websocket", (socket) => displaySockets.push(socket.url()));
    await display.page.goto(`${E2E_BASE_URL}/rooms/${roomId}/display?layout=byPick`);
    await display.page.getByText("首版验收·展示赛").first().waitFor();
    await waitForStatus(display.page, "进行中");
    // URL 冻结布局生效：B 方选用区按 Pick 分行共 5 行（竖排为 9 行）。
    await expectCount(display.page.locator('section[aria-label="B 方选用区"] > div > div'), 5);
    // 无入房表单、无搜索/确认/面板入口。
    expect(await display.page.getByRole("heading", { name: "进入房间" }).count()).toBe(0);
    expect(await display.page.getByLabel("搜索代理人名称").count()).toBe(0);
    expect(await display.page.getByRole("button", { name: /确认禁用|确认选用/ }).count()).toBe(0);
    expect(await display.page.getByRole("button", { name: "控制面板", exact: true }).count()).toBe(
      0,
    );
    // 全量代理人同屏：58 名全部渲染，页面无整页越界。
    await expectCount(display.page.locator("section[aria-label='代理人池'] li"), AGENTS.length);
    await assertNoOverflow(display.page, "展示页 byPick 1280x640");
    await assertDisplayPoolFits(display.page, "展示页 byPick 1280x640");
    // 已禁用结果与队名同步（缺头像代理人正常显示名称）。
    await displayCard(display.page, plan[1] ?? "", "已禁用").waitFor({ state: "visible" });
    await display.page.getByText("乙队", { exact: true }).first().waitFor();

    // 刷新同一链接仍保留冻结布局（不写回存储、不回落本地偏好）。
    await display.page.reload();
    await display.page.getByText("首版验收·展示赛").first().waitFor();
    await expectCount(display.page.locator('section[aria-label="B 方选用区"] > div > div'), 5);

    // ---- 公开预选实时同步到展示页 ----
    await agentCard(playerA.page, plan[2] ?? "").click();
    await preselectText(display.page, plan[2] ?? "").waitFor({ state: "visible" });
    await submitStep(playerA.page, "AB2", plan[2] ?? "");
    await displayCard(display.page, plan[2] ?? "", "已禁用").waitFor({ state: "visible" });

    // ---- 布局参数缺失/非法：回退本地偏好（新上下文默认竖排） ----
    await display.page.goto(`${E2E_BASE_URL}/rooms/${roomId}/display?layout=nonsense`);
    await display.page.getByText("首版验收·展示赛").first().waitFor();
    await waitForStatus(display.page, "进行中");
    await expectCount(display.page.locator('section[aria-label="B 方选用区"] > div > div'), 9);
    await assertDisplayPoolFits(display.page, "展示页 竖排 1280x640");

    // ---- 展示连接不建立成员身份：仅展示 WS、零成员 WS、零 POST、零 Cookie ----
    expect(displaySockets.some((url) => url.endsWith(`/api/rooms/${roomId}/display/ws`))).toBe(
      true,
    );
    expect(displaySockets.some((url) => url.endsWith(`/api/rooms/${roomId}/ws`))).toBe(false);
    expect(
      displayRequests.some((item) => item.method === "POST" && item.url.includes("/api/rooms/")),
    ).toBe(false);
    const identityCookies = (await display.context.cookies()).filter((cookie) =>
      cookie.name.startsWith("zzzbp_room_"),
    );
    expect(identityCookies).toHaveLength(0);

    assertNoPageErrors(display);
    assertNoPageErrors(host);
    assertNoPageErrors(playerA);
    assertNoPageErrors(playerB);
  } finally {
    await browser.close();
  }
}, 240_000);

test("记录页：完成/未完成快照、两布局、终态分流与真实 404", async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 640 } });
    context.setDefaultTimeout(20_000);
    await context.route(AVATAR_CDN_PATTERN, (route) => route.abort());
    const page = await context.newPage();
    const errors: string[] = [];
    // WS 观测必须用 websocket 事件：page.on("request") 看不到 WS 握手
    // （已由探针证实 request 事件不含 /ws 请求），旧写法即使开了连接也照样通过。
    const recordSockets: string[] = [];
    page.on("websocket", (socket) => recordSockets.push(socket.url()));
    page.on("pageerror", (error) => errors.push(`[record] pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // 被主动拦截的头像 CDN 请求产生预期资源加载失败，不计入错误。
      if (message.text().startsWith("Failed to load resource")) return;
      errors.push(`[record] console.error: ${message.text()}`);
    });

    // ---- 完成快照（26 步）：注入合法归档响应 ----
    const roomId = "11111111-1111-4111-8111-111111111111";
    const completed = buildSnapshot(roomId, BP_ORDER.length);
    const requests: Array<{ url: string; method: string }> = [];
    watchNetwork(page, requests);
    await context.route(`**/api/rooms/${roomId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({ kind: "archived", record: completed }),
      });
    });
    await page.goto(`${E2E_BASE_URL}/rooms/${roomId}`);
    await page.getByText("只读记录 · 已完成", { exact: true }).waitFor();
    await page.getByText("共 26 步", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "归档验收赛" }).waitFor();
    await assertNoOverflow(page, "记录页 已完成 1280x640");
    // 列表首步与末步：连续顺序、左右方动作文案、缺头像/最长名称代表。
    await page.getByText("第 1 步：左方禁用", { exact: false }).first().waitFor();
    await page
      .getByText(`第 26 步：左方选用 ${completed.operations[25]?.agentName ?? ""}`, {
        exact: false,
      })
      .first()
      .waitFor();
    await page.getByText("已禁用：", { exact: false }).first().waitFor();

    // 两种布局切换（个人设置，不改变快照）。
    await openPanel(page);
    await page.getByRole("button", { name: "按 Pick 分行", exact: true }).click();
    await closePanel(page);
    await assertNoOverflow(page, "记录页 已完成 byPick");
    // 控制面板：复制链接与记录到期时间。
    await openPanel(page);
    await expectVisible(page.getByRole("button", { name: "复制房间链接", exact: true }));
    await page.getByText("记录到期时间：", { exact: false }).waitFor();
    await closePanel(page);

    // 完成快照阶段的记录页零业务 WS（websocket 事件观测）与零 POST（请求观测）。
    // 断言点在多次页面交互之后（渲染、两布局、面板），任何 WS 握手都已被记录。
    const socketsAfterCompleted = [...recordSockets];
    expect(socketsAfterCompleted.filter((url) => url.endsWith("/ws"))).toHaveLength(0);
    expect(
      requests.some((item) => item.method === "POST" && item.url.includes("/api/rooms/")),
    ).toBe(false);

    // ---- 未完成快照（10 步）：明确标为未完成，只列已提交部分 ----
    const roomIdIncomplete = "22222222-2222-4222-8222-222222222222";
    const incomplete = buildSnapshot(roomIdIncomplete, 10);
    await context.route(`**/api/rooms/${roomIdIncomplete}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({ kind: "archived", record: incomplete }),
      });
    });
    const socketsBeforeIncomplete = recordSockets.length;
    await page.goto(`${E2E_BASE_URL}/rooms/${roomIdIncomplete}`);
    await page.getByText("只读记录 · 未完成", { exact: true }).waitFor();
    await page.getByText("共 10 步", { exact: true }).waitFor();
    await page.getByText("第 10 步：", { exact: false }).first().waitFor();
    // 未完成记录阶段同样零业务 WS（仅统计本阶段新增事件）。
    expect(
      recordSockets.slice(socketsBeforeIncomplete).filter((url) => url.endsWith("/ws")),
    ).toHaveLength(0);

    // ---- 入房进行中被归档：POST 410 + GET archived → 转记录读取 ----
    const roomIdJoining = "33333333-3333-4333-8333-333333333333";
    let archived = false;
    await context.route(`**/api/rooms/${roomIdJoining}`, async (route) => {
      const body = archived
        ? JSON.stringify({ kind: "archived", record: buildSnapshot(roomIdJoining, 4) })
        : JSON.stringify({ kind: "live", roomName: "入房中被归档", memberView: null });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body,
      });
    });
    await context.route(`**/api/rooms/${roomIdJoining}/members`, async (route) => {
      archived = true;
      await route.fulfill({
        status: 410,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({ error: { code: "ROOM_ARCHIVED", message: "房间已归档" } }),
      });
    });
    await page.goto(`${E2E_BASE_URL}/rooms/${roomIdJoining}`);
    await page.getByRole("heading", { name: "进入房间" }).waitFor();
    await page.fill("#join-nickname", "入房者");
    await page.getByRole("button", { name: "进入房间", exact: true }).click();
    await page.getByText("只读记录 · 未完成", { exact: true }).waitFor();
    await page.getByText("共 4 步", { exact: true }).waitFor();

    // ---- 真实 404：随机 roomId 走真实后端 → 统一不存在页 ----
    const randomRoomId = crypto.randomUUID();
    await page.goto(`${E2E_BASE_URL}/rooms/${randomRoomId}`);
    await page.getByText("房间不存在或已过期", { exact: true }).waitFor();
    await expectVisible(page.getByRole("link", { name: "创建新房间" }));

    expect(errors).toHaveLength(0);
    await context.close();
  } finally {
    await browser.close();
  }
}, 240_000);
