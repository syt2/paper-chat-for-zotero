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

import type {
  ChatMessage,
  ChatMessageStreamingState,
  ChatSession,
  SessionMeta,
  ToolExecutionState,
} from "../../types/chat";
import type { EvidenceRecord } from "../../types/evidence";
import { filterValidMessages, generateShortId } from "../../utils/common";
import { normalizeEvidenceRecords } from "./evidence";
import { normalizeSourceItemKeys } from "./note-source-provenance";
import { serializeQuotedMessageRefs } from "./quoted-messages";
import { stripPendingAndIncompleteToolCallContent } from "./interrupted-message";
import { getStorageDatabase } from "./db/StorageDatabase";
import {
  mapMessageRowToChatMessage,
  type MessageStorageRow,
  type QueryableDatabase,
} from "./db/MessageRowStorage";
import type { SearchBackfillSliceTiming } from "./search/SearchBackfill";
import { CURRENT_SEARCH_VERSION } from "./search/SearchProjection";
import {
  incrementSearchRevision,
  projectMessageSearchTextSafe,
  projectTitleSearchTextSafe,
  SessionSearchService,
  type ChatSearchState,
} from "./search/SessionSearchService";
import type {
  ChatHistoryMessagePage,
  ChatHistorySearchPage,
  SearchHistoryGroupsRequest,
  SearchHistorySessionMatchesRequest,
} from "./search/SearchTypes";

// Re-exported for existing importers: these symbols historically lived here.
export {
  mapMessageRowToChatMessage,
  type MessageStorageRow,
  type QueryableDatabase,
} from "./db/MessageRowStorage";

// 最大 session 数量限制
const MAX_SESSIONS = 1000;

type SessionRow = {
  id: string;
  created_at: number;
  updated_at: number;
  last_active_item_key: string | null;
  context_summary: string | null;
  context_state: string | null;
  execution_plan?: string | null;
  tool_execution_state?: string | null;
  tool_approval_state?: string | null;
  user_input_request_state?: string | null;
  memory_extracted_at: number | null;
  memory_extracted_msg_count: number | null;
  selected_tier: string | null;
  resolved_model_id: string | null;
  last_retryable_user_message_id: string | null;
  last_retryable_error_message_id: string | null;
  last_retryable_failed_model_id: string | null;
  title: string | null;
  title_source: string | null;
  title_generated_at: number | null;
  title_edited_at: number | null;
};

// Valid projection versions are non-negative. Current semantic writes first
// use this transaction-local sentinel so legacy invalidation triggers can
// distinguish an acknowledged source update even when its projection is equal.
const SEARCH_PROJECTION_WRITE_SENTINEL_VERSION = -1;

function serializeEvidenceRecords(value: unknown): string | null {
  const records = normalizeEvidenceRecords(value);
  return records.length > 0 ? JSON.stringify(records) : null;
}

function serializeSourceItemKeys(value: unknown): string | null {
  const keys = normalizeSourceItemKeys(value);
  return keys.length > 0 ? JSON.stringify(keys) : null;
}

export interface CreateSessionOptions {
  sessionId?: string;
  messages?: ChatMessage[];
  lastActiveItemKey?: string | null;
  selectedTier?: ChatSession["selectedTier"];
  resolvedModelId?: string;
  activate?: boolean;
}

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

function toValidSelectedTier(
  value: string | null,
): ChatSession["selectedTier"] {
  if (
    value === "paperchat-lite" ||
    value === "paperchat-standard" ||
    value === "paperchat-pro" ||
    value === "paperchat-ultra"
  ) {
    return value;
  }
  return undefined;
}

function toValidTitleSource(value: string | null): ChatSession["titleSource"] {
  if (value === "generated" || value === "user") {
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
    messages: filterValidMessages(messages),
    title: row.title || undefined,
    titleSource: toValidTitleSource(row.title_source),
    titleGeneratedAt:
      row.title_generated_at != null
        ? (row.title_generated_at as number)
        : undefined,
    titleEditedAt:
      row.title_edited_at != null ? (row.title_edited_at as number) : undefined,
    contextSummary: row.context_summary
      ? JSON.parse(row.context_summary)
      : undefined,
    contextState: row.context_state ? JSON.parse(row.context_state) : undefined,
    executionPlan: row.execution_plan
      ? JSON.parse(row.execution_plan)
      : undefined,
    toolExecutionState: row.tool_execution_state
      ? JSON.parse(row.tool_execution_state)
      : undefined,
    toolApprovalState: row.tool_approval_state
      ? JSON.parse(row.tool_approval_state)
      : undefined,
    userInputRequestState: row.user_input_request_state
      ? JSON.parse(row.user_input_request_state)
      : undefined,
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
    lastRetryableUserMessageId: row.last_retryable_user_message_id || undefined,
    lastRetryableErrorMessageId:
      row.last_retryable_error_message_id || undefined,
    lastRetryableFailedModelId: row.last_retryable_failed_model_id || undefined,
  };
}

function retainRecoverableToolExecutionState(
  state: ToolExecutionState | null | undefined,
  updatedAt: number,
): ToolExecutionState | undefined {
  const results = state?.results || [];
  if (results.length === 0) {
    return undefined;
  }
  return {
    turnStartedAt: state?.turnStartedAt || updatedAt,
    updatedAt,
    results,
  };
}

