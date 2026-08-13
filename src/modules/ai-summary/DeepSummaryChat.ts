import type { ChatMessage, ChatSession } from "../../types/chat";

export const DEEP_SUMMARY_TOOL_NAMES = [
  "get_annotations",
  "get_outline",
  "get_page_count",
  "get_pages",
  "get_paper_metadata",
  "get_paper_section",
  "list_sections",
  "read_artifact",
  "search_paper_content",
  "search_with_regex",
] as const;

export interface DeepSummaryChatManager {
  createItemSession(itemKey: string, title: string): Promise<ChatSession>;
  sendMessage(
    content: string,
    options: {
      item: Zotero.Item;
      attachPdf: boolean;
      targetSession: ChatSession;
      requireTargetSessionActive: boolean;
      allowedToolNames: readonly string[];
      lockedToolItemKey: string;
    },
  ): Promise<boolean>;
  cancelSessionTurn(sessionId: string): Promise<boolean>;
}

export interface DeepSummaryChatDependencies {
  chatManager: DeepSummaryChatManager;
  showPanelForItem: (item: Zotero.Item) => void;
  formatAssistantMessage: (message: ChatMessage) => string;
}

export interface DeepSummaryChatRequest {
  item: Zotero.Item;
  sessionTitle: string;
  prompt: string;
  signal?: AbortSignal;
}

function getFailedPlanMessage(session: ChatSession): string | null {
  if (session.executionPlan?.status !== "failed") {
    return null;
  }
  const failedStep = session.executionPlan.steps
    .filter((step) => step.status === "failed")
    .at(-1);
  return (
    failedStep?.error || failedStep?.detail || "Deep summary execution failed"
  );
}

export async function runDeepSummaryChat(
  request: DeepSummaryChatRequest,
  dependencies: DeepSummaryChatDependencies,
): Promise<string | null> {
  const { item, sessionTitle, prompt, signal } = request;
  const { chatManager } = dependencies;
  if (signal?.aborted) {
    throw new Error("Processing cancelled");
  }

  const session = await chatManager.createItemSession(item.key, sessionTitle);
  if (signal?.aborted) {
    throw new Error("Processing cancelled");
  }
  dependencies.showPanelForItem(item);

  const firstNewMessageIndex = session.messages.length;
  let cancellation: Promise<boolean> | null = null;
  const cancelSession = () => {
    cancellation ??= chatManager
      .cancelSessionTurn(session.id)
      .catch(() => false);
  };
  signal?.addEventListener("abort", cancelSession, { once: true });

  try {
    if (signal?.aborted) {
      throw new Error("Processing cancelled");
    }
    const accepted = await chatManager.sendMessage(prompt, {
      item,
      attachPdf: false,
      targetSession: session,
      requireTargetSessionActive: true,
      allowedToolNames: DEEP_SUMMARY_TOOL_NAMES,
      lockedToolItemKey: item.key,
    });
    if (signal?.aborted) {
      throw new Error("Processing cancelled");
    }

    const newMessages = session.messages.slice(firstNewMessageIndex);
    const errorMessage = newMessages
      .filter((message) => message.role === "error")
      .at(-1);
    if (errorMessage) {
      throw new Error(errorMessage.content || "Deep summary chat failed");
    }

    const failedPlanMessage = getFailedPlanMessage(session);
    if (failedPlanMessage) {
      throw new Error(failedPlanMessage);
    }

    const assistantMessage = newMessages
      .filter((message) => message.role === "assistant" && !message.apiOnly)
      .at(-1);
    if (!accepted || !assistantMessage) {
      throw new Error(
        assistantMessage?.content || "Deep summary chat was not accepted",
      );
    }
    if (assistantMessage.streamingState) {
      throw new Error("Deep summary chat was interrupted");
    }

    return dependencies.formatAssistantMessage(assistantMessage).trim() || null;
  } finally {
    signal?.removeEventListener("abort", cancelSession);
    if (cancellation) {
      await cancellation;
    }
  }
}
