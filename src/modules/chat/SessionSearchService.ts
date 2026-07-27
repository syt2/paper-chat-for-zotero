/**
 * SessionSearchService - Chat history search + backfill subsystem.
 *
 * Owns the full-text search query engine (session/message match aggregation,
 * pagination, snapshot consistency) and the incremental search-index backfill
 * state machine. Split out of SessionStorageService so the CRUD core stays
 * focused on persistence; both halves share the leaf primitives in
 * session-storage-primitives. SessionStorageService constructs this collaborator
 * and exposes it as `.search`, injecting `ensureInitialized` so a search query
 * lazily guarantees the storage schema/state is ready.
 */

import type { ChatMessage } from "../../types/chat";
import { generateShortId } from "../../utils/common";
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
  projectSearchDocument,
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
import {
  mapMessageRowToChatMessage,
  projectMessageSearchText,
  projectTitleSearchText,
  projectTitleSearchTextSafe,
  readChatSearchState,
  type ChatSearchState,
  type MessageStorageRow,
  type QueryableDatabase,
} from "./session-storage-primitives";

const MAX_SEARCH_SESSION_PAGE_SIZE = 20;
const INITIAL_SEARCH_MESSAGE_PAGE_SIZE = 3;
const MAX_SEARCH_MESSAGE_PAGE_SIZE = 10;
const SEARCH_SOURCE_SCAN_PAGE_SIZE = 100;
const SEARCH_SQL_SESSION_CHUNK_SIZE = 250;
const SEARCH_BACKFILL_RETRY_BASE_DELAY_MS = 250;
const SEARCH_BACKFILL_RETRY_MAX_DELAY_MS = 30_000;

type SearchBackfillWorkKind = "message" | "title";

interface SearchBackfillTitleRow {
  id: string;
  title: string | null;
  search_index_version: number;
}

interface PreparedMessageSearchProjection {
  id: string;
  /** null when the projection pipeline threw — the row must be quarantined. */
  signature: string | null;
  searchText: string;
}

interface PreparedTitleSearchProjection {
  id: string;
  /** null when the projection pipeline threw — the row must be quarantined. */
  signature: string | null;
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
    const normalizedText = projectSourceMessageSearchTextSafe(
      message,
      this.query,
    );
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
    quotedMessages: row.quoted_messages ?? null,
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
  try {
    return {
      id: row.id,
      signature: createMessageProjectionSignature(
        toMessageProjectionSource(row),
      ),
      searchText: projectMessageSearchText(mapMessageRowToChatMessage(row)),
    };
  } catch (error) {
    // One un-projectable row must never wedge the whole backfill. Quarantine
    // it with an empty projection so it exits the work set as non-matching.
    ztoolkit.log(
      "[SessionSearchService] Message search projection failed, quarantining:",
      row.id,
      error,
    );
    return { id: row.id, signature: null, searchText: "" };
  }
}

function prepareTitleSearchProjection(
  row: SearchBackfillTitleRow,
): PreparedTitleSearchProjection {
  try {
    return {
      id: row.id,
      signature: createTitleProjectionSignature(row.id, row.title),
      searchTitle: projectTitleSearchText(row.title || ""),
    };
  } catch (error) {
    ztoolkit.log(
      "[SessionSearchService] Title search projection failed, quarantining:",
      row.id,
      error,
    );
    return { id: row.id, signature: null, searchTitle: "" };
  }
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

/**
 * Foreground fallback scans run the full projection pipeline over rows the
 * backfill has not reached yet. A row that cannot be projected is treated as
 * non-matching instead of failing the entire search.
 */
function projectSourceMessageSearchTextSafe(
  message: ChatMessage,
  query: ParsedSearchQuery,
): string | null {
  try {
    return projectSourceMessageSearchText(message, query);
  } catch (error) {
    ztoolkit.log(
      "[SessionSearchService] Source message search projection failed, skipping row:",
      message.id,
      error,
    );
    return null;
  }
}

/**
 * Collaborator injected by SessionStorageService so a search query can lazily
 * ensure the storage schema + search state are initialized before running.
 */
export interface SessionSearchDeps {
  ensureInitialized: () => Promise<void>;
}

export class SessionSearchService {
  private searchBackfillBatchSize = INITIAL_SEARCH_BACKFILL_BATCH_SIZE;
  private searchBackfillNextWorkKind: SearchBackfillWorkKind = "message";
  private searchBackfillTimer: ReturnType<typeof setTimeout> | null = null;
  private searchBackfillActive: Promise<void> | null = null;
  private searchBackfillPauseDepth = 0;
  private searchBackfillRequested = false;
  private searchBackfillStopped = false;
  private searchBackfillConsecutiveFailures = 0;
  private lastSearchBackfillTiming: SearchBackfillSliceTiming | null = null;

  constructor(private readonly deps: SessionSearchDeps) {}

  private ensureInitialized(): Promise<void> {
    return this.deps.ensureInitialized();
  }

  private async runTransaction<T>(
    operation: (db: QueryableDatabase) => Promise<T>,
  ): Promise<T> {
    return getStorageDatabase().executeTransaction(operation);
  }

  async initializeSearchState(): Promise<void> {
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
    await this.ensureInitialized();
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
    await this.ensureInitialized();
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
        const normalizedText = projectSourceMessageSearchTextSafe(
          message,
          query,
        );
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
        normalizedTitle: projectTitleSearchTextSafe(row.title || "").searchText,
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
          normalizedTitle: projectTitleSearchTextSafe(row.title || "")
            .searchText,
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
             api_only, is_system_notice, quoted_messages, search_index_version
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
    await this.ensureInitialized();
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
                 streaming_state, api_only, is_system_notice, quoted_messages,
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
              Number(current.search_index_version) >= targetVersion
            ) {
              continue;
            }
            // A null signature means the projection threw: quarantine the row
            // with an empty projection so it exits the work set. The signature
            // check only applies to successful projections; a concurrently
            // changed row is left for the next slice to re-read.
            if (
              projection.signature !== null &&
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
              Number(current.search_index_version) >= targetVersion
            ) {
              continue;
            }
            // A null signature means the projection threw: quarantine the row
            // with an empty projection so it exits the work set.
            if (
              projection.signature !== null &&
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
}
