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
 * 重连降级为观众、结果未知命令的重连核对（同 operationId 同载荷收敛，
 * 确定性注入）、房主兼任选手。
 *
 * 断线注入分三类，全部作用在真实 WS 帧上：
 * - 真实关闭页面（用户关标签）用于「部分断开」；
 * - 代理强制断开用于「最后一页掉线」（context.setOffline 不会终止既有
 *   WebSocket，代理关闭才能制造服务端可见断线）；
 * - 结果未知核对：代理扣下目标命令的成功回执（服务端已提交的既成事实）
 *   并随即切断，客户端必然进入「正在核对结果…」；重连被暂时阻断以稳定
 *   观察核对反馈，恢复后断言同 operationId、同载荷字节重发，且服务端
 *   回执幂等重放（bp.version 不变）——不靠点击快慢或 sleep 碰运气。
 *
 * 代理在首次入房之前安装——routeWebSocket 只拦截注册后新建的连接——
 * 并等待注册完成；帧一律手动转发以支持观测与扣留。
 */

interface TargetCommandFrames {
  readonly operationId: string;
  readonly raw: string;
}

/** 成员通道代理：可关闭当前连接、拒绝新连接、观测帧并扣留目标回执。 */
class MemberWsProxy {
  private readonly registration: Promise<void>;
  private current: WebSocketRoute | null = null;
  private mode: "proxy" | "fail" = "proxy";
  /** 是否武装：下一条 confirmPreselect 成为扣留目标。 */
  private armTarget = false;
  /** 扣留目标的 operationId；跨重连保持。 */
  private targetOperationId: string | null = null;
  private heldResolve: (() => void) | null = null;

  /** 客户端发出的 confirmPreselect 帧（原始序列化载荷字节）。 */
  readonly confirmSends: TargetCommandFrames[] = [];
  /** 服务端发出的目标命令 commandResult 帧（扣留一条 + 重放一条）。 */
  readonly targetResults: Array<TargetCommandFrames & { ok: boolean; bpVersion: number }> = [];
  /** 被扣留的成功回执（到达即代表服务端已提交）；未武装/未发生为 null。 */
  heldResult: (TargetCommandFrames & { ok: boolean; bpVersion: number }) | null = null;

  constructor(page: Page, roomId: string) {
    this.registration = page.routeWebSocket(new RegExp(`/api/rooms/${roomId}/ws$`), (ws) => {
      const server = ws.connectToServer();
      if (this.mode === "fail") {
        closeQuietly(ws);
        return;
      }
      this.current = ws;
      // 客户端 → 服务端：记录目标命令的原载荷字节后原样转发。
      ws.onMessage((message) => {
        if (typeof message === "string") {
          const parsed = parseFrame(message);
          if (parsed?.type === "confirmPreselect" && typeof parsed.operationId === "string") {
            this.confirmSends.push({ operationId: parsed.operationId, raw: message });
            if (this.armTarget && this.targetOperationId === null) {
              this.targetOperationId = parsed.operationId;
              this.armTarget = false;
            }
          }
        }
        server.send(message);
      });
      // 服务端 → 客户端：扣留目标命令的成功回执并切断；其余原样转发。
      server.onMessage((message) => {
        if (typeof message === "string" && this.targetOperationId !== null) {
          const parsed = parseFrame(message);
          if (parsed?.kind === "commandResult" && parsed.operationId === this.targetOperationId) {
            this.targetResults.push({
              operationId: String(parsed.operationId),
              raw: message,
              ok: parsed.ok === true,
              bpVersion: Number(parsed.bpVersion ?? -1),
            });
            if (this.heldResult === null && parsed.ok === true) {
              // 服务端已提交（回执为先决条件）：扣下回执并使连接断线，
              // 让客户端进入「结果未知、核对中」。
              this.heldResult = {
                operationId: String(parsed.operationId),
                raw: message,
                ok: true,
                bpVersion: Number(parsed.bpVersion ?? -1),
              };
              closeQuietly(ws);
              this.heldResolve?.();
              return;
            }
          }
        }
        ws.send(message);
      });
    });
  }

  /** 等待路由注册完成：注册是异步的，未完成前建立的连接不会被拦截。 */
  async ready(): Promise<void> {
    await this.registration;
  }

