import { expect, test } from "vitest";
import { chromium } from "playwright";
import type { Page, WebSocketRoute } from "playwright";
import {
  AGENTS,
  assertHeaderPrioritizesCenter,
  assertNoOverflow,
  assertNoPageErrors,
  assertNoSlotNumbers,
  assertPickColumnsMatchPool,
  assertRoundBreaks,
  assertTeamNameBesideBans,
  assignSeatViaUi,
  closePanel,
  confirmButton,
  createRoomViaUi,
  expectDisabled,
  expectHidden,
  expectVisible,
  joinRoomViaUi,
  newRoomContext,
  openPanel,
  panel,
  preselectText,
  saveTeamName,
  submitStep,
  waitForStatus,
} from "./helpers";
import type { RoomContext } from "./helpers";

/**
 * 实时房间 UI 细节端到端验收：本人身份提示、两轮分隔、移除槽位数字、
 * 控制面板的关闭语义，以及控制面板的固定底栏与成员列表滚动。
 *
 * 身份提示只依赖成员视图的 self 字段（昵称、是否房主、当前席位），因此
 * 覆盖房主、房主兼任选手、选手、观众与换人后的更新；面板关闭覆盖入口
 * 再点、外部首次点击（只收起面板、不触发底层预选）、Esc、关闭按钮与
 * 子视图，并断言焦点回到入口；分隔线与数字角标按槽位几何与可见文本
 * 判定（展示页/记录页的对应断言在 display-record.spec.ts，三页共用同一
 * 判定）。面板结构按几何与可见文本判定：「显示与分享」固定在面板底部、
 * 中间内容滚动不带动它，其他成员列表滚动时标题、列头与底部人数栏不动。
 * 视口取最小支持宽度 1024×768，检查身份提示不遮挡中央确认按钮
 * 与右侧面板入口。
 */

/** 长昵称（共享 schema 上限 24 码点内的代表值）。 */
const LONG_NICKNAME = "超长昵称选手乙一二三四五六七八九十";

/** 身份提示元素：底部操作栏左侧的常驻文本（昵称 + 身份）。 */
function identityText(page: Page, text: string) {
  return page.getByText(text, { exact: true });
}

/**
 * 底部操作栏互不遮挡：身份提示止步于中央确认按钮与右侧面板入口之前。
 * 返回量测结果供断言，避免在页面内直接判定测试语义。
 */
async function identityClearance(page: Page): Promise<{
  readonly entryOverlaps: boolean;
  readonly confirmOverlaps: boolean;
  readonly truncated: boolean;
}> {
  return page.evaluate(() => {
    const identity = document.querySelector("p[aria-live='polite']");
    const entry = document.querySelector("[data-panel-entry]");
    if (!(identity instanceof HTMLElement) || !(entry instanceof HTMLElement)) {
      throw new Error("未找到身份提示或控制面板入口");
    }
    const identityBox = identity.getBoundingClientRect();
    const entryBox = entry.getBoundingClientRect();
    const confirm = [...document.querySelectorAll("button")].find((button) =>
      /确认禁用|确认选用/.test(button.textContent ?? ""),
    );
    const confirmBox = confirm?.getBoundingClientRect() ?? null;
    return {
      entryOverlaps: identityBox.right > entryBox.left,
      confirmOverlaps: confirmBox === null ? false : identityBox.right > confirmBox.left,
      truncated: identity.scrollWidth > identity.clientWidth,
    };
  });
}

