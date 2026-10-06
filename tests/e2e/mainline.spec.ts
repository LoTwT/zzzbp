import { expect, test } from "vitest";
import { chromium } from "playwright";
import {
  AGENTS,
  BP_ORDER,
  LONGEST_NAME_AGENT,
  NO_AVATAR_AGENTS,
  agentCard,
  assertConfirmNotCovered,
  assertNoOverflow,
  assertNoPageErrors,
  closePanel,
  confirmButton,
  expectDisabled,
  expectEnabled,
  createRoomViaUi,
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

/**
 * 首版主线端到端验收（PR10）：真实 cf dev 服务上，从 UI 建房、隔离身份
 * 入房、房主分席开局，经完整 26 步公开预选与确认，到完成后撤回、恢复、
 * 重开与再次开局的一条完整交付线。
 *
 * 视口组合：房主/选手 A/观众 1440×900，选手 B 1280×640（小窗口 + 长昵称
 * 与 32 码点长队名）。缺头像与最长名称代理人纳入 26 步序列（展示后备
 * 不改变操作可用性）。
 */

/** 一局 26 步的代理人分配：目录顺序前 26 名，替换两个代表（缺头像、最长名）。 */
function planAgents(): string[] {
  const names = AGENTS.slice(0, 26).map((entry) => entry.name);
  const replace = (index: number, entry: { readonly name: string } | undefined): void => {
    // 固定目录中缺头像与最长名称代理人均在 26 名之外；防御性检查避免重复。
    if (entry !== undefined && !names.includes(entry.name)) names[index] = entry.name;
  };
  replace(6, NO_AVATAR_AGENTS[0]);
  replace(12, LONGEST_NAME_AGENT);
  return names;
}

test("主线：建房 → 隔离身份入房 → 分席开局 → 完整 26 步 → 撤回/恢复 → 重开", async () => {
  const browser = await chromium.launch();
  const roomName = "首版验收·主线赛";
  const teamNameA = "甲队";
  const teamNameB = "乙".repeat(32); // 32 码点长队名
  const nicknameB = "超长昵称选手乙一二三四五六七八九十"; // 20 码点

  try {
    const host = await newRoomContext(browser, "host", { width: 1440, height: 900 });
    const playerA = await newRoomContext(browser, "playerA", { width: 1440, height: 900 });
    const playerB = await newRoomContext(browser, "playerB", { width: 1280, height: 640 });
    const spectator = await newRoomContext(browser, "spectator", { width: 1440, height: 900 });

    // ---- UI 建房与隔离身份入房 ----
    const roomUrl = await createRoomViaUi(host, roomName, "主办小鱼");
    expect(roomUrl).toContain("/rooms/");
    await waitForStatus(host.page, "待开始");
    await assertNoOverflow(host.page, "房主 待开始");

    await joinRoomViaUi(playerA, roomUrl, "选手甲");
    await joinRoomViaUi(playerB, roomUrl, nicknameB);
    await joinRoomViaUi(spectator, roomUrl, "观众星河");

    // 观众权限：无搜索筛选、无确认按钮，完整代理人池与面板入口。
    expect(await spectator.page.getByLabel("搜索代理人名称").count()).toBe(0);
    expect(await spectator.page.getByRole("button", { name: /确认禁用|确认选用/ }).count()).toBe(0);
    await agentCard(spectator.page, AGENTS[0]?.name ?? "").waitFor({ state: "visible" });
    await assertNoOverflow(spectator.page, "观众 待开始");

    // ---- 房主面板：队名、席位、开局条件 ----
    const panel = await openPanel(host.page);
    const startButton = panel.getByRole("button", { name: "开始 BP", exact: true });
    await expectDisabled(startButton);
    await panel.getByText("左方队伍名未填写").waitFor();
    await panel.getByText("右方席位无选手").waitFor();

    await saveTeamName(host.page, "A", teamNameA);
    await saveTeamName(host.page, "B", teamNameB);
    await assignSeatViaUi(host.page, "A", "选手甲");
    await assignSeatViaUi(host.page, "B", nicknameB);
    await closePanel(host.page);

    // 队名在各方页面同步显示（长队名截断由 title 兜底，不改变内容）。
    await playerB.page.getByText(teamNameA, { exact: true }).first().waitFor();
    await spectator.page.getByText(teamNameB, { exact: true }).first().waitFor();

    await openPanel(host.page);
    await expectEnabled(startButton);
    await startButton.click();
    await closePanel(host.page);

    for (const ctx of [host, playerA, playerB, spectator]) {
      await waitForStatus(ctx.page, "进行中");
    }

    // ---- 完整 26 步：公开预选、跨页同步 ----
    // 小窗口（1280×640）页面在开局后先确认无整页越界。
    await assertNoOverflow(playerB.page, "选手B 进行中");

    // 面板打开时底部确认按钮不被遮挡（1280×640 小窗口组合）。
    // B 方第一个操作位 BB1 之前轮到 A（AB1）：先由 A 操作一步再检查 B 的面板遮挡。
    // 第一步（AB1，A 方）：公开预选可见于观众页、可更换预选后确认。
    const plan = planAgents();
    const firstAgent = plan[0] ?? "";
    const secondChoice =
      AGENTS.find((entry) => !plan.includes(entry.name))?.name ?? AGENTS[26]?.name ?? "";
    await agentCard(playerA.page, firstAgent).click();
    await preselectText(spectator.page, firstAgent).waitFor({ state: "visible" });
    await agentCard(playerA.page, secondChoice).click();
    await preselectText(spectator.page, secondChoice).waitFor({ state: "visible" });
    await confirmButton(playerA.page).click();
    await agentCard(playerA.page, secondChoice, "已禁用").waitFor({ state: "visible" });
    // 双页面同步：观众页同步看到已禁用状态。
    await agentCard(spectator.page, secondChoice, "已禁用").waitFor({ state: "visible" });

    // BB1（B 方）：面板打开时底部确认按钮仍未被遮挡（面板只覆盖池区，
    // 不遮操作区）。外部首次点击只收起面板，因此这里按几何判定后收起面板，
    // 再走正常预选与确认。
    await openPanel(playerB.page);
    await assertConfirmNotCovered(playerB.page, "选手B 面板打开");
    await closePanel(playerB.page);
    await submitStep(playerB.page, "BB1", plan[1] ?? "");

    // 其余 24 步（AB2 … AP9）：按操作位在对应选手页执行，观众页逐轮同步。
    for (let index = 2; index < BP_ORDER.length; index += 1) {
      const slotId = BP_ORDER[index] ?? "";
      const operator = stepOf(slotId).team === "A" ? playerA.page : playerB.page;
      const agentName = plan[index] ?? "";
      await submitStep(operator, slotId, agentName, { expectOn: spectator.page });
    }

    // 完成态：各方页面显示已完成，代理人池全部落入两种终态。
    for (const ctx of [host, playerA, playerB, spectator]) {
      await waitForStatus(ctx.page, "已完成");
    }
    await assertNoOverflow(host.page, "房主 已完成");
    await assertNoOverflow(playerB.page, "选手B 已完成");

    // ---- 已完成撤回：回到 AP9 并暂停，由房主恢复 ----
    await openPanel(host.page);
    const undoButton = host.page.getByRole("button", { name: "撤回上一步", exact: true });
    await expectEnabled(undoButton);
    const lastPickName = plan[25] ?? "";
    await host.page.getByText(`可撤回：`, { exact: false }).waitFor();
    await undoButton.click();
    await closePanel(host.page);
    await waitForStatus(host.page, "已暂停");
    // AP9 恢复可用（卡片回到可选状态）。
    await agentCard(playerA.page, lastPickName).waitFor({ state: "visible" });

    // 房主恢复后 A 方重新提交 AP9，回到已完成。
    await openPanel(host.page);
    await host.page.getByRole("button", { name: "继续 BP", exact: true }).click();
    await closePanel(host.page);
    await waitForStatus(playerA.page, "进行中");
    await submitStep(playerA.page, "AP9", lastPickName);
    await waitForStatus(spectator.page, "已完成");

    // ---- 重开本局：清空禁选结果，保留成员/席位/队名，回到待开始 ----
    await openPanel(host.page);
    await host.page.getByRole("button", { name: "重开本局", exact: true }).click();
    await host.page.getByText("重开将清空本局全部禁选结果与未提交预选", { exact: false }).waitFor();
    await host.page.getByRole("button", { name: "确认重开", exact: true }).click();
    await closePanel(host.page);
    await waitForStatus(host.page, "待开始");
    await waitForStatus(playerB.page, "待开始");
    // 队名与席位保留：B 页继续显示长队名，池内代理人均恢复可选。
    await playerB.page.getByText(teamNameB, { exact: true }).first().waitFor();
    await agentCard(spectator.page, secondChoice).waitFor({ state: "visible" });
    await agentCard(spectator.page, lastPickName).waitFor({ state: "visible" });

    // 满足开局条件后重新开始，从 AB1 起再走一步（重开后流程可用）。
    await openPanel(host.page);
    await host.page.getByRole("button", { name: "开始 BP", exact: true }).click();
    await closePanel(host.page);
    await waitForStatus(playerA.page, "进行中");
    const restartAgent = plan[0] ?? "";
    await submitStep(playerA.page, "AB1", restartAgent, { expectOn: spectator.page });

    for (const ctx of [host, playerA, playerB, spectator]) {
      assertNoPageErrors(ctx);
    }
  } finally {
    await browser.close();
  }
}, 240_000);
