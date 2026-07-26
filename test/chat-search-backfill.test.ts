import { assert } from "chai";
import {
  SessionStorageService,
  type MessageStorageRow,
} from "../src/modules/chat/SessionStorageService.ts";
import {
  getStorageDatabase,
  resetStorageDatabaseForTests,
} from "../src/modules/chat/db/StorageDatabase.ts";
import {
  adaptSearchBackfillBatchSize,
  createMessageProjectionSignature,
  createTitleProjectionSignature,
} from "../src/modules/chat/search/SearchBackfill.ts";
import { stopExistingSearchBackfillForShutdown } from "../src/modules/chat/search/SearchBackfillShutdown.ts";
import {
  CURRENT_SEARCH_VERSION,
  FIELD_BOUNDARY_TOKEN,
} from "../src/modules/chat/search/SearchProjection.ts";

type SearchStateRow = {
  target_version: number;
  completed: number;
  revision_epoch: string;
  search_revision: number;
  updated_at: number;
};

type BackfillMessageRow = MessageStorageRow & {
  session_id: string;
  seq: number;
  search_index_version: number;
  search_text: string;
};

type BackfillTitleRow = {
  id: string;
  title: string | null;
  updated_at: number;
  message_count: number;
  search_index_version: number;
  search_title: string;
};

