import { expect, test } from "vitest";
import {
  ROOM_HISTORY_VERSION,
  createRoomHistory,
  roomHistoryKey,
  type RoomHistoryStorage,
} from "../../src/room/room-history";

// 首页「最近参与」本机清单的存储层回归：记录与去重排序、每房间独立键的
// 多标签页合并、移除后的迟到写入、存储不可用/配额/损坏记录的降级，以及
// 「只清空本功能数据」的删除边界（docs/specs/room-roles.md「本机参与记录」）。

/** 可注入的假存储：支持读取/写入失败注入，并保留其他应用的键。 */
class FakeStorage implements RoomHistoryStorage {
  private readonly values = new Map<string, string>();
  failRead = false;
  failWrite: "quota" | "failed" | null = null;

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    if (this.failRead) throw new Error("storage disabled");
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    if (this.failRead) throw new Error("storage disabled");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrite !== null) {
      const error = new Error("write rejected") as Error & { name: string };
      error.name = this.failWrite === "quota" ? "QuotaExceededError" : "UnknownError";
      throw error;
    }
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }
}

function storedEntry(roomId: string, roomName: string, lastVisitedAt: string): string {
  return JSON.stringify({
    version: ROOM_HISTORY_VERSION,
    roomId,
    roomName,
    lastVisitedAt,
  });
}

test("同一房间重复参与只保留一条记录，并按最近参与时间倒序", () => {
  const storage = new FakeStorage();
  let clock = Date.parse("2026-10-07T02:00:00.000Z");
  const history = createRoomHistory({ storage, now: () => new Date(clock) });

  expect(history.commit(history.begin("room-a"), { roomName: "赛事甲" })).toEqual({ ok: true });
  clock += 60_000;
  expect(history.commit(history.begin("room-b"), { roomName: "赛事乙" })).toEqual({ ok: true });
  clock += 60_000;
  expect(history.commit(history.begin("room-a"), { roomName: "赛事甲" })).toEqual({ ok: true });

  const list = history.list();
  expect(list.storageAvailable).toBe(true);
  expect(list.entries.map((entry) => entry.roomId)).toEqual(["room-a", "room-b"]);
  expect(list.entries[0]).toEqual({
    roomId: "room-a",
    roomName: "赛事甲",
    lastVisitedAt: new Date(clock).toISOString(),
  });
  // 每房间一条独立键：重复参与不新增第二条记录。
  expect(storage.has(roomHistoryKey("room-a"))).toBe(true);
});

test("每房间独立键：其他标签页的写入不会被旧列表整体覆盖，移除也只影响本房间", () => {
  const storage = new FakeStorage();
  const tabA = createRoomHistory({ storage, now: () => new Date("2026-10-07T01:00:00.000Z") });
  const tabB = createRoomHistory({ storage, now: () => new Date("2026-10-07T02:00:00.000Z") });

  tabA.commit(tabA.begin("room-a"), { roomName: "甲" });
  // 另一个标签页（可能持有更旧的列表视图）记录自己的房间：不能丢掉 room-a。
  tabB.commit(tabB.begin("room-b"), { roomName: "乙" });
  expect(tabA.list().entries.map((entry) => entry.roomId)).toEqual(["room-b", "room-a"]);

  tabB.remove("room-b");
  expect(tabA.list().entries.map((entry) => entry.roomId)).toEqual(["room-a"]);
});

test("记录被移除后，延迟到达的写入被放弃；再次主动参与可以重新记录", () => {
  const storage = new FakeStorage();
  const history = createRoomHistory({ storage });

  const delayed = history.begin("room-a");
  history.remove("room-a");
  expect(history.commit(delayed, { roomName: "甲" })).toEqual({ ok: false, reason: "stale" });
  expect(history.list().entries).toEqual([]);
  expect(history.takeWriteFailure()).toBeNull();

  // 再次主动进入房间：新的写入正常记录。
  expect(history.commit(history.begin("room-a"), { roomName: "甲" })).toEqual({ ok: true });
  expect(history.list().entries.map((entry) => entry.roomId)).toEqual(["room-a"]);
});

test("清空历史后，所有在先的未提交写入都被放弃", () => {
  const storage = new FakeStorage();
  const history = createRoomHistory({ storage });
  history.commit(history.begin("room-old"), { roomName: "旧" });

  const delayed = history.begin("room-new");
  expect(history.clear()).toEqual({ ok: true });
  expect(history.commit(delayed, { roomName: "新" })).toEqual({ ok: false, reason: "stale" });
  expect(history.list().entries).toEqual([]);
});

test("其他标签页的移除与清空经 storage 事件作废本页在途写入", () => {
  const storage = new FakeStorage();
  const history = createRoomHistory({ storage });

  const removedElsewhere = history.begin("room-a");
  const clearedElsewhere = history.begin("room-b");
  history.handleExternalChange({ key: roomHistoryKey("room-a"), newValue: null });
  history.handleExternalChange({ key: null, newValue: null });
  expect(history.commit(removedElsewhere, { roomName: "甲" })).toEqual({
    ok: false,
    reason: "stale",
  });
  expect(history.commit(clearedElsewhere, { roomName: "乙" })).toEqual({
    ok: false,
    reason: "stale",
  });

  // 其他标签页新增或更新记录是正常参与，不作废本页写入。
  const kept = history.begin("room-c");
  history.handleExternalChange({
    key: roomHistoryKey("room-c"),
    newValue: storedEntry("room-c", "丙", "2026-10-07T05:00:00.000Z"),
  });
  expect(history.commit(kept, { roomName: "丙" })).toEqual({ ok: true });
});

