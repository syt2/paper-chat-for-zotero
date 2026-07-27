import { assert } from "chai";
import {
  SessionStorageService,
  mapMessageRowToChatMessage,
  type MessageStorageRow,
} from "../src/modules/chat/SessionStorageService.ts";
import {
  getStorageDatabase,
  resetStorageDatabaseForTests,
} from "../src/modules/chat/db/StorageDatabase.ts";
import {
  buildVisibleSearchSegments,
  CURRENT_SEARCH_VERSION,
  projectSearchDocument,
  projectSearchTitle,
} from "../src/modules/chat/search/SearchProjection.ts";
import { ChatHistorySearchError } from "../src/modules/chat/search/SearchTypes.ts";

type SearchFixtureMode = "indexed" | "partial" | "future";

type FixtureSession = {
  id: string;
  title: string;
  updatedAt: number;
};

type FixtureMessage = MessageStorageRow & {
  session_id: string;
  seq: number;
};

type RecordedQuery = {
  sql: string;
  params: unknown[];
  rowReturning: boolean;
};

type TestSqliteStatement = {
  all(...params: any[]): any[];
  run(...params: any[]): unknown;
};

type TestSqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): TestSqliteStatement;
  close(): void;
};

let createMemoryDatabase: (() => TestSqliteDatabase) | null = null;

const SEARCH_QUERY = "alpha beta";
const SEARCH_REVISION = 11;
const SEARCH_EPOCH = "service-search-fixture-epoch";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function messageSearchText(message: FixtureMessage): string {
  return projectSearchDocument(
    buildVisibleSearchSegments(mapMessageRowToChatMessage(message)),
  ).normalizedText;
}

function isRowReturningSql(sql: string): boolean {
  return /^\s*(?:SELECT|WITH)\b/i.test(sql);
}

class SearchServiceFakeDatabase {
  readonly database: TestSqliteDatabase;
  readonly queries: RecordedQuery[] = [];
  private revisionReads: number[] | null = null;
  private revisionReadIndex = 0;

  constructor(readonly mode: SearchFixtureMode) {
    if (!createMemoryDatabase) {
      throw new Error("Node SQLite test runtime is unavailable");
    }
    this.database = createMemoryDatabase();
    this.createSchema();
    this.seedFixture();
  }

  setRevisionReads(revisions: number[]): void {
    this.revisionReads = [...revisions];
    this.revisionReadIndex = 0;
  }

  async queryAsync(
    sql: string,
    rawParams: unknown[] = [],
  ): Promise<any[] | undefined> {
    const params = [...rawParams];
    const rowReturning = isRowReturningSql(sql);
    this.queries.push({ sql, params, rowReturning });

    // Mirror Zotero.DBConnection's row-return detection footgun. SQLite still
    // executes other leading forms, but the wrapper publishes rows only for a
    // literal `SELECT ` prefix.
    if (sql.startsWith("SELECT ")) {
      const rows = this.database.prepare(sql).all(...(params as any[]));
      if (
        normalizeSql(sql) ===
          "SELECT target_version, completed, revision_epoch, search_revision, updated_at FROM chat_search_state WHERE id = 1" &&
        this.revisionReads
      ) {
        const override =
          this.revisionReads[
            Math.min(this.revisionReadIndex, this.revisionReads.length - 1)
          ];
        this.revisionReadIndex += 1;
        return rows.map((row) => ({ ...row, search_revision: override }));
      }
      return rows;
    }

    if (rowReturning) {
      this.database.prepare(sql).all(...(params as any[]));
      return undefined;
    }

    this.database.prepare(sql).run(...(params as any[]));
    return [];
  }

