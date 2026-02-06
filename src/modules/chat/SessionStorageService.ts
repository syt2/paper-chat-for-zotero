/**
 * SessionStorageService - SQLite-backed Session Storage
 *
 * 职责:
 * 1. SQLite 存储 (via StorageDatabase)
 * 2. CRUD 操作
 * 3. 空 session 自动清理
 * 4. 最大 1000 session 限制
 *
 * Public API unchanged from file-based version.
 */

import type { ChatSession, SessionMeta } from "../../types/chat";
import { filterValidMessages, generateShortId } from "../../utils/common";
import { getStorageDatabase } from "./db/StorageDatabase";

// 最大 session 数量限制
const MAX_SESSIONS = 1000;

export class SessionStorageService {
  private initialized: boolean = false;
  private activeSessionIdCache: string | null = null;

  /**
   * 初始化存储服务
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const db = await getStorageDatabase().ensureInit();

      // Load activeSessionId from settings
      const rows = (await db.queryAsync(
        "SELECT value FROM settings WHERE key = ?",
        ["active_session_id"],
      )) || [];

      this.activeSessionIdCache = rows.length > 0 ? rows[0].value : null;

      this.initialized = true;
      ztoolkit.log("[SessionStorageService] Initialized (SQLite)");
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Init error:", error);
      throw error;
    }
  }

  /**
   * 构建 session 元数据
   */
  private buildSessionMeta(session: ChatSession): SessionMeta {
    let lastMessagePreview = "";
    let lastMessageTime = session.updatedAt || Date.now();

    if (session.messages && session.messages.length > 0) {
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const msg = session.messages[i];
        if (msg.content && msg.role !== "tool") {
          lastMessagePreview =
            msg.content.substring(0, 50) +
            (msg.content.length > 50 ? "..." : "");
          lastMessageTime = msg.timestamp || session.updatedAt || Date.now();
          break;
        }
      }
    }

