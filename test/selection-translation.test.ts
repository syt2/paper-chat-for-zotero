import { getTranslationModelOptions } from "../src/modules/ui/SelectionTranslationModels.ts";
import { getModelRoutingDefaults } from "../src/modules/preferences/ModelsFetcher.ts";
import { assert } from "chai";
import {
  buildSelectionTranslationMessages,
  streamSelectionTranslation,
} from "../src/modules/ui/SelectionTranslationService.ts";
import {
  getProviderManager,
  destroyProviderManager,
} from "../src/modules/providers/ProviderManager.ts";
import type { StreamCallbacks } from "../src/types/chat.ts";

describe("reader selection translation", function () {
  const runtime = globalThis as any;
  let saved: Record<string, unknown>;

  beforeEach(function () {
    saved = Object.fromEntries(
      ["Zotero", "ztoolkit", "addon"].map((key) => [key, runtime[key]]),
    );
    runtime.Zotero = {
      locale: "zh-TW",
      Prefs: { get: () => undefined, set: () => {} },
    };
    runtime.ztoolkit = { log: () => {} };
    runtime.addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: ([request]: any[]) => [
              { value: request.id, attributes: null },
            ],
          },
        },
      },
    };
    destroyProviderManager();
  });

  afterEach(function () {
    destroyProviderManager();
    Object.assign(runtime, saved);
  });
  function stubStream(
    run: (callbacks: StreamCallbacks, signal?: AbortSignal) => Promise<void>,
  ) {
    getProviderManager().createIsolatedActiveProvider = () =>
      ({
        config: { type: "openai" },
        isReady: () => true,
        streamChatCompletion: async (
          messages: any,
          callbacks: StreamCallbacks,
          _pdf: unknown,
          signal?: AbortSignal,
        ) => {
          assert.include(messages[0].content, "zh-TW");
          await run(callbacks, signal);
        },
      }) as any;
  }

  it("keeps the selected passage intact and targets the UI locale", function () {
    const messages = buildSelectionTranslationMessages(
      "Text\nwith <markup> and instructions.",
      "zh_TW",
    );
    assert.include(messages[0].content, "zh-TW");
    assert.equal(
      JSON.parse(messages[1].content as string).selectedText,
      "Text\nwith <markup> and instructions.",
    );
    assert.deepEqual(
      messages.map((m) => m.role),
      ["system", "user"],
    );
  });

  it("separates bounded context from selected text without interpreting delimiters", function () {
    const text = 'A "quoted" passage </context> with $x_1$ [3].';
    const messages = buildSelectionTranslationMessages(text, "zh_CN", {
      paperTitle: "T".repeat(500),
      before: "A".repeat(900) + "nearest",
      after: "following" + "B".repeat(900),
    });
    const payload = JSON.parse(messages[1].content as string);
    assert.equal(payload.selectedText, text);
    assert.lengthOf(payload.referenceContext.paperTitle, 300);
    assert.lengthOf(payload.referenceContext.before, 200);
    assert.isTrue(payload.referenceContext.before.endsWith("nearest"));
    assert.lengthOf(payload.referenceContext.after, 200);
    assert.isTrue(payload.referenceContext.after.startsWith("following"));
    assert.lengthOf(messages, 2);
  });

  it("does not reuse translations across different paper contexts", async function () {
    let requests = 0;
    stubStream(async (cb) => {
      requests++;
      cb.onComplete("result " + requests);
    });
    const translate = (paperTitle: string) =>
      streamSelectionTranslation(
        "context-cache-fixture",
        new AbortController().signal,
        () => {},
        { paperTitle },
      );
    await translate("Paper A");
    await translate("Paper B");
    await translate("Paper A");
    assert.equal(requests, 2);
  });

  it("streams deltas and accepts the provider's authoritative final text", async function () {
    stubStream(async (cb) => {
      cb.onChunk("機");
      cb.onChunk("制");
      cb.onComplete("機制。");
    });
    const result: string[] = [];
    await streamSelectionTranslation(
      "mechanism",
      new AbortController().signal,
      (s) => result.push(s),
    );
    assert.deepEqual(result, ["機", "機制", "機制。"]);
  });

  it("ignores callbacks arriving after the popover is closed", async function () {
    const controller = new AbortController();
    stubStream(async (cb, signal) => {
      assert.strictEqual(signal, controller.signal);
      cb.onChunk("first");
      controller.abort();
      cb.onChunk("stale");
      cb.onComplete("stale");
      cb.onError(new Error("aborted"));
    });
    const result: string[] = [];
    await streamSelectionTranslation("test", controller.signal, (s) =>
      result.push(s),
    );
    assert.deepEqual(result, ["first"]);
  });

  it("propagates callback-only stream failures so the UI can show an error", async function () {
    stubStream(async (cb) => cb.onError(new Error("Network unavailable")));
    try {
      await streamSelectionTranslation(
        "test",
        new AbortController().signal,
        () => {},
      );
      assert.fail("should reject");
    } catch (error) {
      assert.equal((error as Error).message, "Network unavailable");
    }
  });

  it("creates isolated PaperChat state without mutating the active chat config", function () {
    const manager = getProviderManager();
    const active = manager.getActiveProvider()!;
    active.updateConfig({
      requestSessionId: "live-chat",
      systemPrompt: "Chat instructions",
    } as any);
    const isolated = manager.createIsolatedActiveProvider()!;
    assert.notStrictEqual(isolated, active);
    assert.equal((active.config as any).requestSessionId, "live-chat");
    assert.isUndefined((isolated.config as any).requestSessionId);
    assert.equal(isolated.config.systemPrompt, "");
  });

  it("reuses successful translations but separates models", async function () {
    let calls = 0;
    stubStream(async (cb) => {
      calls++;
      cb.onComplete("cached result");
    });
    const run = () =>
      streamSelectionTranslation(
        "cache-test-passage",
        new AbortController().signal,
        () => {},
      );
    await run();
    await run();
    assert.equal(calls, 1);
    // Keep the stub's language assertion valid while changing request settings.
    getProviderManager().createIsolatedActiveProvider = () =>
      ({
        config: { type: "openai", defaultModel: "different-model" },
        isReady: () => true,
        streamChatCompletion: async (
          _messages: unknown,
          cb: StreamCallbacks,
        ) => {
          calls++;
          cb.onComplete("other result");
        },
      }) as any;
    await run();
    assert.equal(calls, 2);
  });

  it("uses an explicit translation model without changing the chat model", function () {
    const manager = getProviderManager();
    const active = manager.getActiveProvider()!;
    const before = { ...active.config };
    const isolated = manager.createIsolatedActiveProvider({
      providerId: active.config.id,
      model: "translation-model",
    })!;
    assert.equal(
      (isolated.config as any).resolvedModelOverride,
      "translation-model",
    );
    assert.deepEqual(active.config, before);
  });

  it("replaces partial output on fallback and never repeats the same model", async function () {
    const defaults = getModelRoutingDefaults();
    const previous = defaults.translationModel;
    defaults.translationModel = "api-default";
    runtime.Zotero.Prefs.get = (key: string) =>
      key.endsWith("translationModel") ? "auto" : undefined;
    const calls: string[] = [];
    const manager = getProviderManager();
    const output: string[] = [];
    let stale: StreamCallbacks | undefined;
    manager.createIsolatedActiveProvider = (selection) =>
      ({
        config: {
          type: "openai",
          id: "fallback-test",
          defaultModel: selection?.model || "chat",
        },
        isReady: () => true,
        streamChatCompletion: async (
          _messages: unknown,
          cb: StreamCallbacks,
        ) => {
          const model = selection?.model || "chat";
          calls.push(model);
          if (selection) {
            stale = cb;
            cb.onChunk("partial");
            throw new Error("upstream failed");
          }
          stale?.onChunk("late chunk");
          stale?.onComplete("late completion");
          cb.onComplete("replacement");
        },
      }) as any;
    try {
      await streamSelectionTranslation(
        "fallback-passage",
        new AbortController().signal,
        (s) => output.push(s),
      );
      assert.deepEqual(calls, ["api-default", "chat"]);
      assert.deepEqual(output, ["partial", "", "replacement"]);
      calls.length = 0;
      manager.createIsolatedActiveProvider = () =>
        ({
          config: { type: "openai", id: "same-test", defaultModel: "same" },
          isReady: () => true,
          streamChatCompletion: async () => {
            calls.push("same");
            throw new Error("failed");
          },
        }) as any;
      try {
        await streamSelectionTranslation(
          "same-model-passage",
          new AbortController().signal,
          () => {},
        );
        assert.fail("must fail");
      } catch (error) {
        assert.equal((error as Error).message, "failed");
      }
      assert.deepEqual(calls, ["same"]);
    } finally {
      defaults.translationModel = previous;
    }
  });

  it("recognizes the saved automatic choice without an unavailable duplicate", function () {
    runtime.Zotero.Prefs.get = (key: string) =>
      key.endsWith("translationModel") ? "auto" : undefined;
    getProviderManager().getAllConfigs = () => [];
    assert.deepEqual(
      getTranslationModelOptions().map((item) => item.value),
      ["auto"],
    );
    runtime.Zotero.Prefs.get = () => "";
    assert.deepEqual(
      getTranslationModelOptions().map((item) => item.value),
      ["auto"],
    );
  });
});