test("实时房间：身份提示（房主/兼任/选手/观众/换人）与最小宽度下互不遮挡", async () => {
  const browser = await chromium.launch();
  try {
    const host = await newRoomContext(browser, "host", { width: 1024, height: 768 });
    const playerA = await newRoomContext(browser, "playerA", { width: 1024, height: 768 });
    const spectator = await newRoomContext(browser, "spectator", { width: 1024, height: 768 });
    const roomUrl = await createRoomViaUi(host, "首版验收·细节赛", "主办小鱼");
    await joinRoomViaUi(playerA, roomUrl, LONG_NICKNAME);
    await joinRoomViaUi(spectator, roomUrl, "观众星河");

    // ---- 入房即为成员视角：三种身份在同一房间并存 ----
    await expectVisible(identityText(host.page, "主办小鱼 · 房主"));
    await expectVisible(identityText(playerA.page, `${LONG_NICKNAME} · 观众`));
    await expectVisible(identityText(spectator.page, "观众星河 · 观众"));
    // 长昵称不撑开工作区（最小宽度与常规宽度下都不出现整页越界）。
    await assertNoOverflow(host.page, "房主 1024x768 待开始");
    await assertNoOverflow(playerA.page, "长昵称观众 1024x768 待开始");

    // ---- 分席后：选手身份与房主兼任选手 ----
    await openPanel(host.page);
    await saveTeamName(host.page, "A", "甲队");
    await saveTeamName(host.page, "B", "乙队");
    await assignSeatViaUi(host.page, "A", LONG_NICKNAME);
    // 未占席的房主本人可以把自己安排到另一方（房主兼任选手）。
    await assignSeatViaUi(host.page, "B", "主办小鱼");
    await closePanel(host.page);

    await expectVisible(identityText(playerA.page, `${LONG_NICKNAME} · 左方选手`));
    await expectVisible(identityText(host.page, "主办小鱼 · 房主 · 右方选手"));
    // 观众不受分席影响。
    await expectVisible(identityText(spectator.page, "观众星河 · 观众"));

    // ---- 换人：暂停后把「右方」换成观众，双方身份随最新视图更新 ----
    await openPanel(host.page);
    await host.page.getByRole("button", { name: "开始 BP", exact: true }).click();
    await closePanel(host.page);
    for (const ctx of [host, playerA, spectator]) await waitForStatus(ctx.page, "进行中");
    await openPanel(host.page);
    await host.page.getByRole("button", { name: "暂停 BP", exact: true }).click();
    await waitForStatus(host.page, "已暂停");
    await assignSeatViaUi(host.page, "B", "观众星河");
    await closePanel(host.page);

    // 原房主被换下仍是房主（不显示为观众），新选手获得右方身份。
    await expectVisible(identityText(host.page, "主办小鱼 · 房主"));
    await expectVisible(identityText(spectator.page, "观众星河 · 右方选手"));

    // ---- 身份提示不遮挡确认按钮与面板入口：选手页长昵称（截断）为最严苛组合 ----
    for (const ctx of [host, playerA, spectator]) {
      await expectVisible(identityText(ctx.page, identityOf(ctx)));
      const clearance = await identityClearance(ctx.page);
      if (clearance.entryOverlaps) throw new Error(`${ctx.label} 身份提示遮挡控制面板入口`);
      if (clearance.confirmOverlaps) throw new Error(`${ctx.label} 身份提示遮挡中央确认按钮`);
    }
    // 长昵称超出可用宽度时按截断处理（title 保留完整文案）。
    const clearance = await identityClearance(playerA.page);
    expect(clearance.truncated).toBe(true);
    expect(await playerA.page.locator("p[aria-live='polite']").getAttribute("title")).toBe(
      `${LONG_NICKNAME} · 左方选手`,
    );

    assertNoPageErrors(host);
    assertNoPageErrors(playerA);
    assertNoPageErrors(spectator);
  } finally {
    await browser.close();
  }
}, 240_000);

/** 各上下文的最终身份文案（换人后）。 */
function identityOf(ctx: { readonly label: string }): string {
  switch (ctx.label) {
    case "host":
      return "主办小鱼 · 房主";
    case "playerA":
      return `${LONG_NICKNAME} · 左方选手`;
    default:
      return "观众星河 · 右方选手";
  }
}

