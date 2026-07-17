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
import {
  getStorageDatabase,
  type StorageTransactionClient,
} from "../db/StorageDatabase";
import {
  CURRENT_SEARCH_VERSION,
  projectMessageSearchNormalizedText,
  projectSearchNormalizedText,
} from "../search/SearchProjection";
import {
  getDataPath,
  getErrorMessage,
  generateShortId,
} from "../../../utils/common";

const MIGRATION_KEY = "migration_v3_completed";
const MIGRATION_FILE_KEY_PREFIX = "migration_v3_file";
const SESSION_MIGRATION_BATCH_SIZE = 25;
const MESSAGE_ID_LOOKUP_CHUNK_SIZE = 500;

interface SessionMigrationResult {
  count: number;
  activeSessionId: string | null;
  preparationFailures: string[];
}

/**
 * Check if V3 migration has been completed
 */
async function isMigrationCompleted(): Promise<boolean> {
  try {
    const db = await getStorageDatabase().ensureInit();
    const rows =
      (await db.queryAsync("SELECT value FROM settings WHERE key = ?", [
        MIGRATION_KEY,
      ])) || [];
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
      if (msg.content && msg.role !== "tool" && !msg.apiOnly) {
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
    messageCount: session.messages?.filter((msg) => !msg.apiOnly).length || 0,
    lastMessagePreview,
    lastMessageTime,
    title: session.title,
    titleSource: session.titleSource,
    titleGeneratedAt: session.titleGeneratedAt,
    titleEditedAt: session.titleEditedAt,
  };
}

interface PreparedImportedSession {
  source: "v1" | "v2";
  filePath: string;
  markerKey: string;
  id: string;
  updatedAt: number;
  sessionParams: unknown[];
  companionParams: unknown[];
  messageParams: unknown[][];
  metaParams: unknown[];
}

function prepareImportedSession(
  source: "v1" | "v2",
  filePath: string,
  markerKey: string,
  session: ChatSession,
): PreparedImportedSession {
  const meta = buildSessionMeta(session);
  const searchTitle = projectSearchNormalizedText([
    {
      kind: "text",
      text: session.title || "",
      separator: "none",
    },
  ]);
  const messageParams = (session.messages || []).map((msg, seq) => [
    msg.id,
    session.id,
    seq,
    msg.role,
    msg.content || "",
    msg.reasoning || null,
    msg.images ? JSON.stringify(msg.images) : null,
    msg.files ? JSON.stringify(msg.files) : null,
    msg.timestamp || Date.now(),
    msg.pdfContext ? 1 : null,
    msg.selectedText || null,
    msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
    msg.tool_call_id || null,
    msg.streamingState || null,
    msg.apiOnly ? 1 : null,
    msg.isSystemNotice ? 1 : null,
    projectMessageSearchNormalizedText(msg),
    CURRENT_SEARCH_VERSION,
  ]);

  return {
    source,
    filePath,
    markerKey,
    id: session.id,
    updatedAt: session.updatedAt || 0,
    sessionParams: [
      session.id,
      session.createdAt,
      session.updatedAt,
      session.lastActiveItemKey || null,
      session.title || null,
      session.titleSource || null,
      session.titleGeneratedAt ?? null,
      session.titleEditedAt ?? null,
      session.contextSummary ? JSON.stringify(session.contextSummary) : null,
      session.contextState ? JSON.stringify(session.contextState) : null,
      session.executionPlan ? JSON.stringify(session.executionPlan) : null,
      session.toolExecutionState
        ? JSON.stringify(session.toolExecutionState)
        : null,
      session.toolApprovalState
        ? JSON.stringify(session.toolApprovalState)
        : null,
      session.userInputRequestState
        ? JSON.stringify(session.userInputRequestState)
        : null,
      session.memoryExtractedAt ?? null,
      session.memoryExtractedMsgCount ?? null,
    ],
    companionParams: [
      session.id,
      session.selectedTier || null,
      session.resolvedModelId || null,
      session.lastRetryableUserMessageId || null,
      session.lastRetryableErrorMessageId || null,
      session.lastRetryableFailedModelId || null,
    ],
    messageParams,
    metaParams: [
      meta.id,
      meta.createdAt,
      meta.updatedAt,
      meta.messageCount,
      meta.lastMessagePreview,
      meta.lastMessageTime,
      meta.title || null,
      meta.titleSource || null,
      meta.titleGeneratedAt ?? null,
      meta.titleEditedAt ?? null,
      searchTitle,
      CURRENT_SEARCH_VERSION,
    ],
  };
}

interface SessionInsertOutcome {
  prepared: PreparedImportedSession;
  status: "inserted" | "covered";
}

async function findForeignMessageOwners(
  db: StorageTransactionClient,
  prepared: PreparedImportedSession,
): Promise<Map<string, string>> {
  const messageIds = [
    ...new Set(
      prepared.messageParams
        .map((params) => params[0])
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const owners = new Map<string, string>();

  for (
    let offset = 0;
    offset < messageIds.length;
    offset += MESSAGE_ID_LOOKUP_CHUNK_SIZE
  ) {
    const chunk = messageIds.slice(
      offset,
      offset + MESSAGE_ID_LOOKUP_CHUNK_SIZE,
    );
    const placeholders = chunk.map(() => "?").join(", ");
    const rows =
      (await db.queryAsync(
        `SELECT id, session_id FROM messages WHERE id IN (${placeholders})`,
        chunk,
      )) || [];

    for (const row of rows) {
      const messageId = String(row.id);
      const sessionId = String(row.session_id);
      if (sessionId !== prepared.id) {
        owners.set(messageId, sessionId);
      }
    }
  }

  return owners;
}

async function markImportedSessionCovered(
  db: StorageTransactionClient,
  prepared: PreparedImportedSession,
): Promise<void> {
  await db.queryAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    [
      prepared.markerKey,
      JSON.stringify({
        importedAt: Date.now(),
        coveredByExistingMessages: true,
      }),
    ],
  );
}

/**
 * A JSON import can run before SessionStorageService initializes its singleton
 * search state. Create that state if needed, then publish the imported semantic
 * batch by incrementing its durable revision. Existing target versions are
 * deliberately left untouched so an older plugin cannot downgrade newer data.
 */
async function publishImportedSearchBatch(
  db: StorageTransactionClient,
  updatedAt: number,
  revisionEpoch: string,
): Promise<void> {
  await db.queryAsync(
    `INSERT OR IGNORE INTO chat_search_state
     (id, target_version, completed, revision_epoch, search_revision, updated_at)
     VALUES (1, ?, 0, ?, 0, ?)`,
    [CURRENT_SEARCH_VERSION, revisionEpoch, updatedAt],
  );

  // Recompute completion against the preserved target version. Imported rows
  // are projected at this build's version, so they correctly reopen backfill
  // when a newer build already owns the database state.
  await db.queryAsync(
    `UPDATE chat_search_state
     SET completed = CASE WHEN
           EXISTS (
             SELECT 1 FROM messages
             WHERE search_index_version < chat_search_state.target_version
             LIMIT 1
           ) OR EXISTS (
             SELECT 1 FROM session_meta
             WHERE search_index_version < chat_search_state.target_version
             LIMIT 1
           )
         THEN 0 ELSE 1 END,
         search_revision = search_revision + 1,
         updated_at = ?
     WHERE id = 1`,
    [updatedAt],
  );
}

/**
 * Insert a session and its metadata into SQLite (within an existing transaction)
 */
async function insertSession(
  db: StorageTransactionClient,
  prepared: PreparedImportedSession,
): Promise<void> {
  // Insert session row (no messages column in v2 schema)
  await db.queryAsync(
    `INSERT INTO sessions
     (id, created_at, updated_at, last_active_item_key, title, title_source, title_generated_at, title_edited_at, context_summary, context_state, execution_plan, tool_execution_state, tool_approval_state, user_input_request_state, memory_extracted_at, memory_extracted_msg_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       last_active_item_key = excluded.last_active_item_key,
       title = excluded.title,
       title_source = excluded.title_source,
       title_generated_at = excluded.title_generated_at,
       title_edited_at = excluded.title_edited_at,
       context_summary = excluded.context_summary,
       context_state = excluded.context_state,
       execution_plan = excluded.execution_plan,
       tool_execution_state = excluded.tool_execution_state,
       tool_approval_state = excluded.tool_approval_state,
       user_input_request_state = excluded.user_input_request_state,
       memory_extracted_at = excluded.memory_extracted_at,
       memory_extracted_msg_count = excluded.memory_extracted_msg_count`,
    prepared.sessionParams,
  );

  // Preserve a companion row that may already contain newer routing state.
  await db.queryAsync(
    `INSERT INTO paperchat_session_state
     (session_id, selected_tier, resolved_model_id, last_retryable_user_message_id, last_retryable_error_message_id, last_retryable_failed_model_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO NOTHING`,
    prepared.companionParams,
  );

  // Replace any pre-marker partial data for this source session inside the
  // same transaction. Once the marker commits, future retries skip the file.
  await db.queryAsync("DELETE FROM messages WHERE session_id = ?", [
    prepared.id,
  ]);

  // Insert messages into the messages table (one row per message)
  for (const params of prepared.messageParams) {
    await db.queryAsync(
      `INSERT INTO messages
       (id, session_id, seq, role, content, reasoning, images, files, timestamp, pdf_context, selected_text, tool_calls, tool_call_id, streaming_state, api_only, is_system_notice, search_text, search_index_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params,
    );
  }

  // Insert session_meta
  await db.queryAsync(
    `INSERT OR REPLACE INTO session_meta
     (id, created_at, updated_at, message_count, last_message_preview, last_message_time, title, title_source, title_generated_at, title_edited_at, search_title, search_index_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    prepared.metaParams,
  );

  // This marker commits atomically with the imported session. If a later
  // batch fails, retries skip this source snapshot instead of overwriting
  // user changes made to the already-visible SQLite session.
  await db.queryAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    [prepared.markerKey, JSON.stringify({ importedAt: Date.now() })],
  );
}

async function insertSessionBatch(
  preparedSessions: PreparedImportedSession[],
): Promise<SessionInsertOutcome[]> {
  if (preparedSessions.length === 0) return [];

  const batchUpdatedAt = Date.now();
  const revisionEpoch = `${batchUpdatedAt.toString(36)}-${generateShortId()}`;

  return getStorageDatabase().executeTransaction(async (db) => {
    const outcomes: SessionInsertOutcome[] = [];
    let insertedAnySession = false;

    for (const prepared of preparedSessions) {
      if (prepared.source === "v1") {
        const foreignOwners = await findForeignMessageOwners(db, prepared);
        if (foreignOwners.size > 0) {
          // Historical V1 -> V2 conversion preserved message ids but left the
          // V1 source file behind. Any foreign owner proves this V1 snapshot
          // was already converted. Importing its remaining stale messages
          // would create a duplicate session or resurrect messages deleted
          // from the newer V2 copy.
          await markImportedSessionCovered(db, prepared);
          outcomes.push({ prepared, status: "covered" });
          continue;
        }
      }

      try {
        await insertSession(db, prepared);
        insertedAnySession = true;
        outcomes.push({ prepared, status: "inserted" });
      } catch (error) {
        throw new Error(
          `Failed to migrate ${prepared.filePath}: ${getErrorMessage(error)}`,
        );
      }
    }

    if (insertedAnySession) {
      await publishImportedSearchBatch(db, batchUpdatedAt, revisionEpoch);
    }

    return outcomes;
  });
}

async function setActiveSessionId(activeSessionId: string | null) {
  if (!activeSessionId) return;

  await getStorageDatabase().executeTransaction(async (db) => {
    await db.queryAsync(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ["active_session_id", activeSessionId],
    );
  });
}

function getLegacySessionId(
  filePath: string,
  legacy: LegacyChatSession,
): string {
  const sourceId =
    typeof legacy.id === "string" && legacy.id.trim()
      ? legacy.id.trim()
      : filePath
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.json$/i, "") || "unknown";
  return `legacy-v1-${sourceId}`;
}

function getMigrationFileMarkerKey(
  source: "v1" | "v2",
  filePath: string,
): string {
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  return `${MIGRATION_FILE_KEY_PREFIX}:${source}:${fileName}`;
}

async function loadImportedMigrationFileKeys(
  source: "v1" | "v2",
): Promise<Set<string>> {
  const db = await getStorageDatabase().ensureInit();
  const prefix = `${MIGRATION_FILE_KEY_PREFIX}:${source}:`;
  const rows =
    (await db.queryAsync("SELECT key FROM settings WHERE key LIKE ?", [
      `${prefix}%`,
    ])) || [];
  return new Set(rows.map((row) => String(row.key)));
}

/**
 * Migrate V2 sessions (sessions/*.json) to SQLite
 */
async function migrateV2Sessions(): Promise<
  SessionMigrationResult & { hasExplicitActiveSessionId: boolean }
> {
  const sessionsPath = getDataPath("sessions");

  if (!(await IOUtils.exists(sessionsPath))) {
    return {
      count: 0,
      activeSessionId: null,
      preparationFailures: [],
      hasExplicitActiveSessionId: false,
    };
  }

  const children = await IOUtils.getChildren(sessionsPath);
  const sessionFiles = children.filter(
    (f) => f.endsWith(".json") && !f.endsWith("session-index.json"),
  );

  if (sessionFiles.length === 0) {
    return {
      count: 0,
      activeSessionId: null,
      preparationFailures: [],
      hasExplicitActiveSessionId: false,
    };
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

  let migratedCount = 0;
  let latestSession: { id: string; updatedAt: number } | null = null;
  const preparationFailures: string[] = [];
  const importedFileKeys = await loadImportedMigrationFileKeys("v2");
  migratedCount = sessionFiles.filter((filePath) =>
    importedFileKeys.has(getMigrationFileMarkerKey("v2", filePath)),
  ).length;
  for (
    let offset = 0;
    offset < sessionFiles.length;
    offset += SESSION_MIGRATION_BATCH_SIZE
  ) {
    const preparedBatch: PreparedImportedSession[] = [];
    const fileBatch = sessionFiles.slice(
      offset,
      offset + SESSION_MIGRATION_BATCH_SIZE,
    );

    for (const filePath of fileBatch) {
      const markerKey = getMigrationFileMarkerKey("v2", filePath);
      if (importedFileKeys.has(markerKey)) continue;
      try {
        const session = (await IOUtils.readJSON(filePath)) as ChatSession;
        if (!session.id) {
          throw new Error("Session id is missing");
        }
        preparedBatch.push(
          prepareImportedSession("v2", filePath, markerKey, session),
        );
      } catch (error) {
        const failure = `Failed to prepare migration file ${filePath}: ${getErrorMessage(error)}`;
        preparationFailures.push(failure);
        ztoolkit.log(`[Migration V3] ${failure}`);
      }
    }

    const outcomes = await insertSessionBatch(preparedBatch);
    for (const { prepared, status } of outcomes) {
      migratedCount += 1;
      importedFileKeys.add(prepared.markerKey);
      if (
        status === "inserted" &&
        (!latestSession || prepared.updatedAt > latestSession.updatedAt)
      ) {
        latestSession = {
          id: prepared.id,
          updatedAt: prepared.updatedAt,
        };
      }
    }
  }

  const finalActiveId = activeSessionId || latestSession?.id || null;
  await setActiveSessionId(finalActiveId);

  ztoolkit.log(`[Migration V3] V2 sessions migrated: ${migratedCount}`);
  return {
    count: migratedCount,
    activeSessionId: finalActiveId,
    preparationFailures,
    hasExplicitActiveSessionId: activeSessionId !== null,
  };
}

/**
 * Migrate V1 sessions (conversations/*.json) to SQLite
 */
async function migrateV1Sessions(
  preserveExistingActiveSessionId = false,
): Promise<SessionMigrationResult> {
  const legacyPath = getDataPath("conversations");

  if (!(await IOUtils.exists(legacyPath))) {
    return { count: 0, activeSessionId: null, preparationFailures: [] };
  }

  const children = await IOUtils.getChildren(legacyPath);
  const sessionFiles = children.filter(
    (f) => f.endsWith(".json") && !f.endsWith("_index.json"),
  );

  if (sessionFiles.length === 0) {
    return { count: 0, activeSessionId: null, preparationFailures: [] };
  }

  ztoolkit.log(
    `[Migration V3] Found ${sessionFiles.length} V1 legacy session files`,
  );

  let migratedCount = 0;
  let latestSession: { id: string; updatedAt: number } | null = null;
  const preparationFailures: string[] = [];
  const importedFileKeys = await loadImportedMigrationFileKeys("v1");
  migratedCount = sessionFiles.filter((filePath) =>
    importedFileKeys.has(getMigrationFileMarkerKey("v1", filePath)),
  ).length;
  for (
    let offset = 0;
    offset < sessionFiles.length;
    offset += SESSION_MIGRATION_BATCH_SIZE
  ) {
    const preparedBatch: PreparedImportedSession[] = [];
    const fileBatch = sessionFiles.slice(
      offset,
      offset + SESSION_MIGRATION_BATCH_SIZE,
    );

    for (const filePath of fileBatch) {
      const markerKey = getMigrationFileMarkerKey("v1", filePath);
      if (importedFileKeys.has(markerKey)) continue;
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
          id: getLegacySessionId(filePath, legacy),
          createdAt: legacy.createdAt || Date.now(),
          updatedAt: legacy.updatedAt || Date.now(),
          lastActiveItemKey: itemKey,
          messages: legacy.messages,
          contextSummary: legacy.contextSummary,
          contextState: legacy.contextState,
          executionPlan: legacy.executionPlan,
          toolExecutionState: legacy.toolExecutionState,
          toolApprovalState: legacy.toolApprovalState,
        };
        preparedBatch.push(
          prepareImportedSession("v1", filePath, markerKey, newSession),
        );
      } catch (error) {
        const failure = `Failed to prepare legacy migration file ${filePath}: ${getErrorMessage(error)}`;
        preparationFailures.push(failure);
        ztoolkit.log(`[Migration V3] ${failure}`);
      }
    }

    const outcomes = await insertSessionBatch(preparedBatch);
    for (const { prepared, status } of outcomes) {
      migratedCount += 1;
      importedFileKeys.add(prepared.markerKey);
      if (
        status === "inserted" &&
        (!latestSession || prepared.updatedAt > latestSession.updatedAt)
      ) {
        latestSession = {
          id: prepared.id,
          updatedAt: prepared.updatedAt,
        };
      }
    }
  }

  const finalActiveId = latestSession?.id || null;
  if (!preserveExistingActiveSessionId) {
    await setActiveSessionId(finalActiveId);
  }

  ztoolkit.log(`[Migration V3] V1 sessions migrated: ${migratedCount}`);
  return {
    count: migratedCount,
    activeSessionId: finalActiveId,
    preparationFailures,
  };
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
    ztoolkit.log(
      "[Migration V3] AI Summary progress migration error:",
      getErrorMessage(error),
    );
    throw error;
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
    ztoolkit.log(
      "[Migration V3] Failed to delete sessions/:",
      getErrorMessage(error),
    );
  }

  // Delete conversations/ directory
  const conversationsPath = getDataPath("conversations");
  try {
    if (await IOUtils.exists(conversationsPath)) {
      await IOUtils.remove(conversationsPath, { recursive: true });
      ztoolkit.log("[Migration V3] Deleted old conversations/ directory");
    }
  } catch (error) {
    ztoolkit.log(
      "[Migration V3] Failed to delete conversations/:",
      getErrorMessage(error),
    );
  }

  // Delete ai-summary/progress.json
  const progressPath = getDataPath("ai-summary", "progress.json");
  try {
    if (await IOUtils.exists(progressPath)) {
      await IOUtils.remove(progressPath);
      ztoolkit.log("[Migration V3] Deleted old ai-summary/progress.json");
    }
  } catch (error) {
    ztoolkit.log(
      "[Migration V3] Failed to delete progress.json:",
      getErrorMessage(error),
    );
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
    let preserveV2IndexedActiveSession = false;
    const preparationFailures: string[] = [];

    if (hasV2) {
      const result = await migrateV2Sessions();
      preserveV2IndexedActiveSession = result.hasExplicitActiveSessionId;
      preparationFailures.push(...result.preparationFailures);
      if (result.count > 0) {
        ztoolkit.log(`[Migration V3] V2 migration: ${result.count} sessions`);
        migrated = true;
      }
    }

    // V1 and V2 sources can coexist after an older partial conversion. Import
    // both independently so cleanup never deletes an unprocessed source tree.
    const conversationsPath = getDataPath("conversations");
    const hasV1 = await IOUtils.exists(conversationsPath);
    if (hasV1) {
      const result = await migrateV1Sessions(preserveV2IndexedActiveSession);
      preparationFailures.push(...result.preparationFailures);
      if (result.count > 0) {
        ztoolkit.log(`[Migration V3] V1 migration: ${result.count} sessions`);
        migrated = true;
      }
    }

    // Migrate AI Summary progress (independent of session migration)
    await migrateAISummaryProgress();

    // Successful files have already committed with their durable markers.
    // Keep the source trees and retry only the unmarked failures next startup.
    if (preparationFailures.length > 0) {
      throw new Error(
        `${preparationFailures.length} session migration file(s) could not be prepared: ${preparationFailures.join("; ")}`,
      );
    }

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
