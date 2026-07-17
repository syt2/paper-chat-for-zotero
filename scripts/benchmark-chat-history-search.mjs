#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const DEFAULT_SIZES = [10_000, 50_000, 100_000];

function parseArgs(argv) {
  const result = {
    sizes: DEFAULT_SIZES,
    runs: 40,
    warmups: 3,
    backfillBatch: 100,
    output: null,
    workdirRoot: tmpdir(),
    keep: false,
  };

  for (const arg of argv) {
    if (arg.startsWith("--sizes=")) {
      result.sizes = arg
        .slice("--sizes=".length)
        .split(",")
        .map((value) => Number(value.replaceAll("_", "")))
        .filter((value) => Number.isInteger(value) && value > 0);
    } else if (arg.startsWith("--runs=")) {
      result.runs = Math.max(1, Number(arg.slice("--runs=".length)) || 1);
    } else if (arg.startsWith("--warmups=")) {
      result.warmups = Math.max(0, Number(arg.slice("--warmups=".length)) || 0);
    } else if (arg.startsWith("--backfill-batch=")) {
      result.backfillBatch = Math.max(
        1,
        Number(arg.slice("--backfill-batch=".length)) || 1,
      );
    } else if (arg.startsWith("--output=")) {
      result.output = resolve(arg.slice("--output=".length));
    } else if (arg.startsWith("--workdir=")) {
      result.workdirRoot = resolve(arg.slice("--workdir=".length));
    } else if (arg === "--keep") {
      result.keep = true;
    } else if (arg === "--quick") {
      result.sizes = [10_000];
      result.runs = 5;
      result.warmups = 1;
    } else if (arg === "--help") {
      process.stdout
        .write(`Usage: node scripts/benchmark-chat-history-search.mjs [options]

Options:
  --sizes=10000,50000,100000  Dataset sizes
  --runs=40                   Timed runs per query
  --warmups=3                 Warmup runs per query
  --backfill-batch=100        Search-doc rows per transaction
  --output=/path/result.json  Persist structured results
  --workdir=/tmp/path         Parent for an owned temporary database directory
  --keep                      Keep generated databases
  --quick                     10k rows, 5 runs
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (result.sizes.length === 0) {
    throw new Error("At least one positive --sizes value is required.");
  }
  return result;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    minMs: round(sorted[0] || 0),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) || 0),
    meanMs: round(
      sorted.reduce((total, value) => total + value, 0) /
        Math.max(1, sorted.length),
    ),
  };
}

function timeCall(callback) {
  const startedAt = performance.now();
  const value = callback();
  return { value, elapsedMs: performance.now() - startedAt };
}

function byteSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function databaseBytes(db) {
  const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size);
  const pageCount = Number(db.prepare("PRAGMA page_count").get().page_count);
  return pageSize * pageCount;
}

function tableBytes(db) {
  try {
    return Object.fromEntries(
      db
        .prepare(
          `SELECT name, SUM(pgsize) AS bytes
           FROM dbstat
           GROUP BY name
           ORDER BY name`,
        )
        .all()
        .map((row) => [String(row.name), Number(row.bytes)]),
    );
  } catch {
    return null;
  }
}

function storageSnapshot(db, path) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return {
    databaseBytes: databaseBytes(db),
    fileBytes: byteSize(path),
    tables: tableBytes(db),
  };
}

function configureDatabase(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);
}

function createBaseSchema(db) {
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY COLLATE BINARY,
      search_title TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE messages (
      message_id TEXT PRIMARY KEY COLLATE BINARY,
      session_id TEXT NOT NULL COLLATE BINARY,
      message_seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_timestamp INTEGER NOT NULL,
      content TEXT NOT NULL,
      hidden_payload TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX idx_messages_session_seq
      ON messages(session_id COLLATE BINARY, message_seq DESC);
  `);
}

function installInlineSchema(db) {
  db.exec(`
    ALTER TABLE messages
      ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
    ALTER TABLE messages
      ADD COLUMN search_index_version INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX idx_messages_search_work
      ON messages(search_index_version, message_id COLLATE BINARY);
  `);
}

function installMaterializedSchema(db) {
  db.exec(`
    CREATE TABLE message_search_docs (
      docid INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE COLLATE BINARY,
      session_id TEXT NOT NULL COLLATE BINARY,
      message_seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_timestamp INTEGER NOT NULL,
      display_text TEXT NOT NULL DEFAULT '',
      search_text TEXT NOT NULL DEFAULT '',
      search_index_version INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX idx_search_docs_session_seq
      ON message_search_docs(session_id COLLATE BINARY, message_seq DESC);
  `);
}

const BASE_TEXT =
  "这是一段用于模拟论文讨论的可见消息，包含实验设计、统计结果、方法限制和后续问题。 " +
  "The visible answer discusses methods, evidence, limitations, and reproducible evaluation. ";
const HIDDEN_TEXT =
  "hidden reasoning tool result attachment payload should never be searchable ";
const MEDIUM_HIDDEN_PAYLOAD = "m".repeat(2 * 1024);
const LARGE_HIDDEN_PAYLOAD = "l".repeat(14 * 1024);

function normalizeSearchValue(value) {
  return value
    .normalize("NFKC")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, " ")
    .trim();
}

function projectRawContent(content) {
  const displayText = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return {
    displayText,
    searchText: normalizeSearchValue(displayText),
  };
}

function messageContent(index) {
  let text = `${BASE_TEXT}${BASE_TEXT}RECORD ${index}.\r\n`;
  if (index % 5 === 0) text += " 研究方法需要对照实验。";
  if (index % 11 === 0) text += " Retrieval benchmark evidence.";
  if (index % 29 === 0) text += " ALPHA separated evidence BETA.";
  if (index % 97 === 0) text += " 量子证据只在少量记录出现。";
  if (index % 10 !== 0) text += " broadmatch sensitivity marker.";
  return text;
}

function hiddenPayload(index) {
  let payload = `${HIDDEN_TEXT}${index % 13 === 0 ? "secret-match" : ""}`;
  if (index % 10 === 0) payload += MEDIUM_HIDDEN_PAYLOAD;
  if (index % 100 === 0) payload += LARGE_HIDDEN_PAYLOAD;
  return payload;
}

function populateMessages(db, messageCount) {
  const sessionCount = Math.min(
    1_000,
    Math.max(1, Math.ceil(messageCount / 100)),
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions(session_id, search_title, updated_at)
     VALUES (?, ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages(
       message_id, session_id, message_seq, role, message_timestamp,
       content, hidden_payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const startedAt = performance.now();
  let contentBytes = 0;
  let hiddenPayloadBytes = 0;
  let maxHiddenPayloadBytes = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
      const sessionId = `session-${String(sessionIndex).padStart(6, "0")}`;
      const title =
        sessionIndex % 50 === 0
          ? `研究方法 session ${sessionIndex}`
          : `paper discussion ${sessionIndex}`;
      insertSession.run(sessionId, title, 1_800_000_000_000 - sessionIndex);
    }

    for (let index = 0; index < messageCount; index += 1) {
      const sessionIndex = index % sessionCount;
      const sessionId = `session-${String(sessionIndex).padStart(6, "0")}`;
      const messageId = `message-${String(index).padStart(9, "0")}`;
      const content = messageContent(index);
      const hidden = hiddenPayload(index);
      const hiddenBytes = Buffer.byteLength(hidden);
      contentBytes += Buffer.byteLength(content);
      hiddenPayloadBytes += hiddenBytes;
      maxHiddenPayloadBytes = Math.max(maxHiddenPayloadBytes, hiddenBytes);
      insertMessage.run(
        messageId,
        sessionId,
        Math.floor(index / sessionCount),
        index % 2 === 0 ? "user" : "assistant",
        1_700_000_000_000 + index,
        content,
        hidden,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    sessionCount,
    elapsedMs: performance.now() - startedAt,
    contentBytes,
    hiddenPayloadBytes,
    averageHiddenPayloadBytes: round(hiddenPayloadBytes / messageCount),
    maxHiddenPayloadBytes,
  };
}

function backfillSearchDocs(db, batchSize) {
  const selectBatch = db.prepare(
    `SELECT m.message_id,
       m.session_id,
       m.message_seq,
       m.role,
       m.message_timestamp,
       m.content
     FROM messages m
     LEFT JOIN message_search_docs d ON d.message_id = m.message_id
     WHERE d.message_id IS NULL OR d.search_index_version < 1
     ORDER BY m.message_id COLLATE BINARY
     LIMIT ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO message_search_docs(
       message_id, session_id, message_seq, role, message_timestamp,
       display_text, search_text, search_index_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(message_id) DO UPDATE SET
       session_id = excluded.session_id,
       message_seq = excluded.message_seq,
       role = excluded.role,
       message_timestamp = excluded.message_timestamp,
       display_text = excluded.display_text,
       search_text = excluded.search_text,
       search_index_version = excluded.search_index_version`,
  );
  const sliceTimes = [];
  const transactionTimes = [];
  const startedAt = performance.now();
  let rowsWritten = 0;

  while (true) {
    const sliceStartedAt = performance.now();
    const rows = selectBatch.all(batchSize);
    if (rows.length === 0) break;
    const projectedRows = rows.map((row) => ({
      ...row,
      ...projectRawContent(String(row.content)),
    }));

    const transactionStartedAt = performance.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of projectedRows) {
        upsert.run(
          row.message_id,
          row.session_id,
          row.message_seq,
          row.role,
          row.message_timestamp,
          row.displayText,
          row.searchText,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    rowsWritten += rows.length;
    transactionTimes.push(performance.now() - transactionStartedAt);
    sliceTimes.push(performance.now() - sliceStartedAt);
  }

  return {
    rowsWritten,
    batches: transactionTimes.length,
    totalMs: round(performance.now() - startedAt),
    rowsPerSecond: round(
      rowsWritten / Math.max(0.001, (performance.now() - startedAt) / 1_000),
    ),
    transaction: summarize(transactionTimes),
    slice: summarize(sliceTimes),
  };
}

function backfillInlineSearchColumns(db, batchSize) {
  const selectBatch = db.prepare(
    `SELECT message_id, content
     FROM messages
     WHERE search_index_version < 1
     ORDER BY search_index_version ASC, message_id COLLATE BINARY ASC
     LIMIT ?`,
  );
  const writeProjection = db.prepare(
    `UPDATE messages
     SET search_text = ?, search_index_version = 1
     WHERE message_id = ?
       AND content = ?
       AND search_index_version < 1`,
  );
  const sliceTimes = [];
  const transactionTimes = [];
  const startedAt = performance.now();
  let rowsWritten = 0;

  while (true) {
    const sliceStartedAt = performance.now();
    const rows = selectBatch.all(batchSize);
    if (rows.length === 0) break;
    const projectedRows = rows.map((row) => ({
      messageId: row.message_id,
      rawContent: String(row.content),
      searchText: normalizeSearchValue(String(row.content)),
    }));

    const transactionStartedAt = performance.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of projectedRows) {
        const result = writeProjection.run(
          row.searchText,
          row.messageId,
          row.rawContent,
        );
        rowsWritten += Number(result.changes);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    transactionTimes.push(performance.now() - transactionStartedAt);
    sliceTimes.push(performance.now() - sliceStartedAt);
  }

  const totalMs = performance.now() - startedAt;
  return {
    rowsWritten,
    batches: transactionTimes.length,
    totalMs: round(totalMs),
    rowsPerSecond: round(rowsWritten / Math.max(0.001, totalMs / 1_000)),
    transaction: summarize(transactionTimes),
    slice: summarize(sliceTimes),
  };
}

function installFts(db) {
  const startedAt = performance.now();
  try {
    db.exec(`
      CREATE VIRTUAL TABLE message_search_fts USING fts5(
        search_text,
        content='message_search_docs',
        content_rowid='docid',
        tokenize='trigram'
      );
      INSERT INTO message_search_fts(message_search_fts) VALUES('rebuild');
      INSERT INTO message_search_fts(message_search_fts) VALUES('optimize');
    `);
    return { supported: true, buildMs: round(performance.now() - startedAt) };
  } catch (error) {
    return {
      supported: false,
      buildMs: round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function ftsLiteral(terms) {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function buildGroupQuery(engine, termCount) {
  const source =
    engine === "message-instr" ? "messages" : "message_search_docs";
  const alias = "d";
  const ftsJoin =
    engine === "doc-fts"
      ? `JOIN message_search_fts
           ON message_search_fts.rowid = d.docid`
      : "";
  const ftsPredicate =
    engine === "doc-fts" ? "message_search_fts MATCH ? AND" : "";
  const termPredicates = Array.from(
    { length: termCount },
    () => `instr(${alias}.search_text, ?) > 0`,
  ).join(" AND ");

  return `SELECT session_id,
      session_updated_at,
      total_message_matches,
      category,
      message_id,
      message_rank,
      message_timestamp,
      message_seq
    FROM (
    WITH message_matches AS MATERIALIZED (
      SELECT
        d.session_id,
        d.message_id,
        d.message_seq,
        d.message_timestamp,
        CASE WHEN instr(d.search_text, ?) > 0 THEN 0 ELSE 1 END AS message_rank
      FROM ${source} d
      ${ftsJoin}
      WHERE ${ftsPredicate} ${termPredicates}
    ),
    message_groups AS (
      SELECT
        session_id,
        COUNT(*) AS total_message_matches,
        MIN(message_rank) AS best_message_rank
      FROM message_matches
      GROUP BY session_id
    ),
    title_matches AS (
      SELECT
        session_id,
        CASE WHEN search_title = ? THEN 0 ELSE 1 END AS title_rank
      FROM sessions
      WHERE instr(search_title, ?) > 0
    ),
    grouped AS (
      SELECT
        s.session_id,
        s.updated_at AS session_updated_at,
        COALESCE(m.total_message_matches, 0) AS total_message_matches,
        CASE
          WHEN t.title_rank IS NOT NULL THEN t.title_rank
          WHEN m.best_message_rank = 0 THEN 2
          ELSE 3
        END AS category
      FROM sessions s
      LEFT JOIN message_groups m ON m.session_id = s.session_id
      LEFT JOIN title_matches t ON t.session_id = s.session_id
      WHERE m.session_id IS NOT NULL OR t.session_id IS NOT NULL
    ),
    top_groups AS MATERIALIZED (
      SELECT *
      FROM grouped
      ORDER BY
        category ASC,
        session_updated_at DESC,
        session_id COLLATE BINARY ASC
      LIMIT 21
    ),
    ranked_messages AS (
      SELECT
        m.*,
        ROW_NUMBER() OVER (
          PARTITION BY m.session_id
          ORDER BY
            m.message_rank ASC,
            m.message_timestamp DESC,
            m.message_seq DESC,
            m.message_id COLLATE BINARY ASC
        ) AS row_number
      FROM message_matches m
      INNER JOIN top_groups g ON g.session_id = m.session_id
    )
    SELECT
      g.session_id,
      g.session_updated_at,
      g.total_message_matches,
      g.category,
      r.message_id,
      r.message_rank,
      r.message_timestamp,
      r.message_seq,
      r.row_number AS message_row_number
    FROM top_groups g
    LEFT JOIN ranked_messages r
      ON r.session_id = g.session_id AND r.row_number <= 3
    )
    ORDER BY
      category ASC,
      session_updated_at DESC,
      session_id COLLATE BINARY ASC,
      message_row_number ASC`;
}

function queryParams(searchCase, engine) {
  const params = [searchCase.phrase];
  if (engine === "doc-fts") params.push(ftsLiteral(searchCase.terms));
  params.push(...searchCase.terms, searchCase.phrase, searchCase.phrase);
  return params;
}

function resultSignature(rows) {
  return rows
    .map(
      (row) =>
        `${row.session_id}:${row.total_message_matches}:${row.category}:${row.message_id || ""}`,
    )
    .join("|");
}

function seedFromString(value) {
  let seed = 2_166_136_261;
  for (const character of value) {
    seed ^= character.codePointAt(0);
    seed = Math.imul(seed, 16_777_619);
  }
  return seed >>> 0;
}

function deterministicShuffle(values, seed) {
  const shuffled = [...values];
  let state = seed || 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = next() % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

function benchmarkSearchCase(
  searchCase,
  engineDefinitions,
  warmups,
  runs,
  seed,
) {
  const engines = engineDefinitions.map(({ engine, db }) => ({
    engine,
    statement: db.prepare(buildGroupQuery(engine, searchCase.terms.length)),
    params: queryParams(searchCase, engine),
    times: [],
    rows: [],
  }));

  for (let index = 0; index < warmups; index += 1) {
    const order = deterministicShuffle(engines, seed + index);
    for (const engine of order) engine.statement.all(...engine.params);
  }

  for (let index = 0; index < runs; index += 1) {
    const order = deterministicShuffle(engines, seed + warmups + index);
    for (const engine of order) {
      const measured = timeCall(() => engine.statement.all(...engine.params));
      engine.rows = measured.value;
      engine.times.push(measured.elapsedMs);
    }
  }

  const canonical = engines.find(({ engine }) => engine === "message-instr");
  const canonicalSignature = resultSignature(canonical.rows);
  return engines.map((engine) => ({
    case: searchCase.name,
    engine: engine.engine,
    timedRuns: runs,
    ...summarize(engine.times),
    returnedRows: engine.rows.length,
    matchesCanonical: resultSignature(engine.rows) === canonicalSignature,
  }));
}

function snapshotConcurrencyProbe(dbPath) {
  const reader = new DatabaseSync(dbPath);
  const writer = new DatabaseSync(dbPath);
  configureDatabase(reader);
  configureDatabase(writer);
  try {
    reader.exec("BEGIN");
    const sessionId = String(
      reader
        .prepare(
          "SELECT session_id FROM sessions ORDER BY session_id COLLATE BINARY LIMIT 1",
        )
        .get().session_id,
    );
    const readUpdatedAt = () =>
      Number(
        reader
          .prepare("SELECT updated_at FROM sessions WHERE session_id = ?")
          .get(sessionId).updated_at,
      );
    const before = readUpdatedAt();
    const measured = timeCall(() => {
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare(
          "UPDATE sessions SET updated_at = updated_at + 1 WHERE session_id = ?",
        )
        .run(sessionId);
      writer.exec("COMMIT");
    });
    const during = readUpdatedAt();
    reader.exec("COMMIT");
    const after = readUpdatedAt();
    return {
      probeScope:
        "WAL snapshot semantics only; synchronous Node execution does not overlap a long search with the writer.",
      writerCommitMs: round(measured.elapsedMs),
      readerHeldStableSnapshot: before === during,
      readerObservedAfterCommit: after === before + 1,
    };
  } finally {
    try {
      reader.exec("ROLLBACK");
    } catch {
      // Already committed.
    }
    reader.close();
    writer.close();
  }
}

const SEARCH_CASES = [
  { name: "zh2-common", phrase: "研究", terms: ["研究"], ftsEligible: false },
  { name: "zh2-none", phrase: "火星", terms: ["火星"], ftsEligible: false },
  {
    name: "en-common",
    phrase: "retrieval",
    terms: ["retrieval"],
    ftsEligible: true,
  },
  {
    name: "en-near-all-90pct",
    phrase: "broadmatch",
    terms: ["broadmatch"],
    ftsEligible: true,
  },
  {
    name: "en-multi-and",
    phrase: "alpha beta",
    terms: ["alpha", "beta"],
    ftsEligible: true,
  },
  {
    name: "zh4-rare",
    phrase: "量子证据",
    terms: ["量子证据"],
    ftsEligible: true,
  },
  {
    name: "en-none",
    phrase: "nonexistentterm",
    terms: ["nonexistentterm"],
    ftsEligible: true,
  },
];

function runDataset(options, messageCount) {
  const inlineDbPath = join(
    options.workdir,
    `history-search-${messageCount}-inline.sqlite`,
  );
  const materializedDbPath = join(
    options.workdir,
    `history-search-${messageCount}-materialized.sqlite`,
  );
  for (const path of [inlineDbPath, materializedDbPath]) {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }

  let inlineDb = new DatabaseSync(inlineDbPath);
  configureDatabase(inlineDb);
  createBaseSchema(inlineDb);
  const population = populateMessages(inlineDb, messageCount);
  const baseStorage = storageSnapshot(inlineDb, inlineDbPath);
  inlineDb.close();
  copyFileSync(inlineDbPath, materializedDbPath);

  inlineDb = new DatabaseSync(inlineDbPath);
  const materializedDb = new DatabaseSync(materializedDbPath);
  configureDatabase(inlineDb);
  configureDatabase(materializedDb);

  installInlineSchema(inlineDb);
  const inlineBackfill = backfillInlineSearchColumns(
    inlineDb,
    options.backfillBatch,
  );
  const inlineStorage = storageSnapshot(inlineDb, inlineDbPath);

  installMaterializedSchema(materializedDb);
  const documentBackfill = backfillSearchDocs(
    materializedDb,
    options.backfillBatch,
  );
  const documentStorage = storageSnapshot(materializedDb, materializedDbPath);

  const fts = installFts(materializedDb);
  const ftsStorage = storageSnapshot(materializedDb, materializedDbPath);

  const queryResults = [];
  for (const searchCase of SEARCH_CASES) {
    const engineDefinitions = [
      { engine: "message-instr", db: inlineDb },
      { engine: "doc-instr", db: materializedDb },
    ];
    if (fts.supported && searchCase.ftsEligible) {
      engineDefinitions.push({ engine: "doc-fts", db: materializedDb });
    }
    queryResults.push(
      ...benchmarkSearchCase(
        searchCase,
        engineDefinitions,
        options.warmups,
        options.runs,
        seedFromString(`${messageCount}:${searchCase.name}`),
      ),
    );
  }

  inlineDb.close();
  materializedDb.close();
  const concurrency = snapshotConcurrencyProbe(materializedDbPath);

  return {
    messageCount,
    sessionCount: population.sessionCount,
    databasePaths: options.keep
      ? { inline: inlineDbPath, materialized: materializedDbPath }
      : undefined,
    populationMs: round(population.elapsedMs),
    payloadProfile: {
      contentBytes: population.contentBytes,
      hiddenPayloadBytes: population.hiddenPayloadBytes,
      averageHiddenPayloadBytes: population.averageHiddenPayloadBytes,
      maxHiddenPayloadBytes: population.maxHiddenPayloadBytes,
      largeHiddenPayloadEveryMessages: 100,
      mediumHiddenPayloadEveryMessages: 10,
    },
    storage: {
      base: baseStorage,
      withInlineColumns: inlineStorage,
      withSearchDocuments: documentStorage,
      withFts: ftsStorage,
      inlineOverheadBytes:
        inlineStorage.databaseBytes - baseStorage.databaseBytes,
      searchDocumentOverheadBytes:
        documentStorage.databaseBytes - baseStorage.databaseBytes,
      ftsOverheadBytes:
        ftsStorage.databaseBytes - documentStorage.databaseBytes,
    },
    backfill: {
      inlineColumns: inlineBackfill,
      materializedDocuments: documentBackfill,
    },
    fts,
    concurrency,
    queries: queryResults,
  };
}

function runtimeInfo() {
  const db = new DatabaseSync(":memory:");
  const sqliteVersion = String(
    db.prepare("SELECT sqlite_version() AS version").get().version,
  );
  const compileOptions = db
    .prepare("PRAGMA compile_options")
    .all()
    .map((row) => String(row.compile_options));
  let trigramSupported = false;
  try {
    db.exec(
      "CREATE VIRTUAL TABLE probe_fts USING fts5(text, tokenize='trigram')",
    );
    trigramSupported = true;
  } catch {
    trigramSupported = false;
  }
  db.close();
  return {
    benchmarkRuntime: "Node.js node:sqlite",
    authoritativeForZoteroRuntime: false,
    qualification:
      "Use these results for architecture comparison only. Re-run representative probes through Zotero.DBConnection before setting Zotero latency gates.",
    node: process.version,
    sqliteVersion,
    fts5Compiled: compileOptions.includes("ENABLE_FTS5"),
    trigramSupported,
  };
}

const options = parseArgs(process.argv.slice(2));
mkdirSync(options.workdirRoot, { recursive: true });
options.workdir = mkdtempSync(
  join(options.workdirRoot, "paperchat-history-search-"),
);
const startedAt = performance.now();
const output = {
  generatedAt: new Date().toISOString(),
  runtime: runtimeInfo(),
  config: {
    sizes: options.sizes,
    runs: options.runs,
    warmups: options.warmups,
    backfillBatch: options.backfillBatch,
    workdir: options.workdir,
    keep: options.keep,
    engineScheduling: "deterministic interleaved shuffle",
    productionPragmasOnly: ["journal_mode=WAL", "foreign_keys=ON"],
  },
  datasets: [],
};

for (const size of options.sizes) {
  process.stderr.write(`Benchmarking ${size.toLocaleString()} messages...\n`);
  output.datasets.push(runDataset(options, size));
}
output.totalMs = round(performance.now() - startedAt);

const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (options.output) {
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, serialized, "utf8");
}
process.stdout.write(serialized);

if (!options.keep) {
  rmSync(options.workdir, { recursive: true, force: true });
}