  close(): void {
    this.database.close();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE chat_search_state (
        id INTEGER PRIMARY KEY,
        target_version INTEGER NOT NULL,
        completed INTEGER NOT NULL,
        revision_epoch TEXT NOT NULL,
        search_revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_meta (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        last_message_preview TEXT NOT NULL DEFAULT '',
        last_message_time INTEGER NOT NULL,
        title TEXT,
        title_source TEXT,
        title_generated_at INTEGER,
        title_edited_at INTEGER,
        search_title TEXT NOT NULL DEFAULT '',
        search_index_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        reasoning TEXT,
        images TEXT,
        files TEXT,
        quoted_messages TEXT,
        timestamp INTEGER NOT NULL,
        pdf_context INTEGER,
        selected_text TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        streaming_state TEXT,
        api_only INTEGER,
        is_system_notice INTEGER,
        search_text TEXT NOT NULL DEFAULT '',
        search_index_version INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  private seedFixture(): void {
    const sessions: FixtureSession[] = [
      { id: "s-title-only", title: "Alpha Beta", updatedAt: 600 },
      {
        id: "s-mixed",
        title: "Notebook: Alpha Beta archive",
        updatedAt: 500,
      },
      { id: "s-message-exact", title: "Evidence", updatedAt: 400 },
      { id: "s-message-terms", title: "Reverse order", updatedAt: 300 },
      { id: "s-literal", title: "Literal syntax", updatedAt: 200 },
    ];
    const messages: FixtureMessage[] = [
      {
        id: "title-unrelated",
        session_id: "s-title-only",
        seq: 0,
        role: "assistant",
        content: "Nothing relevant is in this completed answer.",
        timestamp: 601,
      },
      {
        id: "mixed-exact-new",
        session_id: "s-mixed",
        seq: 6,
        role: "user",
        content: "[Question]: Alpha Beta newest",
        timestamp: 507,
      },
      {
        id: "mixed-exact-markdown",
        session_id: "s-mixed",
        seq: 5,
        role: "assistant",
        content: "Answer with **Alpha Beta**.",
        timestamp: 506,
      },
      {
        id: "mixed-exact-selected",
        session_id: "s-mixed",
        seq: 4,
        role: "user",
        content: "[Question]: follow up",
        selected_text: "Alpha Beta excerpt",
        timestamp: 505,
      },
      {
        id: "mixed-terms-new",
        session_id: "s-mixed",
        seq: 3,
        role: "assistant",
        content: "Beta comes before Alpha in this answer.",
        timestamp: 504,
      },
      {
        id: "mixed-terms-middle",
        session_id: "s-mixed",
        seq: 2,
        role: "user",
        content: "[Question]: Alpha then Beta",
        timestamp: 503,
      },
      {
        id: "mixed-terms-old",
        session_id: "s-mixed",
        seq: 1,
        role: "assistant",
        content: "Beta appears far away from Alpha.",
        timestamp: 502,
      },
      {
        id: "mixed-terms-oldest",
        session_id: "s-mixed",
        seq: 0,
        role: "user",
        content: "[Question]: Alpha and finally Beta",
        timestamp: 501,
      },
      {
        id: "message-exact",
        session_id: "s-message-exact",
        seq: 1,
        role: "assistant",
        content: "Alpha Beta evidence",
        timestamp: 402,
      },
      {
        id: "message-exact-terms",
        session_id: "s-message-exact",
        seq: 0,
        role: "user",
        content: "[Question]: Beta then Alpha",
        timestamp: 401,
      },
      {
        id: "message-terms",
        session_id: "s-message-terms",
        seq: 0,
        role: "assistant",
        content: "Alpha is discussed; much later comes Beta.",
        timestamp: 301,
      },
      {
        id: "message-literal",
        session_id: "s-literal",
        seq: 0,
        role: "user",
        content: "[Question]: Literal %_ token",
        timestamp: 201,
      },
    ];

    const targetVersion =
      this.mode === "future"
        ? CURRENT_SEARCH_VERSION + 1
        : CURRENT_SEARCH_VERSION;
    const completed = this.mode === "partial" ? 0 : 1;
    this.database
      .prepare(
        `INSERT INTO chat_search_state
         (id, target_version, completed, revision_epoch, search_revision, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(targetVersion, completed, SEARCH_EPOCH, SEARCH_REVISION, 1);

    const messagesBySession = new Map<string, FixtureMessage[]>();
    for (const message of messages) {
      const values = messagesBySession.get(message.session_id) || [];
      values.push(message);
      messagesBySession.set(message.session_id, values);
    }

    const insertMeta = this.database.prepare(
      `INSERT INTO session_meta
       (id, created_at, updated_at, message_count, last_message_time, title,
        search_title, search_index_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    sessions.forEach((session, index) => {
      const current = this.mode === "indexed" || index % 2 === 1;
      const version =
        this.mode === "future"
          ? targetVersion
          : current
            ? CURRENT_SEARCH_VERSION
            : 0;
      const searchTitle =
        this.mode === "future"
          ? "future projector value must not be trusted"
          : current
            ? projectSearchTitle(session.title).normalizedText
            : "";
      insertMeta.run(
        session.id,
        session.updatedAt - 100,
        session.updatedAt,
        messagesBySession.get(session.id)?.length || 0,
        session.updatedAt,
        session.title,
        searchTitle,
        version,
      );
    });

    const insertMessage = this.database.prepare(
      `INSERT INTO messages
       (id, session_id, seq, role, content, reasoning, images, files, timestamp,
        pdf_context, selected_text, tool_calls, tool_call_id, streaming_state,
        api_only, is_system_notice, search_text, search_index_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    messages.forEach((message, index) => {
      const current = this.mode === "indexed" || index % 2 === 0;
      const version =
        this.mode === "future"
          ? targetVersion
          : current
            ? CURRENT_SEARCH_VERSION
            : 0;
      const searchText =
        this.mode === "future"
          ? "future projector value must not be trusted"
          : current
            ? messageSearchText(message)
            : "";
      insertMessage.run(
        message.id,
        message.session_id,
        message.seq,
        message.role,
        message.content,
        message.reasoning ?? null,
        message.images ?? null,
        message.files ?? null,
        message.timestamp,
        message.pdf_context ?? null,
        message.selected_text ?? null,
        message.tool_calls ?? null,
        message.tool_call_id ?? null,
        message.streaming_state ?? null,
        message.api_only ?? null,
        message.is_system_notice ?? null,
        searchText,
        version,
      );
    });
  }
}

async function installSearchDatabase(
  fake: SearchServiceFakeDatabase,
): Promise<SessionStorageService> {
  const storage = getStorageDatabase() as any;
  storage.ensureInit = async () => fake;
  const service = new SessionStorageService();
  (service as any).initialized = true;
  (service as any).loadSession = async () => {
    throw new Error("grouped history search must not call loadSession()");
  };
  return service;
}

function highlightedText(
  snippet: string,
  ranges: Array<{ start: number; end: number }>,
): string[] {
  return ranges.map((range) => snippet.slice(range.start, range.end));
}

describe("SessionStorageService grouped history search", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let fake: SearchServiceFakeDatabase | null = null;

  before(async function () {
    if (!(globalThis as any).process?.versions?.node) {
      this.skip();
      return;
    }
    // Keep the Node-only runtime dependency out of Zotero's Firefox bundle.
    // This suite is intentionally exercised through `npm run test:node`.
    const moduleName = ["node", "sqlite"].join(":");
    const sqlite = (await import(moduleName)) as {
      DatabaseSync: new (path: string) => TestSqliteDatabase;
    };
    createMemoryDatabase = () => new sqlite.DatabaseSync(":memory:");
  });

  beforeEach(async function () {
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "/tmp/paperchat-search-service-test" },
    };
    (globalThis as any).ztoolkit = { log: () => undefined };
    await resetStorageDatabaseForTests();
  });

  afterEach(async function () {
    await resetStorageDatabaseForTests();
    fake?.close();
    fake = null;
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
  });

  async function createService(
    mode: SearchFixtureMode,
  ): Promise<SessionStorageService> {
    fake = new SearchServiceFakeDatabase(mode);
    return installSearchDatabase(fake);
  }

  it("ignores malformed optional JSON fields when mapping stored messages", function () {
    const message = mapMessageRowToChatMessage({
      id: "malformed-json",
      role: "assistant",
      content: "Readable answer",
      images: "{",
      files: "not-json",
      timestamp: 1,
      tool_calls: "[broken",
      source_item_keys: "{broken",
    });

    assert.equal(message.content, "Readable answer");
    assert.isUndefined(message.images);
    assert.isUndefined(message.files);
    assert.isUndefined(message.tool_calls);
    assert.isUndefined(message.sourceItemKeys);
  });

  it("loads only normalized Zotero keys from trusted message sources", function () {
    const message = mapMessageRowToChatMessage({
      id: "trusted-sources",
      role: "assistant",
      content: "Compared sources",
      timestamp: 1,
      source_item_keys: JSON.stringify([
        "item0001",
        "ITEM0001",
        "PAPER002",
        "not-a-key",
      ]),
    });

    assert.deepEqual(message.sourceItemKeys, ["ITEM0001", "PAPER002"]);
  });

  it("maps narrow Zotero DB projections without reading omitted columns", function () {
    const projectedRow = {
      id: "strict-projection",
      role: "user" as const,
      content: "Question from a narrow SELECT",
      timestamp: 1,
      selected_text: "Selected source text",
      tool_calls: null,
      tool_call_id: null,
      streaming_state: null,
      api_only: 0,
      is_system_notice: 0,
    };
    const strictRow = new Proxy(projectedRow, {
      get(target, property, receiver) {
        if (property === "then") return undefined;
        if (!(property in target)) {
          throw new Error(`DB column '${String(property)}' not found`);
        }
        return Reflect.get(target, property, receiver);
      },
      // Zotero's row Proxy reports false for both omitted and selected-null
      // columns, which is sufficient for optional message fields.
      has(target, property) {
        return property in target && Boolean(Reflect.get(target, property));
      },
    }) as unknown as MessageStorageRow;

    assert.throws(() => strictRow.reasoning, "DB column 'reasoning' not found");
    const message = mapMessageRowToChatMessage(strictRow);

    assert.equal(message.id, "strict-projection");
    assert.equal(message.content, "Question from a narrow SELECT");
    assert.equal(message.selectedText, "Selected source text");
    assert.isUndefined(message.reasoning);
    assert.isUndefined(message.images);
    assert.isUndefined(message.files);
  });

  it("keeps source-fallback search available with malformed tool-call JSON", async function () {
    const service = await createService("partial");
    fake!.database
      .prepare(
        "UPDATE messages SET images = ?, files = ?, tool_calls = ? WHERE id = ?",
      )
      .run("{", "not-json", "[broken", "mixed-exact-new");

    const page = await service.search.searchHistoryGroups({
      query: SEARCH_QUERY,
      sessionLimit: 20,
    });

    assert.include(
      page.groups.flatMap((group) =>
        group.matches.map((match) => match.messageId),
      ),
      "mixed-exact-new",
    );
  });

  it("keeps indexed and partial source results identical with title-only groups, exact totals, top three, and snippets", async function () {
    const indexedService = await createService("indexed");
    const indexed = await indexedService.search.searchHistoryGroups({
      query: SEARCH_QUERY,
      sessionLimit: 20,
      initialMessageLimit: 99,
    });

    assert.deepEqual(
      indexed.groups.map((group) => group.sessionId),
      ["s-title-only", "s-mixed", "s-message-exact", "s-message-terms"],
    );
    const titleOnly = indexed.groups[0];
    assert.equal(titleOnly.titleMatch?.kind, "exact");
    assert.equal(titleOnly.titleMatch?.snippet, "Alpha Beta");
    assert.deepEqual(
      highlightedText(
        titleOnly.titleMatch!.snippet,
        titleOnly.titleMatch!.highlightRanges,
      ),
      ["Alpha Beta"],
    );
    assert.equal(titleOnly.totalMessageMatches, 0);
    assert.deepEqual(titleOnly.matches, []);
    assert.isUndefined(titleOnly.nextMessageCursor);

    const mixed = indexed.groups[1];
    assert.equal(mixed.titleMatch?.kind, "contains");
    assert.equal(mixed.totalMessageMatches, 7);
    assert.deepEqual(
      mixed.matches.map((match) => match.messageId),
      ["mixed-exact-new", "mixed-exact-markdown", "mixed-exact-selected"],
    );
    assert.exists(mixed.nextMessageCursor);
    const markdownMatch = mixed.matches[1];
    assert.equal(markdownMatch.snippet, "Answer with Alpha Beta.");
    assert.deepEqual(
      highlightedText(markdownMatch.snippet, markdownMatch.highlightRanges),
      ["Alpha Beta"],
    );

    await resetStorageDatabaseForTests();
    fake.close();
    fake = null;
    const partialService = await createService("partial");
    const partial = await partialService.search.searchHistoryGroups({
      query: SEARCH_QUERY,
      sessionLimit: 20,
    });

    assert.deepEqual(partial, indexed);
  });

  it("paginates session groups and independent in-session message cursors", async function () {
    const service = await createService("indexed");
    const first = await service.search.searchHistoryGroups({
      query: SEARCH_QUERY,
      sessionLimit: 2,
    });
    assert.deepEqual(
      first.groups.map((group) => group.sessionId),
      ["s-title-only", "s-mixed"],
    );
    assert.exists(first.nextSessionCursor);

    const second = await service.search.searchHistoryGroups({
      query: SEARCH_QUERY,
      sessionLimit: 2,
      sessionCursor: first.nextSessionCursor,
    });
    assert.deepEqual(
      second.groups.map((group) => group.sessionId),
      ["s-message-exact", "s-message-terms"],
    );
    assert.isUndefined(second.nextSessionCursor);

    const mixed = first.groups[1];
    const expansionOne = await service.search.searchHistorySessionMatches({
      query: SEARCH_QUERY,
      queryKey: first.queryKey,
      searchRevision: first.searchRevision,
      sessionId: mixed.sessionId,
      messageCursor: mixed.nextMessageCursor,
      limit: 2,
    });
    assert.equal(expansionOne.totalMessageMatches, 7);
    assert.deepEqual(
      expansionOne.matches.map((match) => match.messageId),
      ["mixed-terms-new", "mixed-terms-middle"],
    );
    assert.exists(expansionOne.nextMessageCursor);

    const expansionTwo = await service.search.searchHistorySessionMatches({
      query: SEARCH_QUERY,
      queryKey: first.queryKey,
      searchRevision: first.searchRevision,
      sessionId: mixed.sessionId,
      messageCursor: expansionOne.nextMessageCursor,
      limit: 2,
    });
    assert.deepEqual(
      expansionTwo.matches.map((match) => match.messageId),
      ["mixed-terms-old", "mixed-terms-oldest"],
    );
    assert.isUndefined(expansionTwo.nextMessageCursor);
  });

  it("falls back to every source row when the stored target is from a future projector", async function () {
    const futureService = await createService("future");
    const future = await futureService.search.searchHistoryGroups({
      query: SEARCH_QUERY,
      sessionLimit: 20,
    });

    await resetStorageDatabaseForTests();
    fake.close();
    fake = null;
    const indexedService = await createService("indexed");
    const indexed = await indexedService.search.searchHistoryGroups({
      query: SEARCH_QUERY,
      sessionLimit: 20,
    });

    assert.deepEqual(future, indexed);
    assert.isTrue(future.groups.some((group) => group.totalMessageMatches > 0));
  });

  it("retries one revision change and returns STALE_SEARCH after a second change", async function () {
    const service = await createService("indexed");
    fake!.setRevisionReads([11, 12, 12, 12]);

    const retried = await service.search.searchHistoryGroups({
      query: SEARCH_QUERY,
      sessionLimit: 20,
    });
    assert.equal(retried.searchRevision, 12);
    assert.equal(
      fake!.queries.filter((query) =>
        normalizeSql(query.sql).startsWith(
          "SELECT m.session_id, COUNT(*) AS total_message_matches",
        ),
      ).length,
      2,
    );

    fake!.queries.length = 0;
    fake!.setRevisionReads([21, 22, 22, 23]);
    let staleError: unknown;
    try {
      await service.search.searchHistoryGroups({
        query: SEARCH_QUERY,
        sessionLimit: 20,
      });
    } catch (error) {
      staleError = error;
    }
    assert.instanceOf(staleError, ChatHistorySearchError);
    assert.equal((staleError as ChatHistorySearchError).code, "STALE_SEARCH");
  });

  it("uses bound literal input and only literal SELECT row-returning statements without loading a session", async function () {
    const service = await createService("indexed");
    const page = await service.search.searchHistoryGroups({
      query: "%_",
      sessionLimit: 20,
    });

    assert.deepEqual(
      page.groups.flatMap((group) =>
        group.matches.map((match) => match.messageId),
      ),
      ["message-literal"],
    );
    const searchQueries = fake!.queries.filter((query) =>
      query.sql.includes("instr("),
    );
    assert.isNotEmpty(searchQueries);
    assert.isTrue(searchQueries.every((query) => !query.sql.includes("%_")));
    assert.isTrue(searchQueries.some((query) => query.params.includes("%_")));
    assert.isTrue(
      fake!.queries
        .filter((query) => query.rowReturning)
        .every((query) => query.sql.startsWith("SELECT ")),
    );
  });

  it("does not invoke the session-retention policy from a read-only search", async function () {
    const service = await createService("indexed");

    await service.search.searchHistoryGroups({
      query: SEARCH_QUERY,
      sessionLimit: 20,
    });

    assert.isFalse(
      fake!.queries.some((query) =>
        normalizeSql(query.sql).startsWith(
          "SELECT COUNT(*) as count FROM session_meta",
        ),
      ),
    );
    assert.isTrue(fake!.queries.every((query) => query.rowReturning));
  });
});
