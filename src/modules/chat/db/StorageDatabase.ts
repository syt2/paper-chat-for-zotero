/**
 * StorageDatabase - SQLite storage for chat sessions, settings, and AI summary progress
 *
 * Uses Zotero.DBConnection for reliable persistence.
 * Separate from VectorStore (different lifecycle: vectors can be rebuilt, sessions cannot).
 *
 * Database location: paper-chat/storage
 */

import { getErrorMessage } from "../../../utils/common";

const DB_DIR = "paper-chat";
const DB_NAME = "paper-chat/storage";
const SCHEMA_VERSION = 2;

/**
 * Minimal type definition for Zotero.DBConnection
 */
interface ZoteroDBConnection {
  queryAsync(sql: string, params?: unknown[]): Promise<any[] | undefined>;
}

export class StorageDatabase {
  private db: ZoteroDBConnection | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the SQLite database
   */
  async init(): Promise<void> {
    if (this.db) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.initDatabase();
    return this.initPromise;
  }

  private async initDatabase(): Promise<void> {
    try {
      // Ensure subdirectory exists
      const dataDir = Zotero.DataDirectory.dir;
      const subDir = PathUtils.join(dataDir, DB_DIR);
      await IOUtils.makeDirectory(subDir, { ignoreExisting: true });

      // Create database connection (assign to local var first;
      // only set this.db after all initialization succeeds to prevent
      // concurrent callers from seeing a partially-initialized DB)
      const db: ZoteroDBConnection = new Zotero.DBConnection(DB_NAME);

      // Enable WAL mode for better concurrent read performance
      await db.queryAsync("PRAGMA journal_mode=WAL");
      // Enable foreign keys (best-effort: may not persist across reconnections,
      // so callers should not rely solely on CASCADE - always delete explicitly)
      await db.queryAsync("PRAGMA foreign_keys=ON");

      // Create all tables
      await this.createTables(db);

      // Initialize schema version
      await this.initSchemaVersion(db);

      // Mark as fully initialized only after everything succeeds
      this.db = db;

      ztoolkit.log("[StorageDatabase] SQLite database initialized successfully");
    } catch (error) {
      ztoolkit.log(
        "[StorageDatabase] Failed to initialize database:",
        getErrorMessage(error),
      );
      this.db = null;
      this.initPromise = null;
      throw error;
    }
  }

