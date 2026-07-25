import { assert } from "chai";
import {
  applyNoteSummaryDestinationResponse,
  buildNoteSummaryDestinationRequestArgs,
  buildNoteSummaryRuntimeInstruction,
  createNoteSummaryContext,
  MAX_NOTE_SUMMARY_SOURCE_ITEMS,
  rewriteCreateNoteTarget,
} from "../src/modules/chat/note-summary-destination.ts";
import { AgentRuntime } from "../src/modules/chat/agent-runtime/AgentRuntime.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat.ts";
import type { ToolCall } from "../src/types/tool.ts";

function createNoteCall(args: Record<string, unknown>): ToolCall {
  return {
    id: "create-note",
    type: "function",
    function: {
      name: "create_note",
      arguments: JSON.stringify(args),
    },
  };
}

function sourceItem(index: number): { itemKey: string; title: string } {
  const alphabet = "23456789";
  let value = index;
  let suffix = "";
  for (let position = 0; position < 3; position++) {
    suffix = alphabet[value % alphabet.length] + suffix;
    value = Math.floor(value / alphabet.length);
  }
  return { itemKey: `AAAAA${suffix}`, title: `Paper ${index + 1}` };
}

describe("note summary destinations", function () {
  let originalAddon: unknown;

  before(function () {
    originalAddon = (globalThis as { addon?: unknown }).addon;
    (globalThis as { addon?: unknown }).addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: ([request]: Array<{ id: string }>) => [
              { value: request.id, attributes: null },
            ],
          },
        },
      },
    };
  });

  after(function () {
    (globalThis as { addon?: unknown }).addon = originalAddon;
  });

  it("resolves zero and one source without asking and leaves multiple pending", function () {
    assert.deepEqual(createNoteSummaryContext([]).destination, {
      status: "resolved",
      itemKey: null,
    });
    assert.deepEqual(
      createNoteSummaryContext([{ itemKey: "item0001", title: "Paper A" }]),
      {
        sourceItems: [{ itemKey: "ITEM0001", title: "Paper A" }],
        noteCreated: false,
        destination: { status: "resolved", itemKey: "ITEM0001" },
      },
    );
    assert.deepEqual(
      createNoteSummaryContext([
        { itemKey: "ITEM0001", title: "Paper A" },
        { itemKey: "PAPER002", title: "Paper B" },
      ]).destination,
      { status: "pending" },
    );
  });

  it("accepts only an application-provided destination", function () {
    const context = createNoteSummaryContext([
      { itemKey: "ITEM0001", title: "Paper A" },
      { itemKey: "PAPER002", title: "Paper B" },
    ]);
    applyNoteSummaryDestinationResponse(context, {
      answers: {
        note_summary_destination: { answers: ["paper:PAPER002"] },
      },
    });
    assert.deepEqual(context.destination, {
      status: "resolved",
      itemKey: "PAPER002",
    });

    const forged = createNoteSummaryContext([
      { itemKey: "ITEM0001", title: "Paper A" },
      { itemKey: "PAPER002", title: "Paper B" },
    ]);
    applyNoteSummaryDestinationResponse(forged, {
      answers: {
        note_summary_destination: { answers: ["paper:FORGED01"] },
      },
    });
    assert.deepEqual(forged.destination, { status: "cancelled" });
  });

  it("overwrites a model-selected paper and supports an explicit standalone note", function () {
    const original = createNoteCall({
      content: "Summary",
      itemKey: "FORGED01",
      item_key: "FORGED02",
      itemkey: "FORGED03",
      "ITEM-KEY": "FORGED04",
      "item key": "FORGED05",
    });
    const attached = rewriteCreateNoteTarget(original, "ITEM0001");
    assert.isNotNull(attached);
    assert.deepEqual(JSON.parse(attached!.function.arguments), {
      content: "Summary",
      itemKey: "ITEM0001",
      format: "plain",
    });

    const standalone = rewriteCreateNoteTarget(original, null);
    assert.isNotNull(standalone);
    assert.deepEqual(JSON.parse(standalone!.function.arguments), {
      content: "Summary",
      format: "plain",
    });
  });

  it("forces model-generated summaries through the plain-text note path", function () {
    const rewritten = rewriteCreateNoteTarget(
      createNoteCall({
        content: '<img src="https://example.invalid/pixel">',
        format: "html",
      }),
      null,
    );

    assert.isNotNull(rewritten);
    assert.equal(JSON.parse(rewritten!.function.arguments).format, "plain");
  });

  it("bounds application-generated destination choices without overflowing validation", function () {
    const context = createNoteSummaryContext(
      Array.from({ length: MAX_NOTE_SUMMARY_SOURCE_ITEMS + 1 }, (_, index) =>
        sourceItem(index),
      ),
    );
    const options =
      buildNoteSummaryDestinationRequestArgs(context).questions[0].options!;

    assert.lengthOf(context.sourceItems, MAX_NOTE_SUMMARY_SOURCE_ITEMS);
    assert.lengthOf(options, MAX_NOTE_SUMMARY_SOURCE_ITEMS + 1);
  });

  it("updates runtime instructions after destination resolution or cancellation", function () {
    const resolved = createNoteSummaryContext([
      { itemKey: "ITEM0001", title: "Paper A" },
      { itemKey: "PAPER002", title: "Paper B" },
    ]);
    applyNoteSummaryDestinationResponse(resolved, {
      answers: {
        note_summary_destination: { answers: ["paper:PAPER002"] },
      },
    });
    assert.include(
      buildNoteSummaryRuntimeInstruction(resolved),
      "already selected",
    );
    assert.notInclude(
      buildNoteSummaryRuntimeInstruction(resolved),
      "Before creating the note",
    );

    const cancelled = createNoteSummaryContext([
      { itemKey: "ITEM0001", title: "Paper A" },
      { itemKey: "PAPER002", title: "Paper B" },
    ]);
    applyNoteSummaryDestinationResponse(cancelled, {
      answers: {},
      cancelled: true,
    });
    assert.include(
      buildNoteSummaryRuntimeInstruction(cancelled),
      "cancelled destination selection",
    );
  });

  it("blocks create_note planned in the same response as destination input", function () {
    const runtime = new AgentRuntime(
      {} as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "generated",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    const message: ChatMessage = {
      id: "assistant",
      role: "assistant",
      content: "",
      timestamp: 1,
    };
    const session: ChatSession = {
      id: "session",
      messages: [message],
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: "ITEM0001",
    };
    const context = createNoteSummaryContext([
      { itemKey: "ITEM0001", title: "Paper A" },
      { itemKey: "PAPER002", title: "Paper B" },
    ]);
    const requestInput: ToolCall = {
      id: "choose-destination",
      type: "function",
      function: { name: "request_user_input", arguments: "{}" },
    };

    const entries = runtime.createRuntimeToolIterationEntries(
      session,
      message,
      [requestInput, createNoteCall({ content: "Summary" })],
      { maxTotalToolCalls: 10 },
      undefined,
      false,
      "ITEM0001",
      new Set(["request_user_input", "create_note"]),
      context,
    );

    assert.deepEqual(
      entries.map((entry: any) => entry.kind),
      ["user_input", "synthetic"],
    );
    assert.equal(entries[1].results[0].status, "denied");
    assert.include(entries[1].results[0].content, "before creating the note");
  });

  it("passes an explicit standalone target instead of the current paper fallback", function () {
    const runtime = new AgentRuntime(
      {} as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "generated",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    const message: ChatMessage = {
      id: "assistant",
      role: "assistant",
      content: "",
      timestamp: 1,
    };
    const session: ChatSession = {
      id: "session",
      messages: [message],
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: "ITEM0001",
    };
    const context = createNoteSummaryContext([]);
    const standaloneCall = rewriteCreateNoteTarget(
      createNoteCall({ content: "Summary" }),
      null,
    );
    assert.isNotNull(standaloneCall);
    const entries = runtime.createRuntimeToolIterationEntries(
      session,
      message,
      [standaloneCall!],
      { maxTotalToolCalls: 10 },
      undefined,
      false,
      "ITEM0001",
      new Set(["create_note"]),
      context,
    );

    assert.equal(entries[0].kind, "execute");
    assert.strictEqual(entries[0].requests[0].currentItemKey, null);
    assert.notProperty(
      JSON.parse(entries[0].requests[0].toolCall.function.arguments),
      "itemKey",
    );
  });

  it("enforces a resolved paper target at the execution boundary", function () {
    let scheduled = 0;
    const runtime = new AgentRuntime(
      {} as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "generated",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => {
          scheduled += requests.length;
          return [requests];
        },
        executeBatch: async () => [],
      },
    ) as any;
    const message: ChatMessage = {
      id: "assistant",
      role: "assistant",
      content: "",
      timestamp: 1,
    };
    const session: ChatSession = {
      id: "session",
      messages: [message],
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: "ITEM0001",
    };
    const context = createNoteSummaryContext([
      { itemKey: "ITEM0001", title: "Paper A" },
      { itemKey: "PAPER002", title: "Paper B" },
    ]);
    applyNoteSummaryDestinationResponse(context, {
      answers: {
        note_summary_destination: { answers: ["paper:PAPER002"] },
      },
    });
    const protectedCall = rewriteCreateNoteTarget(
      createNoteCall({ content: "Summary", itemKey: "FORGED01" }),
      "PAPER002",
    );
    assert.isNotNull(protectedCall);

    const entries = runtime.createRuntimeToolIterationEntries(
      session,
      message,
      [protectedCall!],
      { maxTotalToolCalls: 10 },
      undefined,
      false,
      "ITEM0001",
      new Set(["create_note"]),
      context,
    );

    assert.equal(scheduled, 1);
    assert.equal(entries[0].kind, "execute");
    assert.strictEqual(entries[0].requests[0].currentItemKey, "PAPER002");
    assert.equal(
      JSON.parse(entries[0].requests[0].toolCall.function.arguments).itemKey,
      "PAPER002",
    );
  });

  it("blocks malformed create_note arguments before scheduling execution", function () {
    let scheduled = 0;
    const runtime = new AgentRuntime(
      {} as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "generated",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => {
          scheduled += requests.length;
          return [requests];
        },
        executeBatch: async () => [],
      },
    ) as any;
    const message: ChatMessage = {
      id: "assistant",
      role: "assistant",
      content: "",
      timestamp: 1,
    };
    const session: ChatSession = {
      id: "session",
      messages: [message],
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: "ITEM0001",
    };
    const context = createNoteSummaryContext([
      { itemKey: "ITEM0001", title: "Paper A" },
    ]);
    const malformed: ToolCall = {
      id: "malformed-create-note",
      type: "function",
      function: { name: "create_note", arguments: "[]" },
    };
    assert.isNull(rewriteCreateNoteTarget(malformed, "ITEM0001"));

    const entries = runtime.createRuntimeToolIterationEntries(
      session,
      message,
      [malformed],
      { maxTotalToolCalls: 10 },
      undefined,
      false,
      "ITEM0001",
      new Set(["create_note"]),
      context,
      new Set([malformed.id]),
    );

    assert.equal(scheduled, 0);
    assert.equal(entries[0].kind, "synthetic");
    assert.equal(entries[0].results[0].status, "denied");
  });

  it("keeps create_note blocked after the user cancels destination selection", function () {
    const runtime = new AgentRuntime(
      {} as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "generated",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => [requests],
        executeBatch: async () => [],
      },
    ) as any;
    const message: ChatMessage = {
      id: "assistant",
      role: "assistant",
      content: "",
      timestamp: 1,
    };
    const session: ChatSession = {
      id: "session",
      messages: [message],
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: "ITEM0001",
    };
    const context = createNoteSummaryContext([
      { itemKey: "ITEM0001", title: "Paper A" },
      { itemKey: "PAPER002", title: "Paper B" },
    ]);
    applyNoteSummaryDestinationResponse(context, {
      answers: {},
      cancelled: true,
    });

    const entries = runtime.createRuntimeToolIterationEntries(
      session,
      message,
      [createNoteCall({ content: "Summary" })],
      { maxTotalToolCalls: 10 },
      undefined,
      false,
      "ITEM0001",
      new Set(["create_note"]),
      context,
    );

    assert.equal(entries[0].kind, "synthetic");
    assert.equal(entries[0].results[0].status, "denied");
    assert.include(entries[0].results[0].content, "cancelled");
  });

  it("allows at most one create_note per summary action", function () {
    let scheduled = 0;
    const runtime = new AgentRuntime(
      {} as any,
      {
        isSessionActive: () => true,
        isSessionTracked: () => true,
        formatToolCallCard: () => "",
        generateId: () => "generated",
      } as any,
      {
        createExecutionBatches: (requests: any[]) => {
          scheduled += requests.length;
          return [requests];
        },
        executeBatch: async () => [],
      },
    ) as any;
    const message: ChatMessage = {
      id: "assistant",
      role: "assistant",
      content: "",
      timestamp: 1,
    };
    const session: ChatSession = {
      id: "session",
      messages: [message],
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: "ITEM0001",
    };
    const context = createNoteSummaryContext([
      { itemKey: "ITEM0001", title: "Paper A" },
    ]);
    const first = createNoteCall({ content: "First" });
    const second = {
      ...createNoteCall({ content: "Second" }),
      id: "create-note-duplicate",
    };

    const entries = runtime.createRuntimeToolIterationEntries(
      session,
      message,
      [first, second],
      { maxTotalToolCalls: 10 },
      undefined,
      false,
      "ITEM0001",
      new Set(["create_note"]),
      context,
    );

    assert.equal(scheduled, 1);
    assert.deepEqual(
      entries.map((entry: any) => entry.kind),
      ["execute", "synthetic"],
    );
    assert.equal(entries[1].results[0].status, "denied");
    assert.include(entries[1].results[0].content, "at most one");

    context.noteCreated = true;
    const laterEntries = runtime.createRuntimeToolIterationEntries(
      session,
      message,
      [createNoteCall({ content: "Third" })],
      { maxTotalToolCalls: 10 },
      undefined,
      false,
      "ITEM0001",
      new Set(["create_note"]),
      context,
    );
    assert.equal(scheduled, 1);
    assert.equal(laterEntries[0].kind, "synthetic");
    assert.include(
      buildNoteSummaryRuntimeInstruction(context),
      "already been created",
    );
  });

  it("keeps cancellation waiting while a write-class tool entry is settling", async function () {
    const runtime = new AgentRuntime({} as any, {} as any, {} as any) as any;
    const release = runtime.beginMutatingToolEntry("session", [
      {
        toolCall: createNoteCall({ content: "Summary" }),
      },
    ]);
    assert.isFunction(release);

    let settled = false;
    const wait = runtime
      .waitForPendingMutatingToolExecutions("session")
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    assert.isFalse(settled);

    release();
    await wait;
    assert.isTrue(settled);
    await runtime.waitForPendingMutatingToolExecutions("session");

    assert.isNull(
      runtime.beginMutatingToolEntry("session", [
        {
          toolCall: {
            id: "read-only",
            type: "function",
            function: { name: "search_items", arguments: "{}" },
          },
        },
      ]),
    );
  });
});
