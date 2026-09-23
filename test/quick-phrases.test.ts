import { assert } from "chai";
import {
  MAX_QUICK_PHRASES,
  addQuickPhrase,
  appendQuickPhraseToDraft,
  canAddQuickPhrase,
  defaultQuickPhrases,
  loadQuickPhrases,
  removeQuickPhrase,
  sanitizeQuickPhrases,
  saveQuickPhrases,
} from "../src/modules/ui/chat-panel/QuickPhrases.ts";

const PREFS_PREFIX = "extensions.zotero.paperchat.";

describe("chat quick phrases", function () {
  let originalZotero: unknown;
  let originalAddon: unknown;
  let prefStore: Map<string, unknown>;

  beforeEach(function () {
    originalZotero = (globalThis as any).Zotero;
    originalAddon = (globalThis as any).addon;
    prefStore = new Map();
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => prefStore.set(key, value),
      },
    };
    (globalThis as any).addon = {
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
  });

  afterEach(function () {
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).addon = originalAddon;
  });

  it("trims, dedupes, and caps the stored list", function () {
    assert.deepEqual(
      sanitizeQuickPhrases(["  first  ", "first", "", "  ", "second", 7, null]),
      ["first", "second"],
    );
    assert.deepEqual(sanitizeQuickPhrases("not a list"), []);
    assert.lengthOf(
      sanitizeQuickPhrases(
        Array.from({ length: MAX_QUICK_PHRASES + 5 }, (_, i) => `phrase-${i}`),
      ),
      MAX_QUICK_PHRASES,
    );
  });

  it("adds phrases once and stops at the limit", function () {
    assert.deepEqual(addQuickPhrase(["first"], "  second  "), [
      "first",
      "second",
    ]);
    assert.deepEqual(addQuickPhrase(["first"], "   "), ["first"]);
    assert.deepEqual(addQuickPhrase(["first"], "first"), ["first"]);

    const full = Array.from(
      { length: MAX_QUICK_PHRASES },
      (_, i) => `phrase-${i}`,
    );
    assert.isFalse(canAddQuickPhrase(full));
    assert.deepEqual(addQuickPhrase(full, "one more"), full);
  });

  it("removes the requested entry and ignores stray indexes", function () {
    assert.deepEqual(removeQuickPhrase(["a", "b", "c"], 1), ["a", "c"]);
    assert.deepEqual(removeQuickPhrase(["a"], 4), ["a"]);
    assert.deepEqual(removeQuickPhrase(["a"], -1), ["a"]);
    assert.deepEqual(removeQuickPhrase(["a"], 0.5), ["a"]);
  });

  it("extends the draft instead of replacing it", function () {
    assert.equal(appendQuickPhraseToDraft("", "summarize"), "summarize");
    assert.equal(appendQuickPhraseToDraft("   \n ", "summarize"), "summarize");
    assert.equal(
      appendQuickPhraseToDraft("existing draft", "  summarize  "),
      "existing draft\nsummarize",
    );
    assert.equal(
      appendQuickPhraseToDraft("existing draft", "   "),
      "existing draft",
    );
  });

  it("seeds the presets on first use and keeps them afterwards", function () {
    const seeded = loadQuickPhrases();

    assert.deepEqual(seeded, [
      "paperchat-chat-quick-phrases-preset-summarize",
      "paperchat-chat-quick-phrases-preset-contributions",
      "paperchat-chat-quick-phrases-preset-limitations",
    ]);
    assert.deepEqual(seeded, defaultQuickPhrases());
    assert.equal(
      prefStore.get(`${PREFS_PREFIX}quickPhrases`),
      JSON.stringify(seeded),
    );
    assert.deepEqual(loadQuickPhrases(), seeded);
  });

  it("keeps a deliberately emptied list empty", function () {
    loadQuickPhrases();
    saveQuickPhrases([]);

    assert.equal(prefStore.get(`${PREFS_PREFIX}quickPhrases`), "[]");
    assert.deepEqual(loadQuickPhrases(), []);
  });

  it("reads stored phrases and survives a corrupt entry", function () {
    prefStore.set(
      `${PREFS_PREFIX}quickPhrases`,
      JSON.stringify([" first ", "first", 3, "second"]),
    );
    assert.deepEqual(loadQuickPhrases(), ["first", "second"]);

    prefStore.set(`${PREFS_PREFIX}quickPhrases`, "{not json");
    assert.deepEqual(loadQuickPhrases(), []);
  });
});
