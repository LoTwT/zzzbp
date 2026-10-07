import { z } from "zod";
import { roomIdSchema } from "../../shared/ids";
import { roomNameSchema } from "../../shared/room";

/**
 * 首页「最近参与」本机清单的存储层。
 *
 * 事实来源：参与记录的时机与边界见 docs/specs/room-roles.md「本机参与记录」，
 * 界面结构与操作见 docs/specs/room-layout.md「首页与首次入房」，凭据与存储
 * 边界见 docs/architecture.md「身份与凭据边界」。本模块负责持久化与并发
 * 退化，不负责判断「什么算参与」。
 *
 * 边界与取舍：
 * - 只保存房间 ID、服务端确认的房间名、最近参与时间与格式版本；不保存身份
 *   Cookie、成员凭据、成员名单或 BP 快照，跳转路径一律由合法 roomId 生成，
 *   不保存任意外部 URL。清单只是本浏览器记住的链接，不是身份或权限来源。
 * - 每个房间一条独立键：多标签页各自写入只影响本房间，不会用旧列表整体
 *   覆盖其他标签页刚加入的房间；列表每次从存储重新读取，并通过 storage
 *   事件感知其他标签页的移除与清空。
 * - 存储被禁用、配额不足或个别记录损坏时只降级本功能：读取跳过损坏记录，
 *   写入返回失败结果供界面提示；任何情况都不抛出异常，也不阻断建房、入房
 *   与 BP。
 * - 写入前先 begin()（本页移除直接作废；其他标签页的移除/清空经安装的
 *   storage 观察者作废），并调用方在动作发起时捕获令牌：记录在写入落地前
 *   被移除则 commit() 放弃，避免「移除后到达的延迟响应」把记录复活；
 *   用户再次主动进入房间会开启新的写入，可以重新记录。
 */

/** 记录格式版本：键名与载荷同时带版本，避免旧格式被误读。 */
export const ROOM_HISTORY_VERSION = 1;

const ROOM_HISTORY_KEY_PREFIX = `zzzbp.recent-rooms.v${ROOM_HISTORY_VERSION}.`;

/** 单个房间在本机存储中的键（每房间独立键，避免多标签页整体覆盖）。 */
export function roomHistoryKey(roomId: string): string {
  return `${ROOM_HISTORY_KEY_PREFIX}${roomId}`;
}

/** 单条记录的持久载荷；读取时按此校验，损坏记录直接跳过。 */
const roomHistoryEntrySchema = z.object({
  version: z.literal(ROOM_HISTORY_VERSION),
  roomId: roomIdSchema,
  roomName: roomNameSchema,
  lastVisitedAt: z.iso.datetime(),
});

/**
 * 写入失败提示的会话级标记键（`sessionStorage`）：同标签页整页刷新后仍能
 * 提示未保存，关闭标签页即消失。只保存失败原因这一个枚举值，不含任何房间
 * 数据，也不写入 `localStorage` 的清单键空间。
 */
const ROOM_HISTORY_WRITE_FAILURE_KEY = `zzzbp.recent-rooms.v${ROOM_HISTORY_VERSION}.write-failure`;

/** 面向界面的记录（不含格式版本）。 */
export interface RoomHistoryEntry {
  readonly roomId: string;
  readonly roomName: string;
  /** 最近一次参与时间（ISO 8601 UTC）。 */
  readonly lastVisitedAt: string;
}

/**
 * 写入失败原因：
 * - `unavailable`：浏览器存储被禁用或端点本身不可用；
 * - `quota`：配额不足等写入被拒；
 * - `failed`：其他写入失败（含不符合校验的载荷）；
 * - `stale`：记录已在写入落地前被移除或清空，本次写入按规则放弃（非故障）。
 */
export type RoomHistoryWriteFailure = "unavailable" | "quota" | "failed" | "stale";

export type RoomHistoryWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RoomHistoryWriteFailure };

/** 参与写入令牌：绑定 begin() 时的移除/清空代次。 */
export interface RoomHistoryToken {
  readonly roomId: string;
  readonly removalGeneration: number;
  readonly clearGeneration: number;
}

export interface RoomHistoryList {
  readonly entries: readonly RoomHistoryEntry[];
  /** 存储不可用时为 false：界面据此提示无法读取与保存，而不是显示空清单。 */
  readonly storageAvailable: boolean;
}

