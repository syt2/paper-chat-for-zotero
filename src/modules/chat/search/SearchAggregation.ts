import {
  compareMessageSearchOrder,
  compareSessionSearchOrder,
  compareUtf8Bytes,
  decodeSearchCursor,
  encodeSearchCursor,
  type MessageSearchOrder,
  type SessionSearchOrder,
} from "./SearchCursor";
import {
  classifyMessageMatch,
  classifyTitleMatch,
  getSessionSearchCategory,
  type ParsedSearchQuery,
} from "./SearchQuery";
import { ChatHistorySearchError } from "./SearchTypes";

export const DEFAULT_SEARCH_MESSAGE_CANDIDATE_LIMIT = 3;

export type SearchableMessageRole = "user" | "assistant";
export type SearchTitleMatchKind = "exact" | "prefix" | "contains";

export interface SearchSessionMetadata {
  sessionId: string;
  sessionTitle: string | null;
  sessionUpdatedAt: number;
}

export interface IndexedSearchMessageCandidate extends MessageSearchOrder {
  role: SearchableMessageRole;
}

/**
 * A current-version SQL summary. `topMessageCandidates` must contain the
 * highest ranked `min(candidateLimit, totalMessageMatches)` rows from this
 * source partition. Keeping that coverage explicit lets the merger preserve a
 * bounded Top N while still publishing an exact total.
 */
export interface IndexedMessageSearchSummary extends SearchSessionMetadata {
  totalMessageMatches: number;
  bestMessageCategory: 0 | 1;
  topMessageCandidates: readonly IndexedSearchMessageCandidate[];
}

export interface LowerVersionMessageSearchSummary extends SearchSessionMetadata {
  totalMessageMatches: number;
  bestMessageCategory: 0 | 1;
  topMessageCandidates: readonly IndexedSearchMessageCandidate[];
}

export interface LowerVersionMessageSearchPartition {
  messageCandidateLimit: number;
  messageSummaries: readonly LowerVersionMessageSearchSummary[];
}

export interface IndexedTitleSearchCandidate extends SearchSessionMetadata {
  normalizedTitle: string;
}

/** A source-projected message whose stored search version is not current. */
export interface LowerVersionMessageSearchCandidate extends SearchSessionMetadata {
  messageId: string;
  role: string;
  messageTimestamp: number;
  messageSeq: number;
  normalizedText: string;
  sessionMessageCount: number;
}

/** A source-projected title whose stored search version is not current. */
export interface LowerVersionTitleSearchCandidate extends SearchSessionMetadata {
  normalizedTitle: string;
  sessionMessageCount: number;
}

export interface AggregatedSearchMessageCandidate extends MessageSearchOrder {
  sessionId: string;
  role: SearchableMessageRole;
}

export interface AggregatedSearchSession extends SessionSearchOrder {
  sessionTitle?: string;
  titleMatchKind?: SearchTitleMatchKind;
  totalMessageMatches: number;
  topMessageCandidates: AggregatedSearchMessageCandidate[];
}

export interface AggregateSearchSessionsInput {
  query: Pick<ParsedSearchQuery, "exactPhrase" | "terms">;
  indexedMessageSummaries: Iterable<IndexedMessageSearchSummary>;
  indexedTitleMatches: Iterable<IndexedTitleSearchCandidate>;
  /** Convenience route for bounded fixtures and already-materialized rows. */
  lowerVersionMessageCandidates?: Iterable<LowerVersionMessageSearchCandidate>;
  /** Bounded result from `LowerVersionMessagePartitionAccumulator`. */
  lowerVersionMessagePartition?: LowerVersionMessageSearchPartition;
  lowerVersionTitleCandidates: Iterable<LowerVersionTitleSearchCandidate>;
  messageCandidateLimit?: number;
}

interface MutableSessionAggregate extends SearchSessionMetadata {
  indexedMessageMatches: number;
  lowerVersionMessageMatches: number;
  bestMessageCategory?: 0 | 1;
  titleMatchKind?: SearchTitleMatchKind;
  titleSource?: "indexed" | "lower-version";
  topMessageCandidates: AggregatedSearchMessageCandidate[];
}

export interface SearchCursorContext {
  queryKey: string;
  searchRevision: number;
}

export interface SearchSessionPage<T extends SessionSearchOrder> {
  items: T[];
  nextCursor?: string;
}

