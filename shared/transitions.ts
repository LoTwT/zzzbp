import { computeAgentPoolUsage, getAgentPoolStatus, type AgentCatalog } from "./bp/agents";
import { BP_STEP_COUNT, currentBpStep } from "./bp/steps";
import type { BpProgress, BpSubmission } from "./bp/state";
import type {
  AssignSeatCommand,
  ClearPreselectCommand,
  ConfirmPreselectCommand,
  PauseBpCommand,
  RestartBpCommand,
  ResumeBpCommand,
  RoomCommand,
  RoomOperationErrorCode,
  RoomOperationResult,
  SetPreselectCommand,
  SetTeamNameCommand,
  StartBpCommand,
  UndoBpStepCommand,
} from "./commands";
import type { MemberId } from "./ids";
import type { RoomMember, RoomState, SeatAssignment, TeamNames } from "./room";

/**
 * 可信操作者：由服务端凭据解析出的成员身份。
 *
 * 角色、席位与在线状态一律从房间状态派生；客户端载荷不得自报，
 * 也不得通过 targetMemberId 等参数获得操作身份。
 */
export interface RoomActor {
  readonly memberId: MemberId;
}

/**
 * 纯函数状态转换层：统一命令入口与成员在线状态系统入口。
 *
 * 约定：
 * - 输入状态视为已通过 roomStateSchema 校验的可信快照，不做重复解析；
 * - 产生可见变更的成功路径返回新对象，空操作返回原状态引用；
 *   输入状态（含失败路径）从不被就地修改；
 * - 检查顺序固定：操作者身份 → live 生命周期 → 操作者在线 → 权限 →
 *   命令前提 → 版本门 → 生效；错误码稳定；
 * - 有效但不产生可见变化的命令（如重复任命同一席位、设置相同预选）
 *   视为成功的空操作，不推进任何版本；
 * - bp.version 只随预选、提交、控制命令与席位权限变化递增；公开
 *   revision 随一切可见状态变化递增；失败不改变任何版本。
 * - operationId 本轮不做持久化去重，重复提交由版本门与状态检查拒绝。
 * - 代理人名单校验以传入的 catalog 为准：预选与确认两个入口都会核对，
 *   schema 只能保证结构合法，无法保证名单成员资格（状态恢复或名单
 *   适配都可能产生越界值）。
 */

function err(code: RoomOperationErrorCode, message: string): RoomOperationResult {
  return { ok: false, error: { code, message } };
}

function ok(state: RoomState): RoomOperationResult {
  return { ok: true, state };
}

function findMember(state: RoomState, memberId: MemberId): RoomMember | undefined {
  return state.members.find((member) => member.memberId === memberId);
}

/** 房主命令的统一权限检查。 */
function requireHost(state: RoomState, actor: RoomActor): RoomOperationResult | null {
  if (actor.memberId !== state.hostMemberId) {
    return err("NOT_HOST", "该命令仅房主可执行");
  }
  return null;
}

/** 选手命令的统一权限检查：操作者须是当前操作位所属阵营的在席成员。 */
function requireCurrentPlayer(state: RoomState, actor: RoomActor): RoomOperationResult | null {
  const step = currentBpStep(state.bp.submissions.length);
  const seatMemberId = step === null ? null : state.seats[step.team];
  if (seatMemberId === null || seatMemberId !== actor.memberId) {
    return err("NOT_CURRENT_PLAYER", "仅当前操作位所属阵营的在席选手可执行该命令");
  }
  return null;
}

/** 版本门：命令所依据的 BP 版本必须与当前一致，否则视为过期命令。 */
function requireFreshVersion(state: RoomState, command: RoomCommand): RoomOperationResult | null {
  if (command.expectedBpVersion !== state.bp.version) {
    return err(
      "STALE_BP_VERSION",
      `命令基于 BP 版本 ${command.expectedBpVersion}，当前版本为 ${state.bp.version}`,
    );
  }
  return null;
}

/**
 * 公开 revision 前置条件：用于「产生可见变化但不推进 bp.version」的命令
 * （当前仅 setTeamName）。这类命令的回执被淘汰后，旧重发若只比较载荷值，
 * 可能把后来已确认的值改回旧值；要求命令所依据的 revision 与当前严格
 * 一致，使任何后续可见变化（含后续改名）都让旧载荷过期。
 */
