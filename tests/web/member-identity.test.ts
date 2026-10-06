import { expect, test } from "vitest";
import type { MemberSelfInfo } from "../../shared/contracts/views";
import { memberIdentityText } from "../../src/room/member-identity";

// 本人身份提示：昵称 + 当前身份。房主兼任选手显示两种身份，左/右方对应
// 固定的 A/B 席位，未占席的普通成员为观众；换人后按最新视图重新派生
// （docs/specs/room-layout.md「本人身份提示」）。

function self(overrides: Partial<MemberSelfInfo>): MemberSelfInfo {
  return { memberId: "m1", nickname: "小鱼", isHost: false, seatTeam: null, ...overrides };
}

test("身份文案：观众、双方选手、房主与房主兼任选手", () => {
  expect(memberIdentityText(self({}))).toBe("小鱼 · 观众");
  expect(memberIdentityText(self({ seatTeam: "A" }))).toBe("小鱼 · 左方选手");
  expect(memberIdentityText(self({ seatTeam: "B" }))).toBe("小鱼 · 右方选手");
  expect(memberIdentityText(self({ isHost: true }))).toBe("小鱼 · 房主");
  expect(memberIdentityText(self({ isHost: true, seatTeam: "A" }))).toBe("小鱼 · 房主 · 左方选手");
  expect(memberIdentityText(self({ isHost: true, seatTeam: "B" }))).toBe("小鱼 · 房主 · 右方选手");
});

test("身份文案：房主被换下席位后仍是房主，不显示为观众", () => {
  // 换人前后同一位成员的两份视图：身份结论只随 self 字段变化。
  expect(memberIdentityText(self({ isHost: true, seatTeam: "A" }))).toBe("小鱼 · 房主 · 左方选手");
  expect(memberIdentityText(self({ isHost: true, seatTeam: null }))).toBe("小鱼 · 房主");
  // 普通选手被换下即回到观众。
  expect(memberIdentityText(self({ seatTeam: "B" }))).toBe("小鱼 · 右方选手");
  expect(memberIdentityText(self({}))).toBe("小鱼 · 观众");
});

test("身份文案：昵称原样展示（长度约束由共享 schema 维护）", () => {
  const nickname = "超长昵称选手乙一二三四五六七八九十";
  expect(memberIdentityText(self({ nickname }))).toBe(`${nickname} · 观众`);
});
