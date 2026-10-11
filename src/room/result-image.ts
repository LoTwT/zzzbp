import type { BpTeam } from "../../shared/bp/steps";
import {
  EXPORT_UNSUBMITTED_TEXT,
  exportCompletionText,
  type ExportAgentEntry,
  type ExportResultSnapshot,
} from "./result-export";
import { SECOND_BAN_ROUND_START_ORDINAL, SECOND_PICK_ROUND_START_ORDINAL } from "./pick-layout";

/**
 * BP 结果图片的浏览器本地渲染（docs/specs/room-layout.md「BP 结果导出」）。
 *
 * 原生 Canvas 输出固定 1600×1200 的分享排版 PNG：顶部房间名与完成情况，
 * 双列对应左方/右方（队名、4 个方形禁用缩略图、9 个带名称的矩形选用条目），
 * 禁用 2|2 与选用 6|3 沿用两轮分隔线（边界复用 pick-layout 的权威常量）。
 * 颜色取页面实际主题 token 的计算值（先在画笔上校验有效性，未解析或
 * 无效时退回内置兜底色，不把 var(...) 当画笔）；文字沿用页面正文字体栈
 * 并等待字体就绪。图片只加载本站同源资源：方图按保存的 crop 等价于
 * cover + object-position 裁切，旧圆图 contain 完整展示；null、加载失败、
 * 超时与跨域旧图一律用占位（名称仍在条目旁，代理人身份可辨认），不请求
 * 外部地址、不污染画布。每个素材等待有明确上限，整体失败以异常交给
 * 调用方按可恢复失败提示。
 */

/** 分享图的固定画布尺寸：不随用户 DPR 无界放大。 */
export const EXPORT_IMAGE_WIDTH = 1600;
export const EXPORT_IMAGE_HEIGHT = 1200;

/** 单个图片素材的等待上限：超时按加载失败处理，不无限阻塞导出。 */
const IMAGE_LOAD_TIMEOUT_MS = 5000;

/** 结果图片渲染失败（画布不可用或 PNG 编码失败）。 */
export class ResultImageError extends Error {}

/** 主题语义色的画布用解析结果；全部字段为可直接赋给画笔的颜色值。 */
interface ExportPalette {
  readonly canvas: string;
  readonly panel: string;
  readonly subtle: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  readonly borderSubtle: string;
  readonly borderDefault: string;
  readonly borderStrong: string;
}

/**
 * 内置兜底色：与默认 Paper 浅色主题的对应 token 同域，仅在计算值缺失、
 * 未解析（var(...)）或无法赋给画笔时使用，保证导出永远能出图。
 */
const PALETTE_FALLBACK: ExportPalette = {
  canvas: "#faf8f4",
  panel: "#ffffff",
  subtle: "#eee9df",
  textPrimary: "#191713",
  textSecondary: "#4a443a",
  textMuted: "#6b6252",
  borderSubtle: "rgba(25, 23, 19, 0.1)",
  borderDefault: "rgba(25, 23, 19, 0.16)",
  borderStrong: "rgba(25, 23, 19, 0.28)",
};

/**
 * 解析一个主题 token 为画笔可用颜色。
 *
 * 计算值取自 documentElement（自定义属性的计算值已完成 var() 替换）；
 * 剩余的未解析值（var(...)、unset 等）直接退回兜底。最终再在画笔上
 * 验证：把无效颜色赋给 fillStyle 不会改变取值，借此区分成功与失败，
 * 不把浏览器不认识的色串画进结果图。
 */
function resolveTokenColor(
  ctx: CanvasRenderingContext2D,
  tokenName: string,
  fallback: string,
): string {
  let raw = getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim();
  if (
    raw === "" ||
    raw.includes("var(") ||
    raw === "unset" ||
    raw === "inherit" ||
    raw === "initial" ||
    raw === "currentcolor" ||
    raw === "transparent"
  ) {
    raw = fallback;
  }
  const sentinel = "#010203";
  ctx.fillStyle = sentinel;
  ctx.fillStyle = raw;
  const assigned = ctx.fillStyle;
  ctx.fillStyle = "#ffffff";
  if (assigned.toLowerCase() === sentinel && raw.toLowerCase() !== sentinel) return fallback;
  return raw;
}