function parseRetainedToolExecutionState(
  raw: unknown,
  updatedAt: number,
): ToolExecutionState | undefined {
  if (typeof raw !== "string" || !raw) {
    return undefined;
  }
  try {
    return retainRecoverableToolExecutionState(
      JSON.parse(raw) as ToolExecutionState,
      updatedAt,
    );
  } catch {
    return undefined;
  }
}

export class SessionStorageService {
  private initialized: boolean = false;
  private activeSessionIdCache: string | null = null;
  private readonly search = new SessionSearchService({
    init: () => this.init(),
    runTransaction: <T>(operation: (db: QueryableDatabase) => Promise<T>) =>
      this.runTransaction(operation),
  });

  private async runTransaction<T>(
    operation: (db: QueryableDatabase) => Promise<T>,
  ): Promise<T> {
    return getStorageDatabase().executeTransaction(operation);
  }

  async getSearchState(): Promise<ChatSearchState> {
    return this.search.getSearchState();
  }

  async searchHistoryGroups(
    input: SearchHistoryGroupsRequest,
  ): Promise<ChatHistorySearchPage> {
    return this.search.searchHistoryGroups(input);
  }

  async searchHistorySessionMatches(
    input: SearchHistorySessionMatchesRequest,
  ): Promise<ChatHistoryMessagePage> {
    return this.search.searchHistorySessionMatches(input);
  }

  /**
   * Start the invisible search-index backfill. The caller intentionally does
   * not await this method: each bounded slice yields through a zero-delay timer
   * before the next slice is considered.
   */
  startSearchBackfill(): void {
    this.search.startSearchBackfill();
  }

  /** Prevent a future slice from starting. Calls are reference-counted. */
  pauseSearchBackfill(): void {
    this.search.pauseSearchBackfill();
  }

  /** Await the slice that had already started before a foreground search. */
  async awaitActiveSearchBackfill(): Promise<void> {
    await this.search.awaitActiveSearchBackfill();
  }

  /** Release one foreground pause and resume scheduling when all have left. */
  resumeSearchBackfill(): void {
    this.search.resumeSearchBackfill();
  }

  /** Cancel future slices and drain the active one before database shutdown. */
  async stopSearchBackfill(): Promise<void> {
    await this.search.stopSearchBackfill();
  }

  /** Last measured complete-slice and transaction-callback occupancy. */
  getLastSearchBackfillTiming(): SearchBackfillSliceTiming | null {
    return this.search.getLastSearchBackfillTiming();
  }

  /**
   * 初始化存储服务
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const db = await getStorageDatabase().ensureInit();

      await this.search.initializeSearchState();

      // Load activeSessionId from settings
      const rows =
        (await db.queryAsync("SELECT value FROM settings WHERE key = ?", [
          "active_session_id",
        ])) || [];

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
        if (msg.content && msg.role !== "tool" && !msg.apiOnly) {
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
      messageCount: session.messages?.filter((msg) => !msg.apiOnly).length || 0,
      lastMessagePreview,
      lastMessageTime,
      title: session.title,
      titleSource: session.titleSource,
      titleGeneratedAt: session.titleGeneratedAt,
      titleEditedAt: session.titleEditedAt,
    };
  }

  /**
   * 生成新的 session ID (timestamp-uuid 格式)
   */
  private generateSessionId(): string {
    return `${Date.now()}-${generateShortId()}`;
  }

