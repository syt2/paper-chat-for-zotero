import { assert } from "chai";
import {
  SessionStorageService,
  type MessageStorageRow,
} from "../src/modules/chat/SessionStorageService.ts";
import {
  FIELD_BOUNDARY_TOKEN,
  CURRENT_SEARCH_VERSION,
} from "../src/modules/chat/search/SearchProjection.ts";
import {
  getStorageDatabase,
  resetStorageDatabaseForTests,
} from "../src/modules/chat/db/StorageDatabase.ts";
import type { ChatSession } from "../src/types/chat.ts";

type SearchStateRow = {
  target_version: number;
  completed: number;
  revision_epoch: string;
  search_revision: number;
  updated_at: number;
};

type StoredMessage = MessageStorageRow & {
  session_id: string;
  seq: number;
};

type RecordedQuery = {
  sql: string;
  params: unknown[];
  inTransaction: boolean;
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

class SemanticWriteFakeDatabase {
  state: SearchStateRow | null;
  hasBackfillWork = false;
  observedSearchVersion = 0;
  readonly messages = new Map<string, StoredMessage>();
  readonly sessions = new Set<string>();
  readonly queries: RecordedQuery[] = [];
  private transactionDepth = 0;

  constructor(state: SearchStateRow | null) {
    this.state = state;
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
      return this.state ? [{ ...this.state }] : [];
    }
    if (statement.startsWith("SELECT MAX(version) AS max_version")) {
      return [{ max_version: this.observedSearchVersion }];
    }
    if (statement.startsWith("SELECT CASE WHEN EXISTS")) {
      return [{ has_work: this.hasBackfillWork ? 1 : 0 }];
    }
    if (statement === "DELETE FROM chat_search_state WHERE id = 1") {
      this.state = null;
      return [];
    }
    if (statement.startsWith("INSERT INTO chat_search_state")) {
      this.state = {
        target_version: Number(params[0]),
        completed: Number(params[1]),
        revision_epoch: String(params[2]),
        search_revision: 0,
        updated_at: Number(params[3]),
      };
      return [];
    }
    if (
      statement.startsWith("UPDATE chat_search_state SET target_version = ?")
    ) {
      if (this.state) {
        this.state.target_version = Number(params[0]);
        this.state.completed = 0;
        this.state.updated_at = Number(params[1]);
      }
      return [];
    }
    if (
      statement ===
      "UPDATE chat_search_state SET completed = 0, updated_at = ? WHERE id = 1"
    ) {
      if (this.state) {
        this.state.completed = 0;
        this.state.updated_at = Number(params[0]);
      }
      return [];
    }
    if (
      statement.startsWith(
        "UPDATE chat_search_state SET search_revision = search_revision + 1",
      )
    ) {
      if (this.state) {
        this.state.search_revision += 1;
        this.state.updated_at = Number(params[0]);
        if (this.state.target_version > Number(params[1])) {
          this.state.completed = 0;
        }
      }
      return [];
    }
    if (statement === "SELECT value FROM settings WHERE key = ?") return [];

    if (
      statement ===
      "SELECT COALESCE(MAX(seq), -1) as max_seq FROM messages WHERE session_id = ?"
    ) {
      const sessionId = String(params[0]);
      const seqs = [...this.messages.values()]
        .filter((message) => message.session_id === sessionId)
        .map((message) => message.seq);
      return [{ max_seq: seqs.length ? Math.max(...seqs) : -1 }];
    }
    if (statement.startsWith("INSERT INTO messages")) {
      const message: StoredMessage = {
        id: String(params[0]),
        session_id: String(params[1]),
        seq: Number(params[2]),
        role: params[3] as StoredMessage["role"],
        content: String(params[4] || ""),
        reasoning: (params[5] as string | null) || null,
        images: (params[6] as string | null) || null,
        files: (params[7] as string | null) || null,
        timestamp: Number(params[8]),
        pdf_context: (params[9] as number | null) || null,
        selected_text: (params[10] as string | null) || null,
        tool_calls: (params[11] as string | null) || null,
        tool_call_id: (params[12] as string | null) || null,
        streaming_state:
          (params[13] as StoredMessage["streaming_state"]) || null,
        api_only: (params[14] as number | null) || null,
        is_system_notice: (params[15] as number | null) || null,
        search_text: String(params[16] || ""),
        search_index_version: Number(params[17]),
      };
      this.messages.set(message.id, message);
      return [];
    }
    if (
      statement === "SELECT * FROM messages WHERE id = ? AND session_id = ?"
    ) {
      const message = this.messages.get(String(params[0]));
      return message && message.session_id === params[1]
        ? [{ ...message }]
        : [];
    }
    if (statement.startsWith("UPDATE messages SET content = ?")) {
      const message = this.messages.get(String(params[6]));
      if (message && message.session_id === params[7]) {
        message.content = String(params[0] || "");
        message.reasoning = (params[1] as string | null) || null;
        message.timestamp = Number(params[2]);
        message.streaming_state =
          (params[3] as StoredMessage["streaming_state"]) || null;
        message.search_text = String(params[4] || "");
        message.search_index_version = Number(params[5]);
      }
      return [];
    }
    if (
      statement === "SELECT id FROM messages WHERE id = ? AND session_id = ?"
    ) {
      const message = this.messages.get(String(params[0]));
      return message && message.session_id === params[1]
        ? [{ id: message.id }]
        : [];
    }
    if (statement === "DELETE FROM messages WHERE id = ? AND session_id = ?") {
      const message = this.messages.get(String(params[0]));
      if (message?.session_id === params[1]) this.messages.delete(message.id);
      return [];
    }
    if (statement === "DELETE FROM messages WHERE session_id = ?") {
      for (const [id, message] of this.messages) {
        if (message.session_id === params[0]) this.messages.delete(id);
      }
      return [];
    }
    if (
      statement.startsWith("SELECT COUNT(*) AS count FROM messages") ||
      statement.startsWith("SELECT COUNT(*) as count FROM messages")
    ) {
      const sessionId = String(params.at(-1));
      const count = [...this.messages.values()].filter(
        (message) =>
          message.session_id === sessionId &&
          (!statement.includes("streaming_state = 'in_progress'") ||
            message.streaming_state === "in_progress"),
      ).length;
      return [{ count }];
    }
    if (statement.startsWith("SELECT content, timestamp FROM messages")) {
      const sessionId = String(params[0]);
      const message = [...this.messages.values()]
        .filter(
          (candidate) =>
            candidate.session_id === sessionId &&
            candidate.role !== "tool" &&
            !candidate.api_only &&
            !!candidate.content,
        )
        .sort((left, right) => right.seq - left.seq)[0];
      return message
        ? [{ content: message.content, timestamp: message.timestamp }]
        : [];
    }
    if (
      statement.startsWith(
        "UPDATE messages SET streaming_state = 'interrupted'",
      )
    ) {
      const sessionId = String(params[1]);
      for (const message of this.messages.values()) {
        if (
          message.session_id === sessionId &&
          message.streaming_state === "in_progress"
        ) {
          message.streaming_state = "interrupted";
          message.search_text = "";
          message.search_index_version = Number(params[0]);
        }
      }
      return [];
    }

    if (statement.startsWith("INSERT INTO sessions")) {
      this.sessions.add(String(params[0]));
      return [];
    }
    if (statement === "SELECT id FROM sessions WHERE id = ?") {
      return this.sessions.has(String(params[0])) ? [{ id: params[0] }] : [];
    }
    if (statement === "DELETE FROM sessions WHERE id = ?") {
      this.sessions.delete(String(params[0]));
      return [];
    }
    if (statement === "SELECT COUNT(*) as count FROM session_meta") {
      return [{ count: this.sessions.size }];
    }

    return [];
  }
}

