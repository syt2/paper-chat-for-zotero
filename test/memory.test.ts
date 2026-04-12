import { assert } from "chai";
import { MemoryService } from "../src/modules/chat/memory/MemoryService";
import { MemorySearchService } from "../src/modules/chat/memory/MemorySearchService";
import { MemoryStore } from "../src/modules/chat/memory/MemoryStore";
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
});