function resolvePalette(ctx: CanvasRenderingContext2D): ExportPalette {
  return {
    canvas: resolveTokenColor(ctx, "--surface-canvas", PALETTE_FALLBACK.canvas),
    panel: resolveTokenColor(ctx, "--surface-panel", PALETTE_FALLBACK.panel),
    subtle: resolveTokenColor(ctx, "--surface-subtle", PALETTE_FALLBACK.subtle),
    textPrimary: resolveTokenColor(ctx, "--text-primary", PALETTE_FALLBACK.textPrimary),
    textSecondary: resolveTokenColor(ctx, "--text-secondary", PALETTE_FALLBACK.textSecondary),
    textMuted: resolveTokenColor(ctx, "--text-muted", PALETTE_FALLBACK.textMuted),
    borderSubtle: resolveTokenColor(ctx, "--border-subtle", PALETTE_FALLBACK.borderSubtle),
    borderDefault: resolveTokenColor(ctx, "--border-default", PALETTE_FALLBACK.borderDefault),
    borderStrong: resolveTokenColor(ctx, "--border-strong", PALETTE_FALLBACK.borderStrong),
  };
}

/** 页面正文字体栈（计算值，含引号的原样栈表）；缺省退回通用无衬线。 */
let pageFontStack = "system-ui, sans-serif";

function pageFontFamily(): string {
  const family = getComputedStyle(document.body).fontFamily.trim();
  return family === "" ? "system-ui, sans-serif" : family;
}

/** ---- 文本排版：按码点断行、限行数并逐步缩小字号，绝不重叠越界。 ---- */

interface TextLayout {
  readonly lines: readonly string[];
  readonly fontSize: number;
}

/** 以当前字号把文本按码点断成不超过 maxWidth 的行；逐字换行对 CJK/emoji 安全。 */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const char of Array.from(text)) {
    const candidate = current + char;
    if (current !== "" && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** 省略截断到单行宽度内（自适应字号全部失败时的最终兜底，仍保留可读前缀）。 */
function clipWithEllipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
    clipped = Array.from(clipped).slice(0, -1).join("");
  }
  return `${clipped}…`;
}

/** 单行自适应：从 startSize 逐步缩小到 minSize，直到单行宽度可用；失败时省略截断。 */
function fitSingleLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  weight: number,
  startSize: number,
  minSize: number,
): TextLayout {
  for (let size = startSize; size >= minSize; size -= 1) {
    ctx.font = `${weight} ${size}px ${pageFontStack}`;
    if (ctx.measureText(text).width <= maxWidth) return { lines: [text], fontSize: size };
  }
  ctx.font = `${weight} ${minSize}px ${pageFontStack}`;
  return { lines: [clipWithEllipsis(ctx, text, maxWidth)], fontSize: minSize };
}

/** 多行自适应：逐步缩小字号直到行数不超过 maxLines；仍超出时末行省略截断。 */
function fitMultiLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
  weight: number,
  startSize: number,
  minSize: number,
): TextLayout {
  for (let size = startSize; size >= minSize; size -= 1) {
    ctx.font = `${weight} ${size}px ${pageFontStack}`;
    const lines = wrapLines(ctx, text, maxWidth);
    if (lines.length <= maxLines) return { lines, fontSize: size };
  }
  ctx.font = `${weight} ${minSize}px ${pageFontStack}`;
  const lines = wrapLines(ctx, text, maxWidth).slice(0, maxLines);
  if (lines.length === 0) return { lines: [], fontSize: minSize };
  lines[lines.length - 1] = clipWithEllipsis(ctx, lines[lines.length - 1] ?? "", maxWidth);
  return { lines, fontSize: minSize };
}

/** ---- 图片加载：仅同源，失败/超时/跨域返回 null（占位兜底）。 ---- */

function isSameOriginUrl(url: string): boolean {
  try {
    return new URL(url, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok && image.naturalWidth > 0 && image.naturalHeight > 0 ? image : null);
    };
    const timer = setTimeout(() => finish(false), IMAGE_LOAD_TIMEOUT_MS);
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
  });
}

