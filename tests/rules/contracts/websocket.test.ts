import { describe, expect, it } from "vitest";
import {
  commandResultMessageSchema,
  displayServerMessageSchema,
  memberServerMessageSchema,
  webSocketClientMessageSchema,
} from "../../../shared/contracts/websocket";
import type { VersionInfo } from "../../../shared/contracts/versions";
import {
  projectDisplayView,
  projectHostManagementView,
  projectRoomMemberView,
} from "../../../shared/contracts/views";
import { HOST_ID, PLAYER_A_ID, startedRoom } from "../room-fixture";

const versions: VersionInfo = { ruleVersion: "rules-test", agentDataVersion: "agents-test" };

describe("WebSocket 客户端消息", () => {
  it("仅接受业务命令，系统入口不可注入", () => {
    expect(
      webSocketClientMessageSchema.safeParse({
        type: "setPreselect",
        slotId: "AB1",
        agentId: "agent-01",
        operationId: "op-1",
        expectedBpVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      webSocketClientMessageSchema.safeParse({
        type: "pauseBp",
        operationId: "op-2",
        expectedBpVersion: 1,
      }).success,
    ).toBe(true);
    // setMemberOnline 是服务端系统入口，不在客户端联合中
    expect(
      webSocketClientMessageSchema.safeParse({
        type: "setMemberOnline",
        memberId: "member-1",
        online: false,
      }).success,
    ).toBe(false);
    expect(webSocketClientMessageSchema.safeParse({ type: "restartEverything" }).success).toBe(
      false,
    );
  });
});

describe("命令结果消息", () => {
  it("成功结果关联 operationId 与生效后的版本，不携带错误与状态", () => {
    const message = commandResultMessageSchema.parse({
      kind: "commandResult",
      operationId: "op-1",
      ok: true,
      error: null,
      bpVersion: 6,
      revision: 6,
    });
    expect(message).toEqual({
      kind: "commandResult",
      operationId: "op-1",
      ok: true,
      error: null,
      bpVersion: 6,
      revision: 6,
    });
    // 成功携带错误被拒
    expect(
      commandResultMessageSchema.safeParse({
        kind: "commandResult",
        operationId: "op-1",
        ok: true,
        error: { code: "NOT_HOST", message: "x" },
        bpVersion: 6,
        revision: 6,
      }).success,
    ).toBe(false);
    // 缺少关联字段被拒
    expect(
      commandResultMessageSchema.safeParse({ kind: "commandResult", operationId: "op-1", ok: true })
        .success,
    ).toBe(false);
  });

  it("失败结果携带稳定错误码与当前版本", () => {
    const message = commandResultMessageSchema.parse({
      kind: "commandResult",
      operationId: "op-1",
      ok: false,
      error: { code: "STALE_BP_VERSION", message: "命令基于 BP 版本 3，当前版本为 5" },
      bpVersion: 5,
      revision: 5,
    });
    expect(message.error?.code).toBe("STALE_BP_VERSION");
    // 失败缺错误被拒；未知错误码被拒
    expect(
      commandResultMessageSchema.safeParse({
        kind: "commandResult",
        operationId: "op-1",
        ok: false,
        error: null,
        bpVersion: 5,
        revision: 5,
      }).success,
    ).toBe(false);
    expect(
      commandResultMessageSchema.safeParse({
        kind: "commandResult",
        operationId: "op-1",
        ok: false,
        error: { code: "NOT_A_CODE", message: "x" },
        bpVersion: 5,
        revision: 5,
      }).success,
    ).toBe(false);
  });
});

describe("成员通道服务端消息", () => {
  it("按身份推送成员视图或房主管理视图", () => {
    const state = startedRoom();
    const memberView = projectRoomMemberView(state, PLAYER_A_ID, versions);
    if (memberView === null) throw new Error("成员视图不应为空");
    expect(memberServerMessageSchema.parse({ kind: "memberView", view: memberView }).kind).toBe(
      "memberView",
    );
    const hostView = projectHostManagementView(state, HOST_ID, versions);
    if (hostView === null) throw new Error("房主视图不应为空");
    expect(memberServerMessageSchema.parse({ kind: "hostView", view: hostView }).kind).toBe(
      "hostView",
    );
  });

  it("接受命令结果与连接通知，拒绝展示视图", () => {
    expect(
      memberServerMessageSchema.safeParse({
        kind: "commandResult",
        operationId: "op-1",
        ok: false,
        error: { code: "ROOM_ARCHIVED", message: "已归档" },
        bpVersion: 1,
        revision: 1,
      }).success,
    ).toBe(true);
    expect(
      memberServerMessageSchema.safeParse({
        kind: "notice",
        code: "AUTH_FAILED",
        message: "凭据失效",
      }).success,
    ).toBe(true);
    expect(
      memberServerMessageSchema.safeParse({ kind: "notice", code: "NOT_A_CODE", message: "x" })
        .success,
    ).toBe(false);
    // 展示视图只在展示通道下发
    expect(
      memberServerMessageSchema.safeParse({
        kind: "displayView",
        view: projectDisplayView(startedRoom(), versions),
      }).success,
    ).toBe(false);
  });
});

describe("展示通道服务端消息", () => {
  it("只有展示视图与连接通知，没有命令结果或写入口", () => {
    const view = projectDisplayView(startedRoom(), versions);
    expect(displayServerMessageSchema.parse({ kind: "displayView", view }).kind).toBe(
      "displayView",
    );
    expect(
      displayServerMessageSchema.safeParse({ kind: "notice", code: "ROOM_ARCHIVED", message: "x" })
        .success,
    ).toBe(true);
    // 即使展示连接携带房主凭据，通道内也没有命令结果与成员视图
    expect(
      displayServerMessageSchema.safeParse({
        kind: "commandResult",
        operationId: "op-1",
        ok: true,
        error: null,
        bpVersion: 1,
        revision: 1,
      }).success,
    ).toBe(false);
    expect(
      displayServerMessageSchema.safeParse({
        kind: "hostView",
        view: projectHostManagementView(startedRoom(), HOST_ID, versions),
      }).success,
    ).toBe(false);
  });
});