type RecordedQuery = {
  sql: string;
  params: unknown[];
  inTransaction: boolean;
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function sortByWorkOrder<
  T extends { id: string; search_index_version: number },
>(left: T, right: T): number {
  return (
    left.search_index_version - right.search_index_version ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

class BackfillFakeDatabase {
  readonly messages = new Map<string, BackfillMessageRow>();
  readonly titles = new Map<string, BackfillTitleRow>();
  readonly queries: RecordedQuery[] = [];
  /** Rows whose content reads throw, like a strict Zotero row Proxy would. */
  readonly poisonedMessageIds = new Set<string>();
  mutateOnNextTransaction: (() => void) | null = null;
  private transactionDepth = 0;

  constructor(readonly state: SearchStateRow) {}

  private copyMessageRow(row: BackfillMessageRow): BackfillMessageRow {
    const copy: BackfillMessageRow = { ...row };
    if (this.poisonedMessageIds.has(row.id)) {
      Object.defineProperty(copy, "content", {
        get(): string {
          throw new Error("poisoned content read");
        },
      });
    }
    return copy;
  }

  async queryAsync(
    sql: string,
    rawParams: unknown[] = [],
  ): Promise<any[] | undefined> {
    const statement = normalizeSql(sql);
    const params = [...rawParams];
    this.queries.push({
      sql: statement,
      params,
      inTransaction: this.transactionDepth > 0,
    });

    if (statement === "BEGIN TRANSACTION") {
      this.transactionDepth += 1;
      const mutation = this.mutateOnNextTransaction;
      this.mutateOnNextTransaction = null;
      mutation?.();
      return [];
    }
    if (statement === "COMMIT") {
      this.transactionDepth -= 1;
      return [];
    }
    if (statement === "ROLLBACK") {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      return [];
    }
    if (
      statement ===
      "SELECT target_version, completed, revision_epoch, search_revision, updated_at FROM chat_search_state WHERE id = 1"
    ) {
      return [{ ...this.state }];
    }
    if (statement === "SELECT value FROM settings WHERE key = ?") return [];

    if (
      statement.startsWith(
        "SELECT id, session_id, seq, role, content, timestamp, selected_text, tool_calls, tool_call_id",
      )
    ) {
      const targetVersion = Number(params[0]);
      const limit = Number(params.at(-1));
      return [...this.messages.values()]
        .filter((row) => row.search_index_version < targetVersion)
        .sort(sortByWorkOrder)
        .slice(0, limit)
        .map((row) => this.copyMessageRow(row));
    }
    if (
      statement.startsWith(
        "SELECT id, title, updated_at, message_count, search_index_version FROM session_meta",
      )
    ) {
      const targetVersion = Number(params[0]);
      const limit = Number(params.at(-1));
      return [...this.titles.values()]
        .filter((row) => row.search_index_version < targetVersion)
        .sort(sortByWorkOrder)
        .slice(0, limit)
        .map((row) => ({ ...row }));
    }
    if (
      statement.startsWith(
        "SELECT id, role, content, selected_text, tool_calls, tool_call_id",
      )
    ) {
      return params
        .map((id) => this.messages.get(String(id)))
        .filter((row): row is BackfillMessageRow => !!row)
        .map((row) => this.copyMessageRow(row));
    }
    if (
      statement.startsWith(
        "SELECT id, title, search_index_version FROM session_meta WHERE id IN",
      )
    ) {
      return params
        .map((id) => this.titles.get(String(id)))
        .filter((row): row is BackfillTitleRow => !!row)
        .map((row) => ({ ...row }));
    }
    if (statement.startsWith("UPDATE messages SET search_text = ?")) {
      const row = this.messages.get(String(params[2]));
      if (row && row.search_index_version < Number(params[3])) {
        row.search_text = String(params[0]);
        row.search_index_version = Number(params[1]);
      }
      return [];
    }
    if (statement.startsWith("UPDATE session_meta SET search_title = ?")) {
      const row = this.titles.get(String(params[2]));
      if (row && row.search_index_version < Number(params[3])) {
        row.search_title = String(params[0]);
        row.search_index_version = Number(params[1]);
      }
      return [];
    }
    if (statement.startsWith("SELECT CASE WHEN NOT EXISTS")) {
      const messageTarget = Number(params[0]);
      const titleTarget = Number(params[1]);
      const hasWork =
        [...this.messages.values()].some(
          (row) => row.search_index_version < messageTarget,
        ) ||
        [...this.titles.values()].some(
          (row) => row.search_index_version < titleTarget,
        );
      return [{ completed: hasWork ? 0 : 1 }];
    }
    if (statement.startsWith("UPDATE chat_search_state SET completed = 1")) {
      if (this.state.target_version === Number(params[1])) {
        this.state.completed = 1;
        this.state.updated_at = Number(params[0]);
      }
      return [];
    }

    return [];
  }
}

async function installFakeDatabase(fake: BackfillFakeDatabase): Promise<void> {
  const storage = getStorageDatabase() as any;
  storage.ensureInit = async () => fake;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("chat history search backfill helpers", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;

  beforeEach(async function () {
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "/tmp/paperchat-search-backfill-test" },
    };
    (globalThis as any).ztoolkit = { log: () => undefined };
    await resetStorageDatabaseForTests();
  });

  afterEach(async function () {
    await resetStorageDatabaseForTests();
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
  });

  it("does not create work without an existing backfill owner", async function () {
    await stopExistingSearchBackfillForShutdown(null);
  });

  it("awaits an existing backfill owner until its active slice drains", async function () {
    const activeDrained = deferred();
    let stopCalls = 0;
    let shutdownResolved = false;

    const shutdown = stopExistingSearchBackfillForShutdown({
      async stopSearchHistoryBackfill() {
        stopCalls += 1;
        await activeDrained.promise;
      },
    }).then(() => {
      shutdownResolved = true;
    });

    await Promise.resolve();
    assert.equal(stopCalls, 1);
    assert.isFalse(shutdownResolved);

    activeDrained.resolve();
    await shutdown;
    assert.isTrue(shutdownResolved);
  });

  it("adapts batches within the approved 1-100 row bounds", function () {
    assert.equal(
      adaptSearchBackfillBatchSize(25, { totalMs: 5, transactionMs: 3 }),
      38,
    );
    assert.equal(
      adaptSearchBackfillBatchSize(25, { totalMs: 17, transactionMs: 3 }),
      12,
    );
    assert.equal(
      adaptSearchBackfillBatchSize(1, { totalMs: 30, transactionMs: 30 }),
      1,
    );
    assert.equal(
      adaptSearchBackfillBatchSize(100, { totalMs: 1, transactionMs: 1 }),
      100,
    );
  });

  it("signs every source field used by message and title projection", function () {
    const source = {
      id: "m1",
      role: "assistant",
      content: "answer",
      quotedMessages: null,
      selectedText: null,
      toolCalls: null,
      toolCallId: null,
      streamingState: null,
      apiOnly: false,
      isSystemNotice: false,
    };
    const base = createMessageProjectionSignature(source);

    for (const mutation of [
      { id: "m2" },
      { role: "user" },
      { content: "changed" },
      { quotedMessages: '[{"preview":"quoted"}]' },
      { selectedText: "selection" },
      { toolCalls: '[{"id":"tool-1"}]' },
      { toolCallId: "tool-1" },
      { streamingState: "interrupted" },
      { apiOnly: true },
      { isSystemNotice: true },
    ]) {
      assert.notEqual(
        base,
        createMessageProjectionSignature({ ...source, ...mutation }),
      );
    }
    assert.notEqual(
      createTitleProjectionSignature("s1", "Title"),
      createTitleProjectionSignature("s1", "New title"),
    );
    assert.notEqual(
      createTitleProjectionSignature("s1", "Title"),
      createTitleProjectionSignature("s2", "Title"),
    );
  });

  it("backfills visible message/title projections without revising search", async function () {
    const fake = new BackfillFakeDatabase({
      target_version: CURRENT_SEARCH_VERSION,
      completed: 0,
      revision_epoch: "backfill-epoch",
      search_revision: 9,
      updated_at: 1,
    });
    fake.messages.set("message-b", {
      id: "message-b",
      session_id: "session-1",
      seq: 1,
      role: "assistant",
      content: "Final **Ａｎｓｗｅｒ**",
      timestamp: 2,
      tool_calls: null,
      tool_call_id: null,
      streaming_state: null,
      api_only: null,
      is_system_notice: null,
      search_text: "",
      search_index_version: 0,
    });
    fake.messages.set("message-a", {
      id: "message-a",
      session_id: "session-1",
      seq: 0,
      role: "user",
      content: "[Question]: Hello",
      selected_text: "Selected",
      timestamp: 1,
      tool_calls: null,
      tool_call_id: null,
      streaming_state: null,
      api_only: null,
      is_system_notice: null,
      search_text: "",
      search_index_version: 0,
    });
    fake.messages.set("message-tool", {
      id: "message-tool",
      session_id: "session-1",
      seq: 2,
      role: "assistant",
      content: "Internal tool answer",
      timestamp: 3,
      tool_calls: '[{"id":"tool-1"}]',
      tool_call_id: null,
      streaming_state: null,
      api_only: null,
      is_system_notice: null,
      search_text: "stale private text",
      search_index_version: 0,
    });
    fake.titles.set("session-1", {
      id: "session-1",
      title: "Ｒｅｓｅａｒｃｈ Notes",
      updated_at: 3,
      message_count: 2,
      search_title: "",
      search_index_version: 0,
    });
    await installFakeDatabase(fake);
    const service = new SessionStorageService();
    await service.init();

    const hasMoreWork = await (service as any).search.runSearchBackfillSlice();

    assert.isFalse(hasMoreWork);
    assert.equal(
      fake.messages.get("message-a")?.search_text,
      `selected${FIELD_BOUNDARY_TOKEN}hello`,
    );
    assert.equal(fake.messages.get("message-b")?.search_text, "final answer");
    assert.equal(fake.messages.get("message-tool")?.search_text, "");
    assert.equal(fake.titles.get("session-1")?.search_title, "research notes");
    assert.equal(fake.state.completed, 1);
    assert.equal(fake.state.search_revision, 9);
    assert.isAtLeast(service.getLastSearchBackfillTiming()?.totalMs ?? -1, 0);
    assert.isAtLeast(
      service.getLastSearchBackfillTiming()?.transactionMs ?? -1,
      0,
    );

    const workQueries = fake.queries.filter(
      (query) =>
        query.sql.includes("WHERE search_index_version < ?") &&
        query.sql.includes("ORDER BY search_index_version ASC"),
    );
    assert.lengthOf(workQueries, 2);
    assert.isTrue(
      workQueries.every((query) => query.sql.includes("id COLLATE BINARY ASC")),
    );
    const representationWrites = fake.queries.filter(
      (query) =>
        query.sql.startsWith("UPDATE messages SET search_text = ?") ||
        query.sql.startsWith("UPDATE session_meta SET search_title = ?") ||
        query.sql.startsWith("UPDATE chat_search_state SET completed = 1"),
    );
    assert.isTrue(representationWrites.every((query) => query.inTransaction));
    assert.isFalse(
      fake.queries.some((query) => query.sql.includes("search_revision + 1")),
    );
  });

  it("advances rows whose optional attachment JSON is malformed", async function () {
    const fake = new BackfillFakeDatabase({
      target_version: CURRENT_SEARCH_VERSION,
      completed: 0,
      revision_epoch: "malformed-json-epoch",
      search_revision: 3,
      updated_at: 1,
    });
    fake.messages.set("message-malformed", {
      id: "message-malformed",
      session_id: "session-1",
      seq: 0,
      role: "assistant",
      content: "Still searchable",
      images: "{",
      files: "not-json",
      timestamp: 1,
      tool_calls: "[broken",
      tool_call_id: null,
      streaming_state: null,
      api_only: null,
      is_system_notice: null,
      search_text: "",
      search_index_version: 0,
    });
    await installFakeDatabase(fake);
    const service = new SessionStorageService();
    await service.init();

    assert.isFalse(await (service as any).search.runSearchBackfillSlice());
    assert.equal(
      fake.messages.get("message-malformed")?.search_text,
      "still searchable",
    );
    assert.equal(
      fake.messages.get("message-malformed")?.search_index_version,
      CURRENT_SEARCH_VERSION,
    );
    assert.equal(fake.state.completed, 1);
  });

  it("quarantines a row whose projection throws instead of wedging the backfill", async function () {
    const fake = new BackfillFakeDatabase({
      target_version: CURRENT_SEARCH_VERSION,
      completed: 0,
      revision_epoch: "poison-epoch",
      search_revision: 5,
      updated_at: 1,
    });
    fake.messages.set("message-poisoned", {
      id: "message-poisoned",
      session_id: "session-1",
      seq: 0,
      role: "assistant",
      content: "Unreadable legacy content",
      timestamp: 1,
      tool_calls: null,
      tool_call_id: null,
      streaming_state: null,
      api_only: null,
      is_system_notice: null,
      search_text: "",
      search_index_version: 0,
    });
    fake.messages.set("message-healthy", {
      id: "message-healthy",
      session_id: "session-1",
      seq: 1,
      role: "assistant",
      content: "Healthy answer",
      timestamp: 2,
      tool_calls: null,
      tool_call_id: null,
      streaming_state: null,
      api_only: null,
      is_system_notice: null,
      search_text: "",
      search_index_version: 0,
    });
    fake.poisonedMessageIds.add("message-poisoned");
    await installFakeDatabase(fake);
    const service = new SessionStorageService();
    await service.init();

    // The slice completes instead of throwing and re-reading the same
    // poisoned row on every retry forever.
    assert.isFalse(await (service as any).search.runSearchBackfillSlice());

    const poisoned = fake.messages.get("message-poisoned");
    assert.equal(poisoned?.search_text, "");
    assert.equal(poisoned?.search_index_version, CURRENT_SEARCH_VERSION);
    assert.equal(
      fake.messages.get("message-healthy")?.search_text,
      "healthy answer",
    );
    assert.equal(fake.state.completed, 1);
    assert.equal(fake.state.search_revision, 5);
  });

  it("leaves a stale source pending and projects it on the next slice", async function () {
    const fake = new BackfillFakeDatabase({
      target_version: CURRENT_SEARCH_VERSION,
      completed: 0,
      revision_epoch: "stale-epoch",
      search_revision: 4,
      updated_at: 1,
    });
    fake.messages.set("message-stale", {
      id: "message-stale",
      session_id: "session-1",
      seq: 0,
      role: "assistant",
      content: "Old answer",
      timestamp: 1,
      tool_calls: null,
      tool_call_id: null,
      streaming_state: null,
      api_only: null,
      is_system_notice: null,
      search_text: "",
      search_index_version: 0,
    });
    await installFakeDatabase(fake);
    const service = new SessionStorageService();
    await service.init();
    fake.mutateOnNextTransaction = () => {
      fake.messages.get("message-stale")!.content = "Changed answer";
    };

    assert.isTrue(await (service as any).search.runSearchBackfillSlice());
    assert.equal(fake.messages.get("message-stale")?.search_index_version, 0);
    assert.equal(fake.messages.get("message-stale")?.search_text, "");
    assert.equal(fake.state.completed, 0);
    assert.equal(fake.state.search_revision, 4);

    assert.isFalse(await (service as any).search.runSearchBackfillSlice());
    assert.equal(
      fake.messages.get("message-stale")?.search_index_version,
      CURRENT_SEARCH_VERSION,
    );
    assert.equal(
      fake.messages.get("message-stale")?.search_text,
      "changed answer",
    );
    assert.equal(fake.state.completed, 1);
    assert.equal(fake.state.search_revision, 4);
  });

  it("pauses, drains, resumes, and stops one scheduled slice at a time", async function () {
    const service = new SessionStorageService();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;

    (service as any).search.runSearchBackfillSlice = async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (calls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      concurrent -= 1;
      return calls === 1;
    };

    service.startSearchBackfill();
    await firstStarted.promise;
    service.pauseSearchBackfill();
    releaseFirst.resolve();
    await service.awaitActiveSearchBackfill();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 1);

    service.resumeSearchBackfill();
    await waitFor(() => calls === 2);
    await service.stopSearchBackfill();
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(calls, 2);
    assert.equal(maxConcurrent, 1);
  });

  it("cancels a future timer before shutdown", async function () {
    const service = new SessionStorageService();
    let calls = 0;
    (service as any).search.runSearchBackfillSlice = async () => {
      calls += 1;
      return false;
    };

    service.startSearchBackfill();
    await service.stopSearchBackfill();
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(calls, 0);
  });

  it("does not schedule a retry when shutdown drains a failing slice", async function () {
    const service = new SessionStorageService();
    const sliceStarted = deferred();
    const releaseSlice = deferred();
    let calls = 0;

    (service as any).search.runSearchBackfillSlice = async () => {
      calls += 1;
      sliceStarted.resolve();
      await releaseSlice.promise;
      throw new Error("database closed");
    };

    service.startSearchBackfill();
    await sliceStarted.promise;
    const stopping = service.stopSearchBackfill();
    releaseSlice.resolve();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(calls, 1);
    assert.isNull((service as any).search.searchBackfillTimer);
  });

  it("backs persistent failures off exponentially and resets after success", async function () {
    const service = new SessionStorageService();
    const scheduled: Array<{
      callback: () => void;
      delayMs: number;
      token: object;
    }> = [];
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let calls = 0;

    globalThis.setTimeout = ((callback: () => void, delayMs: number = 0) => {
      const token = {};
      scheduled.push({ callback, delayMs, token });
      return token;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((token: object) => {
      const pendingIndex = scheduled.findIndex(
        (entry) => entry.token === token,
      );
      if (pendingIndex >= 0) scheduled.splice(pendingIndex, 1);
    }) as typeof clearTimeout;

    (service as any).search.runSearchBackfillSlice = async () => {
      calls += 1;
      if (calls <= 9) throw new Error("persistent failure");
      return true;
    };

    try {
      service.startSearchBackfill();
      const runNext = async (expectedDelayMs: number): Promise<void> => {
        const next = scheduled.shift();
        assert.exists(next);
        assert.equal(next!.delayMs, expectedDelayMs);
        next!.callback();
        await service.awaitActiveSearchBackfill();
      };

      await runNext(0);
      for (const retryDelayMs of [
        250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
      ]) {
        await runNext(retryDelayMs);
      }

      // A successful slice immediately schedules normal work again.
      assert.equal(scheduled[0]?.delayMs, 0);
    } finally {
      await service.stopSearchBackfill();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
