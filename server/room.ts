import { DurableObject } from "cloudflare:workers";
import { roomInfoSchema, type RoomInfo } from "../shared/api";

/**
 * 房间 Durable Object 的最小骨架。
 *
 * 每个房间一个实例，存储引擎为内置 SQLite；席位、BP 状态与归档等
 * 首版业务表在后续 PR 中落在同一存储上。当前仅保留一条房间创建记录，
 * 用于验证真实 Workers SQLite 的读写链路。
 */
export class Room extends DurableObject {
  private ensureTable(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS room_info (id INTEGER PRIMARY KEY CHECK (id = 1), created_at TEXT NOT NULL)",
    );
  }

  /** 幂等地初始化房间记录并返回房间信息。 */
  async ensureCreated(): Promise<RoomInfo> {
    this.ensureTable();
    const existing = await this.readInfo();
    if (existing) return existing;

    const createdAt = new Date().toISOString();
    this.ctx.storage.sql.exec("INSERT INTO room_info (id, created_at) VALUES (1, ?)", createdAt);
    return roomInfoSchema.parse({ createdAt });
  }

  /** 读取房间信息；房间尚未初始化时返回 null。 */
  async readInfo(): Promise<RoomInfo | null> {
    this.ensureTable();
    const cursor = this.ctx.storage.sql.exec("SELECT created_at FROM room_info WHERE id = 1");
    const row = cursor.toArray()[0];
    if (!row) return null;

    const createdAt = row.created_at;
    if (typeof createdAt !== "string") {
      throw new Error("room_info.created_at 应为 TEXT 类型的 ISO 时间");
    }
    return roomInfoSchema.parse({ createdAt });
  }
}