export interface SearchMessagePage<T extends AggregatedSearchMessageCandidate> {
  items: T[];
  nextCursor?: string;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(`Invalid search aggregation input: ${message}`);
}

function assertNonEmptyId(value: string, field: string): void {
  invariant(typeof value === "string" && value.length > 0, `${field} is empty`);
}

function assertFiniteTimestamp(value: number, field: string): void {
  invariant(Number.isFinite(value), `${field} is not finite`);
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  invariant(
    Number.isSafeInteger(value) && value >= 0,
    `${field} is not a non-negative safe integer`,
  );
}

function normalizeTitle(title: string | null): string | null {
  return title === null ? null : String(title);
}

function validateMetadata(metadata: SearchSessionMetadata): void {
  assertNonEmptyId(metadata.sessionId, "sessionId");
  invariant(
    metadata.sessionTitle === null || typeof metadata.sessionTitle === "string",
    "sessionTitle is invalid",
  );
  assertFiniteTimestamp(metadata.sessionUpdatedAt, "sessionUpdatedAt");
}

function validateMessageOrder(order: MessageSearchOrder): void {
  invariant(
    order.category === 0 || order.category === 1,
    "message category is invalid",
  );
  assertFiniteTimestamp(order.messageTimestamp, "messageTimestamp");
  assertNonNegativeSafeInteger(order.messageSeq, "messageSeq");
  assertNonEmptyId(order.messageId, "messageId");
}

function validateCandidateLimit(limit: number): number {
  invariant(
    Number.isSafeInteger(limit) && limit >= 0,
    "messageCandidateLimit is invalid",
  );
  return limit;
}

function validatePageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Search page limit must be a positive safe integer");
  }
  return limit;
}

function metadataMatches(
  aggregate: MutableSessionAggregate,
  metadata: SearchSessionMetadata,
): boolean {
  return (
    aggregate.sessionUpdatedAt === metadata.sessionUpdatedAt &&
    normalizeTitle(aggregate.sessionTitle) ===
      normalizeTitle(metadata.sessionTitle)
  );
}

function getOrCreateSession(
  sessions: Map<string, MutableSessionAggregate>,
  metadata: SearchSessionMetadata,
): MutableSessionAggregate {
  validateMetadata(metadata);
  const existing = sessions.get(metadata.sessionId);
  if (existing) {
    invariant(
      metadataMatches(existing, metadata),
      `conflicting metadata for session ${metadata.sessionId}`,
    );
    return existing;
  }

  const created: MutableSessionAggregate = {
    sessionId: metadata.sessionId,
    sessionTitle: normalizeTitle(metadata.sessionTitle),
    sessionUpdatedAt: metadata.sessionUpdatedAt,
    indexedMessageMatches: 0,
    lowerVersionMessageMatches: 0,
    topMessageCandidates: [],
  };
  sessions.set(metadata.sessionId, created);
  return created;
}

function retainTopMessageCandidate(
  aggregate: MutableSessionAggregate,
  candidate: AggregatedSearchMessageCandidate,
  limit: number,
): void {
  if (limit === 0) return;
  const existingIndex = aggregate.topMessageCandidates.findIndex(
    (value) => value.messageId === candidate.messageId,
  );
  if (existingIndex >= 0) {
    const existing = aggregate.topMessageCandidates[existingIndex];
    invariant(
      existing.sessionId === candidate.sessionId &&
        existing.role === candidate.role &&
        compareMessageSearchOrder(existing, candidate) === 0,
      `conflicting candidate for message ${candidate.messageId}`,
    );
    return;
  }

  aggregate.topMessageCandidates.push(candidate);
  aggregate.topMessageCandidates.sort(compareMessageSearchOrder);
  if (aggregate.topMessageCandidates.length > limit) {
    aggregate.topMessageCandidates.length = limit;
  }
}

function compareLowerVersionCandidateToOrder(
  candidate: LowerVersionMessageSearchCandidate,
  category: 0 | 1,
  order: AggregatedSearchMessageCandidate,
): number {
  if (category !== order.category) return category - order.category;
  if (candidate.messageTimestamp !== order.messageTimestamp) {
    return order.messageTimestamp - candidate.messageTimestamp;
  }
  if (candidate.messageSeq !== order.messageSeq) {
    return order.messageSeq - candidate.messageSeq;
  }
  return compareUtf8Bytes(candidate.messageId, order.messageId);
}

