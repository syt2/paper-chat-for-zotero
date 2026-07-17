#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";
import type { ChatMessage } from "../src/types/chat";
import { LowerVersionMessagePartitionAccumulator } from "../src/modules/chat/search/SearchAggregation";
import {
  getMessageSearchFastDecision,
  projectMessageSearchNormalizedText,
} from "../src/modules/chat/search/SearchProjection";
import {
  parseSearchQuery,
  type ParsedSearchQuery,
} from "../src/modules/chat/search/SearchQuery";

const DEFAULT_MESSAGE_COUNT = 100_000;
const DEFAULT_SESSION_COUNT = 1_000;
const DEFAULT_RUNS = 20;
const DEFAULT_WARMUPS = 3;
const DEFAULT_PAGE_SIZE = 100;
const HIGH_MATCH_TERM = "broadmatch";
const PROJECT_HEAVY_TERM = "broad-match";
const NO_MATCH_TERM = "nonexistentterm";
const LATENCY_BUDGET_MS = 2_000;
const HEAP_BUDGET_BYTES = 32 * 1024 * 1024;

interface BenchmarkOptions {
  messageCount: number;
  sessionCount: number;
  runs: number;
  warmups: number;
  pageSize: number;
}

interface FixtureMessage {
  message: ChatMessage;
  sessionId: string;
  sessionTitle: string;
  sessionUpdatedAt: number;
  sessionMessageCount: number;
  messageSeq: number;
}

interface BenchmarkFixture {
  messageCount: number;
  sessionCount: number;
  sessionMessageCounts: Uint32Array;
  expectedHighMatches: number;
}

interface DecisionCounts {
  skip: number;
  exactMatch: number;
  project: number;
}

interface ScanResult {
  matchedMessages: number;
  matchedSessions: number;
  retainedCandidates: number;
  decisionCounts: DecisionCounts;
  checksum: string;
}

interface BenchmarkCase {
  name: "high-match" | "no-match" | "project-heavy";
  query: ParsedSearchQuery;
  expected: {
    matchedMessages: number;
    matchedSessions?: number;
    retainedCandidates?: number;
    decisionCounts: DecisionCounts;
    checksum?: string;
  };
}

type ScanScheduling = "tight-loop" | "paged-async";

interface HeapOnlyRequest {
  caseName: BenchmarkCase["name"];
  scheduling: ScanScheduling;
}

function readPositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value.replaceAll("_", ""));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive safe integer`);
  }
  return parsed;
}

function readNonNegativeInteger(value: string, optionName: string): number {
  const parsed = Number(value.replaceAll("_", ""));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative safe integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    messageCount: DEFAULT_MESSAGE_COUNT,
    sessionCount: DEFAULT_SESSION_COUNT,
    runs: DEFAULT_RUNS,
    warmups: DEFAULT_WARMUPS,
    pageSize: DEFAULT_PAGE_SIZE,
  };

  for (const argument of argv) {
    if (argument.startsWith("--messages=")) {
      options.messageCount = readPositiveInteger(
        argument.slice("--messages=".length),
        "--messages",
      );
    } else if (argument.startsWith("--sessions=")) {
      options.sessionCount = readPositiveInteger(
        argument.slice("--sessions=".length),
        "--sessions",
      );
    } else if (argument.startsWith("--runs=")) {
      options.runs = readPositiveInteger(
        argument.slice("--runs=".length),
        "--runs",
      );
    } else if (argument.startsWith("--warmups=")) {
      options.warmups = readNonNegativeInteger(
        argument.slice("--warmups=".length),
        "--warmups",
      );
    } else if (argument.startsWith("--page-size=")) {
      options.pageSize = readPositiveInteger(
        argument.slice("--page-size=".length),
        "--page-size",
      );
    } else if (argument === "--quick") {
      options.messageCount = 10_000;
      options.sessionCount = 100;
      options.runs = 5;
      options.warmups = 1;
    } else if (argument.startsWith("--heap-only=")) {
      continue;
    } else if (argument === "--help") {
      process.stdout.write(`Usage:
  node --expose-gc --import tsx scripts/benchmark-chat-history-source-fallback.ts [options]

