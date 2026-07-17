import { assert } from "chai";
import {
  compareMessageSearchOrder,
  compareSessionSearchOrder,
  compareUtf8Bytes,
  createSearchQueryKey,
  decodeSearchCursor,
  encodeSearchCursor,
} from "../src/modules/chat/search/SearchCursor.ts";
import { ChatHistorySearchError } from "../src/modules/chat/search/SearchTypes.ts";

describe("chat history search cursors", function () {
  it("round-trips Unicode session and message cursors", function () {
    const sessionCursor = encodeSearchCursor({
      version: 1,
      kind: "session",
      queryKey: "query-key",
      searchRevision: 12,
      order: {
        category: 2,
        sessionUpdatedAt: 100,
        sessionId: "会话-α",
      },
    });
    const messageCursor = encodeSearchCursor({
      version: 1,
      kind: "message",
      queryKey: "query-key",
      searchRevision: 12,
      sessionId: "会话-α",
      order: {
        category: 1,
        messageTimestamp: 99,
        messageSeq: 3,
        messageId: "消息-β",
      },
    });

    assert.deepEqual(decodeSearchCursor(sessionCursor), {
      version: 1,
      kind: "session",
      queryKey: "query-key",
      searchRevision: 12,
      order: {
        category: 2,
        sessionUpdatedAt: 100,
        sessionId: "会话-α",
      },
    });
    assert.equal(
      (decodeSearchCursor(messageCursor) as { sessionId: string }).sessionId,
      "会话-α",
    );
  });

  it("rejects malformed cursors", function () {
    assert.throws(
      () => decodeSearchCursor("not+base64"),
      ChatHistorySearchError,
      "Invalid cursor",
    );
  });

  it("uses the approved deterministic ordering tuples", function () {
    assert.isBelow(compareUtf8Bytes("a", "é"), 0);
    assert.isBelow(
      compareSessionSearchOrder(
        { category: 1, sessionUpdatedAt: 10, sessionId: "z" },
        { category: 2, sessionUpdatedAt: 20, sessionId: "a" },
      ),
      0,
    );
    assert.isBelow(
      compareMessageSearchOrder(
        {
          category: 0,
          messageTimestamp: 10,
          messageSeq: 1,
          messageId: "z",
        },
        {
          category: 0,
          messageTimestamp: 9,
          messageSeq: 99,
          messageId: "a",
        },
      ),
      0,
    );
  });

  it("includes epoch and normalized query in the SHA-256 query key", async function () {
    const first = await createSearchQueryKey("epoch-a", "本地 search");
    const same = await createSearchQueryKey("epoch-a", "本地 search");
    const changed = await createSearchQueryKey("epoch-b", "本地 search");

    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first, same);
    assert.notEqual(first, changed);
  });
});
