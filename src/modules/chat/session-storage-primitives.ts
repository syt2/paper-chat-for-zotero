/**
 * session-storage-primitives - Shared message-storage primitives.
 *
 * Row types, column mapping, JSON (de)serialization, and the search-projection
 * helpers that both the CRUD core (SessionStorageService) and the search
 * subsystem (SessionSearchService) depend on. Extracting them into a leaf
 * module keeps the dependency graph a DAG: storage -> primitives, search ->
 * primitives, storage -> search. No cycles.
 */

import type { ChatMessage, ChatMessageStreamingState } from "../../types/chat";
import type { EvidenceRecord } from "../../types/evidence";
import { normalizeEvidenceRecords } from "./evidence";
import { normalizeSourceItemKeys } from "./note-source-provenance";
import { normalizeQuotedMessageRefs } from "./quoted-messages";
import {
  CURRENT_SEARCH_VERSION,
  projectMessageSearchNormalizedText,
  projectSearchNormalizedText,
} from "./search/SearchProjection";

const MAX_STORED_EVIDENCE_JSON_CHARACTERS = 600_000;

// JSON escaping can expand each bounded string character to six characters
// (for example, a control character becomes `\\u0000`). Keep the raw guard
// above the worst-case size of three normalized references.
const MAX_STORED_QUOTED_MESSAGES_JSON_CHARACTERS = 128_000;

// Valid projection versions are non-negative. Current semantic writes first
// use this transaction-local sentinel so legacy invalidation triggers can
// distinguish an acknowledged source update even when its projection is equal.
export const SEARCH_PROJECTION_WRITE_SENTINEL_VERSION = -1;

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
  quoted_messages?: string | null;
  timestamp: number;
  pdf_context?: number | null;
  selected_text?: string | null;
  tool_calls?: string | null;
  tool_call_id?: string | null;
  evidence?: string | null;
  source_item_keys?: string | null;
  streaming_state?: ChatMessageStreamingState | null;
  api_only?: number | null;
  is_system_notice?: number | null;
  search_text?: string | null;
  search_index_version?: number | null;
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

function parseStoredQuotedMessageRefs(
  value: string | null | undefined,
): NonNullable<ChatMessage["quotedMessages"]> | undefined {
  if (!value || value.length > MAX_STORED_QUOTED_MESSAGES_JSON_CHARACTERS) {
    return undefined;
  }
  try {
    const quotes = normalizeQuotedMessageRefs(JSON.parse(value));
    return quotes.length > 0 ? quotes : undefined;
  } catch {
    return undefined;
  }
}

function parseStoredEvidenceRecords(
  value: string | null | undefined,
): EvidenceRecord[] | undefined {
  if (!value || value.length > MAX_STORED_EVIDENCE_JSON_CHARACTERS) {
    return undefined;
  }
  try {
    const records = normalizeEvidenceRecords(JSON.parse(value));
    return records.length > 0 ? records : undefined;
  } catch {
    return undefined;
  }
}

export function serializeEvidenceRecords(value: unknown): string | null {
  const records = normalizeEvidenceRecords(value);
  return records.length > 0 ? JSON.stringify(records) : null;
}

function parseStoredSourceItemKeys(
  value: string | null | undefined,
): string[] | undefined {
  if (!value) return undefined;
  try {
    const keys = normalizeSourceItemKeys(JSON.parse(value));
    return keys.length > 0 ? keys : undefined;
  } catch {
    return undefined;
  }
}

export function serializeSourceItemKeys(value: unknown): string | null {
  const keys = normalizeSourceItemKeys(value);
  return keys.length > 0 ? JSON.stringify(keys) : null;
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
  const quotedMessages = parseStoredQuotedMessageRefs(
    readOptionalMessageColumn(row, "quoted_messages"),
  );
  if (quotedMessages) message.quotedMessages = quotedMessages;
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
  const evidence = parseStoredEvidenceRecords(
    readOptionalMessageColumn(row, "evidence"),
  );
  if (evidence) message.evidence = evidence;
  const sourceItemKeys = parseStoredSourceItemKeys(
    readOptionalMessageColumn(row, "source_item_keys"),
  );
  if (sourceItemKeys) message.sourceItemKeys = sourceItemKeys;
  const streamingState = readOptionalMessageColumn(row, "streaming_state");
  if (streamingState) message.streamingState = streamingState;
  if (readOptionalMessageColumn(row, "api_only")) message.apiOnly = true;
  if (readOptionalMessageColumn(row, "is_system_notice")) {
    message.isSystemNotice = true;
  }
  return message;
}

export function projectMessageSearchText(message: ChatMessage): string {
  return projectMessageSearchNormalizedText(message);
}

export interface SafeSearchProjection {
  searchText: string;
  searchIndexVersion: number;
  failed: boolean;
}

/**
 * The projection pipeline parses arbitrary historical/LLM content and must
 * never take chat persistence down with it. On failure, persist an empty
 * projection at version 0: the row simply stays unindexed and the hardened
 * backfill later quarantines it at the target version.
 */
export function projectMessageSearchTextSafe(
  message: ChatMessage,
): SafeSearchProjection {
  try {
    return {
      searchText: projectMessageSearchText(message),
      searchIndexVersion: CURRENT_SEARCH_VERSION,
      failed: false,
    };
  } catch (error) {
    ztoolkit.log(
      "[SessionStorageService] Message search projection failed, persisting without index:",
      message.id,
      error,
    );
    return { searchText: "", searchIndexVersion: 0, failed: true };
  }
}

export function projectTitleSearchText(title: string): string {
  return projectSearchNormalizedText([
    { kind: "text", text: title, separator: "none" },
  ]);
}

export function projectTitleSearchTextSafe(
  title: string,
): SafeSearchProjection {
  try {
    return {
      searchText: projectTitleSearchText(title),
      searchIndexVersion: CURRENT_SEARCH_VERSION,
      failed: false,
    };
  } catch (error) {
    ztoolkit.log(
      "[SessionStorageService] Title search projection failed, persisting without index:",
      error,
    );
    return { searchText: "", searchIndexVersion: 0, failed: true };
  }
}
