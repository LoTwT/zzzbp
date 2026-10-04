import type { RoomOperationErrorCode } from "../../shared/commands";

/**
 * 房间命令与连接错误的用户可见文案。
 *
 * 稳定错误码由共享合同维护（shared/commands.ts）；这里只负责把它们翻译
 * 成简短中文提示。客户端特有的伪错误码（CONNECTION_LOST /
 * UNKNOWN_OUTCOME）表达本地连接层结论，不会出现在服务端回执中。
 */

/** 客户端本地结论码：命令未送达或连接已断开。 */
export const CONNECTION_LOST = "CONNECTION_LOST" as const;

/** 客户端本地结论码：断线期间结果未知，已按最新视图核对仍未确认生效。 */
export const UNKNOWN_OUTCOME = "UNKNOWN_OUTCOME" as const;

/** 客户端可见错误码：服务端稳定码 + 两个本地结论码。 */
export type RoomClientErrorCode =
  | RoomOperationErrorCode
  | typeof CONNECTION_LOST
  | typeof UNKNOWN_OUTCOME;

const ERROR_TEXTS: Readonly<Record<RoomClientErrorCode, string>> = {
  ACTOR_NOT_MEMBER: "身份已失效，请重新进入房间",
  ACTOR_OFFLINE: "连接状态异常，请稍后重试",
  MEMBER_NOT_FOUND: "目标成员不在本房间",
  ROOM_ARCHIVED: "房间已归档，无法继续操作",
  NOT_HOST: "仅房主可执行该操作",
  NOT_CURRENT_PLAYER: "当前不是你的操作回合",
  STALE_BP_VERSION: "页面状态已更新，请按最新状态重试",
  STALE_REVISION: "页面状态已更新，请重试",
  BP_NOT_WAITING: "当前状态不允许该操作",
  BP_NOT_RUNNING: "BP 未在进行中",
  BP_NOT_PAUSED: "BP 未处于暂停状态",
  START_CONDITIONS_UNMET: "开局条件未满足",
  SEAT_CHANGE_FORBIDDEN: "仅待开始或已暂停状态可调整席位",
  SEAT_TARGET_NOT_MEMBER: "目标成员不在本房间",
  SEAT_TARGET_OFFLINE: "该成员当前离线，不能上席",
  SEAT_TARGET_ALREADY_SEATED: "该成员已占据另一方席位",
  PRESELECT_SLOT_MISMATCH: "操作位已推进，请按最新状态重试",
  AGENT_NOT_IN_CATALOG: "该代理人不在本场名单",
  AGENT_UNAVAILABLE: "该代理人已被禁用或选用",
  NO_PRESELECT: "尚无预选，无法提交",
  NOTHING_TO_UNDO: "本局尚无可撤回的提交",
  OPERATION_ID_CONFLICT: "操作标识冲突，请重试",
  RULE_VERSION_UNSUPPORTED: "房间规则版本不受当前版本支持",
  INTERNAL: "服务器处理失败，请重试",
  [CONNECTION_LOST]: "连接中断，操作未完成",
  [UNKNOWN_OUTCOME]: "连接中断，结果未知；已同步最新状态，请按当前界面操作",
};

/** 错误码 → 中文提示；未知码回退到通用文案，避免把原始 message 直接透给界面。 */
export function roomClientErrorText(code: RoomClientErrorCode): string {
  return ERROR_TEXTS[code] ?? "操作失败，请重试";
}