test("实时房间：控制面板入口再点、外部首次点击、Esc 与关闭按钮的关闭语义", async () => {
  const browser = await chromium.launch();
  try {
    const host = await newRoomContext(browser, "host", { width: 1440, height: 900 });
    const playerA = await newRoomContext(browser, "playerA", { width: 1024, height: 768 });
    const roomUrl = await createRoomViaUi(host, "首版验收·面板赛", "主办小鱼");
    await joinRoomViaUi(playerA, roomUrl, "选手甲");
    await openPanel(host.page);
    await saveTeamName(host.page, "A", "甲队");
    await saveTeamName(host.page, "B", "乙队");
    await assignSeatViaUi(host.page, "A", "选手甲");
    // 另一方由房主本人兼任，满足开局席位条件。
    await assignSeatViaUi(host.page, "B", "主办小鱼");
    await host.page.getByRole("button", { name: "开始 BP", exact: true }).click();
    await closePanel(host.page);
    await waitForStatus(playerA.page, "进行中");

    const entry = playerA.page.getByRole("button", { name: "控制面板", exact: true });

    // ---- 入口再点即收起（开关语义完全由入口处理，不被外部监听先关后开） ----
    await openPanel(playerA.page);
    await entry.click();
    await expectHidden(panel(playerA.page));

    // ---- 外部首次点击：只收起面板，不同时触发底层预选 ----
    await openPanel(playerA.page);
    const panelBox = await panel(playerA.page).boundingBox();
    if (panelBox === null) throw new Error("未找到控制面板");
    // 点击面板左侧未被覆盖的代理人卡片：先取卡片中心点，再按真实指针位置点击。
    const targetPoint = await playerA.page.evaluate((panelLeft: number) => {
      const cards = [...document.querySelectorAll("[aria-label='代理人池'] ul li button")];
      const card = cards.find((candidate) => {
        const box = candidate.getBoundingClientRect();
        return box.width > 0 && box.right < panelLeft - 8;
      });
      if (card === undefined) throw new Error("未找到面板之外的代理人卡片");
      const box = card.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, panelBox.x);
    await playerA.page.mouse.click(targetPoint.x, targetPoint.y);
    await expectHidden(panel(playerA.page));
    // 同一次外部点击没有选中代理人：确认按钮仍不可用、无公开预选。
    await expectDisabled(confirmButton(playerA.page));
    expect(await preselectText(playerA.page, AGENTS[0]?.name ?? "").count()).toBe(0);

    // ---- 拦截不依赖时长与位移：长按（850ms）与同一次按下内移动 8px 都只收起面板 ----
    for (const [label, holdMs, movePx] of [
      ["长按 850ms", 850, 0],
      ["同按钮内移动 8px", 0, 8],
    ] as const) {
      await openPanel(playerA.page);
      const box = await panel(playerA.page).boundingBox();
      if (box === null) throw new Error("未找到控制面板");
      const point = await playerA.page.evaluate((panelLeft: number) => {
        const cards = [...document.querySelectorAll("[aria-label='代理人池'] ul li button")];
        const card = cards.find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.width > 24 && rect.right < panelLeft - 8;
        });
        if (card === undefined) throw new Error("未找到面板之外的代理人卡片");
        const rect = card.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, box.x);
      await playerA.page.mouse.move(point.x, point.y);
      await playerA.page.mouse.down();
      if (holdMs > 0) await playerA.page.waitForTimeout(holdMs);
      if (movePx > 0) await playerA.page.mouse.move(point.x + movePx, point.y, { steps: 2 });
      await playerA.page.mouse.up();
      await expectHidden(panel(playerA.page));
      await expectDisabled(confirmButton(playerA.page));
      expect(
        await preselectText(playerA.page, AGENTS[0]?.name ?? "").count(),
        `${label} 仍触发了底层预选`,
      ).toBe(0);
    }

    // ---- Esc：面板关闭且焦点回到入口 ----
    await openPanel(playerA.page);
    await playerA.page.keyboard.press("Escape");
    await expectHidden(panel(playerA.page));
    expect(await entry.evaluate((element) => element === document.activeElement)).toBe(true);

    // ---- 关闭按钮：面板关闭且焦点回到入口 ----
    await openPanel(playerA.page);
    await playerA.page.getByRole("button", { name: "关闭控制面板", exact: true }).click();
    await expectHidden(panel(playerA.page));
    expect(await entry.evaluate((element) => element === document.activeElement)).toBe(true);

    // ---- 子视图沿用整个面板的关闭语义：外部点击收起后不残留子视图 ----
    await openPanel(host.page);
    await panel(host.page)
      .getByRole("button", { name: /其他成员/ })
      .click();
    await expectVisible(panel(host.page).getByText("昵称", { exact: true }));
    await host.page.mouse.click(8, 8);
    await expectHidden(panel(host.page));
    await openPanel(host.page);
    await expectVisible(panel(host.page).getByText("显示与分享", { exact: true }));
    expect(await panel(host.page).getByText("昵称", { exact: true }).count()).toBe(0);
    await closePanel(host.page);

    assertNoPageErrors(host);
    assertNoPageErrors(playerA);
  } finally {
    await browser.close();
  }
}, 240_000);

