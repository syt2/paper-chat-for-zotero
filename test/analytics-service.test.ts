import { assert } from "chai";
import type {
  AnalyticsHttpRequest,
  AnalyticsHttpTransport,
} from "../src/modules/analytics/AnalyticsService";

describe("AnalyticsService helpers", function () {
  it("normalizeEventProps drops non-primitive values and returns undefined for empty objects", async function () {
    const { normalizeEventProps } = await import(
      "../src/modules/analytics/AnalyticsService.ts"
    );

    assert.isUndefined(normalizeEventProps());
    assert.isUndefined(normalizeEventProps({}));
    assert.isUndefined(
      normalizeEventProps({ a: null, b: undefined, c: { nested: 1 } as unknown as string }),
    );
    assert.deepEqual(normalizeEventProps({ a: "x", b: 1, c: false }), {
      a: "x",
      b: 1,
      c: false,
    });
    assert.deepEqual(
      normalizeEventProps({ a: "x", b: null, c: undefined, d: 2 }),
      { a: "x", d: 2 },
    );
  });

  it("createSessionId composes seconds and injected random suffix", async function () {
    const { createSessionId } = await import(
      "../src/modules/analytics/AnalyticsService.ts"
    );

    const id = createSessionId(
      () => 1_700_000_000_000,
      () => "12345678",
    );
    assert.equal(id, "170000000012345678");
  });
});

describe("AnalyticsService.track", function () {
  async function loadService() {
    return import("../src/modules/analytics/AnalyticsService.ts");
  }

  it("posts an Aptabase-shaped payload to the configured endpoint", async function () {
    const { AnalyticsService } = await loadService();

    const httpCalls: AnalyticsHttpRequest[] = [];
    const service = new AnalyticsService({
      appKey: "A-SH-TESTKEY",
      endpoint: "https://example.test/api/v0/event",
      appVersion: "9.9.9",
      isDebug: true,
      sdkVersion: "paper-chat-analytics/1",
      http: async (request) => {
        httpCalls.push(request);
        return { status: 200, responseText: "" };
      },
      getLocale: () => "en-US",
      now: () => 1_700_000_000_000,
      randomSessionIdSuffix: () => "00000001",
    });

    service.track("chat_sent", { provider: "paperchat", count: 3, omit: null });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.lengthOf(httpCalls, 1);
    const request = httpCalls[0];
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://example.test/api/v0/event");
    assert.equal(request.headers["Content-Type"], "application/json");
    assert.equal(request.headers["App-Key"], "A-SH-TESTKEY");

    const body = JSON.parse(request.body);
    assert.equal(body.eventName, "chat_sent");
    assert.equal(body.sessionId, "170000000000000001");
    assert.equal(body.timestamp, new Date(1_700_000_000_000).toISOString());
    assert.deepEqual(body.systemProps, {
      locale: "en-US",
      isDebug: true,
      appVersion: "9.9.9",
      sdkVersion: "paper-chat-analytics/1",
    });
    assert.deepEqual(body.props, { provider: "paperchat", count: 3 });
  });

  it("rotates the session id once activity exceeds the timeout", async function () {
    const { AnalyticsService } = await loadService();

    let currentTime = 1_700_000_000_000;
    let suffixCounter = 0;
    const httpCalls: string[] = [];

    const service = new AnalyticsService({
      appKey: "A-SH-TESTKEY",
      endpoint: "https://example.test/api/v0/event",
      appVersion: "1.0.0",
      isDebug: false,
      http: async (request) => {
        httpCalls.push(request.body);
        return { status: 200, responseText: "" };
      },
      getLocale: () => "en-US",
      now: () => currentTime,
      randomSessionIdSuffix: () => {
        suffixCounter += 1;
        return String(suffixCounter).padStart(8, "0");
      },
      sessionTimeoutMs: 1000,
    });

    service.track("event_a");
    currentTime += 500;
    service.track("event_b");
    currentTime += 2000;
    service.track("event_c");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.lengthOf(httpCalls, 3);
    const sessionIds = httpCalls.map((body) => JSON.parse(body).sessionId);
    assert.equal(sessionIds[0], sessionIds[1], "within timeout should reuse session id");
    assert.notEqual(
      sessionIds[1],
      sessionIds[2],
      "after exceeding timeout session id should rotate",
    );
  });

  it("swallows synchronous throws from the transport", async function () {
    const { AnalyticsService } = await loadService();

    const loggerMessages: Array<{ message: string; context?: unknown }> = [];
    const service = new AnalyticsService({
      appKey: "A-SH-TESTKEY",
      endpoint: "https://example.test/api/v0/event",
      appVersion: "1.0.0",
      isDebug: false,
      http: (() => {
        throw new Error("sync transport failure");
      }) as unknown as AnalyticsHttpTransport,
      logger: {
        log: (message, context) => loggerMessages.push({ message, context }),
      },
      getLocale: () => "en-US",
    });

    assert.doesNotThrow(() => service.track("event_sync_throw"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.lengthOf(loggerMessages, 1);
    assert.equal(loggerMessages[0].message, "[Analytics] event send failed");
  });

  it("swallows HTTP failures and logs them through the injected logger", async function () {
    const { AnalyticsService } = await loadService();

    const loggerMessages: Array<{ message: string; context?: unknown }> = [];
    const service = new AnalyticsService({
      appKey: "A-SH-TESTKEY",
      endpoint: "https://example.test/api/v0/event",
      appVersion: "1.0.0",
      isDebug: false,
      http: async () => ({ status: 500, responseText: "boom" }),
      logger: {
        log: (message, context) => loggerMessages.push({ message, context }),
      },
      getLocale: () => "en-US",
    });

    service.track("event_fail");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.lengthOf(loggerMessages, 1);
    assert.equal(loggerMessages[0].message, "[Analytics] event send failed");
    assert.deepInclude(loggerMessages[0].context, {
      eventName: "event_fail",
      status: 500,
      response: "boom",
    });
  });
});
