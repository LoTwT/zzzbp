import { expect, test } from "vitest";
import {
  AVATAR_MAX_PX,
  AVATAR_MIN_PX,
  CARD_PAD_PX,
  GRID_GAP_PX,
  NAME_LINE_PX,
  NAME_WIDTH_SAFETY_PX,
  AVATAR_NAME_GAP_PX,
  computeDisplayGrid,
  type DisplayGridInput,
  type DisplayGridSizing,
} from "../../src/room/display-grid";

// 展示页全量同屏排布算法回归（PR8）：
// - 任何解都必须在容器内放下全部条目（列宽×列数、行高×行数均不越界），
//   单行名称解的列宽不小于实测最长名称宽度 + 安全余量；
// - 列数与头像尺寸随条目数与容器尺寸自适应，不硬编码 60 格或 58 人；
// - 头像尺寸有上下限；并列时取更多列；单行名称不可行时退到两行名称
//   预算，仍不可行时给最小尺寸兜底；
// - 名称宽度是浏览器实测像素值（见 DisplayPool 的测量）：同一名称在不同
//   平台的字体回退下相差亚像素，字符类估算法偏窄会让最长名称换行。

/** 目录最长名称「奥菲丝&「鬼火」」在 12px 下的实测单行宽度上界（px）：
 * 本机约 92.5，Linux runner 字体回退下更宽，取跨字体上界验证。 */
const LONGEST_NAME_PX = 93.4;

/** 卡片竖向固定开销（不含头像与换行追加）：内边距 + 名称行 + 间距。 */
const CELL_FIXED_PX = 2 * CARD_PAD_PX + NAME_LINE_PX + AVATAR_NAME_GAP_PX;

/** 检查排布结果在容器内完整放下且满足单行名称宽度（nameWraps=false 时）。 */
function expectFits(sizing: DisplayGridSizing | null, input: DisplayGridInput): void {
  expect(sizing).not.toBeNull();
  const grid = sizing as DisplayGridSizing;
  expect(grid.columns).toBeGreaterThanOrEqual(1);
  expect(grid.rows).toBeGreaterThanOrEqual(1);
  expect(grid.columns * grid.rows).toBeGreaterThanOrEqual(input.count);
  // 水平：列宽 × 列数 + 间隙不越界。
  expect(grid.columns * grid.cellWidth + (grid.columns - 1) * GRID_GAP_PX).toBeLessThanOrEqual(
    input.width + 1e-6,
  );
  // 垂直：行内容高（头像 + 固定开销 + 换行追加）× 行数 + 间隙不越界。
  const cellHeight = grid.avatarSize + CELL_FIXED_PX + (grid.nameWraps ? NAME_LINE_PX : 0);
  expect(grid.rows * cellHeight + (grid.rows - 1) * GRID_GAP_PX).toBeLessThanOrEqual(
    input.height + 1e-6,
  );
  // 单行名称解：列宽足以完整显示实测最长名称（含安全余量）。
  if (!grid.nameWraps) {
    expect(grid.cellWidth).toBeGreaterThanOrEqual(
      input.nameWidthPx + NAME_WIDTH_SAFETY_PX + 2 * CARD_PAD_PX - 1e-6,
    );
  }
  expect(grid.avatarSize).toBeGreaterThanOrEqual(AVATAR_MIN_PX - 1e-6);
  expect(grid.avatarSize).toBeLessThanOrEqual(AVATAR_MAX_PX + 1e-6);
}

// 三个支持视口下中央网格的近似可用内容区（扣除头部、两侧列与内边距）。
const VIEWPORTS = {
  "1280x640": { width: 990, height: 528 },
  "1440x900": { width: 1150, height: 770 },
  "1920x1080": { width: 1630, height: 950 },
} as const;

test("58 名目录在三个支持视口内全部同屏、单行可读且头像不小于 48px", () => {
  for (const size of Object.values(VIEWPORTS)) {
    const input: DisplayGridInput = { ...size, count: 58, nameWidthPx: LONGEST_NAME_PX };
    const sizing = computeDisplayGrid(input);
    expectFits(sizing, input);
    expect((sizing as DisplayGridSizing).nameWraps).toBe(false);
    expect((sizing as DisplayGridSizing).rows).toBeLessThanOrEqual(7);
    expect((sizing as DisplayGridSizing).columns).toBeGreaterThanOrEqual(8);
    expect((sizing as DisplayGridSizing).avatarSize).toBeGreaterThanOrEqual(48);
  }
});

