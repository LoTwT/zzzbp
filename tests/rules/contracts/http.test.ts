import { describe, expect, it } from "vitest";
import {
  apiErrorResponseBodySchema,
  createRoomRequestSchema,
  createRoomResponseSchema,
  displayWebSocketPath,
  joinRoomRequestSchema,
  joinRoomResponseSchema,
  memberWebSocketPath,
  roomEntryResponseSchema,
} from "../../../shared/contracts/http";
import { projectArchiveSnapshot } from "../../../shared/contracts/records";
import type { VersionInfo } from "../../../shared/contracts/versions";
import { projectRoomMemberView } from "../../../shared/contracts/views";
import { AUDIENCE_ID, HOST_ID, PLAYER_A_ID, completedRoom, startedRoom } from "../room-fixture";
import { SYNTHETIC_AGENT_IDS } from "../spec-bp-order";
import type { AgentDisplayLookup } from "../../../shared/contracts/records";

const versions: VersionInfo = { ruleVersion: "rules-test", agentDataVersion: "agents-test" };

/** 全量合成代理人的展示信息表。 */
const agentDisplay: AgentDisplayLookup = new Map(
  SYNTHETIC_AGENT_IDS.map((agentId): [string, { name: string; avatarUrl: string | null }] => [
    agentId,
    { name: `代理人 ${agentId}`, avatarUrl: `/avatars/${agentId}.png` },
  ]),
);

describe("HTTP 合同", () => {
  it("建房请求：房间名与昵称必填、trim、长度约束", () => {
    expect(createRoomRequestSchema.parse({ roomName: " 拓金杯 ", nickname: " 小鱼 " })).toEqual({
      roomName: "拓金杯",
      nickname: "小鱼",
    });
    for (const invalid of [
      { roomName: "", nickname: "小鱼" },
      { roomName: "   ", nickname: "小鱼" },
      { roomName: "拓金杯", nickname: "" },
      { roomName: "拓金杯", nickname: "  " },
      { roomName: "a".repeat(81), nickname: "小鱼" },
      { roomName: "拓金杯", nickname: "鱼".repeat(25) },
      { roomName: "拓金杯" },
    ]) {
      expect(createRoomRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("建房响应：房间 ID 与创建者（房主）的成员视图", () => {
    const state = startedRoom();
    const memberView = projectRoomMemberView(state, HOST_ID, versions);
    if (memberView === null) throw new Error("房主应是房间成员");
    const response = createRoomResponseSchema.parse({ roomId: state.roomId, memberView });
    expect(response.roomId).toBe("room-fixture");
    expect(response.memberView.self.isHost).toBe(true);
    // 响应不含任何凭据字段
    expect(JSON.stringify(response).includes("credential")).toBe(false);
  });

  it("GET 房间：live 匿名、live 已有身份与 archived 三种分流", () => {
    const state = startedRoom();
    // 匿名访客：只有房名，进入首次入房表单
    expect(
      roomEntryResponseSchema.parse({ kind: "live", roomName: state.name, memberView: null }),
    ).toEqual({ kind: "live", roomName: "夹具房间", memberView: null });
    // 携带有效身份：直接恢复成员视图
    const memberView = projectRoomMemberView(state, PLAYER_A_ID, versions);
    const live = roomEntryResponseSchema.parse({
      kind: "live",
      roomName: state.name,
      memberView,
    });
    expect(live.kind).toBe("live");
    if (live.kind === "live" && live.memberView) {
      expect(live.memberView.self.memberId).toBe(PLAYER_A_ID);
    }
    // 归档房间：普通 HTTP 返回只读快照
    const archivedAt = "2026-10-05T00:00:00.000Z";
    const record = projectArchiveSnapshot({
      state: completedRoom(),
      agentDisplay,
      versions,
      archivedAt,
    });
    if (record === null) throw new Error("完整对局应生成快照");
    const archived = roomEntryResponseSchema.parse({ kind: "archived", record });
    expect(archived.kind).toBe("archived");
    // 分流之外的结构被拒
    expect(roomEntryResponseSchema.safeParse({ kind: "deleted" }).success).toBe(false);
    expect(roomEntryResponseSchema.safeParse({ kind: "live", memberView: null }).success).toBe(
      false,
    );
  });

  it("入房请求与响应：昵称必填；响应为请求者自身视图", () => {
    expect(joinRoomRequestSchema.parse({ nickname: " 橙子 " })).toEqual({ nickname: "橙子" });
    expect(joinRoomRequestSchema.safeParse({ nickname: " " }).success).toBe(false);
    expect(joinRoomRequestSchema.safeParse({}).success).toBe(false);

    const state = startedRoom();
    const memberView = projectRoomMemberView(state, AUDIENCE_ID, versions);
    if (memberView === null) throw new Error("观众应是房间成员");
    const response = joinRoomResponseSchema.parse({ memberView });
    expect(response.memberView.self.seatTeam).toBeNull();
  });

  it("错误体与 WS 路径", () => {
    expect(
      apiErrorResponseBodySchema.parse({
        error: { code: "ROOM_NOT_FOUND", message: "房间不存在或已过期" },
      }),
    ).toEqual({ error: { code: "ROOM_NOT_FOUND", message: "房间不存在或已过期" } });
    expect(apiErrorResponseBodySchema.safeParse({ error: { code: "NOPE" } }).success).toBe(false);
    expect(memberWebSocketPath("room-1")).toBe("/api/rooms/room-1/ws");
    expect(displayWebSocketPath("room-1")).toBe("/api/rooms/room-1/display/ws");
  });
});
