import { assert } from "chai";
import { ChatManager } from "../src/modules/chat/ChatManager.ts";
import {
  stopSessionTurn,
  syncSendButtonState,
} from "../src/modules/ui/chat-panel/ChatPanelEvents.ts";
import { sessionTurnQueue } from "../src/modules/ui/chat-panel/SessionTurnQueue.ts";

describe("send button run state", function () {
  const runtime = globalThis as Record<string, any>;
  let previousAddon: unknown;

  beforeEach(function () {
    previousAddon = runtime.addon;
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
  });

  afterEach(function () {
    sessionTurnQueue.clearAll();
    runtime.addon = previousAddon;
  });

  function fixture() {
    const manager = Object.create(ChatManager.prototype) as any;
    Object.assign(manager, {
      activeSessionRunIds: new Map(),
      sessionRunCounters: new Map(),
      activeSessionAbortControllers: new Map(),
      streamingSessions: new Map(),
    });
    let session = { id: "note-session" };
    manager.getActiveSession = () => session;
    const input = { value: "" };
    const icon = { tagName: "span", textContent: "", style: {} };
    const root = {
      querySelector: (selector: string) =>
        selector === "#chat-message-input" ? input : null,
    };
    const button = {
      style: {},
      title: "",
      disabled: false,
      closest: () => root,
      querySelector: () => icon,
      setAttribute: () => {},
    } as unknown as HTMLButtonElement;
    const sync = () => syncSendButtonState(button, manager);
    const unsubscribe = manager.subscribeRunActivity(sync);
    return {
      manager,
      button,
      icon,
      input,
      sync,
      unsubscribe,
      session,
      switchSession: (id: string) => {
        session = { id };
        sync();
      },
    };
  }

  it("shows Stop for a direct note run and restores Send after completion", function () {
    const f = fixture();
    try {
      assert.equal(f.icon.textContent, "↑");
      assert.equal(sessionTurnQueue.snapshot(f.session.id).status, "idle");
      const run = f.manager.beginSessionRun(f.session);
      assert.equal(f.icon.textContent, "■");
      assert.include(f.button.title, "stop-generating");
      f.manager.completeSessionRun(f.session, run.runId);
      assert.equal(f.icon.textContent, "↑");
    } finally {
      f.unsubscribe();
    }
  });

  it("tracks only the displayed session and preserves draft send behavior", function () {
    const f = fixture();
    try {
      f.manager.beginSessionRun(f.session);
      f.switchSession("other");
      assert.equal(f.icon.textContent, "↑");
      f.switchSession(f.session.id);
      assert.equal(f.icon.textContent, "■");
      f.input.value = "next question";
      f.sync();
      assert.equal(f.icon.textContent, "↑");
      f.input.value = "";
      f.sync();
      assert.equal(f.icon.textContent, "■");
    } finally {
      f.unsubscribe();
    }
  });

  it("cancels a direct run through ChatManager and updates the button", async function () {
    const f = fixture();
    try {
      const stopped: string[] = [];
      f.manager.beginSessionRun(f.session);
      f.manager.cancelSessionTurn = async (id: string) => {
        stopped.push(id);
        f.manager.invalidateSessionRun(id, { abort: true });
        return true;
      };
      assert.isTrue(await stopSessionTurn(f.manager, f.session.id));
      assert.deepEqual(stopped, [f.session.id]);
      assert.equal(f.icon.textContent, "↑");
    } finally {
      f.unsubscribe();
    }
  });

  it("keeps cancellation of queue-owned turns on the queue path", async function () {
    const f = fixture();
    let resolve!: (value: { accepted: boolean }) => void;
    const pending = new Promise<{ accepted: boolean }>((done) => {
      resolve = done;
    });
    let cancellations = 0;
    try {
      sessionTurnQueue.enqueue(f.session.id, {
        id: "queued",
        content: "question",
        draft: {
          content: "question",
          attachmentState: {
            pendingImages: [],
            pendingFiles: [],
            pinnedSelectedTexts: [],
            pendingSelectedText: null,
            pendingQuotedMessages: [],
          },
        },
        run: () => pending,
        cancel: async () => {
          cancellations++;
          resolve({ accepted: true });
          return true;
        },
      });
      f.manager.cancelSessionTurn = async () => {
        throw new Error("Must cancel via queue");
      };
      f.sync();
      assert.equal(f.icon.textContent, "■");
      assert.isTrue(await stopSessionTurn(f.manager, f.session.id));
      assert.equal(cancellations, 1);
      f.sync();
      assert.equal(f.icon.textContent, "↑");
    } finally {
      resolve({ accepted: true });
      f.unsubscribe();
    }
  });
});
