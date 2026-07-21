import { assert } from "chai";
import type { ToolCall } from "../src/types/tool";

describe("tool scheduler execution hooks", function () {
  let originalZotero: unknown;
  let originalPathUtils: unknown;
  let originalIOUtils: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as any).Zotero;
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
      DataDirectory: {
        dir: "/tmp/zotero",
      },
    };
  });

  afterEach(async function () {
    const { getToolPermissionManager } =
      await import("../src/modules/chat/tool-permissions/index.ts");
    const { resetSessionArtifactStoreForTests } =
      await import("../src/modules/chat/session-artifacts/index.ts");
    getToolPermissionManager().setDescriptorModeOverride("create_note", null);
    resetSessionArtifactStoreForTests();
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).PathUtils = originalPathUtils;
    (globalThis as any).IOUtils = originalIOUtils;
  });

  it("fires execution-ready hooks only for calls that will actually execute", async function () {
    const { getToolPermissionManager } =
      await import("../src/modules/chat/tool-permissions/index.ts");
    const { ToolScheduler } =
      await import("../src/modules/chat/tool-scheduler/ToolScheduler.ts");

    getToolPermissionManager().setDescriptorModeOverride("create_note", "deny");

    const lifecycle: string[] = [];
    const scheduler = new ToolScheduler(async (toolCall) => {
      lifecycle.push(`execute:${toolCall.function.name}`);
      return "ok";
    });

    const requests: Array<{ toolCall: ToolCall; sessionId: string }> = [
      {
        toolCall: {
          id: "tool-denied",
          type: "function",
          function: {
            name: "create_note",
            arguments: JSON.stringify({ content: "hello" }),
          },
        },
        sessionId: "session-1",
      },
      {
        toolCall: {
          id: "tool-allowed",
          type: "function",
          function: {
            name: "get_item_metadata",
            arguments: JSON.stringify({ itemKey: "ITEM-1" }),
          },
        },
        sessionId: "session-1",
      },
    ];

    const results = await scheduler.executeBatch(requests, {
      onExecutionReady: (request) => {
        lifecycle.push(`ready:${request.toolCall.function.name}`);
      },
    });

    assert.deepEqual(lifecycle, [
      "ready:get_item_metadata",
      "execute:get_item_metadata",
    ]);
    assert.deepEqual(
      results.map(
        (result) => `${result.toolCall.function.name}:${result.status}`,
      ),
      ["create_note:denied", "get_item_metadata:completed"],
    );
  });

  it("passes the request-scoped item key to the tool executor", async function () {
    const { ToolScheduler } =
      await import("../src/modules/chat/tool-scheduler/ToolScheduler.ts");
    let receivedItemKey: string | null | undefined;
    const scheduler = new ToolScheduler(
      async (_toolCall, _fallback, _args, currentItemKey) => {
        receivedItemKey = currentItemKey;
        return "ok";
      },
    );

    await scheduler.execute({
      toolCall: {
        id: "tool-item-context",
        type: "function",
        function: {
          name: "get_item_metadata",
          arguments: JSON.stringify({ itemKey: "EXPLICIT-ITEM" }),
        },
      },
      sessionId: "session-item-context",
      currentItemKey: "SESSION-PAPER-A",
    });

    assert.equal(receivedItemKey, "SESSION-PAPER-A");
  });

  it("stores large completed tool results as session artifacts and reads them back", async function () {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    (globalThis as any).PathUtils = {
      join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
    };
    (globalThis as any).IOUtils = {
      exists: async (path: string) => files.has(path) || dirs.has(path),
      makeDirectory: async (path: string) => {
        dirs.add(path);
      },
      writeUTF8: async (path: string, content: string) => {
        files.set(path, content);
      },
      readUTF8: async (path: string) => {
        if (!files.has(path)) {
          throw new Error(`missing file: ${path}`);
        }
        return files.get(path) || "";
      },
    };

    const { ToolScheduler } =
      await import("../src/modules/chat/tool-scheduler/ToolScheduler.ts");
    const largeContent = "x".repeat(12_500);
    const scheduler = new ToolScheduler(async () => largeContent);

    const result = await scheduler.execute({
      toolCall: {
        id: "tool-large",
        type: "function",
        function: {
          name: "search_paper_content",
          arguments: JSON.stringify({ query: "method" }),
        },
      },
      sessionId: "session-1",
      assistantMessageId: "assistant-1",
    });

    assert.equal(result.status, "completed");
    assert.isDefined(result.artifact);
    assert.include(result.content, "Tool result saved as session artifact");
    assert.include(result.content, "read_artifact");

    const readResult = await scheduler.execute({
      toolCall: {
        id: "tool-read-artifact",
        type: "function",
        function: {
          name: "read_artifact",
          arguments: JSON.stringify({
            artifactId: result.artifact!.id,
            offset: 10,
            maxCharacters: 20,
          }),
        },
      },
      sessionId: "session-1",
      assistantMessageId: "assistant-1",
    });

    assert.equal(readResult.status, "completed");
    assert.include(readResult.content, `Artifact id: ${result.artifact!.id}`);
    assert.include(readResult.content, "Returned range: 10-30");
    assert.include(readResult.content, "xxxxxxxxxxxxxxxxxxxx");
  });

  it("captures source references before artifact compaction", async function () {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    (globalThis as any).PathUtils = {
      join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
    };
    (globalThis as any).IOUtils = {
      exists: async (path: string) => files.has(path) || dirs.has(path),
      makeDirectory: async (path: string) => {
        dirs.add(path);
      },
      writeUTF8: async (path: string, content: string) => {
        files.set(path, content);
      },
      readUTF8: async (path: string) => files.get(path) || "",
    };

    const { ToolScheduler } =
      await import("../src/modules/chat/tool-scheduler/ToolScheduler.ts");
    const {
      createPassageEvidenceManifestEntry,
      formatPassageEvidenceManifest,
    } = await import("../src/modules/chat/evidence/index.ts");
    const evidenceQuote = "evidence";
    const evidenceManifest = formatPassageEvidenceManifest([
      createPassageEvidenceManifestEntry({
        resultIndex: 1,
        quote: evidenceQuote,
        page: 7,
      }),
    ]).trimEnd();
    const rawContent = [
      "Source item key: ITEM0001",
      'Source references: {"version":1,"pages":[7]}',
      evidenceManifest,
      "Found 1 semantically relevant passage:",
      "[Result 1] (Score: 98.0% Page 7)",
      evidenceQuote,
      "x".repeat(12_500),
    ].join("\n");
    const scheduler = new ToolScheduler(async () => rawContent);

    const result = await scheduler.execute({
      toolCall: {
        id: "tool-large-source",
        type: "function",
        function: {
          name: "search_paper_content",
          arguments: JSON.stringify({
            itemKey: "FAKE0001",
            query: "method",
          }),
        },
      },
      sessionId: "session-source",
      assistantMessageId: "assistant-source",
    });

    assert.isDefined(result.artifact);
    assert.notEqual(result.content, rawContent);
    assert.deepEqual(result.references, [
      { type: "item", key: "ITEM0001" },
      { type: "page", itemKey: "ITEM0001", page: 7 },
    ]);
    assert.lengthOf(result.evidence || [], 1);
    assert.equal(result.evidence?.[0]?.quote, evidenceQuote);
    assert.equal(result.evidence?.[0]?.itemKey, "ITEM0001");
  });

  it("keeps successful tool results when artifact persistence fails", async function () {
    (globalThis as any).PathUtils = {
      join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
    };
    (globalThis as any).IOUtils = {
      exists: async () => false,
      makeDirectory: async () => undefined,
      writeUTF8: async () => {
        throw new Error("disk full");
      },
      readUTF8: async () => "",
    };

    const { ToolScheduler } =
      await import("../src/modules/chat/tool-scheduler/ToolScheduler.ts");
    const largeContent = "x".repeat(12_500);
    const scheduler = new ToolScheduler(async () => largeContent);

    const result = await scheduler.execute({
      toolCall: {
        id: "tool-large",
        type: "function",
        function: {
          name: "search_paper_content",
          arguments: JSON.stringify({ query: "method" }),
        },
      },
      sessionId: "session-1",
      assistantMessageId: "assistant-1",
    });

    assert.equal(result.status, "completed");
    assert.isUndefined(result.artifact);
    assert.equal(result.content, largeContent);
  });
});