async function installFakeDatabase(
  fakeDb: SemanticWriteFakeDatabase,
): Promise<void> {
  const storage = getStorageDatabase() as any;
  storage.ensureInit = async () => fakeDb;
}

describe("chat search semantic writes", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;

  beforeEach(async function () {
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "/tmp/paperchat-search-semantic-test" },
    };
    (globalThis as any).ztoolkit = { log: () => undefined };
    await resetStorageDatabaseForTests();
  });

  afterEach(async function () {
    await resetStorageDatabaseForTests();
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
  });

  it("creates missing search state and preserves a newer target", async function () {
    const missing = new SemanticWriteFakeDatabase(null);
    missing.hasBackfillWork = true;
    await installFakeDatabase(missing);

    const firstService = new SessionStorageService();
    await firstService.init();

    assert.equal(missing.state?.target_version, CURRENT_SEARCH_VERSION);
    assert.equal(missing.state?.completed, 0);
    assert.equal(missing.state?.search_revision, 0);
    assert.isNotEmpty(missing.state?.revision_epoch || "");

    await resetStorageDatabaseForTests();
    const newer: SearchStateRow = {
      target_version: CURRENT_SEARCH_VERSION + 1,
      completed: 1,
      revision_epoch: "newer-epoch",
      search_revision: 42,
      updated_at: 100,
    };
    const future = new SemanticWriteFakeDatabase({ ...newer });
    await installFakeDatabase(future);

    const secondService = new SessionStorageService();
    await secondService.init();
    assert.deepEqual(future.state, newer);
    assert.isFalse(
      future.queries.some((query) =>
        query.sql.startsWith("INSERT INTO chat_search_state"),
      ),
    );

    const missingFuture = new SemanticWriteFakeDatabase(null);
    missingFuture.observedSearchVersion = CURRENT_SEARCH_VERSION + 2;
    await installFakeDatabase(missingFuture);
    const recoveredFuture = new SessionStorageService();
    await recoveredFuture.init();
    assert.equal(
      missingFuture.state?.target_version,
      CURRENT_SEARCH_VERSION + 2,
    );
  });

  it("reopens a newer completed index after an older build writes", async function () {
    const fake = new SemanticWriteFakeDatabase({
      target_version: CURRENT_SEARCH_VERSION + 1,
      completed: 1,
      revision_epoch: "future-epoch",
      search_revision: 8,
      updated_at: 1,
    });
    await installFakeDatabase(fake);
    const service = new SessionStorageService();
    await service.insertMessage("session-future", {
      id: "future-write",
      role: "user",
      content: "[Question]: searchable write",
      timestamp: 2,
    });

    assert.equal(fake.state?.completed, 0);
    assert.equal(fake.state?.search_revision, 9);
    assert.equal(
      fake.messages.get("future-write")?.search_index_version,
      CURRENT_SEARCH_VERSION,
    );
  });

  it("repairs a completed state when older writes left lower-version rows", async function () {
    const fake = new SemanticWriteFakeDatabase({
      target_version: CURRENT_SEARCH_VERSION,
      completed: 1,
      revision_epoch: "stale-completion",
      search_revision: 2,
      updated_at: 1,
    });
    fake.hasBackfillWork = true;
    await installFakeDatabase(fake);

    await new SessionStorageService().init();

    assert.equal(fake.state?.completed, 0);
    assert.equal(fake.state?.search_revision, 2);
  });

  it("writes an inserted message projection and revision in one transaction", async function () {
    const fake = new SemanticWriteFakeDatabase({
      target_version: CURRENT_SEARCH_VERSION,
      completed: 1,
      revision_epoch: "epoch-insert",
      search_revision: 4,
      updated_at: 1,
    });
    fake.sessions.add("session-1");
    await installFakeDatabase(fake);
    const service = new SessionStorageService();

    await service.insertMessage("session-1", {
      id: "user-1",
      role: "user",
      selectedText: "Selected Text",
      content: "[Question]: Hello ＷＯＲＬＤ",
      timestamp: 10,
    });

    const stored = fake.messages.get("user-1");
    assert.equal(
      stored?.search_text,
      `selected text${FIELD_BOUNDARY_TOKEN}hello world`,
    );
    assert.equal(stored?.search_index_version, CURRENT_SEARCH_VERSION);
    assert.equal(fake.state?.search_revision, 5);

    const semanticWrites = fake.queries.filter(
      (query) =>
        query.sql.startsWith("INSERT INTO messages") ||
        query.sql.startsWith("UPDATE session_meta") ||
        query.sql.startsWith("UPDATE sessions SET updated_at") ||
        query.sql.startsWith("UPDATE chat_search_state SET search_revision"),
    );
    assert.lengthOf(semanticWrites, 4);
    assert.isTrue(semanticWrites.every((query) => query.inTransaction));
  });

  it("does not revise empty streaming checkpoints but revises the final answer", async function () {
    const fake = new SemanticWriteFakeDatabase({
      target_version: CURRENT_SEARCH_VERSION,
      completed: 1,
      revision_epoch: "epoch-stream",
      search_revision: 7,
      updated_at: 1,
    });
    fake.messages.set("assistant-1", {
      id: "assistant-1",
      session_id: "session-1",
      seq: 0,
      role: "assistant",
      content: "",
      timestamp: 1,
      streaming_state: "in_progress",
      search_text: "",
      search_index_version: CURRENT_SEARCH_VERSION,
    });
    await installFakeDatabase(fake);
    const service = new SessionStorageService();

    await service.updateMessageContent(
      "session-1",
      "assistant-1",
      "partial **answer**",
      "hidden reasoning",
      { streamingState: "in_progress" },
    );
    assert.equal(fake.state?.search_revision, 7);
    assert.equal(fake.messages.get("assistant-1")?.search_text, "");

    await service.updateMessageContent(
      "session-1",
      "assistant-1",
      "Final **Answer**",
      "hidden reasoning",
    );
    assert.equal(fake.state?.search_revision, 8);
    assert.equal(fake.messages.get("assistant-1")?.search_text, "final answer");

    const revisionWrites = fake.queries.filter((query) =>
      query.sql.startsWith("UPDATE chat_search_state SET search_revision"),
    );
    assert.lengthOf(revisionWrites, 1);
    assert.isTrue(revisionWrites[0].inTransaction);
    const messageWriteGuards = fake.queries.filter(
      (query) =>
        query.sql ===
          "UPDATE messages SET search_index_version = ? WHERE id = ? AND session_id = ?" &&
        query.params[0] === -1,
    );
    assert.lengthOf(messageWriteGuards, 2);
    assert.isTrue(messageWriteGuards.every((query) => query.inTransaction));
  });

  it("covers full save, metadata, title, delete, clear, and session delete", async function () {
    const fake = new SemanticWriteFakeDatabase({
      target_version: CURRENT_SEARCH_VERSION,
      completed: 1,
      revision_epoch: "epoch-matrix",
      search_revision: 10,
      updated_at: 1,
    });
    await installFakeDatabase(fake);
    const service = new SessionStorageService();
    const session: ChatSession = {
      id: "session-matrix",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      title: "My Ｔｉｔｌｅ",
      titleSource: "user",
      messages: [
        {
          id: "user-matrix",
          role: "user",
          content: "Question",
          timestamp: 2,
        },
        {
          id: "assistant-matrix",
          role: "assistant",
          content: "Partial answer",
          timestamp: 3,
          streamingState: "interrupted",
        },
      ],
    };

    await service.saveSession(session);
    assert.equal(fake.messages.get("user-matrix")?.search_text, "question");
    assert.equal(fake.messages.get("assistant-matrix")?.search_text, "");
    const metaUpsert = fake.queries.find((query) =>
      query.sql.startsWith("INSERT OR REPLACE INTO session_meta"),
    );
    assert.deepEqual(metaUpsert?.params.slice(-2), [
      "my title",
      CURRENT_SEARCH_VERSION,
    ]);

    await service.updateSessionMeta(session);
    await service.updateSessionApprovalState(session);
    await service.updateSessionUserInputRequestState(session);
    await service.updateSessionTitle(
      session.id,
      "Renamed Ｔｉｔｌｅ",
      "user",
      20,
    );
    await service.deleteMessage(session.id, "user-matrix");
    await service.deleteAllMessages(session.id);
    await service.deleteSession(session.id);

    assert.equal(fake.state?.search_revision, 18);
    assert.equal(fake.messages.size, 0);
    assert.isFalse(fake.sessions.has(session.id));
    const revisionWrites = fake.queries.filter((query) =>
      query.sql.startsWith("UPDATE chat_search_state SET search_revision"),
    );
    assert.lengthOf(revisionWrites, 8);
    assert.isTrue(revisionWrites.every((query) => query.inTransaction));

    const titleWrite = fake.queries.find(
      (query) =>
        query.sql.startsWith("UPDATE session_meta SET title = ?") &&
        query.params[0] === "Renamed Ｔｉｔｌｅ",
    );
    assert.deepEqual(titleWrite?.params.slice(-3), [
      "renamed title",
      CURRENT_SEARCH_VERSION,
      session.id,
    ]);
    const titleWriteGuards = fake.queries.filter(
      (query) =>
        query.sql ===
          "UPDATE session_meta SET search_index_version = ? WHERE id = ?" &&
        query.params[0] === -1,
    );
    assert.lengthOf(titleWriteGuards, 2);
    assert.isTrue(titleWriteGuards.every((query) => query.inTransaction));
  });

  it("atomically excludes recovered in-progress messages and revises once", async function () {
    const fake = new SemanticWriteFakeDatabase({
      target_version: CURRENT_SEARCH_VERSION,
      completed: 1,
      revision_epoch: "epoch-interrupt",
      search_revision: 3,
      updated_at: 1,
    });
    fake.messages.set("assistant-interrupt", {
      id: "assistant-interrupt",
      session_id: "session-interrupt",
      seq: 0,
      role: "assistant",
      content: "unfinished",
      timestamp: 1,
      streaming_state: "in_progress",
      search_text: "stale-visible-value",
      search_index_version: 0,
    });
    await installFakeDatabase(fake);
    const service = new SessionStorageService();
    await service.init();

    await (service as any).markInterruptedMessages("session-interrupt");
    const stored = fake.messages.get("assistant-interrupt");
    assert.equal(stored?.streaming_state, "interrupted");
    assert.equal(stored?.search_text, "");
    assert.equal(stored?.search_index_version, CURRENT_SEARCH_VERSION);
    assert.equal(fake.state?.search_revision, 4);
    const interruptionGuard = fake.queries.find(
      (query) =>
        query.sql ===
          "UPDATE messages SET search_index_version = ? WHERE session_id = ? AND streaming_state = 'in_progress'" &&
        query.params[0] === -1,
    );
    assert.exists(interruptionGuard);
    assert.isTrue(interruptionGuard!.inTransaction);

    await (service as any).markInterruptedMessages("session-interrupt");
    assert.equal(fake.state?.search_revision, 4);
  });
});
