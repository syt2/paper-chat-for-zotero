import { assert } from "chai";
import type { ChatSession } from "../src/types/chat";
import { getStorageDatabase } from "../src/modules/chat/db/StorageDatabase";
import { checkAndMigrateToV3 } from "../src/modules/chat/migration/migrateToSQLite";

interface RecordedQuery {
  sql: string;
  params?: unknown[];
}

describe("JSON to SQLite search migration", function () {
  const globals = globalThis as typeof globalThis & {
    IOUtils?: unknown;
    PathUtils?: unknown;
    Zotero?: unknown;
    ztoolkit?: unknown;
  };

  let originalIOUtils: unknown;
  let originalPathUtils: unknown;
  let originalZotero: unknown;
  let originalZtoolkit: unknown;

  beforeEach(function () {
    originalIOUtils = globals.IOUtils;
    originalPathUtils = globals.PathUtils;
    originalZotero = globals.Zotero;
    originalZtoolkit = globals.ztoolkit;
  });

  afterEach(function () {
    globals.IOUtils = originalIOUtils;
    globals.PathUtils = originalPathUtils;
    globals.Zotero = originalZotero;
    globals.ztoolkit = originalZtoolkit;
  });

  it("imports canonical search columns without holding file IO in a transaction", async function () {
    const session: ChatSession = {
      id: "session-1",
      createdAt: 10,
      updatedAt: 20,
      lastActiveItemKey: null,
      title: "Ｔitle  Café",
      titleSource: "generated",
      titleGeneratedAt: 15,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "[Context] hidden\n[Question]:   Why  NOW? ",
          selectedText: "  NFKC ﬃ  ",
          timestamp: 11,
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Visible **Answer**",
          reasoning: "hidden chain",
          timestamp: 12,
        },
        {
          id: "api-only-1",
          role: "assistant",
          content: "hidden transport context",
          apiOnly: true,
          timestamp: 13,
        },
      ],
    };
    const queries: RecordedQuery[] = [];
    const fakeDb = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith("SELECT value FROM settings")) return [];
        return [];
      },
    };

    let transactionCount = 0;
    let transactionActive = false;
    const storage = getStorageDatabase() as any;
    const originalEnsureInit = storage.ensureInit;
    const originalExecuteTransaction = storage.executeTransaction;
    storage.ensureInit = async () => fakeDb;
    storage.executeTransaction = async (
      operation: (db: typeof fakeDb) => Promise<unknown>,
    ) => {
      transactionCount += 1;
      transactionActive = true;
      try {
        return await operation(fakeDb);
      } finally {
        transactionActive = false;
      }
    };

    globals.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
    };
    globals.Zotero = {
      DataDirectory: { dir: "/tmp" },
      Items: { getAsync: async () => null },
    };
    globals.ztoolkit = { log: () => undefined };
    globals.IOUtils = {
      exists: async (path: string) =>
        path === "/tmp/paper-chat/sessions" ||
        path.endsWith("/session-index.json"),
      getChildren: async () => [
        "/tmp/paper-chat/sessions/session-1.json",
        "/tmp/paper-chat/sessions/session-index.json",
      ],
      readJSON: async (path: string) => {
        assert.isFalse(
          transactionActive,
          "file IO must finish before reserving the DB scheduler",
        );
        return path.endsWith("/session-index.json")
          ? { activeSessionId: "session-1" }
          : session;
      },
      readUTF8: async () => "",
      remove: async () => undefined,
    };

    try {
      await checkAndMigrateToV3();
    } finally {
      storage.ensureInit = originalEnsureInit;
      storage.executeTransaction = originalExecuteTransaction;
    }

    assert.equal(transactionCount, 2, "one import plus active-session write");
    assert.isFalse(
      queries.some((query) =>
        /^(BEGIN|COMMIT|ROLLBACK)/i.test(query.sql.trim()),
      ),
      "the migration must leave transaction ownership to StorageDatabase",
    );

    const sessionQuery = queries.find((query) =>
      query.sql.startsWith("INSERT INTO sessions"),
    );
    assert.include(sessionQuery?.sql || "", "ON CONFLICT(id) DO UPDATE SET");
    assert.notInclude(sessionQuery?.sql || "", "INSERT OR REPLACE");
    assert.include(sessionQuery?.sql || "", "execution_plan");

    const companionQuery = queries.find((query) =>
      query.sql.startsWith("INSERT INTO paperchat_session_state"),
    );
    assert.include(
      companionQuery?.sql || "",
      "ON CONFLICT(session_id) DO NOTHING",
    );

    const messageQueries = queries.filter((query) =>
      query.sql.includes("INSERT INTO messages"),
    );
    const messageReset = queries.find((query) =>
      query.sql.startsWith("DELETE FROM messages WHERE session_id"),
    );
    assert.deepEqual(messageReset?.params, ["session-1"]);
    assert.equal(messageQueries.length, 3);
    assert.equal(messageQueries[0].params?.[18], "nfkc ffi\u001fwhy now?");
    assert.equal(messageQueries[0].params?.[19], 1);
    assert.equal(messageQueries[1].params?.[18], "visible answer");
    assert.equal(messageQueries[1].params?.[19], 1);
    assert.equal(messageQueries[2].params?.[18], "");
    assert.equal(messageQueries[2].params?.[19], 1);

    const metaQuery = queries.find((query) =>
      query.sql.includes("INSERT OR REPLACE INTO session_meta"),
    );
    assert.equal(metaQuery?.params?.[3], 2);
    assert.equal(metaQuery?.params?.[4], "Visible **Answer**");
    assert.equal(metaQuery?.params?.[5], 12);
    assert.equal(metaQuery?.params?.[10], "title café");
    assert.equal(metaQuery?.params?.[11], 1);

    const stateInsert = queries.find((query) =>
      query.sql.includes("INSERT OR IGNORE INTO chat_search_state"),
    );
    const stateUpdate = queries.find((query) =>
      query.sql.includes("UPDATE chat_search_state"),
    );
    assert.equal(stateInsert?.params?.[0], 1);
    assert.include(stateUpdate?.sql || "", "search_revision + 1");
    assert.notMatch(
      stateUpdate?.sql || "",
      /SET[\s\S]*target_version\s*=/i,
      "publishing an import must not overwrite a newer target version",
    );
  });

  it("reads and projects session files in fixed batches", async function () {
    const sessionFiles = Array.from(
      { length: 26 },
      (_, index) => `/tmp/paper-chat/sessions/session-${index + 1}.json`,
    );
    let sessionReads = 0;
    const readsAtTransactionStart: number[] = [];
    const fakeDb = {
      queryAsync: async (sql: string) => {
        if (sql.startsWith("SELECT value FROM settings")) return [];
        return [];
      },
    };

    const storage = getStorageDatabase() as any;
    const originalEnsureInit = storage.ensureInit;
    const originalExecuteTransaction = storage.executeTransaction;
    storage.ensureInit = async () => fakeDb;
    storage.executeTransaction = async (
      operation: (db: typeof fakeDb) => Promise<unknown>,
    ) => {
      readsAtTransactionStart.push(sessionReads);
      return operation(fakeDb);
    };

    globals.PathUtils = { join: (...parts: string[]) => parts.join("/") };
    globals.Zotero = {
      DataDirectory: { dir: "/tmp" },
      Items: { getAsync: async () => null },
    };
    globals.ztoolkit = { log: () => undefined };
    globals.IOUtils = {
      exists: async (path: string) => path === "/tmp/paper-chat/sessions",
      getChildren: async () => sessionFiles,
      readJSON: async (path: string) => {
        sessionReads += 1;
        const id = path.match(/session-(\d+)\.json$/)?.[1] || "unknown";
        return {
          id: `session-${id}`,
          createdAt: Number(id),
          updatedAt: Number(id),
          lastActiveItemKey: null,
          messages: [
            {
              id: `message-${id}`,
              role: "user",
              content: `message ${id}`,
              timestamp: Number(id),
            },
          ],
        } satisfies ChatSession;
      },
      readUTF8: async () => "",
      remove: async () => undefined,
    };

    try {
      await checkAndMigrateToV3();
    } finally {
      storage.ensureInit = originalEnsureInit;
      storage.executeTransaction = originalExecuteTransaction;
    }

    assert.deepEqual(
      readsAtTransactionStart,
      [25, 26, 26],
      "25 sessions are projected, committed, and released before reading the next batch; the final transaction only stores the active id",
    );
  });

  it("uses stable V1 session ids and marks imported source files", async function () {
    const insertedSessionIds: string[] = [];
    const settings = new Map<string, unknown>();
    const fakeDb = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("SELECT value FROM settings")) {
          const value = settings.get(String(params?.[0]));
          return value === undefined ? [] : [{ value }];
        }
        if (sql.startsWith("SELECT key FROM settings")) {
          const prefix = String(params?.[0] || "").replace(/%$/, "");
          return [...settings.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ key }));
        }
        if (sql.startsWith("INSERT INTO sessions")) {
          insertedSessionIds.push(String(params?.[0]));
        } else if (
          sql.startsWith("INSERT OR REPLACE INTO settings") &&
          params
        ) {
          settings.set(String(params[0]), params[1]);
        }
        return [];
      },
    };

    const storage = getStorageDatabase() as any;
    const originalEnsureInit = storage.ensureInit;
    const originalExecuteTransaction = storage.executeTransaction;
    storage.ensureInit = async () => fakeDb;
    storage.executeTransaction = async (
      operation: (db: typeof fakeDb) => Promise<unknown>,
    ) => operation(fakeDb);

    globals.PathUtils = { join: (...parts: string[]) => parts.join("/") };
    globals.Zotero = {
      DataDirectory: { dir: "/tmp" },
      Items: { getAsync: async () => ({ key: "ITEMKEY" }) },
    };
    globals.ztoolkit = { log: () => undefined };
    globals.IOUtils = {
      exists: async (path: string) => path === "/tmp/paper-chat/conversations",
      getChildren: async () => [
        "/tmp/paper-chat/conversations/conversation-7.json",
      ],
      readJSON: async () => ({
        id: "conversation-7",
        itemId: 7,
        messages: [
          {
            id: "legacy-message-7",
            role: "user",
            content: "legacy",
            timestamp: 7,
          },
        ],
        pdfAttached: false,
        createdAt: 7,
        updatedAt: 8,
      }),
      readUTF8: async () => "",
      remove: async () => undefined,
    };

    try {
      await checkAndMigrateToV3();
      await checkAndMigrateToV3();
    } finally {
      storage.ensureInit = originalEnsureInit;
      storage.executeTransaction = originalExecuteTransaction;
    }

    assert.deepEqual(insertedSessionIds, ["legacy-v1-conversation-7"]);
    assert.isTrue(settings.has("migration_v3_file:v1:conversation-7.json"));
  });

  it("deduplicates historical V1 files already converted to V2", async function () {
    const settings = new Map<string, unknown>();
    const insertedSessionIds: string[] = [];
    const messageOwners = new Map<string, string>();
    const removed: string[] = [];
    const fakeDb = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("SELECT value FROM settings")) {
          const value = settings.get(String(params?.[0]));
          return value === undefined ? [] : [{ value }];
        }
        if (sql.startsWith("SELECT key FROM settings")) return [];
        if (sql.startsWith("SELECT id, session_id FROM messages")) {
          return (params || [])
            .map((id) => String(id))
            .filter((id) => messageOwners.has(id))
            .map((id) => ({ id, session_id: messageOwners.get(id) }));
        }
        if (sql.startsWith("INSERT INTO sessions")) {
          insertedSessionIds.push(String(params?.[0]));
        } else if (sql.startsWith("DELETE FROM messages WHERE session_id")) {
          const sessionId = String(params?.[0]);
          for (const [messageId, owner] of messageOwners) {
            if (owner === sessionId) messageOwners.delete(messageId);
          }
        } else if (sql.includes("INSERT INTO messages")) {
          const messageId = String(params?.[0]);
          if (messageOwners.has(messageId)) {
            throw new Error(`duplicate message ${messageId}`);
          }
          messageOwners.set(messageId, String(params?.[1]));
        } else if (
          sql.startsWith("INSERT OR REPLACE INTO settings") &&
          params
        ) {
          settings.set(String(params[0]), params[1]);
        }
        return [];
      },
    };
    const storage = getStorageDatabase() as any;
    const originalEnsureInit = storage.ensureInit;
    const originalExecuteTransaction = storage.executeTransaction;
    storage.ensureInit = async () => fakeDb;
    storage.executeTransaction = async (
      operation: (db: typeof fakeDb) => Promise<unknown>,
    ) => operation(fakeDb);

    globals.PathUtils = { join: (...parts: string[]) => parts.join("/") };
    globals.Zotero = {
      DataDirectory: { dir: "/tmp" },
      Items: { getAsync: async () => null },
    };
    globals.ztoolkit = { log: () => undefined };
    globals.IOUtils = {
      exists: async (path: string) =>
        path === "/tmp/paper-chat/sessions" ||
        path === "/tmp/paper-chat/conversations" ||
        path.endsWith("/session-index.json"),
      getChildren: async (path: string) =>
        path.endsWith("/sessions")
          ? [
              "/tmp/paper-chat/sessions/v2.json",
              "/tmp/paper-chat/sessions/session-index.json",
            ]
          : [
              "/tmp/paper-chat/conversations/v1-covered.json",
              "/tmp/paper-chat/conversations/v1-only.json",
            ],
      readJSON: async (path: string) =>
        path.endsWith("/session-index.json")
          ? { activeSessionId: "v2-session" }
          : path.endsWith("/v2.json")
            ? ({
                id: "v2-session",
                createdAt: 1,
                updatedAt: 2,
                lastActiveItemKey: null,
                messages: [
                  {
                    id: "shared-message",
                    role: "user",
                    content: "legacy converted to V2",
                    timestamp: 1,
                  },
                ],
              } satisfies ChatSession)
            : path.endsWith("/v1-covered.json")
              ? {
                  id: "v1-covered",
                  itemId: 0,
                  messages: [
                    {
                      id: "shared-message",
                      role: "user",
                      content: "legacy converted to V2",
                      timestamp: 1,
                    },
                    {
                      id: "stale-v1-only-message",
                      role: "assistant",
                      content: "deleted from the newer V2 session",
                      timestamp: 2,
                    },
                  ],
                  pdfAttached: false,
                  createdAt: 1,
                  updatedAt: 100,
                }
              : {
                  id: "v1-only",
                  itemId: 0,
                  messages: [
                    {
                      id: "v1-only-message",
                      role: "user",
                      content: "legacy only",
                      timestamp: 3,
                    },
                  ],
                  pdfAttached: false,
                  createdAt: 3,
                  updatedAt: 101,
                },
      readUTF8: async () => "",
      remove: async (path: string) => {
        removed.push(path);
      },
    };

    try {
      await checkAndMigrateToV3();
      await checkAndMigrateToV3();
    } finally {
      storage.ensureInit = originalEnsureInit;
      storage.executeTransaction = originalExecuteTransaction;
    }

    assert.deepEqual(insertedSessionIds, ["v2-session", "legacy-v1-v1-only"]);
    assert.equal(messageOwners.get("shared-message"), "v2-session");
    assert.isFalse(messageOwners.has("stale-v1-only-message"));
    assert.equal(messageOwners.get("v1-only-message"), "legacy-v1-v1-only");
    assert.isFalse(insertedSessionIds.includes("legacy-v1-v1-covered"));
    assert.isTrue(settings.has("migration_v3_file:v1:v1-covered.json"));
    assert.isTrue(settings.has("migration_v3_file:v1:v1-only.json"));
    assert.isTrue(settings.has("migration_v3_completed"));
    assert.includeMembers(removed, [
      "/tmp/paper-chat/sessions",
      "/tmp/paper-chat/conversations",
    ]);
    assert.equal(
      settings.get("active_session_id"),
      "v2-session",
      "an explicit V2 index choice must win over a newer V1 conversation",
    );
  });

  it("marks partially overlapping V1 files covered without rolling back clean files", async function () {
    const settings = new Map<string, unknown>();
    const sessions = new Set<string>();
    const messageOwners = new Map<string, string>();
    const removed: string[] = [];
    const fakeDb = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("SELECT value FROM settings")) {
          const value = settings.get(String(params?.[0]));
          return value === undefined ? [] : [{ value }];
        }
        if (sql.startsWith("SELECT key FROM settings")) {
          const prefix = String(params?.[0] || "").replace(/%$/, "");
          return [...settings.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ key }));
        }
        if (sql.startsWith("SELECT id, session_id FROM messages")) {
          return (params || [])
            .map((id) => String(id))
            .filter((id) => messageOwners.has(id))
            .map((id) => ({ id, session_id: messageOwners.get(id) }));
        }
        if (sql.startsWith("INSERT INTO sessions")) {
          sessions.add(String(params?.[0]));
        } else if (sql.startsWith("DELETE FROM messages WHERE session_id")) {
          const sessionId = String(params?.[0]);
          for (const [messageId, owner] of messageOwners) {
            if (owner === sessionId) messageOwners.delete(messageId);
          }
        } else if (sql.includes("INSERT INTO messages")) {
          const messageId = String(params?.[0]);
          if (messageOwners.has(messageId)) {
            throw new Error(`duplicate message ${messageId}`);
          }
          messageOwners.set(messageId, String(params?.[1]));
        } else if (
          sql.startsWith("INSERT OR REPLACE INTO settings") &&
          params
        ) {
          settings.set(String(params[0]), params[1]);
        }
        return [];
      },
    };
    const storage = getStorageDatabase() as any;
    const originalEnsureInit = storage.ensureInit;
    const originalExecuteTransaction = storage.executeTransaction;
    storage.ensureInit = async () => fakeDb;
    storage.executeTransaction = async (
      operation: (db: typeof fakeDb) => Promise<unknown>,
    ) => operation(fakeDb);

    globals.PathUtils = { join: (...parts: string[]) => parts.join("/") };
    globals.Zotero = {
      DataDirectory: { dir: "/tmp" },
      Items: { getAsync: async () => null },
    };
    globals.ztoolkit = { log: () => undefined };
    globals.IOUtils = {
      exists: async (path: string) =>
        path === "/tmp/paper-chat/sessions" ||
        path === "/tmp/paper-chat/conversations" ||
        path.endsWith("/session-index.json"),
      getChildren: async (path: string) =>
        path.endsWith("/sessions")
          ? [
              "/tmp/paper-chat/sessions/v2.json",
              "/tmp/paper-chat/sessions/session-index.json",
            ]
          : [
              "/tmp/paper-chat/conversations/v1-partial.json",
              "/tmp/paper-chat/conversations/v1-clean.json",
            ],
      readJSON: async (path: string) => {
        if (path.endsWith("/session-index.json")) {
          return { activeSessionId: "v2-session" };
        }
        if (path.endsWith("/v2.json")) {
          return {
            id: "v2-session",
            createdAt: 1,
            updatedAt: 2,
            lastActiveItemKey: null,
            messages: [
              {
                id: "shared-message",
                role: "user",
                content: "converted",
                timestamp: 1,
              },
            ],
          } satisfies ChatSession;
        }
        if (path.endsWith("/v1-partial.json")) {
          return {
            id: "v1-partial",
            itemId: 0,
            messages: [
              {
                id: "shared-message",
                role: "user",
                content: "converted",
                timestamp: 1,
              },
              {
                id: "partial-only-message",
                role: "assistant",
                content: "not present in V2",
                timestamp: 2,
              },
            ],
            pdfAttached: false,
            createdAt: 1,
            updatedAt: 5,
          };
        }
        return {
          id: "v1-clean",
          itemId: 0,
          messages: [
            {
              id: "clean-message",
              role: "user",
              content: "clean legacy",
              timestamp: 3,
            },
          ],
          pdfAttached: false,
          createdAt: 3,
          updatedAt: 3,
        };
      },
      readUTF8: async () => "",
      remove: async (path: string) => {
        removed.push(path);
      },
    };

    try {
      await checkAndMigrateToV3();

      assert.deepEqual([...sessions].sort(), [
        "legacy-v1-v1-clean",
        "v2-session",
      ]);
      assert.equal(messageOwners.get("shared-message"), "v2-session");
      assert.equal(messageOwners.get("clean-message"), "legacy-v1-v1-clean");
      assert.isTrue(settings.has("migration_v3_file:v1:v1-partial.json"));
      assert.isTrue(settings.has("migration_v3_file:v1:v1-clean.json"));
      assert.isTrue(settings.has("migration_v3_completed"));
      assert.includeMembers(removed, [
        "/tmp/paper-chat/sessions",
        "/tmp/paper-chat/conversations",
      ]);
      assert.isFalse(messageOwners.has("partial-only-message"));

      await checkAndMigrateToV3();
    } finally {
      storage.ensureInit = originalEnsureInit;
      storage.executeTransaction = originalExecuteTransaction;
    }

    assert.isFalse(sessions.has("legacy-v1-v1-partial"));
    assert.isTrue(settings.has("migration_v3_file:v1:v1-partial.json"));
    assert.isTrue(settings.has("migration_v3_completed"));
    assert.deepEqual(
      removed.sort(),
      ["/tmp/paper-chat/sessions", "/tmp/paper-chat/conversations"].sort(),
    );
  });

  it("commits valid V2 and V1 files while leaving malformed files retryable", async function () {
    const v2Files = Array.from(
      { length: 26 },
      (_, index) => `/tmp/paper-chat/sessions/v2-${index + 1}.json`,
    );
    const v1Files = Array.from(
      { length: 26 },
      (_, index) => `/tmp/paper-chat/conversations/v1-${index + 1}.json`,
    );
    const settings = new Map<string, unknown>();
    const insertedSessionIds: string[] = [];
    const removed: string[] = [];
    const logs: string[] = [];
    let sourcesFixed = false;

    const fakeDb = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("SELECT value FROM settings")) {
          const value = settings.get(String(params?.[0]));
          return value === undefined ? [] : [{ value }];
        }
        if (sql.startsWith("SELECT key FROM settings")) {
          const prefix = String(params?.[0] || "").replace(/%$/, "");
          return [...settings.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ key }));
        }
        if (sql.startsWith("INSERT INTO sessions")) {
          insertedSessionIds.push(String(params?.[0]));
        } else if (
          sql.startsWith("INSERT OR REPLACE INTO settings") &&
          params
        ) {
          settings.set(String(params[0]), params[1]);
        }
        return [];
      },
    };

    const storage = getStorageDatabase() as any;
    const originalEnsureInit = storage.ensureInit;
    const originalExecuteTransaction = storage.executeTransaction;
    storage.ensureInit = async () => fakeDb;
    storage.executeTransaction = async (
      operation: (db: typeof fakeDb) => Promise<unknown>,
    ) => operation(fakeDb);

    globals.PathUtils = { join: (...parts: string[]) => parts.join("/") };
    globals.Zotero = {
      DataDirectory: { dir: "/tmp" },
      Items: { getAsync: async () => null },
    };
    globals.ztoolkit = {
      log: (...parts: unknown[]) => logs.push(parts.map(String).join(" ")),
    };
    globals.IOUtils = {
      exists: async (path: string) =>
        path === "/tmp/paper-chat/sessions" ||
        path === "/tmp/paper-chat/conversations" ||
        path.endsWith("/session-index.json"),
      getChildren: async (path: string) =>
        path.endsWith("/sessions")
          ? [...v2Files, "/tmp/paper-chat/sessions/session-index.json"]
          : v1Files,
      readJSON: async (path: string) => {
        if (path.endsWith("/session-index.json")) {
          return { activeSessionId: "v2-2" };
        }

        const v2Number = Number(path.match(/\/v2-(\d+)\.json$/)?.[1]);
        if (v2Number) {
          if (v2Number === 1 && !sourcesFixed) {
            return { createdAt: 1, updatedAt: 1, messages: [] };
          }
          return {
            id: `v2-${v2Number}`,
            createdAt: v2Number,
            updatedAt: v2Number,
            lastActiveItemKey: null,
            messages: [],
          } satisfies ChatSession;
        }

        const v1Number = Number(path.match(/\/v1-(\d+)\.json$/)?.[1]);
        if (v1Number === 1 && !sourcesFixed) {
          throw new Error("invalid legacy JSON");
        }
        return {
          id: `v1-${v1Number}`,
          itemId: 0,
          messages: [
            {
              id: `v1-message-${v1Number}`,
              role: "user",
              content: `legacy ${v1Number}`,
              timestamp: v1Number,
            },
          ],
          pdfAttached: false,
          createdAt: v1Number,
          updatedAt: v1Number,
        };
      },
      readUTF8: async () => "",
      remove: async (path: string) => {
        removed.push(path);
      },
    };

    try {
      await checkAndMigrateToV3();

      assert.equal(insertedSessionIds.length, 50);
      assert.include(insertedSessionIds, "v2-26");
      assert.include(insertedSessionIds, "legacy-v1-v1-26");
      assert.notInclude(insertedSessionIds, "v2-1");
      assert.notInclude(insertedSessionIds, "legacy-v1-v1-1");
      assert.isFalse(settings.has("migration_v3_file:v2:v2-1.json"));
      assert.isFalse(settings.has("migration_v3_file:v1:v1-1.json"));
      assert.isFalse(settings.has("migration_v3_completed"));
      assert.deepEqual(removed, []);
      assert.isTrue(
        logs.some(
          (entry) =>
            entry.includes("v2-1.json") &&
            entry.includes("Session id is missing"),
        ),
      );
      assert.isTrue(
        logs.some(
          (entry) =>
            entry.includes("v1-1.json") &&
            entry.includes("invalid legacy JSON"),
        ),
      );

      sourcesFixed = true;
      await checkAndMigrateToV3();
    } finally {
      storage.ensureInit = originalEnsureInit;
      storage.executeTransaction = originalExecuteTransaction;
    }

    assert.equal(insertedSessionIds.length, 52);
    assert.equal(new Set(insertedSessionIds).size, 52);
    assert.isTrue(settings.has("migration_v3_file:v2:v2-1.json"));
    assert.isTrue(settings.has("migration_v3_file:v1:v1-1.json"));
    assert.isTrue(settings.has("migration_v3_completed"));
    assert.includeMembers(removed, [
      "/tmp/paper-chat/sessions",
      "/tmp/paper-chat/conversations",
    ]);
  });

  it("does not complete or clean up when AI summary progress import fails", async function () {
    const settings = new Map<string, unknown>();
    const removed: string[] = [];
    const fakeDb = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("SELECT value FROM settings")) {
          const value = settings.get(String(params?.[0]));
          return value === undefined ? [] : [{ value }];
        }
        if (sql.startsWith("INSERT OR REPLACE INTO settings") && params) {
          settings.set(String(params[0]), params[1]);
        }
        return [];
      },
    };
    const storage = getStorageDatabase() as any;
    const originalEnsureInit = storage.ensureInit;
    storage.ensureInit = async () => fakeDb;

    globals.PathUtils = { join: (...parts: string[]) => parts.join("/") };
    globals.Zotero = { DataDirectory: { dir: "/tmp" } };
    globals.ztoolkit = { log: () => undefined };
    globals.IOUtils = {
      exists: async (path: string) =>
        path === "/tmp/paper-chat/ai-summary/progress.json",
      getChildren: async () => [],
      readJSON: async () => ({}),
      readUTF8: async () => "{invalid",
      remove: async (path: string) => {
        removed.push(path);
      },
    };

    try {
      await checkAndMigrateToV3();
    } finally {
      storage.ensureInit = originalEnsureInit;
    }

    assert.isFalse(settings.has("migration_v3_completed"));
    assert.deepEqual(removed, []);
  });

  it("keeps committed batches retryable when a later batch fails", async function () {
    const sessions = Object.fromEntries(
      Array.from({ length: 26 }, (_, index) => {
        const number = index + 1;
        return [
          `/tmp/paper-chat/sessions/session-${number}.json`,
          {
            id: `session-${number}`,
            createdAt: number,
            updatedAt: number,
            lastActiveItemKey: null,
            messages: [
              {
                id: `message-${number}`,
                role: "user",
                content: `message ${number}`,
                timestamp: number,
              },
            ],
          } satisfies ChatSession,
        ];
      }),
    );
    type FakeState = {
      sessions: Set<string>;
      messages: Map<string, string[]>;
      settings: Map<string, unknown>;
      companionState: Set<string>;
    };
    let state: FakeState = {
      sessions: new Set(),
      messages: new Map(),
      settings: new Map(),
      companionState: new Set(),
    };
    let shouldFailLastMessage = true;
    let failedTransactions = 0;
    const removed: string[] = [];
    const fakeDb = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("SELECT value FROM settings")) {
          const value = state.settings.get(String(params?.[0]));
          return value === undefined ? [] : [{ value }];
        }
        if (sql.startsWith("SELECT key FROM settings")) {
          const prefix = String(params?.[0] || "").replace(/%$/, "");
          return [...state.settings.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ key }));
        }
        if (sql.startsWith("INSERT INTO sessions")) {
          state.sessions.add(String(params?.[0]));
        } else if (sql.startsWith("DELETE FROM messages WHERE session_id")) {
          state.messages.set(String(params?.[0]), []);
        } else if (sql.includes("INSERT INTO messages")) {
          const messageId = String(params?.[0]);
          const sessionId = String(params?.[1]);
          if (shouldFailLastMessage && messageId === "message-26") {
            throw new Error("injected message failure");
          }
          const duplicate = [...state.messages.values()].some((ids) =>
            ids.includes(messageId),
          );
          if (duplicate) throw new Error(`duplicate message ${messageId}`);
          state.messages.get(sessionId)?.push(messageId);
        } else if (
          sql.startsWith("INSERT OR REPLACE INTO settings") &&
          params
        ) {
          state.settings.set(String(params[0]), params[1]);
        }
        return [];
      },
    };

    const storage = getStorageDatabase() as any;
    const originalEnsureInit = storage.ensureInit;
    const originalExecuteTransaction = storage.executeTransaction;
    storage.ensureInit = async () => fakeDb;
    storage.executeTransaction = async (
      operation: (db: typeof fakeDb) => Promise<unknown>,
    ) => {
      const snapshot: FakeState = {
        sessions: new Set(state.sessions),
        messages: new Map(
          [...state.messages].map(([id, messages]) => [id, [...messages]]),
        ),
        settings: new Map(state.settings),
        companionState: new Set(state.companionState),
      };
      try {
        return await operation(fakeDb);
      } catch (error) {
        state = snapshot;
        failedTransactions += 1;
        throw error;
      }
    };

    globals.PathUtils = { join: (...parts: string[]) => parts.join("/") };
    globals.Zotero = {
      DataDirectory: { dir: "/tmp" },
      Items: { getAsync: async () => null },
    };
    globals.ztoolkit = { log: () => undefined };
    globals.IOUtils = {
      exists: async (path: string) =>
        path === "/tmp/paper-chat/sessions" ||
        path.endsWith("/session-index.json"),
      getChildren: async () => [
        ...Object.keys(sessions),
        "/tmp/paper-chat/sessions/session-index.json",
      ],
      readJSON: async (path: string) =>
        path.endsWith("/session-index.json")
          ? { activeSessionId: "session-1" }
          : sessions[path],
      readUTF8: async () => "",
      remove: async (path: string) => {
        removed.push(path);
      },
    };

    try {
      await checkAndMigrateToV3();

      assert.equal(failedTransactions, 1);
      assert.equal(state.sessions.size, 25, "the first batch stays committed");
      assert.isFalse(state.sessions.has("session-26"));
      assert.isFalse(state.settings.has("migration_v3_completed"));
      assert.deepEqual(removed, []);

      // Simulate user state and a message edit after the first committed batch.
      // The stale source snapshot must not overwrite either on retry.
      state.companionState.add("session-1");
      state.messages.set("session-1", ["user-edited-message"]);
      sessions["/tmp/paper-chat/sessions/session-1.json"].messages = [];
      shouldFailLastMessage = false;
      await checkAndMigrateToV3();
    } finally {
      storage.ensureInit = originalEnsureInit;
      storage.executeTransaction = originalExecuteTransaction;
    }

    assert.equal(state.sessions.size, 26);
    assert.deepEqual(state.messages.get("session-1"), ["user-edited-message"]);
    assert.deepEqual(state.messages.get("session-26"), ["message-26"]);
    assert.isTrue(
      state.companionState.has("session-1"),
      "session upsert must not cascade-delete companion state",
    );
    assert.isTrue(state.settings.has("migration_v3_completed"));
    assert.deepEqual(removed, ["/tmp/paper-chat/sessions"]);
  });
});