function requireFreshRevision(
  state: RoomState,
  command: SetTeamNameCommand,
): RoomOperationResult | null {
  if (command.expectedRevision !== state.revision) {
    return err(
      "STALE_REVISION",
      `命令基于公开 revision ${command.expectedRevision}，当前 revision 为 ${state.revision}`,
    );
  }
  return null;
}

/**
 * 应用影响 BP 流程或席位权限的变更：bp.version 与公开 revision 同时递增。
 * `bpPatch` 不得携带 version，版本一律由本函数推进。
 */
function applyBpChange(
  state: RoomState,
  bpPatch: Partial<BpProgress>,
  statePatch: Partial<Omit<RoomState, "bp" | "revision">> = {},
): RoomState {
  return {
    ...state,
    ...statePatch,
    revision: state.revision + 1,
    bp: { ...state.bp, ...bpPatch, version: state.bp.version + 1 },
  };
}

/** 应用仅影响公开视图的变更：只递增 revision，不使 BP 命令过期。 */
function applyViewChange(
  state: RoomState,
  statePatch: Partial<Omit<RoomState, "bp" | "revision">>,
): RoomState {
  return { ...state, ...statePatch, revision: state.revision + 1 };
}

/**
 * 统一命令入口。操作者身份由服务端凭据解析；命令已按 roomCommandSchema
 * 解析为可信结构。失败时不产生任何状态或版本变化。
 */
export function applyRoomCommand(
  state: RoomState,
  actor: RoomActor,
  command: RoomCommand,
  catalog: AgentCatalog,
): RoomOperationResult {
  const actorMember = findMember(state, actor.memberId);
  if (!actorMember) {
    return err("ACTOR_NOT_MEMBER", `操作者 ${actor.memberId} 不是本房间成员`);
  }
  if (state.lifecycle !== "live") {
    return err("ROOM_ARCHIVED", "房间已归档，拒绝一切写操作");
  }
  if (!actorMember.online) {
    return err("ACTOR_OFFLINE", `操作者 ${actorMember.nickname}（${actor.memberId}）当前离线`);
  }

  switch (command.type) {
    case "setTeamName":
      return applySetTeamName(state, actor, command);
    case "assignSeat":
      return applyAssignSeat(state, actor, command);
    case "startBp":
      return applyStartBp(state, actor, command);
    case "pauseBp":
      return applyPauseBp(state, actor, command);
    case "resumeBp":
      return applyResumeBp(state, actor, command);
    case "undoBpStep":
      return applyUndoBpStep(state, actor, command);
    case "restartBp":
      return applyRestartBp(state, actor, command);
    case "setPreselect":
      return applySetPreselect(state, actor, command, catalog);
    case "clearPreselect":
      return applyClearPreselect(state, actor, command);
    case "confirmPreselect":
      return applyConfirmPreselect(state, actor, command, catalog);
    default: {
      // 穷尽性保护：schema 新增命令而引擎未实现时在编译期暴露。
      const unhandled: never = command;
      throw new Error(`未实现的命令类型：${unhandled}`);
    }
  }
}

/** 修改队伍名：仅影响公开视图，不使 BP 命令过期；以公开 revision 为过期前置条件。 */
function applySetTeamName(
  state: RoomState,
  actor: RoomActor,
  command: SetTeamNameCommand,
): RoomOperationResult {
  const denied = requireHost(state, actor);
  if (denied) return denied;
  const deniedVersion = requireFreshVersion(state, command);
  if (deniedVersion) return deniedVersion;
  const deniedRevision = requireFreshRevision(state, command);
  if (deniedRevision) return deniedRevision;

  if (state.teamNames[command.team] === command.teamName) {
    // 与当前存储值一致：无可见变化，不推进任何版本。
    return ok(state);
  }
  const teamNames: TeamNames =
    command.team === "A"
      ? { ...state.teamNames, A: command.teamName }
      : { ...state.teamNames, B: command.teamName };
  return ok(applyViewChange(state, { teamNames }));
}