/** Avoid allocating a candidate object when it cannot enter the bounded Top N. */
function retainTopLowerVersionMessageCandidate(
  aggregate: MutableSessionAggregate,
  candidate: LowerVersionMessageSearchCandidate,
  category: 0 | 1,
  limit: number,
): void {
  if (limit === 0) return;
  const existingIndex = aggregate.topMessageCandidates.findIndex(
    (value) => value.messageId === candidate.messageId,
  );
  if (existingIndex >= 0) {
    const existing = aggregate.topMessageCandidates[existingIndex];
    invariant(
      existing.sessionId === candidate.sessionId &&
        existing.role === candidate.role &&
        compareLowerVersionCandidateToOrder(candidate, category, existing) ===
          0,
      `conflicting candidate for message ${candidate.messageId}`,
    );
    return;
  }
  if (aggregate.topMessageCandidates.length >= limit) {
    const worst = aggregate.topMessageCandidates.at(-1)!;
    if (compareLowerVersionCandidateToOrder(candidate, category, worst) >= 0) {
      return;
    }
  }

  retainTopMessageCandidate(
    aggregate,
    {
      sessionId: candidate.sessionId,
      messageId: candidate.messageId,
      role: candidate.role as SearchableMessageRole,
      category,
      messageTimestamp: candidate.messageTimestamp,
      messageSeq: candidate.messageSeq,
    },
    limit,
  );
}

function titleKindCategory(kind: SearchTitleMatchKind): 0 | 1 {
  return kind === "exact" ? 0 : 1;
}

function minMessageCategory(left: 0 | 1, right: 0 | 1): 0 | 1 {
  return left === 0 || right === 0 ? 0 : 1;
}

function mergeTitleMatch(
  aggregate: MutableSessionAggregate,
  kind: SearchTitleMatchKind,
  source: "indexed" | "lower-version",
): void {
  if (!aggregate.titleMatchKind) {
    aggregate.titleMatchKind = kind;
    aggregate.titleSource = source;
    return;
  }

  invariant(
    aggregate.titleSource === source,
    `session ${aggregate.sessionId} appears in both title version partitions`,
  );
  if (titleKindCategory(kind) < titleKindCategory(aggregate.titleMatchKind)) {
    aggregate.titleMatchKind = kind;
  }
}

function isSearchableRole(role: string): role is SearchableMessageRole {
  return role === "user" || role === "assistant";
}

function classifyLowerVersionMessageCandidate(
  candidate: LowerVersionMessageSearchCandidate,
  query: Pick<ParsedSearchQuery, "exactPhrase" | "terms">,
): 0 | 1 | null {
  validateMetadata(candidate);
  assertNonEmptyId(candidate.messageId, "messageId");
  assertFiniteTimestamp(candidate.messageTimestamp, "messageTimestamp");
  assertNonNegativeSafeInteger(candidate.messageSeq, "messageSeq");
  assertNonNegativeSafeInteger(
    candidate.sessionMessageCount,
    "sessionMessageCount",
  );
  invariant(
    typeof candidate.normalizedText === "string",
    `normalized text for message ${candidate.messageId} is invalid`,
  );

  if (candidate.sessionMessageCount === 0) return null;
  const category = classifyMessageMatch(candidate.normalizedText, query);
  if (category === null) return null;
  invariant(
    isSearchableRole(candidate.role),
    `matching message ${candidate.messageId} has a non-searchable role`,
  );
  return category;
}

/**
 * Incrementally summarizes an exhaustive lower-version keyset scan. The caller
 * must feed each source row exactly once (the `(version, id BINARY)` scan
 * already guarantees this). Only one aggregate and Top N tuples per session
 * are retained; normalized message bodies are released after `add()` returns.
 */
export class LowerVersionMessagePartitionAccumulator {
  private readonly sessions = new Map<string, MutableSessionAggregate>();
  readonly messageCandidateLimit: number;

  constructor(
    private readonly query: Pick<ParsedSearchQuery, "exactPhrase" | "terms">,
    messageCandidateLimit: number = DEFAULT_SEARCH_MESSAGE_CANDIDATE_LIMIT,
  ) {
    this.messageCandidateLimit = validateCandidateLimit(messageCandidateLimit);
  }

