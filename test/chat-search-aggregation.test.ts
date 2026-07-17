import { assert } from "chai";
import {
  aggregateSearchSessions,
  createNextMessageCursorForSearchGroup,
  LowerVersionMessagePartitionAccumulator,
  paginateSearchMessages,
  paginateSearchSessions,
  validateMessageSearchCursor,
  validateSessionSearchCursor,
  type AggregatedSearchMessageCandidate,
  type AggregateSearchSessionsInput,
  type IndexedMessageSearchSummary,
  type LowerVersionMessageSearchCandidate,
} from "../src/modules/chat/search/SearchAggregation.ts";
import {
  decodeSearchCursor,
  encodeSearchCursor,
} from "../src/modules/chat/search/SearchCursor.ts";
import { parseSearchQuery } from "../src/modules/chat/search/SearchQuery.ts";
import { ChatHistorySearchError } from "../src/modules/chat/search/SearchTypes.ts";

const query = parseSearchQuery("local research");

function indexedSummary(
  overrides: Partial<IndexedMessageSearchSummary> = {},
): IndexedMessageSearchSummary {
  return {
    sessionId: "combined",
    sessionTitle: "Combined notes",
    sessionUpdatedAt: 300,
    totalMessageMatches: 3,
    bestMessageCategory: 0,
    topMessageCandidates: [
      {
        messageId: "indexed-exact",
        role: "assistant",
        category: 0,
        messageTimestamp: 90,
        messageSeq: 9,
      },
      {
        messageId: "indexed-terms-new",
        role: "user",
        category: 1,
        messageTimestamp: 120,
        messageSeq: 12,
      },
      {
        messageId: "indexed-terms-old",
        role: "assistant",
        category: 1,
        messageTimestamp: 80,
        messageSeq: 8,
      },
    ],
    ...overrides,
  };
}

function lowerMessage(
  overrides: Partial<LowerVersionMessageSearchCandidate> = {},
): LowerVersionMessageSearchCandidate {
  return {
    sessionId: "combined",
    sessionTitle: "Combined notes",
    sessionUpdatedAt: 300,
    sessionMessageCount: 5,
    messageId: "lower-exact",
    role: "assistant",
    messageTimestamp: 100,
    messageSeq: 10,
    normalizedText: "a local research answer",
    ...overrides,
  };
}

function aggregate(overrides: Partial<AggregateSearchSessionsInput> = {}) {
  return aggregateSearchSessions({
    query,
    indexedMessageSummaries: [],
    indexedTitleMatches: [],
    lowerVersionTitleCandidates: [],
    ...overrides,
  });
}

