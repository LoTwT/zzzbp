import { expect, test } from "vitest";
import { chromium } from "playwright";
import type { Page, WebSocketRoute } from "playwright";
import type { BpSlotId } from "../../shared/bp/steps";
import {
  AGENTS,
  BP_ORDER,
  LONGEST_NAME_AGENT,
  agentCard,
  assertNoPageErrors,
  closePanel,
  confirmButton,
  createRoomViaUi,
  expectCount,
  expectDisabled,
  expectHidden,
  expectVisible,
  joinRoomViaUi,
  newRoomContext,
  newSameIdentityPage,
  openPanel,
  saveTeamName,
  assignSeatViaUi,
  submitStep,
  waitForStatus,
} from "./helpers";

/**
 * 断线与恢复端到端验收（PR10）：同一房间内连贯覆盖——同身份多页面的
 * 部分页面关闭不掉线、同身份新页面恢复身份、最后一页掉线立即暂停、
 * 断线期间本地筛选/布局仍可用且服务端操作被禁用、暂停换人、原选手
 * 重连降级为观众、结果未知命令的重连核对（同 operationId 收敛）、
 * 房主兼任选手。
 *
 * 断线注入分两类：真实关闭页面（用户关标签）用于「部分断开」；成员
 * 通道代理强制断开用于「最后一页掉线」（context.setOffline 不会终止
 * 既有 WebSocket，代理关闭才能制造服务端可见断线）。代理在首次入房
 * 之前安装——routeWebSocket 只拦截注册后新建的连接——并等待注册完成。
 */

/** 成员通道代理：可随时强制关闭当前连接，或在「fail」模式下拒绝新连接。 */
class MemberWsProxy {
  private readonly registration: Promise<void>;
  private current: WebSocketRoute | null = null;
  private mode: "proxy" | "fail" = "proxy";

  constructor(page: Page, roomId: string) {
    this.registration = page.routeWebSocket(new RegExp(`/api/rooms/${roomId}/ws$`), (ws) => {
      ws.connectToServer();
      if (this.mode === "fail") {
        closeQuietly(ws);
        return;
      }
      this.current = ws;
    });
  }

  /** 等待路由注册完成：注册是异步的，未完成前建立的连接不会被拦截。 */
  async ready(): Promise<void> {
    await this.registration;
  }

  /** 强制关闭当前连接（关闭会沿代理向服务端传播为真实断线）。 */
  kill(): void {
    if (this.current !== null) closeQuietly(this.current);
    this.current = null;
  }

  setMode(mode: "proxy" | "fail"): void {
    this.mode = mode;
  }
}

/** 关闭 WebSocket 代理句柄，吞掉已断开时的同步异常。 */
function closeQuietly(socket: { close(): void }): void {
  try {
    socket.close();
  } catch {
    // 连接可能已被对端关闭。
  }
}

/** 等待本机连接提示出现（「正在重连…」/「连接中断」）。 */
async function waitForConnectionText(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).waitFor({ state: "visible" });
}

/** 等待本机连接提示消失（重连成功并保持连接）。 */
async function waitForNoConnectionText(page: Page): Promise<void> {
  await expectHidden(page.getByText("正在重连…", { exact: true }));
  await expectHidden(page.getByText("连接中断", { exact: true }));
}