  add(candidate: LowerVersionMessageSearchCandidate): void {
    const category = classifyLowerVersionMessageCandidate(
      candidate,
      this.query,
    );
    if (category === null) return;

    const aggregate = getOrCreateSession(this.sessions, candidate);
    aggregate.lowerVersionMessageMatches += 1;
    aggregate.bestMessageCategory =
      aggregate.bestMessageCategory === undefined
        ? category
        : minMessageCategory(aggregate.bestMessageCategory, category);
    retainTopLowerVersionMessageCandidate(
      aggregate,
      candidate,
      category,
      this.messageCandidateLimit,
    );
  }

  addAll(candidates: Iterable<LowerVersionMessageSearchCandidate>): void {
    for (const candidate of candidates) this.add(candidate);
  }

  finish(): LowerVersionMessageSearchPartition {
    const messageSummaries = Array.from(this.sessions.values(), (session) => ({
      sessionId: session.sessionId,
      sessionTitle: session.sessionTitle,
      sessionUpdatedAt: session.sessionUpdatedAt,
      totalMessageMatches: session.lowerVersionMessageMatches,
      bestMessageCategory: session.bestMessageCategory!,
      topMessageCandidates: session.topMessageCandidates.map((candidate) => ({
        messageId: candidate.messageId,
        role: candidate.role,
        category: candidate.category,
        messageTimestamp: candidate.messageTimestamp,
        messageSeq: candidate.messageSeq,
      })),
    }));
    messageSummaries.sort((left, right) =>
      compareSessionSearchOrder(
        {
          category: left.bestMessageCategory,
          sessionUpdatedAt: left.sessionUpdatedAt,
          sessionId: left.sessionId,
        },
        {
          category: right.bestMessageCategory,
          sessionUpdatedAt: right.sessionUpdatedAt,
          sessionId: right.sessionId,
        },
      ),
    );
    return {
      messageCandidateLimit: this.messageCandidateLimit,
      messageSummaries,
    };
  }
}

/**
 * Merge current inline-index summaries with exhaustively projected old rows.
 * Exact counts are kept separately from bounded candidate tuples. Source rows
 * can be supplied as generators, so the merger never needs to retain projected
 * message bodies; it keeps only per-session state and stable IDs for deduping.
 */