test("实时房间：两轮分隔、槽位数字移除与队名/同高/背景一致性", async () => {
  const browser = await chromium.launch();
  try {
    const host = await newRoomContext(browser, "host", { width: 1440, height: 900 });
    const playerB = await newRoomContext(browser, "playerB", { width: 1024, height: 768 });
    const roomUrl = await createRoomViaUi(host, "首版验收·分隔赛", "主办小鱼");
    await joinRoomViaUi(playerB, roomUrl, "选手乙");

    // 待开始：空席队名在顶部禁用区旁显示「待设置」，选用区与中央池同高。
    await assertTeamNameBesideBans(host.page, "实时房间 待开始", { A: "待设置", B: "待设置" });
    await assertPickColumnsMatchPool(host.page, "实时房间 待开始");

    await openPanel(host.page);
    await saveTeamName(host.page, "A", "甲队");
    await saveTeamName(host.page, "B", "乙队");
    await assignSeatViaUi(host.page, "A", "主办小鱼");
    await assignSeatViaUi(host.page, "B", "选手乙");
    await host.page.getByRole("button", { name: "开始 BP", exact: true }).click();
    await closePanel(host.page);
    await waitForStatus(playerB.page, "进行中");

    // 前两步禁用（AB1、BB1）后槽位已有内容，便于同时验证可见文本。
    const names = new Set(AGENTS.slice(0, 26).map((entry) => entry.name));
    await submitStep(host.page, "AB1", AGENTS[0]?.name ?? "");
    await submitStep(playerB.page, "BB1", AGENTS[1]?.name ?? "");

    // 四个禁用位按 2 | 2、九个选用位按 6 / 3 分隔（固定九格竖排）。
    await assertRoundBreaks(host.page, "实时房间 竖排");
    await assertNoSlotNumbers(host.page, "实时房间 竖排", names);
    await assertRoundBreaks(playerB.page, "实时房间 1024x768");
    await assertNoSlotNumbers(playerB.page, "实时房间 1024x768", names);
    await assertNoOverflow(playerB.page, "实时房间 1024x768");

    // 分席后队名仍在顶部禁用区旁（长队名截断不改变位置关系）。
    await assertTeamNameBesideBans(host.page, "实时房间 进行中", { A: "甲队", B: "乙队" });
    await assertTeamNameBesideBans(playerB.page, "实时房间 1024x768", { A: "甲队", B: "乙队" });
    // 选用区与中央代理人池上下对齐（队名已不在选用区内）。
    await assertPickColumnsMatchPool(host.page, "实时房间 1440x900");
    await assertPickColumnsMatchPool(playerB.page, "实时房间 1024x768");

    // 1920px 以上：工作区限宽居中，顶部条带与两侧页面背景同色（无色差）。
    // 用现有成员页改视口，避免为匿名上下文再走一次入房。
    await host.page.setViewportSize({ width: 2560, height: 1440 });
    await host.page.getByText("进行中", { exact: true }).first().waitFor();
    const wideColors = await host.page.evaluate(() => {
      const header = document.querySelector("header");
      const workspace = document.querySelector(".room-workspace");
      if (!(header instanceof HTMLElement) || !(workspace instanceof HTMLElement)) {
        throw new Error("未找到顶部区域或工作区");
      }
      const workspaceBox = workspace.getBoundingClientRect();
      return {
        headerBg: getComputedStyle(header).backgroundColor,
        pageBg: getComputedStyle(document.body).backgroundColor,
        workspaceLeft: workspaceBox.left,
        viewportWidth: window.innerWidth,
      };
    });
    expect(wideColors.workspaceLeft).toBeGreaterThan(0);
    expect(wideColors.workspaceLeft * 2 + 1920).toBe(wideColors.viewportWidth);
    if (wideColors.headerBg !== wideColors.pageBg) {
      throw new Error(`顶部背景与全局背景不同色（${wideColors.headerBg} vs ${wideColors.pageBg}）`);
    }
    await assertNoOverflow(host.page, "实时房间 2560x1440");

    assertNoPageErrors(host);
    assertNoPageErrors(playerB);
  } finally {
    await browser.close();
  }
}, 240_000);