test("断线恢复：多页面掉线暂停、本地操作、换人与结果未知核对", async () => {
  const browser = await chromium.launch();

  try {
    // ---- 开局：建房、四方入房、分席并推进两步 ----
    const host = await newRoomContext(browser, "host", { width: 1440, height: 900 });
    const roomUrl = await createRoomViaUi(host, "首版验收·断线赛", "主办小鱼");
    const roomId = /\/rooms\/([^/?#]+)/.exec(roomUrl)?.[1] ?? "";

    const playerA = await newRoomContext(browser, "playerA", { width: 1440, height: 900 });
    const playerB = await newRoomContext(browser, "playerB", { width: 1280, height: 640 });
    const substitute = await newRoomContext(browser, "substitute", { width: 1440, height: 900 });
    const spectator = await newRoomContext(browser, "spectator", { width: 1440, height: 900 });

    // 代理成员通道：必须在首次入房（建立成员 WS）之前安装并等待注册。
    const ws1 = new MemberWsProxy(playerA.page, roomId);
    const substituteWs = new MemberWsProxy(substitute.page, roomId);
    await ws1.ready();
    await substituteWs.ready();

    await joinRoomViaUi(playerA, roomUrl, "选手甲");
    await joinRoomViaUi(playerB, roomUrl, "选手乙");
    await joinRoomViaUi(substitute, roomUrl, "替补小七");
    await joinRoomViaUi(spectator, roomUrl, "观众星河");

    await openPanel(host.page);
    await saveTeamName(host.page, "A", "甲队");
    await saveTeamName(host.page, "B", "乙队");
    await assignSeatViaUi(host.page, "A", "选手甲");
    await assignSeatViaUi(host.page, "B", "选手乙");
    await host.page.getByRole("button", { name: "开始 BP", exact: true }).click();
    await closePanel(host.page);

    const plan = AGENTS.slice(0, 26).map((entry) => entry.name);
    const agentFor = (slotId: BpSlotId): string => plan[BP_ORDER.indexOf(slotId)] ?? "";

    await submitStep(playerA.page, "AB1", agentFor("AB1"));
    await submitStep(playerB.page, "BB1", agentFor("BB1"));

    // ---- 同身份新页面：Cookie 恢复身份，不经入房表单；刷新后仍同步 ----
    const page2 = await newSameIdentityPage(playerA, "playerA-p2");
    await page2.goto(roomUrl);
    await waitForStatus(page2, "进行中");
    expect(await page2.getByRole("heading", { name: "进入房间" }).count()).toBe(0);
    await page2.reload();
    await waitForStatus(page2, "进行中");
    await agentCard(page2, agentFor("AB1"), "已禁用").waitFor({ state: "visible" });

    // ---- 部分页面关闭（真实关标签）：成员仍在线，BP 不暂停 ----
    await page2.close();
    await expect(await host.page.getByText("进行中", { exact: true }).count()).toBeGreaterThan(0);
    // 剩余页面 p1 可继续当前操作（AB2）。
    await submitStep(playerA.page, "AB2", agentFor("AB2"));

    // 推进 BB2，当前操作位回到 A 方（AP1）。
    await submitStep(playerB.page, "BB2", agentFor("BB2"));

    // ---- 最后一页掉线：A 唯一页面被强制断开，BP 立即暂停 ----
    ws1.setMode("fail");
    ws1.kill();
    await waitForConnectionText(playerA.page, "连接中断");
    await waitForStatus(host.page, "已暂停");
    await waitForStatus(spectator.page, "已暂停");

    // ---- 断线期间：本地筛选与布局仍可用，服务端操作被禁用 ----
    // p1 保留最后收到的画面（进行中、A 为当前操作方），不显示暂停。
    await waitForStatus(playerA.page, "进行中");
    await openPanel(playerA.page);
    await playerA.page.getByRole("button", { name: "按 Pick 分行", exact: true }).click();
    await closePanel(playerA.page);
    // 名称搜索仅命中唯一代理人（本地筛选覆盖全部状态）。
    await playerA.page.getByLabel("搜索代理人名称").fill(LONGEST_NAME_AGENT.name);
    await expectCount(playerA.page.locator('section[aria-label="代理人池"] ul li'), 1);
    await agentCard(playerA.page, LONGEST_NAME_AGENT.name).waitFor({ state: "visible" });
    await playerA.page.getByLabel("搜索代理人名称").fill("");
    // 确认按钮保留最后视图但被禁用（断线禁用服务端操作，不隐藏入口）。
    await expectDisabled(confirmButton(playerA.page));

    // ---- 暂停换人：A 席换给在线观众「替补小七」并恢复 BP ----
    await openPanel(host.page);
    await host.page.getByRole("button", { name: "更换选手", exact: true }).nth(0).click();
    await host.page
      .getByRole("listitem")
      .filter({ hasText: "替补小七" })
      .getByRole("button", { name: "设为选手", exact: true })
      .click();
    await host.page.getByText("当前选手：替补小七").waitFor();
    await host.page.getByRole("button", { name: "返回", exact: true }).click();
    await host.page.getByRole("button", { name: "继续 BP", exact: true }).click();
    await closePanel(host.page);
    await waitForStatus(host.page, "进行中");
    // 替补接管 A 席且为当前操作方（AP1）：其页面出现搜索筛选与可用确认入口。
    await expectVisible(substitute.page.getByLabel("搜索代理人名称"));
    await expectVisible(confirmButton(substitute.page));

    // ---- 原选手重连：身份恢复但席位已被替换，降级为观众 ----
    ws1.setMode("proxy");
    await waitForNoConnectionText(playerA.page);
    await waitForStatus(playerA.page, "进行中");
    await expectHidden(playerA.page.getByLabel("搜索代理人名称"));
    await expectHidden(confirmButton(playerA.page));

    // ---- 结果未知核对：替补提交 AP1 时连接被切断，重连后同 ID 收敛 ----
    await agentCard(substitute.page, agentFor("AP1")).click();
    await confirmButton(substitute.page).click();
    // 回执到达前切断连接：客户端按「结果未知」进入核对并自动重连，
    // 以同一 operationId 重发；服务端回执去重保证恰好生效一次。
    substituteWs.kill();
    await agentCard(substitute.page, agentFor("AP1"), "已选用").waitFor({ state: "visible" });
    await waitForNoConnectionText(substitute.page);
    await agentCard(host.page, agentFor("AP1"), "已选用").waitFor({ state: "visible" });

    // 核对期断线同样触发掉线暂停（替补在席，规格行为）：房主手动恢复。
    await waitForStatus(host.page, "已暂停");
    await openPanel(host.page);
    await host.page.getByRole("button", { name: "继续 BP", exact: true }).click();
    await closePanel(host.page);
    await waitForStatus(playerB.page, "进行中");

    // ---- 房主兼任：推进 BP1/BP2 后主动暂停，把自己换上 A 席完成 AP2 ----
    await submitStep(playerB.page, "BP1", agentFor("BP1"));
    await submitStep(playerB.page, "BP2", agentFor("BP2"));
    await openPanel(host.page);
    await host.page.getByRole("button", { name: "暂停 BP", exact: true }).click();
    await waitForStatus(spectator.page, "已暂停");
    await host.page.getByRole("button", { name: "更换选手", exact: true }).nth(0).click();
    await host.page
      .getByRole("listitem")
      .filter({ hasText: "主办小鱼" })
      .getByRole("button", { name: "设为选手", exact: true })
      .click();
    await host.page.getByText("当前选手：主办小鱼").waitFor();
    await host.page.getByRole("button", { name: "返回", exact: true }).click();
    await host.page.getByRole("button", { name: "继续 BP", exact: true }).click();
    await closePanel(host.page);
    await waitForStatus(host.page, "进行中");
    // 兼任后房主页面获得选手入口并完成当前操作位（无双重推进的直接验证）。
    await expectVisible(host.page.getByLabel("搜索代理人名称"));
    await submitStep(host.page, "AP2", agentFor("AP2"));
    await agentCard(spectator.page, agentFor("AP2"), "已选用").waitFor({ state: "visible" });

    for (const ctx of [host, playerA, playerB, substitute, spectator]) {
      assertNoPageErrors(ctx);
    }
  } finally {
    await browser.close();
  }
}, 240_000);
