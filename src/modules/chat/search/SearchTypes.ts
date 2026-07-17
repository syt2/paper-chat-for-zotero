export interface SearchHighlightRange {
  start: number;
  end: number;
}

export interface SearchHistoryGroupsRequest {
  query: string;
  sessionLimit?: number;
  sessionCursor?: string;
  initialMessageLimit?: number;
}

export interface ChatHistoryTitleMatch {
  kind: "exact" | "prefix" | "contains";
  snippet: string;
  highlightRanges: SearchHighlightRange[];
}

export interface ChatHistoryMessageMatch {
  messageId: string;
  role: "user" | "assistant";
  messageTimestamp: number;
  messageSeq: number;
  snippet: string;
  highlightRanges: SearchHighlightRange[];
}

export interface ChatHistorySearchGroup {
  sessionId: string;
  sessionTitle?: string;
  sessionUpdatedAt: number;
  titleMatch?: ChatHistoryTitleMatch;
  totalMessageMatches: number;
  matches: ChatHistoryMessageMatch[];
  nextMessageCursor?: string;
}

export interface ChatHistorySearchPage {
  queryKey: string;
  searchRevision: number;
  groups: ChatHistorySearchGroup[];
  nextSessionCursor?: string;
}

export interface SearchHistorySessionMatchesRequest {
  query: string;
  queryKey: string;
  searchRevision: number;
  sessionId: string;
  limit?: number;
  messageCursor?: string;
}

export interface ChatHistoryMessagePage {
  queryKey: string;
  searchRevision: number;
  sessionId: string;
  totalMessageMatches: number;
  matches: ChatHistoryMessageMatch[];
  nextMessageCursor?: string;
}

export type ChatHistorySearchErrorCode =
  | "QUERY_TOO_SHORT"
  | "QUERY_TOO_LONG"
  | "INVALID_REQUEST"
  | "INVALID_CURSOR"
  | "STALE_SEARCH"
  | "SEARCH_UNAVAILABLE";

export class ChatHistorySearchError extends Error {
  readonly code: ChatHistorySearchErrorCode;

  constructor(code: ChatHistorySearchErrorCode, message: string) {
    super(message);
    this.name = "ChatHistorySearchError";
    this.code = code;
  }
}