/** 条目在指定用途下需要加载的同源地址（跨域旧图不请求，直接占位）。 */
function entryImageUrl(entry: ExportAgentEntry | null, variant: "thumb" | "wide"): string | null {
  if (entry === null || entry.image === null) return null;
  if (entry.image.kind === "square") {
    const url = variant === "thumb" ? (entry.image.thumbUrl ?? entry.image.url) : entry.image.url;
    return isSameOriginUrl(url) ? url : null;
  }
  // 旧圆图本地副本为同源路径；仍解析为跨域的按外部图片处理（不请求）。
  return isSameOriginUrl(entry.image.url) ? entry.image.url : null;
}

/** 并行加载快照需要的全部同源图片；同一地址只加载一次。 */
async function loadSnapshotImages(
  snapshot: ExportResultSnapshot,
): Promise<ReadonlyMap<string, HTMLImageElement>> {
  const urls = new Set<string>();
  for (const team of ["A", "B"] as const) {
    const result = snapshot.teams[team];
    for (const entry of result.bans) {
      const url = entryImageUrl(entry, "thumb");
      if (url !== null) urls.add(url);
    }
    for (const entry of result.picks) {
      const url = entryImageUrl(entry, "wide");
      if (url !== null) urls.add(url);
    }
  }
  const loaded = new Map<string, HTMLImageElement>();
  await Promise.all(
    [...urls].map(async (url) => {
      const image = await loadImage(url);
      if (image !== null) loaded.set(url, image);
    }),
  );
  return loaded;
}

/** ---- 绘制 ---- */

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function roundedRectPath(ctx: CanvasRenderingContext2D, box: Box, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.width, box.height, radius);
}

/**
 * 方图母图的 cover + object-position 等价裁切：放大到覆盖目标框后，按
 * crop 百分比选取裁切窗口（与 AgentAvatar 的 wide 用途同一语义）。
 */
function drawCoverCrop(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  box: Box,
  crop: { readonly x: number; readonly y: number } | null,
): void {
  const scale = Math.max(box.width / image.naturalWidth, box.height / image.naturalHeight);
  const sourceWidth = box.width / scale;
  const sourceHeight = box.height / scale;
  const sourceX = ((image.naturalWidth - sourceWidth) * (crop?.x ?? 50)) / 100;
  const sourceY = ((image.naturalHeight - sourceHeight) * (crop?.y ?? 50)) / 100;
  ctx.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    box.x,
    box.y,
    box.width,
    box.height,
  );
}

/** 旧圆图等价 contain：等比完整展示并居中（不裁切、不放大变形）。 */
function drawContain(ctx: CanvasRenderingContext2D, image: HTMLImageElement, box: Box): void {
  const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  ctx.drawImage(
    image,
    box.x + (box.width - width) / 2,
    box.y + (box.height - height) / 2,
    width,
    height,
  );
}

/** 条目图片：优先同源已加载图，缺图/失败/跨域画占位底色；名称由调用方绘制。 */
function drawEntryImage(
  ctx: CanvasRenderingContext2D,
  palette: ExportPalette,
  images: ReadonlyMap<string, HTMLImageElement>,
  entry: ExportAgentEntry,
  box: Box,
  variant: "thumb" | "wide",
): void {
  ctx.save();
  roundedRectPath(ctx, box, 8);
  ctx.clip();
  const url = entryImageUrl(entry, variant);
  const image = url === null ? null : (images.get(url) ?? null);
  if (image !== null && entry.image !== null) {
    if (entry.image.kind === "square") {
      drawCoverCrop(ctx, image, box, entry.image.crop);
    } else {
      drawContain(ctx, image, box);
    }
  } else {
    ctx.fillStyle = palette.subtle;
    ctx.fillRect(box.x, box.y, box.width, box.height);
  }
  ctx.restore();
}

