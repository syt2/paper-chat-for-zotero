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

  it("auto-allows risky tools when no explicit ask policy is configured", async function () {
    const { ToolPermissionManager } =
      await import("../src/modules/chat/tool-permissions/ToolPermissionManager");
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

    assert.equal(decision.verdict, "allow");
    assert.equal(decision.mode, "auto_allow");
    assert.equal(decision.scope, "once");
    assert.include(decision.reason || "", "auto-allowed");
    assert.deepEqual(manager.listPendingApprovals(), []);
  });

  it("uses auto-allow by default for network, write, memory, and high-cost tools", async function () {
    const { ToolPermissionManager } =
      await import("../src/modules/chat/tool-permissions/ToolPermissionManager");
    const manager = new ToolPermissionManager();

    assert.equal(manager.getDescriptor("list_all_items")?.mode, "auto_allow");
    assert.equal(manager.getDescriptor("web_search")?.mode, "auto_allow");
    assert.equal(manager.getDescriptor("create_note")?.mode, "auto_allow");
    assert.equal(manager.getDescriptor("save_memory")?.mode, "auto_allow");
    assert.equal(manager.getDescriptor("get_full_text")?.mode, "auto_allow");
  });

  it("loads configurable default risk modes from prefs", async function () {
    Zotero.Prefs.set(
      "extensions.zotero.paperchat.toolPermissionDefaultModes",
      JSON.stringify({
        network: "deny",
        write: "auto_allow",
        memory: "deny",
        high_cost: "ask",
      }),
      true,
    );

    const { ToolPermissionManager } =
      await import("../src/modules/chat/tool-permissions/ToolPermissionManager");
    const manager = new ToolPermissionManager();

    assert.equal(manager.getDescriptor("web_search")?.mode, "deny");
    assert.equal(manager.getDescriptor("create_note")?.mode, "auto_allow");
    assert.equal(manager.getDescriptor("save_memory")?.mode, "deny");
    assert.equal(manager.getDescriptor("get_full_text")?.mode, "ask");
    assert.equal(manager.getDescriptor("list_all_items")?.mode, "auto_allow");
  });

  it("ignores malformed default risk mode entries in prefs", async function () {
    Zotero.Prefs.set(
      "extensions.zotero.paperchat.toolPermissionDefaultModes",
      JSON.stringify({
        network: "blocked",
        write: "deny",
        strange: "ask",
      }),
      true,
    );

    const { ToolPermissionManager } =
      await import("../src/modules/chat/tool-permissions/ToolPermissionManager");
    const manager = new ToolPermissionManager();

    assert.equal(manager.getDescriptor("web_search")?.mode, "auto_allow");
    assert.equal(manager.getDescriptor("create_note")?.mode, "deny");
    assert.equal(manager.getDescriptor("save_memory")?.mode, "auto_allow");
  });

  it("denies ask-mode write tools when no approval channel is available", async function () {
    Zotero.Prefs.set(
      "extensions.zotero.paperchat.toolPermissionDefaultModes",
      JSON.stringify({
        write: "ask",
      }),
      true,
    );

    const { ToolPermissionManager } =
      await import("../src/modules/chat/tool-permissions/ToolPermissionManager");
    const manager = new ToolPermissionManager();
    const decision = await manager.decide({
      toolCall: {
        id: "call-note",
        type: "function",
        function: {
          name: "create_note",
          arguments: JSON.stringify({ itemKey: "ITEM-1", content: "summary" }),
        },
      },
      args: { itemKey: "ITEM-1", content: "summary" },
      sessionId: "session-1",
      assistantMessageId: "assistant-1",
    });

    assert.equal(decision.verdict, "deny");
    assert.equal(decision.mode, "ask");
    assert.equal(decision.scope, "once");
    assert.equal(decision.descriptor.riskLevel, "write");
    assert.include(decision.reason || "", "requires approval");
    assert.deepEqual(manager.listPendingApprovals(), []);
  });

  it("does not let a deny-once decision poison the next approval", async function () {
    Zotero.Prefs.set(
      "extensions.zotero.paperchat.toolPermissionDefaultModes",
      JSON.stringify({
        write: "ask",
      }),
      true,
    );

    const { ToolPermissionManager } =
      await import("../src/modules/chat/tool-permissions/ToolPermissionManager");
    const manager = new ToolPermissionManager();
    manager.setApprovalHandler(async () => undefined);

    const firstDecisionPromise = manager.decide({
      toolCall: {
        id: "call-note-1",
        type: "function",
        function: {
          name: "create_note",
          arguments: JSON.stringify({ itemKey: "ITEM-1", content: "first" }),
        },
      },
      args: { itemKey: "ITEM-1", content: "first" },
      sessionId: "session-1",
      assistantMessageId: "assistant-1",
    });
    const firstPending = manager.listPendingApprovals()[0];
    assert.isDefined(firstPending);
    manager.resolveApprovalRequest(firstPending.id, {
      verdict: "deny",
      scope: "once",
    });
    const firstDecision = await firstDecisionPromise;
    assert.equal(firstDecision.verdict, "deny");

    const secondDecisionPromise = manager.decide({
      toolCall: {
        id: "call-note-2",
        type: "function",
        function: {
          name: "create_note",
          arguments: JSON.stringify({ itemKey: "ITEM-1", content: "second" }),
        },
      },
      args: { itemKey: "ITEM-1", content: "second" },
      sessionId: "session-1",
      assistantMessageId: "assistant-1",
    });
    const secondPending = manager.listPendingApprovals()[0];
    assert.isDefined(secondPending);
    manager.resolveApprovalRequest(secondPending.id, {
      verdict: "allow",
      scope: "once",
    });
    const secondDecision = await secondDecisionPromise;
    assert.equal(secondDecision.verdict, "allow");
    assert.equal(secondDecision.scope, "once");
  });

  it("allows get_full_text without a confirm flag", async function () {
    const { PdfToolManager } =
      await import("../src/modules/chat/pdf-tools/PdfToolManager");
    const manager = new PdfToolManager();

    const result = await manager.executeToolCall(
      {
        id: "tool-fulltext",
        type: "function",
        function: {
          name: "get_full_text",
          arguments: JSON.stringify({
            itemKey: "ITEM-1",
          }),
        },
      },
      {
        metadata: {},
        sections: [],
        fullText: "Hello full text",
        pages: [],
        pageCount: 1,
      } as any,
    );

    assert.include(result, "Hello full text");
    assert.notInclude(result, "Invalid arguments for get_full_text");
  });

  it("keeps PDF tools available without an active paper when itemKey can be provided", async function () {
    const { PdfToolManager } =
      await import("../src/modules/chat/pdf-tools/PdfToolManager");
    const manager = new PdfToolManager();

    const toolNames = manager
      .getToolDefinitions(false)
      .map((tool) => tool.function.name);

    assert.include(toolNames, "get_full_text");
    assert.include(toolNames, "get_paper_section");
    assert.include(toolNames, "search_paper_content");
  });

  it("clears persisted plan and tool state when recovering interrupted messages", async function () {
    const { SessionStorageService } =
      await import("../src/modules/chat/SessionStorageService");
    const { getStorageDatabase } =
      await import("../src/modules/chat/db/StorageDatabase");
    // Track transaction state so a regression that drops BEGIN/COMMIT
    // wrapping will surface as a failed assertion rather than silently pass.
    const queries: Array<{
      sql: string;
      params?: unknown[];
      inTransaction: boolean;
    }> = [];
    let transactionDepth = 0;
    let committedTransactions = 0;
    const fakeDb = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed === "BEGIN TRANSACTION" || trimmed === "BEGIN") {
          transactionDepth += 1;
          return [];
        }
        if (trimmed === "COMMIT") {
          if (transactionDepth === 0) {
            throw new Error("COMMIT without matching BEGIN");
          }
          transactionDepth -= 1;
          committedTransactions += 1;
          return [];
        }
        if (trimmed === "ROLLBACK") {
          if (transactionDepth > 0) {
            transactionDepth -= 1;
          }
          return [];
        }
        queries.push({
          sql,
          params,
          inTransaction: transactionDepth > 0,
        });
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

    const findQuery = (needle: string) =>
      queries.find((entry) => entry.sql.includes(needle));
    const interruptQ = findQuery("SET streaming_state = 'interrupted'");
    const planQ = findQuery("SET execution_plan = NULL");
    const sessionMetaQ = findQuery("UPDATE session_meta");

    assert.isDefined(interruptQ);
    assert.isDefined(planQ);
    assert.isDefined(sessionMetaQ);

    // The three writes must all run inside the same transaction, and the
    // transaction must commit cleanly.
    assert.isTrue(
      interruptQ!.inTransaction,
      "messages update must be transactional",
    );
    assert.isTrue(
      planQ!.inTransaction,
      "sessions update must be transactional",
    );
    assert.isTrue(
      sessionMetaQ!.inTransaction,
      "session_meta update must be transactional",
    );
    assert.equal(committedTransactions, 1);
    assert.equal(transactionDepth, 0);
  });

  it("stops persisting tool state after a session run is invalidated", async function () {
    const { awaitWhileSessionTracked } =
      await import("../src/modules/chat/agent-runtime/sessionTracking");
    const { SessionRunInvalidatedError } =
      await import("../src/modules/chat/errors");
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
