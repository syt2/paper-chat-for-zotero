import { assert } from "chai";
import { ProviderMemoryExtractor } from "../src/modules/chat/memory/MemoryExtractor";
import {
  parseMemoryExtractionResponse,
} from "../src/modules/chat/memory/MemoryExtractionParser";
import {
  buildMemoryExtractionConversationText,
  buildMemoryExtractionPrompt,
} from "../src/modules/chat/memory/MemoryExtractionPrompt";
import { MemoryService } from "../src/modules/chat/memory/MemoryService";
import { MemorySearchService } from "../src/modules/chat/memory/MemorySearchService";
import { MemoryStore } from "../src/modules/chat/memory/MemoryStore";
import { MemoryOrchestrator } from "../src/modules/chat/memory/MemoryOrchestrator";
import { MemoryManager } from "../src/modules/chat/memory/MemoryManager";
import type { ChatMessage, ChatSession } from "../src/types/chat";
import type { Memory } from "../src/modules/chat/memory/MemoryTypes";

describe("memory module", function () {
  beforeEach(function () {
    (globalThis as any).ztoolkit = {
      log: () => undefined,
    };
  });

  it("deduplicates memories with matching embeddings", async function () {
    const repository = {
      listEmbeddedRows: async () => [
        { embedding: JSON.stringify([1, 0, 0]) },
      ],
      listTextRows: async () => [],
      listRecent: async () => [],
      updateAccessStats: async () => undefined,
    };

    const service = new MemorySearchService(repository as any);
    const duplicated = await service.isDuplicate("ignored", [1, 0, 0]);

    assert.isTrue(duplicated);
  });

  it("falls back to text deduplication when no embedding is available", async function () {
    const repository = {
      listEmbeddedRows: async () => [],
      listTextRows: async () => [
        {
          text: "The user prefers concise answers with bullet points.",
        },
      ],
      listRecent: async () => [],
      updateAccessStats: async () => undefined,
    };

    const service = new MemorySearchService(repository as any);
    const duplicated = await service.isDuplicate(
      "The user prefers concise answers with bullet points.",
    );

    assert.isTrue(duplicated);
  });

  it("ranks the most relevant memory first and updates access stats", async function () {
    const memories: Memory[] = [
      {
        id: "m1",
        libraryId: 1,
        text: "The user prefers concise answers with bullet points.",
        category: "preference",
        importance: 0.8,
        createdAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
      },
      {
        id: "m2",
        libraryId: 1,
        text: "The user is working on Zotero plugin development.",
        category: "fact",
        importance: 0.6,
        createdAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
      },
      {
        id: "m3",
        libraryId: 1,
        text: "The user asked for detailed travel recommendations.",
        category: "fact",
        importance: 0.4,
        createdAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
      },
    ];

    const touchedIds: string[] = [];
    const repository = {
      listEmbeddedRows: async () => [],
      listTextRows: async () => [],
      listRecent: async () => memories,
      updateAccessStats: async (ids: string[]) => {
        touchedIds.push(...ids);
      },
    };

    const service = new MemorySearchService(repository as any);
    (service as any).createEmbedding = async () => ({});

    const results = await service.search("concise answers");

    assert.isAtLeast(results.length, 1);
    assert.equal(results[0].id, "m1");
    assert.deepEqual(touchedIds, results.map((memory) => memory.id));
  });

  it("builds prompt context from searched memories", async function () {
    const memoryService = new MemoryService({
      save: async () => ({ saved: true }),
      search: async () => [
        {
          id: "m1",
          libraryId: 1,
          text: "The user prefers concise answers with bullet points.",
          category: "preference",
          importance: 0.8,
          createdAt: Date.now(),
          accessCount: 0,
          lastAccessedAt: Date.now(),
        },
      ],
      delete: async () => undefined,
      listAll: async () => [],
    } as any);

    const promptContext = await memoryService.buildPromptContext(
      "concise answers",
    );

    assert.include(promptContext ?? "", "[preference]");
    assert.include(
      promptContext ?? "",
      "The user prefers concise answers with bullet points.",
    );
  });

  it("builds extraction conversation text from the latest conversational turns", function () {
    const messages: ChatMessage[] = [
      {
        id: "sys",
        role: "system",
        content: "ignore this",
        timestamp: 1,
      },
      {
        id: "u1",
        role: "user",
        content: "first question",
        timestamp: 2,
      },
      {
        id: "a1",
        role: "assistant",
        content: "first answer",
        timestamp: 3,
      },
      {
        id: "u2",
        role: "user",
        content: "second question",
        timestamp: 4,
      },
    ];

    const conversationText = buildMemoryExtractionConversationText(messages, 64);
    const prompt = buildMemoryExtractionPrompt(conversationText);

    assert.notInclude(conversationText, "ignore this");
    assert.include(conversationText, "USER: second question");
    assert.include(prompt, "Conversation:");
    assert.include(prompt, conversationText);
  });

  it("parses and normalizes extracted memory entries", function () {
    const result = parseMemoryExtractionResponse(
      'prefix [{"text":"  concise answers  ","category":"invalid","importance":9},{"text":"project uses Zotero","category":"fact","importance":0.3},{"text":"   "}] suffix',
    );

    assert.isTrue(result.ok);
    if (!result.ok) {
      throw new Error("expected parse to succeed");
    }

    assert.deepEqual(result.entries, [
      {
        text: "concise answers",
        category: "other",
        importance: 1,
      },
      {
        text: "project uses Zotero",
        category: "fact",
        importance: 0.3,
      },
    ]);
  });

  it("reports when no json array is present in extraction output", function () {
    const result = parseMemoryExtractionResponse("nothing structured here");

    assert.isFalse(result.ok);
    if (result.ok) {
      throw new Error("expected parse to fail");
    }
    assert.equal(result.reason, "no_json_array");
  });

  it("extracts normalized memory entries through the provider-backed extractor", async function () {
    const extractor = new ProviderMemoryExtractor(async () => ({
      isReady: () => true,
      chatCompletion: async () =>
        '[{"text":"  concise answers  ","category":"preference","importance":0.9}]',
    }));

    const result = await extractor.extract([
      {
        id: "u1",
        role: "user",
        content: "Please answer concisely.",
        timestamp: 1,
      },
      {
        id: "a1",
        role: "assistant",
        content: "Sure.",
        timestamp: 2,
      },
    ]);

    assert.isTrue(result.ok);
    if (!result.ok) {
      throw new Error("expected extraction to succeed");
    }
    assert.deepEqual(result.entries, [
      {
        text: "concise answers",
        category: "preference",
        importance: 0.9,
      },
    ]);
  });

  it("reports missing provider during extraction", async function () {
    const extractor = new ProviderMemoryExtractor(async () => null);

    const result = await extractor.extract([
      {
        id: "u1",
        role: "user",
        content: "Please answer concisely.",
        timestamp: 1,
      },
    ]);

    assert.isFalse(result.ok);
    if (result.ok) {
      throw new Error("expected extraction to fail");
    }
    assert.equal(result.reason, "no_provider");
  });

  it("reports provider not ready during extraction", async function () {
    const extractor = new ProviderMemoryExtractor(async () => ({
      isReady: () => false,
      chatCompletion: async () => "[]",
    }));

    const result = await extractor.extract([
      {
        id: "u1",
        role: "user",
        content: "Please answer concisely.",
        timestamp: 1,
      },
    ]);

    assert.isFalse(result.ok);
    if (result.ok) {
      throw new Error("expected extraction to fail");
    }
    assert.equal(result.reason, "provider_not_ready");
  });

  it("reports empty provider response during extraction", async function () {
    const extractor = new ProviderMemoryExtractor(async () => ({
      isReady: () => true,
      chatCompletion: async () => "",
    }));

    const result = await extractor.extract([
      {
        id: "u1",
        role: "user",
        content: "Please answer concisely.",
        timestamp: 1,
      },
      {
        id: "a1",
        role: "assistant",
        content: "Sure.",
        timestamp: 2,
      },
    ]);

    assert.isFalse(result.ok);
    if (result.ok) {
      throw new Error("expected extraction to fail");
    }
    assert.equal(result.reason, "empty_response");
  });

  it("reports empty conversation during extraction", async function () {
    const extractor = new ProviderMemoryExtractor(async () => ({
      isReady: () => true,
      chatCompletion: async () => "[]",
    }));

    const result = await extractor.extract([
      {
        id: "sys",
        role: "system",
        content: "ignore this",
        timestamp: 1,
      },
    ]);

    assert.isFalse(result.ok);
    if (result.ok) {
      throw new Error("expected extraction to fail");
    }
    assert.equal(result.reason, "empty_conversation");
  });

  it("prunes excess memories after a successful save", async function () {
    const inserted: any[] = [];
    let pruneExcess = 0;

    const store = new MemoryStore(1);
    (store as any).repository = {
      insert: async (record: any) => {
        inserted.push(record);
      },
      count: async () => 501,
      pruneOldestLowestImportance: async (excess: number) => {
        pruneExcess = excess;
      },
      delete: async () => undefined,
      listAll: async () => [],
    };
    (store as any).searchService = {
      createEmbedding: async () => ({
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: "test-model",
      }),
      isDuplicate: async () => false,
      search: async () => [],
    };

    const result = await store.save(
      "The user prefers concise answers with bullet points.",
      "preference",
      0.9,
    );

    assert.deepEqual(result, { saved: true });
    assert.lengthOf(inserted, 1);
    assert.equal(inserted[0].embeddingModel, "test-model");
    assert.equal(pruneExcess, 1);
  });

  it("rejects concurrent saves for the same text before insert completes", async function () {
    const inserted: any[] = [];
    let releaseEmbedding!: () => void;
    const embeddingGate = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });

    const store = new MemoryStore(1);
    (store as any).repository = {
      insert: async (record: any) => {
        inserted.push(record);
      },
      count: async () => 1,
      pruneOldestLowestImportance: async () => undefined,
      delete: async () => undefined,
      listAll: async () => [],
    };
    (store as any).searchService = {
      createEmbedding: async () => {
        await embeddingGate;
        return {};
      },
      isDuplicate: async () => false,
      search: async () => [],
    };

    const text = "The user prefers concise answers with bullet points.";
    const firstSave = store.save(text, "preference", 0.9);
    const secondSave = store.save(text, "preference", 0.9);

    releaseEmbedding();

    const [firstResult, secondResult] = await Promise.all([
      firstSave,
      secondSave,
    ]);

    assert.deepEqual(firstResult, { saved: true });
    assert.deepEqual(secondResult, {
      saved: false,
      reason: "duplicate",
    });
    assert.lengthOf(inserted, 1);
  });

  it("does not re-run extraction for unchanged sessions after a successful pass", async function () {
    let updateCalls = 0;
    const session: ChatSession = {
      id: "session-1",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [
        { id: "u1", role: "user", content: "1", timestamp: 1 },
        { id: "a1", role: "assistant", content: "2", timestamp: 2 },
        { id: "u2", role: "user", content: "3", timestamp: 3 },
        { id: "a2", role: "assistant", content: "4", timestamp: 4 },
        { id: "u3", role: "user", content: "5", timestamp: 5 },
        { id: "a3", role: "assistant", content: "6", timestamp: 6 },
        { id: "u4", role: "user", content: "7", timestamp: 7 },
        { id: "a4", role: "assistant", content: "8", timestamp: 8 },
      ],
    };

    const orchestrator = new MemoryOrchestrator(
      {
        updateMemoryExtractionState: async () => {
          updateCalls++;
        },
      } as any,
      () => ({
        save: async () => ({ saved: true }),
      }) as any,
      () => ({
        extract: async () => ({
          ok: true,
          entries: [
            {
              text: "The user prefers concise answers.",
              category: "preference",
              importance: 0.9,
            },
          ],
        }),
      }) as any,
    );

    const firstRun = orchestrator.scheduleExtraction(session);
    assert.isNotNull(firstRun);
    await firstRun;
    assert.equal(updateCalls, 1);
    assert.equal(session.memoryExtractedMsgCount, 8);

    const secondRun = orchestrator.scheduleExtraction(session);
    assert.isNull(secondRun);
    assert.equal(updateCalls, 1);
  });

  it("waits for pending extraction work during memory-manager destroy", async function () {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saveCalls = 0;
    let updateCalls = 0;

    const manager = new MemoryManager(
      {
        updateMemoryExtractionState: async () => {
          updateCalls++;
        },
      } as any,
      () => ({
        save: async () => {
          saveCalls++;
          await saveGate;
          return { saved: true };
        },
        buildPromptContext: async () => undefined,
      }) as any,
      () => ({
        extract: async () => ({
          ok: true,
          entries: [
            {
              text: "The user works on a Zotero plugin.",
              category: "fact",
              importance: 0.8,
            },
          ],
        }),
      }) as any,
    );

    const session: ChatSession = {
      id: "session-2",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [
        { id: "u1", role: "user", content: "1", timestamp: 1 },
        { id: "a1", role: "assistant", content: "2", timestamp: 2 },
        { id: "u2", role: "user", content: "3", timestamp: 3 },
        { id: "a2", role: "assistant", content: "4", timestamp: 4 },
        { id: "u3", role: "user", content: "5", timestamp: 5 },
        { id: "a3", role: "assistant", content: "6", timestamp: 6 },
        { id: "u4", role: "user", content: "7", timestamp: 7 },
        { id: "a4", role: "assistant", content: "8", timestamp: 8 },
      ],
    };

    const destroyPromise = manager.flushOnDestroy(session);
    await Promise.resolve();
    assert.equal(saveCalls, 1);
    assert.equal(updateCalls, 0);

    releaseSave();
    await destroyPromise;
    assert.equal(updateCalls, 1);
  });

  it("passes requireGrowth when startup triggers extraction checks", function () {
    const manager = new MemoryManager(
      {} as any,
      () => ({}) as any,
      () => ({}) as any,
    );
    const scheduleCalls: Array<{
      sessionId: string;
      requireGrowth?: boolean;
    }> = [];

    (manager as any).orchestrator = {
      scheduleExtraction: (session: ChatSession, options?: { requireGrowth?: boolean }) => {
        scheduleCalls.push({
          sessionId: session.id,
          requireGrowth: options?.requireGrowth,
        });
        return null;
      },
      awaitPendingTasks: async () => undefined,
      clear: () => undefined,
    };

    manager.onSessionReady({
      id: "session-3",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      memoryExtractedAt: 100,
      memoryExtractedMsgCount: 8,
      messages: [
        { id: "u1", role: "user", content: "1", timestamp: 1 },
        { id: "a1", role: "assistant", content: "2", timestamp: 2 },
        { id: "u2", role: "user", content: "3", timestamp: 3 },
        { id: "a2", role: "assistant", content: "4", timestamp: 4 },
        { id: "u3", role: "user", content: "5", timestamp: 5 },
        { id: "a3", role: "assistant", content: "6", timestamp: 6 },
        { id: "u4", role: "user", content: "7", timestamp: 7 },
        { id: "a4", role: "assistant", content: "8", timestamp: 8 },
      ],
    });

    assert.deepEqual(scheduleCalls, [
      {
        sessionId: "session-3",
        requireGrowth: true,
      },
    ]);
  });
});