export function aggregateSearchSessions(
  input: AggregateSearchSessionsInput,
): AggregatedSearchSession[] {
  const candidateLimit = validateCandidateLimit(
    input.messageCandidateLimit ?? DEFAULT_SEARCH_MESSAGE_CANDIDATE_LIMIT,
  );
  invariant(
    !input.lowerVersionMessageCandidates || !input.lowerVersionMessagePartition,
    "provide lower-version message rows or a summarized partition, not both",
  );
  const sessions = new Map<string, MutableSessionAggregate>();
  const indexedSummarySessions = new Set<string>();
  const indexedCandidateIds = new Set<string>();

  for (const summary of input.indexedMessageSummaries) {
    validateMetadata(summary);
    invariant(
      !indexedSummarySessions.has(summary.sessionId),
      `duplicate indexed summary for session ${summary.sessionId}`,
    );
    indexedSummarySessions.add(summary.sessionId);
    assertNonNegativeSafeInteger(
      summary.totalMessageMatches,
      "totalMessageMatches",
    );
    invariant(
      summary.totalMessageMatches > 0,
      `indexed summary for session ${summary.sessionId} is empty`,
    );
    invariant(
      summary.bestMessageCategory === 0 || summary.bestMessageCategory === 1,
      `best message category for session ${summary.sessionId} is invalid`,
    );
    invariant(
      Array.isArray(summary.topMessageCandidates),
      `indexed candidates for session ${summary.sessionId} are invalid`,
    );
    invariant(
      summary.topMessageCandidates.length ===
        Math.min(candidateLimit, summary.totalMessageMatches),
      `indexed candidate coverage for session ${summary.sessionId} is incomplete`,
    );

    const aggregate = getOrCreateSession(sessions, summary);
    aggregate.indexedMessageMatches = summary.totalMessageMatches;
    aggregate.bestMessageCategory = summary.bestMessageCategory;

    let candidateBestCategory: 0 | 1 | undefined;
    for (const candidate of summary.topMessageCandidates) {
      validateMessageOrder(candidate);
      const candidateCategory: 0 | 1 = candidate.category === 0 ? 0 : 1;
      invariant(
        isSearchableRole(candidate.role),
        `message ${candidate.messageId} has a non-searchable role`,
      );
      invariant(
        !indexedCandidateIds.has(candidate.messageId),
        `duplicate indexed message ${candidate.messageId}`,
      );
      indexedCandidateIds.add(candidate.messageId);
      candidateBestCategory =
        candidateBestCategory === undefined
          ? candidateCategory
          : minMessageCategory(candidateBestCategory, candidateCategory);
      retainTopMessageCandidate(
        aggregate,
        { ...candidate, sessionId: summary.sessionId },
        candidateLimit,
      );
    }
    if (candidateLimit > 0) {
      invariant(
        candidateBestCategory === summary.bestMessageCategory,
        `best category disagrees with indexed candidates for session ${summary.sessionId}`,
      );
    }
  }

  const lowerPartitionSessions = new Set<string>();
  const lowerPartitionCandidateIds = new Set<string>();
  const lowerPartition = input.lowerVersionMessagePartition;
  if (lowerPartition) {
    invariant(
      lowerPartition.messageCandidateLimit === candidateLimit,
      "lower-version partition candidate limit does not match",
    );
    for (const summary of lowerPartition.messageSummaries) {
      validateMetadata(summary);
      invariant(
        !lowerPartitionSessions.has(summary.sessionId),
        `duplicate lower-version summary for session ${summary.sessionId}`,
      );
      lowerPartitionSessions.add(summary.sessionId);
      assertNonNegativeSafeInteger(
        summary.totalMessageMatches,
        "totalMessageMatches",
      );
      invariant(
        summary.totalMessageMatches > 0,
        `lower-version summary for session ${summary.sessionId} is empty`,
      );
      invariant(
        summary.bestMessageCategory === 0 || summary.bestMessageCategory === 1,
        `best lower-version category for session ${summary.sessionId} is invalid`,
      );
      invariant(
        Array.isArray(summary.topMessageCandidates) &&
          summary.topMessageCandidates.length ===
            Math.min(candidateLimit, summary.totalMessageMatches),
        `lower-version candidate coverage for session ${summary.sessionId} is incomplete`,
      );

      const aggregate = getOrCreateSession(sessions, summary);
      aggregate.lowerVersionMessageMatches = summary.totalMessageMatches;
      aggregate.bestMessageCategory =
        aggregate.bestMessageCategory === undefined
          ? summary.bestMessageCategory
          : minMessageCategory(
              aggregate.bestMessageCategory,
              summary.bestMessageCategory,
            );

      let candidateBestCategory: 0 | 1 | undefined;
      for (const candidate of summary.topMessageCandidates) {
        validateMessageOrder(candidate);
        invariant(
          isSearchableRole(candidate.role),
          `message ${candidate.messageId} has a non-searchable role`,
        );
        invariant(
          !indexedCandidateIds.has(candidate.messageId),
          `message ${candidate.messageId} appears in both version partitions`,
        );
        invariant(
          !lowerPartitionCandidateIds.has(candidate.messageId),
          `duplicate lower-version message ${candidate.messageId}`,
        );
        lowerPartitionCandidateIds.add(candidate.messageId);
        const category: 0 | 1 = candidate.category === 0 ? 0 : 1;
        candidateBestCategory =
          candidateBestCategory === undefined
            ? category
            : minMessageCategory(candidateBestCategory, category);
        retainTopMessageCandidate(
          aggregate,
          { ...candidate, sessionId: summary.sessionId },
          candidateLimit,
        );
      }
      if (candidateLimit > 0) {
        invariant(
          candidateBestCategory === summary.bestMessageCategory,
          `best category disagrees with lower-version candidates for session ${summary.sessionId}`,
        );
      }
    }
  }

  const indexedTitleSessions = new Set<string>();
  for (const title of input.indexedTitleMatches) {
    validateMetadata(title);
    invariant(
      typeof title.normalizedTitle === "string",
      `normalized title for session ${title.sessionId} is invalid`,
    );
    invariant(
      !indexedTitleSessions.has(title.sessionId),
      `duplicate indexed title for session ${title.sessionId}`,
    );
    indexedTitleSessions.add(title.sessionId);
    const kind = classifyTitleMatch(
      title.normalizedTitle,
      input.query.exactPhrase,
    );
    invariant(
      kind,
      `indexed title for session ${title.sessionId} does not match`,
    );
    mergeTitleMatch(getOrCreateSession(sessions, title), kind, "indexed");
  }

  const lowerMatchingMessageIds = new Set<string>();
  for (const candidate of input.lowerVersionMessageCandidates ?? []) {
    const category = classifyLowerVersionMessageCandidate(
      candidate,
      input.query,
    );
    if (category === null) continue;
    invariant(
      isSearchableRole(candidate.role),
      `matching message ${candidate.messageId} has a non-searchable role`,
    );
    invariant(
      !indexedCandidateIds.has(candidate.messageId),
      `message ${candidate.messageId} appears in both version partitions`,
    );
    if (lowerMatchingMessageIds.has(candidate.messageId)) continue;
    lowerMatchingMessageIds.add(candidate.messageId);

    const aggregate = getOrCreateSession(sessions, candidate);
    aggregate.lowerVersionMessageMatches += 1;
    aggregate.bestMessageCategory =
      aggregate.bestMessageCategory === undefined
        ? category
        : minMessageCategory(aggregate.bestMessageCategory, category);
    retainTopMessageCandidate(
      aggregate,
      {
        sessionId: candidate.sessionId,
        messageId: candidate.messageId,
        role: candidate.role,
        category,
        messageTimestamp: candidate.messageTimestamp,
        messageSeq: candidate.messageSeq,
      },
      candidateLimit,
    );
  }

  const lowerTitleSessions = new Set<string>();
  for (const title of input.lowerVersionTitleCandidates) {
    validateMetadata(title);
    assertNonNegativeSafeInteger(
      title.sessionMessageCount,
      "sessionMessageCount",
    );
    invariant(
      typeof title.normalizedTitle === "string",
      `normalized title for session ${title.sessionId} is invalid`,
    );
    if (title.sessionMessageCount === 0) continue;
    invariant(
      !lowerTitleSessions.has(title.sessionId),
      `duplicate lower-version title for session ${title.sessionId}`,
    );
    lowerTitleSessions.add(title.sessionId);

    const kind = classifyTitleMatch(
      title.normalizedTitle,
      input.query.exactPhrase,
    );
    if (!kind) continue;
    mergeTitleMatch(getOrCreateSession(sessions, title), kind, "lower-version");
  }

  const result: AggregatedSearchSession[] = [];
  for (const aggregate of sessions.values()) {
    const totalMessageMatches =
      aggregate.indexedMessageMatches + aggregate.lowerVersionMessageMatches;
    const category = getSessionSearchCategory(
      aggregate.titleMatchKind,
      aggregate.bestMessageCategory,
    );
    if (category === null) continue;

    aggregate.topMessageCandidates.sort(compareMessageSearchOrder);
    invariant(
      aggregate.topMessageCandidates.length ===
        Math.min(candidateLimit, totalMessageMatches),
      `merged candidate coverage for session ${aggregate.sessionId} is incomplete`,
    );
    result.push({
      category,
      sessionId: aggregate.sessionId,
      sessionTitle: aggregate.sessionTitle ?? undefined,
      sessionUpdatedAt: aggregate.sessionUpdatedAt,
      titleMatchKind: aggregate.titleMatchKind,
      totalMessageMatches,
      topMessageCandidates: aggregate.topMessageCandidates,
    });
  }

  return result.sort(compareSessionSearchOrder);
}

