import { expect, test } from "vitest";
import { TeamNameDraft } from "../../src/room/team-name-draft";

// 队名草稿竞态回归：编辑代次 + 提交快照。覆盖父会话复审列出的三类场景
// 与原有边界（无关广播、失败保留、未编辑跟随、发送失败撤销）。

test("① 保存中改成第三个值：成功不覆盖后续编辑，允许再次保存", () => {
  const draft = new TeamNameDraft("原队名");
  draft.edit("已提交的新队名");
  const submitted = draft.beginSave();
  expect(submitted).toBe("已提交的新队名");
  // 保存回执在途时继续编辑为第三个值。
  draft.edit("第三个值");
  draft.settleSave({ ok: true });
  expect(draft.draft).toBe("第三个值");
  expect(draft.dirty).toBe(true);
  // 成功后的权威值到达也不覆盖（存在未收敛编辑）。
  draft.setAuthority("已提交的新队名");
  expect(draft.draft).toBe("第三个值");
  // 允许再次保存。
  expect(draft.beginSave()).toBe("第三个值");
});

test("② 保存中改回旧权威值：成功保留用户的「改回」，不被旧请求覆盖", () => {
  const draft = new TeamNameDraft("原队名");
  draft.edit("已提交的新队名");
  draft.beginSave();
  // 在途期间改回旧权威值（这是新的本地编辑，不是「未编辑」）。
  draft.edit("原队名");
  draft.settleSave({ ok: true });
  expect(draft.draft).toBe("原队名");
  expect(draft.dirty).toBe(true);
  // 服务器保存的「已提交的新队名」随视图到达：不覆盖用户改回的草稿。
  draft.setAuthority("已提交的新队名");
  expect(draft.draft).toBe("原队名");
  expect(draft.dirty).toBe(true);
  // 可再次保存「原队名」。
  expect(draft.beginSave()).toBe("原队名");
});

test("③ 无后续编辑的 trim 规范化成功：草稿收敛为落库值", () => {
  const draft = new TeamNameDraft("原队名");
  draft.edit("  含首尾空格队名  ");
  const submitted = draft.beginSave();
  expect(submitted).toBe("含首尾空格队名");
  draft.settleSave({ ok: true });
  expect(draft.draft).toBe("含首尾空格队名");
  expect(draft.dirty).toBe(false);
  // 权威值到达（与收敛值一致），保存按钮据此禁用。
  draft.setAuthority("含首尾空格队名");
  expect(draft.draft).toBe("含首尾空格队名");
  expect(draft.dirty).toBe(false);
});

test("无关广播（未编辑时不适用）：编辑中的草稿被保留", () => {
  const draft = new TeamNameDraft("原队名");
  draft.edit("应当保留的草稿");
  draft.setAuthority("原队名");
  expect(draft.draft).toBe("应当保留的草稿");
  expect(draft.dirty).toBe(true);
});

test("失败回执保留草稿，允许直接重试", () => {
  const draft = new TeamNameDraft("原队名");
  draft.edit("应当保留的重命名草稿");
  draft.beginSave();
  draft.settleSave({ ok: false });
  expect(draft.draft).toBe("应当保留的重命名草稿");
  expect(draft.dirty).toBe(true);
  // 权威值未变（STALE_REVISION 场景）也不覆盖。
  draft.setAuthority("原队名");
  expect(draft.draft).toBe("应当保留的重命名草稿");
  expect(draft.beginSave()).toBe("应当保留的重命名草稿");
});

test("未编辑状态跟随外部改名", () => {
  const draft = new TeamNameDraft("旧名");
  draft.setAuthority("别人改的名");
  expect(draft.draft).toBe("别人改的名");
  expect(draft.dirty).toBe(false);
});

test("发送被拒绝时撤销提交登记，草稿保持待保存", () => {
  const draft = new TeamNameDraft("原队名");
  draft.edit("新名");
  expect(draft.beginSave()).toBe("新名");
  draft.abortSave();
  expect(draft.saving).toBe(false);
  expect(draft.dirty).toBe(true);
  // 撤销后结算不生效（无提交快照）。
  draft.settleSave({ ok: true });
  expect(draft.draft).toBe("新名");
  expect(draft.dirty).toBe(true);
  // 仍可重新发起保存。
  expect(draft.beginSave()).toBe("新名");
});

test("已有在途保存时拒绝重复 beginSave", () => {
  const draft = new TeamNameDraft("原队名");
  draft.edit("新名");
  expect(draft.beginSave()).toBe("新名");
  expect(draft.beginSave()).toBeNull();
});

test("成功后继续编辑再保存：两轮代次独立收敛", () => {
  const draft = new TeamNameDraft("");
  draft.edit("第一版");
  draft.beginSave();
  draft.settleSave({ ok: true });
  expect(draft.draft).toBe("第一版");
  draft.edit("第二版");
  draft.beginSave();
  draft.settleSave({ ok: true });
  expect(draft.draft).toBe("第二版");
  expect(draft.dirty).toBe(false);
});