/** 分配或替换席位：待开始与已暂停可执行；席位权限变化使旧 BP 命令过期。 */
function applyAssignSeat(
  state: RoomState,
  actor: RoomActor,
  command: AssignSeatCommand,
): RoomOperationResult {
  const denied = requireHost(state, actor);
  if (denied) return denied;
  if (state.bp.status !== "waiting" && state.bp.status !== "paused") {
    return err(
      "SEAT_CHANGE_FORBIDDEN",
      `仅待开始或已暂停状态可调整席位，当前 BP 状态为 ${state.bp.status}`,
    );
  }
  const targetMember = findMember(state, command.targetMemberId);
  if (!targetMember) {
    return err("SEAT_TARGET_NOT_MEMBER", `成员 ${command.targetMemberId} 不在本房间`);
  }
  if (!targetMember.online) {
    return err(
      "SEAT_TARGET_OFFLINE",
      `成员 ${targetMember.nickname}（${command.targetMemberId}）当前离线，不能上席`,
    );
  }
  const otherTeam = command.team === "A" ? "B" : "A";
  if (state.seats[otherTeam] === command.targetMemberId) {
    return err(
      "SEAT_TARGET_ALREADY_SEATED",
      `成员 ${command.targetMemberId} 已占据 ${otherTeam} 方席位，同一成员最多占一个席位`,
    );
  }
  const deniedVersion = requireFreshVersion(state, command);
  if (deniedVersion) return deniedVersion;

  if (state.seats[command.team] === command.targetMemberId) {
    // 目标已是该席现任选手：成功的空操作，不改变状态与版本。
    return ok(state);
  }
  const seats: SeatAssignment =
    command.team === "A"
      ? { ...state.seats, A: command.targetMemberId }
      : { ...state.seats, B: command.targetMemberId };
  // 席位变更不影响 BP 进度本身，但席位权限变化使旧命令失效：version 一并递增。
  return ok(applyBpChange(state, {}, { seats }));
}

/** 开始 BP：要求双方队名已填写、两个不同且在线的成员占席。 */
function applyStartBp(
  state: RoomState,
  actor: RoomActor,
  command: StartBpCommand,
): RoomOperationResult {
  const denied = requireHost(state, actor);
  if (denied) return denied;
  if (state.bp.status !== "waiting") {
    return err("BP_NOT_WAITING", `仅待开始状态可开始 BP，当前为 ${state.bp.status}`);
  }
  const unmet: string[] = [];
  if (state.teamNames.A === "") unmet.push("A 方队伍名未填写");
  if (state.teamNames.B === "") unmet.push("B 方队伍名未填写");
  if (state.seats.A === null) unmet.push("A 方席位无选手");
  if (state.seats.B === null) unmet.push("B 方席位无选手");
  if (state.seats.A !== null && findMember(state, state.seats.A)?.online !== true) {
    unmet.push("A 方选手不在线");
  }
  if (state.seats.B !== null && findMember(state, state.seats.B)?.online !== true) {
    unmet.push("B 方选手不在线");
  }
  if (unmet.length > 0) {
    return err("START_CONDITIONS_UNMET", `开局条件未满足：${unmet.join("；")}`);
  }
  const deniedVersion = requireFreshVersion(state, command);
  if (deniedVersion) return deniedVersion;
  return ok(applyBpChange(state, { status: "running" }));
}

/** 主动暂停：已有预选保留，暂停期间禁止一切预选变更与提交。 */
function applyPauseBp(
  state: RoomState,
  actor: RoomActor,
  command: PauseBpCommand,
): RoomOperationResult {
  const denied = requireHost(state, actor);
  if (denied) return denied;
  if (state.bp.status !== "running") {
    return err("BP_NOT_RUNNING", `仅进行中状态可暂停，当前为 ${state.bp.status}`);
  }
  const deniedVersion = requireFreshVersion(state, command);
  if (deniedVersion) return deniedVersion;
  return ok(applyBpChange(state, { status: "paused" }));
}