test("长队名 + 窄窗口：中央赛事信息不被挤压（1024×1080 连接中断态）", async () => {
  const browser = await chromium.launch();
  const teamNameA = "甲".repeat(32);
  const teamNameB = "乙".repeat(32);
  try {
    const host = await newRoomContext(browser, "host", { width: 1024, height: 1080 });
    const player = await newRoomContext(browser, "player", { width: 1024, height: 768 });
    // 成员通道代理：用于稳定观察「连接中断」提示（与 resilience 同一手法）。
    let failConnections = false;
    const sockets: WebSocketRoute[] = [];
    await host.page.routeWebSocket(/\/api\/rooms\/[^/]+\/ws$/, (client) => {
      if (failConnections) {
        void client.close();
        return;
      }
      sockets.push(client.connectToServer());
    });

    const roomUrl = await createRoomViaUi(host, "首版验收·顶部空间", "主办小鱼");
    await joinRoomViaUi(player, roomUrl, "选手甲");
    await openPanel(host.page);
    await saveTeamName(host.page, "A", teamNameA);
    await saveTeamName(host.page, "B", teamNameB);
    await assignSeatViaUi(host.page, "A", "选手甲");
    await assignSeatViaUi(host.page, "B", "主办小鱼");
    await closePanel(host.page);

    // 制造连接中断：拒绝重连，稳定显示连接提示（1024×1080 高窗口禁用格更大）。
    failConnections = true;
    for (const socket of sockets) socket.close();
    await host.page.getByText("连接中断", { exact: true }).waitFor({ state: "visible" });
    await assertHeaderPrioritizesCenter(host.page, "1024×1080 长队名");
    await assertNoOverflow(host.page, "1024×1080 长队名");
    // 最小高度组合同样成立。
    await host.page.setViewportSize({ width: 1024, height: 768 });
    await host.page.getByText("连接中断", { exact: true }).waitFor({ state: "visible" });
    await assertHeaderPrioritizesCenter(host.page, "1024×768 长队名");
    await assertNoOverflow(host.page, "1024×768 长队名");

    assertNoPageErrors(host);
    assertNoPageErrors(player);
  } finally {
    await browser.close();
  }
}, 240_000);

/**
 * 主面板固定底栏探针：底部动作完整落在面板与视口内、中心点命中自身
 * （未被其他元素遮挡），面板本体不滚动；同时把中间内容区滚到底，检查
 * 底部动作与面板位置不随内容滚动移动。
 */
