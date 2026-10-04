import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import { credentialDigest } from "../../server/credentials";
import { createRoomResponseSchema, joinRoomResponseSchema } from "../../shared/contracts/http";
import type { MemberServerMessage } from "../../shared/contracts/websocket";
import type { DisplayServerMessage } from "../../shared/contracts/websocket";

/**
 * Workers 集成测试的共享辅助：真实 HTTP 建房/入房、WebSocket 客户端
 * 驱动（fetch 升级 → response.webSocket）与实例内 SQL 观察。
 *
 * WebSocket 客户端模式：Workers 运行时没有浏览器式 new WebSocket(url)，
 * 标准做法是对 Worker 发起带 Upgrade 头的 fetch，从 101 响应的
 * webSocket 字段取得客户端 socket 并 accept()；服务端在升级处理期间
 * 发送的初始视图会被缓冲，accept 后照常送达（已由探针验证）。
 */

const BASE_URL = "http://localhost";

/** 一个成员身份：HTTP 建房/入房返回的凭据与成员 ID。 */
export interface TestMember {
  readonly roomId: string;
  readonly memberId: string;
  readonly nickname: string;
  readonly secret: string;
  /** 该房间的身份 Cookie 头值。 */
  readonly cookie: string;
}

/** 经真实 HTTP 建房；返回房间与房主身份。 */
export async function createRoomViaHttp(
  roomName = "集成赛事",
  nickname = "房主",
): Promise<TestMember> {
  const response = await exports.default.fetch(
    new Request(`${BASE_URL}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomName, nickname }),
    }),
  );
  expect(response.status).toBe(201);
  const body = createRoomResponseSchema.parse(await response.json());
  const secret = (response.headers.get("Set-Cookie") ?? "").split(";")[0]?.split("=")[1] ?? "";
  return {
    roomId: body.roomId,
    memberId: body.memberView.self.memberId,
    nickname,
    secret,
    cookie: `zzzbp_room_${body.roomId}=${secret}`,
  };
}

/** 经真实 HTTP 以新观众身份入房。 */
export async function joinMemberViaHttp(roomId: string, nickname: string): Promise<TestMember> {
  const response = await exports.default.fetch(
    new Request(`${BASE_URL}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname }),
    }),
  );
  expect(response.status).toBe(200);
  const body = joinRoomResponseSchema.parse(await response.json());
  const secret = (response.headers.get("Set-Cookie") ?? "").split(";")[0]?.split("=")[1] ?? "";
  return {
    roomId,
    memberId: body.memberView.self.memberId,
    nickname,
    secret,
    cookie: `zzzbp_room_${roomId}=${secret}`,
  };
}

/** 受控凭据：预生成秘密与摘要，供直接驱动 DO 建房的场景使用。 */
export async function controlledCredential(roomId: string, seed: string) {
  const secret = `${seed}-${crypto.randomUUID()}`;
  return {
    secret,
    digest: await credentialDigest(secret),
    cookie: `zzzbp_room_${roomId}=${secret}`,
  };
}

