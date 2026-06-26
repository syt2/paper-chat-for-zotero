import { assert } from "chai";
import { ReadingLoopService } from "../src/modules/reading-loop/ReadingLoopService.ts";

describe("reading loop service", function () {
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
});