Options:
  --messages=100000  Number of fully unindexed source messages
  --sessions=1000    Number of sessions represented by the messages
  --runs=20          Timed scans per search case
  --warmups=3        Warmup scans per search case
  --page-size=100    Heap sampling interval, matching source scan pages
  --quick             10k messages, one warmup, five timed scans
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  options.sessionCount = Math.min(options.sessionCount, options.messageCount);
  return options;
}

function parseHeapOnlyRequest(argv: readonly string[]): HeapOnlyRequest | null {
  const argument = argv.find((value) => value.startsWith("--heap-only="));
  if (!argument) return null;
  const [caseName, scheduling] = argument
    .slice("--heap-only=".length)
    .split(":");
  if (
    (caseName !== "high-match" &&
      caseName !== "no-match" &&
      caseName !== "project-heavy") ||
    (scheduling !== "tight-loop" && scheduling !== "paged-async")
  ) {
    throw new Error(`Invalid heap-only request: ${argument}`);
  }
  return { caseName, scheduling };
}

function assistantContent(variant: number, searchWord: string): string {
  switch (variant) {
    case 0:
      return `## Main finding\nThe ${searchWord} result is stable across repeated trials.\n\nThe confidence interval and limitations remain visible to the reader.`;
    case 1:
      return `The ${searchWord} result is supported by the reported evidence. See [the paper](https://example.test/paper) for the study design.`;
    case 2:
      return `See [the paper](https://example.test/paper) for context. The ${searchWord} result remains visible after the link.`;
    case 3:
      return `<source-group label="Evidence">The controlled study reports reproducible measurements.</source-group>\nThe ${searchWord} result follows the cited evidence.`;
    default:
      return `AT&amp;T terminology precedes the result. The ${searchWord} conclusion is visible after entity decoding.`;
  }
}

function buildFixture(options: BenchmarkOptions): BenchmarkFixture {
  const sessionMessageCounts = new Uint32Array(options.sessionCount);
  let expectedHighMatches = 0;
  for (
    let messageIndex = 0;
    messageIndex < options.messageCount;
    messageIndex += 1
  ) {
    const conversationIndex = Math.floor(messageIndex / 2);
    const sessionIndex = conversationIndex % options.sessionCount;
    const sessionRound = Math.floor(conversationIndex / options.sessionCount);
    sessionMessageCounts[sessionIndex] += 1;
    if (sessionRound % 10 !== 0) expectedHighMatches += 1;
  }
  return {
    messageCount: options.messageCount,
    sessionCount: options.sessionCount,
    sessionMessageCounts,
    expectedHighMatches,
  };
}

function buildFixtureMessage(
  fixture: BenchmarkFixture,
  messageIndex: number,
): FixtureMessage {
  const conversationIndex = Math.floor(messageIndex / 2);
  const role: ChatMessage["role"] =
    messageIndex % 2 === 0 ? "user" : "assistant";
  const sessionIndex = conversationIndex % fixture.sessionCount;
  const sessionRound = Math.floor(conversationIndex / fixture.sessionCount);
  const expectedHighMatch = sessionRound % 10 !== 0;
  const searchWord = expectedHighMatch
    ? `${HIGH_MATCH_TERM} and ${PROJECT_HEAVY_TERM}`
    : "control";
  const variant = Math.floor(sessionRound / 10) % 5;
  const sessionId = `session-${String(sessionIndex).padStart(6, "0")}`;
  const content =
    role === "user"
      ? `Hidden transport context.\n[Question]: How does ${searchWord} affect the reported method and evidence?`
      : assistantContent(variant, searchWord);
  const message: ChatMessage = {
    id: `message-${String(messageIndex).padStart(9, "0")}`,
    role,
    content,
    timestamp: 1_800_000_000_000 - messageIndex,
  };
  if (role === "user") {
    message.selectedText =
      "The selected passage describes the experiment, evidence, and limitations.";
  }

  return {
    message,
    sessionId,
    sessionTitle: `Paper discussion ${sessionIndex}`,
    sessionUpdatedAt: 1_900_000_000_000 - sessionIndex,
    sessionMessageCount: fixture.sessionMessageCounts[sessionIndex],
    messageSeq: sessionRound * 2 + (role === "assistant" ? 1 : 0),
  };
}

