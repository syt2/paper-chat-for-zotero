import { assert } from "chai";
import { StorageDatabase } from "../src/modules/chat/db/StorageDatabase.ts";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

describe("StorageDatabase foundation", function () {
  let originalZtoolkit: unknown;

  beforeEach(function () {
    originalZtoolkit = (globalThis as any).ztoolkit;
    (globalThis as any).ztoolkit = { log: () => undefined };
  });

  afterEach(function () {
    (globalThis as any).ztoolkit = originalZtoolkit;
  });

  it("keeps ordinary statements outside an exclusive transaction", async function () {
    const enteredTransaction = deferred();
    const releaseTransaction = deferred();
    const events: string[] = [];
    const fakeDb = {
      async queryAsync(sql: string) {
        events.push(sql);
        if (sql === "TX-FIRST") {
          enteredTransaction.resolve();
          await releaseTransaction.promise;
        }
        return [];
      },
      async closeDatabase() {},
    };
    const storage = new StorageDatabase();
    (storage as any).db = fakeDb;

    const transaction = storage.executeTransaction(async (tx) => {
      await tx.queryAsync("TX-FIRST");
      await tx.queryAsync("TX-SECOND");
    });
    await enteredTransaction.promise;
    const ordinary = storage.queryAsync("OUTSIDE");

    releaseTransaction.resolve();
    await Promise.all([transaction, ordinary]);

    assert.deepEqual(events, [
      "BEGIN TRANSACTION",
      "TX-FIRST",
      "TX-SECOND",
      "COMMIT",
      "OUTSIDE",
    ]);
  });

  it("rolls back before running an unrelated queued write", async function () {
    const events: string[] = [];
    const fakeDb = {
      async queryAsync(sql: string) {
        events.push(sql);
        if (sql === "TX-FAIL") {
          throw new Error("transaction failed");
        }
        return [];
      },
      async closeDatabase() {},
    };
    const storage = new StorageDatabase();
    (storage as any).db = fakeDb;

    const transaction = storage.executeTransaction(async (tx) => {
      await tx.queryAsync("TX-FAIL");
    });
    const unrelatedWrite = storage.queryAsync("UNRELATED-WRITE");

    let transactionError: unknown;
    try {
      await transaction;
    } catch (error) {
      transactionError = error;
    }
    await unrelatedWrite;

    assert.instanceOf(transactionError, Error);
    assert.equal((transactionError as Error).message, "transaction failed");
    assert.deepEqual(events, [
      "BEGIN TRANSACTION",
      "TX-FAIL",
      "ROLLBACK",
      "UNRELATED-WRITE",
    ]);
  });

  it("stops accepting work, drains accepted jobs, then closes", async function () {
    const enteredSlowQuery = deferred();
    const releaseSlowQuery = deferred();
    const events: string[] = [];
    const fakeDb = {
      async queryAsync(sql: string) {
        events.push(sql);
        if (sql === "SLOW") {
          enteredSlowQuery.resolve();
          await releaseSlowQuery.promise;
        }
        return [];
      },
      async closeDatabase() {
        events.push("CLOSE");
      },
    };
    const storage = new StorageDatabase();
    (storage as any).db = fakeDb;

    const slowQuery = storage.queryAsync("SLOW");
    await enteredSlowQuery.promise;
    const closing = storage.close();

    let shutdownError: unknown;
    try {
      await storage.queryAsync("TOO-LATE");
    } catch (error) {
      shutdownError = error;
    }
    assert.instanceOf(shutdownError, Error);
    assert.equal(
      (shutdownError as Error).message,
      "StorageDatabase is shutting down",
    );

    releaseSlowQuery.resolve();
    await Promise.all([slowQuery, closing]);

    assert.deepEqual(events, ["SLOW", "CLOSE"]);
  });

  it("drains queries and transactions accepted while initialization is pending", async function () {
    const enteredInit = deferred();
    const releaseInit = deferred();
    const events: string[] = [];
    const fakeDb = {
      async queryAsync(sql: string) {
        events.push(sql);
        return [];
      },
      async closeDatabase() {
        events.push("CLOSE");
      },
    };
    const storage = new StorageDatabase();
    let initCalls = 0;
    (storage as any).init = async () => {
      initCalls += 1;
      enteredInit.resolve();
      await releaseInit.promise;
      (storage as any).db = fakeDb;
    };

    const query = storage.queryAsync("ACCEPTED-QUERY");
    const transaction = storage.executeTransaction(async (tx) => {
      await tx.queryAsync("ACCEPTED-TRANSACTION");
    });
    await enteredInit.promise;
    const closing = storage.close();

    releaseInit.resolve();
    await Promise.all([query, transaction, closing]);

    assert.equal(initCalls, 2);
    assert.deepEqual(events, [
      "ACCEPTED-QUERY",
      "BEGIN TRANSACTION",
      "ACCEPTED-TRANSACTION",
      "COMMIT",
      "CLOSE",
    ]);
  });

  it("closes a rejected connection before retrying initialization", async function () {
    const globals = globalThis as any;
    const originalZotero = globals.Zotero;
    const originalPathUtils = globals.PathUtils;
    const originalIOUtils = globals.IOUtils;
    const events: string[] = [];
    let connectionCount = 0;

    class FakeConnection {
      private readonly attempt: number;

      constructor(_path: string) {
        this.attempt = ++connectionCount;
        events.push(`construct:${this.attempt}`);
      }

      async queryAsync(sql: string) {
        const normalized = normalizeSql(sql);
        events.push(`query:${this.attempt}:${normalized}`);
        if (this.attempt === 1 && normalized === "PRAGMA foreign_keys=ON") {
          throw new Error("forced initialization failure");
        }
        if (normalized === "PRAGMA table_info(session_meta)") {
          return [{ name: "search_title" }, { name: "search_index_version" }];
        }
        if (normalized === "PRAGMA table_info(messages)") {
          return [
            { name: "reasoning" },
            { name: "evidence" },
            { name: "quoted_messages" },
            { name: "source_item_keys" },
            { name: "search_text" },
            { name: "search_index_version" },
          ];
        }
        if (normalized === "SELECT version FROM schema_version WHERE id = 1") {
          return [];
        }
        return [];
      }

      async closeDatabase() {
        events.push(`close:${this.attempt}`);
      }
    }

    globals.Zotero = {
      DataDirectory: { dir: "/tmp/paperchat-storage-retry" },
      DBConnection: FakeConnection,
    };
    globals.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
    };
    globals.IOUtils = {
      makeDirectory: async () => undefined,
    };

    const storage = new StorageDatabase();
    try {
      let firstError: unknown;
      try {
        await storage.init();
      } catch (error) {
        firstError = error;
      }
      assert.instanceOf(firstError, Error);
      assert.equal(
        (firstError as Error).message,
        "forced initialization failure",
      );

      await storage.init();
      assert.equal(connectionCount, 2);
      assert.isBelow(events.indexOf("close:1"), events.indexOf("construct:2"));
    } finally {
      await storage.close();
      globals.Zotero = originalZotero;
      globals.PathUtils = originalPathUtils;
      globals.IOUtils = originalIOUtils;
    }

    assert.include(events, "close:2");
  });

  it("adds v9 search schema and repairs only missing companion rows", async function () {
    const recorded: string[] = [];
    const fakeDb = {
      async queryAsync(sql: string) {
        const normalized = normalizeSql(sql);
        recorded.push(normalized);
        if (normalized === "PRAGMA table_info(messages)") {
          return [{ name: "id" }];
        }
        if (normalized === "PRAGMA table_info(session_meta)") {
          return [{ name: "id" }];
        }
        return [];
      },
    };

    await (new StorageDatabase() as any).upgradeToV9(fakeDb);

    assert.include(
      recorded,
      "ALTER TABLE messages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''",
    );
    assert.include(
      recorded,
      "ALTER TABLE messages ADD COLUMN search_index_version INTEGER NOT NULL DEFAULT 0",
    );
    assert.include(
      recorded,
      "ALTER TABLE session_meta ADD COLUMN search_title TEXT NOT NULL DEFAULT ''",
    );
    assert.include(
      recorded,
      "ALTER TABLE session_meta ADD COLUMN search_index_version INTEGER NOT NULL DEFAULT 0",
    );
    assert.isTrue(
      recorded.some((sql) =>
        sql.startsWith("CREATE TABLE IF NOT EXISTS chat_search_state"),
      ),
    );
    assert.isTrue(
      recorded.some((sql) =>
        sql.startsWith(
          "CREATE TRIGGER IF NOT EXISTS trg_messages_search_projection_stale",
        ),
      ),
    );
    assert.isTrue(
      recorded.some((sql) =>
        sql.startsWith(
          "CREATE TRIGGER IF NOT EXISTS trg_session_meta_search_projection_stale",
        ),
      ),
    );
    const repair = recorded.find((sql) =>
      sql.startsWith("INSERT INTO paperchat_session_state"),
    );
    assert.exists(repair);
    assert.include(repair!, "WHERE NOT EXISTS");
    assert.notInclude(repair!, "ON CONFLICT");
    assert.include(
      recorded,
      "UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1",
    );
    assert.strictEqual(recorded.at(-1), "COMMIT");
  });

  it("rebuilds the v1 messages table before replacing its parent session table", async function () {
    const recorded: Array<{ sql: string; params?: unknown[] }> = [];
    const fakeDb = {
      async queryAsync(sql: string, params?: unknown[]) {
        const normalized = normalizeSql(sql);
        recorded.push({ sql: normalized, params });
        if (normalized.startsWith("SELECT id, created_at")) {
          return [
            {
              id: "session-v1",
              created_at: 1,
              updated_at: 2,
              last_active_item_key: "ITEM0001",
              messages: JSON.stringify([
                {
                  id: "message-v1",
                  role: "assistant",
                  content: "preserve me",
                  timestamp: 3,
                },
              ]),
              context_summary: null,
              context_state: null,
            },
          ];
        }
        return [];
      },
    };

    await (new StorageDatabase() as any).devUpgradeToV2(fakeDb);

    const statements = recorded.map((entry) => entry.sql);
    assert.isTrue(
      statements.some((sql) => sql.startsWith("CREATE TABLE messages_new")),
    );
    assert.isTrue(
      statements.some((sql) => sql.startsWith("INSERT INTO messages_new")),
    );
    assert.include(statements, "DROP TABLE messages");
    assert.include(statements, "DROP TABLE sessions");
    assert.include(statements, "ALTER TABLE sessions_new RENAME TO sessions");
    assert.include(statements, "ALTER TABLE messages_new RENAME TO messages");
    assert.isBelow(
      statements.indexOf("DROP TABLE messages"),
      statements.indexOf("DROP TABLE sessions"),
    );
    assert.isBelow(
      statements.indexOf("ALTER TABLE sessions_new RENAME TO sessions"),
      statements.indexOf("ALTER TABLE messages_new RENAME TO messages"),
    );
    assert.strictEqual(statements.at(-1), "COMMIT");
  });

  it("repairs a missing reasoning column even when the schema version is current", async function () {
    const recorded: string[] = [];
    const fakeDb = {
      async queryAsync(sql: string) {
        const normalized = normalizeSql(sql);
        recorded.push(normalized);
        if (normalized === "PRAGMA table_info(messages)") {
          return [
            { name: "id" },
            { name: "evidence" },
            { name: "quoted_messages" },
            { name: "source_item_keys" },
            { name: "search_text" },
            { name: "search_index_version" },
          ];
        }
        if (normalized === "PRAGMA table_info(session_meta)") {
          return [
            { name: "id" },
            { name: "search_title" },
            { name: "search_index_version" },
          ];
        }
        if (normalized === "SELECT version FROM schema_version WHERE id = 1") {
          return [{ version: 12 }];
        }
        return [];
      },
    };
    const storage = new StorageDatabase() as any;

    await storage.createTables(fakeDb);
    await storage.initSchemaVersion(fakeDb);

    assert.equal(
      recorded.filter(
        (sql) => sql === "ALTER TABLE messages ADD COLUMN reasoning TEXT",
      ).length,
      1,
    );
    assert.notInclude(
      recorded,
      "UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1",
    );
  });

  it("upgrades a quoted-message v11 database with trusted sources", async function () {
    const recorded: Array<{ sql: string; params?: unknown[] }> = [];
    let sourceItemKeysAdded = false;
    const fakeDb = {
      async queryAsync(sql: string, params?: unknown[]) {
        const normalized = normalizeSql(sql);
        recorded.push({ sql: normalized, params });
        if (
          normalized === "ALTER TABLE messages ADD COLUMN source_item_keys TEXT"
        ) {
          sourceItemKeysAdded = true;
        }
        if (normalized === "PRAGMA table_info(messages)") {
          return [
            { name: "reasoning" },
            { name: "evidence" },
            { name: "quoted_messages" },
            ...(sourceItemKeysAdded ? [{ name: "source_item_keys" }] : []),
            { name: "search_text" },
            { name: "search_index_version" },
          ];
        }
        if (normalized === "PRAGMA table_info(session_meta)") {
          return [{ name: "search_title" }, { name: "search_index_version" }];
        }
        if (normalized === "SELECT version FROM schema_version WHERE id = 1") {
          return [{ version: 11 }];
        }
        return [];
      },
    };

    await (new StorageDatabase() as any).initSchemaVersion(fakeDb);

    assert.equal(
      recorded.filter(
        (entry) =>
          entry.sql === "ALTER TABLE messages ADD COLUMN source_item_keys TEXT",
      ).length,
      1,
    );
    assert.isTrue(
      recorded.some(
        (entry) =>
          entry.sql ===
            "UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1" &&
          entry.params?.[0] === 12,
      ),
    );
    assert.include(
      recorded.map((entry) => entry.sql),
      "COMMIT",
    );
  });

  it("rolls back a failed trusted-source schema repair", async function () {
    const recorded: string[] = [];
    const fakeDb = {
      async queryAsync(sql: string) {
        const normalized = normalizeSql(sql);
        recorded.push(normalized);
        if (normalized === "PRAGMA table_info(messages)") {
          return [
            { name: "reasoning" },
            { name: "evidence" },
            { name: "quoted_messages" },
            { name: "search_text" },
            { name: "search_index_version" },
          ];
        }
        if (normalized === "PRAGMA table_info(session_meta)") {
          return [{ name: "search_title" }, { name: "search_index_version" }];
        }
        if (normalized === "SELECT version FROM schema_version WHERE id = 1") {
          return [{ version: 11 }];
        }
        if (
          normalized === "ALTER TABLE messages ADD COLUMN source_item_keys TEXT"
        ) {
          throw new Error("alter failed");
        }
        return [];
      },
    };

    let thrown: unknown;
    try {
      await (new StorageDatabase() as any).initSchemaVersion(fakeDb);
    } catch (error) {
      thrown = error;
    }

    assert.instanceOf(thrown, Error);
    assert.include(recorded, "ROLLBACK");
    assert.strictEqual(recorded.at(-1), "ROLLBACK");
  });

  it("adds message evidence when upgrading schema v9 to v10", async function () {
    const recorded: Array<{ sql: string; params?: unknown[] }> = [];
    const fakeDb = {
      async queryAsync(sql: string, params?: unknown[]) {
        const normalized = normalizeSql(sql);
        recorded.push({ sql: normalized, params });
        if (normalized === "SELECT version FROM schema_version WHERE id = 1") {
          return [{ version: 9 }];
        }
        if (normalized === "PRAGMA table_info(messages)") {
          return [
            { name: "reasoning" },
            { name: "search_text" },
            { name: "search_index_version" },
          ];
        }
        if (normalized === "PRAGMA table_info(session_meta)") {
          return [{ name: "search_title" }, { name: "search_index_version" }];
        }
        return [];
      },
    };

    await (new StorageDatabase() as any).initSchemaVersion(fakeDb);

    assert.include(
      recorded.map((entry) => entry.sql),
      "ALTER TABLE messages ADD COLUMN evidence TEXT",
    );
    assert.isTrue(
      recorded.some(
        (entry) =>
          entry.sql ===
            "UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1" &&
          entry.params?.[0] === 10 &&
          typeof entry.params?.[1] === "number",
      ),
    );
    assert.include(
      recorded.map((entry) => entry.sql),
      "COMMIT",
    );
  });

  it("adds quoted messages and trusted sources when upgrading schema v10 to v12", async function () {
    const recorded: Array<{ sql: string; params?: unknown[] }> = [];
    let quotedMessagesAdded = false;
    let sourceItemKeysAdded = false;
    const fakeDb = {
      async queryAsync(sql: string, params?: unknown[]) {
        const normalized = normalizeSql(sql);
        recorded.push({ sql: normalized, params });
        if (
          normalized === "ALTER TABLE messages ADD COLUMN quoted_messages TEXT"
        ) {
          quotedMessagesAdded = true;
        }
        if (
          normalized === "ALTER TABLE messages ADD COLUMN source_item_keys TEXT"
        ) {
          sourceItemKeysAdded = true;
        }
        if (normalized === "SELECT version FROM schema_version WHERE id = 1") {
          return [{ version: 10 }];
        }
        if (normalized === "PRAGMA table_info(messages)") {
          return [
            { name: "reasoning" },
            { name: "evidence" },
            { name: "search_text" },
            { name: "search_index_version" },
            ...(quotedMessagesAdded ? [{ name: "quoted_messages" }] : []),
            ...(sourceItemKeysAdded ? [{ name: "source_item_keys" }] : []),
          ];
        }
        if (normalized === "PRAGMA table_info(session_meta)") {
          return [{ name: "search_title" }, { name: "search_index_version" }];
        }
        return [];
      },
    };

    await (new StorageDatabase() as any).initSchemaVersion(fakeDb);

    assert.include(
      recorded.map((entry) => entry.sql),
      "ALTER TABLE messages ADD COLUMN quoted_messages TEXT",
    );
    assert.include(
      recorded.map((entry) => entry.sql),
      "ALTER TABLE messages ADD COLUMN source_item_keys TEXT",
    );
    assert.isTrue(
      recorded.some(
        (entry) =>
          entry.sql.startsWith(
            "CREATE TRIGGER IF NOT EXISTS trg_messages_search_projection_stale",
          ) && entry.sql.includes("quoted_messages"),
      ),
    );
    assert.isTrue(
      recorded.some(
        (entry) =>
          entry.sql ===
            "UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1" &&
          entry.params?.[0] === 11 &&
          typeof entry.params?.[1] === "number",
      ),
    );
    assert.isTrue(
      recorded.some(
        (entry) =>
          entry.sql ===
            "UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1" &&
          entry.params?.[0] === 12 &&
          typeof entry.params?.[1] === "number",
      ),
    );
    assert.include(
      recorded.map((entry) => entry.sql),
      "COMMIT",
    );
  });

  it("does not install v9 triggers against a V2.6.1 table shape", async function () {
    const recorded: string[] = [];
    const fakeDb = {
      async queryAsync(sql: string) {
        const normalized = normalizeSql(sql);
        recorded.push(normalized);
        if (normalized === "PRAGMA table_info(messages)") {
          return [{ name: "id" }, { name: "reasoning" }];
        }
        if (normalized === "PRAGMA table_info(session_meta)") {
          return [{ name: "id" }, { name: "title" }];
        }
        return [];
      },
    };

    await (new StorageDatabase() as any).createTables(fakeDb);

    assert.isTrue(
      recorded.some((sql) =>
        sql.startsWith("CREATE TABLE IF NOT EXISTS chat_search_state"),
      ),
    );
    assert.isFalse(
      recorded.some((sql) =>
        sql.startsWith(
          "CREATE TRIGGER IF NOT EXISTS trg_messages_search_projection_stale",
        ),
      ),
    );
    assert.isFalse(
      recorded.some((sql) =>
        sql.startsWith(
          "CREATE TRIGGER IF NOT EXISTS trg_session_meta_search_projection_stale",
        ),
      ),
    );
  });

  it("repairs missing v9 search columns even when the version row is current", async function () {
    const recorded: string[] = [];
    const fakeDb = {
      async queryAsync(sql: string) {
        const normalized = normalizeSql(sql);
        recorded.push(normalized);
        if (normalized === "SELECT version FROM schema_version WHERE id = 1") {
          return [{ version: 12 }];
        }
        if (normalized === "PRAGMA table_info(messages)") {
          return [{ name: "id" }, { name: "reasoning" }];
        }
        if (normalized === "PRAGMA table_info(session_meta)") {
          return [{ name: "id" }, { name: "title" }];
        }
        return [];
      },
    };

    await (new StorageDatabase() as any).initSchemaVersion(fakeDb);

    assert.include(
      recorded,
      "ALTER TABLE messages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''",
    );
    assert.include(
      recorded,
      "ALTER TABLE session_meta ADD COLUMN search_title TEXT NOT NULL DEFAULT ''",
    );
    assert.isTrue(
      recorded.some((sql) =>
        sql.startsWith(
          "CREATE TRIGGER IF NOT EXISTS trg_messages_search_projection_stale",
        ),
      ),
    );
    assert.strictEqual(recorded.at(-1), "COMMIT");
  });

  it("rejects a missing version row on a legacy table shape", async function () {
    const recorded: string[] = [];
    const fakeDb = {
      async queryAsync(sql: string) {
        const normalized = normalizeSql(sql);
        recorded.push(normalized);
        if (normalized === "SELECT version FROM schema_version WHERE id = 1") {
          return [];
        }
        if (normalized === "PRAGMA table_info(messages)") {
          return [{ name: "id" }, { name: "reasoning" }];
        }
        if (normalized === "PRAGMA table_info(session_meta)") {
          return [{ name: "id" }, { name: "title" }];
        }
        return [];
      },
    };
    let error: unknown;

    try {
      await (new StorageDatabase() as any).initSchemaVersion(fakeDb);
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "legacy table shape");
    assert.isFalse(
      recorded.some((sql) => sql.startsWith("INSERT INTO schema_version")),
    );
  });

  it("keeps the v4-to-v5 source query on Zotero's literal SELECT path", async function () {
    const recorded: string[] = [];
    const fakeDb = {
      async queryAsync(sql: string) {
        recorded.push(sql);
        if (sql === "PRAGMA table_info(sessions)") {
          return [
            { name: "execution_plan" },
            { name: "tool_execution_state" },
            { name: "tool_approval_state" },
            { name: "user_input_request_state" },
            { name: "selected_tier" },
            { name: "resolved_model_id" },
            { name: "last_retryable_user_message_id" },
            { name: "last_retryable_error_message_id" },
            { name: "last_retryable_failed_model_id" },
          ];
        }
        if (sql === "PRAGMA table_info(messages)") {
          return [{ name: "streaming_state" }];
        }
        return [];
      },
    };

    await (new StorageDatabase() as any).upgradeToV5(fakeDb);

    const sourceQuery = recorded.find((sql) => sql.includes("FROM sessions"));
    assert.exists(sourceQuery);
    assert.isTrue(sourceQuery!.startsWith("SELECT "));
  });
});