/** 手动继续：不要求当前操作方在线，但离线方不能预选或提交。 */
function applyResumeBp(
  state: RoomState,
  actor: RoomActor,
  command: ResumeBpCommand,
): RoomOperationResult {
  const denied = requireHost(state, actor);
  if (denied) return denied;
  if (state.bp.status !== "paused") {
    return err("BP_NOT_PAUSED", `仅已暂停状态可继续，当前为 ${state.bp.status}`);
  }
  const deniedVersion = requireFreshVersion(state, command);
  if (deniedVersion) return deniedVersion;
  return ok(applyBpChange(state, { status: "running" }));
}

/** 撤回最近一条有效提交：释放代理人；操作位回退须清除旧位预选。 */
function applyUndoBpStep(
  state: RoomState,
  actor: RoomActor,
  command: UndoBpStepCommand,
): RoomOperationResult {
  const denied = requireHost(state, actor);
  if (denied) return denied;
  if (state.bp.submissions.length === 0) {
    return err("NOTHING_TO_UNDO", "本局尚无有效提交，无可撤回");
  }
  const deniedVersion = requireFreshVersion(state, command);
  if (deniedVersion) return deniedVersion;
  // 完成状态撤回后转暂停；其余状态保持原状。
  const status = state.bp.status === "completed" ? "paused" : state.bp.status;
  return ok(
    applyBpChange(state, {
      submissions: state.bp.submissions.slice(0, -1),
      preselect: null,
      status,
    }),
  );
}

/** 重开本局：清空序列与预选回到待开始；保留房间配置；版本不重置。 */
function applyRestartBp(
  state: RoomState,
  actor: RoomActor,
  command: RestartBpCommand,
): RoomOperationResult {
  const denied = requireHost(state, actor);
  if (denied) return denied;
  const deniedVersion = requireFreshVersion(state, command);
  if (deniedVersion) return deniedVersion;
  if (state.bp.status === "waiting") {
    // 待开始状态无可清空内容：成功的空操作。
    return ok(state);
  }
  return ok(applyBpChange(state, { status: "waiting", submissions: [], preselect: null }));
}

/** 设置或更换预选：名单外或已禁用/已选用的代理人拒绝。 */
function applySetPreselect(
  state: RoomState,
  actor: RoomActor,
  command: SetPreselectCommand,
  catalog: AgentCatalog,
): RoomOperationResult {
  const denied = requireCurrentPlayer(state, actor);
  if (denied) return denied;
  if (state.bp.status !== "running") {
    return err("BP_NOT_RUNNING", `该命令仅在进行中可用，当前 BP 状态为 ${state.bp.status}`);
  }
  const step = currentBpStep(state.bp.submissions.length);
  if (step === null || step.slotId !== command.slotId) {
    return err("PRESELECT_SLOT_MISMATCH", `命令目标操作位 ${command.slotId} 不是当前操作位`);
  }
  if (!catalog.agentIds.includes(command.agentId)) {
    return err("AGENT_NOT_IN_CATALOG", `代理人 ${command.agentId} 不在本场名单`);
  }
  const usage = computeAgentPoolUsage(state.bp.submissions);
  if (getAgentPoolStatus(usage, command.agentId) !== "available") {
    return err("AGENT_UNAVAILABLE", `代理人 ${command.agentId} 已被禁用或选用`);
  }
  const deniedVersion = requireFreshVersion(state, command);
  if (deniedVersion) return deniedVersion;

  if (state.bp.preselect === command.agentId) {
    // 与当前预选一致：无可见变化，不推进任何版本。
    return ok(state);
  }
  return ok(applyBpChange(state, { preselect: command.agentId }));
}

/** 清空当前操作位的预选。 */
function applyClearPreselect(
  state: RoomState,
  actor: RoomActor,
  command: ClearPreselectCommand,
): RoomOperationResult {
  const denied = requireCurrentPlayer(state, actor);
  if (denied) return denied;
  if (state.bp.status !== "running") {
    return err("BP_NOT_RUNNING", `该命令仅在进行中可用，当前 BP 状态为 ${state.bp.status}`);
  }
  const step = currentBpStep(state.bp.submissions.length);
  if (step === null || step.slotId !== command.slotId) {
    return err("PRESELECT_SLOT_MISMATCH", `命令目标操作位 ${command.slotId} 不是当前操作位`);
  }
  const deniedVersion = requireFreshVersion(state, command);
  if (deniedVersion) return deniedVersion;

  if (state.bp.preselect === null) {
    // 当前无预选：成功的空操作。
    return ok(state);
  }
  return ok(applyBpChange(state, { preselect: null }));
}

