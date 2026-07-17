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
} from "../../types/chat";
import { filterValidMessages, generateShortId } from "../../utils/common";
import { getStorageDatabase } from "./db/StorageDatabase";
import {
  aggregateSearchSessions,
  createNextMessageCursorForSearchGroup,
  LowerVersionMessagePartitionAccumulator,
  paginateSearchMessages,
  paginateSearchSessions,
  validateMessageSearchCursor,
  validateSessionSearchCursor,
  type AggregatedSearchMessageCandidate,
  type AggregatedSearchSession,
  type IndexedMessageSearchSummary,
  type IndexedSearchMessageCandidate,
  type IndexedTitleSearchCandidate,
  type LowerVersionMessageSearchCandidate,
  type LowerVersionTitleSearchCandidate,
  type SearchSessionMetadata,
} from "./search/SearchAggregation";
import {
  adaptSearchBackfillBatchSize,
  createMessageProjectionSignature,
  createTitleProjectionSignature,
  INITIAL_SEARCH_BACKFILL_BATCH_SIZE,
  type MessageProjectionSource,
  type SearchBackfillSliceTiming,
} from "./search/SearchBackfill";
import {
  compareMessageSearchOrder,
  createSearchQueryKey,
  type MessageSearchOrder,
} from "./search/SearchCursor";
import {
  buildVisibleSearchSegments,
  createSearchSnippet,
  CURRENT_SEARCH_VERSION,
  getMessageSearchFastDecision,
  projectMessageSearchNormalizedText,
  projectSearchDocument,
  projectSearchNormalizedText,
  projectSearchTitle,
} from "./search/SearchProjection";
import {
  classifyMessageMatch,
  parseSearchQuery,
  type ParsedSearchQuery,
} from "./search/SearchQuery";
import {
  buildAllSourceMessagePageSql,
  buildAllSourceSessionMessagePageSql,
  buildIndexedMessageCandidatesSql,
  buildIndexedMessageSummarySql,
  buildIndexedSessionMessagePageSql,
  buildIndexedSessionMessageSummarySql,
  buildIndexedTitleMatchesSql,
  buildLowerVersionMessagePageSql,
  buildLowerVersionSessionMessagePageSql,
  buildLowerVersionTitlePageSql,
} from "./search/SearchSql";
import {
  ChatHistorySearchError,
  type ChatHistoryMessageMatch,
  type ChatHistoryMessagePage,
  type ChatHistorySearchGroup,
  type ChatHistorySearchPage,
  type SearchHistoryGroupsRequest,
  type SearchHistorySessionMatchesRequest,
} from "./search/SearchTypes";

// 最大 session 数量限制
const MAX_SESSIONS = 1000;
const MAX_SEARCH_SESSION_PAGE_SIZE = 20;
const INITIAL_SEARCH_MESSAGE_PAGE_SIZE = 3;
const MAX_SEARCH_MESSAGE_PAGE_SIZE = 10;
const SEARCH_SOURCE_SCAN_PAGE_SIZE = 100;
const SEARCH_SQL_SESSION_CHUNK_SIZE = 250;
const SEARCH_BACKFILL_RETRY_BASE_DELAY_MS = 250;
const SEARCH_BACKFILL_RETRY_MAX_DELAY_MS = 30_000;

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

export type QueryableDatabase = {
  queryAsync(sql: string, params?: unknown[]): Promise<any[] | undefined>;
};

export interface ChatSearchState {
  targetVersion: number;
  completed: boolean;
  revisionEpoch: string;
  searchRevision: number;
  updatedAt: number;
}

export interface MessageStorageRow {
  id: string;
  role: ChatMessage["role"];
  content: string | null;
  reasoning?: string | null;
  images?: string | null;
  files?: string | null;
  timestamp: number;
  pdf_context?: number | null;
  selected_text?: string | null;
  tool_calls?: string | null;
  tool_call_id?: string | null;
  streaming_state?: ChatMessageStreamingState | null;
  api_only?: number | null;
  is_system_notice?: number | null;
  search_text?: string | null;
  search_index_version?: number | null;
}

type SearchBackfillWorkKind = "message" | "title";

// Valid projection versions are non-negative. Current semantic writes first
// use this transaction-local sentinel so legacy invalidation triggers can
// distinguish an acknowledged source update even when its projection is equal.
const SEARCH_PROJECTION_WRITE_SENTINEL_VERSION = -1;

interface SearchBackfillTitleRow {
  id: string;
  title: string | null;
  search_index_version: number;
}

interface PreparedMessageSearchProjection {
  id: string;
  signature: string;
  searchText: string;
}

interface PreparedTitleSearchProjection {
  id: string;
  signature: string;
  searchTitle: string;
}

interface SearchSessionMetaRow {
  id: string;
  title: string | null;
  updated_at: number;
  message_count: number;
  search_title: string;
  search_index_version: number;
}

interface SearchSourceMessageRow extends MessageStorageRow {
  session_id: string;
  seq: number;
  search_index_version: number;
}

interface IndexedMessageSummaryRow {
  session_id: string;
  total_message_matches: number;
  best_message_category: 0 | 1;
}

interface IndexedMessageCandidateRow {
  id: string;
  session_id: string;
  seq: number;
  role: "user" | "assistant";
  timestamp: number;
  category: 0 | 1;
}

interface IndexedTitleMatchRow {
  id: string;
  title: string | null;
  search_title: string;
  updated_at: number;
}

function getBoundedSearchLimit(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ChatHistorySearchError(
      "INVALID_REQUEST",
      "Search page limit must be a positive safe integer",
    );
  }
  return Math.min(value, maximum);
}

function toSearchSessionMetadata(
  row: SearchSessionMetaRow,
): SearchSessionMetadata {
  return {
    sessionId: String(row.id),
    sessionTitle: row.title === null ? null : String(row.title),
    sessionUpdatedAt: Number(row.updated_at),
  };
}

function isSameSearchSnapshot(
  left: ChatSearchState,
  right: ChatSearchState,
): boolean {
  return (
    left.targetVersion === right.targetVersion &&
    left.revisionEpoch === right.revisionEpoch &&
    left.searchRevision === right.searchRevision
  );
}

class SourceSessionMatchAccumulator {
  totalMessageMatches = 0;
  private readonly retained: AggregatedSearchMessageCandidate[] = [];

  constructor(
    private readonly query: ParsedSearchQuery,
    private readonly metadata: SearchSessionMetadata,
    private readonly cursor: MessageSearchOrder | undefined,
    private readonly retainLimit: number,
  ) {}

