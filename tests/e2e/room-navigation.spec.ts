import { expect, test } from "vitest";
import { chromium, type Page, type WebSocket } from "playwright";
import { roomEntryResponseSchema } from "../../shared/contracts/http";
import {
  assertNoPageErrors,
  createRoomViaUi,
  newRoomContext,
  openPanel,
  saveTeamName,
} from "./helpers";
import { E2E_BASE_URL } from "./server";

/** 只观测业务连接，排除 Vite HMR；关闭断言证明旧 session 已释放。 */
function trackRoomSockets(page: Page): WebSocket[] {
  const sockets: WebSocket[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/api/rooms/")) sockets.push(socket);
  });
  return sockets;
}

test("历史菜单跨房间跳转：URL、画面和命令目标一致，旧连接关闭", async () => {
  const browser = await chromium.launch();
  try {
    const host = await newRoomContext(browser, "navigation", { width: 1440, height: 900 });
    const page = host.page;
    const sockets = trackRoomSockets(page);
    const urlA = await createRoomViaUi(host, "历史房间 A", "房主");
    await page.getByRole("link", { name: "返回首页" }).click();
    // 保持同一 document 的历史：A → 首页 → B，不能用 goto 代替。
    await page.fill("#home-room-name", "历史房间 B");
    await page.fill("#home-nickname", "房主");
    await page.getByRole("button", { name: "创建房间", exact: true }).click();
    await page.getByRole("heading", { name: "历史房间 B", exact: true }).waitFor();
    const urlB = page.url();
    await openPanel(page);
    await saveTeamName(page, "A", "B 原始队名");
    const socketB = sockets.find((socket) => socket.url().endsWith(`${new URL(urlB).pathname}/ws`));
    expect(socketB).toBeDefined();

    // 浏览器后退菜单直接选择 A，跳过首页；Vue Router 必须重建房间会话。
    await page.evaluate(() => history.go(-2));
    await page.waitForURL(urlA);
    await page.getByRole("heading", { name: "历史房间 A", exact: true }).waitFor();
    await expect.poll(() => socketB?.isClosed()).toBe(true);
    await openPanel(page);
    await saveTeamName(page, "A", "A 跳转后队名");

    for (const [url, name] of [
      [urlA, "A 跳转后队名"],
      [urlB, "B 原始队名"],
    ] as const) {
      const response = await page.request.get(`${E2E_BASE_URL}/api${new URL(url).pathname}`);
      expect(response.ok()).toBe(true);
      const entry = roomEntryResponseSchema.parse(await response.json());
      if (entry.kind !== "live" || entry.memberView === null) throw new Error("应恢复房主身份");
      expect(entry.memberView.teamNames.A).toBe(name);
    }
    expect(
      sockets
        .filter((socket) => !socket.isClosed())
        .map((socket) => new URL(socket.url()).pathname),
    ).toEqual([`/api${new URL(urlA).pathname}/ws`]);
    assertNoPageErrors(host);
  } finally {
    await browser.close();
  }
});

test("展示页历史跳转按新 roomId 重建目录与展示连接", async () => {
  const browser = await chromium.launch();
  try {
    const host = await newRoomContext(browser, "display-host", { width: 1440, height: 900 });
    const urlA = await createRoomViaUi(host, "展示房间 A", "房主");
    const urlB = await createRoomViaUi(host, "展示房间 B", "房主");
    const display = await newRoomContext(browser, "display-navigation", {
      width: 1280,
      height: 720,
    });
    const page = display.page;
    const sockets = trackRoomSockets(page);
    const catalogs: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/catalog"))
        catalogs.push(new URL(request.url()).pathname);
    });
    await page.goto(`${urlB}/display`);
    await page.getByRole("heading", { name: "展示房间 B", exact: true }).waitFor();
    await page.getByRole("list", { name: "代理人池", exact: true }).waitFor();
    const oldSocket = sockets[0];
    expect(oldSocket).toBeDefined();
    // 创建同文档历史项再后退，交给 Router 的 popstate 处理，避免整页导航掩盖复用问题。
    await page.evaluate((target) => {
      const original = location.href;
      const state = history.state;
      history.replaceState(state, "", target);
      history.pushState(state, "", original);
      history.back();
    }, `${urlA}/display`);
    await page.waitForURL(`${urlA}/display`);
    await page.getByRole("heading", { name: "展示房间 A", exact: true }).waitFor();
    await page.getByRole("list", { name: "代理人池", exact: true }).waitFor();
    await expect.poll(() => oldSocket?.isClosed()).toBe(true);
    expect(catalogs).toEqual([
      `/api${new URL(urlB).pathname}/catalog`,
      `/api${new URL(urlA).pathname}/catalog`,
    ]);
    expect(
      sockets
        .filter((socket) => !socket.isClosed())
        .map((socket) => new URL(socket.url()).pathname),
    ).toEqual([`/api${new URL(urlA).pathname}/display/ws`]);
    assertNoPageErrors(host);
    assertNoPageErrors(display);
  } finally {
    await browser.close();
  }
});
