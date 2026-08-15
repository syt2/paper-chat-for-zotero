import { assert } from "chai";
import { AnalyticsService } from "../src/modules/analytics/AnalyticsService.ts";

describe("AnalyticsService fail-open behavior", function () {
  it("does not throw when event metadata cannot be read", async function () {
    const logs: Array<{ message: string; context?: unknown }> = [];
    const service = new AnalyticsService({
      appKey: "A-SH-TESTKEY",
      endpoint: "https://example.test/api/v0/events",
      appVersion: "9.9.9",
      isDebug: true,
      flushIntervalMs: 0,
      http: async () => ({ status: 200, responseText: "" }),
      getUserId: () => {
        throw new Error("preferences unavailable");
      },
      logger: {
        log: (message, context) => logs.push({ message, context }),
      },
    });

    assert.doesNotThrow(() => service.track("purchase_clicked"));
    await service.flush();
    assert.equal(logs[0]?.message, "[Analytics] failed to enqueue event");
  });

  it("requeues a failed background batch even when logging throws", async function () {
    let attempts = 0;
    const service = new AnalyticsService({
      appKey: "A-SH-TESTKEY",
      endpoint: "https://example.test/api/v0/events",
      appVersion: "9.9.9",
      isDebug: true,
      flushIntervalMs: 0,
      maxBatchSize: 1,
      http: async () => {
        attempts += 1;
        return {
          status: attempts === 1 ? 500 : 200,
          responseText: "",
        };
      },
      logger: {
        log: () => {
          throw new Error("logger unavailable");
        },
      },
    });

    assert.doesNotThrow(() => service.track("purchase_clicked"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.flush();

    assert.equal(attempts, 2);
  });
});