test("存储不可用时读取与写入都降级，不抛出异常也不阻断其他功能", () => {
  const history = createRoomHistory({ storage: null });
  expect(history.list()).toEqual({ entries: [], storageAvailable: false });
  expect(history.commit(history.begin("room-a"), { roomName: "甲" })).toEqual({
    ok: false,
    reason: "unavailable",
  });
  expect(history.remove("room-a")).toEqual({ ok: false, reason: "unavailable" });
  expect(history.clear()).toEqual({ ok: false, reason: "unavailable" });
  expect(history.takeWriteFailure()).toBe("unavailable");
  expect(history.takeWriteFailure()).toBeNull();
});

test("读取端点失败按存储不可用降级", () => {
  const storage = new FakeStorage();
  const history = createRoomHistory({ storage });
  history.commit(history.begin("room-a"), { roomName: "甲" });

  storage.failRead = true;
  expect(history.list()).toEqual({ entries: [], storageAvailable: false });
});

test("配额不足与其他写入失败分别提示，且不承诺已保存", () => {
  const storage = new FakeStorage();
  const history = createRoomHistory({ storage, now: () => new Date("2026-10-07T02:00:00.000Z") });

  storage.failWrite = "quota";
  expect(history.commit(history.begin("room-a"), { roomName: "甲" })).toEqual({
    ok: false,
    reason: "quota",
  });
  expect(history.takeWriteFailure()).toBe("quota");
  expect(history.list().entries).toEqual([]);

  storage.failWrite = "failed";
  expect(history.commit(history.begin("room-a"), { roomName: "甲" })).toEqual({
    ok: false,
    reason: "failed",
  });
  expect(history.takeWriteFailure()).toBe("failed");
});

test("个别记录损坏（非法 JSON、版本不符、键与载荷不一致）只跳过该条", () => {
  const storage = new FakeStorage({
    [roomHistoryKey("room-broken")]: "{ not json",
    [roomHistoryKey("room-version")]: JSON.stringify({
      version: ROOM_HISTORY_VERSION + 1,
      roomId: "room-version",
      roomName: "旧版",
      lastVisitedAt: "2026-10-07T01:00:00.000Z",
    }),
    [roomHistoryKey("room-mismatch")]: storedEntry(
      "room-other",
      "错位",
      "2026-10-07T02:00:00.000Z",
    ),
    [roomHistoryKey("room-ok")]: storedEntry("room-ok", "正常", "2026-10-07T03:00:00.000Z"),
  });
  const history = createRoomHistory({ storage });

  expect(history.list()).toEqual({
    entries: [{ roomId: "room-ok", roomName: "正常", lastVisitedAt: "2026-10-07T03:00:00.000Z" }],
    storageAvailable: true,
  });
});

test("清空历史只删除本功能自己的键，其他存储与站点数据不受影响", () => {
  const storage = new FakeStorage({
    "other-app:preference": "保留",
    zzzbp_room_room_a: "身份 Cookie 由浏览器管理，localStorage 里的其他键同样保留",
    [roomHistoryKey("room-a")]: storedEntry("room-a", "甲", "2026-10-07T02:00:00.000Z"),
  });
  const history = createRoomHistory({ storage });

  expect(history.clear()).toEqual({ ok: true });
  expect(storage.has("other-app:preference")).toBe(true);
  expect(storage.has("zzzbp_room_room_a")).toBe(true);
  expect(storage.has(roomHistoryKey("room-a"))).toBe(false);
  expect(history.list().entries).toEqual([]);
});

test("不符合共享 schema 的载荷不写入（防御损坏数据）", () => {
  const storage = new FakeStorage();
  const history = createRoomHistory({ storage });

  expect(history.commit(history.begin("room-a"), { roomName: "   " })).toEqual({
    ok: false,
    reason: "failed",
  });
  expect(history.list().entries).toEqual([]);
});

test("写入失败提示在同标签页整页刷新后仍可见，取出即清除", () => {
  const storage = new FakeStorage();
  const session = new FakeStorage();
  storage.failWrite = "quota";
  const beforeReload = createRoomHistory({
    storage,
    sessionStorage: session,
    now: () => new Date("2026-10-07T02:00:00.000Z"),
  });
  expect(beforeReload.commit(beforeReload.begin("room-a"), { roomName: "甲" })).toEqual({
    ok: false,
    reason: "quota",
  });

  // 模拟整页刷新：新实例只共享持久化的会话标记，内存提示已随页面消失。
  const afterReload = createRoomHistory({ storage, sessionStorage: session });
  expect(afterReload.takeWriteFailure()).toBe("quota");
  expect(afterReload.takeWriteFailure()).toBeNull();
  // 提示只影响本功能：清单仍为空，也不写入 localStorage 的清单键空间。
  expect(afterReload.list().entries).toEqual([]);
  expect(storage.has(roomHistoryKey("room-a"))).toBe(false);
});

test("写入恢复后清除失败提示；会话存储不可用时只保留内存提示", () => {
  const storage = new FakeStorage();
  const session = new FakeStorage();
  storage.failWrite = "quota";
  const history = createRoomHistory({ storage, sessionStorage: session });
  history.commit(history.begin("room-a"), { roomName: "甲" });
  storage.failWrite = null;
  expect(history.commit(history.begin("room-a"), { roomName: "甲" })).toEqual({ ok: true });
  expect(createRoomHistory({ storage, sessionStorage: session }).takeWriteFailure()).toBeNull();

  const noSession = createRoomHistory({
    storage,
    sessionStorage: null,
    now: () => new Date("2026-10-07T02:00:00.000Z"),
  });
  storage.failWrite = "failed";
  expect(noSession.commit(noSession.begin("room-a"), { roomName: "甲" })).toEqual({
    ok: false,
    reason: "failed",
  });
  expect(noSession.takeWriteFailure()).toBe("failed");
  expect(noSession.takeWriteFailure()).toBeNull();
});
