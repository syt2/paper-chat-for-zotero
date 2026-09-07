import { assert } from "chai";
import { sendMessage } from "../src/modules/ui/chat-panel/ChatPanelEvents";
import { sessionTurnQueue } from "../src/modules/ui/chat-panel/SessionTurnQueue";
import { getProviderManager } from "../src/modules/providers/ProviderManager";
import { syncChatHistoryAfterLayout } from "../src/modules/ui/chat-panel/MessageRenderer";
import type { ChatPanelContext } from "../src/modules/ui/chat-panel/types";

describe("explicit chat send scrolling", function () {
  const runtime = globalThis as Record<string, any>;
  let toolkit: unknown;
  let zotero: unknown;
  let addon: unknown;
  let enqueue: typeof sessionTurnQueue.enqueue;
  let provider: ReturnType<typeof getProviderManager>;
  let getActiveProvider: typeof provider.getActiveProvider;
  let getActiveProviderId: typeof provider.getActiveProviderId;

  beforeEach(function () {
    zotero = runtime.Zotero;
    runtime.Zotero = { Prefs: { get: () => false }, getMainWindow: () => ({}) };
    toolkit = runtime.ztoolkit;
    addon = runtime.addon;
    runtime.ztoolkit = { log: () => {} };
    runtime.addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: (requests: Array<{ id: string }>) =>
              requests.map(({ id }) => ({ value: id })),
          },
        },
      },
    };
    provider = getProviderManager();
    getActiveProvider = provider.getActiveProvider;
    getActiveProviderId = provider.getActiveProviderId;
    provider.getActiveProviderId = () => "deepseek";
    provider.getActiveProvider = () =>
      ({ isReady: () => true }) as ReturnType<typeof getActiveProvider>;
    enqueue = sessionTurnQueue.enqueue;
  });

  afterEach(function () {
    sessionTurnQueue.enqueue = enqueue;
    provider.getActiveProvider = getActiveProvider;
    provider.getActiveProviderId = getActiveProviderId;
    runtime.Zotero = zotero;
    runtime.ztoolkit = toolkit;
    runtime.addon = addon;
  });

  function fixture() {
    const attrs = new Map([["data-auto-scroll", "false"]]);
    const history = {
      scrollTop: 120,
      scrollHeight: 1600,
      clientHeight: 500,
      getAttribute: (key: string) => attrs.get(key) ?? null,
      setAttribute: (key: string, value: string) => attrs.set(key, value),
      hasAttribute: (key: string) => attrs.has(key),
    } as unknown as HTMLElement;
    const input = {
      value: "new question",
      style: {},
      scrollHeight: 60,
      focus: () => {},
    } as unknown as HTMLTextAreaElement;
    let activeSession = { id: "send-scroll", messages: [] };
    let cleared = false;
    const errors: string[] = [];
    const context = {
      container: {
        querySelector: (selector: string) =>
          selector === "#chat-history" ? history : null,
        querySelectorAll: () => [],
      },
      chatManager: { getActiveSession: () => activeSession },
      getCurrentItem: () => ({ id: 0 }),
      getAttachmentState: () => ({
        pendingImages: [],
        pendingFiles: [],
        pendingQuotedMessages: [],
      }),
      clearAttachments: () => {
        cleared = true;
      },
      updateAttachmentsPreview: () => {
        history.scrollHeight = 1800;
      },
      appendError: (error: string) => errors.push(error),
    } as unknown as ChatPanelContext;
    return {
      history,
      input,
      context,
      errors,
      cleared: () => cleared,
      switchSession: () => {
        activeSession = { id: "other", messages: [] };
      },
    };
  }

  it("resumes bottom follow after acceptance, including queued sends and composer layout changes", async function () {
    const f = fixture();
    sessionTurnQueue.enqueue = () => true;
    await sendMessage(f.context, f.input, null, null);
    assert.isEmpty(f.errors);
    assert.equal(f.history.scrollTop, 1800);
    assert.equal(f.history.getAttribute("data-auto-scroll"), "true");
    assert.equal(f.input.value, "");
    assert.isTrue(f.cleared());
    f.history.scrollHeight = 2000;
    syncChatHistoryAfterLayout(f.history);
    assert.equal(f.history.scrollTop, 2000);
  });

  it("leaves the reading position and draft intact when the queue is full", async function () {
    const f = fixture();
    sessionTurnQueue.enqueue = () => false;
    await sendMessage(f.context, f.input, null, null);
    assert.equal(f.history.scrollTop, 120);
    assert.equal(f.history.getAttribute("data-auto-scroll"), "false");
    assert.equal(f.input.value, "new question");
    assert.isFalse(f.cleared());
    assert.lengthOf(f.errors, 1);
  });

  it("does not scroll for an empty draft", async function () {
    const f = fixture();
    f.input.value = " ";
    sessionTurnQueue.enqueue = () => {
      throw new Error("must not enqueue");
    };
    await sendMessage(f.context, f.input, null, null);
    assert.equal(f.history.scrollTop, 120);
    assert.equal(f.history.getAttribute("data-auto-scroll"), "false");
    assert.isEmpty(f.errors);
  });

  it("does not pull another active conversation to the bottom", async function () {
    const f = fixture();
    sessionTurnQueue.enqueue = () => {
      f.switchSession();
      return true;
    };
    await sendMessage(f.context, f.input, null, null);
    assert.equal(f.history.scrollTop, 120);
    assert.equal(f.history.getAttribute("data-auto-scroll"), "false");
  });
});
