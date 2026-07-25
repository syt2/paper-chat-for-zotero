import { assert } from "chai";
import { StorageDatabase } from "../src/modules/chat/db/StorageDatabase.ts";
import {
  mapMessageRowToChatMessage,
  type MessageStorageRow,
} from "../src/modules/chat/SessionStorageService.ts";

// This is a Zotero-runtime integration probe. Node's SQLite build and
// Zotero.DBConnection intentionally have different capabilities and wrappers.

type ProbeDatabase = {
  queryAsync(sql: string, params?: unknown[]): Promise<any[] | undefined>;
  closeDatabase(permanent: boolean): Promise<void>;
};

async function removeProbeFile(path: string): Promise<void> {
  try {
    await IOUtils.remove(path);
  } catch {
    // Missing temp files are expected when SQLite did not create WAL/SHM files.
  }
}

describe("chat history search SQLite runtime", function () {
  it("probes the installed Zotero runtime without requiring trigram", async function () {
    const runtime = globalThis as any;
    if (
      !runtime.Zotero?.DBConnection ||
      !runtime.PathUtils ||
      !runtime.IOUtils
    ) {
      this.skip();
    }

    this.timeout(30_000);

    const dbPath = PathUtils.join(
      Zotero.getTempDirectory().path,
      `paperchat-history-search-probe-${Date.now()}.sqlite`,
    );
    const db = new Zotero.DBConnection(dbPath) as ProbeDatabase;
    let trigramSupported = false;
    let twoCharacterFtsCount: number | null = null;
    let twoCharacterFtsError: string | null = null;

    try {
      const versionRows =
        (await db.queryAsync("SELECT sqlite_version() AS version")) || [];
      const compileRows = (await db.queryAsync("PRAGMA compile_options")) || [];
      const moduleRows = (await db.queryAsync("PRAGMA module_list")) || [];
      const sqliteVersion = String(versionRows[0]?.version || "");
      const compileOptions = compileRows.map((row) =>
        String(row.compile_options || ""),
      );
      const modules = moduleRows.map((row) => String(row.name || ""));

      // Zotero.DBConnection detects row-returning statements from the leading
      // SQL token. Keep production CTEs behind a literal `SELECT ` prefix.
      const bareCteRows = await db.queryAsync(
        "WITH probe(value) AS (SELECT 1) SELECT value FROM probe",
      );
      const selectNewlineRows = await db.queryAsync("SELECT\n1 AS value");
      const wrappedCteRows =
        (await db.queryAsync(
          "SELECT value FROM (WITH probe(value) AS (SELECT 1) SELECT value FROM probe)",
        )) || [];
      assert.equal(Number(wrappedCteRows[0]?.value), 1);

      const literalRows =
        (await db.queryAsync("SELECT instr(?, ?) AS position", [
          "本地研究记录",
          "研究",
        ])) || [];
      assert.equal(Number(literalRows[0]?.position), 3);

      try {
        await db.queryAsync(
          "CREATE VIRTUAL TABLE history_search_probe_fts USING fts5(text, tokenize='trigram')",
        );
        trigramSupported = true;
        await db.queryAsync(
          "INSERT INTO history_search_probe_fts(rowid, text) VALUES (?, ?)",
          [1, "本地研究记录 retrieval benchmark"],
        );

        const longTermRows =
          (await db.queryAsync(
            "SELECT rowid FROM history_search_probe_fts WHERE history_search_probe_fts MATCH ?",
            ['"retrieval"'],
          )) || [];
        assert.deepEqual(
          longTermRows.map((row) => Number(row.rowid)),
          [1],
        );

        try {
          const shortTermRows =
            (await db.queryAsync(
              "SELECT rowid FROM history_search_probe_fts WHERE history_search_probe_fts MATCH ?",
              ['"研究"'],
            )) || [];
          twoCharacterFtsCount = shortTermRows.length;
        } catch (error) {
          twoCharacterFtsError =
            error instanceof Error ? error.message : String(error);
        }
      } catch {
        trigramSupported = false;
      }

      const report = {
        sqliteVersion,
        fts5Compiled: compileOptions.includes("ENABLE_FTS5"),
        modules,
        trigramSupported,
        twoCharacterFtsCount,
        twoCharacterFtsError,
        bareCteReturnedRows: Array.isArray(bareCteRows),
        selectNewlineReturnedRows: Array.isArray(selectNewlineRows),
      };
      const reportDebug = (globalThis as any).debug;
      if (typeof reportDebug === "function") {
        await reportDebug({
          ...report,
          indents: 1,
        });
      }

      assert.isNotEmpty(sqliteVersion);
      assert.isBoolean(trigramSupported);
    } finally {
      await db.closeDatabase(false);
      await removeProbeFile(dbPath);
      await removeProbeFile(`${dbPath}-wal`);
      await removeProbeFile(`${dbPath}-shm`);
    }
  });

  it("maps a partial message projection without reading omitted DB columns", async function () {
    const runtime = globalThis as any;
    if (
      !runtime.Zotero?.DBConnection ||
      !runtime.PathUtils ||
      !runtime.IOUtils
    ) {
      this.skip();
    }

    this.timeout(30_000);

    const dbPath = PathUtils.join(
      Zotero.getTempDirectory().path,
      `paperchat-message-projection-${Date.now()}.sqlite`,
    );
    const db = new Zotero.DBConnection(dbPath) as ProbeDatabase;

    try {
      await db.queryAsync(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          reasoning TEXT,
          images TEXT,
          files TEXT,
          timestamp INTEGER NOT NULL,
          pdf_context INTEGER,
          selected_text TEXT,
          tool_calls TEXT,
          tool_call_id TEXT,
          streaming_state TEXT,
          api_only INTEGER,
          is_system_notice INTEGER
        )
      `);
      await db.queryAsync(
        `INSERT INTO messages
         (id, role, content, reasoning, images, files, timestamp, pdf_context,
          selected_text, tool_calls, tool_call_id, streaming_state, api_only,
          is_system_notice)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "partial-message",
          "assistant",
          "Visible answer",
          "Hidden reasoning",
          JSON.stringify(["image-data"]),
          JSON.stringify([{ name: "paper.pdf" }]),
          123,
          1,
          "Selected source text",
          JSON.stringify([
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ]),
          "call-1",
          "interrupted",
          1,
          1,
        ],
      );

      const rows =
        (await db.queryAsync(
          `SELECT id, role, content, timestamp, selected_text, tool_calls,
             tool_call_id, streaming_state, api_only, is_system_notice
           FROM messages
           WHERE id = ?`,
          ["partial-message"],
        )) || [];
      assert.lengthOf(rows, 1);

      let mapped: ReturnType<typeof mapMessageRowToChatMessage> | undefined;
      assert.doesNotThrow(() => {
        mapped = mapMessageRowToChatMessage(rows[0] as MessageStorageRow);
      });
      assert.deepEqual(mapped, {
        id: "partial-message",
        role: "assistant",
        content: "Visible answer",
        timestamp: 123,
        selectedText: "Selected source text",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
        tool_call_id: "call-1",
        streamingState: "interrupted",
        apiOnly: true,
        isSystemNotice: true,
      });
    } finally {
      await db.closeDatabase(false);
      await removeProbeFile(dbPath);
      await removeProbeFile(`${dbPath}-wal`);
      await removeProbeFile(`${dbPath}-shm`);
    }
  });

  it("runs the v9 search migration idempotently without overwriting companion state", async function () {
    const runtime = globalThis as any;
    if (
      !runtime.Zotero?.DBConnection ||
      !runtime.PathUtils ||
      !runtime.IOUtils
    ) {
      this.skip();
    }

    this.timeout(30_000);

    const dbPath = PathUtils.join(
      Zotero.getTempDirectory().path,
      `paperchat-history-search-v9-${Date.now()}.sqlite`,
    );
    const db = new Zotero.DBConnection(dbPath) as ProbeDatabase;

    try {
      await db.queryAsync(
        "CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      );
      await db.queryAsync(
        "INSERT INTO schema_version (id, version, updated_at) VALUES (1, 8, 0)",
      );
      await db.queryAsync(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          selected_tier TEXT,
          resolved_model_id TEXT,
          last_retryable_user_message_id TEXT,
          last_retryable_error_message_id TEXT,
          last_retryable_failed_model_id TEXT
        )
      `);
      await db.queryAsync(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'assistant',
          content TEXT NOT NULL DEFAULT '',
          selected_text TEXT,
          tool_calls TEXT,
          tool_call_id TEXT,
          streaming_state TEXT,
          api_only INTEGER,
          is_system_notice INTEGER
        )
      `);
      await db.queryAsync(
        "CREATE TABLE session_meta (id TEXT PRIMARY KEY, title TEXT)",
      );
      await db.queryAsync(`
        CREATE TABLE paperchat_session_state (
          session_id TEXT PRIMARY KEY,
          selected_tier TEXT,
          resolved_model_id TEXT,
          last_retryable_user_message_id TEXT,
          last_retryable_error_message_id TEXT,
          last_retryable_failed_model_id TEXT
        )
      `);
      await db.queryAsync("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)", [
        "missing",
        "legacy-tier",
        "legacy-model",
        "u1",
        "e1",
        "m1",
      ]);
      await db.queryAsync("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)", [
        "existing",
        "old-tier",
        "old-model",
        "u-old",
        "e-old",
        "m-old",
      ]);
      await db.queryAsync(
        "INSERT INTO paperchat_session_state VALUES (?, ?, ?, ?, ?, ?)",
        ["existing", "new-tier", "new-model", "u-new", "e-new", "m-new"],
      );

      const storage = new StorageDatabase();
      await (storage as any).upgradeToV9(db);
      await (storage as any).upgradeToV9(db);

      const versionRows =
        (await db.queryAsync(
          "SELECT version FROM schema_version WHERE id = 1",
        )) || [];
      assert.equal(Number(versionRows[0]?.version), 9);

      const messageColumnRows =
        (await db.queryAsync(
          "SELECT name FROM pragma_table_info('messages') ORDER BY name",
        )) || [];
      const messageColumns = messageColumnRows.map((row) => String(row.name));
      assert.includeMembers(messageColumns, [
        "search_text",
        "search_index_version",
      ]);

      const metaColumnRows =
        (await db.queryAsync(
          "SELECT name FROM pragma_table_info('session_meta') ORDER BY name",
        )) || [];
      const metaColumns = metaColumnRows.map((row) => String(row.name));
      assert.includeMembers(metaColumns, [
        "search_title",
        "search_index_version",
      ]);

      const indexRows =
        (await db.queryAsync(
          "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
        )) || [];
      const indexes = indexRows.map((row) => String(row.name));
      assert.includeMembers(indexes, [
        "idx_messages_search_work",
        "idx_messages_session_search_work",
        "idx_session_meta_search_work",
      ]);

      await db.queryAsync(
        `INSERT INTO chat_search_state
         (id, target_version, completed, revision_epoch, search_revision, updated_at)
         VALUES (1, 1, 1, 'epoch', 0, 0)`,
      );
      await db.queryAsync(
        `INSERT INTO messages
         (id, session_id, role, content, streaming_state, search_text, search_index_version)
         VALUES ('current-stream', 'missing', 'assistant', '', 'in_progress', '', 1)`,
      );
      await db.queryAsync(
        "INSERT INTO session_meta (id, title, search_title, search_index_version) VALUES ('current-title', 'Ａ', 'a', 1)",
      );
      await db.queryAsync(
        "UPDATE messages SET search_index_version = -1 WHERE id = 'current-stream'",
      );
      await db.queryAsync(
        `UPDATE messages
         SET content = 'partial', streaming_state = 'in_progress',
             search_text = '', search_index_version = 1
         WHERE id = 'current-stream'`,
      );
      await db.queryAsync(
        "UPDATE session_meta SET search_index_version = -1 WHERE id = 'current-title'",
      );
      await db.queryAsync(
        `UPDATE session_meta
         SET title = 'A', search_title = 'a', search_index_version = 1
         WHERE id = 'current-title'`,
      );
      const currentWriteState =
        (await db.queryAsync(
          "SELECT completed, search_revision FROM chat_search_state WHERE id = 1",
        )) || [];
      assert.equal(Number(currentWriteState[0]?.completed), 1);
      assert.equal(Number(currentWriteState[0]?.search_revision), 0);

      await db.queryAsync(
        `INSERT INTO messages
         (id, session_id, role, content, search_text, search_index_version)
         VALUES ('legacy-edit', 'missing', 'assistant', 'old', 'old', 1)`,
      );
      await db.queryAsync(
        "INSERT INTO session_meta (id, title, search_title, search_index_version) VALUES ('missing', 'Old', 'old', 1)",
      );
      await db.queryAsync(
        "UPDATE messages SET content = 'changed' WHERE id = 'legacy-edit'",
      );
      await db.queryAsync(
        "UPDATE session_meta SET title = 'Changed' WHERE id = 'missing'",
      );
      const invalidatedMessage =
        (await db.queryAsync(
          "SELECT search_text, search_index_version FROM messages WHERE id = 'legacy-edit'",
        )) || [];
      const invalidatedTitle =
        (await db.queryAsync(
          "SELECT search_title, search_index_version FROM session_meta WHERE id = 'missing'",
        )) || [];
      const invalidatedState =
        (await db.queryAsync(
          "SELECT completed, search_revision FROM chat_search_state WHERE id = 1",
        )) || [];
      assert.deepEqual(
        invalidatedMessage.map((row) => ({
          searchText: String(row.search_text),
          version: Number(row.search_index_version),
        })),
        [{ searchText: "", version: 0 }],
      );
      assert.deepEqual(
        invalidatedTitle.map((row) => ({
          searchTitle: String(row.search_title),
          version: Number(row.search_index_version),
        })),
        [{ searchTitle: "", version: 0 }],
      );
      assert.equal(Number(invalidatedState[0]?.completed), 0);
      assert.equal(Number(invalidatedState[0]?.search_revision), 2);

      const companionRows =
        (await db.queryAsync(
          "SELECT session_id, selected_tier, resolved_model_id FROM paperchat_session_state ORDER BY session_id",
        )) || [];
      assert.deepEqual(
        companionRows.map((row) => ({
          sessionId: String(row.session_id),
          tier: String(row.selected_tier),
          model: String(row.resolved_model_id),
        })),
        [
          { sessionId: "existing", tier: "new-tier", model: "new-model" },
          { sessionId: "missing", tier: "legacy-tier", model: "legacy-model" },
        ],
      );
    } finally {
      await db.closeDatabase(false);
      await removeProbeFile(dbPath);
      await removeProbeFile(`${dbPath}-wal`);
      await removeProbeFile(`${dbPath}-shm`);
    }
  });

  it("repairs reasoning and upgrades trusted message metadata to schema v11", async function () {
    const runtime = globalThis as any;
    if (
      !runtime.Zotero?.DBConnection ||
      !runtime.PathUtils ||
      !runtime.IOUtils
    ) {
      this.skip();
    }

    this.timeout(30_000);

    const dbPath = PathUtils.join(
      Zotero.getTempDirectory().path,
      `paperchat-reasoning-repair-${Date.now()}.sqlite`,
    );
    const db = new Zotero.DBConnection(dbPath) as ProbeDatabase;

    try {
      await db.queryAsync(
        "CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      );
      await db.queryAsync(
        "INSERT INTO schema_version (id, version, updated_at) VALUES (1, 9, 0)",
      );
      await db.queryAsync(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          images TEXT,
          files TEXT,
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
        )
      `);

      const storage = new StorageDatabase() as any;
      await storage.createTables(db);
      await storage.initSchemaVersion(db);

      const columnRows =
        (await db.queryAsync(
          "SELECT name FROM pragma_table_info('messages') ORDER BY name",
        )) || [];
      assert.includeMembers(
        columnRows.map((row) => String(row.name)),
        ["reasoning", "evidence", "source_item_keys"],
      );
      const versionRows =
        (await db.queryAsync(
          "SELECT version FROM schema_version WHERE id = 1",
        )) || [];
      assert.equal(Number(versionRows[0]?.version), 11);

      await db.queryAsync(
        `INSERT INTO messages
         (id, session_id, seq, role, content, reasoning, timestamp)
         VALUES ('reasoning-message', 'session', 0, 'assistant', 'answer', 'thought', 1)`,
      );
      const messageRows =
        (await db.queryAsync(
          "SELECT reasoning FROM messages WHERE id = 'reasoning-message'",
        )) || [];
      assert.equal(String(messageRows[0]?.reasoning), "thought");
    } finally {
      await db.closeDatabase(false);
      await removeProbeFile(dbPath);
      await removeProbeFile(`${dbPath}-wal`);
      await removeProbeFile(`${dbPath}-shm`);
    }
  });

  it("copies v4 companion rows through a literal SELECT source query", async function () {
    const runtime = globalThis as any;
    if (
      !runtime.Zotero?.DBConnection ||
      !runtime.PathUtils ||
      !runtime.IOUtils
    ) {
      this.skip();
    }

    this.timeout(30_000);

    const dbPath = PathUtils.join(
      Zotero.getTempDirectory().path,
      `paperchat-history-search-v5-${Date.now()}.sqlite`,
    );
    const db = new Zotero.DBConnection(dbPath) as ProbeDatabase;

    try {
      await db.queryAsync(
        "CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      );
      await db.queryAsync(
        "INSERT INTO schema_version (id, version, updated_at) VALUES (1, 4, 0)",
      );
      await db.queryAsync("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
      await db.queryAsync("CREATE TABLE messages (id TEXT PRIMARY KEY)");
      await db.queryAsync("INSERT INTO sessions (id) VALUES (?)", [
        "session-v4",
      ]);

      await (new StorageDatabase() as any).upgradeToV5(db);

      const companionRows =
        (await db.queryAsync(
          "SELECT session_id FROM paperchat_session_state ORDER BY session_id",
        )) || [];
      assert.deepEqual(
        companionRows.map((row) => String(row.session_id)),
        ["session-v4"],
      );
    } finally {
      await db.closeDatabase(false);
      await removeProbeFile(dbPath);
      await removeProbeFile(`${dbPath}-wal`);
      await removeProbeFile(`${dbPath}-shm`);
    }
  });
});
