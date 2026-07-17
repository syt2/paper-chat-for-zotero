import { assert } from "chai";
import {
  classifyMessageMatch,
  classifyTitleMatch,
  getSessionSearchCategory,
  MAX_SEARCH_QUERY_CODE_POINTS,
  MAX_SEARCH_QUERY_RAW_UTF16_LENGTH,
  MAX_SEARCH_QUERY_TERMS,
  parseSearchQuery,
} from "../src/modules/chat/search/SearchQuery.ts";
import {
  compareMessageSearchOrder,
  compareSessionSearchOrder,
} from "../src/modules/chat/search/SearchCursor.ts";
import { ChatHistorySearchError } from "../src/modules/chat/search/SearchTypes.ts";

describe("chat history search query semantics", function () {
  it("normalizes and deduplicates literal AND terms", function () {
    assert.deepEqual(parseSearchQuery("  Ａ 研究 A  "), {
      rawQuery: "  Ａ 研究 A  ",
      normalizedQuery: "a 研究 a",
      exactPhrase: "a 研究 a",
      terms: ["a", "研究"],
    });
    assert.throws(
      () => parseSearchQuery("Ａ"),
      ChatHistorySearchError,
      "at least two",
    );
  });

  it("treats punctuation and wildcard-looking input literally", function () {
    const query = parseSearchQuery("%_\\");
    assert.equal(classifyMessageMatch("literal %_\\ value", query), 0);
    assert.isNull(classifyMessageMatch("literal percent value", query));
  });

  it("rejects queries that exceed the SQL-safe length or term bounds", function () {
    assert.equal(
      parseSearchQuery("a".repeat(MAX_SEARCH_QUERY_CODE_POINTS)).normalizedQuery
        .length,
      MAX_SEARCH_QUERY_CODE_POINTS,
    );
    for (const value of [
      "a".repeat(MAX_SEARCH_QUERY_CODE_POINTS + 1),
      Array.from(
        { length: MAX_SEARCH_QUERY_TERMS + 1 },
        (_, index) => `term${index}`,
      ).join(" "),
    ]) {
      try {
        parseSearchQuery(value);
        assert.fail("expected QUERY_TOO_LONG");
      } catch (error) {
        assert.instanceOf(error, ChatHistorySearchError);
        assert.equal((error as ChatHistorySearchError).code, "QUERY_TOO_LONG");
      }
    }
  });

  it("rejects oversized raw input before Unicode normalization", function () {
    const originalNormalize = String.prototype.normalize;
    let normalizeCalls = 0;
    String.prototype.normalize = function (...args): string {
      normalizeCalls += 1;
      return originalNormalize.apply(this, args);
    };
    try {
      assert.throws(
        () =>
          parseSearchQuery(" ".repeat(MAX_SEARCH_QUERY_RAW_UTF16_LENGTH + 1)),
        ChatHistorySearchError,
        "UTF-16 code units",
      );
      assert.equal(normalizeCalls, 0);
    } finally {
      String.prototype.normalize = originalNormalize;
    }
  });

  it("allows reasonable NFKC input to reach the normalized limit", function () {
    const compatibilityCharacters = "𝐀".repeat(MAX_SEARCH_QUERY_CODE_POINTS);
    assert.isAbove(
      compatibilityCharacters.length,
      MAX_SEARCH_QUERY_CODE_POINTS,
    );
    assert.isAtMost(
      compatibilityCharacters.length,
      MAX_SEARCH_QUERY_RAW_UTF16_LENGTH,
    );
    assert.equal(
      parseSearchQuery(compatibilityCharacters).normalizedQuery,
      "a".repeat(MAX_SEARCH_QUERY_CODE_POINTS),
    );
  });

  it("ranks title matches before message matches", function () {
    assert.equal(
      classifyTitleMatch("local research", "local research"),
      "exact",
    );
    assert.equal(classifyTitleMatch("local research notes", "local"), "prefix");
    assert.equal(classifyTitleMatch("my local notes", "local"), "contains");
    assert.equal(getSessionSearchCategory("contains", 0), 1);
    assert.equal(getSessionSearchCategory(null, 0), 2);
    assert.equal(getSessionSearchCategory(null, 1), 3);
  });

  it("uses exact phrase, timestamp, sequence, and binary id tie-breaks", function () {
    const messages = [
      {
        category: 1,
        messageTimestamp: 100,
        messageSeq: 2,
        messageId: "b",
      },
      {
        category: 0,
        messageTimestamp: 1,
        messageSeq: 1,
        messageId: "z",
      },
      {
        category: 1,
        messageTimestamp: 100,
        messageSeq: 2,
        messageId: "a",
      },
    ].sort(compareMessageSearchOrder);
    assert.deepEqual(
      messages.map((message) => message.messageId),
      ["z", "a", "b"],
    );

    const sessions = [
      { category: 2, sessionUpdatedAt: 10, sessionId: "b" },
      { category: 1, sessionUpdatedAt: 1, sessionId: "z" },
      { category: 2, sessionUpdatedAt: 10, sessionId: "a" },
    ].sort(compareSessionSearchOrder);
    assert.deepEqual(
      sessions.map((session) => session.sessionId),
      ["z", "a", "b"],
    );
  });
});
