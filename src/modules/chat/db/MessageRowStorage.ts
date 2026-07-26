/**
 * MessageRowStorage - shared message-row shapes and row→ChatMessage mapping.
 *
 * Both the session CRUD path (SessionStorageService) and the history search
 * path (SessionSearchService) read `messages` rows; this module keeps the row
 * contract and the defensive column parsing in one place.
 */

import type {
  ChatMessage,
  ChatMessageStreamingState,
} from "../../../types/chat";
import type { EvidenceRecord } from "../../../types/evidence";
import { normalizeEvidenceRecords } from "../evidence";
import { normalizeSourceItemKeys } from "../note-source-provenance";
import { normalizeQuotedMessageRefs } from "../quoted-messages";

export type QueryableDatabase = {
  queryAsync(sql: string, params?: unknown[]): Promise<any[] | undefined>;
};

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

const MAX_STORED_EVIDENCE_JSON_CHARACTERS = 600_000;

// JSON escaping can expand each bounded string character to six characters
// (for example, a control character becomes `\\u0000`). Keep the raw guard
// above the worst-case size of three normalized references.
const MAX_STORED_QUOTED_MESSAGES_JSON_CHARACTERS = 128_000;

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