/** 本模块使用的最小存储接口（浏览器 `localStorage` 兼容，测试可注入）。 */
export interface RoomHistoryStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RoomHistory {
  /** 读取全部记录（按最近参与时间倒序）；每次读取都从存储取最新状态。 */
  list(): RoomHistoryList;
  /**
   * 开始一次参与写入；用于让可能在途的延迟响应在记录被移除后放弃。
   * 首次调用安装其他标签页变化的观察者：请求在途期间发生的移除或清空
   * 同样作废这次写入，不依赖界面组件是否订阅。
   */
  begin(roomId: string): RoomHistoryToken;
  /** 以服务端确认的房间名写入记录；失败返回原因，供界面提示。 */
  commit(token: RoomHistoryToken, input: { readonly roomName: string }): RoomHistoryWriteResult;
  /** 移除单条记录（只删除本功能的数据）。 */
  remove(roomId: string): RoomHistoryWriteResult;
  /** 清空本功能记录（不回退删除其他键，也不触碰任何 Cookie）。 */
  clear(): RoomHistoryWriteResult;
  /** 订阅其他标签页的存储变化以同步界面；返回取消订阅函数。 */
  subscribe(listener: () => void): () => void;
  /**
   * 处理存储变化（storage 事件或测试注入）：删除记录会作废对应的
   * 未提交写入，清空会作废本页全部未提交写入。
   */
  handleExternalChange(change: {
    readonly key: string | null;
    readonly newValue: string | null;
  }): void;
  /** 取出并清除最近一次写入失败提示（`stale` 不算失败，不产生提示）。 */
  takeWriteFailure(): Exclude<RoomHistoryWriteFailure, "stale"> | null;
}

export interface RoomHistoryOptions {
  /** 注入存储（测试用）；省略时使用浏览器 `localStorage`。 */
  readonly storage?: RoomHistoryStorage | null;
  /**
   * 注入会话级存储（测试用）；省略时使用浏览器 `sessionStorage`：写入失败
   * 提示在此保存一个失败原因，使同标签页整页刷新后仍能提示未保存；不可用
   * 时只保留本次页面会话内的内存提示。
   */
  readonly sessionStorage?: RoomHistoryStorage | null;
  /** 注入时钟（测试用）。 */
  readonly now?: () => Date;
}

/**
 * 其他标签页存储变化的最小结构（浏览器 `StorageEvent` 子集）。
 *
 * 本模块同时被浏览器与 Node 测试环境（Workers 类型，不含 DOM lib）检查，
 * 因此不直接引用 `window`/`StorageEvent` 类型，只按结构取用全局对象。
 */
interface StorageChangeEvent {
  readonly key: string | null;
  readonly newValue: string | null;
}

interface StorageWindowLike {
  addEventListener(type: "storage", listener: (event: StorageChangeEvent) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageChangeEvent) => void): void;
}

/** 读取浏览器 `localStorage`；被禁用或不可访问时返回 null。 */
function browserStorage(): RoomHistoryStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: unknown }).localStorage;
    return candidate === undefined || candidate === null ? null : (candidate as RoomHistoryStorage);
  } catch {
    // 隐私模式等场景下访问存储端点本身可能抛错：按不可用降级。
    return null;
  }
}

/** 读取浏览器窗口的 storage 事件端点；非浏览器环境返回 null。 */
function storageWindow(): StorageWindowLike | null {
  const candidate = (globalThis as { window?: unknown }).window;
  if (typeof candidate !== "object" || candidate === null) return null;
  const listeners = candidate as { addEventListener?: unknown; removeEventListener?: unknown };
  if (
    typeof listeners.addEventListener !== "function" ||
    typeof listeners.removeEventListener !== "function"
  ) {
    return null;
  }
  return candidate as StorageWindowLike;
}

/** 写入被拒且属于配额问题：浏览器实现各异，按错误名与旧版数字码共同判断。 */
function isQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
  return (error as { code?: unknown }).code === 22;
}

