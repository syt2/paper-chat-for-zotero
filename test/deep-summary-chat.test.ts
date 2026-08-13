import { assert } from "chai";
import {
  DEEP_SUMMARY_TOOL_NAMES,
  runDeepSummaryChat,
  type DeepSummaryChatManager,
} from "../src/modules/ai-summary/DeepSummaryChat.ts";
import { formatMarkdownForMessageCopy } from "../src/modules/ui/chat-panel/MarkdownRenderer.ts";
import type { ChatMessage, ChatSession } from "../src/types/chat";

function createItem(key: string = "ITEM-DEEP"): Zotero.Item {
  return { id: 1, key } as Zotero.Item;
}

function createSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "deep-summary-session",
    createdAt: 1,
    updatedAt: 1,
    lastActiveItemKey: "ITEM-DEEP",
    messages: [],
    ...overrides,
  };
}

describe("deep summary chat orchestration", function () {
  it("uses a fresh item session, exact tool allowlist, and visible answer only", async function () {
    const item = createItem();
    const session = createSession();
    const created: Array<{ itemKey: string; title: string }> = [];
    const panels: Zotero.Item[] = [];
    let sentOptions:
      | Parameters<DeepSummaryChatManager["sendMessage"]>[1]
      | null = null;
    const manager: DeepSummaryChatManager = {
      createItemSession: async (itemKey, title) => {
        created.push({ itemKey, title });
        return session;
      },
      sendMessage: async (_content, options) => {
        sentOptions = options;
        session.messages.push({
          id: "assistant-summary",
          role: "assistant",
          content: `Inspecting.

<tool-call status="completed">
<tool-name>done get_outline</tool-name>
<tool-status>completed</tool-status>
</tool-call>

# Final summary`,
          timestamp: 2,
        });
        return true;
      },
      cancelSessionTurn: async () => false,
    };

    const result = await runDeepSummaryChat(
      {
        item,
        sessionTitle: "Deep Summary: Paper",
        prompt: "Summarize this paper",
      },
      {
        chatManager: manager,
        showPanelForItem: (targetItem) => panels.push(targetItem),
        formatAssistantMessage: (message: ChatMessage) =>
          formatMarkdownForMessageCopy(message.content),
      },
    );

    assert.deepEqual(created, [
      { itemKey: "ITEM-DEEP", title: "Deep Summary: Paper" },
    ]);
    assert.deepEqual(panels, [item]);
    assert.strictEqual(sentOptions?.item, item);
    assert.strictEqual(sentOptions?.targetSession, session);
    assert.isTrue(sentOptions?.requireTargetSessionActive);
    assert.deepEqual(sentOptions?.allowedToolNames, DEEP_SUMMARY_TOOL_NAMES);
    assert.include(
      [...(sentOptions?.allowedToolNames || [])],
      "read_artifact",
      "large paper excerpts must remain readable through the chat artifact pipeline",
    );
    assert.equal(sentOptions?.lockedToolItemKey, "ITEM-DEEP");
    assert.equal(result, "Inspecting.\n\n# Final summary");
    assert.notInclude(result || "", "<tool-call");
  });

  it("cancels the deep-summary session selected when the run started", async function () {
    const session = createSession({ id: "summary-session-to-cancel" });
    const controller = new AbortController();
    const cancelledSessionIds: string[] = [];
    let finishSend: ((accepted: boolean) => void) | undefined;
    const manager: DeepSummaryChatManager = {
      createItemSession: async () => session,
      sendMessage: async () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
      cancelSessionTurn: async (sessionId) => {
        cancelledSessionIds.push(sessionId);
        finishSend?.(true);
        return true;
      },
    };

    const run = runDeepSummaryChat(
      {
        item: createItem(),
        sessionTitle: "Deep Summary: Paper",
        prompt: "Summarize this paper",
        signal: controller.signal,
      },
      {
        chatManager: manager,
        showPanelForItem: () => undefined,
        formatAssistantMessage: (message) => message.content,
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    let error: unknown;
    try {
      await run;
    } catch (caught) {
      error = caught;
    }

    assert.equal((error as Error)?.message, "Processing cancelled");
    assert.deepEqual(cancelledSessionIds, ["summary-session-to-cancel"]);
  });

  it("rejects persisted chat errors instead of returning an answer", async function () {
    const session = createSession();
    const manager: DeepSummaryChatManager = {
      createItemSession: async () => session,
      sendMessage: async () => {
        session.messages.push(
          {
            id: "assistant-partial",
            role: "assistant",
            content: "Partial answer",
            timestamp: 2,
          },
          {
            id: "summary-error",
            role: "error",
            content: "client_gone",
            timestamp: 3,
          },
        );
        return true;
      },
      cancelSessionTurn: async () => false,
    };

    let error: unknown;
    try {
      await runDeepSummaryChat(
        {
          item: createItem(),
          sessionTitle: "Deep Summary: Paper",
          prompt: "Summarize this paper",
        },
        {
          chatManager: manager,
          showPanelForItem: () => undefined,
          formatAssistantMessage: (message) => message.content,
        },
      );
    } catch (caught) {
      error = caught;
    }

    assert.equal((error as Error)?.message, "client_gone");
  });

  it("rejects failed execution plans even when partial assistant text exists", async function () {
    const session = createSession();
    const manager: DeepSummaryChatManager = {
      createItemSession: async () => session,
      sendMessage: async () => {
        session.messages.push({
          id: "assistant-partial",
          role: "assistant",
          content: "Partial answer",
          timestamp: 2,
        });
        session.executionPlan = {
          id: "summary-plan",
          status: "failed",
          steps: [
            {
              id: "failed-step",
              title: "Read paper",
              status: "failed",
              error: "Maximum planning iterations reached",
            },
          ],
          createdAt: 1,
          updatedAt: 2,
        };
        return true;
      },
      cancelSessionTurn: async () => false,
    };

    let error: unknown;
    try {
      await runDeepSummaryChat(
        {
          item: createItem(),
          sessionTitle: "Deep Summary: Paper",
          prompt: "Summarize this paper",
        },
        {
          chatManager: manager,
          showPanelForItem: () => undefined,
          formatAssistantMessage: (message) => message.content,
        },
      );
    } catch (caught) {
      error = caught;
    }

    assert.equal(
      (error as Error)?.message,
      "Maximum planning iterations reached",
    );
  });
});