/** 设置字号与字重后在盒内垂直居中绘制多行文字（行高 1.25）。 */
function drawCenteredLines(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  color: string,
  box: Box,
  fontSize: number,
  weight: number,
): void {
  const lineHeight = fontSize * 1.25;
  const total = lines.length * lineHeight;
  let y = box.y + Math.max(0, (box.height - total) / 2);
  ctx.font = `${weight} ${fontSize}px ${pageFontStack}`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const line of lines) {
    ctx.fillText(line, box.x + box.width / 2, y);
    y += lineHeight;
  }
}

/** 左对齐绘制单行文字（页眉与列标题用，先由调用方完成自适应布局）。 */
function drawLineLeft(
  ctx: CanvasRenderingContext2D,
  text: string,
  color: string,
  x: number,
  y: number,
  fontSize: number,
  weight: number,
): void {
  ctx.font = `${weight} ${fontSize}px ${pageFontStack}`;
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(text, x, y);
}

/** 左对齐、按垂直中心绘制多行文字（选用条目名称，紧邻图片无大段留白）。 */
function drawLinesLeftAligned(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  color: string,
  x: number,
  centerY: number,
  fontSize: number,
  weight: number,
): void {
  const lineHeight = fontSize * 1.25;
  let y = centerY - (lines.length * lineHeight) / 2;
  ctx.font = `${weight} ${fontSize}px ${pageFontStack}`;
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
}

// ---- 固定版式（1600×1200）：内边距、页眉、双列与各块尺寸。 ----

const PAGE_PADDING = 48;
const HEADER_TOP = 56;
const HEADER_LINE_GAP = 14;
const COLUMNS_TOP = 188;
const COLUMN_GAP = 48;
const COLUMN_WIDTH = (EXPORT_IMAGE_WIDTH - PAGE_PADDING * 2 - COLUMN_GAP) / 2;
const TEAM_HEADER_HEIGHT = 44;
/** 分区标签（禁用/选用）：让分享图在脱离网页后仍能自足表达结果含义。 */
const SECTION_LABEL_FONT = 15;
const SECTION_LABEL_HEIGHT = 20;
const SECTION_LABEL_GAP = 8;
const TEAM_HEADER_GAP = 16;
const BAN_SIZE = 132;
const BAN_NAME_HEIGHT = 40;
const BAN_NAME_GAP = 8;
const BAN_BLOCK_HEIGHT = BAN_SIZE + BAN_NAME_GAP + BAN_NAME_HEIGHT;
const BAN_INTER_GAP = 14;
const BAN_DIVIDER_GAP = 32;
const PICK_SECTION_GAP = 18;
const PICK_ROW_HEIGHT = 64;
const PICK_ROW_GAP = 7;
const PICK_DIVIDER_GAP = 14;
/**
 * 选用图片框宽高比约 2.1:1，不低于 UI 选用卡的实际比例（约 2.3:1）：
 * 逐角色校准的裁切窗口完整覆盖脸部安全区，不裁得更薄。
 */
const PICK_IMAGE_WIDTH = 114;
const PICK_IMAGE_HEIGHT = 54;
const PICK_IMAGE_PADDING_X = 10;
const PICK_NAME_GAP = 14;

/** 某列第 index 个禁用缩略图的横向位置（第二轮起始位次起让出分隔线间距）。 */
function banThumbX(index: number): number {
  const totalWidth = 4 * BAN_SIZE + 2 * BAN_INTER_GAP + BAN_DIVIDER_GAP;
  const startX = (COLUMN_WIDTH - totalWidth) / 2;
  const secondRound = index >= SECOND_BAN_ROUND_START_ORDINAL - 1 ? 1 : 0;
  const pairOffset = secondRound * (BAN_DIVIDER_GAP - BAN_INTER_GAP);
  return startX + index * (BAN_SIZE + BAN_INTER_GAP) + pairOffset;
}

/** 某列第 index 个选用条目的纵向位置（第二轮起始位次起让出分隔线间隙）。 */
function pickRowY(index: number): number {
  const extra = index >= SECOND_PICK_ROUND_START_ORDINAL - 1 ? PICK_DIVIDER_GAP : 0;
  return index * (PICK_ROW_HEIGHT + PICK_ROW_GAP) + extra;
}