  add(row: SearchSourceMessageRow): void {
    if (row.role !== "user" && row.role !== "assistant") return;
    const message = mapMessageRowToChatMessage(row);
    const normalizedText = projectSourceMessageSearchText(message, this.query);
    if (normalizedText === null) return;
    const category = classifyMessageMatch(normalizedText, this.query);
    if (category === null) return;

    this.totalMessageMatches += 1;
    const candidate: AggregatedSearchMessageCandidate = {
      sessionId: this.metadata.sessionId,
      messageId: String(row.id),
      role: row.role,
      category,
      messageTimestamp: Number(row.timestamp),
      messageSeq: Number(row.seq),
    };
    if (this.cursor && compareMessageSearchOrder(candidate, this.cursor) <= 0) {
      return;
    }

    this.retained.push(candidate);
    this.retained.sort(compareMessageSearchOrder);
    if (this.retained.length > this.retainLimit) {
      this.retained.length = this.retainLimit;
    }
  }

  finish(): AggregatedSearchMessageCandidate[] {
    return [...this.retained];
  }
}

function searchBackfillNow(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function parseStoredJsonArray<T extends unknown[]>(
  value: string | null | undefined,
): T | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

function getSearchBackfillRetryDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const exponent = Math.min(consecutiveFailures - 1, 30);
  return Math.min(
    SEARCH_BACKFILL_RETRY_MAX_DELAY_MS,
    SEARCH_BACKFILL_RETRY_BASE_DELAY_MS * 2 ** exponent,
  );
}

function toMessageProjectionSource(
  row: MessageStorageRow,
): MessageProjectionSource {
  return {
    id: row.id,
    role: row.role,
    content: row.content || "",
    selectedText: row.selected_text ?? null,
    toolCalls: row.tool_calls ?? null,
    toolCallId: row.tool_call_id ?? null,
    streamingState: row.streaming_state ?? null,
    apiOnly: row.api_only ?? null,
    isSystemNotice: row.is_system_notice ?? null,
  };
}

function prepareMessageSearchProjection(
  row: MessageStorageRow,
): PreparedMessageSearchProjection {
  return {
    id: row.id,
    signature: createMessageProjectionSignature(toMessageProjectionSource(row)),
    searchText: projectMessageSearchText(mapMessageRowToChatMessage(row)),
  };
}

function prepareTitleSearchProjection(
  row: SearchBackfillTitleRow,
): PreparedTitleSearchProjection {
  return {
    id: row.id,
    signature: createTitleProjectionSignature(row.id, row.title),
    searchTitle: projectTitleSearchText(row.title || ""),
  };
}

function parseSearchState(row: unknown): ChatSearchState | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  const targetVersion = Number(value.target_version);
  const completed = Number(value.completed);
  const searchRevision = Number(value.search_revision);
  const updatedAt = Number(value.updated_at);
  const revisionEpoch = value.revision_epoch;

  if (
    !Number.isSafeInteger(targetVersion) ||
    targetVersion < 1 ||
    (completed !== 0 && completed !== 1) ||
    typeof revisionEpoch !== "string" ||
    !revisionEpoch.trim() ||
    !Number.isSafeInteger(searchRevision) ||
    searchRevision < 0 ||
    !Number.isFinite(updatedAt) ||
    updatedAt < 0
  ) {
    return null;
  }

  return {
    targetVersion,
    completed: completed === 1,
    revisionEpoch,
    searchRevision,
    updatedAt,
  };
}

export async function readChatSearchState(
  db: QueryableDatabase,
): Promise<ChatSearchState | null> {
  const rows =
    (await db.queryAsync(
      "SELECT target_version, completed, revision_epoch, search_revision, updated_at FROM chat_search_state WHERE id = 1",
    )) || [];
  return parseSearchState(rows[0]);
}

export async function incrementSearchRevision(
  db: QueryableDatabase,
  updatedAt: number = Date.now(),
): Promise<void> {
  await db.queryAsync(
    `UPDATE chat_search_state
     SET search_revision = search_revision + 1,
         updated_at = ?,
         completed = CASE WHEN target_version > ? THEN 0 ELSE completed END
     WHERE id = 1`,
    [updatedAt, CURRENT_SEARCH_VERSION],
  );
}

function readOptionalMessageColumn<K extends keyof MessageStorageRow>(
  row: MessageStorageRow,
  column: K,
): MessageStorageRow[K] | undefined {
  // Zotero.DBConnection wraps SELECT rows in a strict Proxy: reading a column
  // that was not included in the projection throws instead of returning
  // undefined. Search intentionally uses a narrow projection, so guard every
  // optional storage column with the Proxy's `has` trap before reading it.
  return column in row ? row[column] : undefined;
}

export function mapMessageRowToChatMessage(
  row: MessageStorageRow,
): ChatMessage {
  const message: ChatMessage = {
    id: row.id,
    role: row.role,
    content: row.content || "",
    timestamp: row.timestamp,
  };
  const reasoning = readOptionalMessageColumn(row, "reasoning");
  if (reasoning) message.reasoning = reasoning;
  const images = parseStoredJsonArray<NonNullable<ChatMessage["images"]>>(
    readOptionalMessageColumn(row, "images"),
  );
  if (images) message.images = images;
  const files = parseStoredJsonArray<NonNullable<ChatMessage["files"]>>(
    readOptionalMessageColumn(row, "files"),
  );
  if (files) message.files = files;
  if (readOptionalMessageColumn(row, "pdf_context")) {
    message.pdfContext = true;
  }
  const selectedText = readOptionalMessageColumn(row, "selected_text");
  if (selectedText) message.selectedText = selectedText;
  const toolCalls = parseStoredJsonArray<
    NonNullable<ChatMessage["tool_calls"]>
  >(readOptionalMessageColumn(row, "tool_calls"));
  if (toolCalls) message.tool_calls = toolCalls;
  const toolCallId = readOptionalMessageColumn(row, "tool_call_id");
  if (toolCallId) message.tool_call_id = toolCallId;
  const streamingState = readOptionalMessageColumn(row, "streaming_state");
  if (streamingState) message.streamingState = streamingState;
  if (readOptionalMessageColumn(row, "api_only")) message.apiOnly = true;
  if (readOptionalMessageColumn(row, "is_system_notice")) {
    message.isSystemNotice = true;
  }
  return message;
}

function projectMessageSearchText(message: ChatMessage): string {
  return projectMessageSearchNormalizedText(message);
}

function projectSourceMessageSearchText(
  message: ChatMessage,
  query: ParsedSearchQuery,
): string | null {
  const decision = getMessageSearchFastDecision(message, query);
  if (decision === "skip") return null;
  if (decision === "exactMatch") return query.exactPhrase;
  return projectMessageSearchText(message);
}