function validateCursorContext(context: SearchCursorContext): void {
  if (!context.queryKey) {
    throw new ChatHistorySearchError(
      "INVALID_CURSOR",
      "Invalid cursor context",
    );
  }
  if (
    !Number.isSafeInteger(context.searchRevision) ||
    context.searchRevision < 0
  ) {
    throw new ChatHistorySearchError(
      "INVALID_CURSOR",
      "Invalid cursor context",
    );
  }
}

export function validateSessionSearchCursor(
  cursorValue: string,
  context: SearchCursorContext,
): SessionSearchOrder {
  validateCursorContext(context);
  const cursor = decodeSearchCursor(cursorValue);
  if (cursor.kind !== "session" || cursor.queryKey !== context.queryKey) {
    throw new ChatHistorySearchError(
      "INVALID_CURSOR",
      "Cursor does not belong to this search",
    );
  }
  if (cursor.searchRevision !== context.searchRevision) {
    throw new ChatHistorySearchError(
      "STALE_SEARCH",
      "Search results changed; restart from the first page",
    );
  }
  return cursor.order;
}

export function validateMessageSearchCursor(
  cursorValue: string,
  context: SearchCursorContext,
  sessionId: string,
): MessageSearchOrder {
  validateCursorContext(context);
  assertNonEmptyId(sessionId, "sessionId");
  const cursor = decodeSearchCursor(cursorValue);
  if (
    cursor.kind !== "message" ||
    cursor.queryKey !== context.queryKey ||
    cursor.sessionId !== sessionId
  ) {
    throw new ChatHistorySearchError(
      "INVALID_CURSOR",
      "Cursor does not belong to this session search",
    );
  }
  if (cursor.searchRevision !== context.searchRevision) {
    throw new ChatHistorySearchError(
      "STALE_SEARCH",
      "Search results changed; restart from the first page",
    );
  }
  return cursor.order;
}

