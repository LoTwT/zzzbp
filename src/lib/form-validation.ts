import type { ZodError } from "zod";
import { nicknameSchema, roomNameSchema, teamNameInputSchema } from "../../shared/room";

/**
 * 表单字段的中文错误提示：复用共享 Zod schema 的校验语义。
 *
 * 共同语义：输入先按 schema 的 trim 规则去首尾空白，再按 Unicode 码点计数
 * 长度（Zod 4 原生行为），边界值（房名 80、队名 32、昵称 24）与服务器端
 * 完全一致。这里只把 Zod 的结构化 issue 翻译成字段级中文文案；无法识别
 * 的问题回退到「格式不正确」，不把英文默认消息透给用户。
 */

/** 校验结果：null 表示通过，否则为字段错误文案。 */
export type FieldValidation = string | null;

function issueText(
  error: ZodError,
  messages: { readonly empty: string; readonly tooLong: string },
): string {
  const codes = new Set(error.issues.map((issue) => issue.code));
  if (codes.has("too_small")) return messages.empty;
  if (codes.has("too_big")) return messages.tooLong;
  return "格式不正确";
}

/** 房间名（赛事名）：trim 后 1 到 80 码点。 */
export function validateRoomName(value: string): FieldValidation {
  const result = roomNameSchema.safeParse(value);
  if (result.success) return null;
  return issueText(result.error, { empty: "房间名不能为空", tooLong: "房间名不能超过 80 个字符" });
}

/** 昵称：trim 后 1 到 24 码点；仅用于展示，不承载身份。 */
export function validateNickname(value: string): FieldValidation {
  const result = nicknameSchema.safeParse(value);
  if (result.success) return null;
  return issueText(result.error, { empty: "昵称不能为空", tooLong: "昵称不能超过 24 个字符" });
}

/** 队伍名（填写/修改输入）：trim 后 1 到 32 码点，不允许为空。 */
export function validateTeamName(value: string): FieldValidation {
  const result = teamNameInputSchema.safeParse(value);
  if (result.success) return null;
  return issueText(result.error, { empty: "队伍名不能为空", tooLong: "队伍名不能超过 32 个字符" });
}
