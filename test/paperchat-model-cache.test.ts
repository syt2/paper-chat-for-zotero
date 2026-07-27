import { assert } from "chai";
import {
  clearPaperchatModelCaches,
  fetchPaperchatRoutingMeta,
  getModelRatios,
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

    clearPaperchatModelCaches();

    assert.deepEqual(getModelRatios(), {});
    assert.deepEqual(getModelRoutingMeta(), {});
    assert.equal(prefStore.get(`${PREFS_PREFIX}paperchatModelsCache`), "");
    assert.equal(prefStore.get(`${PREFS_PREFIX}paperchatRatiosCache`), "");
    assert.equal(
      prefStore.get(`${PREFS_PREFIX}paperchatRoutingConfigCache`),
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
});
