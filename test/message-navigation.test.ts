import { assert } from "chai";
import type { ChatMessage } from "../src/modules/chat/index.ts";
import { providerSupportsToolCalling } from "../src/modules/providers/provider-capabilities.ts";
import { darkTheme } from "../src/modules/ui/chat-panel/ChatPanelTheme.ts";
import {
  createMessageElement,
  findRenderedMessageElement,
  renderMessages,
  scrollToAndHighlightMessage,
  updateUserInputRequestView,
} from "../src/modules/ui/chat-panel/MessageRenderer.ts";
import {
  buildNoteSummaryDestinationRequestArgs,
  createNoteSummaryContext,
} from "../src/modules/chat/note-summary-destination.ts";
import {
  buildReplyNoteSummaryPrompt,
  canSummarizeAssistantReply,
  collectNoteSummarySourceItemKeys,
  hasConversationMessages,
  resolveNoteSummarySourceItem,
  shouldResetSummaryButtonBusyState,
} from "../src/modules/ui/chat-panel/NoteSummaryActions.ts";
import {
  syncSessionNavigationState,
  updateAttachmentsPreviewDisplay,
} from "../src/modules/ui/chat-panel/ChatPanelEvents.ts";

interface RectInit {
  top: number;
  height: number;
}

class FakeElement {
  readonly style: Record<string, string> = {
    backgroundColor: "",
    borderRadius: "",
    boxShadow: "",
    position: "",
    transition: "",
  };
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  parentElement: FakeElement | null = null;
  readonly dataset: Record<string, string> = {};
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  offsetHeight = 0;
  disabled = false;
  value = "";
  checked = false;
  type = "";
  name = "";
  placeholder = "";
  autocomplete = "";
  private textValue = "";
  private rect: RectInit = { top: 0, height: 0 };

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  get childElementCount(): number {
    return this.children.length;
  }

  get textContent(): string {
    return this.textValue;
  }

  set textContent(value: string) {
    this.textValue = value;
    if (value === "") {
      this.children.length = 0;
    }
  }

  setRect(rect: RectInit): void {
    this.rect = rect;
  }

  getBoundingClientRect(): DOMRect {
    return {
      top: this.rect.top,
      bottom: this.rect.top + this.rect.height,
      height: this.rect.height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: this.rect.top,
      toJSON: () => ({}),
    };
  }