  private async refreshSessionMetaAfterMessageDeletion(
    db: QueryableDatabase,
    sessionId: string,
    updatedAt: number,
  ): Promise<void> {
    const countRows =
      (await db.queryAsync(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE session_id = ? AND COALESCE(api_only, 0) = 0`,
        [sessionId],
      )) || [];
    const previewRows =
      (await db.queryAsync(
        `SELECT content, timestamp
         FROM messages
         WHERE session_id = ?
           AND role != 'tool'
           AND COALESCE(api_only, 0) = 0
           AND content != ''
         ORDER BY seq DESC
         LIMIT 1`,
        [sessionId],
      )) || [];
    const lastMessage = previewRows[0];
    const content = String(lastMessage?.content || "");
    const preview =
      content.substring(0, 50) + (content.length > 50 ? "..." : "");

    await db.queryAsync(
      `UPDATE session_meta SET
        message_count = ?,
        last_message_preview = ?,
        last_message_time = ?,
        updated_at = ?
      WHERE id = ?`,
      [
        Number(countRows[0]?.count || 0),
        preview,
        lastMessage?.timestamp ?? updatedAt,
        updatedAt,
        sessionId,
      ],
    );
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
      await getStorageDatabase().ensureInit();
      const now = Date.now();
      const messageTimestamp = message.timestamp || now;
      const searchProjection = projectMessageSearchTextSafe(message);
      const messageCountDelta = message.apiOnly ? 0 : 1;
      const preview =
        !message.apiOnly && message.role !== "tool" && message.content
          ? message.content.substring(0, 50) +
            (message.content.length > 50 ? "..." : "")
          : undefined;

      await this.runTransaction(async (db) => {
        // Sequence allocation and insert share the same exclusive transaction.
        const seqRows =
          (await db.queryAsync(
            "SELECT COALESCE(MAX(seq), -1) as max_seq FROM messages WHERE session_id = ?",
            [sessionId],
          )) || [];
        const nextSeq = (seqRows[0]?.max_seq ?? -1) + 1;

        await db.queryAsync(
          `INSERT INTO messages
           (id, session_id, seq, role, content, reasoning, images, files, quoted_messages, timestamp, pdf_context, selected_text, tool_calls, tool_call_id, evidence, source_item_keys, streaming_state, api_only, is_system_notice, search_text, search_index_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            message.id,
            sessionId,
            nextSeq,
            message.role,
            message.content || "",
            message.reasoning || null,
            message.images ? JSON.stringify(message.images) : null,
            message.files ? JSON.stringify(message.files) : null,
            serializeQuotedMessageRefs(message.quotedMessages),
            messageTimestamp,
            message.pdfContext ? 1 : null,
            message.selectedText || null,
            message.tool_calls ? JSON.stringify(message.tool_calls) : null,
            message.tool_call_id || null,
            serializeEvidenceRecords(message.evidence),
            serializeSourceItemKeys(message.sourceItemKeys),
            message.streamingState || null,
            message.apiOnly ? 1 : null,
            message.isSystemNotice ? 1 : null,
            searchProjection.searchText,
            searchProjection.searchIndexVersion,
          ],
        );

        if (preview !== undefined) {
          await db.queryAsync(
            `UPDATE session_meta SET
              message_count = message_count + ?,
              last_message_preview = ?,
              last_message_time = ?,
              updated_at = ?
            WHERE id = ?`,
            [messageCountDelta, preview, messageTimestamp, now, sessionId],
          );
        } else {
          await db.queryAsync(
            `UPDATE session_meta SET
              message_count = message_count + ?,
              updated_at = ?
            WHERE id = ?`,
            [messageCountDelta, now, sessionId],
          );
        }

        await db.queryAsync("UPDATE sessions SET updated_at = ? WHERE id = ?", [
          now,
          sessionId,
        ]);
        await incrementSearchRevision(db, now);
      });
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
      await getStorageDatabase().ensureInit();
      const now = Date.now();

      await this.runTransaction(async (db) => {
        const rows =
          (await db.queryAsync(
            "SELECT id FROM messages WHERE id = ? AND session_id = ?",
            [messageId, sessionId],
          )) || [];
        if (rows.length === 0) return;

        await db.queryAsync(
          "DELETE FROM messages WHERE id = ? AND session_id = ?",
          [messageId, sessionId],
        );
        await this.refreshSessionMetaAfterMessageDeletion(db, sessionId, now);
        await db.queryAsync("UPDATE sessions SET updated_at = ? WHERE id = ?", [
          now,
          sessionId,
        ]);
        await incrementSearchRevision(db, now);
      });
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
      await getStorageDatabase().ensureInit();
      const now = Date.now();

