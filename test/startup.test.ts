import { assert } from "chai";
import { config } from "../package.json";
import type { ChatSession } from "../src/types/chat";
import type { ToolCall } from "../src/types/tool";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });
});

describe("chat agent safeguards", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let originalAddon: unknown;
  let originalPathUtils: unknown;
  let originalIOUtils: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    originalAddon = (globalThis as any).addon;
    originalPathUtils = (globalThis as any).PathUtils;
    originalIOUtils = (globalThis as any).IOUtils;

    const prefStore = new Map<string, unknown>();
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
          return true;
        },
      },
      Libraries: {
        userLibraryID: 1,
      },
      Items: {
        getByLibraryAndKey: () => null,
        get: () => null,
        getAsync: async () => [],
        getAll: async () => [],
      },
      Collections: {
        getByLibraryAndKey: () => null,
        getByLibrary: () => [],
      },
      Tags: {
        getAll: async () => [],
      },
      Reader: {
        getByTabID: () => null,
      },
      Search: function () {
        return {
          addCondition: () => undefined,
          search: async () => [],
        };
      },
      DB: {
        executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      },
      Utilities: {
        extractIdentifiers: () => [],
      },
      Translate: {
        Search: function () {
          return {
            setIdentifier: () => undefined,
            getTranslators: async () => [],
            setTranslator: () => undefined,
            translate: async () => [],
          };
        },
      },
      getMainWindow: () => ({}),
      DataDirectory: {
        dir: "/tmp",
      },
    };
    (globalThis as any).ztoolkit = {
      log: () => undefined,
      Reader: {
        getReader: async () => null,
      },
    };
    (globalThis as any).addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: () => [{ value: "", attributes: [] }],
          },
        },
      },
    };
    (globalThis as any).PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
    };
    (globalThis as any).IOUtils = {
      makeDirectory: async () => undefined,
      exists: async () => false,
      stat: async () => ({ size: 0 }),
      read: async () => new Uint8Array(),
      readUTF8: async () => "",
      getChildren: async () => [],
      readJSON: async () => ({}),
    };
  });

  afterEach(function () {
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
    (globalThis as any).addon = originalAddon;
    (globalThis as any).PathUtils = originalPathUtils;
    (globalThis as any).IOUtils = originalIOUtils;
  });

  it("denies ask-mode tools immediately when no approval channel is available", async function () {
    const { ToolPermissionManager } = await import(
      "../src/modules/chat/tool-permissions/ToolPermissionManager"
    );
    const manager = new ToolPermissionManager();
    const decision = await manager.decide({
      toolCall: {
        id: "call-web",
        type: "function",
        function: {
          name: "web_search",
          arguments: JSON.stringify({ query: "latest llm news" }),
        },
      },
      args: { query: "latest llm news" },
      sessionId: "session-1",
      assistantMessageId: "assistant-1",
    });

    assert.equal(decision.verdict, "deny");
    assert.equal(decision.mode, "ask");
    assert.equal(decision.scope, "once");
    assert.include(decision.reason || "", "requires approval");
    assert.deepEqual(manager.listPendingApprovals(), []);
  });

  it("clears persisted plan and tool state when recovering interrupted messages", async function () {
    const { SessionStorageService } = await import(
      "../src/modules/chat/SessionStorageService"
    );
    const { getStorageDatabase } = await import(
      "../src/modules/chat/db/StorageDatabase"
    );
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const fakeDb = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT COUNT(*) as count")) {
          return [{ count: 1 }];
        }
        return [];
      },
    };

    const storageDatabase = getStorageDatabase() as any;
    const originalEnsureInit = storageDatabase.ensureInit;
    storageDatabase.ensureInit = async () => fakeDb;

    try {
      const service = new SessionStorageService();
      await (service as any).markInterruptedMessages("session-1");
    } finally {
      storageDatabase.ensureInit = originalEnsureInit;
    }

    assert.isTrue(
      queries.some((entry) =>
        entry.sql.includes("SET streaming_state = 'interrupted'"),
      ),
    );
    assert.isTrue(
      queries.some((entry) =>
        entry.sql.includes("SET execution_plan = NULL"),
      ),
    );
    assert.isTrue(
      queries.some((entry) => entry.sql.includes("UPDATE session_meta")),
    );
  });

  it("stops persisting tool state after a session run is invalidated", async function () {
    const {
      awaitWhileSessionTracked,
    } = await import(
      "../src/modules/chat/agent-runtime/sessionTracking"
    );
    const { SessionRunInvalidatedError } = await import(
      "../src/modules/chat/errors"
    );
    const session: ChatSession = {
      id: "session-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActiveItemKey: null,
      messages: [],
    };

    let tracked = true;
    let operationCalls = 0;

    try {
      await awaitWhileSessionTracked(
        session,
        () => tracked,
        async () => {
          operationCalls += 1;
          const toolCall: ToolCall = {
            id: "tool-1",
            type: "function",
            function: {
              name: "list_all_items",
              arguments: JSON.stringify({ page: 1 }),
            },
          };
          assert.equal(toolCall.function.name, "list_all_items");
          assert.equal(operationCalls, 1);
          assert.isTrue(tracked);
          tracked = false;
          return "tool-result";
        },
      );
      assert.fail("Expected invalidated session run to throw");
    } catch (error) {
      assert.instanceOf(error, SessionRunInvalidatedError);
      assert.equal(operationCalls, 1);
      assert.isFalse(tracked);
    }
  });
});