    return {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages?.length || 0,
      lastMessagePreview,
      lastMessageTime,
    };
  }

  /**
   * 生成新的 session ID (timestamp-uuid 格式)
   */
  private generateSessionId(): string {
    return `${Date.now()}-${generateShortId()}`;
  }

  /**
   * 创建新 session
   */
  async createSession(): Promise<ChatSession> {
    await this.init();

    const sessionId = this.generateSessionId();
    const now = Date.now();

    const session: ChatSession = {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      lastActiveItemKey: null,
      messages: [],
    };

    // 保存 session
    await this.saveSession(session);

    // 设置为活动 session
    await this.setActiveSession(sessionId);

    ztoolkit.log("[SessionStorageService] New session created:", sessionId);
    return session;
  }

  /**
   * 保存 session
   */
  async saveSession(session: ChatSession): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      session.updatedAt = Date.now();

      const meta = this.buildSessionMeta(session);

      await db.queryAsync("BEGIN TRANSACTION");
      try {
        // Upsert session
        await db.queryAsync(
          `INSERT OR REPLACE INTO sessions
           (id, created_at, updated_at, last_active_item_key, last_active_item_keys, messages, context_summary, context_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            session.id,
            session.createdAt,
            session.updatedAt,
            session.lastActiveItemKey || null,
            session.lastActiveItemKeys ? JSON.stringify(session.lastActiveItemKeys) : null,
            JSON.stringify(session.messages),
            session.contextSummary ? JSON.stringify(session.contextSummary) : null,
            session.contextState ? JSON.stringify(session.contextState) : null,
          ],
        );

        // Upsert session_meta
        await db.queryAsync(
          `INSERT OR REPLACE INTO session_meta
           (id, created_at, updated_at, message_count, last_message_preview, last_message_time)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            meta.id,
            meta.createdAt,
            meta.updatedAt,
            meta.messageCount,
            meta.lastMessagePreview,
            meta.lastMessageTime,
          ],
        );

        await db.queryAsync("COMMIT");
      } catch (error) {
        try { await db.queryAsync("ROLLBACK"); } catch { /* ignore */ }
        throw error;
      }

      // 检查是否超过最大限制
      await this.enforceMaxSessions();

      ztoolkit.log("[SessionStorageService] Session saved:", session.id);
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Save session error:", error);
      throw error;
    }
  }

  /**
   * 加载 session
   */
  async loadSession(sessionId: string): Promise<ChatSession | null> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      const rows = (await db.queryAsync(
        "SELECT * FROM sessions WHERE id = ?",
        [sessionId],
      )) || [];

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      const session: ChatSession = {
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastActiveItemKey: row.last_active_item_key || null,
        lastActiveItemKeys: row.last_active_item_keys ? JSON.parse(row.last_active_item_keys) : undefined,
        messages: row.messages ? JSON.parse(row.messages) : [],
        contextSummary: row.context_summary ? JSON.parse(row.context_summary) : undefined,
        contextState: row.context_state ? JSON.parse(row.context_state) : undefined,
      };

      // 过滤无效消息（修复历史数据问题）
      if (session.messages) {
        session.messages = filterValidMessages(session.messages);
      }

      ztoolkit.log("[SessionStorageService] Session loaded:", sessionId);
      return session;
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Load session error:", error);
      return null;
    }
  }

  /**
   * 删除 session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();

      // Explicitly delete from both tables (don't rely on CASCADE alone,
      // since PRAGMA foreign_keys may not persist across reconnections)
      await db.queryAsync("DELETE FROM session_meta WHERE id = ?", [sessionId]);
      await db.queryAsync("DELETE FROM sessions WHERE id = ?", [sessionId]);

      // If deleted session was active, switch to most recent
      if (this.activeSessionIdCache === sessionId) {
        const metaRows = (await db.queryAsync(
          "SELECT id FROM session_meta ORDER BY updated_at DESC LIMIT 1",
        )) || [];

        const newActiveId = metaRows.length > 0 ? metaRows[0].id : null;
        await this.setActiveSession(newActiveId);
      }

      ztoolkit.log("[SessionStorageService] Session deleted:", sessionId);
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Delete session error:", error);
      throw error;
    }
  }

  /**
   * 列出所有 session (返回元数据列表)
   */
  async listSessions(): Promise<SessionMeta[]> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      const rows = (await db.queryAsync(
        "SELECT * FROM session_meta ORDER BY updated_at DESC",
      )) || [];

      return rows.map((row: any) => ({
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
        lastMessagePreview: row.last_message_preview,
        lastMessageTime: row.last_message_time,
      }));
    } catch (error) {
      ztoolkit.log("[SessionStorageService] List sessions error:", error);
      return [];
    }
  }

  /**
   * 获取活动 session
   */
  async getActiveSession(): Promise<ChatSession | null> {
    await this.init();

    const activeId = this.activeSessionIdCache;
    if (!activeId) {
      return null;
    }

    return this.loadSession(activeId);
  }

  /**
   * 获取活动 session ID (同步方法)
   */
  getActiveSessionId(): string | null {
    return this.activeSessionIdCache;
  }

  /**
   * 设置活动 session
   */
  async setActiveSession(sessionId: string | null): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();

      if (sessionId) {
        await db.queryAsync(
          "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
          ["active_session_id", sessionId],
        );
      } else {
        await db.queryAsync(
          "DELETE FROM settings WHERE key = ?",
          ["active_session_id"],
        );
      }

      this.activeSessionIdCache = sessionId;
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Set active session error:", error);
    }
  }

  /**
   * 清理空 session (没有消息的 session)
   */
  async cleanupEmptySessions(): Promise<number> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      const activeId = this.activeSessionIdCache;

      // Find empty sessions (excluding active)
      let query = "SELECT id FROM session_meta WHERE message_count = 0";
      const params: unknown[] = [];

      if (activeId) {
        query += " AND id != ?";
        params.push(activeId);
      }

      const rows = (await db.queryAsync(query, params)) || [];

      for (const row of rows) {
        await db.queryAsync("DELETE FROM session_meta WHERE id = ?", [row.id]);
        await db.queryAsync("DELETE FROM sessions WHERE id = ?", [row.id]);
      }

      ztoolkit.log("[SessionStorageService] Cleaned up empty sessions:", rows.length);
      return rows.length;
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Cleanup error:", error);
      return 0;
    }
  }

  /**
   * 强制执行最大 session 数量限制
   */
  private async enforceMaxSessions(): Promise<void> {
    try {
      const db = await getStorageDatabase().ensureInit();

      const countRows = (await db.queryAsync(
        "SELECT COUNT(*) as count FROM session_meta",
      )) || [];

      const totalCount = countRows[0]?.count || 0;
      if (totalCount <= MAX_SESSIONS) return;

      // Find sessions to delete: oldest beyond MAX_SESSIONS, excluding active
      const activeId = this.activeSessionIdCache;
      const toDeleteRows = (await db.queryAsync(
        `SELECT id FROM session_meta
         WHERE id != ?
         ORDER BY updated_at DESC
         LIMIT -1 OFFSET ?`,
        [activeId || "", MAX_SESSIONS - 1],
      )) || [];

      for (const row of toDeleteRows) {
        await db.queryAsync("DELETE FROM session_meta WHERE id = ?", [row.id]);
        await db.queryAsync("DELETE FROM sessions WHERE id = ?", [row.id]);
      }

      if (toDeleteRows.length > 0) {
        ztoolkit.log(
          "[SessionStorageService] Enforced max sessions limit, deleted:",
          toDeleteRows.length,
        );
      }
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Enforce max sessions error:", error);
    }
  }

  /**
   * 获取或创建活动 session
   */
  async getOrCreateActiveSession(): Promise<ChatSession> {
    await this.init();

    let session = await this.getActiveSession();
    if (!session) {
      session = await this.createSession();
    }
    return session;
  }

  /**
   * 检查是否有旧格式数据需要迁移
   */
  async hasLegacyData(): Promise<boolean> {
    const legacyPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "paper-chat",
      "conversations",
    );
    return IOUtils.exists(legacyPath);
  }

  /**
   * 获取旧格式数据目录路径
   */
  getLegacyStoragePath(): string {
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      "paper-chat",
      "conversations",
    );
  }
}