function projectTitleSearchText(title: string): string {
  return projectSearchNormalizedText([
    { kind: "text", text: title, separator: "none" },
  ]);
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

export class SessionStorageService {
  private initialized: boolean = false;
  private activeSessionIdCache: string | null = null;
  private searchBackfillBatchSize = INITIAL_SEARCH_BACKFILL_BATCH_SIZE;
  private searchBackfillNextWorkKind: SearchBackfillWorkKind = "message";
  private searchBackfillTimer: ReturnType<typeof setTimeout> | null = null;
  private searchBackfillActive: Promise<void> | null = null;
  private searchBackfillPauseDepth = 0;
  private searchBackfillRequested = false;
  private searchBackfillStopped = false;
  private searchBackfillConsecutiveFailures = 0;
  private lastSearchBackfillTiming: SearchBackfillSliceTiming | null = null;

  private async runTransaction<T>(
    operation: (db: QueryableDatabase) => Promise<T>,
  ): Promise<T> {
    return getStorageDatabase().executeTransaction(operation);
  }

  private async initializeSearchState(): Promise<void> {
    await this.runTransaction(async (db) => {
      const state = await readChatSearchState(db);
      const now = Date.now();

      if (!state) {
        const versionRows =
          (await db.queryAsync(
            `SELECT MAX(version) AS max_version
             FROM (
               SELECT COALESCE(MAX(search_index_version), 0) AS version
               FROM messages
               UNION ALL
               SELECT COALESCE(MAX(search_index_version), 0) AS version
               FROM session_meta
             )`,
          )) || [];
        const observedVersion = Number(versionRows[0]?.max_version || 0);
        const targetVersion = Math.max(
          CURRENT_SEARCH_VERSION,
          Number.isSafeInteger(observedVersion) && observedVersion > 0
            ? observedVersion
            : 0,
        );
        const workRows =
          (await db.queryAsync(
            `SELECT CASE WHEN
               EXISTS (
                 SELECT 1 FROM messages WHERE search_index_version < ? LIMIT 1
               ) OR EXISTS (
                 SELECT 1 FROM session_meta WHERE search_index_version < ? LIMIT 1
               )
             THEN 1 ELSE 0 END AS has_work`,
            [targetVersion, targetVersion],
          )) || [];
        const completed = workRows[0]?.has_work === 0 ? 1 : 0;
        const revisionEpoch = `${now.toString(36)}-${generateShortId()}`;

        await db.queryAsync("DELETE FROM chat_search_state WHERE id = 1");
        await db.queryAsync(
          `INSERT INTO chat_search_state
           (id, target_version, completed, revision_epoch, search_revision, updated_at)
           VALUES (1, ?, ?, ?, 0, ?)`,
          [targetVersion, completed, revisionEpoch, now],
        );
        return;
      }

      if (state.targetVersion < CURRENT_SEARCH_VERSION) {
        await db.queryAsync(
          `UPDATE chat_search_state
           SET target_version = ?, completed = 0, updated_at = ?
           WHERE id = 1`,
          [CURRENT_SEARCH_VERSION, now],
        );
        return;
      }

      if (state.completed) {
        const workRows =
          (await db.queryAsync(
            `SELECT CASE WHEN
               EXISTS (
                 SELECT 1 FROM messages WHERE search_index_version < ? LIMIT 1
               ) OR EXISTS (
                 SELECT 1 FROM session_meta WHERE search_index_version < ? LIMIT 1
               )
             THEN 1 ELSE 0 END AS has_work`,
            [state.targetVersion, state.targetVersion],
          )) || [];
        if (Number(workRows[0]?.has_work) === 1) {
          await db.queryAsync(
            "UPDATE chat_search_state SET completed = 0, updated_at = ? WHERE id = 1",
            [now],
          );
        }
      }
      // A newer target belongs to a newer application. Never downgrade it;
      // foreground search falls back to source projection until compatible.
    });
  }

  async getSearchState(): Promise<ChatSearchState> {
    await this.init();
    const db = await getStorageDatabase().ensureInit();
    const state = await readChatSearchState(db);
    if (!state) {
      throw new Error("Chat search state is unavailable after initialization");
    }
    return state;
  }

  async searchHistoryGroups(
    input: SearchHistoryGroupsRequest,
  ): Promise<ChatHistorySearchPage> {
    const query = parseSearchQuery(input.query);
    const sessionLimit = getBoundedSearchLimit(
      input.sessionLimit,
      MAX_SEARCH_SESSION_PAGE_SIZE,
      MAX_SEARCH_SESSION_PAGE_SIZE,
    );
    const initialMessageLimit = getBoundedSearchLimit(
      input.initialMessageLimit,
      INITIAL_SEARCH_MESSAGE_PAGE_SIZE,
      INITIAL_SEARCH_MESSAGE_PAGE_SIZE,
    );

    return this.runStableForegroundSearch((db, state) =>
      this.searchHistoryGroupsAtSnapshot(
        db,
        state,
        query,
        sessionLimit,
        initialMessageLimit,
        input.sessionCursor,
      ),
    );
  }

  async searchHistorySessionMatches(
    input: SearchHistorySessionMatchesRequest,
  ): Promise<ChatHistoryMessagePage> {
    const query = parseSearchQuery(input.query);
    const limit = getBoundedSearchLimit(
      input.limit,
      MAX_SEARCH_MESSAGE_PAGE_SIZE,
      MAX_SEARCH_MESSAGE_PAGE_SIZE,
    );
    if (!input.sessionId) {
      throw new ChatHistorySearchError(
        "INVALID_REQUEST",
        "A session ID is required",
      );
    }

    return this.runStableForegroundSearch((db, state) =>
      this.searchHistorySessionMatchesAtSnapshot(
        db,
        state,
        query,
        input,
        limit,
      ),
    );
  }

  private async runStableForegroundSearch<T>(
    operation: (db: QueryableDatabase, state: ChatSearchState) => Promise<T>,
  ): Promise<T> {
    await this.init();
    this.pauseSearchBackfill();
    try {
      await this.awaitActiveSearchBackfill();
      const db = await getStorageDatabase().ensureInit();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await readChatSearchState(db);
        if (!before) {
          throw new ChatHistorySearchError(
            "SEARCH_UNAVAILABLE",
            "Chat history search state is unavailable",
          );
        }

        let result: T | undefined;
        let failure: unknown;
        try {
          result = await operation(db, before);
        } catch (error) {
          failure = error;
        }

        const after = await readChatSearchState(db);
        if (!after) {
          throw new ChatHistorySearchError(
            "SEARCH_UNAVAILABLE",
            "Chat history search state is unavailable",
          );
        }
        if (isSameSearchSnapshot(before, after)) {
          if (failure !== undefined) throw failure;
          return result as T;
        }
        if (attempt === 1) {
          throw new ChatHistorySearchError(
            "STALE_SEARCH",
            "Search results changed while searching",
          );
        }
      }

      throw new ChatHistorySearchError(
        "STALE_SEARCH",
        "Search results changed while searching",
      );
    } finally {
      this.resumeSearchBackfill();
    }
  }

  private async loadEligibleSearchMetadata(
    db: QueryableDatabase,
  ): Promise<Map<string, SearchSessionMetaRow>> {
    const rows =
      (await db.queryAsync(
        `SELECT id, title, updated_at, message_count, search_title,
           search_index_version
         FROM session_meta
         WHERE message_count > 0`,
      )) || [];
    const metadata = new Map<string, SearchSessionMetaRow>();
    for (const rawRow of rows) {
      const row = rawRow as SearchSessionMetaRow;
      metadata.set(String(row.id), {
        id: String(row.id),
        title: row.title == null ? null : String(row.title),
        updated_at: Number(row.updated_at),
        message_count: Number(row.message_count),
        search_title: String(row.search_title || ""),
        search_index_version: Number(row.search_index_version),
      });
    }
    return metadata;
  }

  private async loadIndexedInitialSearchPartition(
    db: QueryableDatabase,
    query: ParsedSearchQuery,
    targetVersion: number,
    metadata: Map<string, SearchSessionMetaRow>,
    candidateLimit: number,
  ): Promise<{
    messageSummaries: IndexedMessageSearchSummary[];
    titleMatches: IndexedTitleSearchCandidate[];
  }> {
    const summaryQuery = buildIndexedMessageSummarySql(query, targetVersion);
    const rawSummaries =
      (await db.queryAsync(summaryQuery.sql, summaryQuery.params)) || [];
    const summaries = (rawSummaries as IndexedMessageSummaryRow[]).filter(
      (row) =>
        metadata.has(String(row.session_id)) &&
        Number(row.total_message_matches) > 0,
    );

    const candidatesBySession = new Map<
      string,
      IndexedSearchMessageCandidate[]
    >();
    const sessionIds = summaries.map((row) => String(row.session_id));
    for (
      let offset = 0;
      offset < sessionIds.length;
      offset += SEARCH_SQL_SESSION_CHUNK_SIZE
    ) {
      const chunk = sessionIds.slice(
        offset,
        offset + SEARCH_SQL_SESSION_CHUNK_SIZE,
      );
      const candidateQuery = buildIndexedMessageCandidatesSql(
        query,
        targetVersion,
        chunk,
        candidateLimit,
      );
      const rows =
        (await db.queryAsync(candidateQuery.sql, candidateQuery.params)) || [];
      for (const rawRow of rows as IndexedMessageCandidateRow[]) {
        const sessionId = String(rawRow.session_id);
        const candidates = candidatesBySession.get(sessionId) || [];
        candidates.push({
          messageId: String(rawRow.id),
          role: rawRow.role,
          category: Number(rawRow.category) as 0 | 1,
          messageTimestamp: Number(rawRow.timestamp),
          messageSeq: Number(rawRow.seq),
        });
        candidatesBySession.set(sessionId, candidates);
      }
    }

    const messageSummaries = summaries.map((row) => {
      const sessionId = String(row.session_id);
      const sessionMetadata = toSearchSessionMetadata(metadata.get(sessionId)!);
      return {
        ...sessionMetadata,
        totalMessageMatches: Number(row.total_message_matches),
        bestMessageCategory: Number(row.best_message_category) as 0 | 1,
        topMessageCandidates: candidatesBySession.get(sessionId) || [],
      };
    });

    const titleQuery = buildIndexedTitleMatchesSql(query, targetVersion);
    const rawTitles =
      (await db.queryAsync(titleQuery.sql, titleQuery.params)) || [];
    const titleMatches: IndexedTitleSearchCandidate[] = [];
    for (const rawRow of rawTitles as IndexedTitleMatchRow[]) {
      const sessionId = String(rawRow.id);
      const sessionMetadata = metadata.get(sessionId);
      if (!sessionMetadata) continue;
      titleMatches.push({
        ...toSearchSessionMetadata(sessionMetadata),
        normalizedTitle: String(rawRow.search_title || ""),
      });
    }

    return { messageSummaries, titleMatches };
  }

  private async scanInitialSourceMessagePartition(
    db: QueryableDatabase,
    query: ParsedSearchQuery,
    state: ChatSearchState,
    metadata: Map<string, SearchSessionMetaRow>,
    candidateLimit: number,
    sourceOnly: boolean,
  ) {
    const accumulator = new LowerVersionMessagePartitionAccumulator(
      query,
      candidateLimit,
    );
    if (!sourceOnly && state.completed) return accumulator.finish();

    let cursor: { searchIndexVersion: number; id: string } | undefined =
      undefined;
    while (true) {
      const pageQuery = sourceOnly
        ? buildAllSourceMessagePageSql(SEARCH_SOURCE_SCAN_PAGE_SIZE, cursor)
        : buildLowerVersionMessagePageSql(
            state.targetVersion,
            SEARCH_SOURCE_SCAN_PAGE_SIZE,
            cursor,
          );
      const rawRows =
        (await db.queryAsync(pageQuery.sql, pageQuery.params)) || [];
      const rows = rawRows as SearchSourceMessageRow[];
      for (const row of rows) {
        const sessionMetadata = metadata.get(String(row.session_id));
        if (!sessionMetadata) continue;
        const message = mapMessageRowToChatMessage(row);
        const normalizedText = projectSourceMessageSearchText(message, query);
        if (normalizedText === null) continue;
        const candidate: LowerVersionMessageSearchCandidate = {
          ...toSearchSessionMetadata(sessionMetadata),
          sessionMessageCount: sessionMetadata.message_count,
          messageId: String(row.id),
          role: row.role,
          messageTimestamp: Number(row.timestamp),
          messageSeq: Number(row.seq),
          normalizedText,
        };
        accumulator.add(candidate);
      }
      if (rows.length < SEARCH_SOURCE_SCAN_PAGE_SIZE) break;
      const last = rows.at(-1)!;
      cursor = {
        searchIndexVersion: Number(last.search_index_version),
        id: String(last.id),
      };
    }
    return accumulator.finish();
  }

  private async scanInitialSourceTitlePartition(
    db: QueryableDatabase,
    state: ChatSearchState,
    metadata: Map<string, SearchSessionMetaRow>,
    sourceOnly: boolean,
  ): Promise<LowerVersionTitleSearchCandidate[]> {
    if (sourceOnly) {
      return Array.from(metadata.values(), (row) => ({
        ...toSearchSessionMetadata(row),
        normalizedTitle: projectTitleSearchText(row.title || ""),
        sessionMessageCount: row.message_count,
      }));
    }
    if (state.completed) return [];

    const candidates: LowerVersionTitleSearchCandidate[] = [];
    let cursor: { searchIndexVersion: number; id: string } | undefined =
      undefined;
    while (true) {
      const pageQuery = buildLowerVersionTitlePageSql(
        state.targetVersion,
        SEARCH_SOURCE_SCAN_PAGE_SIZE,
        cursor,
      );
      const rawRows =
        (await db.queryAsync(pageQuery.sql, pageQuery.params)) || [];
      const rows = rawRows as SearchSessionMetaRow[];
      for (const row of rows) {
        const sessionMetadata = metadata.get(String(row.id));
        if (!sessionMetadata) continue;
        candidates.push({
          ...toSearchSessionMetadata(sessionMetadata),
          normalizedTitle: projectTitleSearchText(row.title || ""),
          sessionMessageCount: Number(row.message_count),
        });
      }
      if (rows.length < SEARCH_SOURCE_SCAN_PAGE_SIZE) break;
      const last = rows.at(-1)!;
      cursor = {
        searchIndexVersion: Number(last.search_index_version),
        id: String(last.id),
      };
    }
    return candidates;
  }

  private async searchHistoryGroupsAtSnapshot(
    db: QueryableDatabase,
    state: ChatSearchState,
    query: ParsedSearchQuery,
    sessionLimit: number,
    initialMessageLimit: number,
    sessionCursor?: string,
  ): Promise<ChatHistorySearchPage> {
    const queryKey = await createSearchQueryKey(
      state.revisionEpoch,
      query.normalizedQuery,
    );
    const context = {
      queryKey,
      searchRevision: state.searchRevision,
    };
    if (sessionCursor) {
      validateSessionSearchCursor(sessionCursor, context);
    }

    const metadata = await this.loadEligibleSearchMetadata(db);
    const sourceOnly = state.targetVersion !== CURRENT_SEARCH_VERSION;
    const indexed = sourceOnly
      ? { messageSummaries: [], titleMatches: [] }
      : await this.loadIndexedInitialSearchPartition(
          db,
          query,
          state.targetVersion,
          metadata,
          initialMessageLimit,
        );
    const sourceMessages = await this.scanInitialSourceMessagePartition(
      db,
      query,
      state,
      metadata,
      initialMessageLimit,
      sourceOnly,
    );
    const sourceTitles = await this.scanInitialSourceTitlePartition(
      db,
      state,
      metadata,
      sourceOnly,
    );

    const aggregated = aggregateSearchSessions({
      query,
      indexedMessageSummaries: indexed.messageSummaries,
      indexedTitleMatches: indexed.titleMatches,
      lowerVersionMessagePartition: sourceMessages,
      lowerVersionTitleCandidates: sourceTitles,
      messageCandidateLimit: initialMessageLimit,
    });
    const page = paginateSearchSessions(
      aggregated,
      context,
      sessionLimit,
      sessionCursor,
    );
    const groups = await this.materializeSearchGroups(
      db,
      page.items,
      query,
      context,
    );
    return {
      queryKey,
      searchRevision: state.searchRevision,
      groups,
      nextSessionCursor: page.nextCursor,
    };
  }

  private async loadSearchMessageRows(
    db: QueryableDatabase,
    messageIds: readonly string[],
  ): Promise<Map<string, SearchSourceMessageRow>> {
    const rowsById = new Map<string, SearchSourceMessageRow>();
    for (
      let offset = 0;
      offset < messageIds.length;
      offset += SEARCH_SQL_SESSION_CHUNK_SIZE
    ) {
      const chunk = messageIds.slice(
        offset,
        offset + SEARCH_SQL_SESSION_CHUNK_SIZE,
      );
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows =
        (await db.queryAsync(
          `SELECT id, session_id, seq, role, content, timestamp,
             selected_text, tool_calls, tool_call_id, streaming_state,
             api_only, is_system_notice, search_index_version
           FROM messages
           WHERE id IN (${placeholders})`,
          [...chunk],
        )) || [];
      for (const row of rows as SearchSourceMessageRow[]) {
        rowsById.set(String(row.id), row);
      }
    }
    return rowsById;
  }

  private async materializeSearchMessageMatches(
    db: QueryableDatabase,
    candidates: readonly AggregatedSearchMessageCandidate[],
    query: ParsedSearchQuery,
  ): Promise<ChatHistoryMessageMatch[]> {
    const rowsById = await this.loadSearchMessageRows(
      db,
      candidates.map((candidate) => candidate.messageId),
    );
    return candidates.map((candidate) => {
      const row = rowsById.get(candidate.messageId);
      if (!row) {
        throw new Error(
          `Search source message disappeared: ${candidate.messageId}`,
        );
      }
      const document = projectSearchDocument(
        buildVisibleSearchSegments(mapMessageRowToChatMessage(row)),
      );
      const snippet = createSearchSnippet(document, query.normalizedQuery);
      return {
        messageId: candidate.messageId,
        role: candidate.role,
        messageTimestamp: candidate.messageTimestamp,
        messageSeq: candidate.messageSeq,
        snippet: snippet.snippet,
        highlightRanges: snippet.highlightRanges,
      };
    });
  }

  private async materializeSearchGroups(
    db: QueryableDatabase,
    groups: readonly AggregatedSearchSession[],
    query: ParsedSearchQuery,
    context: { queryKey: string; searchRevision: number },
  ): Promise<ChatHistorySearchGroup[]> {
    const allCandidates = groups.flatMap((group) => group.topMessageCandidates);
    const allMatches = await this.materializeSearchMessageMatches(
      db,
      allCandidates,
      query,
    );
    const matchesById = new Map(
      allMatches.map((match) => [match.messageId, match]),
    );

    return groups.map((group) => {
      const result: ChatHistorySearchGroup = {
        sessionId: group.sessionId,
        sessionTitle: group.sessionTitle,
        sessionUpdatedAt: group.sessionUpdatedAt,
        totalMessageMatches: group.totalMessageMatches,
        matches: group.topMessageCandidates.map((candidate) => {
          const match = matchesById.get(candidate.messageId);
          if (!match) {
            throw new Error(
              `Search snippet is unavailable: ${candidate.messageId}`,
            );
          }
          return match;
        }),
        nextMessageCursor: createNextMessageCursorForSearchGroup(
          group,
          context,
        ),
      };
      if (group.titleMatchKind) {
        const titleSnippet = createSearchSnippet(
          projectSearchTitle(group.sessionTitle || ""),
          query.normalizedQuery,
        );
        result.titleMatch = {
          kind: group.titleMatchKind,
          snippet: titleSnippet.snippet,
          highlightRanges: titleSnippet.highlightRanges,
        };
      }
      return result;
    });
  }

  private async loadIndexedSessionMessagePage(
    db: QueryableDatabase,
    query: ParsedSearchQuery,
    targetVersion: number,
    sessionId: string,
    cursor: MessageSearchOrder | undefined,
    retainLimit: number,
  ): Promise<{
    totalMessageMatches: number;
    candidates: AggregatedSearchMessageCandidate[];
  }> {
    const summaryQuery = buildIndexedSessionMessageSummarySql(
      query,
      targetVersion,
      sessionId,
    );
    const summaryRows =
      (await db.queryAsync(summaryQuery.sql, summaryQuery.params)) || [];
    const totalMessageMatches = Number(
      summaryRows[0]?.total_message_matches || 0,
    );
    if (totalMessageMatches === 0) {
      return { totalMessageMatches: 0, candidates: [] };
    }

    const pageQuery = buildIndexedSessionMessagePageSql(
      query,
      targetVersion,
      sessionId,
      retainLimit,
      cursor,
    );
    const rows = (await db.queryAsync(pageQuery.sql, pageQuery.params)) || [];
    const candidates: AggregatedSearchMessageCandidate[] = (
      rows as IndexedMessageCandidateRow[]
    )
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => ({
        sessionId,
        messageId: String(row.id),
        role: row.role,
        category: Number(row.category) as 0 | 1,
        messageTimestamp: Number(row.timestamp),
        messageSeq: Number(row.seq),
      }));
    return { totalMessageMatches, candidates };
  }

  private async scanSourceSessionMessagePage(
    db: QueryableDatabase,
    query: ParsedSearchQuery,
    state: ChatSearchState,
    sessionMetadata: SearchSessionMetaRow,
    cursor: MessageSearchOrder | undefined,
    retainLimit: number,
    sourceOnly: boolean,
  ): Promise<{
    totalMessageMatches: number;
    candidates: AggregatedSearchMessageCandidate[];
  }> {
    const accumulator = new SourceSessionMatchAccumulator(
      query,
      toSearchSessionMetadata(sessionMetadata),
      cursor,
      retainLimit,
    );
    if (!sourceOnly && state.completed) {
      return { totalMessageMatches: 0, candidates: [] };
    }

    let sourceCursor: { searchIndexVersion: number; id: string } | undefined =
      undefined;
    while (true) {
      const pageQuery = sourceOnly
        ? buildAllSourceSessionMessagePageSql(
            sessionMetadata.id,
            SEARCH_SOURCE_SCAN_PAGE_SIZE,
            sourceCursor,
          )
        : buildLowerVersionSessionMessagePageSql(
            state.targetVersion,
            sessionMetadata.id,
            SEARCH_SOURCE_SCAN_PAGE_SIZE,
            sourceCursor,
          );
      const rawRows =
        (await db.queryAsync(pageQuery.sql, pageQuery.params)) || [];
      const rows = rawRows as SearchSourceMessageRow[];
      for (const row of rows) accumulator.add(row);
      if (rows.length < SEARCH_SOURCE_SCAN_PAGE_SIZE) break;
      const last = rows.at(-1)!;
      sourceCursor = {
        searchIndexVersion: Number(last.search_index_version),
        id: String(last.id),
      };
    }
    return {
      totalMessageMatches: accumulator.totalMessageMatches,
      candidates: accumulator.finish(),
    };
  }

  private async searchHistorySessionMatchesAtSnapshot(
    db: QueryableDatabase,
    state: ChatSearchState,
    query: ParsedSearchQuery,
    input: SearchHistorySessionMatchesRequest,
    limit: number,
  ): Promise<ChatHistoryMessagePage> {
    const queryKey = await createSearchQueryKey(
      state.revisionEpoch,
      query.normalizedQuery,
    );
    if (
      input.queryKey !== queryKey ||
      input.searchRevision !== state.searchRevision
    ) {
      throw new ChatHistorySearchError(
        "STALE_SEARCH",
        "Search results changed; restart from the first page",
      );
    }
    const context = {
      queryKey,
      searchRevision: state.searchRevision,
    };
    const cursor = input.messageCursor
      ? validateMessageSearchCursor(
          input.messageCursor,
          context,
          input.sessionId,
        )
      : undefined;

    const metadata = await this.loadEligibleSearchMetadata(db);
    const sessionMetadata = metadata.get(input.sessionId);
    if (!sessionMetadata) {
      return {
        queryKey,
        searchRevision: state.searchRevision,
        sessionId: input.sessionId,
        totalMessageMatches: 0,
        matches: [],
      };
    }

    // Each disjoint version partition retains one extra row after the cursor.
    // If either partition has more data, their merged page therefore has a
    // stable continuation cursor without retaining all matching IDs.
    const retainLimit = limit + 1;
    const sourceOnly = state.targetVersion !== CURRENT_SEARCH_VERSION;
    const indexed = sourceOnly
      ? { totalMessageMatches: 0, candidates: [] }
      : await this.loadIndexedSessionMessagePage(
          db,
          query,
          state.targetVersion,
          input.sessionId,
          cursor,
          retainLimit,
        );
    const source = await this.scanSourceSessionMessagePage(
      db,
      query,
      state,
      sessionMetadata,
      cursor,
      retainLimit,
      sourceOnly,
    );
    const candidates = [...indexed.candidates, ...source.candidates];
    const page = paginateSearchMessages(
      candidates,
      context,
      input.sessionId,
      limit,
      input.messageCursor,
    );
    const matches = await this.materializeSearchMessageMatches(
      db,
      page.items,
      query,
    );
    return {
      queryKey,
      searchRevision: state.searchRevision,
      sessionId: input.sessionId,
      totalMessageMatches:
        indexed.totalMessageMatches + source.totalMessageMatches,
      matches,
      nextMessageCursor: page.nextCursor,
    };
  }

  /**
   * Start the invisible search-index backfill. The caller intentionally does
   * not await this method: each bounded slice yields through a zero-delay timer
   * before the next slice is considered.
   */
  startSearchBackfill(): void {
    if (this.searchBackfillStopped) return;
    this.searchBackfillRequested = true;
    this.scheduleSearchBackfillSlice();
  }

  /** Prevent a future slice from starting. Calls are reference-counted. */
  pauseSearchBackfill(): void {
    this.searchBackfillPauseDepth += 1;
    this.cancelScheduledSearchBackfillSlice();
  }

  /** Await the slice that had already started before a foreground search. */
  async awaitActiveSearchBackfill(): Promise<void> {
    const active = this.searchBackfillActive;
    if (active) await active;
  }

  /** Release one foreground pause and resume scheduling when all have left. */
  resumeSearchBackfill(): void {
    if (this.searchBackfillPauseDepth === 0) return;
    this.searchBackfillPauseDepth -= 1;
    if (this.searchBackfillPauseDepth === 0) {
      this.scheduleSearchBackfillSlice();
    }
  }

  /** Cancel future slices and drain the active one before database shutdown. */
  async stopSearchBackfill(): Promise<void> {
    this.searchBackfillStopped = true;
    this.searchBackfillRequested = false;
    this.cancelScheduledSearchBackfillSlice();
    await this.awaitActiveSearchBackfill();
  }

  /** Last measured complete-slice and transaction-callback occupancy. */
  getLastSearchBackfillTiming(): SearchBackfillSliceTiming | null {
    return this.lastSearchBackfillTiming
      ? { ...this.lastSearchBackfillTiming }
      : null;
  }

  private cancelScheduledSearchBackfillSlice(): void {
    if (this.searchBackfillTimer === null) return;
    clearTimeout(this.searchBackfillTimer);
    this.searchBackfillTimer = null;
  }

  private scheduleSearchBackfillSlice(delayMs?: number): void {
    if (
      !this.searchBackfillRequested ||
      this.searchBackfillStopped ||
      this.searchBackfillPauseDepth > 0 ||
      this.searchBackfillTimer !== null ||
      this.searchBackfillActive !== null
    ) {
      return;
    }

    const effectiveDelayMs =
      delayMs ??
      getSearchBackfillRetryDelayMs(this.searchBackfillConsecutiveFailures);
    const timer = setTimeout(() => {
      if (this.searchBackfillTimer !== timer) return;
      this.searchBackfillTimer = null;
      if (
        !this.searchBackfillRequested ||
        this.searchBackfillStopped ||
        this.searchBackfillPauseDepth > 0
      ) {
        return;
      }

      const active = (async () => {
        let shouldContinue = false;
        try {
          shouldContinue = await this.runSearchBackfillSlice();
          this.searchBackfillConsecutiveFailures = 0;
        } catch (error) {
          // Foreground search remains complete through its lower-version
          // source fallback. Persistent failures use capped exponential
          // backoff so a bad row or unavailable database cannot hot-loop.
          ztoolkit.log(
            "[SessionStorageService] Search backfill slice error:",
            error,
          );
          shouldContinue = true;
          this.searchBackfillConsecutiveFailures += 1;
        } finally {
          this.searchBackfillActive = null;
          if (shouldContinue) {
            this.scheduleSearchBackfillSlice();
          }
        }
      })();
      this.searchBackfillActive = active;
    }, effectiveDelayMs);
    this.searchBackfillTimer = timer;
  }

  private async runSearchBackfillSlice(): Promise<boolean> {
    const totalStartedAt = searchBackfillNow();
    await this.init();
    const database = await getStorageDatabase().ensureInit();
    const state = await readChatSearchState(database);

    // Never write a future projector version using this build's semantics.
    if (
      !state ||
      state.completed ||
      state.targetVersion !== CURRENT_SEARCH_VERSION
    ) {
      return false;
    }

    const targetVersion = state.targetVersion;
    const batchSize = this.searchBackfillBatchSize;
    const messageRows: MessageStorageRow[] = [];
    const titleRows: SearchBackfillTitleRow[] = [];
    const firstKind = this.searchBackfillNextWorkKind;
    this.searchBackfillNextWorkKind =
      firstKind === "message" ? "title" : "message";

    const loadMessages = async (limit: number): Promise<void> => {
      if (limit <= 0) return;
      const query = buildLowerVersionMessagePageSql(targetVersion, limit);
      const rows = (await database.queryAsync(query.sql, query.params)) || [];
      messageRows.push(...(rows as MessageStorageRow[]));
    };
    const loadTitles = async (limit: number): Promise<void> => {
      if (limit <= 0) return;
      const query = buildLowerVersionTitlePageSql(targetVersion, limit);
      const rows = (await database.queryAsync(query.sql, query.params)) || [];
      titleRows.push(...(rows as SearchBackfillTitleRow[]));
    };

    if (firstKind === "message") {
      await loadMessages(batchSize);
      await loadTitles(batchSize - messageRows.length);
    } else {
      await loadTitles(batchSize);
      await loadMessages(batchSize - titleRows.length);
    }

    // Markdown parsing, normalization, and source signatures are intentionally
    // computed before reserving the exclusive transaction job.
    const messageProjections = messageRows.map(prepareMessageSearchProjection);
    const titleProjections = titleRows.map(prepareTitleSearchProjection);

    let transactionStartedAt = 0;
    let transactionFinishedAt = 0;
    let hasMoreWork = true;

    await this.runTransaction(async (db) => {
      transactionStartedAt = searchBackfillNow();
      try {
        const currentState = await readChatSearchState(db);
        if (
          !currentState ||
          currentState.completed ||
          currentState.targetVersion !== targetVersion ||
          currentState.targetVersion !== CURRENT_SEARCH_VERSION
        ) {
          hasMoreWork = false;
          return;
        }

        if (messageProjections.length > 0) {
          const placeholders = messageProjections.map(() => "?").join(", ");
          const currentRows =
            (await db.queryAsync(
              `SELECT id, role, content, selected_text, tool_calls, tool_call_id,
                 streaming_state, api_only, is_system_notice,
                 search_index_version
               FROM messages
               WHERE id IN (${placeholders})`,
              messageProjections.map((projection) => projection.id),
            )) || [];
          const currentById = new Map(
            (currentRows as MessageStorageRow[]).map((row) => [row.id, row]),
          );

          for (const projection of messageProjections) {
            const current = currentById.get(projection.id);
            if (
              !current ||
              Number(current.search_index_version) >= targetVersion ||
              createMessageProjectionSignature(
                toMessageProjectionSource(current),
              ) !== projection.signature
            ) {
              continue;
            }
            await db.queryAsync(
              `UPDATE messages
               SET search_text = ?, search_index_version = ?
               WHERE id = ? AND search_index_version < ?`,
              [
                projection.searchText,
                targetVersion,
                projection.id,
                targetVersion,
              ],
            );
          }
        }

        if (titleProjections.length > 0) {
          const placeholders = titleProjections.map(() => "?").join(", ");
          const currentRows =
            (await db.queryAsync(
              `SELECT id, title, search_index_version
               FROM session_meta
               WHERE id IN (${placeholders})`,
              titleProjections.map((projection) => projection.id),
            )) || [];
          const currentById = new Map(
            (currentRows as SearchBackfillTitleRow[]).map((row) => [
              row.id,
              row,
            ]),
          );

          for (const projection of titleProjections) {
            const current = currentById.get(projection.id);
            if (
              !current ||
              Number(current.search_index_version) >= targetVersion ||
              createTitleProjectionSignature(current.id, current.title) !==
                projection.signature
            ) {
              continue;
            }
            await db.queryAsync(
              `UPDATE session_meta
               SET search_title = ?, search_index_version = ?
               WHERE id = ? AND search_index_version < ?`,
              [
                projection.searchTitle,
                targetVersion,
                projection.id,
                targetVersion,
              ],
            );
          }
        }

        const completionRows =
          (await db.queryAsync(
            `SELECT CASE WHEN
               NOT EXISTS (
                 SELECT 1 FROM messages WHERE search_index_version < ?
               ) AND NOT EXISTS (
                 SELECT 1 FROM session_meta WHERE search_index_version < ?
               )
             THEN 1 ELSE 0 END AS completed`,
            [targetVersion, targetVersion],
          )) || [];
        const completed = Number(completionRows[0]?.completed) === 1;
        if (completed) {
          await db.queryAsync(
            `UPDATE chat_search_state
             SET completed = 1, updated_at = ?
             WHERE id = 1 AND target_version = ?`,
            [Date.now(), targetVersion],
          );
        }
        hasMoreWork = !completed;
      } finally {
        transactionFinishedAt = searchBackfillNow();
      }
    });

    const timing: SearchBackfillSliceTiming = {
      totalMs: Math.max(0, searchBackfillNow() - totalStartedAt),
      transactionMs: Math.max(0, transactionFinishedAt - transactionStartedAt),
    };
    this.lastSearchBackfillTiming = timing;
    this.searchBackfillBatchSize = adaptSearchBackfillBatchSize(
      batchSize,
      timing,
    );
    return hasMoreWork;
  }

  /**
   * 初始化存储服务
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const db = await getStorageDatabase().ensureInit();

      await this.initializeSearchState();

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
      const searchText = projectMessageSearchText(message);
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
           (id, session_id, seq, role, content, reasoning, images, files, timestamp, pdf_context, selected_text, tool_calls, tool_call_id, streaming_state, api_only, is_system_notice, search_text, search_index_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            message.id,
            sessionId,
            nextSeq,
            message.role,
            message.content || "",
            message.reasoning || null,
            message.images ? JSON.stringify(message.images) : null,
            message.files ? JSON.stringify(message.files) : null,
            messageTimestamp,
            message.pdfContext ? 1 : null,
            message.selectedText || null,
            message.tool_calls ? JSON.stringify(message.tool_calls) : null,
            message.tool_call_id || null,
            message.streamingState || null,
            message.apiOnly ? 1 : null,
            message.isSystemNotice ? 1 : null,
            searchText,
            CURRENT_SEARCH_VERSION,
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
        const nextMessage: ChatMessage = {
          ...previousMessage,
          content,
          reasoning,
          timestamp: now,
          streamingState: options?.streamingState ?? undefined,
        };
        const previousSearchText = projectMessageSearchText(previousMessage);
        const searchText = projectMessageSearchText(nextMessage);

        await db.queryAsync(
          `UPDATE messages
           SET search_index_version = ?
           WHERE id = ? AND session_id = ?`,
          [SEARCH_PROJECTION_WRITE_SENTINEL_VERSION, messageId, sessionId],
        );
        await db.queryAsync(
          `UPDATE messages SET
            content = ?, reasoning = ?, timestamp = ?, streaming_state = ?,
            search_text = ?, search_index_version = ?
          WHERE id = ? AND session_id = ?`,
          [
            content,
            reasoning || null,
            now,
            options?.streamingState ?? null,
            searchText,
            CURRENT_SEARCH_VERSION,
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

        if (
          !options?.streamingState ||
          previousSearchText.length > 0 ||
          searchText.length > 0
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
      const searchTitle = projectTitleSearchText(session.title || "");
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
            searchTitle,
            CURRENT_SEARCH_VERSION,
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
      const searchTitle = projectTitleSearchText(session.title || "");
      const messagesForStorage = (session.messages || []).map((message) => ({
        message,
        searchText: projectMessageSearchText(message),
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
              searchText,
              timestamp,
            } = messagesForStorage[seq];
            await db.queryAsync(
              `INSERT INTO messages
               (id, session_id, seq, role, content, reasoning, images, files, timestamp, pdf_context, selected_text, tool_calls, tool_call_id, streaming_state, api_only, is_system_notice, search_text, search_index_version)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                msg.id,
                session.id,
                seq,
                msg.role,
                msg.content || "",
                msg.reasoning || null,
                msg.images ? JSON.stringify(msg.images) : null,
                msg.files ? JSON.stringify(msg.files) : null,
                timestamp,
                msg.pdfContext ? 1 : null,
                msg.selectedText || null,
                msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
                msg.tool_call_id || null,
                msg.streamingState || null,
                msg.apiOnly ? 1 : null,
                msg.isSystemNotice ? 1 : null,
                searchText,
                CURRENT_SEARCH_VERSION,
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
            searchTitle,
            CURRENT_SEARCH_VERSION,
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
      const searchTitle = projectTitleSearchText(normalizedTitle || "");

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
            searchTitle,
            CURRENT_SEARCH_VERSION,
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
          `SELECT COUNT(*) as count
           FROM messages
           WHERE session_id = ? AND streaming_state = 'in_progress'`,
          [sessionId],
        )) || [];
      if (Number(rows[0]?.count || 0) === 0) return;

      await tx.queryAsync(
        `UPDATE messages
         SET search_index_version = ?
         WHERE session_id = ? AND streaming_state = 'in_progress'`,
        [SEARCH_PROJECTION_WRITE_SENTINEL_VERSION, sessionId],
      );
      await tx.queryAsync(
        `UPDATE messages
         SET streaming_state = 'interrupted',
             search_text = '',
             search_index_version = ?
         WHERE session_id = ? AND streaming_state = 'in_progress'`,
        [CURRENT_SEARCH_VERSION, sessionId],
      );
      await tx.queryAsync(
        `UPDATE sessions
         SET execution_plan = NULL,
             tool_execution_state = NULL,
             tool_approval_state = NULL,
             updated_at = ?
         WHERE id = ?`,
        [now, sessionId],
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
    await this.runTransaction(async (db) => {
      await db.queryAsync(
        `UPDATE sessions
         SET execution_plan = NULL,
             tool_execution_state = NULL,
             tool_approval_state = NULL,
             updated_at = ?
         WHERE id = ?`,
        [now, session.id],
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
    session.toolExecutionState = undefined;
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
