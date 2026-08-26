import { assert } from "chai";
import {
  clearPaperchatModelCaches,
  fetchPaperchatRoutingMeta,
  getModelRatios,
  getModelRoutingDefaults,
  getModelRoutingMeta,
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
  });

  afterEach(function () {
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
    (globalThis as any).fetch = originalFetch;
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
