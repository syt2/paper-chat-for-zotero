import { assert } from "chai";
import { destroyAuthManager } from "../src/modules/auth/index.ts";
import { ChatManager } from "../src/modules/chat/ChatManager.ts";
import {
  destroyContextManager,
  getContextManager,
} from "../src/modules/chat/ContextManager.ts";
import { SessionStorageService } from "../src/modules/chat/SessionStorageService.ts";
import {
  StorageDatabase,
  destroyStorageDatabase,
  getStorageDatabase,
} from "../src/modules/chat/db/StorageDatabase.ts";
import { destroyPdfToolManager } from "../src/modules/chat/pdf-tools/index.ts";
import {
  repairPaperChatSessionAfterHardFailureWithRollback,
  rerollPaperChatFailureAndReplay,
} from "../src/modules/chat/paperchat-retry-orchestration.ts";
import { PaperChatProvider } from "../src/modules/providers/PaperChatProvider.ts";
import {
  destroyProviderManager,
  getProviderManager,
} from "../src/modules/providers/ProviderManager.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat";

const PREFS_PREFIX = "extensions.zotero.paperchat";

type RecordedQuery = {
  sql: string;
  params?: unknown[];
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function createPrefEnvironment() {
  const prefStore = new Map<string, unknown>();

  (globalThis as any).ztoolkit = {
    log: () => undefined,
  };

  (globalThis as any).Services = {
    obs: {
      addObserver: () => undefined,
      removeObserver: () => undefined,
    },
    cookies: {
      remove: () => undefined,
      getCookiesFromHost: () => [],
    },
  };
  (globalThis as any).Ci = {
    nsIHttpChannel: Symbol("nsIHttpChannel"),
  };

  (globalThis as any).Zotero = {
    Prefs: {
      get: (key: string) => prefStore.get(key),
      set: (key: string, value: unknown) => {
        prefStore.set(key, value);
        return true;
      },
      clear: (key: string) => {
        prefStore.delete(key);
        return true;
      },
    },
    DataDirectory: {
      dir: "/tmp/zotero-test",
    },
  };

  return prefStore;
}

describe("paperchat storage and chat manager", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let originalServices: unknown;
  let originalCi: unknown;
  let prefStore: Map<string, unknown>;

  beforeEach(function () {
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    originalServices = (globalThis as any).Services;
    originalCi = (globalThis as any).Ci;
    prefStore = createPrefEnvironment();
    destroyStorageDatabase();
    destroyAuthManager();
    destroyContextManager();
    destroyPdfToolManager();
    destroyProviderManager();
  });

  afterEach(function () {
    destroyStorageDatabase();
    destroyAuthManager();
    destroyContextManager();
    destroyPdfToolManager();
    destroyProviderManager();
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
    (globalThis as any).Services = originalServices;
    (globalThis as any).Ci = originalCi;
  });

  it("backfills companion session state during schema v5 migration", async function () {
    const recorded: RecordedQuery[] = [];
    const fakeDb = {
      async queryAsync(sql: string, params?: unknown[]) {
        recorded.push({ sql: normalizeSql(sql), params });
        if (sql.includes("SELECT") && sql.includes("FROM sessions")) {
          return [
            {
              id: "session-1",
              selected_tier: "paperchat-pro",
              resolved_model_id: "model-next",
              last_retryable_user_message_id: "user-1",
              last_retryable_error_message_id: "error-1",
              last_retryable_failed_model_id: "model-prev",
            },
          ];
        }
        return [];
      },
    };

    await (new StorageDatabase() as any).upgradeToV5(fakeDb);

    const companionInsert = recorded.find((entry) =>
      entry.sql.startsWith("INSERT INTO paperchat_session_state"),
    );

    assert.exists(companionInsert);
    assert.deepEqual(companionInsert?.params, [
      "session-1",
      "paperchat-pro",
      "model-next",
      "user-1",
      "error-1",
      "model-prev",
    ]);
    assert.isTrue(
      recorded.some((entry) =>
        entry.sql.includes(
          "CREATE TABLE IF NOT EXISTS paperchat_session_state",
        ),
      ),
    );
    assert.isTrue(
      recorded.some(
        (entry) =>
          entry.sql ===
          "UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1",
      ),
    );
  });

  it("stores paperchat session metadata in the companion table on save", async function () {
    const recorded: RecordedQuery[] = [];
    const fakeDb = {
      async queryAsync(sql: string, params?: unknown[]) {
        const normalized = normalizeSql(sql);
        recorded.push({ sql: normalized, params });

        if (normalized === "SELECT value FROM settings WHERE key = ?") {
          return [];
        }
        if (normalized === "SELECT COUNT(*) as count FROM session_meta") {
          return [{ count: 1 }];
        }

        return [];
      },
    };

    const storage = getStorageDatabase() as any;
    storage.ensureInit = async () => fakeDb;

    const service = new SessionStorageService();
    const session: ChatSession = {
      id: "session-save-1",
      createdAt: 100,
      updatedAt: 100,
      lastActiveItemKey: "ITEM-1",
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "hello",
          timestamp: 101,
        },
      ],
      selectedTier: "paperchat-standard",
      resolvedModelId: "model-pro-2",
      lastRetryableUserMessageId: "user-1",
      lastRetryableErrorMessageId: "error-1",
      lastRetryableFailedModelId: "model-pro-1",
    };

    await service.saveSession(session);

    const sessionUpsert = recorded.find((entry) =>
      entry.sql.startsWith("INSERT INTO sessions"),
    );
    const companionUpsert = recorded.find((entry) =>
      entry.sql.startsWith("INSERT INTO paperchat_session_state"),
    );

    assert.exists(sessionUpsert);
    assert.exists(companionUpsert);
    assert.notInclude(sessionUpsert!.sql, "selected_tier");
    assert.notInclude(sessionUpsert!.sql, "resolved_model_id");
    assert.deepEqual(companionUpsert!.params, [
      "session-save-1",
      "paperchat-standard",
      "model-pro-2",
      "user-1",
      "error-1",
      "model-pro-1",
    ]);
  });

  it("loads a session via SELECT * and merges companion paperchat state", async function () {
    const recorded: RecordedQuery[] = [];
    const fakeDb = {
      async queryAsync(sql: string, params?: unknown[]) {
        const normalized = normalizeSql(sql);
        recorded.push({ sql: normalized, params });

        if (normalized === "SELECT value FROM settings WHERE key = ?") {
          return [];
        }
        if (normalized === "SELECT * FROM sessions WHERE id = ?") {
          return [
            {
              id: "session-load-1",
              created_at: 100,
              updated_at: 200,
              last_active_item_key: "ITEM-1",
              context_summary: null,
              context_state: null,
            },
          ];
        }
        if (
          normalized ===
          "SELECT * FROM paperchat_session_state WHERE session_id = ?"
        ) {
          return [
            {
              session_id: "session-load-1",
              selected_tier: "paperchat-pro",
              resolved_model_id: "model-pro-9",
              last_retryable_user_message_id: "user-1",
              last_retryable_error_message_id: "error-1",
              last_retryable_failed_model_id: "model-pro-8",
            },
          ];
        }
        if (
          normalized ===
          "SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC"
        ) {
          return [
            {
              id: "msg-1",
              role: "user",
              content: "hello",
              timestamp: 201,
            },
            {
              id: "msg-2",
              role: "assistant",
              content: "world",
              timestamp: 202,
            },
          ];
        }

        return [];
      },
    };

    const storage = getStorageDatabase() as any;
    storage.ensureInit = async () => fakeDb;

    const service = new SessionStorageService();
    const session = await service.loadSession("session-load-1");

    assert.exists(session);
    assert.equal(session?.id, "session-load-1");
    assert.equal(session?.lastActiveItemKey, "ITEM-1");
    assert.equal(session?.selectedTier, "paperchat-pro");
    assert.equal(session?.resolvedModelId, "model-pro-9");
    assert.equal(session?.lastRetryableUserMessageId, "user-1");
    assert.equal(session?.lastRetryableErrorMessageId, "error-1");
    assert.equal(session?.lastRetryableFailedModelId, "model-pro-8");
    assert.lengthOf(session?.messages || [], 2);
    assert.include(
      recorded.map((entry) => entry.sql),
      "SELECT * FROM sessions WHERE id = ?",
    );
    assert.include(
      recorded.map((entry) => entry.sql),
      "SELECT * FROM paperchat_session_state WHERE session_id = ?",
    );
  });

  it("excludes interrupted assistant messages from future context windows", function () {
    prefStore.set(`${PREFS_PREFIX}.contextMaxRecentPairs`, 10);
    prefStore.set(`${PREFS_PREFIX}.contextEnableSummary`, false);

    const contextManager = getContextManager();
    const session: ChatSession = {
      id: "session-context-1",
      createdAt: 1,
      updatedAt: 4,
      lastActiveItemKey: null,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Do one web search",
          timestamp: 1,
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "<tool-call>partial web search</tool-call>",
          timestamp: 2,
          streamingState: "interrupted",
        },
        {
          id: "system-notice-1",
          role: "system",
          content: "Previous run was interrupted.",
          timestamp: 3,
          isSystemNotice: true,
        },
        {
          id: "user-2",
          role: "user",
          content: "Do one web search again",
          timestamp: 4,
        },
      ],
    };

    const filtered = contextManager.filterMessages(session);

    assert.deepEqual(
      filtered.messages.map((message) => message.id),
      ["user-1", "system-notice-1", "user-2"],
    );
  });

  it("clears stale turn state when loading an interrupted assistant session", async function () {
    const recorded: RecordedQuery[] = [];
    const fakeDb = {
      async queryAsync(sql: string, params?: unknown[]) {
        const normalized = normalizeSql(sql);
        recorded.push({ sql: normalized, params });

        if (normalized === "SELECT value FROM settings WHERE key = ?") {
          return [];
        }
        if (
          normalized ===
          "SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND streaming_state = 'in_progress'"
        ) {
          return [{ count: 0 }];
        }
        if (normalized === "SELECT * FROM sessions WHERE id = ?") {
          return [
            {
              id: "session-load-2",
              created_at: 100,
              updated_at: 200,
              last_active_item_key: "ITEM-2",
              context_summary: null,
              context_state: null,
              execution_plan: JSON.stringify({
                id: "plan-1",
                summary: "stale plan",
                status: "failed",
                steps: [],
                createdAt: 100,
                updatedAt: 200,
              }),
              tool_execution_state: JSON.stringify({
                turnStartedAt: 150,
                updatedAt: 200,
                results: [
                  {
                    toolCall: {
                      id: "tool-1",
                      type: "function",
                      function: {
                        name: "web_search",
                        arguments: JSON.stringify({ query: "stale query" }),
                      },
                    },
                    args: { query: "stale query" },
                    status: "completed",
                    content: "stale result",
                  },
                ],
              }),
              tool_approval_state: JSON.stringify({
                pendingRequests: [],
                updatedAt: 200,
              }),
            },
          ];
        }
        if (
          normalized ===
          "SELECT * FROM paperchat_session_state WHERE session_id = ?"
        ) {
          return [];
        }
        if (
          normalized ===
          "SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC"
        ) {
          return [
            {
              id: "msg-1",
              role: "user",
              content: "hello",
              timestamp: 201,
            },
            {
              id: "msg-2",
              role: "assistant",
              content: "partial",
              timestamp: 202,
              streaming_state: "interrupted",
            },
          ];
        }

        return [];
      },
    };

    const storage = getStorageDatabase() as any;
    storage.ensureInit = async () => fakeDb;

    const service = new SessionStorageService();
    const session = await service.loadSession("session-load-2");

    assert.exists(session);
    assert.equal(session?.id, "session-load-2");
    assert.isUndefined(session?.executionPlan);
    assert.isUndefined(session?.toolExecutionState);
    assert.isUndefined(session?.toolApprovalState);
    assert.include(
      recorded.map((entry) => entry.sql),
      "UPDATE sessions SET execution_plan = NULL, tool_execution_state = NULL, tool_approval_state = NULL, updated_at = ? WHERE id = ?",
    );
    assert.include(
      recorded.map((entry) => entry.sql),
      "UPDATE session_meta SET updated_at = ? WHERE id = ?",
    );
  });

  it("prefers the tier-resolved provider model over a stale paperchat default", function () {
    prefStore.set(
      `${PREFS_PREFIX}.paperchatTierState`,
      JSON.stringify({
        selectedTier: "paperchat-pro",
        tiers: {
          "paperchat-lite": { mode: "auto", modelId: "m1" },
          "paperchat-standard": { mode: "auto", modelId: "m2" },
          "paperchat-pro": { mode: "auto", modelId: "m3" },
        },
      }),
    );
    prefStore.set(
      `${PREFS_PREFIX}.paperchatRatiosCache`,
      JSON.stringify({ m1: 1, m2: 2, m3: 3 }),
    );

    const provider = new PaperChatProvider({
      id: "paperchat",
      name: "PaperChat",
      type: "paperchat",
      enabled: true,
      isBuiltin: true,
      order: 0,
      defaultModel: "stale-model",
      availableModels: ["m1", "m2", "m3"],
    });

    const delegateConfig = (provider as any).createDelegateConfig();

    assert.equal(delegateConfig.defaultModel, "m3");
  });

  it("treats switching to the already selected tier as a no-op", async function () {
    prefStore.set(
      `${PREFS_PREFIX}.paperchatTierState`,
      JSON.stringify({
        selectedTier: "paperchat-standard",
        tiers: {
          "paperchat-lite": { mode: "auto", modelId: "m1" },
          "paperchat-standard": { mode: "auto", modelId: "m3" },
          "paperchat-pro": { mode: "auto", modelId: "m5" },
        },
      }),
    );

    const manager = Object.create(ChatManager.prototype) as ChatManager & {
      currentSession: ChatSession;
      sessionStorage: {
        updateSessionMeta: (session: ChatSession) => Promise<void>;
      };
      init: () => Promise<void>;
    };
    const session: ChatSession = {
      id: "session-same-tier",
      createdAt: 1,
      updatedAt: 100,
      lastActiveItemKey: null,
      messages: [],
      selectedTier: "paperchat-standard",
      resolvedModelId: "m4",
      lastRetryableUserMessageId: "user-1",
      lastRetryableErrorMessageId: "error-1",
      lastRetryableFailedModelId: "m3",
    };
    let updateCalls = 0;

    manager.currentSession = session;
    manager.sessionStorage = {
      updateSessionMeta: async () => {
        updateCalls += 1;
      },
    };
    manager.init = async () => undefined;

    await manager.switchCurrentSessionPaperChatTier("paperchat-standard");

    assert.equal(updateCalls, 0);
    assert.equal(session.selectedTier, "paperchat-standard");
    assert.equal(session.resolvedModelId, "m4");
    assert.equal(session.lastRetryableUserMessageId, "user-1");
    assert.equal(session.lastRetryableErrorMessageId, "error-1");
    assert.equal(session.lastRetryableFailedModelId, "m3");
    assert.equal(session.updatedAt, 100);
  });

  it("does not mutate session paper context when syncing the current reader item", function () {
    const manager = Object.create(ChatManager.prototype) as ChatManager & {
      currentSession: ChatSession;
      currentItemKey: string | null;
    };
    const session: ChatSession = {
      id: "session-reader-sync",
      createdAt: 1,
      updatedAt: 100,
      lastActiveItemKey: "SESSION-ITEM",
      messages: [],
    };

    manager.currentSession = session;
    manager.currentItemKey = null;

    manager.setCurrentItemKey("READER-ITEM");

    assert.equal(manager.getCurrentItemKey(), "READER-ITEM");
    assert.equal(session.lastActiveItemKey, "SESSION-ITEM");
  });

  it("wraps session metadata writes in a transaction", async function () {
    const recorded: RecordedQuery[] = [];
    const fakeDb = {
      async queryAsync(sql: string, params?: unknown[]) {
        const normalized = normalizeSql(sql);
        recorded.push({ sql: normalized, params });

        if (normalized === "SELECT value FROM settings WHERE key = ?") {
          return [];
        }

        return [];
      },
    };

    const storage = getStorageDatabase() as any;
    storage.ensureInit = async () => fakeDb;

    const service = new SessionStorageService();
    await service.updateSessionMeta({
      id: "session-meta-1",
      createdAt: 100,
      updatedAt: 100,
      lastActiveItemKey: "ITEM-1",
      messages: [],
      selectedTier: "paperchat-standard",
      resolvedModelId: "model-pro-2",
    });

    assert.deepEqual(
      recorded.map((entry) => entry.sql),
      [
        "SELECT value FROM settings WHERE key = ?",
        "BEGIN TRANSACTION",
        "UPDATE sessions SET updated_at = ?, last_active_item_key = ?, context_summary = ?, context_state = ?, execution_plan = ?, tool_execution_state = ?, tool_approval_state = ? WHERE id = ?",
        "INSERT INTO paperchat_session_state (session_id, selected_tier, resolved_model_id, last_retryable_user_message_id, last_retryable_error_message_id, last_retryable_failed_model_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET selected_tier = excluded.selected_tier, resolved_model_id = excluded.resolved_model_id, last_retryable_user_message_id = excluded.last_retryable_user_message_id, last_retryable_error_message_id = excluded.last_retryable_error_message_id, last_retryable_failed_model_id = excluded.last_retryable_failed_model_id",
        "UPDATE session_meta SET updated_at = ? WHERE id = ?",
        "COMMIT",
      ],
    );
  });

  it("rolls back session metadata writes when a companion-table write fails", async function () {
    const recorded: RecordedQuery[] = [];
    const fakeDb = {
      async queryAsync(sql: string, params?: unknown[]) {
        const normalized = normalizeSql(sql);
        recorded.push({ sql: normalized, params });

        if (normalized === "SELECT value FROM settings WHERE key = ?") {
          return [];
        }
        if (normalized.startsWith("INSERT INTO paperchat_session_state")) {
          throw new Error("paperchat state write failed");
        }

        return [];
      },
    };

    const storage = getStorageDatabase() as any;
    storage.ensureInit = async () => fakeDb;

    const service = new SessionStorageService();

    try {
      await service.updateSessionMeta({
        id: "session-meta-rollback",
        createdAt: 100,
        updatedAt: 100,
        lastActiveItemKey: "ITEM-1",
        messages: [],
        selectedTier: "paperchat-standard",
        resolvedModelId: "model-pro-2",
      });
      assert.fail("Expected updateSessionMeta to throw");
    } catch (error) {
      assert.instanceOf(error, Error);
      assert.equal((error as Error).message, "paperchat state write failed");
    }

    assert.include(
      recorded.map((entry) => entry.sql),
      "ROLLBACK",
    );
    assert.notInclude(
      recorded.map((entry) => entry.sql),
      "COMMIT",
    );
  });

  it("rolls back prefs, session state, and provider override when hard-failure repair persistence fails", async function () {
    const previousTierState = JSON.stringify({
      selectedTier: "paperchat-standard",
      tiers: {
        "paperchat-lite": { mode: "auto", modelId: "m1" },
        "paperchat-standard": { mode: "auto", modelId: "m3" },
        "paperchat-pro": { mode: "auto", modelId: "m5" },
      },
    });
    prefStore.set(`${PREFS_PREFIX}.paperchatTierState`, previousTierState);

    const session: ChatSession = {
      id: "session-rollback-1",
      createdAt: 1,
      updatedAt: 100,
      lastActiveItemKey: null,
      messages: [],
      selectedTier: "paperchat-standard",
      resolvedModelId: "m3",
    };
    const providerUpdates: Array<string | undefined> = [];

    try {
      await repairPaperChatSessionAfterHardFailureWithRollback({
        session,
        failedModelId: "m3",
        previousTierStateRaw: previousTierState,
        availableModels: ["m1", "m2", "m3", "m4", "m5", "m6"],
        ratios: {
          m1: 1,
          m2: 2,
          m3: 3,
          m4: 4,
          m5: 5,
          m6: 6,
        },
        persistSessionMeta: async () => {
          throw new Error("persist failed");
        },
        setTierStateRaw: (raw: string) => {
          prefStore.set(`${PREFS_PREFIX}.paperchatTierState`, raw);
        },
        updateProviderOverride: (modelId: string | undefined) => {
          providerUpdates.push(modelId);
        },
        pickRandom: (candidates) => candidates[0] ?? null,
      });
      assert.fail(
        "Expected repairPaperChatSessionAfterHardFailureWithRollback to throw",
      );
    } catch (error) {
      assert.instanceOf(error, Error);
      assert.equal((error as Error).message, "persist failed");
    }

    assert.equal(
      prefStore.get(`${PREFS_PREFIX}.paperchatTierState`),
      previousTierState,
    );
    assert.equal(session.selectedTier, "paperchat-standard");
    assert.equal(session.resolvedModelId, "m3");
    assert.equal(session.updatedAt, 100);
    assert.deepEqual(providerUpdates, ["m3"]);
  });

  it("returns null for stale reroll metadata without mutating the session", async function () {
    const rerollCalls: string[] = [];
    const deleteCalls: string[] = [];

    const session: ChatSession = {
      id: "session-reroll-stale",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "question",
          timestamp: 1,
        },
      ],
      lastRetryableUserMessageId: "user-1",
      lastRetryableErrorMessageId: "missing-error",
    };

    const result = await rerollPaperChatFailureAndReplay({
      session,
      rerollTier: async () => {
        rerollCalls.push("reroll");
        return {
          previousModel: "m3",
          nextModel: "m4",
          tier: "paperchat-standard",
        };
      },
      deleteMessage: async (_sessionId: string, messageId: string) => {
        deleteCalls.push(messageId);
      },
      buildSystemNotice: () => "rerouted notice",
      insertSystemNotice: async () => undefined,
      resend: async () => undefined,
      getItem: () => null,
    });

    assert.isNull(result);
    assert.deepEqual(rerollCalls, []);
    assert.deepEqual(deleteCalls, []);
    assert.lengthOf(session.messages, 1);
  });

  it("replays the original prompt after rerolling within the same tier", async function () {
    const deleted: Array<[string, string]> = [];
    const notices: string[] = [];
    const sentMessages: Array<{
      content: string;
      options: Record<string, unknown>;
    }> = [];
    const itemRef = { id: 42 };

    const userMessage: ChatMessage = {
      id: "user-1",
      role: "user",
      content: "retry this",
      images: [
        {
          type: "url",
          data: "https://example.com/a.png",
          mimeType: "image/png",
        },
      ],
      timestamp: 1,
    };
    const errorMessage: ChatMessage = {
      id: "error-1",
      role: "error",
      content: "model failed",
      timestamp: 2,
    };
    const session: ChatSession = {
      id: "session-reroll-1",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: "ITEM-1",
      messages: [
        {
          id: "system-1",
          role: "system",
          content: "existing",
          timestamp: 0,
          isSystemNotice: true,
        },
        userMessage,
        errorMessage,
      ],
      lastRetryableUserMessageId: "user-1",
      lastRetryableErrorMessageId: "error-1",
    };

    const result = await rerollPaperChatFailureAndReplay({
      session,
      rerollTier: async () => ({
        previousModel: "m3",
        nextModel: "m4",
        tier: "paperchat-standard",
      }),
      deleteMessage: async (sessionId: string, messageId: string) => {
        deleted.push([sessionId, messageId]);
      },
      buildSystemNotice: () => "rerouted notice",
      insertSystemNotice: async (
        targetSession: ChatSession,
        content: string,
      ) => {
        notices.push(content);
        targetSession.messages.push({
          id: "notice-1",
          role: "system",
          content,
          timestamp: 3,
          isSystemNotice: true,
        });
      },
      resend: async ({ content, images, item }) => {
        sentMessages.push({
          content,
          options: {
            item,
            images,
          },
        });
      },
      getItem: () => itemRef,
    });

    assert.deepEqual(result, {
      previousModel: "m3",
      nextModel: "m4",
      tier: "paperchat-standard",
    });
    assert.deepEqual(deleted, [
      ["session-reroll-1", "error-1"],
      ["session-reroll-1", "user-1"],
    ]);
    assert.deepEqual(notices, ["rerouted notice"]);
    assert.deepEqual(sentMessages, [
      {
        content: "retry this",
        options: {
          item: itemRef,
          images: userMessage.images,
        },
      },
    ]);
    assert.deepEqual(
      session.messages.map((message) => message.id),
      ["system-1", "notice-1"],
    );
  });

  it("preserves the paperchat binding when clearing the current session", async function () {
    const deletedSessionIds: string[] = [];
    const persistedSessions: ChatSession[] = [];
    const renderedMessages: ChatMessage[][] = [];
    const appliedContexts: Array<ChatSession | null> = [];

    const manager = Object.create(ChatManager.prototype) as ChatManager & {
      currentSession: ChatSession;
      activeSessionRunIds: Map<string, number>;
      sessionStorage: {
        deleteAllMessages: (sessionId: string) => Promise<void>;
        updateSessionMeta: (session: ChatSession) => Promise<void>;
      };
      streamingSessions: Map<string, ChatSession>;
      applySessionItemContext: (session: ChatSession | null) => void;
      onExecutionPlanUpdate?: (plan?: unknown) => void;
      onMessageUpdate?: (messages: ChatMessage[]) => void;
    };

    const session: ChatSession = {
      id: "session-clear-1",
      createdAt: 1,
      updatedAt: 100,
      lastActiveItemKey: "ITEM-1",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "hello",
          timestamp: 101,
        },
      ],
      contextSummary: "summary",
      contextState: {
        summaryMode: "full",
        lastSummaryIndex: 1,
        totalMessages: 1,
        needsSummary: false,
        isSummarizing: false,
      },
      executionPlan: {
        steps: [],
        status: "completed",
        createdAt: 100,
      },
      toolExecutionState: {
        toolCalls: [],
        updatedAt: 100,
      },
      toolApprovalState: {
        pendingRequests: [],
        updatedAt: 100,
      },
      memoryExtractedAt: 99,
      memoryExtractedMsgCount: 1,
      selectedTier: "paperchat-pro",
      resolvedModelId: "model-pro-9",
      lastRetryableUserMessageId: "user-1",
      lastRetryableErrorMessageId: "error-1",
      lastRetryableFailedModelId: "model-pro-8",
    };

    manager.currentSession = session;
    manager.sessionStorage = {
      deleteAllMessages: async (sessionId: string) => {
        deletedSessionIds.push(sessionId);
      },
      updateSessionMeta: async (persisted: ChatSession) => {
        persistedSessions.push(persisted);
      },
    };
    manager.activeSessionRunIds = new Map();
    manager.streamingSessions = new Map([[session.id, session]]);
    manager.applySessionItemContext = (appliedSession) => {
      appliedContexts.push(appliedSession);
    };
    manager.onExecutionPlanUpdate = () => undefined;
    manager.onMessageUpdate = (messages) => {
      renderedMessages.push(messages);
    };

    await manager.clearCurrentSession();

    const clearedSession = manager.currentSession;
    assert.notStrictEqual(clearedSession, session);
    assert.equal(clearedSession.id, "session-clear-1");
    assert.equal(clearedSession.selectedTier, "paperchat-pro");
    assert.equal(clearedSession.resolvedModelId, "model-pro-9");
    assert.isUndefined(clearedSession.lastRetryableUserMessageId);
    assert.isUndefined(clearedSession.lastRetryableErrorMessageId);
    assert.isUndefined(clearedSession.lastRetryableFailedModelId);
    assert.isUndefined(clearedSession.contextSummary);
    assert.isUndefined(clearedSession.contextState);
    assert.isUndefined(clearedSession.executionPlan);
    assert.isUndefined(clearedSession.toolExecutionState);
    assert.isUndefined(clearedSession.toolApprovalState);
    assert.equal(clearedSession.lastActiveItemKey, null);
    assert.deepEqual(clearedSession.messages, []);
    assert.deepEqual(deletedSessionIds, ["session-clear-1"]);
    assert.deepEqual(persistedSessions, [clearedSession]);
    assert.deepEqual(appliedContexts, [clearedSession]);
    assert.deepEqual(renderedMessages, [[]]);
    assert.isFalse(manager.streamingSessions.has("session-clear-1"));
  });

  it("cancels the current turn and marks the streaming assistant message as interrupted", async function () {
    const messageUpdates: Array<{
      sessionId: string;
      messageId: string;
      content: string;
      streamingState: string | null | undefined;
    }> = [];
    const persistedSessions: ChatSession[] = [];
    const renderedMessages: ChatMessage[][] = [];
    const renderedPlans: unknown[] = [];

    const manager = Object.create(ChatManager.prototype) as ChatManager & {
      currentSession: ChatSession;
      activeSessionRunIds: Map<string, number>;
      streamingSessions: Map<string, ChatSession>;
      sessionStorage: {
        updateMessageContent: (
          sessionId: string,
          messageId: string,
          content: string,
          reasoning?: string,
          options?: { streamingState?: string | null },
        ) => Promise<void>;
        updateSessionMeta: (session: ChatSession) => Promise<void>;
      };
      init: () => Promise<void>;
      isSessionActive: (session: ChatSession) => boolean;
      onExecutionPlanUpdate?: (plan?: unknown) => void;
      onMessageUpdate?: (messages: ChatMessage[]) => void;
    };

    const session: ChatSession = {
      id: "session-cancel-1",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: "ITEM-1",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "hello",
          timestamp: 1,
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "working",
          streamingState: "in_progress",
          timestamp: 2,
        },
      ],
      executionPlan: {
        id: "plan-1",
        summary: "Working",
        status: "in_progress",
        steps: [],
        createdAt: 1,
        updatedAt: 2,
      },
      toolExecutionState: {
        planId: "plan-1",
        turnStartedAt: 1,
        updatedAt: 2,
        results: [],
      },
      toolApprovalState: undefined,
    };

    manager.currentSession = session;
    manager.activeSessionRunIds = new Map([[session.id, 1]]);
    manager.streamingSessions = new Map([[session.id, session]]);
    manager.sessionStorage = {
      updateMessageContent: async (
        sessionId,
        messageId,
        content,
        _reasoning,
        options,
      ) => {
        messageUpdates.push({
          sessionId,
          messageId,
          content,
          streamingState: options?.streamingState,
        });
      },
      updateSessionMeta: async (persisted) => {
        persistedSessions.push(persisted);
      },
    };
    manager.init = async () => undefined;
    manager.isSessionActive = () => true;
    manager.onExecutionPlanUpdate = (plan) => {
      renderedPlans.push(plan);
    };
    manager.onMessageUpdate = (messages) => {
      renderedMessages.push(messages.map((message) => ({ ...message })));
    };

    const cancelled = await manager.cancelCurrentTurn();

    assert.isTrue(cancelled);
    assert.equal(session.messages[1].streamingState, "interrupted");
    assert.equal(session.messages[1].content, "working");
    assert.isUndefined(session.executionPlan);
    assert.isUndefined(session.toolExecutionState);
    assert.isUndefined(session.toolApprovalState);
    assert.isFalse(manager.activeSessionRunIds.has(session.id));
    assert.isFalse(manager.streamingSessions.has(session.id));
    assert.deepEqual(messageUpdates, [
      {
        sessionId: "session-cancel-1",
        messageId: "assistant-1",
        content: "working",
        streamingState: "interrupted",
      },
    ]);
    assert.deepEqual(persistedSessions, [session]);
    assert.deepEqual(renderedPlans, [undefined]);
    assert.lengthOf(renderedMessages, 1);
    assert.equal(renderedMessages[0][1].streamingState, "interrupted");
  });

  it("treats session invalidation after message persistence as an accepted send", async function () {
    const providerManager = getProviderManager() as any;
    const originalGetActiveProviderId = providerManager.getActiveProviderId;
    const originalExecuteWithFallback = providerManager.executeWithFallback;
    const contextManager = getContextManager() as any;
    const originalFilterMessages = contextManager.filterMessages;

    const insertedMessages: ChatMessage[] = [];
    const updatedSessions: ChatSession[] = [];
    const session: ChatSession = {
      id: "session-invalidated-1",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [],
    };

    const provider = {
      config: { id: "openai" },
      getName: () => "OpenAI",
      isReady: () => true,
    };

    providerManager.getActiveProviderId = () => "openai";
    providerManager.executeWithFallback = async (
      operation: (currentProvider: typeof provider) => Promise<unknown>,
    ) => operation(provider);
    contextManager.filterMessages = (targetSession: ChatSession) => ({
      messages: [...targetSession.messages],
      summaryTriggered: false,
    });

    try {
      const manager = Object.create(ChatManager.prototype) as ChatManager & {
        currentSession: ChatSession;
        activeSessionRunIds: Map<string, number>;
        sessionStorage: {
          insertMessage: (
            sessionId: string,
            message: ChatMessage,
          ) => Promise<void>;
          updateSessionMeta: (targetSession: ChatSession) => Promise<void>;
        };
        streamingSessions: Map<string, ChatSession>;
        currentItemKey: string | null;
        init: () => Promise<void>;
        getActiveProvider: () => typeof provider;
        isSessionTracked: (targetSession: ChatSession) => boolean;
      };

      manager.currentSession = session;
      manager.activeSessionRunIds = new Map();
      manager.sessionStorage = {
        insertMessage: async (_sessionId: string, message: ChatMessage) => {
          insertedMessages.push(message);
        },
        updateSessionMeta: async (targetSession: ChatSession) => {
          updatedSessions.push(targetSession);
        },
      };
      manager.streamingSessions = new Map();
      manager.currentItemKey = null;
      manager.init = async () => undefined;
      manager.getActiveProvider = () => provider as any;
      manager.isSessionTracked = () => false;

      const accepted = await manager.sendMessage("already sent");

      assert.isTrue(accepted);
      assert.lengthOf(insertedMessages, 2);
      assert.deepEqual(
        insertedMessages.map((message) => message.role),
        ["user", "assistant"],
      );
      assert.deepEqual(
        session.messages.map((message) => message.role),
        ["user", "assistant"],
      );
      assert.lengthOf(updatedSessions, 1);
    } finally {
      providerManager.getActiveProviderId = originalGetActiveProviderId;
      providerManager.executeWithFallback = originalExecuteWithFallback;
      contextManager.filterMessages = originalFilterMessages;
    }
  });
});
