import { assert } from "chai";
import {
  DEFAULT_AISUMMARY_CONFIG,
  isAISummaryAutoGenerationEnabled,
} from "../src/types/ai-summary.ts";

type AISummaryServiceModule =
  typeof import("../src/modules/ai-summary/AISummaryService.ts");
type AISummaryManagerModule =
  typeof import("../src/modules/ai-summary/AISummaryManager.ts");

function createLibraryItem(key: string): Zotero.Item {
  return {
    key,
    libraryID: 1,
    isNote: () => false,
    isPDFAttachment: () => false,
    isAttachment: () => false,
    getField: () => `Paper ${key}`,
  } as unknown as Zotero.Item;
}

describe("AI summary automatic trigger", function () {
  let serviceModule: AISummaryServiceModule;
  let managerModule: AISummaryManagerModule;
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let hadZotero: boolean;
  let hadZtoolkit: boolean;

  before(async function () {
    // Load auth first to match the application's module order and avoid the
    // existing ProviderManager/AuthService CommonJS cycle in isolated tests.
    await import("../src/modules/auth/index.ts");
    serviceModule =
      await import("../src/modules/ai-summary/AISummaryService.ts");
    managerModule =
      await import("../src/modules/ai-summary/AISummaryManager.ts");
  });

  beforeEach(function () {
    hadZotero = Object.prototype.hasOwnProperty.call(globalThis, "Zotero");
    hadZtoolkit = Object.prototype.hasOwnProperty.call(globalThis, "ztoolkit");
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    (globalThis as any).ztoolkit = { log: () => undefined };
  });

  afterEach(function () {
    serviceModule.destroyAISummaryService();
    if (hadZotero) (globalThis as any).Zotero = originalZotero;
    else delete (globalThis as any).Zotero;
    if (hadZtoolkit) (globalThis as any).ztoolkit = originalZtoolkit;
    else delete (globalThis as any).ztoolkit;
  });

  it("defaults automatic generation for newly added papers to off", function () {
    assert.isFalse(DEFAULT_AISUMMARY_CONFIG.autoGenerateOnItemAdd);
  });

  it("only enables the automatic trigger after an explicit opt-in", function () {
    assert.isFalse(isAISummaryAutoGenerationEnabled({}));
    assert.isFalse(
      isAISummaryAutoGenerationEnabled({ autoGenerateOnItemAdd: false }),
    );
    assert.isTrue(
      isAISummaryAutoGenerationEnabled({ autoGenerateOnItemAdd: true }),
    );
  });

  it("serializes config writes so the last update wins", async function () {
    const manager = new managerModule.AISummaryManager() as any;
    const writes: boolean[] = [];
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    manager.storage.saveConfig = async (config: {
      autoGenerateOnItemAdd: boolean;
    }) => {
      writes.push(config.autoGenerateOnItemAdd);
      if (writes.length === 1) await firstWrite;
    };

    const enable = manager.updateConfig({ autoGenerateOnItemAdd: true });
    assert.isTrue(manager.getConfig().autoGenerateOnItemAdd);
    const disable = manager.updateConfig({ autoGenerateOnItemAdd: false });
    assert.isFalse(manager.getConfig().autoGenerateOnItemAdd);
    await Promise.resolve();

    assert.deepEqual(writes, [true]);
    releaseFirstWrite();
    await Promise.all([enable, disable]);

    assert.deepEqual(writes, [true, false]);
    assert.isFalse(manager.getConfig().autoGenerateOnItemAdd);
  });

  it("keeps a newer config update when an earlier write fails", async function () {
    const manager = new managerModule.AISummaryManager() as any;
    const writes: boolean[] = [];
    manager.storage.saveConfig = async (config: {
      autoGenerateOnItemAdd: boolean;
    }) => {
      writes.push(config.autoGenerateOnItemAdd);
      if (writes.length === 1) throw new Error("first write failed");
    };

    const enable = manager.updateConfig({ autoGenerateOnItemAdd: true });
    const disable = manager.updateConfig({ autoGenerateOnItemAdd: false });
    const results = await Promise.allSettled([enable, disable]);

    assert.equal(results[0].status, "rejected");
    assert.equal(results[1].status, "fulfilled");
    assert.deepEqual(writes, [true, false]);
    assert.isFalse(manager.getConfig().autoGenerateOnItemAdd);
  });

  it("keeps the previous config when persistence fails", async function () {
    const manager = new managerModule.AISummaryManager() as any;
    manager.storage.saveConfig = async () => {
      throw new Error("write failed");
    };

    let error: unknown;
    try {
      await manager.updateConfig({ autoGenerateOnItemAdd: true });
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, Error);
    assert.isFalse(manager.getConfig().autoGenerateOnItemAdd);
  });

  it("rolls the latest failed update back to the last saved config", async function () {
    const manager = new managerModule.AISummaryManager() as any;
    let shouldFail = false;
    manager.storage.saveConfig = async () => {
      if (shouldFail) throw new Error("write failed");
    };

    await manager.updateConfig({ autoGenerateOnItemAdd: true });
    shouldFail = true;

    let error: unknown;
    try {
      await manager.updateConfig({ autoGenerateOnItemAdd: false });
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, Error);
    assert.isTrue(manager.getConfig().autoGenerateOnItemAdd);
  });

  it("only schedules notifier-added papers after automatic generation is enabled", async function () {
    const service = serviceModule.getAISummaryService() as any;
    const item = createLibraryItem("OFF");
    let scheduled = 0;
    let observer:
      | {
          notify: (event: string, type: string, ids: number[]) => Promise<void>;
        }
      | undefined;

    (globalThis as any).Zotero = {
      Notifier: {
        registerObserver: (candidate: typeof observer) => {
          observer = candidate;
          return "ai-summary-observer";
        },
      },
      Items: { get: () => item },
    };
    service.isAutomaticGenerationEnabled = () => false;
    service.scheduleItemProcessing = () => {
      scheduled += 1;
    };
    service.registerItemNotifier();

    await observer!.notify("add", "item", [1]);
    assert.equal(scheduled, 0);

    service.isAutomaticGenerationEnabled = () => true;
    await observer!.notify("add", "item", [1]);
    assert.equal(scheduled, 1);
  });

  it("rechecks the switch after the delay and clears the pending timer", function () {
    const service = serviceModule.getAISummaryService() as any;
    const item = createLibraryItem("DELAYED");
    let enabled = true;
    let queued = 0;
    let scheduledCallback: (() => void) | undefined;
    let scheduledDelay: number | undefined;
    const lookups: Array<[number, string]> = [];
    const originalSetTimeout = globalThis.setTimeout;

    (globalThis as any).Zotero = {
      Items: {
        getByLibraryAndKey: (libraryID: number, itemKey: string) => {
          lookups.push([libraryID, itemKey]);
          return item;
        },
      },
    };
    service.isAutomaticGenerationEnabled = () => enabled;
    service.addToQueue = () => {
      queued += 1;
      return true;
    };
    (globalThis as any).setTimeout = (callback: () => void, delay?: number) => {
      scheduledCallback = callback;
      scheduledDelay = delay;
      return 1;
    };

    try {
      service.scheduleItemProcessing(item);
      assert.equal(scheduledDelay, 30000);
      assert.equal(service.pendingTimers.size, 1);

      enabled = false;
      scheduledCallback!();

      assert.equal(queued, 0);
      assert.equal(service.pendingTimers.size, 0);
      assert.deepEqual(lookups, []);

      enabled = true;
      service.scheduleItemProcessing(item);
      scheduledCallback!();

      assert.equal(queued, 1);
      assert.equal(service.pendingTimers.size, 0);
      assert.deepEqual(lookups, [[1, "DELAYED"]]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("keeps manual quick and deep queue actions available while automatic generation is off", function () {
    const service = serviceModule.getAISummaryService() as any;
    const item = {
      ...createLibraryItem("MANUAL"),
      getAttachments: () => [2],
      getTags: () => [],
    } as unknown as Zotero.Item;

    (globalThis as any).Zotero = {
      Items: {
        get: () => ({ isPDFAttachment: () => true }),
      },
    };
    service.isAutomaticGenerationEnabled = () => false;
    service.processQueue = () => undefined;

    assert.isTrue(service.addItemToQueue(item));
    assert.isTrue(service.addDeepItemToQueue(item));
    assert.deepEqual(
      service.getTaskQueue().map((task: { mode?: string }) => task.mode),
      ["quick", "deep"],
    );
  });
});
