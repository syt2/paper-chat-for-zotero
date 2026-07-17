import { assert } from "chai";
import {
  mapMessageRowToChatMessage,
  type MessageStorageRow,
} from "../src/modules/chat/SessionStorageService.ts";
import { StorageDatabase } from "../src/modules/chat/db/StorageDatabase.ts";

type ProbeDatabase = {
  queryAsync(sql: string, params?: unknown[]): Promise<any[] | undefined>;
  closeDatabase(permanent: boolean): Promise<void>;
  _getConnectionAsync(): Promise<{
    backup(path: string, pagesPerStep: number): Promise<void>;
  }>;
};

const SESSION_PAYLOAD_SQL = `
  SELECT quote(id) || '|' || quote(created_at) || '|' || quote(updated_at) ||
    '|' || quote(last_active_item_key) || '|' || quote(context_summary) ||
    '|' || quote(context_state) || '|' || quote(execution_plan) ||
    '|' || quote(tool_execution_state) || '|' || quote(tool_approval_state) ||
    '|' || quote(user_input_request_state) || '|' || quote(memory_extracted_at) ||
    '|' || quote(memory_extracted_msg_count) || '|' || quote(selected_tier) ||
    '|' || quote(resolved_model_id) || '|' || quote(last_retryable_user_message_id) ||
    '|' || quote(last_retryable_error_message_id) ||
    '|' || quote(last_retryable_failed_model_id) || '|' || quote(title) ||
    '|' || quote(title_source) || '|' || quote(title_generated_at) ||
    '|' || quote(title_edited_at) AS payload
  FROM sessions ORDER BY id
`;

const MESSAGE_PAYLOAD_SQL = `
  SELECT quote(id) || '|' || quote(session_id) || '|' || quote(seq) ||
    '|' || quote(role) || '|' || quote(content) || '|' || quote(reasoning) ||
    '|' || quote(images) || '|' || quote(files) || '|' || quote(timestamp) ||
    '|' || quote(pdf_context) || '|' || quote(selected_text) ||
    '|' || quote(tool_calls) || '|' || quote(tool_call_id) ||
    '|' || quote(streaming_state) || '|' || quote(api_only) ||
    '|' || quote(is_system_notice) AS payload
  FROM messages ORDER BY session_id, seq, id
`;

const META_PAYLOAD_SQL = `
  SELECT quote(id) || '|' || quote(created_at) || '|' || quote(updated_at) ||
    '|' || quote(message_count) || '|' || quote(last_message_preview) ||
    '|' || quote(last_message_time) || '|' || quote(title) ||
    '|' || quote(title_source) || '|' || quote(title_generated_at) ||
    '|' || quote(title_edited_at) AS payload
  FROM session_meta ORDER BY id
`;

async function readPayloadRows(
  db: ProbeDatabase,
  sql: string,
): Promise<string[]> {
  const rows = (await db.queryAsync(sql)) || [];
  return rows.map((row) => String(row.payload));
}

async function readVersion(db: ProbeDatabase): Promise<number> {
  const rows =
    (await db.queryAsync("SELECT version FROM schema_version WHERE id = 1")) ||
    [];
  return Number(rows[0]?.version);
}

async function readRowCount(
  db: ProbeDatabase,
  table: "sessions" | "messages" | "session_meta" | "paperchat_session_state",
): Promise<number> {
  const rows =
    (await db.queryAsync(`SELECT COUNT(*) AS row_count FROM ${table}`)) || [];
  return Number(rows[0]?.row_count);
}