describe("chat history search aggregation", function () {
  it("merges indexed and projected partitions with exact totals and bounded Top N", function () {
    const groups = aggregate({
      indexedMessageSummaries: [indexedSummary()],
      lowerVersionMessageCandidates: [
        lowerMessage(),
        lowerMessage({
          messageId: "lower-terms",
          messageTimestamp: 130,
          messageSeq: 13,
          normalizedText: "research before local",
        }),
        lowerMessage({
          messageId: "lower-hidden",
          role: "tool",
          normalizedText: "",
        }),
      ],
    });

    assert.lengthOf(groups, 1);
    assert.equal(groups[0].totalMessageMatches, 5);
    assert.equal(groups[0].category, 2);
    assert.deepEqual(
      groups[0].topMessageCandidates.map((message) => message.messageId),
      ["lower-exact", "indexed-exact", "lower-terms"],
    );
  });

  it("deduplicates projected rows by stable message ID", function () {
    const duplicate = lowerMessage();
    const groups = aggregate({
      lowerVersionMessageCandidates: [duplicate, { ...duplicate }],
    });

    assert.equal(groups[0].totalMessageMatches, 1);
    assert.deepEqual(
      groups[0].topMessageCandidates.map((message) => message.messageId),
      ["lower-exact"],
    );
  });

  it("keeps row-wise and incremental lower-version partitions identical", function () {
    const lowerRows = [
      lowerMessage(),
      lowerMessage({
        messageId: "lower-terms",
        messageTimestamp: 130,
        messageSeq: 13,
        normalizedText: "research before local",
      }),
      lowerMessage({
        sessionId: "lower-only",
        sessionTitle: "Lower only",
        sessionUpdatedAt: 500,
        messageId: "lower-only-exact",
        normalizedText: "local research",
      }),
      lowerMessage({
        messageId: "excluded-tool",
        role: "tool",
        normalizedText: "",
      }),
    ];
    const rowWise = aggregate({
      indexedMessageSummaries: [indexedSummary()],
      lowerVersionMessageCandidates: lowerRows,
    });

    const accumulator = new LowerVersionMessagePartitionAccumulator(query, 3);
    accumulator.addAll(lowerRows.values());
    const partition = accumulator.finish();
    const summarized = aggregate({
      indexedMessageSummaries: [indexedSummary()],
      lowerVersionMessagePartition: partition,
    });

    assert.deepEqual(summarized, rowWise);
    assert.deepEqual(
      partition.messageSummaries.map((summary) => ({
        sessionId: summary.sessionId,
        total: summary.totalMessageMatches,
        retained: summary.topMessageCandidates.length,
      })),
      [
        { sessionId: "lower-only", total: 1, retained: 1 },
        { sessionId: "combined", total: 2, retained: 2 },
      ],
    );
  });

  it("orders title exact, title prefix/contains, exact messages, then term messages", function () {
    const groups = aggregate({
      indexedMessageSummaries: [
        indexedSummary({
          sessionId: "message-exact",
          sessionTitle: "Unrelated",
          sessionUpdatedAt: 999,
          totalMessageMatches: 1,
          topMessageCandidates: [
            {
              messageId: "m-exact",
              role: "assistant",
              category: 0,
              messageTimestamp: 1,
              messageSeq: 1,
            },
          ],
        }),
        indexedSummary({
          sessionId: "message-terms",
          sessionTitle: "Other",
          sessionUpdatedAt: 1000,
          totalMessageMatches: 1,
          bestMessageCategory: 1,
          topMessageCandidates: [
            {
              messageId: "m-terms",
              role: "user",
              category: 1,
              messageTimestamp: 2,
              messageSeq: 2,
            },
          ],
        }),
      ],
      indexedTitleMatches: [
        {
          sessionId: "title-exact",
          sessionTitle: "Local Research",
          sessionUpdatedAt: 1,
          normalizedTitle: "local research",
        },
        {
          sessionId: "title-prefix-old",
          sessionTitle: "Local Research Archive",
          sessionUpdatedAt: 10,
          normalizedTitle: "local research archive",
        },
        {
          sessionId: "title-contains-new",
          sessionTitle: "My Local Research",
          sessionUpdatedAt: 20,
          normalizedTitle: "my local research",
        },
      ],
    });

    assert.deepEqual(
      groups.map((group) => group.sessionId),
      [
        "title-exact",
        "title-contains-new",
        "title-prefix-old",
        "message-exact",
        "message-terms",
      ],
    );
    assert.deepEqual(
      groups.map((group) => group.category),
      [0, 1, 1, 2, 3],
    );
    assert.equal(groups[0].totalMessageMatches, 0);
    assert.lengthOf(groups[0].topMessageCandidates, 0);
  });

  it("uses unsigned UTF-8 byte ordering for equal session and message tuples", function () {
    const groups = aggregate({
      lowerVersionMessageCandidates: [
        lowerMessage({
          sessionId: "é",
          sessionTitle: "E acute",
          messageId: "é",
          messageTimestamp: 10,
          messageSeq: 1,
        }),
        lowerMessage({
          sessionId: "a",
          sessionTitle: "A",
          messageId: "z",
          messageTimestamp: 10,
          messageSeq: 1,
        }),
        lowerMessage({
          sessionId: "a",
          sessionTitle: "A",
          messageId: "a",
          messageTimestamp: 10,
          messageSeq: 1,
        }),
      ],
    });

    assert.deepEqual(
      groups.map((group) => group.sessionId),
      ["a", "é"],
    );
    assert.deepEqual(
      groups[0].topMessageCandidates.map((message) => message.messageId),
      ["a", "z"],
    );
  });

  it("rejects incomplete indexed Top N coverage", function () {
    assert.throws(
      () =>
        aggregate({
          indexedMessageSummaries: [
            indexedSummary({
              topMessageCandidates: indexedSummary().topMessageCandidates.slice(
                0,
                2,
              ),
            }),
          ],
        }),
      "indexed candidate coverage",
    );
  });

  it("excludes empty sessions from lower-version title matches", function () {
    assert.deepEqual(
      aggregate({
        lowerVersionTitleCandidates: [
          {
            sessionId: "empty",
            sessionTitle: "Local Research",
            sessionUpdatedAt: 10,
            normalizedTitle: "local research",
            sessionMessageCount: 0,
          },
        ],
      }),
      [],
    );
  });

  describe("cursors", function () {
    const context = { queryKey: "query-key", searchRevision: 7 };

    const messageCandidates: AggregatedSearchMessageCandidate[] = [
      {
        sessionId: "session",
        messageId: "z",
        role: "assistant",
        category: 0,
        messageTimestamp: 100,
        messageSeq: 1,
      },
      {
        sessionId: "session",
        messageId: "a",
        role: "user",
        category: 1,
        messageTimestamp: 200,
        messageSeq: 2,
      },
      {
        sessionId: "session",
        messageId: "b",
        role: "assistant",
        category: 1,
        messageTimestamp: 200,
        messageSeq: 2,
      },
    ];

    it("paginates session groups without duplicates and binds the cursor", function () {
      const groups = aggregate({
        indexedTitleMatches: [
          {
            sessionId: "c",
            sessionTitle: "Local Research C",
            sessionUpdatedAt: 10,
            normalizedTitle: "local research c",
          },
          {
            sessionId: "a",
            sessionTitle: "Local Research A",
            sessionUpdatedAt: 10,
            normalizedTitle: "local research a",
          },
          {
            sessionId: "b",
            sessionTitle: "Local Research B",
            sessionUpdatedAt: 10,
            normalizedTitle: "local research b",
          },
        ],
      });
      const first = paginateSearchSessions(groups, context, 2);
      const second = paginateSearchSessions(
        groups,
        context,
        2,
        first.nextCursor,
      );

      assert.deepEqual(
        first.items.map((group) => group.sessionId),
        ["a", "b"],
      );
      assert.deepEqual(
        second.items.map((group) => group.sessionId),
        ["c"],
      );
      assert.isUndefined(second.nextCursor);
      assert.deepEqual(
        validateSessionSearchCursor(first.nextCursor!, context),
        {
          category: first.items[1].category,
          sessionUpdatedAt: first.items[1].sessionUpdatedAt,
          sessionId: first.items[1].sessionId,
        },
      );
    });

    it("paginates messages by category, timestamp, seq, and binary ID", function () {
      const first = paginateSearchMessages(
        messageCandidates,
        context,
        "session",
        2,
      );
      const second = paginateSearchMessages(
        messageCandidates,
        context,
        "session",
        2,
        first.nextCursor,
      );

      assert.deepEqual(
        first.items.map((message) => message.messageId),
        ["z", "a"],
      );
      assert.deepEqual(
        second.items.map((message) => message.messageId),
        ["b"],
      );
      assert.isUndefined(second.nextCursor);
    });

    it("creates an expansion cursor if and only if the exact total has more matches", function () {
      const group = aggregate({
        indexedMessageSummaries: [
          indexedSummary({
            topMessageCandidates: indexedSummary().topMessageCandidates.slice(
              0,
              2,
            ),
          }),
        ],
        messageCandidateLimit: 2,
      })[0];
      const cursor = createNextMessageCursorForSearchGroup(group, context);

      assert.isString(cursor);
      assert.equal(
        (decodeSearchCursor(cursor!) as { sessionId?: string }).sessionId,
        "combined",
      );
      assert.isUndefined(
        createNextMessageCursorForSearchGroup(
          { ...group, totalMessageMatches: group.topMessageCandidates.length },
          context,
        ),
      );
    });

    it("rejects cursors from another query, revision, kind, or session", function () {
      const messageCursor = encodeSearchCursor({
        version: 1,
        kind: "message",
        queryKey: context.queryKey,
        searchRevision: context.searchRevision,
        sessionId: "session",
        order: messageCandidates[0],
      });
      const sessionCursor = encodeSearchCursor({
        version: 1,
        kind: "session",
        queryKey: context.queryKey,
        searchRevision: context.searchRevision,
        order: { category: 1, sessionUpdatedAt: 1, sessionId: "session" },
      });

      assert.throws(
        () =>
          validateMessageSearchCursor(messageCursor, context, "other-session"),
        ChatHistorySearchError,
        "does not belong",
      );
      assert.throws(
        () => validateMessageSearchCursor(sessionCursor, context, "session"),
        ChatHistorySearchError,
        "does not belong",
      );
      assert.throws(
        () =>
          validateMessageSearchCursor(
            messageCursor,
            { ...context, queryKey: "another-query" },
            "session",
          ),
        ChatHistorySearchError,
        "does not belong",
      );
      try {
        validateMessageSearchCursor(
          messageCursor,
          { ...context, searchRevision: 8 },
          "session",
        );
        assert.fail("expected a stale-search error");
      } catch (error) {
        assert.instanceOf(error, ChatHistorySearchError);
        assert.equal((error as ChatHistorySearchError).code, "STALE_SEARCH");
      }
    });

    it("rejects cursor payloads with malformed nested ordering tuples", function () {
      const malformed = encodeSearchCursor({
        version: 1,
        kind: "session",
        queryKey: context.queryKey,
        searchRevision: context.searchRevision,
        order: {
          category: 1,
          sessionUpdatedAt: Number.NaN,
          sessionId: "session",
        },
      });

      assert.throws(
        () => validateSessionSearchCursor(malformed, context),
        ChatHistorySearchError,
        "Invalid cursor",
      );
    });
  });
});
