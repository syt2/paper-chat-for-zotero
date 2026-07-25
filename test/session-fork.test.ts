import { assert } from "chai";
import "../src/modules/auth/index.ts";
import { ChatManager } from "../src/modules/chat/ChatManager.ts";
import {
  cloneHistoryThroughAssistantMessage,
  collectForkArtifactIds,
  resolveForkItemKey,
} from "../src/modules/chat/session-fork.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat";
import { createPdfPassageEvidenceRecord } from "../src/modules/chat/evidence/index.ts";

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(count: number = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

describe("chat session fork", function () {
  it("copies complete model history through the selected AI message", function () {
    const messages: ChatMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "Compare the methods.",
        images: [
          {
            type: "url",
            data: "https://example.test/figure.png",
            mimeType: "image/png",
          },
        ],
        timestamp: 1,
      },
      {
        id: "assistant-1-api-context-tool-call",
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "tool-call-1",
            type: "function",
            function: {
              name: "search_paper_content",
              arguments: '{"query":"method"}',
            },
          },
        ],
        apiOnly: true,
        timestamp: 2,
      },
      {
        id: "assistant-1-api-context-result",
        role: "tool",
        content: "Relevant passages",
        tool_call_id: "tool-call-1",
        apiOnly: true,
        timestamp: 3,
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "The methods differ in two ways.",
        reasoning: "Compared the retrieved evidence.",
        evidence: [
          createPdfPassageEvidenceRecord({
            itemKey: "ITEM0001",
            page: 2,
            quote: "The methods differ in two ways.",
            toolCallId: "tool-call-1",
            resultIndex: 1,
          })!,
        ],
        sourceItemKeys: ["ITEM0001", "PAPER002"],
        timestamp: 4,
      },
      {
        id: "user-2",
        role: "user",
        content: "Explain the first one.",
        timestamp: 5,
      },
    ];
    let nextId = 0;

    const forked = cloneHistoryThroughAssistantMessage(
      messages,
      "assistant-1",
      () => `fork-${++nextId}`,
    );

    assert.deepEqual(
      forked.map((message) => message.id),
      ["fork-1", "fork-2", "fork-3", "fork-4"],
    );
    assert.deepEqual(
      forked.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.equal(forked[1]?.tool_calls?.[0]?.id, "tool-call-1");
    assert.equal(forked[2]?.tool_call_id, "tool-call-1");
    assert.notStrictEqual(forked[0]?.images, messages[0]?.images);
    assert.notStrictEqual(forked[1]?.tool_calls, messages[1]?.tool_calls);
    assert.notStrictEqual(forked[3]?.evidence, messages[3]?.evidence);
    assert.notStrictEqual(forked[3]?.evidence?.[0], messages[3]?.evidence?.[0]);
    assert.deepEqual(forked[3]?.sourceItemKeys, ["ITEM0001", "PAPER002"]);
    assert.notStrictEqual(
      forked[3]?.sourceItemKeys,
      messages[3]?.sourceItemKeys,
    );
    assert.equal(messages[0]?.id, "user-1");
    assert.equal(messages[4]?.id, "user-2");
  });

  it("only accepts a visible, completed AI message as the fork point", function () {
    const base = {
      content: "content",
      timestamp: 1,
    };

    assert.throws(() =>
      cloneHistoryThroughAssistantMessage([], "missing", () => "new-id"),
    );
    assert.throws(() =>
      cloneHistoryThroughAssistantMessage(
        [{ ...base, id: "user", role: "user" }],
        "user",
        () => "new-id",
      ),
    );
    assert.throws(() =>
      cloneHistoryThroughAssistantMessage(
        [
          {
            ...base,
            id: "interrupted",
            role: "assistant",
            streamingState: "interrupted",
          },
        ],
        "interrupted",
        () => "new-id",
      ),
    );
    assert.throws(() =>
      cloneHistoryThroughAssistantMessage(
        [
          {
            ...base,
            id: "streaming",
            role: "assistant",
            streamingState: "in_progress",
          },
        ],
        "streaming",
        () => "new-id",
      ),
    );
    assert.throws(() =>
      cloneHistoryThroughAssistantMessage(
        [
          {
            ...base,
            id: "hidden",
            role: "assistant",
            apiOnly: true,
          },
        ],
        "hidden",
        () => "new-id",
      ),
    );
  });

  it("does not carry paper context that was selected after the fork point", function () {
    const messages: ChatMessage[] = [
      {
        id: "assistant-on-paper-a",
        role: "assistant",
        content: "Answer about paper A",
        timestamp: 1,
      },
      {
        id: "switch-to-paper-b",
        role: "system",
        content: '--- Switched to paper: "Paper B" ---',
        timestamp: 2,
        isSystemNotice: true,
      },
      {
        id: "user-on-paper-b",
        role: "user",
        content: "Question about paper B",
        timestamp: 3,
      },
    ];

    assert.isNull(
      resolveForkItemKey(messages, "assistant-on-paper-a", "PAPER-B"),
    );
    assert.equal(
      resolveForkItemKey(
        messages.slice(0, 1),
        "assistant-on-paper-a",
        "PAPER-A",
      ),
      "PAPER-A",
    );
  });

  it("collects only artifact ids actually referenced in forked tool messages", function () {
    const messages: ChatMessage[] = [
      {
        id: "tool-result",
        role: "tool",
        content: [
          "[Tool result saved as session artifact]",
          "Artifact id: artifact-before-fork",
          "Original characters: 20000",
        ].join("\n"),
        tool_call_id: "reused-tool-call-id",
        timestamp: 1,
      },
      {
        id: "assistant-text",
        role: "assistant",
        content: "Artifact id: artifact-mentioned-by-assistant",
        timestamp: 2,
      },
      {
        id: "ordinary-tool-text",
        role: "tool",
        content: "Artifact id: artifact-mentioned-by-tool-output",
        timestamp: 3,
      },
    ];

    assert.deepEqual(collectForkArtifactIds(messages), [
      "artifact-before-fork",
    ]);
  });

  it("activates a persisted fork without copying pending session state", async function () {
    const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };

    try {
      const sourceSession: ChatSession = {
        id: "source-session",
        createdAt: 1,
        updatedAt: 10,
        lastActiveItemKey: "ITEM-1",
        messages: [
          {
            id: "source-user",
            role: "user",
            content: "Question",
            timestamp: 2,
          },
          {
            id: "source-assistant",
            role: "assistant",
            content: "Answer",
            timestamp: 3,
          },
          {
            id: "later-user",
            role: "user",
            content: "Later question",
            timestamp: 4,
          },
        ],
        contextSummary: {
          id: "summary-1",
          content: "Old summary",
          coveredMessageIds: ["source-user"],
          createdAt: 5,
          messageCountAtCreation: 1,
        },
        executionPlan: {
          id: "plan-1",
          summary: "Pending plan",
          status: "in_progress",
          steps: [],
          createdAt: 6,
          updatedAt: 6,
        },
        selectedTier: "paperchat-pro",
        resolvedModelId: "model-pro",
        lastRetryableUserMessageId: "later-user",
      };
      const manager = Object.create(ChatManager.prototype) as any;
      let createOptions: Record<string, unknown> | undefined;
      let nextId = 0;

      manager.init = async () => undefined;
      manager.currentSession = sourceSession;
      manager.generateId = () => `fork-message-${++nextId}`;
      manager.sessionStorage = {
        createSession: async (options: Record<string, unknown>) => {
          createOptions = options;
          return {
            id: "fork-session",
            createdAt: 20,
            updatedAt: 20,
            lastActiveItemKey: options.lastActiveItemKey,
            messages: options.messages,
            selectedTier: options.selectedTier,
            resolvedModelId: options.resolvedModelId,
          } as ChatSession;
        },
        cleanupAbandonedDraftSessions: async () => {
          throw new Error("cleanup failed");
        },
        setActiveSession: async () => undefined,
        deleteSession: async () => undefined,
      };
      manager.memoryManager = {
        onBeforeSessionSwitch: () => undefined,
      };
      manager.maybeGenerateSessionTitle = () => undefined;
      manager.applySessionItemContext = () => undefined;
      manager.reconcileApprovalState = () => undefined;
      manager.reconcileUserInputRequestState = () => undefined;
      manager.notifySessionListUpdated = () => undefined;

      const forkedSession =
        await manager.forkCurrentSessionAtMessage("source-assistant");

      assert.strictEqual(manager.currentSession, forkedSession);
      assert.equal(forkedSession.id, "fork-session");
      assert.deepEqual(
        forkedSession.messages.map((message) => message.content),
        ["Question", "Answer"],
      );
      assert.deepEqual(
        forkedSession.messages.map((message) => message.id),
        ["fork-message-1", "fork-message-2"],
      );
      assert.equal(createOptions?.lastActiveItemKey, "ITEM-1");
      assert.equal(createOptions?.selectedTier, "paperchat-pro");
      assert.equal(createOptions?.resolvedModelId, "model-pro");
      assert.equal(createOptions?.activate, false);
      assert.notProperty(createOptions || {}, "contextSummary");
      assert.notProperty(createOptions || {}, "executionPlan");
      assert.notProperty(createOptions || {}, "lastRetryableUserMessageId");
      assert.lengthOf(sourceSession.messages, 3);
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    }
  });

  it("serializes rapid forks and leaves the last fork active", async function () {
    const sourceSession: ChatSession = {
      id: "source-session",
      createdAt: 1,
      updatedAt: 10,
      lastActiveItemKey: null,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "First question",
          timestamp: 1,
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "First answer",
          timestamp: 2,
        },
        {
          id: "user-2",
          role: "user",
          content: "Second question",
          timestamp: 3,
        },
        {
          id: "assistant-2",
          role: "assistant",
          content: "Second answer",
          timestamp: 4,
        },
      ],
    };
    const firstCreate = createDeferred();
    const manager = Object.create(ChatManager.prototype) as any;
    let createCount = 0;
    let activeCreates = 0;
    let maxActiveCreates = 0;
    let nextMessageId = 0;
    const memorySwitches: Array<[string | undefined, string]> = [];

    manager.init = async () => undefined;
    manager.currentSession = sourceSession;
    manager.generateId = () => `fork-message-${++nextMessageId}`;
    manager.sessionStorage = {
      createSession: async (options: Record<string, unknown>) => {
        createCount += 1;
        const callNumber = createCount;
        activeCreates += 1;
        maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
        if (callNumber === 1) {
          await firstCreate.promise;
        }
        activeCreates -= 1;
        return {
          id: `fork-session-${callNumber}`,
          createdAt: 20 + callNumber,
          updatedAt: 20 + callNumber,
          lastActiveItemKey: null,
          messages: options.messages,
        } as ChatSession;
      },
      cleanupAbandonedDraftSessions: async () => 0,
      setActiveSession: async () => undefined,
      deleteSession: async () => undefined,
    };
    manager.memoryManager = {
      onBeforeSessionSwitch: (
        session: ChatSession | null,
        nextSessionId: string,
      ) => {
        memorySwitches.push([session?.id, nextSessionId]);
      },
    };
    manager.maybeGenerateSessionTitle = () => undefined;
    manager.applySessionItemContext = () => undefined;
    manager.reconcileApprovalState = () => undefined;
    manager.reconcileUserInputRequestState = () => undefined;
    manager.notifySessionListUpdated = () => undefined;

    const firstFork = manager.forkCurrentSessionAtMessage("assistant-1");
    const secondFork = manager.forkCurrentSessionAtMessage("assistant-2");
    await flushMicrotasks();

    assert.equal(createCount, 1);
    firstCreate.resolve(undefined);

    const [firstSession, secondSession] = await Promise.all([
      firstFork,
      secondFork,
    ]);

    assert.equal(createCount, 2);
    assert.equal(maxActiveCreates, 1);
    assert.equal(firstSession.id, "fork-session-1");
    assert.equal(secondSession.id, "fork-session-2");
    assert.lengthOf(firstSession.messages, 2);
    assert.lengthOf(secondSession.messages, 4);
    assert.strictEqual(manager.currentSession, secondSession);
    assert.deepEqual(memorySwitches, [
      ["source-session", "fork-session-1"],
      ["fork-session-1", "fork-session-2"],
    ]);
  });

  it("finishes a queued session switch after an in-flight fork", async function () {
    const sourceSession: ChatSession = {
      id: "source-session",
      createdAt: 1,
      updatedAt: 10,
      lastActiveItemKey: null,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Answer",
          timestamp: 1,
        },
      ],
    };
    const otherSession: ChatSession = {
      id: "other-session",
      createdAt: 2,
      updatedAt: 20,
      lastActiveItemKey: null,
      messages: [],
    };
    const forkCreate = createDeferred();
    const manager = Object.create(ChatManager.prototype) as any;
    const events: string[] = [];

    manager.init = async () => undefined;
    manager.currentSession = sourceSession;
    manager.streamingSessions = new Map();
    manager.generateId = () => "fork-message-1";
    manager.sessionStorage = {
      createSession: async (options: Record<string, unknown>) => {
        events.push("fork-start");
        await forkCreate.promise;
        events.push("fork-finish");
        return {
          id: "fork-session",
          createdAt: 30,
          updatedAt: 30,
          lastActiveItemKey: null,
          messages: options.messages,
        } as ChatSession;
      },
      cleanupAbandonedDraftSessions: async () => 0,
      loadSession: async () => {
        events.push("switch-load");
        return otherSession;
      },
      setActiveSession: async (sessionId: string) => {
        events.push(`switch-active:${sessionId}`);
      },
      deleteSession: async () => undefined,
    };
    manager.memoryManager = {
      onBeforeSessionSwitch: () => undefined,
    };
    manager.maybeGenerateSessionTitle = () => undefined;
    manager.applySessionItemContext = () => undefined;
    manager.reconcileApprovalState = () => undefined;
    manager.reconcileUserInputRequestState = () => undefined;
    manager.notifySessionListUpdated = () => undefined;

    const fork = manager.forkCurrentSessionAtMessage("assistant-1");
    const switched = manager.switchSession("other-session");
    await flushMicrotasks();

    assert.deepEqual(events, ["fork-start"]);
    forkCreate.resolve(undefined);

    await fork;
    const switchedSession = await switched;

    assert.strictEqual(switchedSession, otherSession);
    assert.strictEqual(manager.currentSession, otherSession);
    assert.deepEqual(events, [
      "fork-start",
      "fork-finish",
      "switch-active:fork-session",
      "switch-load",
      "switch-active:other-session",
    ]);
  });

  it("continues queued navigation after a fork persistence failure", async function () {
    const sourceSession: ChatSession = {
      id: "source-session",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Answer",
          timestamp: 1,
        },
      ],
    };
    const otherSession: ChatSession = {
      id: "other-session",
      createdAt: 2,
      updatedAt: 2,
      lastActiveItemKey: null,
      messages: [],
    };
    const manager = Object.create(ChatManager.prototype) as any;
    const events: string[] = [];

    manager.init = async () => undefined;
    manager.currentSession = sourceSession;
    manager.streamingSessions = new Map();
    manager.generateId = () => "fork-message-1";
    manager.sessionStorage = {
      createSession: async () => {
        events.push("fork-create");
        throw new Error("fork write failed");
      },
      loadSession: async () => {
        events.push("switch-load");
        return otherSession;
      },
      setActiveSession: async (sessionId: string) => {
        events.push(`switch-active:${sessionId}`);
      },
    };
    manager.memoryManager = {
      onBeforeSessionSwitch: () => undefined,
    };
    manager.maybeGenerateSessionTitle = () => undefined;
    manager.applySessionItemContext = () => undefined;
    manager.reconcileApprovalState = () => undefined;
    manager.reconcileUserInputRequestState = () => undefined;
    manager.notifySessionListUpdated = () => undefined;

    const failedFork = manager.forkCurrentSessionAtMessage("assistant-1");
    const switched = manager.switchSession("other-session");

    try {
      await failedFork;
      assert.fail("expected fork persistence to fail");
    } catch (error) {
      assert.equal((error as Error).message, "fork write failed");
    }
    assert.strictEqual(await switched, otherSession);
    assert.strictEqual(manager.currentSession, otherSession);
    assert.deepEqual(events, [
      "fork-create",
      "switch-load",
      "switch-active:other-session",
    ]);
  });
});
