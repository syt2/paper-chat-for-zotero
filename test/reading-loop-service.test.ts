import { assert } from "chai";
import { config } from "../package.json";
import {
  destroyReadingLoopService,
  getReadingLoopService,
  ReadingLoopService,
} from "../src/modules/reading-loop/ReadingLoopService.ts";
import { applyReadingLoopEnabledPreference } from "../src/modules/preferences/PreferencesManager.ts";

const PREFS_PREFIX = config.prefsPrefix;
const FOLLOWUP_QUESTIONS = [
  "为什么这里不对？",
  "how should I read this?",
  "这个公式是什么意思？",
] as const;

function sendFollowupQuestions(
  service: ReadingLoopService,
  item: Zotero.Item,
): void {
  for (const question of FOLLOWUP_QUESTIONS) {
    service.handleChatMessageSent(question, item);
  }
}

function installPrefEnvironment() {
  const originalZotero = (globalThis as any).Zotero;
  const prefStore = new Map<string, unknown>();
  (globalThis as any).Zotero = {
    Prefs: {
      get: (key: string) => prefStore.get(key),
      set: (key: string, value: unknown) => {
        prefStore.set(key, value);
      },
    },
    Libraries: {
      userLibraryID: 1,
    },
    Items: {
      get: () => null,
      getByLibraryAndKey: () => null,
    },
  };
  return {
    prefStore,
    restore: () => {
      (globalThis as any).Zotero = originalZotero;
    },
  };
}

