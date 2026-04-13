/**
 * SessionStorageService - SQLite-backed Session Storage
 *
 * 职责:
 * 1. SQLite 存储 (via StorageDatabase)
 * 2. CRUD 操作
 * 3. 空 session 自动清理
 * 4. 最大 1000 session 限制
 *
 * Messages are stored in a separate `messages` table (one row per message).
 * Push → INSERT, splice → DELETE, content update → UPDATE.
 */

import type { ChatMessage, ChatSession, SessionMeta } from "../../types/chat";
import { filterValidMessages, generateShortId } from "../../utils/common";
import { getStorageDatabase } from "./db/StorageDatabase";

// 最大 session 数量限制
const MAX_SESSIONS = 1000;

type SessionRow = {
  id: string;
  created_at: number;
  updated_at: number;
  last_active_item_key: string | null;
  last_active_item_keys: string | null;
  context_summary: string | null;
  context_state: string | null;
  execution_plan?: string | null;
  memory_extracted_at: number | null;
  memory_extracted_msg_count: number | null;
  selected_tier: string | null;
  resolved_model_id: string | null;
  last_retryable_user_message_id: string | null;
  last_retryable_error_message_id: string | null;
  last_retryable_failed_model_id: string | null;
};

export class SessionLoadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SessionLoadError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class MissingActiveSessionError extends SessionLoadError {
  constructor(message: string) {
    super(message);
    this.name = "MissingActiveSessionError";
  }
}

function toValidSelectedTier(value: string | null): ChatSession["selectedTier"] {
  if (
    value === "paperchat-lite" ||
    value === "paperchat-standard" ||
    value === "paperchat-pro"
  ) {
    return value;
  }
  return undefined;
}