function projectSourceMessage(
  message: ChatMessage,
  query: ParsedSearchQuery,
  decisionCounts: DecisionCounts,
): string | null {
  const decision = getMessageSearchFastDecision(message, query);
  decisionCounts[decision] += 1;
  if (decision === "skip") return null;
  if (decision === "exactMatch") return query.exactPhrase;
  return projectMessageSearchNormalizedText(message);
}

function checksumPartition(
  summaries: ReturnType<
    LowerVersionMessagePartitionAccumulator["finish"]
  >["messageSummaries"],
): string {
  let hash = 2_166_136_261;
  for (const summary of summaries) {
    const candidateTuples = summary.topMessageCandidates
      .map(
        (candidate) =>
          `${candidate.messageId},${candidate.role},${candidate.category},${candidate.messageTimestamp},${candidate.messageSeq}`,
      )
      .join("|");
    const value = `${summary.sessionId}:${summary.totalMessageMatches}:${summary.bestMessageCategory}:${candidateTuples}`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function yieldSourcePage(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function runSourceFallbackScan(
  fixture: BenchmarkFixture,
  query: ParsedSearchQuery,
  pageSize: number,
  scheduling: ScanScheduling,
  sampleHeap?: () => void,
): Promise<ScanResult> {
  const decisionCounts: DecisionCounts = {
    skip: 0,
    exactMatch: 0,
    project: 0,
  };
  const accumulator = new LowerVersionMessagePartitionAccumulator(query, 3);

  for (
    let pageStart = 0;
    pageStart < fixture.messageCount;
    pageStart += pageSize
  ) {
    const pageLength = Math.min(pageSize, fixture.messageCount - pageStart);
    const page = Array.from({ length: pageLength }, (_, offset) =>
      buildFixtureMessage(fixture, pageStart + offset),
    );
    for (const row of page) {
      const normalizedText = projectSourceMessage(
        row.message,
        query,
        decisionCounts,
      );
      if (normalizedText !== null) {
        accumulator.add({
          sessionId: row.sessionId,
          sessionTitle: row.sessionTitle,
          sessionUpdatedAt: row.sessionUpdatedAt,
          sessionMessageCount: row.sessionMessageCount,
          messageId: row.message.id,
          role: row.message.role,
          messageTimestamp: row.message.timestamp,
          messageSeq: row.messageSeq,
          normalizedText,
        });
      }
    }
    if (scheduling === "paged-async") await yieldSourcePage();
    sampleHeap?.();
  }

  const partition = accumulator.finish();
  sampleHeap?.();
  return {
    matchedMessages: partition.messageSummaries.reduce(
      (total, summary) => total + summary.totalMessageMatches,
      0,
    ),
    matchedSessions: partition.messageSummaries.length,
    retainedCandidates: partition.messageSummaries.reduce(
      (total, summary) => total + summary.topMessageCandidates.length,
      0,
    ),
    decisionCounts,
    checksum: checksumPartition(partition.messageSummaries),
  };
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  return sortedValues[index];
}

function round(value: number, digits: number = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isCanonicalGateConfig(options: BenchmarkOptions): boolean {
  return (
    options.messageCount === DEFAULT_MESSAGE_COUNT &&
    options.sessionCount === DEFAULT_SESSION_COUNT &&
    options.pageSize === DEFAULT_PAGE_SIZE &&
    options.runs >= DEFAULT_RUNS &&
    options.warmups >= DEFAULT_WARMUPS
  );
}

function summarize(times: readonly number[]) {
  const sorted = [...times].sort((left, right) => left - right);
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

function forceGc(): void {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!gc) {
    throw new Error(
      "Heap measurements require Node's --expose-gc flag. See --help.",
    );
  }
  gc();
}

function assertScanResult(
  benchmarkCase: BenchmarkCase,
  result: ScanResult,
): void {
  const expected = benchmarkCase.expected;
  if (
    result.matchedMessages !== expected.matchedMessages ||
    (expected.matchedSessions !== undefined &&
      result.matchedSessions !== expected.matchedSessions) ||
    (expected.retainedCandidates !== undefined &&
      result.retainedCandidates !== expected.retainedCandidates) ||
    (expected.checksum !== undefined &&
      result.checksum !== expected.checksum) ||
    result.decisionCounts.skip !== expected.decisionCounts.skip ||
    result.decisionCounts.exactMatch !== expected.decisionCounts.exactMatch ||
    result.decisionCounts.project !== expected.decisionCounts.project
  ) {
    throw new Error(
      `${benchmarkCase.name} result mismatch:\nactual=${JSON.stringify(result)}\nexpected=${JSON.stringify(expected)}`,
    );
  }
}

async function measureHeap(
  fixture: BenchmarkFixture,
  benchmark: BenchmarkCase,
  options: BenchmarkOptions,
  scheduling: ScanScheduling,
) {
  forceGc();
  const baselineBytes = process.memoryUsage().heapUsed;
  let peakBytes = baselineBytes;
  const result = await runSourceFallbackScan(
    fixture,
    benchmark.query,
    options.pageSize,
    scheduling,
    () => {
      peakBytes = Math.max(peakBytes, process.memoryUsage().heapUsed);
    },
  );
  assertScanResult(benchmark, result);
  peakBytes = Math.max(peakBytes, process.memoryUsage().heapUsed);
  forceGc();
  const retainedBytesAfterGc = process.memoryUsage().heapUsed;
  const peakDeltaBytes = Math.max(0, peakBytes - baselineBytes);
  return {
    scheduling,
    baselineBytes,
    peakBytes,
    peakDeltaBytes,
    peakDeltaMiB: round(peakDeltaBytes / (1024 * 1024)),
    retainedDeltaBytesAfterGc: Math.max(
      0,
      retainedBytesAfterGc - baselineBytes,
    ),
  };
}

function measureHeapInFreshProcess(
  benchmark: BenchmarkCase,
  options: BenchmarkOptions,
  scheduling: ScanScheduling,
): Awaited<ReturnType<typeof measureHeap>> {
  const scriptPath = process.argv[1];
  if (!scriptPath) throw new Error("Benchmark script path is unavailable");
  const output = execFileSync(
    process.execPath,
    [
      ...process.execArgv,
      scriptPath,
      `--messages=${options.messageCount}`,
      `--sessions=${options.sessionCount}`,
      `--runs=${options.runs}`,
      `--warmups=${options.warmups}`,
      `--page-size=${options.pageSize}`,
      `--heap-only=${benchmark.name}:${scheduling}`,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(output) as Awaited<ReturnType<typeof measureHeap>>;
}

async function benchmarkCase(
  fixture: BenchmarkFixture,
  benchmark: BenchmarkCase,
  options: BenchmarkOptions,
) {
  let representative: ScanResult | null = null;
  for (let index = 0; index < options.warmups; index += 1) {
    representative = await runSourceFallbackScan(
      fixture,
      benchmark.query,
      options.pageSize,
      "paged-async",
    );
    assertScanResult(benchmark, representative);
  }

  forceGc();
  const times: number[] = [];
  for (let index = 0; index < options.runs; index += 1) {
    const startedAt = performance.now();
    representative = await runSourceFallbackScan(
      fixture,
      benchmark.query,
      options.pageSize,
      "paged-async",
    );
    times.push(performance.now() - startedAt);
    assertScanResult(benchmark, representative);
  }

  const tightLoopHeap = measureHeapInFreshProcess(
    benchmark,
    options,
    "tight-loop",
  );
  const pagedAsyncHeap = measureHeapInFreshProcess(
    benchmark,
    options,
    "paged-async",
  );

  const latency = summarize(times);
  return {
    name: benchmark.name,
    query: benchmark.query.normalizedQuery,
    timedRuns: options.runs,
    warmupRuns: options.warmups,
    latency: {
      scheduling:
        "setImmediate after each source page, modeling db.queryAsync pagination",
      ...latency,
    },
    heap: {
      measurement:
        "Maximum process.memoryUsage().heapUsed sampled after each source page in a fresh child process; compact fixture metadata is resident before the baseline and rows are materialized one page at a time.",
      tightLoopConservative: tightLoopHeap,
      pagedAsync: pagedAsyncHeap,
    },
    result: representative,
    gates: isCanonicalGateConfig(options)
      ? {
          p95Under2s: latency.p95Ms < LATENCY_BUDGET_MS,
          pagedAsyncPeakHeapUnder32MiB:
            pagedAsyncHeap.peakDeltaBytes < HEAP_BUDGET_BYTES,
        }
      : undefined,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseArgs(argv);
  const heapOnlyRequest = parseHeapOnlyRequest(argv);
  forceGc();
  const heapBeforeFixtureBytes = process.memoryUsage().heapUsed;
  if (!heapOnlyRequest) {
    process.stderr.write(
      `Building ${options.messageCount.toLocaleString()} paged production-projection rows...\n`,
    );
  }
  const fixture = buildFixture(options);
  forceGc();
  const fixtureResidentHeapBytes = Math.max(
    0,
    process.memoryUsage().heapUsed - heapBeforeFixtureBytes,
  );
  const expectedHighMatches = fixture.expectedHighMatches;
  const hasCanonicalDataset =
    options.messageCount === DEFAULT_MESSAGE_COUNT &&
    options.sessionCount === DEFAULT_SESSION_COUNT;

  const cases: BenchmarkCase[] = [
    {
      name: "high-match",
      query: parseSearchQuery(HIGH_MATCH_TERM),
      expected: {
        matchedMessages: expectedHighMatches,
        matchedSessions: hasCanonicalDataset ? options.sessionCount : undefined,
        retainedCandidates: hasCanonicalDataset
          ? options.sessionCount * 3
          : undefined,
        decisionCounts: {
          skip: options.messageCount - expectedHighMatches,
          exactMatch: expectedHighMatches,
          project: 0,
        },
        checksum: hasCanonicalDataset ? "2f7bddd9" : undefined,
      },
    },
    {
      name: "no-match",
      query: parseSearchQuery(NO_MATCH_TERM),
      expected: {
        matchedMessages: 0,
        matchedSessions: 0,
        retainedCandidates: 0,
        decisionCounts: {
          skip: options.messageCount,
          exactMatch: 0,
          project: 0,
        },
        checksum: "811c9dc5",
      },
    },
    {
      name: "project-heavy",
      query: parseSearchQuery(PROJECT_HEAVY_TERM),
      expected: {
        matchedMessages: expectedHighMatches,
        matchedSessions: options.sessionCount,
        retainedCandidates: options.sessionCount * 3,
        decisionCounts: {
          skip: 0,
          exactMatch: 0,
          project: options.messageCount,
        },
        checksum: hasCanonicalDataset ? "2f7bddd9" : undefined,
      },
    },
  ];

  if (heapOnlyRequest) {
    const benchmark = cases.find(
      (candidate) => candidate.name === heapOnlyRequest.caseName,
    )!;
    process.stdout.write(
      JSON.stringify(
        await measureHeap(
          fixture,
          benchmark,
          options,
          heapOnlyRequest.scheduling,
        ),
      ),
    );
    return;
  }

  const results = [];
  for (const benchmark of cases) {
    process.stderr.write(
      `Benchmarking ${benchmark.name} (${options.runs} timed runs)...\n`,
    );
    results.push(await benchmarkCase(fixture, benchmark, options));
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runtime: {
          node: process.version,
          engine: "Node.js with tsx, production TypeScript projection imports",
          authoritativeForZoteroRuntime: false,
          qualification:
            "Measures production source projection and bounded aggregation only; Zotero.DBConnection latency remains covered by the runtime spike.",
        },
        config: options,
        fixture: {
          roles: "50% user, 50% completed assistant",
          highMatchRate: round(expectedHighMatches / fixture.messageCount),
          assistantVariants: [
            "plain visible prefix",
            "visible prefix before Markdown link",
            "visible match after Markdown link",
            "source-group before visible match",
            "HTML entity before visible match",
          ],
          selectedTextOnUserMessages: true,
          residentMetadataHeapBytesExcludedFromCaseDeltas:
            fixtureResidentHeapBytes,
          rowMaterialization:
            "Rows are generated and released one page at a time, matching SQLite keyset pagination.",
        },
        budgets: {
          sourceFallbackP95MsAt100k: LATENCY_BUDGET_MS,
          peakHeapBytesAt100k: HEAP_BUDGET_BYTES,
        },
        cases: results,
      },
      null,
      2,
    )}\n`,
  );
  if (
    isCanonicalGateConfig(options) &&
    results.some(
      (result) =>
        !result.gates?.p95Under2s ||
        !result.gates?.pagedAsyncPeakHeapUnder32MiB,
    )
  ) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
