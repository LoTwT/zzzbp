/**
 * 实时展示页中央代理人池的全量同屏排布算法（纯函数）。
 *
 * 需求见 docs/specs/room-layout.md「实时展示页」：根据本场目录条数与
 * 可用宽高调整网格列数与头像尺寸，在支持的电脑展示尺寸内同时呈现全部
 * 代理人，不依赖滚动、翻页或轮播；头像下名称直接可读，不以截断省略号
 * 代替直播画面可读性。数量与名称宽度都来自目录数据推导，不硬编码线框
 * 的 60 格或当前 58 人。
 *
 * 算法：枚举列数 1..count，按容器宽高求出该列数下的单元宽高与可容纳的
 * 头像尺寸（正方形，受行高与列宽双约束），先要求最长名称能以单行完整
 * 显示（宽度下限 = 展示组件实测的最长名称单行像素宽度 + 安全余量），
 * 在可行解中取头像最大者；并列时取更多列（高度受限时更多列不损失头像
 * 尺寸，只减少水平浪费）。无可行的单行解时退到两行名称的预算重算
 * （名称换行显示，仍不截断）；仍无解时给出最小尺寸兜底，由容器裁剪，
 * 不产生滚动条。
 *
 * 单行宽度必须用实测像素值而不是字符类估算：不同平台的字体回退会让同一
 * 名称相差零点几像素，估算一旦偏窄就会让最长名称换行，行高比预算多一行
 * 并在 content-center 下向容器外溢出。实测在展示组件中完成（用与名称
 * 相同的字体量取），本模块保持纯函数。
 */

/** 网格间隙（横纵相同，px）。导出供渲染层与算法保持同一数值。 */
export const GRID_GAP_PX = 4;
/** 卡片内边距（四周，px）。导出供渲染层共用。 */
export const CARD_PAD_PX = 2;
/** 名称字号与行高（px）：与展示卡片的文字规格一致。导出供渲染层共用。 */
export const NAME_FONT_PX = 12;
export const NAME_LINE_PX = 16;
/** 头像与名称之间的间距（px）。导出供渲染层共用。 */
export const AVATAR_NAME_GAP_PX = 2;
/** 头像尺寸上下限（px）：下限保证可辨认，上限避免大屏上比例失衡。
 * 导出供渲染与测试对照。 */
export const AVATAR_MIN_PX = 24;
export const AVATAR_MAX_PX = 144;
/** 浮点并列判定容差（px）。 */
const EPSILON_PX = 0.5;
/** 单行名称宽度安全余量（px）：吸收 1/64px 布局取整与测量噪声，远小于
 * 任何可见的列宽差，不会因余量本身改变列数选择之外的行为。 */
export const NAME_WIDTH_SAFETY_PX = 0.25;

/** 名称行与内边距构成的单元竖向固定开销：pad + name + gap + pad。 */
const CELL_FIXED_HEIGHT_PX = 2 * CARD_PAD_PX + NAME_LINE_PX + AVATAR_NAME_GAP_PX;

/** 排布结果；null 表示容器尚无可用尺寸或目录为空。 */
export interface DisplayGridSizing {
  readonly columns: number;
  readonly rows: number;
  /** 单元宽度（px，可为小数；渲染用 1fr 列 + gap 复现）。 */
  readonly cellWidth: number;
  /** 头像边长（px，正方形）。 */
  readonly avatarSize: number;
  /** 名称是否按可能换行（两行）预留高度。 */
  readonly nameWraps: boolean;
}

/** 算法输入：容器内容尺寸、条目数与目录中最长名称的实测单行宽度（px）。 */
export interface DisplayGridInput {
  readonly width: number;
  readonly height: number;
  readonly count: number;
  /** 目录中任一名称在名称元素实际字体下单行渲染的最大宽度（px）。 */
  readonly nameWidthPx: number;
}

/** 指定列数下的候选排布；不可行返回 null。 */
function candidateOf(
  input: DisplayGridInput,
  columns: number,
  nameLines: number,
  minCellWidth: number,
): DisplayGridSizing | null {
  const cellWidth = (input.width - (columns - 1) * GRID_GAP_PX) / columns;
  const rows = Math.ceil(input.count / columns);
  const cellHeight = (input.height - (rows - 1) * GRID_GAP_PX) / rows;
  if (cellWidth < minCellWidth) return null;
  const fixedHeight = CELL_FIXED_HEIGHT_PX + (nameLines - 1) * NAME_LINE_PX;
  const avatar = Math.min(cellWidth - 2 * CARD_PAD_PX, cellHeight - fixedHeight);
  if (avatar < AVATAR_MIN_PX) return null;
  return {
    columns,
    rows,
    cellWidth,
    avatarSize: Math.min(avatar, AVATAR_MAX_PX),
    nameWraps: nameLines > 1,
  };
}

/** 在全部候选中取头像最大者；并列取更多列（更紧凑的水平排布）。 */
function bestOf(candidates: ReadonlyArray<DisplayGridSizing>): DisplayGridSizing | null {
  let best: DisplayGridSizing | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      candidate.avatarSize > best.avatarSize + EPSILON_PX ||
      (Math.abs(candidate.avatarSize - best.avatarSize) <= EPSILON_PX &&
        candidate.columns > best.columns)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * 计算全量同屏排布。
 *
 * 第一优先级：最长名称单行完整显示（宽度下限 = 实测名称宽度 + 安全余量 + 内边距）；
 * 第二优先级：名称允许两行（宽度下限降为头像下限，行高预算加一行）；
 * 兜底：单列、最小头像、按两行名称预留——极端小容器下由外层裁剪，
 * 不产生滚动条。nameWidthPx 由调用方取目录全部条目实测宽度的最大值。
 */
export function computeDisplayGrid(input: DisplayGridInput): DisplayGridSizing | null {
  if (input.count <= 0 || input.width <= 0 || input.height <= 0) return null;

  const oneLineMinWidth = input.nameWidthPx + NAME_WIDTH_SAFETY_PX + 2 * CARD_PAD_PX;
  const oneLine: DisplayGridSizing[] = [];
  const wrapped: DisplayGridSizing[] = [];
  for (let columns = 1; columns <= input.count; columns += 1) {
    const single = candidateOf(input, columns, 1, oneLineMinWidth);
    if (single !== null) oneLine.push(single);
    // 两行名称的宽度下限：至少能以两行容纳最长名称的一半，并保住最小头像。
    const wrappedMinWidth = Math.max(
      AVATAR_MIN_PX + 2 * CARD_PAD_PX,
      input.nameWidthPx * 0.5 + 2 * CARD_PAD_PX,
    );
    const wrappedCandidate = candidateOf(input, columns, 2, wrappedMinWidth);
    if (wrappedCandidate !== null) wrapped.push(wrappedCandidate);
  }
  const one = bestOf(oneLine);
  if (one !== null) return one;
  const two = bestOf(wrapped);
  if (two !== null) return two;
  return {
    columns: 1,
    rows: input.count,
    cellWidth: input.width,
    avatarSize: AVATAR_MIN_PX,
    nameWraps: true,
  };
}
