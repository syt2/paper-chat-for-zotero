import { assert } from "chai";
import {
  buildAllSourceMessagePageSql,
  buildIndexedMessageCandidatesSql,
  buildIndexedMessageSummarySql,
  buildIndexedTitleMatchesSql,
  buildLowerVersionMessagePageSql,
  buildLowerVersionTitlePageSql,
} from "../src/modules/chat/search/SearchSql.ts";
import { parseSearchQuery } from "../src/modules/chat/search/SearchQuery.ts";

describe("chat history search SQL", function () {
  it("keeps every row-returning query on Zotero's literal SELECT path", function () {
    const query = parseSearchQuery("研究 %_");
    const statements = [
      buildIndexedMessageSummarySql(query, 1),
      buildIndexedTitleMatchesSql(query, 1),
      buildIndexedMessageCandidatesSql(query, 1, ["s1", "s2"]),
      buildLowerVersionMessagePageSql(1, 100),
      buildLowerVersionTitlePageSql(1, 100),
      buildAllSourceMessagePageSql(100),
    ];

    for (const statement of statements) {
      assert.isTrue(statement.sql.startsWith("SELECT "));
      assert.notInclude(statement.sql, "研究");
      assert.notInclude(statement.sql, "%_");
    }
  });

  it("binds literal terms, versions, session ids, and keyset cursors", function () {
    const query = parseSearchQuery("研究 %_");
    const candidates = buildIndexedMessageCandidatesSql(query, 3, ["会话-a"]);
    assert.deepEqual(candidates.params, [
      "研究 %_",
      "研究 %_",
      3,
      "会话-a",
      "研究",
      "%_",
      3,
    ]);

    const page = buildLowerVersionMessagePageSql(3, 100, {
      searchIndexVersion: 1,
      id: "消息-a",
    });
    assert.deepEqual(page.params, [3, 1, 1, "消息-a", 100]);
    assert.include(page.sql, "id COLLATE BINARY > ?");

    const allSource = buildAllSourceMessagePageSql(50, {
      searchIndexVersion: 9,
      id: "future-row",
    });
    assert.deepEqual(allSource.params, [9, 9, "future-row", 50]);
  });
});