function drawTeamColumn(
  ctx: CanvasRenderingContext2D,
  palette: ExportPalette,
  snapshot: ExportResultSnapshot,
  images: ReadonlyMap<string, HTMLImageElement>,
  team: BpTeam,
  columnX: number,
): void {
  const result = snapshot.teams[team];
  const sideText = team === "A" ? "左方" : "右方";
  const headerText = result.teamName === "" ? sideText : `${sideText} · ${result.teamName}`;

  // 列标题（方位 + 队名）：单行自适应列宽。
  const headerLayout = fitSingleLine(ctx, headerText, COLUMN_WIDTH, 600, 34, 20);
  drawLineLeft(
    ctx,
    headerLayout.lines[0] ?? "",
    palette.textPrimary,
    columnX,
    COLUMNS_TOP,
    headerLayout.fontSize,
    600,
  );

  // ---- 禁用区：分区标签 + 4 个方形缩略图 + 名称，第 2、3 格之间竖线分隔两轮。 ----
  const banLabelY = COLUMNS_TOP + TEAM_HEADER_HEIGHT + TEAM_HEADER_GAP;
  drawLineLeft(ctx, "禁用", palette.textMuted, columnX, banLabelY, SECTION_LABEL_FONT, 600);
  const banTop = banLabelY + SECTION_LABEL_HEIGHT + SECTION_LABEL_GAP;
  for (let index = 0; index < 4; index += 1) {
    const entry = result.bans[index] ?? null;
    const thumbBox: Box = {
      x: columnX + banThumbX(index),
      y: banTop,
      width: BAN_SIZE,
      height: BAN_SIZE,
    };
    ctx.strokeStyle = entry === null ? palette.borderSubtle : palette.borderDefault;
    ctx.lineWidth = 1;
    roundedRectPath(ctx, thumbBox, 12);
    ctx.fillStyle = palette.panel;
    ctx.fill();
    ctx.stroke();
    if (entry === null) {
      // 未提交禁用位：空框 + 占位文案，不伪造结果。
      drawCenteredLines(ctx, [EXPORT_UNSUBMITTED_TEXT], palette.textMuted, thumbBox, 15, 400);
      continue;
    }
    drawEntryImage(ctx, palette, images, entry, thumbBox, "thumb");
    const nameLayout = fitMultiLine(ctx, entry.name, BAN_SIZE, 2, 500, 16, 13);
    drawCenteredLines(
      ctx,
      nameLayout.lines,
      palette.textSecondary,
      {
        x: thumbBox.x,
        y: banTop + BAN_SIZE + BAN_NAME_GAP,
        width: BAN_SIZE,
        height: BAN_NAME_HEIGHT,
      },
      nameLayout.fontSize,
      500,
    );
  }
  // 禁用两轮分隔线：第 2、3 个缩略图之间（覆盖禁用块及其名称区）。
  const banDividerX = columnX + banThumbX(SECOND_BAN_ROUND_START_ORDINAL - 1) - BAN_DIVIDER_GAP / 2;
  ctx.strokeStyle = palette.borderStrong;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(banDividerX, banTop - 8);
  ctx.lineTo(banDividerX, banTop + BAN_BLOCK_HEIGHT + 8);
  ctx.stroke();

  // ---- 选用区：分区标签 + 9 个矩形条目（图片 + 名称），第 6、7 格之间横线分隔两轮。 ----
  const pickLabelY = banTop + BAN_BLOCK_HEIGHT + PICK_SECTION_GAP;
  drawLineLeft(ctx, "选用", palette.textMuted, columnX, pickLabelY, SECTION_LABEL_FONT, 600);
  const pickTop = pickLabelY + SECTION_LABEL_HEIGHT + SECTION_LABEL_GAP;
  for (let index = 0; index < 9; index += 1) {
    const entry = result.picks[index] ?? null;
    const rowY = pickTop + pickRowY(index);
    const cardBox: Box = { x: columnX, y: rowY, width: COLUMN_WIDTH, height: PICK_ROW_HEIGHT };
    ctx.strokeStyle = entry === null ? palette.borderSubtle : palette.borderDefault;
    ctx.lineWidth = 1;
    roundedRectPath(ctx, cardBox, 10);
    ctx.fillStyle = palette.panel;
    ctx.fill();
    ctx.stroke();
    if (entry === null) {
      drawCenteredLines(ctx, [EXPORT_UNSUBMITTED_TEXT], palette.textMuted, cardBox, 18, 400);
      continue;
    }
    drawEntryImage(
      ctx,
      palette,
      images,
      entry,
      {
        x: cardBox.x + PICK_IMAGE_PADDING_X,
        y: rowY + (PICK_ROW_HEIGHT - PICK_IMAGE_HEIGHT) / 2,
        width: PICK_IMAGE_WIDTH,
        height: PICK_IMAGE_HEIGHT,
      },
      "wide",
    );
    const nameX = cardBox.x + PICK_IMAGE_PADDING_X + PICK_IMAGE_WIDTH + PICK_NAME_GAP;
    const nameMaxWidth =
      COLUMN_WIDTH - (PICK_IMAGE_PADDING_X + PICK_IMAGE_WIDTH + PICK_NAME_GAP) - 14;
    const nameLayout = fitMultiLine(ctx, entry.name, nameMaxWidth, 2, 500, 21, 18);
    drawLinesLeftAligned(
      ctx,
      nameLayout.lines,
      palette.textPrimary,
      nameX,
      rowY + PICK_ROW_HEIGHT / 2,
      nameLayout.fontSize,
      500,
    );
  }
  // 选用两轮分隔线：第 6、7 个条目之间。
  const pickDividerY =
    pickTop + pickRowY(SECOND_PICK_ROUND_START_ORDINAL - 1) - PICK_DIVIDER_GAP / 2;
  ctx.strokeStyle = palette.borderStrong;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(columnX, pickDividerY);
  ctx.lineTo(columnX + COLUMN_WIDTH, pickDividerY);
  ctx.stroke();
}