  private async createTables(db: ZoteroDBConnection): Promise<void> {
    // Schema version table
    await db.queryAsync(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Chat sessions (messages stored in separate table)
    await db.queryAsync(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_active_item_key TEXT,
        last_active_item_keys TEXT,
        context_summary TEXT,
        context_state TEXT
      )
    `);

    await db.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
      ON sessions (updated_at DESC)
    `);

    // Session metadata (lightweight queries, replaces session-index.json)
    await db.queryAsync(`
      CREATE TABLE IF NOT EXISTS session_meta (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_message_preview TEXT NOT NULL DEFAULT '',
        last_message_time INTEGER NOT NULL,
        FOREIGN KEY (id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    await db.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_session_meta_updated_at
      ON session_meta (updated_at DESC)
    `);

    // Chat messages (one row per message)
    await db.queryAsync(`
      CREATE TABLE IF NOT EXISTS messages (
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
        is_system_notice INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    await db.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_seq
      ON messages (session_id, seq ASC)
    `);

    // Key-value settings (active_session_id, migration markers, etc.)
    await db.queryAsync(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // AI Summary progress (single row state)
    await db.queryAsync(`
      CREATE TABLE IF NOT EXISTS ai_summary_progress (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        progress TEXT NOT NULL,
        pending_item_keys TEXT NOT NULL,
        completed_item_keys TEXT NOT NULL,
        failed_item_keys TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  private async initSchemaVersion(db: ZoteroDBConnection): Promise<void> {
    const rows = (await db.queryAsync(
      "SELECT version FROM schema_version WHERE id = 1",
    )) || [];

    if (rows.length === 0) {
      // Fresh install — tables already created with v2 schema
      await db.queryAsync(
        "INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?, ?)",
        [SCHEMA_VERSION, Date.now()],
      );
    } else {
      const currentVersion = rows[0].version;
      if (currentVersion < 2) {
        await this.devUpgradeToV2(db);
      }
    }
  }

  /**
   * Dev-period upgrade: migrate from schema v1 (messages JSON blob in sessions)
   * to schema v2 (separate messages table).
   *
   * This only affects dev users who had the v1 SQLite schema.
   * Published users migrated from file-based storage directly into the current schema.
   */
  private async devUpgradeToV2(db: ZoteroDBConnection): Promise<void> {
    ztoolkit.log("[StorageDatabase] Upgrading schema v1 → v2...");

    await db.queryAsync("BEGIN TRANSACTION");
    try {
      // 1. Read all existing session rows (with messages JSON blob)
      const sessionRows = (await db.queryAsync(
        "SELECT id, created_at, updated_at, last_active_item_key, last_active_item_keys, messages, context_summary, context_state FROM sessions",
      )) || [];

      // 2. Create new sessions table without messages column
      await db.queryAsync(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_active_item_key TEXT,
          last_active_item_keys TEXT,
          context_summary TEXT,
          context_state TEXT
        )
      `);

      // 3. Create messages table (may already exist from createTables, use IF NOT EXISTS)
      await db.queryAsync(`
        CREATE TABLE IF NOT EXISTS messages (
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
          is_system_notice INTEGER,
          FOREIGN KEY (session_id) REFERENCES sessions_new(id) ON DELETE CASCADE
        )
      `);

      // 4. Migrate each session
      for (const row of sessionRows) {
        // Insert into sessions_new (without messages)
        await db.queryAsync(
          `INSERT INTO sessions_new (id, created_at, updated_at, last_active_item_key, last_active_item_keys, context_summary, context_state)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.created_at,
            row.updated_at,
            row.last_active_item_key,
            row.last_active_item_keys,
            row.context_summary,
            row.context_state,
          ],
        );

        // Parse and insert messages
        let messages: any[] = [];
        try {
          messages = row.messages ? JSON.parse(row.messages) : [];
        } catch {
          messages = [];
        }

        for (let seq = 0; seq < messages.length; seq++) {
          const msg = messages[seq];
          if (!msg.id || !msg.role) continue;

          await db.queryAsync(
            `INSERT INTO messages (id, session_id, seq, role, content, images, files, timestamp, pdf_context, selected_text, tool_calls, tool_call_id, is_system_notice)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              msg.id,
              row.id,
              seq,
              msg.role,
              msg.content || "",
              msg.images ? JSON.stringify(msg.images) : null,
              msg.files ? JSON.stringify(msg.files) : null,
              msg.timestamp || Date.now(),
              msg.pdfContext ? 1 : null,
              msg.selectedText || null,
              msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
              msg.tool_call_id || null,
              msg.isSystemNotice ? 1 : null,
            ],
          );
        }
      }

      // 5. Drop old sessions table and rename new one
      await db.queryAsync("DROP TABLE sessions");
      await db.queryAsync("ALTER TABLE sessions_new RENAME TO sessions");

      // 6. Rebuild indexes
      await db.queryAsync(`
        CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
        ON sessions (updated_at DESC)
      `);
      await db.queryAsync(`
        CREATE INDEX IF NOT EXISTS idx_messages_session_seq
        ON messages (session_id, seq ASC)
      `);

      // 7. Update schema version
      await db.queryAsync(
        "UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1",
        [2, Date.now()],
      );

      await db.queryAsync("COMMIT");
      ztoolkit.log("[StorageDatabase] Schema upgrade v1 → v2 completed");
    } catch (error) {
      try { await db.queryAsync("ROLLBACK"); } catch { /* ignore */ }
      ztoolkit.log("[StorageDatabase] Schema upgrade failed:", getErrorMessage(error));
      throw error;
    }
  }

  /**
   * Ensure database is initialized and return the connection
   */
  async ensureInit(): Promise<ZoteroDBConnection> {
    await this.init();
    if (!this.db) {
      throw new Error("StorageDatabase not initialized");
    }
    return this.db;
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db = null;
      this.initPromise = null;
      ztoolkit.log("[StorageDatabase] Database reference cleared");
    }
  }
}

// Singleton instance
let storageDatabase: StorageDatabase | null = null;

export function getStorageDatabase(): StorageDatabase {
  if (!storageDatabase) {
    storageDatabase = new StorageDatabase();
  }
  return storageDatabase;
}

export function destroyStorageDatabase(): void {
  if (storageDatabase) {
    storageDatabase.close();
    storageDatabase = null;
  }
}