describe("reading loop service", function () {
  let prefEnvironment: ReturnType<typeof installPrefEnvironment>;

  beforeEach(function () {
    prefEnvironment = installPrefEnvironment();
  });

  afterEach(function () {
    prefEnvironment.restore();
  });

  it("uses the enabled preference and blocks automatic triggers while disabled", function () {
    const { prefStore } = prefEnvironment;
    const originalNow = Date.now;
    const now = 100000;
    Date.now = () => now;

    try {
      const service = new ReadingLoopService();
      service.refreshEnabledFromPrefs();
      assert.isTrue(service.getSnapshot().enabled);

      prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, false);
      service.refreshEnabledFromPrefs();
      assert.isFalse(service.getSnapshot().enabled);
      assert.equal(service.getSnapshot().state, "idle");

      (service as any).currentPaperKey = "paper-key";
      (service as any).currentItemStartedAt = now - 5 * 60 * 1000;
      (service as any).lastReaderProgressBucket.set("paper-key", 0);
      (service as any).readActiveReaderProgress = () => ({
        pageIndex: 30,
        pageCount: 100,
      });
      const item = { key: "paper-key" } as Zotero.Item;

      (service as any).handleReaderProgressSignals();
      sendFollowupQuestions(service, item);
      for (let index = 0; index < 3; index += 1) {
        service.handleAnnotationCreated({
          key: "paper-key",
          annotationType: "highlight",
        } as Zotero.Item);
      }

      assert.isUndefined(service.getSnapshot().activeSuggestion);

      prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, true);
      service.refreshEnabledFromPrefs();
      assert.isTrue(service.getSnapshot().enabled);
      sendFollowupQuestions(service, item);
      assert.equal(
        service.getSnapshot().activeSuggestion?.kind,
        "followup_questions",
      );
      service.destroy();
    } finally {
      Date.now = originalNow;
    }
  });

  it("rolls back the persisted setting when the live refresh fails", function () {
    const { prefStore } = prefEnvironment;
    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, true);
    const service = getReadingLoopService();
    const originalRefresh = service.refreshEnabledFromPrefs.bind(service);
    let refreshCount = 0;
    service.refreshEnabledFromPrefs = () => {
      refreshCount++;
      if (refreshCount === 1) {
        throw new Error("refresh failed");
      }
      originalRefresh();
    };

    try {
      assert.throws(
        () => applyReadingLoopEnabledPreference(false),
        "refresh failed",
      );
      assert.equal(refreshCount, 2);
      assert.equal(prefStore.get(`${PREFS_PREFIX}.readingLoopEnabled`), true);
      assert.isTrue(service.getSnapshot().enabled);
    } finally {
      service.refreshEnabledFromPrefs = originalRefresh;
      destroyReadingLoopService();
    }
  });

  it("hides pending suggestions when the automatic loop is disabled", function () {
    const { prefStore } = prefEnvironment;
    const service = new ReadingLoopService();
    (service as any).currentPaperKey = "paper-key";
    const item = { key: "paper-key" } as Zotero.Item;

    sendFollowupQuestions(service, item);
    assert.equal(
      service.getSnapshot().activeSuggestion?.kind,
      "followup_questions",
    );

    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, false);
    service.refreshEnabledFromPrefs();
    assert.isFalse(service.getSnapshot().enabled);
    assert.isUndefined(service.getSnapshot().activeSuggestion);
    assert.isUndefined((service as any).activeSuggestion);
    service.destroy();
  });

  it("pauses polling and skips highlight scans while disabled", function () {
    const { prefStore } = prefEnvironment;
    const service = new ReadingLoopService();
    (service as any).initialized = true;
    (service as any).startReaderStatePolling();
    assert.isNotNull((service as any).readerStatePollTimer);

    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, false);
    service.refreshEnabledFromPrefs();
    assert.isNull((service as any).readerStatePollTimer);

    let highlightScanCount = 0;
    (service as any).getHighlightStatsForPaper = () => {
      highlightScanCount++;
      return { count: 5, lastAnnotationMarker: "marker" };
    };
    service.setCurrentItem({ key: "paper-key" } as Zotero.Item);
    assert.equal(highlightScanCount, 0);
    assert.equal((service as any).currentItemStartedAt, 0);

    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, true);
    service.refreshEnabledFromPrefs();
    assert.isNotNull((service as any).readerStatePollTimer);
    assert.isAbove((service as any).currentItemStartedAt, 0);
    assert.equal(highlightScanCount, 0);

    service.setCurrentItem({ key: "paper-key" } as Zotero.Item);
    assert.equal(highlightScanCount, 1);
    assert.equal(
      service.getSnapshot().activeSuggestion?.kind,
      "highlight_digest",
    );
    service.destroy();
  });

  it("does not count disabled time toward a dwell suggestion", function () {
    const { prefStore } = prefEnvironment;
    const originalNow = Date.now;
    let now = 100000;
    Date.now = () => now;

    try {
      const service = new ReadingLoopService();
      service.setCurrentItem({ key: "paper-key" } as Zotero.Item);

      now += 3 * 60 * 1000;
      prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, false);
      service.refreshEnabledFromPrefs();

      now += 2 * 60 * 60 * 1000;
      prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, true);
      service.refreshEnabledFromPrefs();
      (service as any).readActiveReaderProgress = () => null;
      (service as any).handleReaderProgressSignals();
      assert.isUndefined(service.getSnapshot().activeSuggestion);

      now += 4 * 60 * 1000;
      (service as any).handleReaderProgressSignals();
      assert.equal(
        service.getSnapshot().activeSuggestion?.kind,
        "reading_checkpoint",
      );
      service.destroy();
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not carry question signals across a disabled interval", function () {
    const { prefStore } = prefEnvironment;
    const service = new ReadingLoopService();
    (service as any).currentPaperKey = "paper-key";
    const item = { key: "paper-key" } as Zotero.Item;

    service.handleChatMessageSent("为什么这里不对？", item);
    service.handleChatMessageSent("how should I read this?", item);

    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, false);
    service.refreshEnabledFromPrefs();
    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, true);
    service.refreshEnabledFromPrefs();

    service.handleChatMessageSent("这个公式是什么意思？", item);
    assert.isUndefined(service.getSnapshot().activeSuggestion);

    service.handleChatMessageSent("why is this assumption needed?", item);
    service.handleChatMessageSent("这里该怎么理解？", item);
    assert.equal(
      service.getSnapshot().activeSuggestion?.kind,
      "followup_questions",
    );
    service.destroy();
  });

  it("lets an accepted task finish while disabled after changing papers", async function () {
    const { prefStore } = prefEnvironment;
    const service = new ReadingLoopService();
    (service as any).currentPaperKey = "paper-key";
    const item = { key: "paper-key" } as Zotero.Item;
    let resolveExecutor: ((result: { title: string }) => void) | undefined;
    service.setExecutor(
      () =>
        new Promise((resolve) => {
          resolveExecutor = resolve;
        }),
    );
    let highlightScanCount = 0;
    (service as any).getHighlightStatsForPaper = () => {
      highlightScanCount++;
      return { count: 5, lastAnnotationMarker: "marker" };
    };

    sendFollowupQuestions(service, item);
    const suggestion = service.getSnapshot().activeSuggestion;
    assert.isDefined(suggestion);

    const acceptPromise = service.acceptSuggestion(suggestion!.id);
    assert.equal((service as any).activeSuggestion?.status, "running");

    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, false);
    service.refreshEnabledFromPrefs();
    assert.equal(service.getSnapshot().state, "idle");

    service.setCurrentItem({ key: "other-paper" } as Zotero.Item);
    assert.equal((service as any).activeSuggestion?.status, "running");
    assert.equal(highlightScanCount, 0);

    resolveExecutor?.({ title: "Done" });
    await acceptPromise;
    assert.equal((service as any).activeSuggestion?.status, "completed");

    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, true);
    service.refreshEnabledFromPrefs();
    assert.equal(service.getSnapshot().state, "completed");
    service.setCurrentItem({ key: "other-paper" } as Zotero.Item);
    assert.equal(highlightScanCount, 0);

    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, false);
    service.refreshEnabledFromPrefs();
    assert.equal((service as any).activeSuggestion?.status, "completed");
    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, true);
    service.refreshEnabledFromPrefs();
    assert.equal(service.getSnapshot().state, "completed");

    const completedSuggestion = service.getSnapshot().activeSuggestion;
    service.viewResult(completedSuggestion!.id);
    service.setCurrentItem({ key: "other-paper" } as Zotero.Item);
    assert.equal(highlightScanCount, 1);
    assert.equal(
      service.getSnapshot().activeSuggestion?.kind,
      "highlight_digest",
    );
    service.destroy();
  });

  it("keeps a running task past its original expiry when re-enabled", async function () {
    const { prefStore } = prefEnvironment;
    const originalNow = Date.now;
    let now = 100000;
    Date.now = () => now;

    try {
      const service = new ReadingLoopService();
      (service as any).currentPaperKey = "paper-key";
      const item = { key: "paper-key" } as Zotero.Item;
      let resolveExecutor: ((result: { title: string }) => void) | undefined;
      service.setExecutor(
        () =>
          new Promise((resolve) => {
            resolveExecutor = resolve;
          }),
      );

      sendFollowupQuestions(service, item);
      const suggestion = service.getSnapshot().activeSuggestion;
      assert.isDefined(suggestion);
      (service as any).activeSuggestion.expiresAt = now + 1000;

      const acceptPromise = service.acceptSuggestion(suggestion!.id);
      prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, false);
      service.refreshEnabledFromPrefs();

      now += 1001;
      prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, true);
      service.refreshEnabledFromPrefs();
      assert.equal(service.getSnapshot().state, "running");

      resolveExecutor?.({ title: "Done" });
      await acceptPromise;
      assert.equal(service.getSnapshot().state, "completed");
      service.destroy();
    } finally {
      Date.now = originalNow;
    }
  });

  it("surfaces a task failure that occurs while the loop is disabled", async function () {
    const { prefStore } = prefEnvironment;
    const service = new ReadingLoopService();
    (service as any).currentPaperKey = "paper-key";
    const item = { key: "paper-key" } as Zotero.Item;
    let rejectExecutor: ((error: Error) => void) | undefined;
    service.setExecutor(
      () =>
        new Promise((_resolve, reject) => {
          rejectExecutor = reject;
        }),
    );

    sendFollowupQuestions(service, item);
    const suggestion = service.getSnapshot().activeSuggestion;
    const acceptPromise = service.acceptSuggestion(suggestion!.id);
    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, false);
    service.refreshEnabledFromPrefs();

    rejectExecutor?.(new Error("executor failed"));
    await acceptPromise;
    assert.equal((service as any).activeSuggestion?.status, "attention");
    assert.equal(service.getSnapshot().state, "idle");

    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, true);
    service.refreshEnabledFromPrefs();
    assert.equal(service.getSnapshot().state, "attention");

    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, false);
    service.refreshEnabledFromPrefs();
    assert.equal((service as any).activeSuggestion?.status, "attention");
    prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, true);
    service.refreshEnabledFromPrefs();
    assert.equal(service.getSnapshot().state, "attention");
    service.destroy();
  });

  it("expires a hidden completion with one notification on re-enable", async function () {
    const { prefStore } = prefEnvironment;
    const originalNow = Date.now;
    let now = 100000;
    Date.now = () => now;

    try {
      const service = new ReadingLoopService();
      (service as any).currentPaperKey = "paper-key";
      const item = { key: "paper-key" } as Zotero.Item;
      let resolveExecutor: ((result: { title: string }) => void) | undefined;
      service.setExecutor(
        () =>
          new Promise((resolve) => {
            resolveExecutor = resolve;
          }),
      );

      sendFollowupQuestions(service, item);
      const suggestion = service.getSnapshot().activeSuggestion;
      const acceptPromise = service.acceptSuggestion(suggestion!.id);
      prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, false);
      service.refreshEnabledFromPrefs();

      resolveExecutor?.({ title: "Done" });
      await acceptPromise;
      const completed = (service as any).activeSuggestion;
      assert.equal(completed?.status, "completed");
      now = completed.expiresAt + 1;

      let notifications = 0;
      const unsubscribe = service.subscribe(() => {
        notifications++;
      });
      const notificationsBeforeEnable = notifications;
      prefStore.set(`${PREFS_PREFIX}.readingLoopEnabled`, true);
      service.refreshEnabledFromPrefs();

      assert.isUndefined(service.getSnapshot().activeSuggestion);
      assert.equal(notifications, notificationsBeforeEnable + 1);
      unsubscribe();
      service.destroy();
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not inspect PDF selections or create selection tasks while polling", async function () {
    const service = new ReadingLoopService();
    (service as any).currentPaperKey = "paper-key";
    (service as any).getActiveReaderItem = () =>
      ({ key: "paper-key" }) as Zotero.Item;
    (service as any).handleReaderProgressSignals = () => undefined;
    const { prefStore } = prefEnvironment;
    const runtime = globalThis as { ztoolkit?: unknown };
    const originalZtoolkit = runtime.ztoolkit;
    let selectionReadCount = 0;
    runtime.ztoolkit = {
      log: () => undefined,
      Reader: {
        getReader: async () => ({}),
        getSelectedText: () => {
          selectionReadCount++;
          return "Selected text that must not trigger PaperChat";
        },
      },
    };

    try {
      await (service as any).pollReaderState();

      assert.equal(selectionReadCount, 0);
      assert.equal(service.getSnapshot().state, "idle");
      assert.isUndefined(service.getSnapshot().activeSuggestion);
      assert.isUndefined(prefStore.get(`${PREFS_PREFIX}.readingLoopHistory`));
    } finally {
      runtime.ztoolkit = originalZtoolkit;
      service.destroy();
    }
  });

  it("advances the chat follow-up window after a suggestion attempt", function () {
    const originalNow = Date.now;
    let now = 30000;
    Date.now = () => now;

    try {
      const service = new ReadingLoopService();
      (service as any).currentPaperKey = "paper-key";
      const item = { key: "paper-key" } as Zotero.Item;

      service.handleChatMessageSent("为什么这里不对？", item);
      now += 1000;
      service.handleChatMessageSent("how should I read this?", item);
      now += 1000;
      service.handleChatMessageSent("这个公式是什么意思？", item);
      assert.equal(
        service.getSnapshot().activeSuggestion?.kind,
        "followup_questions",
      );

      (service as any).activeSuggestion = undefined;
      now += 6 * 60 * 1000;
      service.handleChatMessageSent("为什么还有这个假设？", item);
      assert.isUndefined(service.getSnapshot().activeSuggestion);

      now += 1000;
      service.handleChatMessageSent("what does this result mean?", item);
      now += 1000;
      service.handleChatMessageSent("怎么判断这个结论？", item);
      assert.equal(
        service.getSnapshot().activeSuggestion?.kind,
        "followup_questions",
      );
      service.destroy();
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not treat the first progress poll in a new reader session as progress crossing", function () {
    const service = new ReadingLoopService();
    (service as any).currentPaperKey = "paper-key";
    (service as any).lastReaderProgressBucket.set("paper-key", 3);
    (service as any).readActiveReaderProgress = () => ({
      pageIndex: 29,
      pageCount: 100,
    });

    (service as any).beginReaderSession("paper-key");
    (service as any).handleReaderProgressSignals();

    assert.isUndefined(service.getSnapshot().activeSuggestion);
    assert.equal((service as any).lastReaderProgressBucket.get("paper-key"), 1);
    service.destroy();
  });

  it("waits for a stable progress bucket before suggesting a checkpoint", function () {
    const originalNow = Date.now;
    let now = 100000;
    Date.now = () => now;

    try {
      const service = new ReadingLoopService();
      (service as any).currentPaperKey = "paper-key";
      (service as any).beginReaderSession("paper-key");
      (service as any).lastReaderProgressBucket.set("paper-key", 0);
      (service as any).readActiveReaderProgress = () => ({
        pageIndex: 30,
        pageCount: 100,
      });

      (service as any).handleReaderProgressSignals();
      assert.isUndefined(service.getSnapshot().activeSuggestion);

      now += 11999;
      (service as any).handleReaderProgressSignals();
      assert.isUndefined(service.getSnapshot().activeSuggestion);

      now += 2;
      (service as any).handleReaderProgressSignals();
      assert.equal(
        service.getSnapshot().activeSuggestion?.kind,
        "section_checkpoint",
      );
      service.destroy();
    } finally {
      Date.now = originalNow;
    }
  });

  it("resets progress bucket delay while the reader is quickly scrolled", function () {
    const originalNow = Date.now;
    let now = 200000;
    let progress = {
      pageIndex: 30,
      pageCount: 100,
    };
    Date.now = () => now;

    try {
      const service = new ReadingLoopService();
      (service as any).currentPaperKey = "paper-key";
      (service as any).beginReaderSession("paper-key");
      (service as any).lastReaderProgressBucket.set("paper-key", 0);
      (service as any).readActiveReaderProgress = () => progress;

      (service as any).handleReaderProgressSignals();
      now += 6000;
      progress = {
        pageIndex: 80,
        pageCount: 100,
      };
      (service as any).handleReaderProgressSignals();

      now += 6000;
      (service as any).handleReaderProgressSignals();
      assert.isUndefined(service.getSnapshot().activeSuggestion);

      now += 6001;
      (service as any).handleReaderProgressSignals();
      assert.equal(
        service.getSnapshot().activeSuggestion?.kind,
        "reading_checkpoint",
      );
      assert.equal(
        (service as any).lastReaderProgressBucket.get("paper-key"),
        3,
      );
      service.destroy();
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not let sustained dwell bypass an unstable progress bucket", function () {
    const originalNow = Date.now;
    let now = 500000;
    Date.now = () => now;

    try {
      const service = new ReadingLoopService();
      (service as any).currentPaperKey = "paper-key";
      (service as any).currentItemStartedAt = now - 5 * 60 * 1000;
      (service as any).lastReaderProgressBucket.set("paper-key", 0);
      (service as any).readActiveReaderProgress = () => ({
        pageIndex: 30,
        pageCount: 100,
      });

      (service as any).handleReaderProgressSignals();
      assert.isUndefined(service.getSnapshot().activeSuggestion);

      now += 12001;
      (service as any).handleReaderProgressSignals();
      assert.equal(
        service.getSnapshot().activeSuggestion?.kind,
        "section_checkpoint",
      );
      service.destroy();
    } finally {
      Date.now = originalNow;
    }
  });

  it("waits for the current page to stabilize before creating a dwell checkpoint", function () {
    const originalNow = Date.now;
    let now = 400000;
    Date.now = () => now;

    try {
      const service = new ReadingLoopService();
      (service as any).currentPaperKey = "paper-key";
      (service as any).currentItemStartedAt = now - 5 * 60 * 1000;
      (service as any).lastReaderProgressBucket.set("paper-key", 1);
      (service as any).readActiveReaderProgress = () => ({
        pageIndex: 30,
        pageCount: 100,
      });

      (service as any).handleReaderProgressSignals();
      assert.isUndefined(service.getSnapshot().activeSuggestion);

      now += 12001;
      (service as any).handleReaderProgressSignals();
      assert.equal(
        service.getSnapshot().activeSuggestion?.kind,
        "reading_checkpoint",
      );
      service.destroy();
    } finally {
      Date.now = originalNow;
    }
  });

  it("updates the persisted history record when a suggestion completes", async function () {
    const { prefStore } = prefEnvironment;
    const originalNow = Date.now;
    let now = 70000;
    Date.now = () => now;

    try {
      const service = new ReadingLoopService();
      (service as any).currentPaperKey = "paper-key";
      service.setExecutor(async () => {
        now += 500;
        return {
          title: "Done",
        };
      });

      const item = { key: "paper-key" } as Zotero.Item;
      service.handleChatMessageSent("为什么这里不对？", item);
      now += 1000;
      service.handleChatMessageSent("how should I read this?", item);
      now += 1000;
      service.handleChatMessageSent("这个公式是什么意思？", item);

      const suggestion = service.getSnapshot().activeSuggestion;
      assert.equal(suggestion?.kind, "followup_questions");
      await service.acceptSuggestion(suggestion!.id);
      assert.equal(service.getSnapshot().state, "completed");
      assert.isNumber(service.getSnapshot().activeSuggestion?.expiresAt);

      const rawHistory = prefStore.get(
        `${PREFS_PREFIX}.readingLoopHistory`,
      ) as string;
      const parsed = JSON.parse(rawHistory) as {
        records: Array<{
          status: string;
          acceptedAt?: number;
          completedAt?: number;
        }>;
      };
      assert.equal(parsed.records[0]?.status, "completed");
      assert.isNumber(parsed.records[0]?.acceptedAt);
      assert.isNumber(parsed.records[0]?.completedAt);

      now += 6001;
      (service as any).expireStaleSuggestion();
      assert.isUndefined(service.getSnapshot().activeSuggestion);
      service.destroy();
    } finally {
      Date.now = originalNow;
    }
  });
});
