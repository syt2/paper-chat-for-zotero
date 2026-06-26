import { assert } from "chai";
import { config } from "../package.json";
import { ReadingLoopService } from "../src/modules/reading-loop/ReadingLoopService.ts";

const PREFS_PREFIX = config.prefsPrefix;

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

  it("waits for a stable selection before creating a simplified suggestion", function () {
    const service = new ReadingLoopService();
    (service as any).currentPaperKey = "paper-key";

    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      const selectedText =
        "The dataset improves performance in experiments with a stronger baseline.";

      service.handleTextSelected(selectedText);
      assert.equal(service.getSnapshot().state, "idle");
      assert.isUndefined(service.getSnapshot().activeSuggestion);

      now += 1000;
      service.handleTextSelected(selectedText);
      assert.equal(service.getSnapshot().state, "idle");

      now += 1001;
      service.handleTextSelected(selectedText);
      const suggestion = service.getSnapshot().activeSuggestion;
      assert.equal(suggestion?.kind, "explain_selection");
      assert.equal(suggestion?.payload?.selectedText, selectedText);
    } finally {
      Date.now = originalNow;
      service.destroy();
    }
  });

  it("resets the selection delay when selected text changes or clears", function () {
    const service = new ReadingLoopService();
    (service as any).currentPaperKey = "paper-key";

    const originalNow = Date.now;
    let now = 5000;
    Date.now = () => now;
    try {
      service.handleTextSelected("first selected passage");

      now += 1500;
      service.handleTextSelected("second selected passage");
      assert.equal(service.getSnapshot().state, "idle");

      now += 600;
      service.handleSelectionCleared();
      service.handleTextSelected("second selected passage");
      assert.equal(service.getSnapshot().state, "idle");

      now += 2100;
      service.handleTextSelected("second selected passage");
      assert.equal(
        service.getSnapshot().activeSuggestion?.kind,
        "explain_selection",
      );
    } finally {
      Date.now = originalNow;
      service.destroy();
    }
  });

  it("persists suggestion history and suppresses the same selection reason", function () {
    const { prefStore } = prefEnvironment;
    const originalNow = Date.now;
    let now = 10000;
    Date.now = () => now;

    try {
      const selectedText = "This selected passage should only prompt once.";
      const firstService = new ReadingLoopService();
      (firstService as any).currentPaperKey = "paper-key";

      firstService.handleTextSelected(selectedText);
      now += 2100;
      firstService.handleTextSelected(selectedText);

      const firstSuggestion = firstService.getSnapshot().activeSuggestion;
      assert.equal(firstSuggestion?.kind, "explain_selection");
      assert.isString(
        prefStore.get(`${PREFS_PREFIX}.readingLoopHistory`) as string,
      );

      firstService.destroy();
      now += 10 * 60 * 1000;

      const secondService = new ReadingLoopService();
      (secondService as any).currentPaperKey = "paper-key";
      secondService.handleTextSelected(selectedText);
      now += 2100;
      secondService.handleTextSelected(selectedText);

      assert.isUndefined(secondService.getSnapshot().activeSuggestion);

      secondService.handleTextSelected("A different selected passage is new.");
      now += 2100;
      secondService.handleTextSelected("A different selected passage is new.");
      assert.equal(
        secondService.getSnapshot().activeSuggestion?.kind,
        "explain_selection",
      );
      secondService.destroy();
    } finally {
      Date.now = originalNow;
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

      const selectedText = "This completion status should be persisted.";
      service.handleTextSelected(selectedText);
      now += 2100;
      service.handleTextSelected(selectedText);

      const suggestion = service.getSnapshot().activeSuggestion;
      assert.equal(suggestion?.kind, "explain_selection");
      await service.acceptSuggestion(suggestion!.id);

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
      service.destroy();
    } finally {
      Date.now = originalNow;
    }
  });
});