async function panelFooterProbe(page: Page): Promise<{
  readonly openUsable: boolean;
  readonly copyUsable: boolean;
  readonly panelScrolls: boolean;
  readonly regionScrollable: boolean;
  readonly scrolledTo: number;
  readonly footerFixed: boolean;
}> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="控制面板"]');
    if (!(dialog instanceof HTMLElement)) throw new Error("未找到控制面板");
    const panelBox = dialog.getBoundingClientRect();
    const usable = (name: string) => {
      const element = [...dialog.querySelectorAll("a, button")].find(
        (candidate) => (candidate.textContent ?? "").trim() === name,
      );
      if (!(element instanceof HTMLElement)) throw new Error(`未找到「${name}」`);
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      return (
        box.top >= panelBox.top - 0.5 &&
        box.bottom <= panelBox.bottom + 0.5 &&
        box.top >= 0 &&
        box.bottom <= window.innerHeight &&
        (hit === element || element.contains(hit))
      );
    };
    // 中间内容区：比赛控制所在的最近一层纵向滚动容器。
    const region = (() => {
      const section = dialog.querySelector('section[aria-label="比赛控制"]');
      let node: Element | null = section?.parentElement ?? null;
      while (node !== null && node !== dialog) {
        if (getComputedStyle(node).overflowY === "auto") return node;
        node = node.parentElement;
      }
      return null;
    })();
    if (!(region instanceof HTMLElement)) throw new Error("未找到主面板中间内容区");
    const footer = dialog.querySelector('section[aria-label="显示与分享"]');
    if (!(footer instanceof HTMLElement)) throw new Error("未找到显示与分享");
    const footerTopBefore = footer.getBoundingClientRect().top;
    const panelTopBefore = panelBox.top;
    region.scrollTop = 100_000;
    const scrolledTo = region.scrollTop;
    const footerFixed =
      Math.abs(footer.getBoundingClientRect().top - footerTopBefore) <= 0.5 &&
      Math.abs(dialog.getBoundingClientRect().top - panelTopBefore) <= 0.5;
    region.scrollTop = 0;
    return {
      openUsable: usable("打开展示页"),
      copyUsable: usable("复制房间链接"),
      panelScrolls: dialog.scrollHeight > dialog.clientHeight + 1,
      regionScrollable: region.scrollHeight > region.clientHeight + 1,
      scrolledTo,
      footerFixed,
    };
  });
}

/**
 * 其他成员列表探针：标题、列头与人数栏在名单滚动前后位置不变，人数与
 * 名单行数一致，人数栏位于名单下方且以上方横线分隔。
 */
async function membersListProbe(page: Page): Promise<{
  readonly countText: string;
  readonly rows: number;
  readonly scrollable: boolean;
  readonly scrolledTo: number;
  readonly fixedChrome: boolean;
  readonly separator: string;
  readonly countBelowList: boolean;
}> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="控制面板"]');
    if (!(dialog instanceof HTMLElement)) throw new Error("未找到控制面板");
    const find = (selector: string, text: string) =>
      [...dialog.querySelectorAll(selector)].find(
        (node) => (node.textContent ?? "").trim() === text,
      );
    const heading = find("h2", "其他成员");
    const countBar = [...dialog.querySelectorAll("p")].find((node) =>
      /^共 \d+ 人$/.test((node.textContent ?? "").trim()),
    );
    const columnHeader = find("span", "昵称")?.parentElement ?? null;
    const list = dialog.querySelector("ul");
    const scroller = list?.parentElement ?? null;
    if (
      !(heading instanceof HTMLElement) ||
      !(countBar instanceof HTMLElement) ||
      !(columnHeader instanceof HTMLElement) ||
      !(list instanceof HTMLElement) ||
      !(scroller instanceof HTMLElement)
    ) {
      throw new Error("未找到其他成员视图的标题、列头、名单或人数栏");
    }
    const topOf = (element: HTMLElement) => element.getBoundingClientRect().top;
    const before = [topOf(heading), topOf(columnHeader), topOf(countBar)];
    scroller.scrollTop = 100_000;
    const scrolledTo = scroller.scrollTop;
    const after = [topOf(heading), topOf(columnHeader), topOf(countBar)];
    const countBelowList =
      countBar.getBoundingClientRect().top >= scroller.getBoundingClientRect().bottom - 0.5;
    scroller.scrollTop = 0;
    return {
      countText: (countBar.textContent ?? "").trim(),
      rows: list.querySelectorAll("li").length,
      scrollable: scroller.scrollHeight > scroller.clientHeight + 1,
      scrolledTo,
      fixedChrome: before.every((value, index) => Math.abs(value - (after[index] ?? 0)) <= 0.5),
      separator: getComputedStyle(countBar).borderTopWidth,
      countBelowList,
    };
  });
}

/** 同一浏览器上下文换一个昵称重新入房：铺满成员列表用，避免开大量上下文。 */
async function joinSpectator(ctx: RoomContext, roomUrl: string, nickname: string): Promise<void> {
  await ctx.context.clearCookies();
  await ctx.page.goto(roomUrl);
  await ctx.page.getByRole("heading", { name: "进入房间" }).waitFor();
  await ctx.page.fill("#join-nickname", nickname);
  await ctx.page.getByRole("button", { name: "进入房间", exact: true }).click();
  await ctx.page.getByText(`${nickname} · 观众`, { exact: true }).waitFor();
}