export function mapSessionRowToChatSession(
  row: SessionRow,
  messages: ChatMessage[],
): ChatSession {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveItemKey: row.last_active_item_key || null,
    lastActiveItemKeys: row.last_active_item_keys
      ? JSON.parse(row.last_active_item_keys)
      : undefined,
    messages: filterValidMessages(messages),
    contextSummary: row.context_summary
      ? JSON.parse(row.context_summary)
      : undefined,
    contextState: row.context_state ? JSON.parse(row.context_state) : undefined,
    executionPlan: row.execution_plan ? JSON.parse(row.execution_plan) : undefined,
    memoryExtractedAt:
      row.memory_extracted_at != null
        ? (row.memory_extracted_at as number)
        : undefined,
    memoryExtractedMsgCount:
      row.memory_extracted_msg_count != null
        ? (row.memory_extracted_msg_count as number)
        : undefined,
    selectedTier: toValidSelectedTier(row.selected_tier),
    resolvedModelId: row.resolved_model_id || undefined,
    lastRetryableUserMessageId:
      row.last_retryable_user_message_id || undefined,
    lastRetryableErrorMessageId:
      row.last_retryable_error_message_id || undefined,
    lastRetryableFailedModelId:
      row.last_retryable_failed_model_id || undefined,
  };
}

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

  // ============================================
  // Message-level operations
  // ============================================

  /**
   * 插入单条消息 (push 操作)
   */
  async insertMessage(sessionId: string, message: ChatMessage): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();

      // Get the next seq number for this session
      const seqRows = (await db.queryAsync(
        "SELECT COALESCE(MAX(seq), -1) as max_seq FROM messages WHERE session_id = ?",
        [sessionId],
      )) || [];
      const nextSeq = (seqRows[0]?.max_seq ?? -1) + 1;

      await db.queryAsync(
        `INSERT INTO messages (id, session_id, seq, role, content, reasoning, images, files, timestamp, pdf_context, selected_text, tool_calls, tool_call_id, is_system_notice)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.id,
          sessionId,
          nextSeq,
          message.role,
          message.content || "",
          message.reasoning || null,
          message.images ? JSON.stringify(message.images) : null,
          message.files ? JSON.stringify(message.files) : null,
          message.timestamp || Date.now(),
          message.pdfContext ? 1 : null,
          message.selectedText || null,
          message.tool_calls ? JSON.stringify(message.tool_calls) : null,
          message.tool_call_id || null,
          message.isSystemNotice ? 1 : null,
        ],
      );

      // Incrementally update session_meta
      const now = Date.now();
      const preview = (message.role !== "tool" && message.content)
        ? message.content.substring(0, 50) + (message.content.length > 50 ? "..." : "")
        : undefined;

      if (preview !== undefined) {
        await db.queryAsync(
          `UPDATE session_meta SET
            message_count = message_count + 1,
            last_message_preview = ?,
            last_message_time = ?,
            updated_at = ?
          WHERE id = ?`,
          [preview, message.timestamp || now, now, sessionId],
        );
      } else {
        await db.queryAsync(
          `UPDATE session_meta SET
            message_count = message_count + 1,
            updated_at = ?
          WHERE id = ?`,
          [now, sessionId],
        );
      }

      // Update sessions.updated_at
      await db.queryAsync(
        "UPDATE sessions SET updated_at = ? WHERE id = ?",
        [now, sessionId],
      );
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Insert message error:", error);
      throw error;
    }
  }

  /**
   * 删除单条消息 (splice 操作 — 错误恢复时删除 assistant 占位)
   */
  async deleteMessage(sessionId: string, messageId: string): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      const now = Date.now();

      await db.queryAsync(
        "DELETE FROM messages WHERE id = ? AND session_id = ?",
        [messageId, sessionId],
      );

      await db.queryAsync(
        `UPDATE session_meta SET
          message_count = MAX(0, message_count - 1),
          updated_at = ?
        WHERE id = ?`,
        [now, sessionId],
      );

      await db.queryAsync(
        "UPDATE sessions SET updated_at = ? WHERE id = ?",
        [now, sessionId],
      );
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Delete message error:", error);
      throw error;
    }
  }

  /**
   * 删除所有消息 (clearCurrentSession)
   */
  async deleteAllMessages(sessionId: string): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      const now = Date.now();

      await db.queryAsync(
        "DELETE FROM messages WHERE session_id = ?",
        [sessionId],
      );

      await db.queryAsync(
        `UPDATE session_meta SET
          message_count = 0,
          last_message_preview = '',
          last_message_time = ?,
          updated_at = ?
        WHERE id = ?`,
        [now, now, sessionId],
      );

      await db.queryAsync(
        "UPDATE sessions SET updated_at = ? WHERE id = ?",
        [now, sessionId],
      );
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Delete all messages error:", error);
      throw error;
    }
  }

  /**
   * 更新消息内容 (streaming 完成后更新 assistant message 的最终内容)
   */
  async updateMessageContent(sessionId: string, messageId: string, content: string, reasoning?: string): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();

      await db.queryAsync(
        "UPDATE messages SET content = ?, reasoning = ?, timestamp = ? WHERE id = ? AND session_id = ?",
        [content, reasoning || null, Date.now(), messageId, sessionId],
      );

      // Update session_meta preview with the latest content
      const preview = content.substring(0, 50) + (content.length > 50 ? "..." : "");
      const now = Date.now();

      await db.queryAsync(
        `UPDATE session_meta SET
          last_message_preview = ?,
          last_message_time = ?,
          updated_at = ?
        WHERE id = ?`,
        [preview, now, now, sessionId],
      );
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Update message content error:", error);
      throw error;
    }
  }

  /**
   * 仅更新 session 元数据 (不涉及 messages)
   */
  async updateSessionMeta(session: ChatSession): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      session.updatedAt = Date.now();
      await db.queryAsync("BEGIN TRANSACTION");
      try {
        await db.queryAsync(
          `UPDATE sessions SET
            updated_at = ?,
            last_active_item_key = ?,
            last_active_item_keys = ?,
            context_summary = ?,
            context_state = ?,
            execution_plan = ?
          WHERE id = ?`,
          [
            session.updatedAt,
            session.lastActiveItemKey || null,
            session.lastActiveItemKeys ? JSON.stringify(session.lastActiveItemKeys) : null,
            session.contextSummary ? JSON.stringify(session.contextSummary) : null,
            session.contextState ? JSON.stringify(session.contextState) : null,
            session.executionPlan ? JSON.stringify(session.executionPlan) : null,
          session.id,
        ],
      );

        await db.queryAsync(
          `INSERT INTO paperchat_session_state
           (session_id, selected_tier, resolved_model_id, last_retryable_user_message_id, last_retryable_error_message_id, last_retryable_failed_model_id)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             selected_tier = excluded.selected_tier,
             resolved_model_id = excluded.resolved_model_id,
             last_retryable_user_message_id = excluded.last_retryable_user_message_id,
             last_retryable_error_message_id = excluded.last_retryable_error_message_id,
             last_retryable_failed_model_id = excluded.last_retryable_failed_model_id`,
          [
            session.id,
            session.selectedTier || null,
            session.resolvedModelId || null,
            session.lastRetryableUserMessageId || null,
            session.lastRetryableErrorMessageId || null,
            session.lastRetryableFailedModelId || null,
          ],
        );

        // Also keep session_meta.updated_at in sync
        await db.queryAsync(
          "UPDATE session_meta SET updated_at = ? WHERE id = ?",
          [session.updatedAt, session.id],
        );

        await db.queryAsync("COMMIT");
      } catch (error) {
        try { await db.queryAsync("ROLLBACK"); } catch { /* ignore */ }
        throw error;
      }
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Update session meta error:", error);
      throw error;
    }
  }

  /**
   * Persist memory extraction state for a session (called after successful extraction).
   */
  async updateMemoryExtractionState(
    sessionId: string,
    extractedAt: number,
    extractedMsgCount: number,
  ): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      await db.queryAsync(
        "UPDATE sessions SET memory_extracted_at = ?, memory_extracted_msg_count = ? WHERE id = ?",
        [extractedAt, extractedMsgCount, sessionId],
      );
    } catch (error) {
      ztoolkit.log("[SessionStorageService] updateMemoryExtractionState error:", error);
      throw error;
    }
  }

  // ============================================
  // Session-level CRUD
  // ============================================

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

    // 保存 session (full write — no messages to insert)
    await this.saveSession(session);

    // 设置为活动 session
    await this.setActiveSession(sessionId);

    ztoolkit.log("[SessionStorageService] New session created:", sessionId);
    return session;
  }

  /**
   * 保存 session (全量写入 — 用于 create/migration/destroy)
   */
  async saveSession(session: ChatSession): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      session.updatedAt = Date.now();

      const meta = this.buildSessionMeta(session);

      await db.queryAsync("BEGIN TRANSACTION");
      try {
        // Upsert session (no messages column)
        await db.queryAsync(
          `INSERT INTO sessions
           (id, created_at, updated_at, last_active_item_key, last_active_item_keys, context_summary, context_state, execution_plan, memory_extracted_at, memory_extracted_msg_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             last_active_item_key = excluded.last_active_item_key,
             last_active_item_keys = excluded.last_active_item_keys,
             context_summary = excluded.context_summary,
             context_state = excluded.context_state,
             execution_plan = excluded.execution_plan,
             memory_extracted_at = excluded.memory_extracted_at,
             memory_extracted_msg_count = excluded.memory_extracted_msg_count`,
          [
            session.id,
            session.createdAt,
            session.updatedAt,
            session.lastActiveItemKey || null,
            session.lastActiveItemKeys ? JSON.stringify(session.lastActiveItemKeys) : null,
            session.contextSummary ? JSON.stringify(session.contextSummary) : null,
            session.contextState ? JSON.stringify(session.contextState) : null,
            session.executionPlan ? JSON.stringify(session.executionPlan) : null,
            session.memoryExtractedAt ?? null,
            session.memoryExtractedMsgCount ?? null,
          ],
        );

        await db.queryAsync(
          `INSERT INTO paperchat_session_state
           (session_id, selected_tier, resolved_model_id, last_retryable_user_message_id, last_retryable_error_message_id, last_retryable_failed_model_id)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             selected_tier = excluded.selected_tier,
             resolved_model_id = excluded.resolved_model_id,
             last_retryable_user_message_id = excluded.last_retryable_user_message_id,
             last_retryable_error_message_id = excluded.last_retryable_error_message_id,
             last_retryable_failed_model_id = excluded.last_retryable_failed_model_id`,
          [
            session.id,
            session.selectedTier || null,
            session.resolvedModelId || null,
            session.lastRetryableUserMessageId || null,
            session.lastRetryableErrorMessageId || null,
            session.lastRetryableFailedModelId || null,
          ],
        );

        // Replace all messages: delete existing, then insert
        await db.queryAsync(
          "DELETE FROM messages WHERE session_id = ?",
          [session.id],
        );

        if (session.messages && session.messages.length > 0) {
          for (let seq = 0; seq < session.messages.length; seq++) {
            const msg = session.messages[seq];
            await db.queryAsync(
              `INSERT INTO messages (id, session_id, seq, role, content, reasoning, images, files, timestamp, pdf_context, selected_text, tool_calls, tool_call_id, is_system_notice)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                msg.id,
                session.id,
                seq,
                msg.role,
                msg.content || "",
                msg.reasoning || null,
                msg.images ? JSON.stringify(msg.images) : null,
                msg.files ? JSON.stringify(msg.files) : null,
                msg.timestamp || Date.now(),
                msg.pdfContext ? 1 : null,
                msg.selectedText || null,
                msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
                msg.tool_call_id || null,
                msg.isSystemNotice ? 1 : null,
              ],
            );
          }
        }

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

      // 1. Load session row (without messages)
      const sessionRows = (await db.queryAsync(
        "SELECT * FROM sessions WHERE id = ?",
        [sessionId],
      )) || [];

      if (sessionRows.length === 0) {
        return null;
      }

      const baseRowRaw = sessionRows[0] as Partial<SessionRow> & Record<string, unknown>;
      const baseRow: SessionRow = {
        id: String(baseRowRaw.id || ""),
        created_at: Number(baseRowRaw.created_at || 0),
        updated_at: Number(baseRowRaw.updated_at || 0),
        last_active_item_key:
          typeof baseRowRaw.last_active_item_key === "string"
            ? baseRowRaw.last_active_item_key
            : null,
        last_active_item_keys:
          typeof baseRowRaw.last_active_item_keys === "string"
            ? baseRowRaw.last_active_item_keys
            : null,
        context_summary:
          typeof baseRowRaw.context_summary === "string"
            ? baseRowRaw.context_summary
            : null,
        context_state:
          typeof baseRowRaw.context_state === "string"
            ? baseRowRaw.context_state
            : null,
        execution_plan:
          typeof baseRowRaw.execution_plan === "string"
            ? baseRowRaw.execution_plan
            : null,
        memory_extracted_at:
          typeof baseRowRaw.memory_extracted_at === "number"
            ? baseRowRaw.memory_extracted_at
            : null,
        memory_extracted_msg_count:
          typeof baseRowRaw.memory_extracted_msg_count === "number"
            ? baseRowRaw.memory_extracted_msg_count
            : null,
        selected_tier:
          typeof baseRowRaw.selected_tier === "string"
            ? baseRowRaw.selected_tier
            : null,
        resolved_model_id:
          typeof baseRowRaw.resolved_model_id === "string"
            ? baseRowRaw.resolved_model_id
            : null,
        last_retryable_user_message_id:
          typeof baseRowRaw.last_retryable_user_message_id === "string"
            ? baseRowRaw.last_retryable_user_message_id
            : null,
        last_retryable_error_message_id:
          typeof baseRowRaw.last_retryable_error_message_id === "string"
            ? baseRowRaw.last_retryable_error_message_id
            : null,
        last_retryable_failed_model_id:
          typeof baseRowRaw.last_retryable_failed_model_id === "string"
            ? baseRowRaw.last_retryable_failed_model_id
            : null,
      };
      const paperchatStateRows = (await db.queryAsync(
        "SELECT * FROM paperchat_session_state WHERE session_id = ?",
        [sessionId],
      )) || [];
      const paperchatState = paperchatStateRows[0] as Partial<SessionRow> | undefined;
      const row: SessionRow = {
        ...baseRow,
        selected_tier: paperchatState?.selected_tier ?? baseRow.selected_tier,
        resolved_model_id:
          paperchatState?.resolved_model_id ?? baseRow.resolved_model_id,
        last_retryable_user_message_id:
          paperchatState?.last_retryable_user_message_id
          ?? baseRow.last_retryable_user_message_id,
        last_retryable_error_message_id:
          paperchatState?.last_retryable_error_message_id
          ?? baseRow.last_retryable_error_message_id,
        last_retryable_failed_model_id:
          paperchatState?.last_retryable_failed_model_id
          ?? baseRow.last_retryable_failed_model_id,
      };

      // 2. Load messages from messages table
      const messageRows = (await db.queryAsync(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC",
        [sessionId],
      )) || [];

      const messages: ChatMessage[] = messageRows.map((m: any) => {
        const msg: ChatMessage = {
          id: m.id,
          role: m.role,
          content: m.content || "",
          timestamp: m.timestamp,
        };
        if (m.reasoning) msg.reasoning = m.reasoning;
        if (m.images) msg.images = JSON.parse(m.images);
        if (m.files) msg.files = JSON.parse(m.files);
        if (m.pdf_context) msg.pdfContext = true;
        if (m.selected_text) msg.selectedText = m.selected_text;
        if (m.tool_calls) msg.tool_calls = JSON.parse(m.tool_calls);
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.is_system_notice) msg.isSystemNotice = true;
        return msg;
      });

      const session = mapSessionRowToChatSession(row, messages);
      return session;
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Load session error:", error);
      throw new SessionLoadError(`Failed to load session ${sessionId}`, error);
    }
  }

  /**
   * 删除 session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();

      // Explicitly delete from all tables (don't rely on CASCADE alone,
      // since PRAGMA foreign_keys may not persist across reconnections)
      await db.queryAsync(
        "DELETE FROM paperchat_session_state WHERE session_id = ?",
        [sessionId],
      );
      await db.queryAsync("DELETE FROM messages WHERE session_id = ?", [sessionId]);
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
      throw error;
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
        await db.queryAsync(
          "DELETE FROM paperchat_session_state WHERE session_id = ?",
          [row.id],
        );
        await db.queryAsync("DELETE FROM messages WHERE session_id = ?", [row.id]);
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
        await db.queryAsync(
          "DELETE FROM paperchat_session_state WHERE session_id = ?",
          [row.id],
        );
        await db.queryAsync("DELETE FROM messages WHERE session_id = ?", [row.id]);
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

    const activeId = this.activeSessionIdCache;
    if (activeId) {
      const session = await this.loadSession(activeId);
      if (session) {
        return session;
      }
      throw new MissingActiveSessionError(`Active session ${activeId} is missing`);
    }

    return this.createSession();
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