      await this.runTransaction(async (db) => {
        const rows =
          (await db.queryAsync(
            "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
            [sessionId],
          )) || [];
        if (Number(rows[0]?.count || 0) === 0) return;

        await db.queryAsync("DELETE FROM messages WHERE session_id = ?", [
          sessionId,
        ]);
        await db.queryAsync(
          `UPDATE session_meta SET
            message_count = 0,
            last_message_preview = '',
            last_message_time = ?,
            updated_at = ?
          WHERE id = ?`,
          [now, now, sessionId],
        );
        await db.queryAsync("UPDATE sessions SET updated_at = ? WHERE id = ?", [
          now,
          sessionId,
        ]);
        await incrementSearchRevision(db, now);
      });
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Delete all messages error:", error);
      throw error;
    }
  }

  /**
   * 更新消息内容 (streaming 完成后更新 assistant message 的最终内容)
   */
  async updateMessageContent(
    sessionId: string,
    messageId: string,
    content: string,
    reasoning?: string,
    options?: {
      streamingState?: ChatMessageStreamingState | null;
      evidence?: EvidenceRecord[];
      sourceItemKeys?: string[];
    },
  ): Promise<void> {
    await this.init();

    try {
      await getStorageDatabase().ensureInit();
      const now = Date.now();

      await this.runTransaction(async (db) => {
        const rows =
          (await db.queryAsync(
            "SELECT * FROM messages WHERE id = ? AND session_id = ?",
            [messageId, sessionId],
          )) || [];
        if (rows.length === 0) return;

        const previousMessage = mapMessageRowToChatMessage(
          rows[0] as MessageStorageRow,
        );
        const nextEvidence = Object.prototype.hasOwnProperty.call(
          options || {},
          "evidence",
        )
          ? normalizeEvidenceRecords(options?.evidence)
          : previousMessage.evidence;
        const nextSourceItemKeys = Object.prototype.hasOwnProperty.call(
          options || {},
          "sourceItemKeys",
        )
          ? normalizeSourceItemKeys(options?.sourceItemKeys)
          : previousMessage.sourceItemKeys;
        const nextMessage: ChatMessage = {
          ...previousMessage,
          content,
          reasoning,
          timestamp: now,
          streamingState: options?.streamingState ?? undefined,
          evidence: nextEvidence,
          sourceItemKeys:
            nextSourceItemKeys && nextSourceItemKeys.length > 0
              ? nextSourceItemKeys
              : undefined,
        };
        const previousProjection =
          projectMessageSearchTextSafe(previousMessage);
        const nextProjection = projectMessageSearchTextSafe(nextMessage);

        await db.queryAsync(
          `UPDATE messages
           SET search_index_version = ?
           WHERE id = ? AND session_id = ?`,
          [SEARCH_PROJECTION_WRITE_SENTINEL_VERSION, messageId, sessionId],
        );
        await db.queryAsync(
          `UPDATE messages SET
            content = ?, reasoning = ?, timestamp = ?, streaming_state = ?, evidence = ?, source_item_keys = ?,
            search_text = ?, search_index_version = ?
          WHERE id = ? AND session_id = ?`,
          [
            content,
            reasoning || null,
            now,
            options?.streamingState ?? null,
            serializeEvidenceRecords(nextEvidence),
            serializeSourceItemKeys(nextSourceItemKeys),
            nextProjection.searchText,
            nextProjection.searchIndexVersion,
            messageId,
            sessionId,
          ],
        );

        // Only update the history preview on the final flush. In-progress
        // checkpoints remain excluded and do not invalidate search pages.
        if (!options?.streamingState) {
          const preview =
            content.substring(0, 50) + (content.length > 50 ? "..." : "");
          await db.queryAsync(
            `UPDATE session_meta SET
            last_message_preview = ?,
            last_message_time = ?,
            updated_at = ?
          WHERE id = ?`,
            [preview, now, now, sessionId],
          );
          await db.queryAsync(
            "UPDATE sessions SET updated_at = ? WHERE id = ?",
            [now, sessionId],
          );
        }

        // A failed projection is indistinguishable from a semantic change,
        // so bump the revision conservatively in that case.
        if (
          !options?.streamingState ||
          previousProjection.failed ||
          nextProjection.failed ||
          previousProjection.searchText.length > 0 ||
          nextProjection.searchText.length > 0
        ) {
          await incrementSearchRevision(db, now);
        }
      });
    } catch (error) {
      ztoolkit.log(
        "[SessionStorageService] Update message content error:",
        error,
      );
      throw error;
    }
  }

  /**
   * 仅更新 session 元数据 (不涉及 messages)
   */
  async updateSessionMeta(session: ChatSession): Promise<void> {
    await this.init();

    try {
      await getStorageDatabase().ensureInit();
      const nextUpdatedAt = Date.now();
      const titleProjection = projectTitleSearchTextSafe(session.title || "");
      await this.runTransaction(async (db) => {
        await db.queryAsync(
          `UPDATE sessions SET
            updated_at = ?,
            last_active_item_key = ?,
            title = ?,
            title_source = ?,
            title_generated_at = ?,
            title_edited_at = ?,
            context_summary = ?,
            context_state = ?,
            execution_plan = ?,
            tool_execution_state = ?,
            tool_approval_state = ?,
            user_input_request_state = ?
          WHERE id = ?`,
          [
            nextUpdatedAt,
            session.lastActiveItemKey || null,
            session.title || null,
            session.titleSource || null,
            session.titleGeneratedAt ?? null,
            session.titleEditedAt ?? null,
            session.contextSummary
              ? JSON.stringify(session.contextSummary)
              : null,
            session.contextState ? JSON.stringify(session.contextState) : null,
            session.executionPlan
              ? JSON.stringify(session.executionPlan)
              : null,
            session.toolExecutionState
              ? JSON.stringify(session.toolExecutionState)
              : null,
            session.toolApprovalState
              ? JSON.stringify(session.toolApprovalState)
              : null,
            session.userInputRequestState
              ? JSON.stringify(session.userInputRequestState)
              : null,
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
          `UPDATE session_meta
           SET search_index_version = ?
           WHERE id = ?`,
          [SEARCH_PROJECTION_WRITE_SENTINEL_VERSION, session.id],
        );
        await db.queryAsync(
          `UPDATE session_meta SET
            updated_at = ?,
            title = ?,
            title_source = ?,
            title_generated_at = ?,
            title_edited_at = ?,
            search_title = ?,
            search_index_version = ?
          WHERE id = ?`,
          [
            nextUpdatedAt,
            session.title || null,
            session.titleSource || null,
            session.titleGeneratedAt ?? null,
            session.titleEditedAt ?? null,
            titleProjection.searchText,
            titleProjection.searchIndexVersion,
            session.id,
          ],
        );
        await incrementSearchRevision(db, nextUpdatedAt);
      });
      // Only mutate caller state after the write committed.
      session.updatedAt = nextUpdatedAt;
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Update session meta error:", error);
      throw error;
    }
  }

  /** Persist approval state and its ranking timestamp atomically. */
  async updateSessionApprovalState(session: ChatSession): Promise<void> {
    await this.init();

    try {
      await getStorageDatabase().ensureInit();
      const nextUpdatedAt = Date.now();
      await this.runTransaction(async (db) => {
        await db.queryAsync(
          `UPDATE sessions SET
            updated_at = ?,
            tool_approval_state = ?
          WHERE id = ?`,
          [
            nextUpdatedAt,
            session.toolApprovalState
              ? JSON.stringify(session.toolApprovalState)
              : null,
            session.id,
          ],
        );
        await db.queryAsync(
          "UPDATE session_meta SET updated_at = ? WHERE id = ?",
          [nextUpdatedAt, session.id],
        );
        await incrementSearchRevision(db, nextUpdatedAt);
      });
      session.updatedAt = nextUpdatedAt;
    } catch (error) {
      ztoolkit.log(
        "[SessionStorageService] Update session approval state error:",
        error,
      );
      throw error;
    }
  }

  /** Persist user-input request state and ranking timestamp atomically. */
  async updateSessionUserInputRequestState(
    session: ChatSession,
  ): Promise<void> {
    await this.init();

    try {
      await getStorageDatabase().ensureInit();
      const nextUpdatedAt = Date.now();
      await this.runTransaction(async (db) => {
        await db.queryAsync(
          `UPDATE sessions SET
            updated_at = ?,
            user_input_request_state = ?
          WHERE id = ?`,
          [
            nextUpdatedAt,
            session.userInputRequestState
              ? JSON.stringify(session.userInputRequestState)
              : null,
            session.id,
          ],
        );
        await db.queryAsync(
          "UPDATE session_meta SET updated_at = ? WHERE id = ?",
          [nextUpdatedAt, session.id],
        );
        await incrementSearchRevision(db, nextUpdatedAt);
      });
      session.updatedAt = nextUpdatedAt;
    } catch (error) {
      ztoolkit.log(
        "[SessionStorageService] Update session user-input request state error:",
        error,
      );
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
      ztoolkit.log(
        "[SessionStorageService] updateMemoryExtractionState error:",
        error,
      );
      throw error;
    }
  }

  // ============================================
  // Session-level CRUD
  // ============================================

  /**
   * 创建新 session
   */
  async createSession(
    options: CreateSessionOptions = {},
  ): Promise<ChatSession> {
    await this.init();

    const sessionId = options.sessionId ?? this.generateSessionId();
    if (!/^[A-Za-z0-9_.-]{1,96}$/.test(sessionId)) {
      throw new Error("Invalid session id.");
    }
    const now = Date.now();

    const session: ChatSession = {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      lastActiveItemKey: options.lastActiveItemKey ?? null,
      messages: options.messages ?? [],
      selectedTier: options.selectedTier,
      resolvedModelId: options.resolvedModelId,
    };

    // 保存 session（full write，也支持一次性写入分叉历史）
    await this.saveSession(session);

    if (options.activate !== false) {
      // 设置为活动 session
      await this.setActiveSession(sessionId);
    }

    ztoolkit.log("[SessionStorageService] New session created:", sessionId);
    return session;
  }

  /**
   * 保存 session (全量写入 — 用于 create/migration/destroy)
   */
  async saveSession(session: ChatSession): Promise<void> {
    await this.init();

    try {
      await getStorageDatabase().ensureInit();
      const nextUpdatedAt = Date.now();
      const sessionForMeta: ChatSession = {
        ...session,
        updatedAt: nextUpdatedAt,
      };

      const meta = this.buildSessionMeta(sessionForMeta);
      const titleProjection = projectTitleSearchTextSafe(session.title || "");
      const messagesForStorage = (session.messages || []).map((message) => ({
        message,
        searchProjection: projectMessageSearchTextSafe(message),
        timestamp: message.timestamp || nextUpdatedAt,
      }));

      await this.runTransaction(async (db) => {
        // Upsert session (no messages column)
        await db.queryAsync(
          `INSERT INTO sessions
           (id, created_at, updated_at, last_active_item_key, title, title_source, title_generated_at, title_edited_at, context_summary, context_state, execution_plan, tool_execution_state, tool_approval_state, user_input_request_state, memory_extracted_at, memory_extracted_msg_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             last_active_item_key = excluded.last_active_item_key,
             title = excluded.title,
             title_source = excluded.title_source,
             title_generated_at = excluded.title_generated_at,
             title_edited_at = excluded.title_edited_at,
             context_summary = excluded.context_summary,
             context_state = excluded.context_state,
             execution_plan = excluded.execution_plan,
             tool_execution_state = excluded.tool_execution_state,
             tool_approval_state = excluded.tool_approval_state,
             user_input_request_state = excluded.user_input_request_state,
             memory_extracted_at = excluded.memory_extracted_at,
             memory_extracted_msg_count = excluded.memory_extracted_msg_count`,
          [
            session.id,
            session.createdAt,
            nextUpdatedAt,
            session.lastActiveItemKey || null,
            session.title || null,
            session.titleSource || null,
            session.titleGeneratedAt ?? null,
            session.titleEditedAt ?? null,
            session.contextSummary
              ? JSON.stringify(session.contextSummary)
              : null,
            session.contextState ? JSON.stringify(session.contextState) : null,
            session.executionPlan
              ? JSON.stringify(session.executionPlan)
              : null,
            session.toolExecutionState
              ? JSON.stringify(session.toolExecutionState)
              : null,
            session.toolApprovalState
              ? JSON.stringify(session.toolApprovalState)
              : null,
            session.userInputRequestState
              ? JSON.stringify(session.userInputRequestState)
              : null,
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
        await db.queryAsync("DELETE FROM messages WHERE session_id = ?", [
          session.id,
        ]);

        if (messagesForStorage.length > 0) {
          for (let seq = 0; seq < messagesForStorage.length; seq++) {
            const {
              message: msg,
              searchProjection,
              timestamp,
            } = messagesForStorage[seq];
            await db.queryAsync(
              `INSERT INTO messages
               (id, session_id, seq, role, content, reasoning, images, files, quoted_messages, timestamp, pdf_context, selected_text, tool_calls, tool_call_id, evidence, source_item_keys, streaming_state, api_only, is_system_notice, search_text, search_index_version)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                msg.id,
                session.id,
                seq,
                msg.role,
                msg.content || "",
                msg.reasoning || null,
                msg.images ? JSON.stringify(msg.images) : null,
                msg.files ? JSON.stringify(msg.files) : null,
                serializeQuotedMessageRefs(msg.quotedMessages),
                timestamp,
                msg.pdfContext ? 1 : null,
                msg.selectedText || null,
                msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
                msg.tool_call_id || null,
                serializeEvidenceRecords(msg.evidence),
                serializeSourceItemKeys(msg.sourceItemKeys),
                msg.streamingState || null,
                msg.apiOnly ? 1 : null,
                msg.isSystemNotice ? 1 : null,
                searchProjection.searchText,
                searchProjection.searchIndexVersion,
              ],
            );
          }
        }

        // Upsert session_meta
        await db.queryAsync(
          `INSERT OR REPLACE INTO session_meta
           (id, created_at, updated_at, message_count, last_message_preview, last_message_time, title, title_source, title_generated_at, title_edited_at, search_title, search_index_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            meta.id,
            meta.createdAt,
            meta.updatedAt,
            meta.messageCount,
            meta.lastMessagePreview,
            meta.lastMessageTime,
            meta.title || null,
            meta.titleSource || null,
            meta.titleGeneratedAt ?? null,
            meta.titleEditedAt ?? null,
            titleProjection.searchText,
            titleProjection.searchIndexVersion,
          ],
        );
        await incrementSearchRevision(db, nextUpdatedAt);
      });
      // Only mutate caller state after the write committed.
      session.updatedAt = nextUpdatedAt;

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
      await this.markInterruptedMessages(sessionId);
      const db = await getStorageDatabase().ensureInit();

      // 1. Load session row (without messages)
      const sessionRows =
        (await db.queryAsync("SELECT * FROM sessions WHERE id = ?", [
          sessionId,
        ])) || [];

      if (sessionRows.length === 0) {
        return null;
      }

      const baseRowRaw = sessionRows[0] as Partial<SessionRow> &
        Record<string, unknown>;
      const baseRow: SessionRow = {
        id: String(baseRowRaw.id || ""),
        created_at: Number(baseRowRaw.created_at || 0),
        updated_at: Number(baseRowRaw.updated_at || 0),
        last_active_item_key:
          typeof baseRowRaw.last_active_item_key === "string"
            ? baseRowRaw.last_active_item_key
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
        tool_execution_state:
          typeof baseRowRaw.tool_execution_state === "string"
            ? baseRowRaw.tool_execution_state
            : null,
        tool_approval_state:
          typeof baseRowRaw.tool_approval_state === "string"
            ? baseRowRaw.tool_approval_state
            : null,
        user_input_request_state:
          typeof baseRowRaw.user_input_request_state === "string"
            ? baseRowRaw.user_input_request_state
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
        title: typeof baseRowRaw.title === "string" ? baseRowRaw.title : null,
        title_source:
          typeof baseRowRaw.title_source === "string"
            ? baseRowRaw.title_source
            : null,
        title_generated_at:
          typeof baseRowRaw.title_generated_at === "number"
            ? baseRowRaw.title_generated_at
            : null,
        title_edited_at:
          typeof baseRowRaw.title_edited_at === "number"
            ? baseRowRaw.title_edited_at
            : null,
      };
      const paperchatStateRows =
        (await db.queryAsync(
          "SELECT * FROM paperchat_session_state WHERE session_id = ?",
          [sessionId],
        )) || [];
      const paperchatState = paperchatStateRows[0] as
        | Partial<SessionRow>
        | undefined;
      const row: SessionRow = {
        ...baseRow,
        selected_tier: paperchatState?.selected_tier ?? baseRow.selected_tier,
        resolved_model_id:
          paperchatState?.resolved_model_id ?? baseRow.resolved_model_id,
        last_retryable_user_message_id:
          paperchatState?.last_retryable_user_message_id ??
          baseRow.last_retryable_user_message_id,
        last_retryable_error_message_id:
          paperchatState?.last_retryable_error_message_id ??
          baseRow.last_retryable_error_message_id,
        last_retryable_failed_model_id:
          paperchatState?.last_retryable_failed_model_id ??
          baseRow.last_retryable_failed_model_id,
      };

      // 2. Load messages from messages table
      const messageRows =
        (await db.queryAsync(
          "SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC",
          [sessionId],
        )) || [];

      const messages: ChatMessage[] = messageRows.map((row: any) =>
        mapMessageRowToChatMessage(row as MessageStorageRow),
      );

      const session = mapSessionRowToChatSession(row, messages);
      await this.clearRecoveredTurnArtifacts(session);
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
      await this.deleteSessionData(sessionId);

      // If deleted session was active, switch to most recent
      if (this.activeSessionIdCache === sessionId) {
        const metaRows =
          (await db.queryAsync(
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
      const rows =
        (await db.queryAsync(
          "SELECT * FROM session_meta WHERE message_count > 0 ORDER BY updated_at DESC",
        )) || [];

      return rows.map((row: any) => ({
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
        lastMessagePreview: row.last_message_preview,
        lastMessageTime: row.last_message_time,
        title: row.title || undefined,
        titleSource: toValidTitleSource(row.title_source),
        titleGeneratedAt:
          row.title_generated_at != null ? row.title_generated_at : undefined,
        titleEditedAt:
          row.title_edited_at != null ? row.title_edited_at : undefined,
      }));
    } catch (error) {
      ztoolkit.log("[SessionStorageService] List sessions error:", error);
      throw error;
    }
  }

  async updateSessionTitle(
    sessionId: string,
    title: string | null,
    source: "generated" | "user",
    timestamp: number = Date.now(),
  ): Promise<void> {
    await this.init();

    try {
      await getStorageDatabase().ensureInit();
      const normalizedTitle = title?.trim() || null;
      const titleSource = normalizedTitle || source === "user" ? source : null;
      const titleGeneratedAt =
        normalizedTitle && source === "generated" ? timestamp : null;
      const titleEditedAt = source === "user" ? timestamp : null;
      const titleProjection = projectTitleSearchTextSafe(normalizedTitle || "");

      await this.runTransaction(async (db) => {
        await db.queryAsync(
          `UPDATE sessions SET
            title = ?,
            title_source = ?,
            title_generated_at = ?,
            title_edited_at = ?
          WHERE id = ?`,
          [
            normalizedTitle,
            titleSource,
            titleGeneratedAt,
            titleEditedAt,
            sessionId,
          ],
        );
        await db.queryAsync(
          `UPDATE session_meta
           SET search_index_version = ?
           WHERE id = ?`,
          [SEARCH_PROJECTION_WRITE_SENTINEL_VERSION, sessionId],
        );
        await db.queryAsync(
          `UPDATE session_meta SET
            title = ?,
            title_source = ?,
            title_generated_at = ?,
            title_edited_at = ?,
            search_title = ?,
            search_index_version = ?
          WHERE id = ?`,
          [
            normalizedTitle,
            titleSource,
            titleGeneratedAt,
            titleEditedAt,
            titleProjection.searchText,
            titleProjection.searchIndexVersion,
            sessionId,
          ],
        );
        await incrementSearchRevision(db, timestamp);
      });
    } catch (error) {
      ztoolkit.log(
        "[SessionStorageService] Update session title error:",
        error,
      );
      throw error;
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
        await db.queryAsync("DELETE FROM settings WHERE key = ?", [
          "active_session_id",
        ]);
      }

      this.activeSessionIdCache = sessionId;
    } catch (error) {
      ztoolkit.log("[SessionStorageService] Set active session error:", error);
      throw error;
    }
  }

  /**
   * 清理被放弃的草稿 session。
   *
   * Abandoned draft 的定义比“空 session”更窄：非当前活动会话、
   * session_meta 计数为 0、messages 表没有任何记录、并且没有用户/生成标题。
   * 这样可以清理启动/切换过程中遗留的隐藏草稿，同时避免删除旧版本里可能
   * 被用户命名过的空会话。
   */
  async cleanupAbandonedDraftSessions(): Promise<number> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      const activeId = this.activeSessionIdCache;

      const rows =
        (await db.queryAsync(
          `SELECT sm.id
           FROM session_meta sm
           WHERE sm.message_count = 0
             AND sm.id != ?
             AND NOT EXISTS (
               SELECT 1 FROM messages m WHERE m.session_id = sm.id
             )
             AND (sm.title IS NULL OR TRIM(sm.title) = '')
             AND sm.title_source IS NULL
             AND sm.title_generated_at IS NULL
             AND sm.title_edited_at IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM sessions s
               WHERE s.id = sm.id
                 AND (
                   (s.title IS NOT NULL AND TRIM(s.title) != '')
                   OR s.title_source IS NOT NULL
                   OR s.title_generated_at IS NOT NULL
                   OR s.title_edited_at IS NOT NULL
                 )
             )`,
          [activeId || ""],
        )) || [];

      for (const row of rows) {
        await this.deleteSessionData(row.id);
      }

      ztoolkit.log(
        "[SessionStorageService] Cleaned up abandoned draft sessions:",
        rows.length,
      );
      return rows.length;
    } catch (error) {
      ztoolkit.log(
        "[SessionStorageService] Abandoned draft cleanup error:",
        error,
      );
      return 0;
    }
  }

  /**
   * 强制执行最大 session 数量限制
   */
  private async enforceMaxSessions(): Promise<void> {
    try {
      const db = await getStorageDatabase().ensureInit();

      const countRows =
        (await db.queryAsync("SELECT COUNT(*) as count FROM session_meta")) ||
        [];

      const totalCount = countRows[0]?.count || 0;
      if (totalCount <= MAX_SESSIONS) return;

      // Find sessions to delete: oldest beyond MAX_SESSIONS, excluding active
      const activeId = this.activeSessionIdCache;
      const toDeleteRows =
        (await db.queryAsync(
          `SELECT id FROM session_meta
         WHERE id != ?
         ORDER BY updated_at DESC
         LIMIT -1 OFFSET ?`,
          [activeId || "", MAX_SESSIONS - 1],
        )) || [];

      for (const row of toDeleteRows) {
        await this.deleteSessionData(row.id);
      }

      if (toDeleteRows.length > 0) {
        ztoolkit.log(
          "[SessionStorageService] Enforced max sessions limit, deleted:",
          toDeleteRows.length,
        );
      }
    } catch (error) {
      ztoolkit.log(
        "[SessionStorageService] Enforce max sessions error:",
        error,
      );
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
      throw new MissingActiveSessionError(
        `Active session ${activeId} is missing`,
      );
    }

    return this.createSession();
  }

  private async markInterruptedMessages(sessionId: string): Promise<void> {
    await getStorageDatabase().ensureInit();
    const now = Date.now();
    await this.runTransaction(async (tx) => {
      const rows =
        (await tx.queryAsync(
          `SELECT id, content
           FROM messages
           WHERE session_id = ? AND streaming_state = 'in_progress'`,
          [sessionId],
        )) || [];
      if (rows.length === 0) return;

      const sessionRows =
        (await tx.queryAsync(
          "SELECT tool_execution_state FROM sessions WHERE id = ?",
          [sessionId],
        )) || [];
      const retainedToolExecutionState = parseRetainedToolExecutionState(
        sessionRows[0]?.tool_execution_state,
        now,
      );

      await tx.queryAsync(
        `UPDATE messages
         SET search_index_version = ?
         WHERE session_id = ? AND streaming_state = 'in_progress'`,
        [SEARCH_PROJECTION_WRITE_SENTINEL_VERSION, sessionId],
      );
      for (const row of rows) {
        await tx.queryAsync(
          `UPDATE messages
           SET content = ?,
               streaming_state = 'interrupted',
               search_text = '',
               search_index_version = ?
           WHERE id = ? AND session_id = ? AND streaming_state = 'in_progress'`,
          [
            stripPendingAndIncompleteToolCallContent(row.content || ""),
            CURRENT_SEARCH_VERSION,
            row.id,
            sessionId,
          ],
        );
      }
      await tx.queryAsync(
        `UPDATE sessions
         SET execution_plan = NULL,
             tool_execution_state = ?,
             tool_approval_state = NULL,
             updated_at = ?
         WHERE id = ?`,
        [
          retainedToolExecutionState
            ? JSON.stringify(retainedToolExecutionState)
            : null,
          now,
          sessionId,
        ],
      );
      await tx.queryAsync(
        `UPDATE session_meta
         SET updated_at = ?
         WHERE id = ?`,
        [now, sessionId],
      );
      await incrementSearchRevision(tx, now);
    });
  }

  private async clearRecoveredTurnArtifacts(
    session: ChatSession,
  ): Promise<void> {
    if (
      !session.executionPlan &&
      !session.toolExecutionState &&
      !session.toolApprovalState
    ) {
      return;
    }

    const hasInterruptedAssistant = session.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.streamingState === "interrupted",
    );
    if (!hasInterruptedAssistant) {
      return;
    }

    await getStorageDatabase().ensureInit();
    const now = Date.now();
    const retainedToolExecutionState = retainRecoverableToolExecutionState(
      session.toolExecutionState,
      now,
    );
    await this.runTransaction(async (db) => {
      await db.queryAsync(
        `UPDATE sessions
         SET execution_plan = NULL,
             tool_execution_state = ?,
             tool_approval_state = NULL,
             updated_at = ?
         WHERE id = ?`,
        [
          retainedToolExecutionState
            ? JSON.stringify(retainedToolExecutionState)
            : null,
          now,
          session.id,
        ],
      );
      await db.queryAsync(
        `UPDATE session_meta
         SET updated_at = ?
         WHERE id = ?`,
        [now, session.id],
      );
      await incrementSearchRevision(db, now);
    });

    session.executionPlan = undefined;
    session.toolExecutionState = retainedToolExecutionState;
    session.toolApprovalState = undefined;
    session.updatedAt = now;
  }

  private async deleteSessionData(sessionId: string): Promise<void> {
    await this.runTransaction(async (db) => {
      const sessionRows =
        (await db.queryAsync("SELECT id FROM sessions WHERE id = ?", [
          sessionId,
        ])) || [];
      await db.queryAsync(
        "DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE session_id = ?)",
        [sessionId],
      );
      await db.queryAsync("DELETE FROM tasks WHERE session_id = ?", [
        sessionId,
      ]);
      await db.queryAsync(
        "DELETE FROM paperchat_session_state WHERE session_id = ?",
        [sessionId],
      );
      await db.queryAsync("DELETE FROM messages WHERE session_id = ?", [
        sessionId,
      ]);
      await db.queryAsync("DELETE FROM session_meta WHERE id = ?", [sessionId]);
      await db.queryAsync("DELETE FROM sessions WHERE id = ?", [sessionId]);
      if (sessionRows.length > 0) {
        await incrementSearchRevision(db);
      }
    });
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