  appendChild(child: FakeElement): FakeElement {
    // Mirror DOM DocumentFragment semantics: appending a fragment moves its
    // children into this node and leaves the fragment empty.
    if (child.tagName === "#fragment") {
      for (const grandChild of [...child.children]) {
        this.appendChild(grandChild);
      }
      child.children.length = 0;
      return child;
    }
    child.parentElement = this;
    this.children.push(child);
    if (
      this.tagName === "select" &&
      !this.value &&
      child.tagName === "option"
    ) {
      this.value = child.value;
    }
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (element: FakeElement): boolean => {
      if (selector.startsWith("#")) {
        return element.getAttribute("id") === selector.slice(1);
      }
      if (selector.startsWith(".")) {
        return (element.getAttribute("class") || "")
          .split(/\s+/)
          .includes(selector.slice(1));
      }
      if (selector.startsWith("[")) {
        const attributes = [...selector.matchAll(/\[([^=\]]+)="([^"]*)"\]/g)];
        return attributes.every(
          (match) => element.getAttribute(match[1]) === match[2],
        );
      }
      return element.tagName === selector.toLowerCase();
    };
    const found: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      for (const child of element.children) {
        if (matches(child)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

class FakeDocument {
  readonly head: FakeElement;

  constructor() {
    this.head = new FakeElement(this, "head");
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(this, tagName.toLowerCase());
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName.toLowerCase());
  }

  createDocumentFragment(): FakeElement {
    return new FakeElement(this, "#fragment");
  }

  createTextNode(value: string): FakeElement {
    const node = new FakeElement(this, "#text");
    node.textContent = value;
    return node;
  }

  querySelector(_selector: string): FakeElement | null {
    return null;
  }
}

class AttachmentPreviewContainer extends FakeElement {
  constructor(
    doc: FakeDocument,
    private readonly preview: FakeElement,
  ) {
    super(doc, "div");
  }

  override querySelector(selector: string): FakeElement | null {
    return selector === "#chat-attachments-preview" ? this.preview : null;
  }
}

function asElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function message(
  id: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role: "user",
    content: "hello",
    timestamp: 1,
    ...overrides,
  };
}

describe("chat message exact navigation", function () {
  let originalAddon: unknown;

  beforeEach(function () {
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

  afterEach(function () {
    (globalThis as { addon?: unknown }).addon = originalAddon;
  });

  it("clears only session-bound quotes and refreshes the target send state", function () {
    let attachmentState = {
      pendingImages: [
        {
          type: "base64" as const,
          data: "YWJj",
          mimeType: "image/png",
          name: "figure.png",
        },
      ],
      pendingFiles: [
        {
          type: "text" as const,
          name: "notes.txt",
          content: "keep me",
          mimeType: "text/plain",
        },
      ],
      pendingSelectedText: "keep selected text",
      pendingQuotedMessages: [
        {
          sessionId: "old-session",
          messageId: "old-assistant",
          role: "assistant" as const,
          preview: "old quote",
          contentSnapshot: "old quote",
          timestamp: 1,
        },
      ],
    };
    let previewUpdates = 0;
    const icon = {
      tagName: "span",
      style: {} as Record<string, string>,
      textContent: "■",
    };
    const attributes = new Map<string, string>();
    const root = {
      querySelector: (selector: string) =>
        selector === "#chat-message-input" ? { value: "" } : null,
    };
    const sendButton = {
      disabled: true,
      style: {} as Record<string, string>,
      title: "",
      querySelector: (selector: string) =>
        selector === "#chat-send-icon" ? icon : null,
      closest: () => root,
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
    };
    const context = {
      getAttachmentState: () => attachmentState,
      setAttachmentState: (nextState: typeof attachmentState) => {
        attachmentState = nextState;
      },
      updateAttachmentsPreview: () => {
        previewUpdates += 1;
      },
    };
    const manager = {
      getActiveSession: () => ({ id: "presentation-target-session" }),
    };

    syncSessionNavigationState(
      context as any,
      sendButton as unknown as HTMLButtonElement,
      manager as any,
    );

    assert.deepEqual(attachmentState.pendingQuotedMessages, []);
    assert.lengthOf(attachmentState.pendingImages, 1);
    assert.lengthOf(attachmentState.pendingFiles, 1);
    assert.equal(attachmentState.pendingSelectedText, "keep selected text");
    assert.equal(previewUpdates, 1);
    assert.equal(icon.textContent, "↑");
    assert.equal(attributes.get("aria-label"), "paperchat-chat-send");
  });

  it("adds stable IDs to ordinary and system message wrappers", function () {
    const doc = new FakeDocument();
    const ordinary = createMessageElement(
      doc as unknown as Document,
      message('ordinary"] > *'),
      darkTheme,
    );
    const notice = createMessageElement(
      doc as unknown as Document,
      message("notice:id", {
        role: "system",
        isSystemNotice: true,
      }),
      darkTheme,
    );

    assert.equal(ordinary.getAttribute("data-message-id"), 'ordinary"] > *');
    assert.equal(notice.getAttribute("data-message-id"), "notice:id");
  });

  it("fires the render-complete callback after message wrappers exist", function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    history.scrollHeight = 100;
    history.clientHeight = 100;
    let renderedId: string | null = null;

    renderMessages(
      asElement(history),
      null,
      [message("rendered", { role: "system", isSystemNotice: true })],
      darkTheme,
      undefined,
      undefined,
      undefined,
      {
        onRenderComplete: () => {
          renderedId = history.children[0]?.getAttribute("data-message-id");
        },
      },
    );

    assert.equal(renderedId, "rendered");
  });

  it("groups an adjacent failure into the interrupted assistant footer", async function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    history.scrollHeight = 100;
    history.clientHeight = 100;
    let retried = false;
    let rerolled = false;

    renderMessages(
      asElement(history),
      null,
      [
        message("assistant-1", {
          role: "assistant",
          content: "Partial answer",
          streamingState: "interrupted",
        }),
        message("notice-1", {
          role: "system",
          content: "Switched provider",
          isSystemNotice: true,
        }),
        message("error-1", {
          role: "error",
          content: "provider failed",
        }),
      ],
      darkTheme,
      "error-1",
      () => {
        rerolled = true;
      },
      undefined,
      {
        onRetry: () => {
          retried = true;
        },
      },
    );

    assert.lengthOf(history.children, 1);
    const wrapper = history.children[0];
    assert.equal(wrapper.getAttribute("data-message-id"), "assistant-1");
    const bubble = wrapper.children[0];
    const footer = bubble.children.at(-1)!;
    assert.equal(footer.getAttribute("data-interrupted-footer"), "true");
    assert.isNull(footer.getAttribute("aria-live"));
    assert.equal(footer.getAttribute("data-attached-error-id"), "error-1");
    assert.equal(
      footer.children[0].getAttribute("data-attached-system-notice-id"),
      "notice-1",
    );
    assert.lengthOf(footer.children, 2);
    assert.equal(footer.children[1].textContent, "⚠️ provider failed");

    const actions = wrapper.children[1];
    assert.lengthOf(actions.children, 3);
    assert.equal(
      actions.children[1].getAttribute("class"),
      "message-action-btn retry-btn",
    );
    assert.equal(
      actions.children[1].getAttribute("aria-label"),
      "paperchat-chat-retry",
    );
    assert.equal(
      actions.children[1].children[0].getAttribute("src"),
      "chrome://paperchat/content/icons/refresh.svg",
    );
    actions.children[1].listeners.get("click")?.[0]?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.isTrue(retried);
    assert.equal(actions.children[1].getAttribute("data-busy"), "true");
    assert.equal(actions.children[2].getAttribute("data-busy"), "true");
    assert.equal(actions.children[1].getAttribute("aria-busy"), "true");
    assert.equal(actions.children[2].getAttribute("aria-busy"), "true");
    assert.equal(
      actions.children[2].getAttribute("class"),
      "message-action-btn reroll-btn",
    );
    assert.equal(
      actions.children[2].getAttribute("aria-label"),
      "paperchat-chat-reroll-model",
    );
    assert.equal(
      actions.children[2].children[0].getAttribute("src"),
      "chrome://paperchat/content/icons/change.svg",
    );
    actions.children[2].listeners.get("click")?.[0]?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.isFalse(rerolled);

    await Promise.resolve();
    await Promise.resolve();
    assert.isNull(actions.children[1].getAttribute("data-busy"));
    assert.isNull(actions.children[2].getAttribute("data-busy"));

    actions.children[2].listeners.get("click")?.[0]?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.isTrue(rerolled);
  });

  it("shows an interrupted footer after restart without an error row", function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    history.scrollHeight = 100;
    history.clientHeight = 100;

    renderMessages(
      asElement(history),
      null,
      [
        message("assistant-after-restart", {
          role: "assistant",
          content: "Partial answer preserved after restart",
          streamingState: "interrupted",
        }),
      ],
      darkTheme,
    );

    const footer = history.children[0].children[0].children.at(-1)!;
    assert.equal(footer.getAttribute("data-interrupted-footer"), "true");
    assert.isNull(footer.getAttribute("aria-live"));
    assert.equal(footer.children[0].textContent, "paperchat-chat-interrupted");
    assert.lengthOf(footer.children, 1);
  });

  it("projects a still-calling presentation card from an interrupted message", function () {
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      getMainWindow: () => null,
    };
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    history.scrollHeight = 100;
    history.clientHeight = 100;
    const startedAt = 1_000_000;
    const interruptedAt = startedAt + 45_000;

    try {
      renderMessages(
        asElement(history),
        null,
        [
          message("assistant-presentation-interrupted", {
            role: "assistant",
            timestamp: interruptedAt,
            content: `<tool-call status="calling" expand-key="presentation-interrupted" presentation-phase="rendering" presentation-stage="drafting" presentation-message="正在生成幻灯片" presentation-started-at="${startedAt}" presentation-stage-started-at="${startedAt + 10_000}" presentation-updated-at="${startedAt + 20_000}">
<tool-name>⏳ presentation</tool-name>
<tool-status>调用中...</tool-status>
</tool-call>`,
            streamingState: "interrupted",
          }),
        ],
        darkTheme,
        undefined,
        undefined,
        undefined,
        {
          markdown: {
            presentationResumeAction: {
              label: "恢复制作",
              busyLabel: "正在恢复…",
              onResume: async () => undefined,
            },
          },
        },
      );

      const card = history.querySelector(
        '[data-presentation-progress-card="true"]',
      );
      const elapsed = history.querySelector(
        '[data-presentation-elapsed="true"]',
      );
      const resume = history.querySelector('[data-presentation-resume="true"]');
      assert.equal(
        card?.getAttribute("data-presentation-card-status"),
        "interrupted",
      );
      assert.equal(elapsed?.textContent, "Elapsed 00:45");
      assert.equal(resume?.textContent, "恢复制作");
      assert.isNull(
        history.querySelector(
          '[data-presentation-indeterminate-progress="true"]',
        ),
      );
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
  });

  it("keeps the interrupted error footer after a later conversation turn", function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    history.scrollHeight = 100;
    history.clientHeight = 100;

    renderMessages(
      asElement(history),
      null,
      [
        message("assistant-1", {
          role: "assistant",
          content: "Partial answer",
          streamingState: "interrupted",
        }),
        message("error-1", { role: "error", content: "provider failed" }),
        message("user-2", { role: "user", content: "继续" }),
        message("assistant-2", {
          role: "assistant",
          content: "Completed continuation",
        }),
      ],
      darkTheme,
    );

    const footer = history.children[0].children[0].children.at(-1)!;
    assert.equal(footer.getAttribute("data-interrupted-footer"), "true");
    assert.equal(footer.getAttribute("data-attached-error-id"), "error-1");
    assert.lengthOf(footer.children, 1);
    assert.equal(footer.children[0].textContent, "⚠️ provider failed");
  });

  it("keeps a standalone error bubble when there is no partial response", function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    history.scrollHeight = 100;
    history.clientHeight = 100;

    renderMessages(
      asElement(history),
      null,
      [message("error-1", { role: "error", content: "provider failed" })],
      darkTheme,
    );

    assert.lengthOf(history.children, 1);
    assert.equal(
      history.children[0].getAttribute("data-message-id"),
      "error-1",
    );
    assert.equal(
      history.children[0].getAttribute("class"),
      "chat-message error-message",
    );
  });

