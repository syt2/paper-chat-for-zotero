/**
 * V3 Migration - Migrate JSON file storage to SQLite
 *
 * Migration paths:
 * 1. V2 (sessions/*.json) → SQLite
 * 2. V1 (conversations/*.json) → SQLite (direct, reusing conversion logic)
 * 3. AI Summary progress.json → SQLite
 *
 * After successful migration, old files are deleted.
 */

import type {
  ChatSession,
  LegacyChatSession,
  SessionMeta,
} from "../../../types/chat";
import type { AISummaryStoredState } from "../../../types/ai-summary";
import { getStorageDatabase } from "../db/StorageDatabase";
import { getDataPath, getErrorMessage, generateShortId } from "../../../utils/common";

const MIGRATION_KEY = "migration_v3_completed";

/**
 * Check if V3 migration has been completed
 */
async function isMigrationCompleted(): Promise<boolean> {
  try {
    const db = await getStorageDatabase().ensureInit();
    const rows = (await db.queryAsync(
      "SELECT value FROM settings WHERE key = ?",
      [MIGRATION_KEY],
    )) || [];
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Mark migration as completed
 */
async function markMigrationCompleted(): Promise<void> {
  const db = await getStorageDatabase().ensureInit();
  await db.queryAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    [MIGRATION_KEY, JSON.stringify({ migratedAt: Date.now() })],
  );
}

/**
 * Build session metadata from a ChatSession
 */
function buildSessionMeta(session: ChatSession): SessionMeta {
  let lastMessagePreview = "";
  let lastMessageTime = session.updatedAt || Date.now();

  if (session.messages && session.messages.length > 0) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (msg.content && msg.role !== "tool") {
        lastMessagePreview =
          msg.content.substring(0, 50) + (msg.content.length > 50 ? "..." : "");
        lastMessageTime = msg.timestamp || session.updatedAt || Date.now();
        break;
      }
    }
  }

  return {
    id: session.id,
    createdAt: session.createdAt || Date.now(),
    updatedAt: session.updatedAt || Date.now(),
    messageCount: session.messages?.length || 0,
    lastMessagePreview,
    lastMessageTime,
  };
}

/**
 * Insert a session and its metadata into SQLite (within an existing transaction)
 */
