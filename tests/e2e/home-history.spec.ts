import { expect, test } from "vitest";
import { chromium } from "playwright";
import type { Locator, Page } from "playwright";
import {
  AGENT_DATA_VERSION,
  assertNoPageErrors,
  createRoomViaUi,
  expectCount,
  expectHidden,
  expectVisible,
  joinRoomViaUi,
  newRoomContext,
  newSameIdentityPage,
} from "./helpers";
import { E2E_BASE_URL } from "./server";

/**
 * 首页「最近参与」本机清单端到端验收（docs/specs/room-layout.md
 * 「首页与首次入房」，行为规则见 docs/specs/room-roles.md「本机参与记录」）。
 *
 * 分层证据：
 * - 真实后端覆盖创建、以昵称加入、有效身份恢复三种记录时机，以及
 *   「仅打开链接停留在昵称表单不记录」；同时观测清单的状态读取不发成员
 *   POST、不建立业务 WS（credentials: omit 的匿名公开读）。
 * - 生命周期状态用浏览器侧注入固定响应覆盖已归档与暂时无法确认，
 *   真实 404 不注入、走随机 roomId 验证「不存在或已过期」。
 * - 界面结构性验证：默认 10 条、显示更多、四种状态与操作入口、
 *   长房间名截断（完整名称可读）、清空历史的二次确认与删除边界、
 *   键盘可达、整页纵向滚动且卡片内不滚动。
 *
 * 视口取桌面基准 1440×900 与最小支持宽度 1024×768。
 */

const HISTORY_KEY_PREFIX = "zzzbp.recent-rooms.v1.";
/** 与其它功能无关的存储键：验证清空历史只删除本功能自己的数据。 */
const UNRELATED_KEY = "other-app:preference";
const ARCHIVED_AT = "2026-10-05T02:00:00.000Z";
const EXPIRES_AT = "2027-01-03T02:00:00.000Z";
const LONG_ROOM_NAME = "超长赛事名称展示测试专用".repeat(5);

interface SeedEntry {
  readonly roomId: string;
  readonly roomName: string;
  readonly lastVisitedAt: string;
}

function card(page: Page): Locator {
  return page.getByRole("region", { name: "最近参与" });
}

function row(target: Locator, roomName: string): Locator {
  return target.getByRole("listitem").filter({ hasText: roomName });
}

function localDate(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 预置本机清单（在每次页面加载前执行，先清空再写入确定的记录与外部键）。 */
async function seedHistory(
  page: Page,
  entries: readonly SeedEntry[],
  extra: Readonly<Record<string, string>> = {},
): Promise<void> {
  await page.addInitScript(
    (payload) => {
      window.localStorage.clear();
      for (const [key, value] of Object.entries(payload.extra)) {
        window.localStorage.setItem(key, value);
      }
      for (const entry of payload.entries) {
        window.localStorage.setItem(
          `zzzbp.recent-rooms.v1.${entry.roomId}`,
          JSON.stringify({ version: 1, ...entry }),
        );
      }
    },
    { entries, extra },
  );
}

/** 读取本机清单的持久内容（键 → 载荷）。 */
async function readStoredHistory(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate((prefix) => {
    const result: Record<string, unknown> = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key === null || !key.startsWith(prefix)) continue;
      const raw = window.localStorage.getItem(key) ?? "";
      try {
        result[key.slice(prefix.length)] = JSON.parse(raw);
      } catch {
        result[key.slice(prefix.length)] = "invalid";
      }
    }
    return result;
  }, HISTORY_KEY_PREFIX);
}

function watchNetwork(page: Page): {
  requests: Array<{ url: string; method: string }>;
  sockets: string[];
} {
  const record = {
    requests: [] as Array<{ url: string; method: string }>,
    sockets: [] as string[],
  };
  page.on("request", (request) =>
    record.requests.push({ url: request.url(), method: request.method() }),
  );
  page.on("websocket", (socket) => record.sockets.push(socket.url()));
  return record;
}