/**
 * 渲染结果图片（PNG Blob）。
 *
 * 同步绘制前的异步等待只有两类：页面字体就绪与同源图片加载（有上限）。
 * 快照本身不可变，等待期间源房间变化不会混入本图；是否继续下载由
 * 调用方在取得 Blob 后校验来源一致性（见 ResultExportActions）。
 */
export async function renderResultImagePng(snapshot: ExportResultSnapshot): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = EXPORT_IMAGE_WIDTH;
  canvas.height = EXPORT_IMAGE_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new ResultImageError("画布不可用");
  const palette = resolvePalette(ctx);
  pageFontStack = pageFontFamily();
  // 等待页面字体（含 CJK 字面量字体）就绪再测量与绘制，避免回退字体宽度误差。
  await document.fonts.ready;
  const images = await loadSnapshotImages(snapshot);

  // 背景
  ctx.fillStyle = palette.canvas;
  ctx.fillRect(0, 0, EXPORT_IMAGE_WIDTH, EXPORT_IMAGE_HEIGHT);

  // 页眉：房间名（单行自适应，极端超长时省略截断）+ 完成情况。
  const headerMaxWidth = EXPORT_IMAGE_WIDTH - PAGE_PADDING * 2;
  const headerLayout = fitSingleLine(ctx, snapshot.roomName, headerMaxWidth, 600, 44, 16);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `600 ${headerLayout.fontSize}px ${pageFontStack}`;
  ctx.fillStyle = palette.textPrimary;
  ctx.fillText(headerLayout.lines[0] ?? "", EXPORT_IMAGE_WIDTH / 2, HEADER_TOP);
  ctx.font = `400 26px ${pageFontStack}`;
  ctx.fillStyle = palette.textMuted;
  ctx.fillText(
    `BP 结果 · ${exportCompletionText(snapshot)}`,
    EXPORT_IMAGE_WIDTH / 2,
    HEADER_TOP + headerLayout.fontSize * 1.3 + HEADER_LINE_GAP,
  );

  drawTeamColumn(ctx, palette, snapshot, images, "A", PAGE_PADDING);
  drawTeamColumn(ctx, palette, snapshot, images, "B", PAGE_PADDING + COLUMN_WIDTH + COLUMN_GAP);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new ResultImageError("PNG 编码失败"));
      else resolve(blob);
    }, "image/png");
  });
}
