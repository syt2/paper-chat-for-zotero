import { assert } from "chai";
import { getTranslationModelOptions } from "../src/modules/ui/SelectionTranslationModels.ts";
import {
  getProviderManager,
  destroyProviderManager,
} from "../src/modules/providers/ProviderManager.ts";
import {
  clearPaperchatModelCaches,
  fetchPaperchatRoutingMeta,
  getModelRatios,
  getModelRoutingDefaults,
  getModelRoutingMeta,
  getSelectablePaperchatModels,
  loadCachedRatios,
} from "../src/modules/preferences/ModelsFetcher";

const PREFS_PREFIX = "extensions.zotero.paperchat.";

describe("PaperChat model cache", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let originalFetch: unknown;
  let prefStore: Map<string, unknown>;

  beforeEach(function () {
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    originalFetch = (globalThis as any).fetch;
    prefStore = new Map([
      [`${PREFS_PREFIX}paperchatModelsCache`, '["model-a"]'],
      [`${PREFS_PREFIX}paperchatRatiosCache`, '{"model-a":2}'],
      [
        `${PREFS_PREFIX}paperchatRoutingConfigCache`,
        '{"model-a":{"upstreamModelId":"upstream-a"}}',
      ],
      [
        `${PREFS_PREFIX}paperchatRoutingDefaultsCache`,
        '{"defaults":{"contextSummaryModel":"model-a"}}',
      ],
    ]);
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => prefStore.set(key, value),
      },
    };
    (globalThis as any).ztoolkit = { log: () => undefined };
    loadCachedRatios();
  });

  afterEach(function () {
    clearPaperchatModelCaches();
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
    (globalThis as any).fetch = originalFetch;
  });

  it("lists only the key/routing intersection without losing raw key models", function () {
    const raw = ["model-a", "key-only", "text-embedding-3-small", "model-a"];
    prefStore.set(`${PREFS_PREFIX}paperchatModelsCache`, JSON.stringify(raw));
    prefStore.set(
      `${PREFS_PREFIX}paperchatRoutingConfigCache`,
      JSON.stringify({
        "model-a": {},
        "route-only": {},
        "text-embedding-3-small": {},
      }),
    );
    loadCachedRatios();
    assert.deepEqual(getSelectablePaperchatModels(), ["model-a"]);
    assert.deepEqual(getSelectablePaperchatModels(["route-only", "key-only"]), [
      "route-only",
    ]);
    assert.equal(
      prefStore.get(`${PREFS_PREFIX}paperchatModelsCache`),
      JSON.stringify(raw),
    );
  });

  it("uses an empty intersection when either source is missing or empty", function () {
    clearPaperchatModelCaches();
    assert.deepEqual(getSelectablePaperchatModels(["model-a"]), []);
    prefStore.set(
      `${PREFS_PREFIX}paperchatRoutingConfigCache`,
      '{"model-a":{}}',
    );
    loadCachedRatios();
    assert.deepEqual(getSelectablePaperchatModels([]), []);
    prefStore.set(`${PREFS_PREFIX}paperchatModelsCache`, "invalid");
    assert.deepEqual(getSelectablePaperchatModels(), []);
  });

  it("handles malformed caches and entries without exposing invalid models", function () {
    for (const cached of ["invalid", "null", "[]", '"model-a"', "42"]) {
      prefStore.set(`${PREFS_PREFIX}paperchatRoutingConfigCache`, cached);
      loadCachedRatios();
      assert.deepEqual(getSelectablePaperchatModels(), [], cached);
      assert.deepEqual(getModelRoutingMeta(), {}, cached);
    }

    prefStore.set(
      `${PREFS_PREFIX}paperchatRoutingConfigCache`,
      '{"model-a":{},"broken":null,"array":[],"scalar":true,"":{}}',
    );
    prefStore.set(
      `${PREFS_PREFIX}paperchatModelsCache`,
      '["model-a",null,42,"broken","array","scalar","","toString"]',
    );
    // The list can also be read before the in-memory routing cache is loaded.
    assert.deepEqual(getSelectablePaperchatModels(), ["model-a"]);
    loadCachedRatios();
    assert.deepEqual(getSelectablePaperchatModels(), ["model-a"]);
    for (const cached of ["null", "{}", '"model-a"']) {
      prefStore.set(`${PREFS_PREFIX}paperchatModelsCache`, cached);
      assert.deepEqual(getSelectablePaperchatModels(), [], cached);
    }
  });

  it("removes stale choices after a successful empty routing refresh", async function () {
    assert.deepEqual(getSelectablePaperchatModels(), ["model-a"]);
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ models: {} }), { status: 200 });
    await fetchPaperchatRoutingMeta();
    assert.deepEqual(getSelectablePaperchatModels(), []);
    loadCachedRatios();
    assert.deepEqual(getSelectablePaperchatModels(), []);
  });

  it("keeps route entries without optional metadata and cached routes on network failure", async function () {
    prefStore.set(`${PREFS_PREFIX}paperchatModelsCache`, '["plain","removed"]');
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({
          models: { plain: {}, broken: null },
        }),
        { status: 200 },
      );
    await fetchPaperchatRoutingMeta();
    assert.deepEqual(getSelectablePaperchatModels(), ["plain"]);
    (globalThis as any).fetch = async () => {
      throw new Error("offline");
    };
    await fetchPaperchatRoutingMeta();
    assert.deepEqual(getSelectablePaperchatModels(), ["plain"]);
    loadCachedRatios();
    assert.deepEqual(getSelectablePaperchatModels(), ["plain"]);
    clearPaperchatModelCaches();
    assert.deepEqual(getSelectablePaperchatModels(), []);
  });

  it("filters translation choices without readding a disallowed default or changing other providers", function () {
    loadCachedRatios();
    const previousAddon = (globalThis as any).addon;
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
    destroyProviderManager();
    try {
      getProviderManager().getAllConfigs = () =>
        [
          {
            id: "paperchat",
            type: "paperchat",
            name: "PaperChat",
            enabled: true,
            availableModels: ["model-a", "key-only"],
            defaultModel: "key-only",
          },
          {
            id: "custom",
            type: "openai-compatible",
            name: "Custom",
            enabled: true,
            availableModels: ["custom-model"],
            defaultModel: "custom-model",
          },
        ] as any;
      prefStore.set(
        `${PREFS_PREFIX}translationModel`,
        JSON.stringify({ providerId: "paperchat", model: "key-only" }),
      );
      assert.deepEqual(
        getTranslationModelOptions().map((option) => option.value),
        [
          "auto",
          JSON.stringify({ providerId: "paperchat", model: "model-a" }),
          JSON.stringify({ providerId: "custom", model: "custom-model" }),
        ],
      );
    } finally {
      destroyProviderManager();
      (globalThis as any).addon = previousAddon;
    }
  });

  it("clears persisted and in-memory model metadata", function () {
    loadCachedRatios();
    assert.deepEqual(getModelRatios(), { "model-a": 2 });
    assert.hasAllKeys(getModelRoutingMeta(), ["model-a"]);
    assert.deepEqual(getModelRoutingDefaults(), {
      contextSummaryModel: "model-a",
    });

    clearPaperchatModelCaches();

    assert.deepEqual(getModelRatios(), {});
    assert.deepEqual(getModelRoutingMeta(), {});
    assert.equal(prefStore.get(`${PREFS_PREFIX}paperchatModelsCache`), "");
    assert.equal(prefStore.get(`${PREFS_PREFIX}paperchatRatiosCache`), "");
    assert.equal(
      prefStore.get(`${PREFS_PREFIX}paperchatRoutingConfigCache`),
      "",
    );
    assert.equal(
      prefStore.get(`${PREFS_PREFIX}paperchatRoutingDefaultsCache`),
      "",
    );
  });

  it("ignores routing metadata returned by the previous environment", async function () {
    let resolveRequest!: (response: Response) => void;
    clearPaperchatModelCaches();
    (globalThis as any).fetch = () =>
      new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      });

    const request = fetchPaperchatRoutingMeta();
    clearPaperchatModelCaches();
    resolveRequest(
      new Response(
        JSON.stringify({
          models: { "model-old": { upstreamModelId: "upstream-old" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await request;

    assert.deepEqual(getModelRoutingMeta(), {});
    assert.equal(
      prefStore.get(`${PREFS_PREFIX}paperchatRoutingConfigCache`),
      "",
    );
  });

  it("fetches and caches routing defaults with the model metadata", async function () {
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({
          defaults: {
            contextSummaryModel: "model-a",
            sessionTitleModel: "model-b",
          },
          models: {
            "model-a": { tier: "standard" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await fetchPaperchatRoutingMeta();

    assert.deepEqual(getModelRoutingDefaults(), {
      contextSummaryModel: "model-a",
      sessionTitleModel: "model-b",
    });
    assert.equal(
      prefStore.get(`${PREFS_PREFIX}paperchatRoutingDefaultsCache`),
      '{"defaults":{"contextSummaryModel":"model-a","sessionTitleModel":"model-b"}}',
    );
  });
});
