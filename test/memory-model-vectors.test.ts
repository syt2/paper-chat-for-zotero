import { assert } from "chai";
import { StorageDatabase } from "../src/modules/chat/db/StorageDatabase";
import { MemoryRepository } from "../src/modules/chat/memory/MemoryRepository";
import { MemoryIndexer } from "../src/modules/chat/memory/MemoryIndexer";

describe("memory vectors by model (SQLite)", function () {
  let sqlite: any;
  let db: any;
  let storage: any;
  let repository: any;
  let originalToolkit: unknown;

  before(async function () {
    if (!(globalThis as any).process?.versions?.node) return this.skip();
    const moduleName = ["node", "sqlite"].join(":");
    sqlite = await import(moduleName);
  });
  beforeEach(async function () {
    originalToolkit = (globalThis as any).ztoolkit;
    (globalThis as any).ztoolkit = { log() {} };
    const connection = new sqlite.DatabaseSync(":memory:");
    db = {
      connection,
      async queryAsync(sql: string, params: unknown[] = []) {
        const statement = connection.prepare(sql);
        if (statement.columns().length) return statement.all(...params);
        statement.run(...params);
        return [];
      },
    };
    storage = new StorageDatabase();
    await storage.createTables(db);
    await db.queryAsync(
      "INSERT INTO schema_version (id, version, updated_at) VALUES (1, 16, 0)",
    );
    await db.queryAsync(
      "INSERT INTO memories (id, library_id, text, category, importance, created_at, access_count, last_accessed_at, embedding, embedding_model) VALUES ('m1', 1, 'original memory', 'fact', 0.5, 1, 0, 1, '[1,0]', 'model-a')",
    );
    repository = new MemoryRepository(1);
    repository.getDb = async () => db;
  });
  afterEach(function () {
    db?.connection.close();
    (globalThis as any).ztoolkit = originalToolkit;
  });

  it("migrates legacy vectors and keeps different models isolated across switchback", async function () {
    await storage.upgradeToV17(db);
    assert.deepEqual(
      (await repository.listRecent(10, "model-a"))[0].embedding,
      [1, 0],
    );
    assert.lengthOf(await repository.listMissingEmbeddings("model-b"), 1);
    const indexer: any = new MemoryIndexer(1);
    indexer.repository = repository;
    let calls = 0;
    const provider = (modelId: string) => ({
      modelId,
      embedBatch: async () => {
        calls++;
        return [[0, 1]];
      },
    });
    await indexer.reindexMissingEmbeddings(provider("model-b"));
    await indexer.reindexMissingEmbeddings(provider("model-a"));
    await indexer.reindexMissingEmbeddings(provider("model-b"));
    assert.equal(calls, 1);
    assert.deepEqual(
      (await repository.listRecent(10, "model-a"))[0].embedding,
      [1, 0],
    );
    assert.deepEqual(
      (await repository.listRecent(10, "model-b"))[0].embedding,
      [0, 1],
    );
    const otherLibrary: any = new MemoryRepository(2);
    otherLibrary.getDb = async () => db;
    assert.isEmpty(await otherLibrary.listEmbeddedRows(10, "model-a"));
  });

  it("invalidates edited vectors and rejects in-flight writes for deleted or edited memories", async function () {
    await storage.upgradeToV17(db);
    await db.queryAsync("UPDATE memories SET text = 'edited' WHERE id = 'm1'");
    await repository.saveEmbedding("m1", "model-b", "original memory", [0, 1]);
    await storage.upgradeToV17(db);
    assert.isEmpty(await repository.listEmbeddedRows(10, "model-a"));
    assert.isEmpty(await repository.listEmbeddedRows(10, "model-b"));
    await repository.saveEmbedding("m1", "model-b", "edited", [0, 1]);
    await repository.delete("m1");
    await repository.saveEmbedding("m1", "model-a", "edited", [1, 0]);
    assert.isEmpty(await db.queryAsync("SELECT * FROM memory_embeddings"));
  });

  it("rolls back migration without losing legacy vectors on failure", async function () {
    const failing = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("UPDATE schema_version"))
          throw new Error("simulated failure");
        return db.queryAsync(sql, params);
      },
    };
    try {
      await storage.upgradeToV17(failing);
      assert.fail("migration must fail");
    } catch (error) {
      assert.include(String(error), "simulated failure");
    }
    assert.equal(
      (await db.queryAsync("SELECT embedding FROM memories"))[0].embedding,
      "[1,0]",
    );
    assert.isEmpty(await db.queryAsync("SELECT * FROM memory_embeddings"));
  });
});
