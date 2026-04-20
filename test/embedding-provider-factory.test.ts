import { assert } from "chai";
import { destroyAuthManager } from "../src/modules/auth";
import { destroyEmbeddingProviderFactory } from "../src/modules/embedding";
import { destroyProviderManager } from "../src/modules/providers";

describe("embedding provider factory", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let originalAddon: unknown;
  let originalFetch: unknown;

  beforeEach(function () {
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    originalAddon = (globalThis as any).addon;
    originalFetch = (globalThis as any).fetch;

    const prefStore = new Map<string, unknown>([
      ["extensions.zotero.paperchat.apiKey", "sk-test"],
      ["extensions.zotero.paperchat.userId", 1],
      ["extensions.zotero.paperchat.username", "tester"],
      [
        "extensions.zotero.paperchat.paperchatModelsCache",
        JSON.stringify([
          "text-embedding-v4",
          "claude-haiku-4-5-20251001",
        ]),
      ],
    ]);

    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
          return true;
        },
        clear: (key: string) => {
          prefStore.delete(key);
          return true;
        },
      },
      Libraries: {
        userLibraryID: 1,
      },
      DataDirectory: {
        dir: "/tmp",
      },
    };
    (globalThis as any).ztoolkit = {
      log: () => undefined,
    };
    (globalThis as any).addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: () => [{ value: "", attributes: [] }],
          },
        },
      },
    };
  });

  afterEach(function () {
    destroyEmbeddingProviderFactory();
    destroyAuthManager();
    destroyProviderManager();
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
    (globalThis as any).addon = originalAddon;
    (globalThis as any).fetch = originalFetch;
  });

  it("resolves a PaperChat provider without probing the embeddings endpoint", async function () {
    let fetchCalls = 0;
    (globalThis as any).fetch = async () => {
      fetchCalls += 1;
      throw new Error("fetch should not be called while resolving provider");
    };

    const { getEmbeddingProviderFactory } = await import(
      "../src/modules/embedding/EmbeddingProviderFactory"
    );
    const factory = getEmbeddingProviderFactory();
    const provider = await factory.getProvider();

    assert.isNotNull(provider);
    assert.equal(provider?.type, "paperchat");
    assert.equal(provider?.modelId, "paperchat:text-embedding-v4");
    assert.equal(fetchCalls, 0);
  });
});