export function createRoomHistory(options: RoomHistoryOptions = {}): RoomHistory {
  const injectedStorage = options.storage;
  const injectedSessionStorage = options.sessionStorage;
  const now = options.now ?? (() => new Date());
  /** 各房间的移除代次：记录被移除后自增，作废在先的未提交写入。 */
  const removalGenerations = new Map<string, number>();
  /** 清空代次：清空历史后自增，作废所有在先的未提交写入。 */
  let clearGeneration = 0;
  let pendingWriteFailure: Exclude<RoomHistoryWriteFailure, "stale"> | null = null;
  /** 其他标签页变化的界面监听器（由 subscribe 登记）；失效判定由内部观察者负责。 */
  const externalListeners = new Set<() => void>();
  /** 其他标签页变化的观察者只安装一次。 */
  let externalObserverInstalled = false;

  function storage(): RoomHistoryStorage | null {
    return injectedStorage === undefined ? browserStorage() : injectedStorage;
  }

  /**
   * 失败提示的会话级存储端点；不可用时只保留本次页面会话内的内存提示。
   * 禁用存储时访问端点本身也可能抛错（如 SecurityError），与 `localStorage`
   * 的读取一致地按不可用降级：提示不是记录，任何情况都不能让
   * fail()/succeed()/takeWriteFailure() 抛出而影响建房、入房与 BP。
   */
  function sessionStore(): RoomHistoryStorage | null {
    if (injectedSessionStorage !== undefined) return injectedSessionStorage;
    try {
      const candidate = (globalThis as { sessionStorage?: unknown }).sessionStorage;
      if (candidate === undefined || candidate === null) return null;
      return candidate as RoomHistoryStorage;
    } catch {
      return null;
    }
  }

  function clearSessionFailure(): void {
    const target = sessionStore();
    if (target === null) return;
    try {
      target.removeItem(ROOM_HISTORY_WRITE_FAILURE_KEY);
    } catch {
      // 会话存储不可用只影响提示的跨刷新可见性，不影响任何记录。
    }
  }

  function readSessionFailure(): Exclude<RoomHistoryWriteFailure, "stale"> | null {
    const target = sessionStore();
    if (target === null) return null;
    try {
      const raw = target.getItem(ROOM_HISTORY_WRITE_FAILURE_KEY);
      if (raw === "unavailable" || raw === "quota" || raw === "failed") return raw;
      return null;
    } catch {
      return null;
    }
  }

  function fail(reason: Exclude<RoomHistoryWriteFailure, "stale">): RoomHistoryWriteResult {
    pendingWriteFailure = reason;
    const target = sessionStore();
    if (target !== null) {
      try {
        target.setItem(ROOM_HISTORY_WRITE_FAILURE_KEY, reason);
      } catch {
        // 会话存储写入失败：提示仍保留在本次页面会话内。
      }
    }
    return { ok: false, reason };
  }

  function succeed(): RoomHistoryWriteResult {
    pendingWriteFailure = null;
    clearSessionFailure();
    return { ok: true };
  }

  function removalGenerationOf(roomId: string): number {
    return removalGenerations.get(roomId) ?? 0;
  }

  function invalidate(roomId: string): void {
    removalGenerations.set(roomId, removalGenerationOf(roomId) + 1);
  }

  /** 收集本功能自己的键（绝不枚举或删除其他键）。 */
  function ownKeys(target: RoomHistoryStorage): string[] {
    const keys: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key !== null && key.startsWith(ROOM_HISTORY_KEY_PREFIX)) keys.push(key);
    }
    return keys;
  }

  function parseEntry(raw: string, expectedRoomId: string): RoomHistoryEntry | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 个别记录损坏：跳过该条，不影响其余记录与首页其他功能。
      return null;
    }
    const result = roomHistoryEntrySchema.safeParse(parsed);
    if (!result.success) return null;
    // 键与载荷必须指向同一房间；不一致按损坏处理。
    if (result.data.roomId !== expectedRoomId) return null;
    return {
      roomId: result.data.roomId,
      roomName: result.data.roomName,
      lastVisitedAt: result.data.lastVisitedAt,
    };
  }

  function list(): RoomHistoryList {
    const target = storage();
    if (target === null) return { entries: [], storageAvailable: false };
    const entries: RoomHistoryEntry[] = [];
    try {
      for (const key of ownKeys(target)) {
        const raw = target.getItem(key);
        if (raw === null) continue;
        const entry = parseEntry(raw, key.slice(ROOM_HISTORY_KEY_PREFIX.length));
        if (entry !== null) entries.push(entry);
      }
    } catch {
      // 读取端点本身失败：按不可用降级，首页其余功能照常。
      return { entries: [], storageAvailable: false };
    }
    entries.sort(
      (left, right) =>
        Date.parse(right.lastVisitedAt) - Date.parse(left.lastVisitedAt) ||
        left.roomId.localeCompare(right.roomId),
    );
    return { entries, storageAvailable: true };
  }

  function begin(roomId: string): RoomHistoryToken {
    // 发起写入的页面必须能感知其他标签页的移除/清空：观察者在此安装，因此
    // 请求在途期间发生的移除同样会作废这次写入（不依赖界面组件是否订阅）。
    ensureExternalObserver();
    return {
      roomId,
      removalGeneration: removalGenerationOf(roomId),
      clearGeneration,
    };
  }

  function commit(
    token: RoomHistoryToken,
    input: { readonly roomName: string },
  ): RoomHistoryWriteResult {
    const target = storage();
    if (target === null) return fail("unavailable");
    if (
      removalGenerationOf(token.roomId) !== token.removalGeneration ||
      clearGeneration !== token.clearGeneration
    ) {
      // 记录在写入落地前已被移除或清空：按规则放弃，不复活记录，也不报错。
      return { ok: false, reason: "stale" };
    }
    const entry = roomHistoryEntrySchema.safeParse({
      version: ROOM_HISTORY_VERSION,
      roomId: token.roomId,
      roomName: input.roomName,
      lastVisitedAt: now().toISOString(),
    });
    if (!entry.success) return fail("failed");
    try {
      target.setItem(roomHistoryKey(token.roomId), JSON.stringify(entry.data));
      return succeed();
    } catch (error) {
      return fail(isQuotaError(error) ? "quota" : "failed");
    }
  }

  function remove(roomId: string): RoomHistoryWriteResult {
    // 先作废在途写入再删除：存储不可用时同样保证不会随后复活记录。
    invalidate(roomId);
    const target = storage();
    if (target === null) return fail("unavailable");
    try {
      target.removeItem(roomHistoryKey(roomId));
      return succeed();
    } catch {
      return fail("failed");
    }
  }

  function clear(): RoomHistoryWriteResult {
    clearGeneration += 1;
    const target = storage();
    if (target === null) return fail("unavailable");
    try {
      for (const key of ownKeys(target)) target.removeItem(key);
      return succeed();
    } catch {
      return fail("failed");
    }
  }

  function handleExternalChange(change: {
    readonly key: string | null;
    readonly newValue: string | null;
  }): void {
    if (change.key === null) {
      // 其他标签页清空历史：作废本页所有未提交写入。
      clearGeneration += 1;
      return;
    }
    if (!change.key.startsWith(ROOM_HISTORY_KEY_PREFIX)) return;
    // 只有删除会作废在途写入；其他标签页新增/更新记录是正常的参与记录。
    if (change.newValue !== null) return;
    invalidate(change.key.slice(ROOM_HISTORY_KEY_PREFIX.length));
  }

  /**
   * 安装其他标签页变化的观察者：删除与清空经 storage 事件作废本页未提交
   * 写入，随后通知界面监听器。非浏览器环境没有窗口端点，只作本页内的
   * 失效判定。
   */
  function ensureExternalObserver(): void {
    if (externalObserverInstalled) return;
    const target = storageWindow();
    if (target === null) return;
    externalObserverInstalled = true;
    target.addEventListener("storage", (event) => {
      handleExternalChange({ key: event.key, newValue: event.newValue });
      for (const listener of externalListeners) listener();
    });
  }

  function subscribe(listener: () => void): () => void {
    ensureExternalObserver();
    externalListeners.add(listener);
    return () => {
      externalListeners.delete(listener);
    };
  }

  function takeWriteFailure(): Exclude<RoomHistoryWriteFailure, "stale"> | null {
    const failure = pendingWriteFailure ?? readSessionFailure();
    pendingWriteFailure = null;
    clearSessionFailure();
    return failure;
  }

  return {
    list,
    begin,
    commit,
    remove,
    clear,
    subscribe,
    handleExternalChange,
    takeWriteFailure,
  };
}

/**
 * 应用共用的单例：页面（记录参与）与首页清单（读取与展示）共享同一份
 * 写入失败提示。存储端点每次操作时解析，便于测试与非浏览器环境降级。
 */
export const roomHistory: RoomHistory = createRoomHistory();