test("列数与行数随条目数自适应（30 与 60 人）", () => {
  const base = { ...VIEWPORTS["1440x900"], nameWidthPx: LONGEST_NAME_PX };
  const by30 = computeDisplayGrid({ ...base, count: 30 }) as DisplayGridSizing;
  expectFits(by30, { ...base, count: 30 });
  expect(by30.rows).toBeLessThanOrEqual(5);
  const by60 = computeDisplayGrid({ ...base, count: 60 }) as DisplayGridSizing;
  expectFits(by60, { ...base, count: 60 });
  expect(by60.columns * by60.rows).toBeGreaterThanOrEqual(60);
});

test("头像尺寸有上限：大容器不产生失衡头像", () => {
  const input: DisplayGridInput = {
    width: 3000,
    height: 1600,
    count: 58,
    nameWidthPx: LONGEST_NAME_PX,
  };
  const sizing = computeDisplayGrid(input) as DisplayGridSizing;
  expect(sizing.avatarSize).toBe(AVATAR_MAX_PX);
  expectFits(sizing, input);
});

test("并列头像尺寸取更多列（高度受限时更紧凑）", () => {
  // 构造行数同为 6 的相邻列数并列：10 与 11 列的头像都由行高决定（列宽
  // 均不构成约束），12 列列宽先到极限。应取并列中更多的 11 列。
  const sizing = computeDisplayGrid({
    width: 1200,
    height: 700,
    count: 58,
    nameWidthPx: LONGEST_NAME_PX,
  }) as DisplayGridSizing;
  expect(sizing.columns).toBe(11);
  expect(sizing.rows).toBe(6);
});

test("单行名称放不下时退到两行名称预算，仍不截断", () => {
  // 宽度 380：任何列数的单行名称宽度（~97px）都放不下，两行预算可行。
  const input: DisplayGridInput = {
    width: 380,
    height: 800,
    count: 58,
    nameWidthPx: LONGEST_NAME_PX,
  };
  const sizing = computeDisplayGrid(input) as DisplayGridSizing;
  expect(sizing.nameWraps).toBe(true);
  expectFits(sizing, input);
});

test("极端小容器给最小尺寸兜底，不返回 null", () => {
  const sizing = computeDisplayGrid({
    width: 60,
    height: 40,
    count: 58,
    nameWidthPx: LONGEST_NAME_PX,
  }) as DisplayGridSizing;
  expect(sizing.avatarSize).toBe(AVATAR_MIN_PX);
});

test("零尺寸或空目录返回 null", () => {
  expect(computeDisplayGrid({ width: 0, height: 500, count: 58, nameWidthPx: 93 })).toBeNull();
  expect(computeDisplayGrid({ width: 500, height: 0, count: 58, nameWidthPx: 93 })).toBeNull();
  expect(computeDisplayGrid({ width: 500, height: 500, count: 0, nameWidthPx: 93 })).toBeNull();
});

test("实测名称宽度微超可用宽度时不产生单行换行解（CI 回归）", () => {
  // 1280x640 展示页的真实容器约 1006x555：10 列时名称可用宽 93px。
  // 本机实测最长名称 92.54px 恰好单行可行；Linux 字体回退下同一名称
  // 约 93.3px，若仍按估算选 10 列就会换行并在网格居中下向容器外溢出。
  const local = computeDisplayGrid({
    width: 1006,
    height: 555,
    count: 58,
    nameWidthPx: 92.54,
  }) as DisplayGridSizing;
  expect(local.columns).toBe(10);
  expect(local.nameWraps).toBe(false);

  const widerFallback = computeDisplayGrid({
    width: 1006,
    height: 555,
    count: 58,
    nameWidthPx: 93.3,
  }) as DisplayGridSizing;
  expect(widerFallback.nameWraps).toBe(false);
  expect(widerFallback.columns).toBe(9);
  expect(widerFallback.cellWidth - 2 * CARD_PAD_PX).toBeGreaterThanOrEqual(93.3);
});

test("单条目在窄高容器内也可行", () => {
  const input: DisplayGridInput = { width: 200, height: 200, count: 1, nameWidthPx: 93 };
  const sizing = computeDisplayGrid(input) as DisplayGridSizing;
  expect(sizing.columns).toBe(1);
  expect(sizing.rows).toBe(1);
  expectFits(sizing, input);
});
