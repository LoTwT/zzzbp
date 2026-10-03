import { z } from "zod";

/**
 * 版本信息合同：公开视图与归档记录随附，用于客户端解释 BP 结果，
 * 并防止后续规则或数据更新把旧记录解释成另一场结果。
 *
 * 实际取值由服务端在运行时固定：规则版本来自部署的代码版本，
 * 代理人数据版本来自构建时接入的数据包。
 */

/** 规则版本：标识当前部署的 BP 规则实现。 */
export const ruleVersionSchema = z.string().trim().min(1).max(50);
export type RuleVersion = z.infer<typeof ruleVersionSchema>;

/** 代理人数据版本：标识构建时接入的数据包版本。 */
export const agentDataVersionSchema = z.string().trim().min(1).max(50);
export type AgentDataVersion = z.infer<typeof agentDataVersionSchema>;

/** 视图与归档记录随附的版本信息。 */
export const versionInfoSchema = z.object({
  ruleVersion: ruleVersionSchema,
  agentDataVersion: agentDataVersionSchema,
});
export type VersionInfo = z.infer<typeof versionInfoSchema>;