/** WebSocket 测试客户端：未消费消息队列 + 谓词等待（轮询）+ 关闭事件捕获。 */
export class TestWsClient {
  readonly socket: WebSocket;
  /** 全部历史消息（含已消费），仅用于调试与计数断言。 */
  readonly received: string[] = [];
  /** 尚未被 waitFor 消费的消息。 */
  private readonly unconsumed: string[] = [];
  closeEvent: { code: number; reason: string } | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      this.received.push(event.data);
      this.unconsumed.push(event.data);
    });
    socket.addEventListener("close", (event) => {
      this.closeEvent = { code: event.code, reason: event.reason };
    });
  }

  /** 发起成员通道升级；secret 为 null 表示匿名（预期 AUTH_FAILED）。 */
  static async connectMember(roomId: string, secret: string | null): Promise<TestWsClient> {
    return TestWsClient.upgrade(
      `/api/rooms/${roomId}/ws`,
      secret === null ? {} : { Cookie: `zzzbp_room_${roomId}=${secret}` },
    );
  }

  /** 发起展示通道升级；可携带任意 Cookie（展示永不成为成员）。 */
  static async connectDisplay(roomId: string, cookie?: string): Promise<TestWsClient> {
    return TestWsClient.upgrade(
      `/api/rooms/${roomId}/display/ws`,
      cookie === undefined ? {} : { Cookie: cookie },
    );
  }

  private static async upgrade(
    path: string,
    headers: Record<string, string>,
  ): Promise<TestWsClient> {
    const response = await exports.default.fetch(
      new Request(`${BASE_URL}${path}`, { headers: { Upgrade: "websocket", ...headers } }),
    );
    if (response.status !== 101 || response.webSocket === null) {
      throw new Error(`WebSocket 升级失败：HTTP ${response.status}`);
    }
    const client = new TestWsClient(response.webSocket);
    response.webSocket.accept();
    return client;
  }

  /**
   * 等待并消费下一条满足谓词的未消费消息；谓词也可观察连接状态
   * （如 closeEvent），以轮询方式评估，不依赖新消息触发。
   */
  async waitFor(
    predicate: (message: string | null) => boolean,
    label: string,
    timeoutMs = 3000,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.unconsumed.findIndex((message) => predicate(message));
      if (index >= 0) {
        return this.unconsumed.splice(index, 1)[0] ?? null;
      }
      if (predicate(null)) return null;
      if (Date.now() >= deadline) {
        throw new Error(`等待超时：${label}；已收到 ${this.received.length} 条消息`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** 等待并消费下一条指定 kind 的服务端消息（按合同 schema 解析）。 */
  async next<K extends MemberServerMessage["kind"] | DisplayServerMessage["kind"]>(
    kind: K,
    timeoutMs = 3000,
  ): Promise<Extract<MemberServerMessage | DisplayServerMessage, { kind: K }>> {
    const raw = await this.waitFor(
      (message) => {
        if (message === null) return false;
        try {
          return (JSON.parse(message) as { kind?: unknown }).kind === kind;
        } catch {
          return false;
        }
      },
      `消息 kind=${kind}`,
      timeoutMs,
    );
    if (raw === null) throw new Error(`等待 kind=${kind} 失败`);
    return JSON.parse(raw);
  }

  /** 等待并消费指定 operationId 的命令结果。 */
  async commandResult(operationId: string, timeoutMs = 3000) {
    const raw = await this.waitFor(
      (message) => {
        if (message === null) return false;
        try {
          const parsed = JSON.parse(message) as { kind?: string; operationId?: string };
          return parsed.kind === "commandResult" && parsed.operationId === operationId;
        } catch {
          return false;
        }
      },
      `commandResult(${operationId})`,
      timeoutMs,
    );
    if (raw === null) throw new Error(`等待 commandResult(${operationId}) 失败`);
    return JSON.parse(raw) as {
      kind: "commandResult";
      operationId: string;
      ok: boolean;
      error: { code: string; message: string } | null;
      bpVersion: number;
      revision: number;
    };
  }

  /** 等待服务端关闭连接并返回关闭码；超时抛错。 */
  async waitForClose(label: string, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeEvent === null) {
      if (Date.now() >= deadline) {
        throw new Error(`等待关闭事件超时：${label}；已收到 ${this.received.length} 条消息`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.closeEvent;
  }

  /** 发送 JSON 消息。 */
  send(payload: unknown): void {
    this.socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  close(): void {
    this.socket.close();
  }
}

/** 在房间实例内执行只读 SQL 并返回标量行（观察真实持久存储）。 */
export function queryRoomRows(
  roomId: string,
  query: string,
): Promise<Array<Record<string, string | number | null>>> {
  const stub = exports.Room.get(exports.Room.idFromName(roomId));
  return runInDurableObject(stub, (_room, state) => {
    const rows = state.storage.sql.exec(query).toArray();
    return rows.map((row) => {
      const plain: Record<string, string | number | null> = {};
      for (const column of Object.keys(row)) {
        const value: unknown = row[column];
        if (value === null || typeof value === "string" || typeof value === "number") {
          plain[column] = value;
        } else {
          throw new Error(`测试查询不应返回非标量列：${column}`);
        }
      }
      return plain;
    });
  });
}

/** 在房间实例内执行任意 SQL（故障注入/回执构造）。 */
export function execInRoom(roomId: string, statement: string): Promise<void> {
  const stub = exports.Room.get(exports.Room.idFromName(roomId));
  return runInDurableObject(stub, (_room, state) => {
    state.storage.sql.exec(statement);
  });
}

/** 轮询等待直到 SQL 查询返回期望值；超时返回 false。 */
export async function waitForRoomQuery(
  roomId: string,
  query: string,
  column: string,
  expected: string | number | null,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await queryRoomRows(roomId, query);
    const value = rows[0]?.[column];
    if (value === expected) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 当前房间实例的 alarm 时间；PR9 前任何路径都不应设置。 */
export function currentAlarm(roomId: string): Promise<number | null> {
  const stub = exports.Room.get(exports.Room.idFromName(roomId));
  return runInDurableObject(stub, (_room, state) => state.storage.getAlarm());
}