/** 打开/退出「其他成员」子视图。 */
async function openMembers(page: Page): Promise<void> {
  await panel(page)
    .getByRole("button", { name: /其他成员/ })
    .click();
  await expectVisible(panel(page).getByText("昵称", { exact: true }));
}

async function backToMain(page: Page): Promise<void> {
  await panel(page).getByRole("button", { name: "返回", exact: true }).click();
  await expectVisible(panel(page).getByText("显示与分享", { exact: true }));
}

test("实时房间：控制面板底部动作固定与成员列表滚动（零/一/多成员）", async () => {
  const browser = await chromium.launch();
  try {
    const host = await newRoomContext(browser, "host", { width: 1024, height: 768 });
    const playerA = await newRoomContext(browser, "playerA", { width: 1024, height: 768 });
    const guest = await newRoomContext(browser, "guest", { width: 1024, height: 768 });
    const roomUrl = await createRoomViaUi(host, "首版验收·面板布局", "主办小鱼");
    await joinRoomViaUi(playerA, roomUrl, "选手甲");

    // 零人：两名成员都在席，双方选手以外没有其他成员。
    await openPanel(host.page);
    await assignSeatViaUi(host.page, "A", "选手甲");
    await assignSeatViaUi(host.page, "B", "主办小鱼");

    // ---- 1024×768（最小支持尺寸）：底部动作完整可见、可点击，内容区独立滚动 ----
    const tight = await panelFooterProbe(host.page);
    expect(tight.openUsable).toBe(true);
    expect(tight.copyUsable).toBe(true);
    expect(tight.panelScrolls).toBe(false);
    expect(tight.regionScrollable).toBe(true);
    expect(tight.scrolledTo).toBeGreaterThan(0);
    expect(tight.footerFixed).toBe(true);
    // 复制链接在最小尺寸下仍可操作（真实点击后按钮给出已复制反馈）。
    await panel(host.page).getByRole("button", { name: "复制房间链接", exact: true }).click();
    await expectVisible(panel(host.page).getByRole("button", { name: "已复制", exact: true }));

    await openMembers(host.page);
    const zero = await membersListProbe(host.page);
    expect(zero.countText).toBe("共 0 人");
    expect(zero.rows).toBe(0);
    expect(zero.separator).toBe("1px");
    expect(zero.countBelowList).toBe(true);
    await backToMain(host.page);

    // ---- 一人与多人：名单超出可用高度后仍只有名单滚动 ----
    let oneChecked = false;
    let manyChecked = false;
    for (let index = 1; index <= 20 && !manyChecked; index += 1) {
      await joinSpectator(guest, roomUrl, `观众${index}`);
      await openMembers(host.page);
      const state = await membersListProbe(host.page);
      expect(state.countText).toBe(`共 ${index} 人`);
      expect(state.rows).toBe(index);
      expect(state.separator).toBe("1px");
      expect(state.countBelowList).toBe(true);
      expect(state.fixedChrome).toBe(true);
      if (index === 1) {
        expect(state.scrollable).toBe(false);
        oneChecked = true;
      }
      if (state.scrollable) {
        expect(state.scrolledTo).toBeGreaterThan(0);
        manyChecked = true;
      }
      await backToMain(host.page);
    }
    expect(oneChecked).toBe(true);
    expect(manyChecked).toBe(true);

    // ---- 1536×864 与常规桌面：底部动作同样完整可见且可点击 ----
    for (const size of [
      { width: 1536, height: 864 },
      { width: 1920, height: 1080 },
    ]) {
      await host.page.setViewportSize(size);
      const state = await panelFooterProbe(host.page);
      expect(state.openUsable, `${size.width}×${size.height} 打开展示页不可用`).toBe(true);
      expect(state.copyUsable, `${size.width}×${size.height} 复制房间链接不可用`).toBe(true);
      expect(state.panelScrolls).toBe(false);
      expect(state.footerFixed).toBe(true);
    }

    assertNoPageErrors(host);
    assertNoPageErrors(guest);
  } finally {
    await browser.close();
  }
}, 240_000);