  it("keeps quota recovery and top-up inside the interrupted footer", function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    history.scrollHeight = 100;
    history.clientHeight = 100;

    renderMessages(
      asElement(history),
      null,
      [
        message("assistant-1", {
          role: "assistant",
          content: "Partial answer",
          streamingState: "interrupted",
        }),
        message("quota-error-1", {
          role: "error",
          content: JSON.stringify({
            error: {
              code: "insufficient_user_quota",
              message: "quota exceeded",
            },
          }),
        }),
      ],
      darkTheme,
      "quota-error-1",
      () => undefined,
    );

    assert.lengthOf(history.children, 1);
    const wrapper = history.children[0];
    const footer = wrapper.children[0].children.at(-1)!;
    assert.equal(
      footer.children[0].textContent,
      "⚠️ paperchat-chat-error-paperchat-insufficient-quota",
    );
    const topup = footer.children[1];
    assert.equal(topup.getAttribute("class"), "paperchat-topup-btn");
    assert.lengthOf(topup.listeners.get("click") || [], 1);
    const actions = wrapper.children[1];
    assert.lengthOf(actions.children, 1);
    assert.equal(
      actions.children[0].getAttribute("class"),
      "message-action-btn copy-message-btn",
    );
  });

  it("offers note summarization for completed assistant replies", async function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    history.scrollHeight = 100;
    history.clientHeight = 100;
    let summarizedMessageId: string | null = null;

    renderMessages(
      asElement(history),
      null,
      [
        message("assistant-to-summarize", {
          role: "assistant",
          content: "A completed answer",
        }),
      ],
      darkTheme,
      undefined,
      undefined,
      undefined,
      {
        onSummarizeReply: (messageId) => {
          summarizedMessageId = messageId;
        },
      },
    );

    const actions = history.children[0].children[1];
    assert.lengthOf(actions.children, 2);
    const summaryButton = actions.children[1];
    assert.equal(
      summaryButton.getAttribute("class"),
      "message-action-btn summarize-reply-note-btn",
    );
    assert.equal(
      summaryButton.getAttribute("aria-label"),
      "paperchat-chat-summarize-reply-note",
    );
    assert.equal(
      summaryButton.children[0].getAttribute("src"),
      "chrome://paperchat/content/icons/write.svg",
    );

    summaryButton.listeners.get("click")?.[0]?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.equal(summarizedMessageId, "assistant-to-summarize");
    assert.equal(summaryButton.getAttribute("aria-busy"), "true");

    await Promise.resolve();
    await Promise.resolve();
    assert.isNull(summaryButton.getAttribute("aria-busy"));
  });

  it("offers quoting for completed assistant replies", function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    history.scrollHeight = 100;
    history.clientHeight = 100;
    let quotedMessageId: string | null = null;

    renderMessages(
      asElement(history),
      null,
      [
        message("assistant-to-quote", {
          role: "assistant",
          content: "A completed answer",
        }),
      ],
      darkTheme,
      undefined,
      undefined,
      undefined,
      {
        onQuoteReply: (messageId) => {
          quotedMessageId = messageId;
        },
      },
    );

    const actions = history.children[0].children[1];
    assert.lengthOf(actions.children, 2);
    const quoteButton = actions.children[1];
    assert.equal(
      quoteButton.getAttribute("class"),
      "message-action-btn quote-reply-btn",
    );
    assert.equal(
      quoteButton.getAttribute("aria-label"),
      "paperchat-chat-quote-reply",
    );
    assert.equal(
      quoteButton.children[0].getAttribute("src"),
      "chrome://paperchat/content/icons/quote.svg",
    );

    quoteButton.listeners.get("click")?.[0]?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.equal(quotedMessageId, "assistant-to-quote");
  });

  it("renders sent quote indicators in order and navigates by exact message ID", function () {
    const doc = new FakeDocument();
    const navigated: string[] = [];
    const userMessage = message("user-with-quotes", {
      quotedMessages: [
        {
          sessionId: "session-1",
          messageId: "assistant-1",
          role: "assistant",
          preview: "First answer",
          contentSnapshot: "First answer",
          timestamp: 1,
        },
        {
          sessionId: "session-1",
          messageId: "assistant-2",
          role: "assistant",
          preview: "Second answer",
          contentSnapshot: "Second answer",
          timestamp: 2,
        },
      ],
    });

    const wrapper = createMessageElement(
      doc as unknown as Document,
      userMessage,
      darkTheme,
      false,
      false,
      undefined,
      undefined,
      {
        onNavigateToQuotedMessage: (quote) => {
          navigated.push(quote.messageId);
        },
      },
    );

    const quotedReplies = wrapper.children[0].children[0];
    assert.equal(quotedReplies.getAttribute("class"), "message-quoted-replies");
    assert.deepEqual(
      quotedReplies.children.map((row) =>
        row.getAttribute("data-quoted-message-id"),
      ),
      ["assistant-1", "assistant-2"],
    );
    quotedReplies.children[1].listeners.get("click")?.[0]?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.deepEqual(navigated, ["assistant-2"]);
  });

  it("renders pending quotes as removable tags and images as thumbnails", function () {
    const doc = new FakeDocument();
    const preview = new FakeElement(doc, "div");
    const container = new AttachmentPreviewContainer(doc, preview);
    const removedQuotes: number[] = [];
    const removedImages: number[] = [];
    const navigated: string[] = [];

    updateAttachmentsPreviewDisplay(
      asElement(container),
      {
        pendingQuotedMessages: [
          {
            sessionId: "session-1",
            messageId: "assistant-1",
            role: "assistant",
            preview: "Quoted answer",
            contentSnapshot: "Quoted answer",
            timestamp: 1,
          },
        ],
        pendingImages: [
          {
            type: "base64",
            data: "YWJj",
            mimeType: "image/png",
            name: "figure.png",
          },
        ],
        pendingFiles: [],
        pendingSelectedText: null,
      },
      {
        onRemoveQuote: (index) => removedQuotes.push(index),
        onRemoveImage: (index) => removedImages.push(index),
        onNavigateQuote: (quote) => navigated.push(quote.messageId),
      },
    );

    assert.equal(preview.style.display, "flex");
    assert.lengthOf(preview.children, 2);
    const quoteTag = preview.children[0];
    assert.equal(quoteTag.getAttribute("class"), "pending-quoted-message");
    assert.equal(
      quoteTag.getAttribute("data-quoted-message-id"),
      "assistant-1",
    );
    quoteTag.listeners.get("click")?.[0]?.({});
    quoteTag.listeners.get("keydown")?.[0]?.({
      key: "Enter",
      target: quoteTag.children[1],
      currentTarget: quoteTag,
      preventDefault: () => assert.fail("nested keydown was prevented"),
    });
    quoteTag.children[1].listeners.get("click")?.[0]?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.deepEqual(navigated, ["assistant-1"]);
    assert.deepEqual(removedQuotes, [0]);

    const imageTag = preview.children[1];
    assert.equal(imageTag.getAttribute("class"), "pending-image-attachment");
    assert.equal(imageTag.children[0].tagName, "img");
    assert.equal(imageTag.children[0].style.width, "32px");
    assert.equal(
      imageTag.children[0].getAttribute("src"),
      "data:image/png;base64,YWJj",
    );
    imageTag.children[2].listeners.get("click")?.[0]?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.deepEqual(removedImages, [0]);
  });

  it("summarizes only usable conversation messages", function () {
    const user = message("user-1", { role: "user" });
    const completedAssistant = message("assistant-1", {
      role: "assistant",
      content: "Answer",
    });
    const streamingAssistant = message("assistant-streaming", {
      role: "assistant",
      content: "Partial",
      streamingState: "in_progress",
    });
    const apiOnlyAssistant = message("assistant-api-only", {
      role: "assistant",
      content: "Hidden",
      apiOnly: true,
    });

    assert.isFalse(hasConversationMessages([]));
    assert.isFalse(hasConversationMessages([apiOnlyAssistant]));
    assert.isTrue(hasConversationMessages([user]));
    assert.isTrue(canSummarizeAssistantReply(completedAssistant));
    assert.isFalse(canSummarizeAssistantReply(streamingAssistant));
    assert.isFalse(canSummarizeAssistantReply(apiOnlyAssistant));
    assert.equal(
      buildReplyNoteSummaryPrompt("Summarize", "Answer"),
      "Summarize\n\n---\nAnswer\n---",
    );
    assert.deepEqual(
      collectNoteSummarySourceItemKeys([
        message("assistant-sourced", {
          role: "assistant",
          sourceItemKeys: ["paper002"],
        }),
      ]),
      ["PAPER002"],
    );
    assert.deepEqual(
      collectNoteSummarySourceItemKeys([completedAssistant]),
      [],
    );
    const parentItem = {
      key: "PAPER002",
      getDisplayTitle: () => "Paper B",
      isAttachment: () => false,
      isNote: () => false,
    } as Zotero.Item;
    const attachment = {
      key: "ATTACH01",
      parentItemID: 42,
      getDisplayTitle: () => "Preprint PDF",
      isAttachment: () => true,
      isNote: () => false,
    } as Zotero.Item;
    assert.deepEqual(
      resolveNoteSummarySourceItem(
        "ATTACH01",
        (key) => (key === "ATTACH01" ? attachment : null),
        (id) => (id === 42 ? parentItem : null),
      ),
      { itemKey: "PAPER002", title: "Paper B" },
    );
    assert.isFalse(shouldResetSummaryButtonBusyState(null, "session-1"));
    assert.isFalse(shouldResetSummaryButtonBusyState("session-1", "session-1"));
    assert.isTrue(shouldResetSummaryButtonBusyState("session-1", "session-2"));
    assert.isFalse(providerSupportsToolCalling(null));
    assert.isFalse(providerSupportsToolCalling({} as any));
    assert.isTrue(
      providerSupportsToolCalling({
        chatCompletionWithTools: async () => ({ content: "" }),
      } as any),
    );
  });

  it("renders destination radios up to four choices and a paper select above four", function () {
    const renderDestination = (paperCount: number) => {
      const doc = new FakeDocument();
      const panel = new FakeElement(doc, "div");
      const context = createNoteSummaryContext(
        Array.from({ length: paperCount }, (_, index) => ({
          itemKey: `PAPER${String(index + 1).padStart(3, "0")}`,
          title: `Paper ${index + 1}`,
        })),
      );
      let response: any;
      updateUserInputRequestView(
        asElement(panel),
        darkTheme,
        {
          pendingRequests: [
            {
              id: "destination-request",
              sessionId: "session",
              assistantMessageId: "assistant",
              toolCallId: "request-user-input",
              toolName: "request_user_input",
              args: buildNoteSummaryDestinationRequestArgs(context),
              status: "pending",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          updatedAt: 1,
        },
        {
          onResolveUserInput: (_requestId, value) => {
            response = value;
          },
        },
      );
      return { panel, getResponse: () => response };
    };

    const fourChoices = renderDestination(3).panel;
    assert.lengthOf(fourChoices.querySelectorAll("input"), 4);
    assert.lengthOf(fourChoices.querySelectorAll("select"), 0);

    const fiveChoices = renderDestination(4);
    const radios = fiveChoices.panel.querySelectorAll("input");
    const selects = fiveChoices.panel.querySelectorAll("select");
    assert.lengthOf(radios, 2);
    assert.lengthOf(selects, 1);
    assert.isTrue(radios[0].checked);
    assert.isFalse(radios[1].checked);

    const select = selects[0];
    select.value = "paper:PAPER004";
    select.listeners.get("change")?.[0]?.({});
    assert.isTrue(radios[1].checked);
    assert.equal(radios[1].value, "paper:PAPER004");

    const form = fiveChoices.panel.querySelector("form")!;
    form.listeners.get("submit")?.[0]?.({
      preventDefault: () => undefined,
    });
    assert.deepEqual(
      fiveChoices.getResponse().answers.note_summary_destination.answers,
      ["paper:PAPER004"],
    );
  });

  it("matches opaque message IDs without CSS selector escaping", function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    const first = new FakeElement(doc, "div");
    const target = new FakeElement(doc, "div");
    const opaqueId = 'message"]:not(*) \\ / 漢字';
    first.setAttribute("data-message-id", "first");
    target.setAttribute("data-message-id", opaqueId);
    history.appendChild(first);
    history.appendChild(target);

    assert.strictEqual(
      findRenderedMessageElement(asElement(history), opaqueId),
      asElement(target),
    );
    assert.isNull(findRenderedMessageElement(asElement(history), "missing"));
  });

  it("centers the message and briefly flashes only its bubble", async function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    const target = new FakeElement(doc, "div");
    const bubble = new FakeElement(doc, "div");
    history.scrollTop = 20;
    history.scrollHeight = 600;
    history.clientHeight = 200;
    history.setRect({ top: 100, height: 200 });
    target.setRect({ top: 350, height: 40 });
    target.setAttribute("data-message-id", "target");
    bubble.setAttribute("class", "chat-bubble");
    bubble.style.backgroundColor = "navy";
    target.appendChild(bubble);
    history.appendChild(target);

    const found = scrollToAndHighlightMessage(asElement(history), "target", 5);

    assert.strictEqual(found, asElement(target));
    assert.equal(history.scrollTop, 190);
    assert.equal(history.getAttribute("data-auto-scroll"), "false");
    assert.equal(target.style.backgroundColor, "");
    assert.equal(bubble.style.backgroundColor, "navy");
    assert.lengthOf(bubble.children, 1);
    assert.equal(
      bubble.children[0].getAttribute("class"),
      "paperchat-message-highlight-overlay",
    );
    assert.equal(
      bubble.children[0].style.backgroundColor,
      "rgba(59, 130, 246, 0.18)",
    );
    assert.equal(bubble.children[0].style.opacity, "0.72");
    assert.equal(bubble.children[0].style.animation, undefined);
    assert.equal(bubble.children[0].style.boxShadow, "");

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.lengthOf(bubble.children, 0);
    assert.equal(bubble.style.backgroundColor, "navy");
    assert.equal(bubble.style.position, "");
  });

  it("pulses the bubble background twice before removing the overlay", async function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    const target = new FakeElement(doc, "div");
    const bubble = new FakeElement(doc, "div");
    history.clientHeight = 200;
    history.scrollHeight = 600;
    history.setRect({ top: 0, height: 200 });
    target.setRect({ top: 100, height: 40 });
    target.setAttribute("data-message-id", "double-pulse");
    bubble.setAttribute("class", "chat-bubble");
    target.appendChild(bubble);
    history.appendChild(target);

    scrollToAndHighlightMessage(asElement(history), "double-pulse", 300);
    const overlay = bubble.children[0];
    assert.equal(overlay.style.opacity, "0.72");

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(overlay.style.opacity, "0");

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(overlay.style.opacity, "0.58");

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(overlay.style.opacity, "0");

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.lengthOf(bubble.children, 0);
  });

  it("does not let an earlier render lease clear a newer highlight", async function () {
    const doc = new FakeDocument();
    const history = new FakeElement(doc, "div");
    history.clientHeight = 200;
    history.scrollHeight = 600;
    history.setRect({ top: 0, height: 200 });

    const firstRender = new FakeElement(doc, "div");
    const firstBubble = new FakeElement(doc, "div");
    firstRender.setAttribute("data-message-id", "same-id");
    firstRender.setRect({ top: 100, height: 40 });
    firstBubble.setAttribute("class", "chat-bubble");
    firstRender.appendChild(firstBubble);
    history.appendChild(firstRender);
    scrollToAndHighlightMessage(asElement(history), "same-id", 5);

    history.children.length = 0;
    const secondRender = new FakeElement(doc, "div");
    const secondBubble = new FakeElement(doc, "div");
    secondRender.setAttribute("data-message-id", "same-id");
    secondRender.setRect({ top: 100, height: 40 });
    secondBubble.setAttribute("class", "chat-bubble");
    secondRender.appendChild(secondBubble);
    history.appendChild(secondRender);
    scrollToAndHighlightMessage(asElement(history), "same-id", 30);

    await new Promise((resolve) => setTimeout(resolve, 12));
    assert.lengthOf(secondBubble.children, 1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.lengthOf(secondBubble.children, 0);
  });
});