describe("upgrade from the official V2.6.1 database", function () {
  let originalZtoolkitDescriptor: PropertyDescriptor | undefined;

  before(function () {
    // This test bundle runs in the scaffold runner's chrome global, while the
    // production addon defines ztoolkit in its own global. Direct migration
    // calls below need the same logging surface before they execute any SQL.
    originalZtoolkitDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "ztoolkit",
    );
    Object.defineProperty(globalThis, "ztoolkit", {
      configurable: true,
      get: () => (Zotero as any).PaperChat.data.ztoolkit,
    });
  });

  after(function () {
    if (originalZtoolkitDescriptor) {
      Object.defineProperty(globalThis, "ztoolkit", originalZtoolkitDescriptor);
      return;
    }
    delete (globalThis as any).ztoolkit;
  });

  it("preserves reasoning and semantic data through the production startup path", async function () {
    this.timeout(30000);

    const baselinePath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "paper-chat",
      "baseline-v8",
    );
    const upgradedPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "paper-chat",
      "storage",
    );
    const upgradeStage = Zotero.Prefs.get(
      "extensions.zotero.paperchat.onlineReleaseUpgradeStage",
      true,
    );
    assert.oneOf(upgradeStage, ["upgrade", "idempotency"]);
    const baseline = new Zotero.DBConnection(baselinePath) as ProbeDatabase;
    const upgraded = new Zotero.DBConnection(upgradedPath) as ProbeDatabase;

    try {
      assert.equal(await readVersion(baseline), 8);
      assert.equal(await readVersion(upgraded), 9);

      assert.equal(await readRowCount(baseline, "sessions"), 2);
      assert.equal(await readRowCount(baseline, "messages"), 3);
      assert.equal(await readRowCount(baseline, "session_meta"), 2);
      assert.equal(await readRowCount(baseline, "paperchat_session_state"), 1);

      const baselineMessageColumns =
        (await baseline.queryAsync(
          "SELECT name FROM pragma_table_info('messages') ORDER BY name",
        )) || [];
      assert.include(
        baselineMessageColumns.map((row) => String(row.name)),
        "reasoning",
      );
      assert.notInclude(
        baselineMessageColumns.map((row) => String(row.name)),
        "search_text",
      );

      const upgradedMessageColumns =
        (await upgraded.queryAsync(
          "SELECT name FROM pragma_table_info('messages') ORDER BY name",
        )) || [];
      assert.includeMembers(
        upgradedMessageColumns.map((row) => String(row.name)),
        ["reasoning", "search_text", "search_index_version"],
      );

      const upgradedMetaColumns =
        (await upgraded.queryAsync(
          "SELECT name FROM pragma_table_info('session_meta') ORDER BY name",
        )) || [];
      assert.includeMembers(
        upgradedMetaColumns.map((row) => String(row.name)),
        ["search_title", "search_index_version"],
      );

      const schemaObjectRows =
        (await upgraded.queryAsync(
          `SELECT name FROM sqlite_master
           WHERE name IN (
             'chat_search_state',
             'idx_messages_search_work',
             'idx_messages_session_search_work',
             'idx_session_meta_search_work',
             'trg_messages_search_projection_stale',
             'trg_session_meta_search_projection_stale'
           )
           ORDER BY name`,
        )) || [];
      assert.sameMembers(
        schemaObjectRows.map((row) => String(row.name)),
        [
          "chat_search_state",
          "idx_messages_search_work",
          "idx_messages_session_search_work",
          "idx_session_meta_search_work",
          "trg_messages_search_projection_stale",
          "trg_session_meta_search_projection_stale",
        ],
      );

      let searchStateRows =
        (await upgraded.queryAsync(
          `SELECT target_version, completed, revision_epoch,
             search_revision, updated_at
           FROM chat_search_state WHERE id = 1`,
        )) || [];
      if (upgradeStage === "upgrade") {
        assert.lengthOf(searchStateRows, 0);
        const defaultMessageProjectionRows =
          (await upgraded.queryAsync(
            `SELECT search_text, search_index_version FROM messages
             WHERE id = 'online-v261-assistant-message'`,
          )) || [];
        assert.equal(String(defaultMessageProjectionRows[0]?.search_text), "");
        assert.equal(
          Number(defaultMessageProjectionRows[0]?.search_index_version),
          0,
        );
        const defaultTitleProjectionRows =
          (await upgraded.queryAsync(
            `SELECT search_title, search_index_version FROM session_meta
             WHERE id = 'online-v261-existing-companion'`,
          )) || [];
        assert.equal(String(defaultTitleProjectionRows[0]?.search_title), "");
        assert.equal(
          Number(defaultTitleProjectionRows[0]?.search_index_version),
          0,
        );

        await upgraded.queryAsync("BEGIN TRANSACTION");
        try {
          await upgraded.queryAsync(
            `UPDATE messages
             SET search_text = 'v9-message-sentinel',
                 search_index_version = 41
             WHERE id = 'online-v261-assistant-message'`,
          );
          await upgraded.queryAsync(
            `UPDATE session_meta
             SET search_title = 'v9-title-sentinel',
                 search_index_version = 41
             WHERE id = 'online-v261-existing-companion'`,
          );
          await upgraded.queryAsync(
            `INSERT INTO chat_search_state
             (id, target_version, completed, revision_epoch,
              search_revision, updated_at)
             VALUES (1, 41, 1, 'v9-idempotency-sentinel', 17, 1720000015000)`,
          );
          await upgraded.queryAsync("COMMIT");
        } catch (error) {
          await upgraded.queryAsync("ROLLBACK");
          throw error;
        }
        searchStateRows =
          (await upgraded.queryAsync(
            `SELECT target_version, completed, revision_epoch,
               search_revision, updated_at
             FROM chat_search_state WHERE id = 1`,
          )) || [];
      } else {
        assert.equal(upgradeStage, "idempotency");
        assert.lengthOf(searchStateRows, 1);
      }

      assert.lengthOf(searchStateRows, 1);
      assert.equal(Number(searchStateRows[0]?.target_version), 41);
      assert.equal(Number(searchStateRows[0]?.completed), 1);
      assert.equal(
        String(searchStateRows[0]?.revision_epoch),
        "v9-idempotency-sentinel",
      );
      assert.equal(Number(searchStateRows[0]?.search_revision), 17);
      assert.equal(Number(searchStateRows[0]?.updated_at), 1720000015000);

      const messageProjectionRows =
        (await upgraded.queryAsync(
          `SELECT search_text, search_index_version FROM messages
           WHERE id = 'online-v261-assistant-message'`,
        )) || [];
      assert.equal(
        String(messageProjectionRows[0]?.search_text),
        "v9-message-sentinel",
      );
      assert.equal(Number(messageProjectionRows[0]?.search_index_version), 41);
      const titleProjectionRows =
        (await upgraded.queryAsync(
          `SELECT search_title, search_index_version FROM session_meta
           WHERE id = 'online-v261-existing-companion'`,
        )) || [];
      assert.equal(
        String(titleProjectionRows[0]?.search_title),
        "v9-title-sentinel",
      );
      assert.equal(Number(titleProjectionRows[0]?.search_index_version), 41);

      assert.deepEqual(
        await readPayloadRows(upgraded, SESSION_PAYLOAD_SQL),
        await readPayloadRows(baseline, SESSION_PAYLOAD_SQL),
      );
      assert.deepEqual(
        await readPayloadRows(upgraded, MESSAGE_PAYLOAD_SQL),
        await readPayloadRows(baseline, MESSAGE_PAYLOAD_SQL),
      );
      assert.deepEqual(
        await readPayloadRows(upgraded, META_PAYLOAD_SQL),
        await readPayloadRows(baseline, META_PAYLOAD_SQL),
      );

      const existingCompanionRows =
        (await upgraded.queryAsync(
          `SELECT selected_tier, resolved_model_id,
             last_retryable_user_message_id,
             last_retryable_error_message_id,
             last_retryable_failed_model_id
           FROM paperchat_session_state
           WHERE session_id = 'online-v261-existing-companion'`,
        )) || [];
      assert.equal(existingCompanionRows.length, 1);
      assert.equal(
        String(existingCompanionRows[0]?.selected_tier),
        "companion-tier",
      );
      assert.equal(
        String(existingCompanionRows[0]?.resolved_model_id),
        "companion-model",
      );
      assert.equal(
        String(existingCompanionRows[0]?.last_retryable_user_message_id),
        "companion-user",
      );
      assert.equal(
        String(existingCompanionRows[0]?.last_retryable_error_message_id),
        "companion-error",
      );
      assert.equal(
        String(existingCompanionRows[0]?.last_retryable_failed_model_id),
        "companion-failed-model",
      );

      const repairedCompanionRows =
        (await upgraded.queryAsync(
          `SELECT selected_tier, resolved_model_id
           FROM paperchat_session_state
           WHERE session_id = 'online-v261-missing-companion'`,
        )) || [];
      assert.equal(repairedCompanionRows.length, 1);
      assert.equal(
        String(repairedCompanionRows[0]?.selected_tier),
        "repair-tier",
      );
      assert.equal(
        String(repairedCompanionRows[0]?.resolved_model_id),
        "repair-model",
      );

      const reasoningRows =
        (await upgraded.queryAsync(
          `SELECT reasoning FROM messages
           WHERE id = 'online-v261-assistant-message'`,
        )) || [];
      assert.equal(
        String(reasoningRows[0]?.reasoning),
        "V2.6.1 reasoning sentinel 思考内容",
      );

      const partialRows =
        (await upgraded.queryAsync(
          `SELECT id, role, content, timestamp, selected_text, tool_calls,
             tool_call_id, streaming_state, api_only, is_system_notice
           FROM messages
           WHERE id = 'online-v261-assistant-message'`,
        )) || [];
      let partialMessage:
        | ReturnType<typeof mapMessageRowToChatMessage>
        | undefined;
      assert.doesNotThrow(() => {
        partialMessage = mapMessageRowToChatMessage(
          partialRows[0] as MessageStorageRow,
        );
      });
      assert.isUndefined(partialMessage?.reasoning);

      const fullRows =
        (await upgraded.queryAsync(
          `SELECT * FROM messages
           WHERE id = 'online-v261-assistant-message'`,
        )) || [];
      const fullMessage = mapMessageRowToChatMessage(
        fullRows[0] as MessageStorageRow,
      );
      assert.equal(fullMessage.reasoning, "V2.6.1 reasoning sentinel 思考内容");

      await upgraded.queryAsync("BEGIN TRANSACTION");
      try {
        await upgraded.queryAsync(
          `UPDATE messages SET reasoning = ?
           WHERE id = 'online-v261-assistant-message'`,
          ["reasoning remains writable after v9 upgrade"],
        );
        const writableRows =
          (await upgraded.queryAsync(
            `SELECT reasoning FROM messages
             WHERE id = 'online-v261-assistant-message'`,
          )) || [];
        assert.equal(
          String(writableRows[0]?.reasoning),
          "reasoning remains writable after v9 upgrade",
        );
      } finally {
        await upgraded.queryAsync("ROLLBACK");
      }

      const integrityRows =
        (await upgraded.queryAsync("PRAGMA integrity_check")) || [];
      assert.equal(String(integrityRows[0]?.integrity_check), "ok");

      const scaffoldDir = PathUtils.parent(Zotero.DataDirectory.dir, 2);
      assert.isString(scaffoldDir);
      const stageDir = PathUtils.join(scaffoldDir!, "online-release-upgrade");
      const stageStoragePath = PathUtils.join(stageDir, "storage-v9");
      await IOUtils.makeDirectory(stageDir, { ignoreExisting: true });
      try {
        await IOUtils.remove(stageStoragePath);
      } catch {
        // The first run has no previous stage snapshot.
      }
      const rawConnection = await upgraded._getConnectionAsync();
      await rawConnection.backup(stageStoragePath, 256);
      assert.isTrue(await IOUtils.exists(stageStoragePath));
    } finally {
      await baseline.closeDatabase(false);
      await upgraded.closeDatabase(false);
    }
  });

  it("rolls a failed v9 migration back without breaking V2.6.1 writes", async function () {
    this.timeout(30000);

    const rollbackPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "paper-chat",
      "rollback-v8",
    );
    const db = new Zotero.DBConnection(rollbackPath) as ProbeDatabase;
    let injectedFailure = false;
    let lastMigrationSql = "";
    const failingClient = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        lastMigrationSql = sql.trim().replace(/\s+/g, " ");
        if (
          !injectedFailure &&
          /UPDATE\s+schema_version\s+SET\s+version/i.test(sql) &&
          Number(params?.[0]) === 9
        ) {
          injectedFailure = true;
          throw new Error("forced v9 version-write failure");
        }
        return db.queryAsync(sql, params);
      },
      closeDatabase: (permanent: boolean) => db.closeDatabase(permanent),
    };
    const storage = new StorageDatabase() as any;

    try {
      assert.equal(await readVersion(db), 8);
      await storage.createTables(failingClient);

      const preMigrationTriggerRows =
        (await db.queryAsync(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger'
             AND name IN (
               'trg_messages_search_projection_stale',
               'trg_session_meta_search_projection_stale'
             )`,
        )) || [];
      assert.lengthOf(preMigrationTriggerRows, 0);

      let migrationError: unknown;
      try {
        await storage.upgradeToV9(failingClient);
      } catch (error) {
        migrationError = error;
      }
      const migrationDetail =
        migrationError instanceof Error
          ? `${migrationError.name}: ${migrationError.message}\n${
              migrationError.stack || ""
            }`
          : String(migrationError);
      assert.isTrue(
        injectedFailure,
        `migration failed before the injected version write while executing ${lastMigrationSql}: ${migrationDetail}`,
      );
      assert.instanceOf(migrationError, Error);
      assert.include(
        (migrationError as Error).message,
        "forced v9 version-write failure",
      );

      assert.equal(await readVersion(db), 8);
      const messageColumns =
        (await db.queryAsync(
          "SELECT name FROM pragma_table_info('messages') ORDER BY name",
        )) || [];
      assert.notInclude(
        messageColumns.map((row) => String(row.name)),
        "search_text",
      );
      assert.notInclude(
        messageColumns.map((row) => String(row.name)),
        "search_index_version",
      );
      const metaColumns =
        (await db.queryAsync(
          "SELECT name FROM pragma_table_info('session_meta') ORDER BY name",
        )) || [];
      assert.notInclude(
        metaColumns.map((row) => String(row.name)),
        "search_title",
      );
      assert.notInclude(
        metaColumns.map((row) => String(row.name)),
        "search_index_version",
      );

      const rolledBackTriggerRows =
        (await db.queryAsync(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger'
             AND name IN (
               'trg_messages_search_projection_stale',
               'trg_session_meta_search_projection_stale'
             )`,
        )) || [];
      assert.lengthOf(rolledBackTriggerRows, 0);

      const companionRows =
        (await db.queryAsync(
          "SELECT session_id FROM paperchat_session_state ORDER BY session_id",
        )) || [];
      assert.deepEqual(
        companionRows.map((row) => String(row.session_id)),
        ["online-v261-existing-companion"],
      );

      await db.queryAsync(
        `UPDATE messages SET content = content || ' rollback-safe'
         WHERE id = 'online-v261-assistant-message'`,
      );
      await db.queryAsync(
        `UPDATE session_meta SET title = title || ' rollback-safe'
         WHERE id = 'online-v261-existing-companion'`,
      );
      const updatedRows =
        (await db.queryAsync(
          `SELECT content FROM messages
           WHERE id = 'online-v261-assistant-message'`,
        )) || [];
      assert.equal(
        String(updatedRows[0]?.content),
        "V2.6.1 visible answer rollback-safe",
      );

      await storage.upgradeToV9(failingClient);
      assert.equal(await readVersion(db), 9);
      const retryMessageColumns =
        (await db.queryAsync(
          "SELECT name FROM pragma_table_info('messages') ORDER BY name",
        )) || [];
      assert.includeMembers(
        retryMessageColumns.map((row) => String(row.name)),
        ["reasoning", "search_text", "search_index_version"],
      );
      const retryTriggerRows =
        (await db.queryAsync(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger'
             AND name IN (
               'trg_messages_search_projection_stale',
               'trg_session_meta_search_projection_stale'
             )
           ORDER BY name`,
        )) || [];
      assert.deepEqual(
        retryTriggerRows.map((row) => String(row.name)),
        [
          "trg_messages_search_projection_stale",
          "trg_session_meta_search_projection_stale",
        ],
      );
      const retryCompanionRows =
        (await db.queryAsync(
          "SELECT session_id FROM paperchat_session_state ORDER BY session_id",
        )) || [];
      assert.deepEqual(
        retryCompanionRows.map((row) => String(row.session_id)),
        ["online-v261-existing-companion", "online-v261-missing-companion"],
      );
      const retryReasoningRows =
        (await db.queryAsync(
          `SELECT reasoning FROM messages
           WHERE id = 'online-v261-assistant-message'`,
        )) || [];
      assert.equal(
        String(retryReasoningRows[0]?.reasoning),
        "V2.6.1 reasoning sentinel 思考内容",
      );

      const integrityRows =
        (await db.queryAsync("PRAGMA integrity_check")) || [];
      assert.equal(String(integrityRows[0]?.integrity_check), "ok");
    } finally {
      await db.closeDatabase(false);
    }
  });

  it("preserves committed V2.6.1 reasoning resident in WAL", async function () {
    this.timeout(30000);

    const walPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "paper-chat",
      "wal-v8",
    );
    const db = new Zotero.DBConnection(walPath) as ProbeDatabase;
    const storage = new StorageDatabase() as any;

    try {
      assert.equal(await readVersion(db), 8);
      await db.queryAsync("PRAGMA journal_mode=WAL");
      await db.queryAsync("PRAGMA wal_autocheckpoint=0");
      await db.queryAsync("BEGIN TRANSACTION");
      try {
        await db.queryAsync(
          `INSERT INTO messages
           (id, session_id, seq, role, content, reasoning, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            "online-v261-wal-message",
            "online-v261-existing-companion",
            2,
            "assistant",
            "V2.6.1 WAL visible answer",
            "V2.6.1 WAL reasoning sentinel",
            1720000002500,
          ],
        );
        await db.queryAsync(
          `UPDATE session_meta
           SET message_count = 3,
               last_message_preview = 'V2.6.1 WAL visible answer',
               last_message_time = 1720000002500
           WHERE id = 'online-v261-existing-companion'`,
        );
        await db.queryAsync("COMMIT");
      } catch (error) {
        await db.queryAsync("ROLLBACK");
        throw error;
      }

      const walInfo = await IOUtils.stat(`${walPath}-wal`);
      assert.isAbove(Number(walInfo.size), 0);

      await storage.createTables(db);
      await storage.initSchemaVersion(db);
      assert.equal(await readVersion(db), 9);
      const reasoningRows =
        (await db.queryAsync(
          `SELECT reasoning FROM messages
           WHERE id = 'online-v261-wal-message'`,
        )) || [];
      assert.equal(
        String(reasoningRows[0]?.reasoning),
        "V2.6.1 WAL reasoning sentinel",
      );
    } finally {
      await db.closeDatabase(false);
    }

    const reopened = new Zotero.DBConnection(walPath) as ProbeDatabase;
    try {
      assert.equal(await readVersion(reopened), 9);
      const reasoningRows =
        (await reopened.queryAsync(
          `SELECT reasoning FROM messages
           WHERE id = 'online-v261-wal-message'`,
        )) || [];
      assert.equal(
        String(reasoningRows[0]?.reasoning),
        "V2.6.1 WAL reasoning sentinel",
      );
      const integrityRows =
        (await reopened.queryAsync("PRAGMA integrity_check")) || [];
      assert.equal(String(integrityRows[0]?.integrity_check), "ok");
    } finally {
      await reopened.closeDatabase(false);
    }
  });
});
