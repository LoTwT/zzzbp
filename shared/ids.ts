import { z } from "zod";

/**
 * 机器生成标识符的通用约束。
 *
 * 房间与成员 ID 由服务端生成，代理人 ID 来自后续数据包接入；
 * 这里只做防御性约束，具体格式由各自的生成方决定：
 * trim 后非空，且不超过 100 个 Unicode 码点（Zod 4 的长度检查
 * 按码点而非 UTF-16 单元计数）。
 */
const machineIdSchema = z.string().trim().min(1).max(100);

/** 代理人 ID，指向本场名单中的唯一代理人。 */
export const agentIdSchema = machineIdSchema;
export type AgentId = z.infer<typeof agentIdSchema>;

/** 成员 ID：服务端生成的入房身份标识；昵称仅用于展示，不承载身份。 */
export const memberIdSchema = machineIdSchema;
export type MemberId = z.infer<typeof memberIdSchema>;

/** 房间 ID：出现在房间链接中的房间唯一标识。 */
export const roomIdSchema = machineIdSchema;
export type RoomId = z.infer<typeof roomIdSchema>;