/** 确认当前预选：逐位推进；最后一个位置 AP9 提交后立即完成。 */
function applyConfirmPreselect(
  state: RoomState,
  actor: RoomActor,
  command: ConfirmPreselectCommand,
  catalog: AgentCatalog,
): RoomOperationResult {
  const denied = requireCurrentPlayer(state, actor);
  if (denied) return denied;
  if (state.bp.status !== "running") {
    return err("BP_NOT_RUNNING", `该命令仅在进行中可用，当前 BP 状态为 ${state.bp.status}`);
  }
  const step = currentBpStep(state.bp.submissions.length);
  if (step === null || step.slotId !== command.slotId) {
    return err("PRESELECT_SLOT_MISMATCH", `命令目标操作位 ${command.slotId} 不是当前操作位`);
  }
  if (state.bp.preselect === null) {
    return err("NO_PRESELECT", "当前操作位尚无预选，无法提交");
  }
  // 防御性复核：预选设置时已校验，但 schema 无法校验名单成员资格，
  // 状态恢复或名单适配可能带来越界值；确认前再次核对当前预选仍在
  // 本场名单内且在当前有效序列下仍可用。
  if (!catalog.agentIds.includes(state.bp.preselect)) {
    return err("AGENT_NOT_IN_CATALOG", `预选的代理人 ${state.bp.preselect} 不在本场名单`);
  }
  const usage = computeAgentPoolUsage(state.bp.submissions);
  if (getAgentPoolStatus(usage, state.bp.preselect) !== "available") {
    return err("AGENT_UNAVAILABLE", `预选的代理人 ${state.bp.preselect} 已被禁用或选用`);
  }
  const deniedVersion = requireFreshVersion(state, command);
  if (deniedVersion) return deniedVersion;

  const submission: BpSubmission = { slotId: step.slotId, agentId: state.bp.preselect };
  const finished = state.bp.submissions.length + 1 === BP_STEP_COUNT;
  // 操作位推进：清除本位预选。
  return ok(
    applyBpChange(state, {
      status: finished ? "completed" : "running",
      submissions: [...state.bp.submissions, submission],
      preselect: null,
    }),
  );
}

/**
 * 成员在线状态系统入口：接收服务端可信的「该成员实际在线/离线」判定。
 *
 * 这是服务端内部入口，不作为客户端可调用命令暴露；真实的多页面连接
 * 计数由后续 PR 实现。规则：
 * - 进行中，房主或任一在席选手从在线变离线时立即暂停整场 BP；
 * - 普通观众掉线不影响 BP；上线一律不自动恢复；
 * - 与当前判定一致的重复输入视为空操作。
 */
export function setMemberOnline(
  state: RoomState,
  memberId: MemberId,
  online: boolean,
): RoomOperationResult {
  const member = findMember(state, memberId);
  if (!member) {
    return err("MEMBER_NOT_FOUND", `成员 ${memberId} 不在本房间`);
  }
  if (state.lifecycle !== "live") {
    return err("ROOM_ARCHIVED", "房间已归档，拒绝一切写操作");
  }
  if (member.online === online) {
    return ok(state);
  }

  const members = state.members.map((candidate) =>
    candidate.memberId === memberId ? { ...candidate, online } : candidate,
  );
  if (online) {
    // 上线不自动恢复 BP：仅更新公开可见的在线状态。
    return ok(applyViewChange(state, { members }));
  }

  // 下线：进行中且成员是房主或在席选手时立即暂停。
  const isHostOrSeated =
    memberId === state.hostMemberId || state.seats.A === memberId || state.seats.B === memberId;
  if (state.bp.status === "running" && isHostOrSeated) {
    return ok({
      ...state,
      revision: state.revision + 1,
      members,
      bp: { ...state.bp, status: "paused", version: state.bp.version + 1 },
    });
  }
  return ok(applyViewChange(state, { members }));
}