export function paginateSearchSessions<T extends SessionSearchOrder>(
  groups: readonly T[],
  context: SearchCursorContext,
  limit: number,
  cursorValue?: string,
): SearchSessionPage<T> {
  validateCursorContext(context);
  const pageLimit = validatePageLimit(limit);
  const cursorOrder = cursorValue
    ? validateSessionSearchCursor(cursorValue, context)
    : undefined;
  const sorted = [...groups].sort(compareSessionSearchOrder);
  const afterCursor = cursorOrder
    ? sorted.filter(
        (candidate) => compareSessionSearchOrder(candidate, cursorOrder) > 0,
      )
    : sorted;
  const items = afterCursor.slice(0, pageLimit);
  const hasMore = afterCursor.length > items.length;
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeSearchCursor({
            version: 1,
            kind: "session",
            queryKey: context.queryKey,
            searchRevision: context.searchRevision,
            order: {
              category: last.category,
              sessionUpdatedAt: last.sessionUpdatedAt,
              sessionId: last.sessionId,
            },
          })
        : undefined,
  };
}

export function paginateSearchMessages<
  T extends AggregatedSearchMessageCandidate,
>(
  candidates: readonly T[],
  context: SearchCursorContext,
  sessionId: string,
  limit: number,
  cursorValue?: string,
): SearchMessagePage<T> {
  validateCursorContext(context);
  assertNonEmptyId(sessionId, "sessionId");
  const pageLimit = validatePageLimit(limit);
  const cursorOrder = cursorValue
    ? validateMessageSearchCursor(cursorValue, context, sessionId)
    : undefined;
  const messageIds = new Set<string>();
  for (const candidate of candidates) {
    invariant(
      candidate.sessionId === sessionId,
      `message ${candidate.messageId} belongs to another session`,
    );
    validateMessageOrder(candidate);
    invariant(
      !messageIds.has(candidate.messageId),
      `duplicate message ${candidate.messageId}`,
    );
    messageIds.add(candidate.messageId);
  }

  const sorted = [...candidates].sort(compareMessageSearchOrder);
  const afterCursor = cursorOrder
    ? sorted.filter(
        (candidate) => compareMessageSearchOrder(candidate, cursorOrder) > 0,
      )
    : sorted;
  const items = afterCursor.slice(0, pageLimit);
  const hasMore = afterCursor.length > items.length;
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeSearchCursor({
            version: 1,
            kind: "message",
            queryKey: context.queryKey,
            searchRevision: context.searchRevision,
            sessionId,
            order: {
              category: last.category,
              messageTimestamp: last.messageTimestamp,
              messageSeq: last.messageSeq,
              messageId: last.messageId,
            },
          })
        : undefined,
  };
}

/** Build the initial group's expansion cursor from its exact total. */
export function createNextMessageCursorForSearchGroup(
  group: AggregatedSearchSession,
  context: SearchCursorContext,
): string | undefined {
  validateCursorContext(context);
  if (
    group.totalMessageMatches <= group.topMessageCandidates.length ||
    group.topMessageCandidates.length === 0
  ) {
    return undefined;
  }
  const last = group.topMessageCandidates.at(-1)!;
  return encodeSearchCursor({
    version: 1,
    kind: "message",
    queryKey: context.queryKey,
    searchRevision: context.searchRevision,
    sessionId: group.sessionId,
    order: {
      category: last.category,
      messageTimestamp: last.messageTimestamp,
      messageSeq: last.messageSeq,
      messageId: last.messageId,
    },
  });
}