/** 轮询等待条件成立（页面动画/网络时序无关的稳定判定）。 */
async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${message}（20s 超时）`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface RowGeometry {
  readonly name: {
    readonly text: string;
    readonly title: string | null;
    readonly truncated: boolean;
    readonly height: number;
  } | null;
  readonly textRight: number;
  readonly actionsLeft: number;
  readonly actionsHeight: number;
}

/** 量取每行的文本列与操作列几何（判定互不遮挡、操作按钮单行）。 */
async function readRowGeometry(target: Locator): Promise<RowGeometry[]> {
  return target.evaluate((element) =>
    [...element.querySelectorAll("li")].map((line) => {
      const text = line.firstElementChild;
      const actions = line.lastElementChild;
      const name = text?.firstElementChild ?? null;
      const box = (node: Element | null) => (node === null ? null : node.getBoundingClientRect());
      const nameBox = box(name);
      return {
        name:
          name === null || nameBox === null
            ? null
            : {
                text: (name.textContent ?? "").trim(),
                title: name.getAttribute("title"),
                truncated: name.scrollWidth > name.clientWidth,
                height: nameBox.height,
              },
        textRight: box(text)?.right ?? 0,
        actionsLeft: box(actions)?.left ?? 0,
        actionsHeight: box(actions)?.height ?? 0,
      };
    }),
  );
}

/** 首页为普通纵向滚动页面：只断言不出现横向越界与卡片内滚动。 */
async function assertHomePageLayout(target: Locator, page: Page, label: string): Promise<void> {
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  if (geometry.scrollWidth > geometry.clientWidth + 1) {
    throw new Error(
      `${label} 首页出现横向越界（${geometry.scrollWidth} > ${geometry.clientWidth}）`,
    );
  }
  if (geometry.scrollHeight <= geometry.innerHeight) {
    throw new Error(
      `${label} 长清单没有让整页纵向滚动（${geometry.scrollHeight} ≤ ${geometry.innerHeight}）`,
    );
  }
  const inner = await target.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  if (inner.scrollHeight > inner.clientHeight + 1) {
    throw new Error(
      `${label} 卡片自身出现内嵌滚动（${inner.scrollHeight} > ${inner.clientHeight}）`,
    );
  }
}

test("创建、加入与身份恢复记入最近参与；清单状态读取不建立成员身份", async () => {
  const browser = await chromium.launch();
  try {
    const host = await newRoomContext(browser, "host", { width: 1440, height: 900 });
    const watch = watchNetwork(host.page);

    const roomUrl = await createRoomViaUi(host, "最近参与·建房赛", "主办小鱼");
    const roomId = /\/rooms\/([^/?#]+)/.exec(roomUrl)?.[1] ?? "";
    expect(roomId).not.toBe("");

    // ---- 创建成功：首页清单出现该房间（服务端确认的名称 + 未归档） ----
    await host.page.goto(`${E2E_BASE_URL}/`);
    // 首页阶段观测起点：此前的建房请求与房间页成员连接不计入清单判定。
    const requestsAtHome = watch.requests.length;
    const socketsAtHome = watch.sockets.length;
    const list = card(host.page);
    await expectVisible(list.getByText("最近参与·建房赛", { exact: true }));
    await expectVisible(list.getByText("未归档", { exact: true }));
    await expectCount(list.getByRole("listitem"), 1);
    await expectVisible(list.getByRole("button", { name: "刷新状态", exact: true }));
    await expectVisible(list.getByRole("button", { name: "清空历史", exact: true }));
    // 同房间多次参与仍是一条记录；持久内容只含 ID、房间名、时间与版本。
    const stored = await readStoredHistory(host.page);
    expect(Object.keys(stored)).toEqual([roomId]);
    expect(Object.keys(stored[roomId] as Record<string, unknown>).sort()).toEqual([
      "lastVisitedAt",
      "roomId",
      "roomName",
      "version",
    ]);
    expect((stored[roomId] as { roomName: string }).roomName).toBe("最近参与·建房赛");

    // ---- 手动刷新状态：复查已展示记录，不发成员 POST、不建立业务 WS ----
    const historyGets = (): number =>
      watch.requests.filter(
        (item) => item.method === "GET" && item.url.endsWith(`/api/rooms/${roomId}`),
      ).length;
    await waitFor(() => historyGets() >= 1, "首次展示没有查询房间状态");
    await list.getByRole("button", { name: "刷新状态", exact: true }).click();
    await waitFor(() => historyGets() >= 2, "手动刷新没有复查状态");
    const homeRequests = watch.requests.slice(requestsAtHome);
    const homeSockets = watch.sockets.slice(socketsAtHome);
    expect(homeRequests.some((item) => item.method === "POST")).toBe(false);
    expect(homeSockets.filter((url) => url.endsWith("/ws"))).toHaveLength(0);
    await expectVisible(list.getByText("未归档", { exact: true }));

    // ---- 进入房间：沿用 /rooms/:roomId，有效 Cookie 直接恢复身份 ----
    await list.getByRole("button", { name: "进入房间" }).first().click();
    await host.page.waitForURL(new RegExp(`/rooms/${roomId}$`));
    await host.page.getByRole("heading", { name: "最近参与·建房赛" }).waitFor();
    expect(await host.page.getByRole("heading", { name: "进入房间" }).count()).toBe(0);

    // ---- 仅打开链接停留在昵称表单：不记录 ----
    const guest = await newRoomContext(browser, "guest", { width: 1280, height: 640 });
    await guest.page.goto(roomUrl);
    await guest.page.getByRole("heading", { name: "进入房间" }).waitFor();
    await guest.page.goto(`${E2E_BASE_URL}/`);
    const guestList = card(guest.page);
    await expectVisible(guestList.getByText("还没有参与记录，创建或加入房间后会自动记录。"));
    expect(await guestList.getByRole("button", { name: "刷新状态", exact: true }).count()).toBe(0);

    // ---- 以昵称加入（服务端成功响应）：记录 ----
    await joinRoomViaUi(guest, roomUrl, "观众星河");
    await guest.page.goto(`${E2E_BASE_URL}/`);
    await expectVisible(guestList.getByText("最近参与·建房赛", { exact: true }));
    await expectVisible(guestList.getByText("未归档", { exact: true }));

    // ---- 身份恢复：带有效身份重新打开链接后仍更新为一条记录 ----
    await guest.page.goto(roomUrl);
    await guest.page.getByRole("heading", { name: "最近参与·建房赛" }).waitFor();
    await guest.page.goto(`${E2E_BASE_URL}/`);
    await expectCount(guestList.getByRole("listitem"), 1);

    assertNoPageErrors(host);
    assertNoPageErrors(guest);
  } finally {
    await browser.close();
  }
});

test("最近参与清单：四种状态、显示更多、清空确认、长名字与键盘可达", async () => {
  const browser = await chromium.launch();
  try {
    const host = await newRoomContext(browser, "host", { width: 1440, height: 900 });

    // 真实 live 房间（走真实 GET）与真实 404（随机 roomId 不注入）。
    const roomUrl = await createRoomViaUi(host, "最近参与·状态赛", "主办小鱼");
    const liveRoomId = /\/rooms\/([^/?#]+)/.exec(roomUrl)?.[1] ?? "";
    const missingRoomId = "11111111-1111-4111-8111-111111111111";
    const archivedRoomId = "22222222-2222-4222-8222-222222222222";
    const brokenRoomId = "33333333-3333-4333-8333-333333333333";
    const longNameRoomId = "44444444-4444-4444-8444-444444444444";
    const fillers = Array.from({ length: 8 }, (_, index) => ({
      roomId: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
      roomName: `赛事 ${index + 6}`,
    }));

    // 建房之后开始观测：清单阶段的成员 POST/WS 判定以此为基准。
    const watch = watchNetwork(host.page);
    const queryCount = (roomId: string): number =>
      watch.requests.filter(
        (item) => item.method === "GET" && item.url.includes(`/api/rooms/${roomId}`),
      ).length;

    const mockLive = (roomName: string) => async (route: import("playwright").Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ kind: "live", roomName, memberView: null }),
      });
    };
    const handlers = new Map<string, (route: import("playwright").Route) => Promise<void>>([
      [
        archivedRoomId,
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              kind: "archived",
              record: {
                roomId: archivedRoomId,
                roomName: "归档赛事",
                teamNames: { A: "甲队", B: "乙队" },
                bpCompleted: false,
                operations: [
                  {
                    slotId: "AB1",
                    team: "A",
                    action: "ban",
                    agentId: "9001",
                    agentName: "代理人甲",
                    agentAvatarUrl: null,
                  },
                ],
                versions: { ruleVersion: "rules-e2e", agentDataVersion: AGENT_DATA_VERSION },
                archivedAt: ARCHIVED_AT,
                expiresAt: EXPIRES_AT,
              },
            }),
          });
        },
      ],
      [
        brokenRoomId,
        async (route) => {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "INTERNAL", message: "内部错误" } }),
          });
        },
      ],
      [longNameRoomId, mockLive(LONG_ROOM_NAME)],
      ...fillers.map((filler) => [filler.roomId, mockLive(filler.roomName)] as const),
    ]);
    await host.context.route(/\/api\/rooms\/[^/]+$/, async (route) => {
      const handler = handlers.get(new URL(route.request().url()).pathname.split("/").pop() ?? "");
      if (handler === undefined) {
        await route.continue();
        return;
      }
      await handler(route);
    });

    // 预置 13 条记录：live（真实）→ 已归档 → 不存在 → 暂时无法确认 → 长名 → 8 条填充。
    const seeded: SeedEntry[] = [
      {
        roomId: liveRoomId,
        roomName: "最近参与·状态赛",
        lastVisitedAt: "2026-10-07T06:00:00.000Z",
      },
      { roomId: archivedRoomId, roomName: "归档赛事", lastVisitedAt: "2026-10-07T05:00:00.000Z" },
      { roomId: missingRoomId, roomName: "已清理赛事", lastVisitedAt: "2026-10-07T04:00:00.000Z" },
      { roomId: brokenRoomId, roomName: "故障赛事", lastVisitedAt: "2026-10-07T03:00:00.000Z" },
      {
        roomId: longNameRoomId,
        roomName: LONG_ROOM_NAME,
        lastVisitedAt: "2026-10-07T02:00:00.000Z",
      },
      ...fillers.map((filler, index) => ({
        roomId: filler.roomId,
        roomName: filler.roomName,
        lastVisitedAt: `2026-10-06T${String(10 - index).padStart(2, "0")}:00:00.000Z`,
      })),
    ];
    await seedHistory(host.page, seeded, {
      [UNRELATED_KEY]: "保留",
      // 个别记录损坏：只跳过该条，不影响其余记录与首页其他功能。
      [`${HISTORY_KEY_PREFIX}broken-record`]: "{ not json",
    });
    await host.page.goto(`${E2E_BASE_URL}/`);
    const list = card(host.page);

    // ---- 默认显示最近 10 条：只对已展示记录查询状态 ----
    await expectCount(list.getByRole("listitem"), 10);
    await expectHidden(list.getByText("赛事 13", { exact: true }));
    // 损坏记录已跳过：13 条合法记录之外没有多出条目，首页照常渲染。
    await expectCount(list.getByRole("listitem"), 10);
    await waitFor(() => queryCount(archivedRoomId) >= 1, "已展示记录没有查询状态");
    expect(queryCount(fillers[7]!.roomId)).toBe(0);
    // 真实房间的首次展示只读一次，不持续轮询。
    await waitFor(() => queryCount(liveRoomId) >= 1, "live 记录没有查询状态");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(queryCount(liveRoomId)).toBe(1);

    // ---- 四种状态与操作入口 ----
    const liveRow = row(list, "最近参与·状态赛");
    await expectVisible(liveRow.getByText("未归档", { exact: true }));
    await expectVisible(liveRow.getByRole("button", { name: "进入房间" }));
    expect(await liveRow.getByRole("button", { name: "查看记录" }).count()).toBe(0);

    const archivedRow = row(list, "归档赛事");
    await expectVisible(archivedRow.getByText("已归档", { exact: true }));
    await expectVisible(archivedRow.getByText(`记录保留至 ${localDate(EXPIRES_AT)}`));
    await expectVisible(archivedRow.getByRole("button", { name: "查看记录" }));
    expect(await archivedRow.getByRole("button", { name: "进入房间" }).count()).toBe(0);

    const missingRow = row(list, "已清理赛事");
    await expectVisible(missingRow.getByText("不存在或已过期", { exact: true }));
    expect(await missingRow.getByRole("button", { name: /进入房间|查看记录/ }).count()).toBe(0);
    await expectVisible(missingRow.getByRole("button", { name: "移除" }));

    const brokenRow = row(list, "故障赛事");
    await expectVisible(brokenRow.getByText("暂时无法确认", { exact: true }));
    await expectVisible(brokenRow.getByRole("button", { name: "进入房间" }));

    // ---- 显示更多：每次展开 10 条，新展开的条目也查询 ----
    await list.getByRole("button", { name: "显示更多", exact: true }).click();
    await expectCount(list.getByRole("listitem"), 13);
    await expectHidden(list.getByRole("button", { name: "显示更多", exact: true }));
    await expectVisible(list.getByText("赛事 13", { exact: true }));
    await waitFor(() => queryCount(fillers[7]!.roomId) >= 1, "新展开的记录没有查询状态");

    // ---- 长房间名截断但有完整名称与悬停提示；行内操作不与文本列重叠 ----
    const geometry = await readRowGeometry(list);
    expect(geometry).toHaveLength(13);
    for (const line of geometry) {
      if (line.textRight > line.actionsLeft + 1) {
        throw new Error(`行内操作按钮与文本列重叠（${line.textRight} > ${line.actionsLeft}）`);
      }
      if (line.actionsHeight > 40) {
        throw new Error(`行内操作按钮换行（高度 ${line.actionsHeight}px）`);
      }
      expect(line.name).not.toBeNull();
    }
    const longName = geometry.find((line) => line.name?.text === LONG_ROOM_NAME)?.name ?? null;
    expect(longName).not.toBeNull();
    expect(longName?.title).toBe(LONG_ROOM_NAME);
    expect(longName?.truncated).toBe(true);
    expect(longName?.height ?? 0).toBeLessThanOrEqual(24);
    // 两卡同宽：历史卡片与创建表单宽度一致。
    const widths = await host.page.evaluate(() => ({
      card:
        document
          .querySelector("section[aria-labelledby='recent-rooms-title']")
          ?.getBoundingClientRect().width ?? 0,
      form: document.querySelector("form")?.getBoundingClientRect().width ?? 0,
    }));
    expect(Math.abs(widths.card - widths.form)).toBeLessThanOrEqual(1);

    // ---- 键盘可达：Tab 依次到达卡片操作，Enter 可激活 ----
    const reachable: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      await host.page.keyboard.press("Tab");
      const focused = await host.page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return null;
        return {
          text: (active.textContent ?? "").trim(),
          focusRing: active.classList.contains("focus-ring"),
          insideCard: active.closest("section[aria-labelledby='recent-rooms-title']") !== null,
        };
      });
      if (focused === null || !focused.insideCard) continue;
      if (focused.text !== "") reachable.push(focused.text);
      if (!focused.focusRing) throw new Error(`卡片内的控件缺少焦点样式：${focused.text}`);
    }
    for (const expected of ["刷新状态", "清空历史", "进入房间", "查看记录", "移除"]) {
      if (!reachable.some((text) => text.startsWith(expected))) {
        throw new Error(`键盘无法到达「${expected}」（实际：${reachable.join(" / ")}）`);
      }
    }
    // Enter 激活：移除「已清理赛事」这一条（该行本轮只保留移除操作）。
    await missingRow.getByRole("button", { name: "移除" }).focus();
    await host.page.keyboard.press("Enter");
    await expectCount(list.getByRole("listitem"), 12);
    expect(await list.getByText("已清理赛事", { exact: true }).count()).toBe(0);

    // ---- 刷新状态复查当前已展示记录 ----
    const before = queryCount(archivedRoomId);
    await list.getByRole("button", { name: "刷新状态", exact: true }).click();
    await waitFor(() => queryCount(archivedRoomId) > before, "刷新状态没有复查已展示记录");
    await expectVisible(row(list, "归档赛事").getByText("已归档", { exact: true }));

    // ---- 多标签页同步：另一个标签页的移除反映到本页，且不覆盖其他房间 ----
    const secondTab = await newSameIdentityPage(host, "host-second");
    await secondTab.goto(`${E2E_BASE_URL}/`);
    const secondList = card(secondTab);
    await expectCount(secondList.getByRole("listitem"), 10);
    await secondList.getByRole("button", { name: "显示更多", exact: true }).click();
    await expectCount(secondList.getByRole("listitem"), 12);
    await secondList
      .getByRole("listitem")
      .filter({ hasText: "赛事 13" })
      .getByRole("button", { name: "移除" })
      .click();
    await expectCount(secondList.getByRole("listitem"), 11);
    // 本页经 storage 事件重新读取：只丢掉被移除的那一条，其余记录保持。
    await expectCount(list.getByRole("listitem"), 11);
    await expectVisible(row(list, "归档赛事").getByText("已归档", { exact: true }));
    await secondTab.close();

    // ---- 布局：整页纵向滚动、无横向越界、卡片内不滚动 ----
    await assertHomePageLayout(list, host.page, "1440x900 长清单");

    // ---- 按钮层级：创建是强调主按钮，行内操作为次级按钮与文字操作 ----
    const layers = await host.page.evaluate(() => {
      const styleOf = (element: Element | null) => {
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, borderWidth: style.borderTopWidth };
      };
      const buttons = [
        ...document.querySelectorAll("section[aria-labelledby='recent-rooms-title'] li button"),
      ];
      return {
        create: styleOf(document.querySelector("form button[type='submit']")),
        enter: styleOf(
          buttons.find((button) => (button.textContent ?? "").trim().startsWith("进入房间")) ??
            null,
        ),
        remove: styleOf(
          buttons.find((button) => (button.textContent ?? "").trim().startsWith("移除")) ?? null,
        ),
      };
    });
    const transparent = "rgba(0, 0, 0, 0)";
    expect(layers.create?.background).not.toBe(transparent);
    expect(layers.enter?.borderWidth).toBe("1px");
    expect(layers.enter?.background).toBe(transparent);
    expect(layers.remove?.borderWidth).toBe("0px");
    expect(layers.remove?.background).toBe(transparent);

    // ---- 最小支持宽度 1024×768：仍不横向越界、两卡同宽、行内不重叠 ----
    await host.page.setViewportSize({ width: 1024, height: 768 });
    for (const line of await readRowGeometry(list)) {
      if (line.textRight > line.actionsLeft + 1) {
        throw new Error(
          `1024×768 行内操作按钮与文本列重叠（${line.textRight} > ${line.actionsLeft}）`,
        );
      }
    }
    const smallWidths = await host.page.evaluate(() => ({
      card:
        document
          .querySelector("section[aria-labelledby='recent-rooms-title']")
          ?.getBoundingClientRect().width ?? 0,
      form: document.querySelector("form")?.getBoundingClientRect().width ?? 0,
    }));
    expect(Math.abs(smallWidths.card - smallWidths.form)).toBeLessThanOrEqual(1);
    await assertHomePageLayout(list, host.page, "1024x768 长清单");
    await host.page.setViewportSize({ width: 1440, height: 900 });

    // ---- 清空历史：二次确认 + 只删除本功能数据 ----
    await list.getByRole("button", { name: "清空历史", exact: true }).click();
    await expectVisible(list.getByText("清空只删除本浏览器记住的这份列表", { exact: false }));
    await list.getByRole("button", { name: "取消", exact: true }).click();
    await expectCount(list.getByRole("listitem"), 11);
    await list.getByRole("button", { name: "清空历史", exact: true }).click();
    await list.getByRole("button", { name: "确认清空", exact: true }).click();
    await expectVisible(list.getByText("还没有参与记录，创建或加入房间后会自动记录。"));
    expect(await readStoredHistory(host.page)).toEqual({});
    const unrelated = await host.page.evaluate(() =>
      window.localStorage.getItem("other-app:preference"),
    );
    expect(unrelated).toBe("保留");
    expect(await list.getByRole("button", { name: "刷新状态", exact: true }).count()).toBe(0);
    expect(await list.getByRole("button", { name: "清空历史", exact: true }).count()).toBe(0);
    expect(await list.getByRole("button", { name: "显示更多", exact: true }).count()).toBe(0);

    // 全程零成员 POST 与零业务 WS：清单不建立成员身份或实时连接。
    expect(
      watch.requests.some((item) => item.method === "POST" && item.url.includes("/api/rooms/")),
    ).toBe(false);
    expect(watch.sockets.filter((url) => url.endsWith("/ws"))).toHaveLength(0);
    assertNoPageErrors(host);
  } finally {
    await browser.close();
  }
});

test("本机存储写入被拒时提示未保存，且不阻断创建与进入", async () => {
  const browser = await chromium.launch();
  try {
    const host = await newRoomContext(browser, "host", { width: 1440, height: 900 });
    // 模拟本机 localStorage 配额不足/隐私模式：写入一律被拒
    // （QuotaExceededError），会话存储仍可用（真实存储区各自独立配额）。
    await host.page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key: string, value: string) {
        if (this === window.localStorage) {
          const error = new Error("quota exceeded") as Error & { name: string };
          error.name = "QuotaExceededError";
          throw error;
        }
        return original.call(this, key, value);
      };
    });

    await host.page.goto(`${E2E_BASE_URL}/`);
    const list = card(host.page);
    await expectVisible(list.getByText("还没有参与记录，创建或加入房间后会自动记录。"));

    // 创建成功照常进入房间；写入失败只影响本机清单。
    const roomUrl = await createRoomViaUi(host, "最近参与·配额赛", "主办小鱼");
    expect(roomUrl).toContain("/rooms/");
    await host.page.getByRole("heading", { name: "最近参与·配额赛" }).waitFor();

    // 回到首页：明确提示未保存，不承诺已持久保存，也不虚构记录。
    await host.page.goto(`${E2E_BASE_URL}/`);
    await expectVisible(list.getByText("上次的参与记录未能保存到本机", { exact: false }));
    await expectVisible(list.getByText("还没有参与记录，创建或加入房间后会自动记录。"));
    expect(await readStoredHistory(host.page)).toEqual({});
    assertNoPageErrors(host);
  } finally {
    await browser.close();
  }
});
