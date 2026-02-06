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
const SCHEMA_VERSION = 1;

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

    // Chat sessions (messages stored as JSON blob)
    await db.queryAsync(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_active_item_key TEXT,
        last_active_item_keys TEXT,
        messages TEXT NOT NULL DEFAULT '[]',
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
      await db.queryAsync(
        "INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?, ?)",
        [SCHEMA_VERSION, Date.now()],
      );
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