  /**
   * 武装扣留：下一条 confirmPreselect 成为目标，其成功回执被扣下、
   * 连接被切断。返回在扣留发生时兑现的 promise。
   */
  armConfirmHold(): Promise<void> {
    this.armTarget = true;
    this.targetOperationId = null;
    this.heldResult = null;
    return new Promise((resolve) => {
      this.heldResolve = resolve;
    });
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

/** 解析文本帧；非 JSON 返回 null。 */
function parseFrame(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
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

    // ---- 断线期间：本地筛选仍可用，服务端操作被禁用 ----
    // p1 保留最后收到的画面（进行中、A 为当前操作方），不显示暂停。
    await waitForStatus(playerA.page, "进行中");
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

    // ---- 结果未知核对（确定性）：扣下 AP1 成功回执后断开 ----
    // 前提建立：代理先观测到服务端已提交的成功回执（被扣下），再切断连接；
    // 客户端因此必然进入「正在核对结果…」，而不是靠切断时机碰运气。
    const held = substituteWs.armConfirmHold();
    await agentCard(substitute.page, agentFor("AP1")).click();
    await confirmButton(substitute.page).click();
    await held;
    const heldResult = substituteWs.heldResult;
    expect(heldResult).not.toBeNull();
    expect(heldResult?.ok).toBe(true);
    // 阻断自动重连以稳定观察核对反馈（连接已断，不再依赖任何 sleep）。
    substituteWs.setMode("fail");
    await waitForConnectionText(substitute.page, "连接中断");
    await expectVisible(
      substitute.page.getByRole("button", { name: "正在核对结果…", exact: true }),
    );
    // 恢复连接：客户端重连后以同一 operationId、同一载荷字节重发核对。
    substituteWs.setMode("proxy");
    await waitForNoConnectionText(substitute.page);
    const operationId = heldResult?.operationId ?? "";
    // 「连接提示消失」只代表首个权威视图到达，重发与服务端重放回执仍可能在途；
    // 用有界轮询等待两个事实都实际到达后再取快照（不引入固定 sleep）。
    await expect
      .poll(
        () => substituteWs.confirmSends.filter((frame) => frame.operationId === operationId).length,
        { timeout: 20_000, interval: 100 },
      )
      .toBe(2);
    await expect
      .poll(
        () =>
          substituteWs.targetResults.filter((frame) => frame.operationId === operationId).length,
        { timeout: 20_000, interval: 100 },
      )
      .toBe(2);
    const sends = substituteWs.confirmSends.filter((frame) => frame.operationId === operationId);
    const results = substituteWs.targetResults.filter((frame) => frame.operationId === operationId);
    expect(sends[1]?.raw).toBe(sends[0]?.raw);
    // 服务端对重发幂等重放原回执：成功结论、bp.version 与首次提交一致，未再次推进。
    expect(results[1]?.ok).toBe(true);
    expect(results[1]?.bpVersion).toBe(results[0]?.bpVersion);
    expect(results[1]?.bpVersion).toBe(heldResult?.bpVersion);
    // 核对证据（人工可读）：同 operationId、同载荷字节、重发恰一次、回执幂等重放。
    console.log(
      `[e2e] 结果未知核对证据：operationId=${operationId} 载荷字节=${new TextEncoder().encode(sends[0]?.raw ?? "").length} 发送次数=${sends.length} 扣留回执bpVersion=${heldResult?.bpVersion ?? -1} 重放回执bpVersion=${results[1]?.bpVersion ?? -1}`,
    );
    // 等待客户端核对反馈真正收敛：结算为成功结论，不得残留提交中/核对中或
    // 「结果未知」错误（操作位仍在替补一方，反馈显示在按钮标签与固定反馈区）。
    await agentCard(substitute.page, agentFor("AP1"), "已选用").waitFor({ state: "visible" });
    await expect
      .poll(
        async () => {
          const page = substitute.page;
          const pendingTexts = await Promise.all([
            page.getByText("正在核对结果…", { exact: true }).count(),
            page.getByText("正在核对上一操作结果…", { exact: true }).count(),
            page.getByText("上一操作提交中…", { exact: true }).count(),
            page.getByText("操作结果未知", { exact: false }).count(),
          ]);
          return pendingTexts.reduce((sum, count) => sum + count, 0);
        },
        { timeout: 20_000, interval: 100 },
      )
      .toBe(0);
    await agentCard(host.page, agentFor("AP1"), "已选用").waitFor({ state: "visible" });

    // 核对期断线同样触发掉线暂停（替补在席，规格行为）：暂停保持到房主手动恢复；
    // 面板「可撤回」恰为第 5 步（AP1），证明整场只推进一次。
    await waitForStatus(host.page, "已暂停");
    await openPanel(host.page);
    await host.page.getByText("可撤回：第 5 步", { exact: false }).waitFor();
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