async function insertSession(
  db: { queryAsync(sql: string, params?: unknown[]): Promise<any[] | undefined> },
  session: ChatSession,
): Promise<void> {
  const meta = buildSessionMeta(session);

  // Insert session row (no messages column in v2 schema)
  await db.queryAsync(
    `INSERT OR REPLACE INTO sessions
     (id, created_at, updated_at, last_active_item_key, last_active_item_keys, context_summary, context_state)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id,
      session.createdAt,
      session.updatedAt,
      session.lastActiveItemKey || null,
      session.lastActiveItemKeys ? JSON.stringify(session.lastActiveItemKeys) : null,
      session.contextSummary ? JSON.stringify(session.contextSummary) : null,
      session.contextState ? JSON.stringify(session.contextState) : null,
    ],
  );

  // Insert messages into the messages table (one row per message)
  const messages = session.messages || [];
  for (let seq = 0; seq < messages.length; seq++) {
    const msg = messages[seq];
    await db.queryAsync(
      `INSERT INTO messages (id, session_id, seq, role, content, images, files, timestamp, pdf_context, selected_text, tool_calls, tool_call_id, is_system_notice)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        session.id,
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

  // Insert session_meta
  await db.queryAsync(
    `INSERT OR REPLACE INTO session_meta
     (id, created_at, updated_at, message_count, last_message_preview, last_message_time)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      meta.id,
      meta.createdAt,
      meta.updatedAt,
      meta.messageCount,
      meta.lastMessagePreview,
      meta.lastMessageTime,
    ],
  );
}

/**
 * Migrate V2 sessions (sessions/*.json) to SQLite
 */
async function migrateV2Sessions(): Promise<{ count: number; activeSessionId: string | null }> {
  const sessionsPath = getDataPath("sessions");

  if (!(await IOUtils.exists(sessionsPath))) {
    return { count: 0, activeSessionId: null };
  }

  const children = await IOUtils.getChildren(sessionsPath);
  const sessionFiles = children.filter(
    (f) => f.endsWith(".json") && !f.endsWith("session-index.json"),
  );

  if (sessionFiles.length === 0) {
    return { count: 0, activeSessionId: null };
  }

  ztoolkit.log(`[Migration V3] Found ${sessionFiles.length} V2 session files`);

  // Try to load the existing index for activeSessionId
  let activeSessionId: string | null = null;
  const indexPath = PathUtils.join(sessionsPath, "session-index.json");
  try {
    if (await IOUtils.exists(indexPath)) {
      const indexData = await IOUtils.readJSON(indexPath);
      activeSessionId = (indexData as any)?.activeSessionId || null;
    }
  } catch {
    // Index file corrupted, we'll pick the most recent session
  }

  const db = await getStorageDatabase().ensureInit();
  let migratedCount = 0;
  let latestSession: { id: string; updatedAt: number } | null = null;

  // Migrate in a transaction
  await db.queryAsync("BEGIN TRANSACTION");
  try {
    for (const filePath of sessionFiles) {
      try {
        const session = (await IOUtils.readJSON(filePath)) as ChatSession;
        if (!session.id) continue;

        await insertSession(db, session);
        migratedCount++;

        if (!latestSession || (session.updatedAt || 0) > latestSession.updatedAt) {
          latestSession = { id: session.id, updatedAt: session.updatedAt || 0 };
        }
      } catch (error) {
        ztoolkit.log(`[Migration V3] Error migrating file ${filePath}:`, getErrorMessage(error));
      }
    }

    // Set active session
    const finalActiveId = activeSessionId || latestSession?.id || null;
    if (finalActiveId) {
      await db.queryAsync(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        ["active_session_id", finalActiveId],
      );
    }

    await db.queryAsync("COMMIT");
    ztoolkit.log(`[Migration V3] V2 sessions migrated: ${migratedCount}`);
    return { count: migratedCount, activeSessionId: finalActiveId };
  } catch (error) {
    try { await db.queryAsync("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Migrate V1 sessions (conversations/*.json) to SQLite
 */
async function migrateV1Sessions(): Promise<{ count: number; activeSessionId: string | null }> {
  const legacyPath = getDataPath("conversations");

  if (!(await IOUtils.exists(legacyPath))) {
    return { count: 0, activeSessionId: null };
  }

  const children = await IOUtils.getChildren(legacyPath);
  const sessionFiles = children.filter(
    (f) => f.endsWith(".json") && !f.endsWith("_index.json"),
  );

  if (sessionFiles.length === 0) {
    return { count: 0, activeSessionId: null };
  }

  ztoolkit.log(`[Migration V3] Found ${sessionFiles.length} V1 legacy session files`);

  const db = await getStorageDatabase().ensureInit();
  let migratedCount = 0;
  let latestSession: { id: string; updatedAt: number } | null = null;

  await db.queryAsync("BEGIN TRANSACTION");
  try {
    for (const filePath of sessionFiles) {
      try {
        const legacy = (await IOUtils.readJSON(filePath)) as LegacyChatSession;

        // Skip empty sessions
        if (!legacy.messages || legacy.messages.length === 0) continue;

        // Convert itemId to itemKey
        let itemKey: string | null = null;
        if (legacy.itemId && legacy.itemId !== 0) {
          try {
            const item = await Zotero.Items.getAsync(legacy.itemId);
            if (item) {
              itemKey = item.key;
            }
          } catch {
            // Item may have been deleted
          }
        }

        const newSession: ChatSession = {
          id: `${Date.now()}-${generateShortId()}`,
          createdAt: legacy.createdAt || Date.now(),
          updatedAt: legacy.updatedAt || Date.now(),
          lastActiveItemKey: itemKey,
          messages: legacy.messages,
          contextSummary: legacy.contextSummary,
          contextState: legacy.contextState,
        };

        await insertSession(db, newSession);
        migratedCount++;

        if (!latestSession || (newSession.updatedAt || 0) > latestSession.updatedAt) {
          latestSession = { id: newSession.id, updatedAt: newSession.updatedAt || 0 };
        }

        // Small delay to ensure unique IDs
        await new Promise((resolve) => setTimeout(resolve, 1));
      } catch (error) {
        ztoolkit.log(`[Migration V3] Error migrating V1 file ${filePath}:`, getErrorMessage(error));
      }
    }

    // Set active session
    if (latestSession) {
      await db.queryAsync(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        ["active_session_id", latestSession.id],
      );
    }

    await db.queryAsync("COMMIT");
    ztoolkit.log(`[Migration V3] V1 sessions migrated: ${migratedCount}`);
    return { count: migratedCount, activeSessionId: latestSession?.id || null };
  } catch (error) {
    try { await db.queryAsync("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Migrate AI Summary progress.json to SQLite
 */
async function migrateAISummaryProgress(): Promise<boolean> {
  const progressPath = getDataPath("ai-summary", "progress.json");

  try {
    if (!(await IOUtils.exists(progressPath))) {
      return false;
    }

    const content = await IOUtils.readUTF8(progressPath);
    const state = JSON.parse(content) as AISummaryStoredState;

    const db = await getStorageDatabase().ensureInit();
    await db.queryAsync(
      `INSERT OR REPLACE INTO ai_summary_progress
       (id, progress, pending_item_keys, completed_item_keys, failed_item_keys, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      [
        JSON.stringify(state.progress),
        JSON.stringify(state.pendingItemKeys),
        JSON.stringify(state.completedItemKeys),
        JSON.stringify(state.failedItemKeys),
        Date.now(),
      ],
    );

    ztoolkit.log("[Migration V3] AI Summary progress migrated");
    return true;
  } catch (error) {
    ztoolkit.log("[Migration V3] AI Summary progress migration error:", getErrorMessage(error));
    return false;
  }
}

/**
 * Delete old files after successful migration
 */
async function cleanupOldFiles(): Promise<void> {
  // Delete sessions/ directory
  const sessionsPath = getDataPath("sessions");
  try {
    if (await IOUtils.exists(sessionsPath)) {
      await IOUtils.remove(sessionsPath, { recursive: true });
      ztoolkit.log("[Migration V3] Deleted old sessions/ directory");
    }
  } catch (error) {
    ztoolkit.log("[Migration V3] Failed to delete sessions/:", getErrorMessage(error));
  }

  // Delete conversations/ directory
  const conversationsPath = getDataPath("conversations");
  try {
    if (await IOUtils.exists(conversationsPath)) {
      await IOUtils.remove(conversationsPath, { recursive: true });
      ztoolkit.log("[Migration V3] Deleted old conversations/ directory");
    }
  } catch (error) {
    ztoolkit.log("[Migration V3] Failed to delete conversations/:", getErrorMessage(error));
  }

  // Delete ai-summary/progress.json
  const progressPath = getDataPath("ai-summary", "progress.json");
  try {
    if (await IOUtils.exists(progressPath)) {
      await IOUtils.remove(progressPath);
      ztoolkit.log("[Migration V3] Deleted old ai-summary/progress.json");
    }
  } catch (error) {
    ztoolkit.log("[Migration V3] Failed to delete progress.json:", getErrorMessage(error));
  }
}

/**
 * Main entry point: check and run V3 migration
 */
export async function checkAndMigrateToV3(): Promise<void> {
  try {
    // Check if already migrated
    if (await isMigrationCompleted()) {
      ztoolkit.log("[Migration V3] Already completed, skipping");
      return;
    }

    ztoolkit.log("[Migration V3] Starting migration...");

    // Try V2 sessions first (most common path for V1.1.1 users)
    const sessionsPath = getDataPath("sessions");
    const hasV2 = await IOUtils.exists(sessionsPath);

    let migrated = false;

    if (hasV2) {
      const result = await migrateV2Sessions();
      if (result.count > 0) {
        ztoolkit.log(`[Migration V3] V2 migration: ${result.count} sessions`);
        migrated = true;
      }
    }

    // If no V2 data, try V1
    if (!migrated) {
      const conversationsPath = getDataPath("conversations");
      const hasV1 = await IOUtils.exists(conversationsPath);
      if (hasV1) {
        const result = await migrateV1Sessions();
        if (result.count > 0) {
          ztoolkit.log(`[Migration V3] V1 migration: ${result.count} sessions`);
          migrated = true;
        }
      }
    }

    // Migrate AI Summary progress (independent of session migration)
    await migrateAISummaryProgress();

    // Mark migration as completed
    await markMigrationCompleted();

    // Clean up old files
    if (migrated) {
      await cleanupOldFiles();
    }

    ztoolkit.log("[Migration V3] Migration completed successfully");
  } catch (error) {
    ztoolkit.log("[Migration V3] Migration failed:", getErrorMessage(error));
    // Don't mark as completed so it retries next startup
  }
}
