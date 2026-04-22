import { assert } from "chai";
import type {
  AnalyticsHttpRequest,
  AnalyticsHttpResponse,
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

describe("AnalyticsService batching", function () {
  async function loadService() {
    return import("../src/modules/analytics/AnalyticsService.ts");
  }

  const commonOptions = {
    appKey: "A-SH-TESTKEY",
    endpoint: "https://example.test/api/v0/events",
    appVersion: "9.9.9",
    isDebug: true,
    sdkVersion: "paper-chat-analytics/1",
    getLocale: () => "en-US",
    getOsName: () => "Windows",
    getZoteroVersion: () => "7.0.15",
    getSystemVersion: () => "11",
    flushIntervalMs: 0,
  };

  it("queues events and posts an Aptabase-shaped batch on flush()", async function () {
    const { AnalyticsService } = await loadService();

    const httpCalls: AnalyticsHttpRequest[] = [];
    const service = new AnalyticsService({
      ...commonOptions,
      http: async (request) => {
        httpCalls.push(request);
        return { status: 200, responseText: "" };
      },
      now: () => 1_700_000_000_000,
      randomSessionIdSuffix: () => "00000001",
    });

    service.track("chat_sent", { provider: "paperchat", count: 3, omit: null });
    service.track("chat_completed");
    assert.lengthOf(httpCalls, 0, "track should not post synchronously");

    await service.flush();

    assert.lengthOf(httpCalls, 1);
    const request = httpCalls[0];
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://example.test/api/v0/events");
    assert.equal(request.headers["Content-Type"], "application/json");
    assert.equal(request.headers["App-Key"], "A-SH-TESTKEY");

    const body = JSON.parse(request.body);
    assert.isArray(body);
    assert.lengthOf(body, 2);
    assert.equal(body[0].eventName, "chat_sent");
    assert.equal(body[0].sessionId, "170000000000000001");
    assert.equal(body[0].timestamp, new Date(1_700_000_000_000).toISOString());
    assert.deepEqual(body[0].systemProps, {
      locale: "en-US",
      osName: "Windows",
      osVersion: "7.0.15",
      deviceModel: "11",
      isDebug: true,
      appVersion: "9.9.9",
      sdkVersion: "paper-chat-analytics/1",
    });
    assert.deepEqual(body[0].props, { provider: "paperchat", count: 3 });
    assert.equal(body[1].eventName, "chat_completed");
  });

  it("auto-flushes once the queue reaches maxBatchSize", async function () {
    const { AnalyticsService } = await loadService();

    const httpCalls: AnalyticsHttpRequest[] = [];
    const service = new AnalyticsService({
      ...commonOptions,
      maxBatchSize: 3,
      http: async (request) => {
        httpCalls.push(request);
        return { status: 200, responseText: "" };
      },
    });

    service.track("e1");
    service.track("e2");
    assert.lengthOf(httpCalls, 0);
    service.track("e3");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.lengthOf(httpCalls, 1);
    const body = JSON.parse(httpCalls[0].body);
    assert.lengthOf(body, 3);
  });

  it("splits a large queue across multiple batches during flush()", async function () {
    const { AnalyticsService } = await loadService();

    const httpCalls: AnalyticsHttpRequest[] = [];
    const service = new AnalyticsService({
      ...commonOptions,
      maxBatchSize: 2,
      http: async (request) => {
        httpCalls.push(request);
        return { status: 200, responseText: "" };
      },
    });

    service.track("e1");
    service.track("e2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.track("e3");
    service.track("e4");
    service.track("e5");
    await service.flush();

    const posted = httpCalls.flatMap((call) => JSON.parse(call.body));
    assert.lengthOf(posted, 5);
    assert.deepEqual(
      posted.map((e: { eventName: string }) => e.eventName),
      ["e1", "e2", "e3", "e4", "e5"],
    );
  });

  it("drops the oldest event when the queue exceeds maxQueueSize", async function () {
    const { AnalyticsService } = await loadService();

    const httpCalls: AnalyticsHttpRequest[] = [];
    const loggerMessages: Array<{ message: string; context?: unknown }> = [];
    const service = new AnalyticsService({
      ...commonOptions,
      maxQueueSize: 2,
      maxBatchSize: 10,
      http: async (request) => {
        httpCalls.push(request);
        return { status: 200, responseText: "" };
      },
      logger: {
        log: (message, context) => loggerMessages.push({ message, context }),
      },
    });

    service.track("e1");
    service.track("e2");
    service.track("e3");
    await service.flush();

    assert.lengthOf(httpCalls, 1);
    const body = JSON.parse(httpCalls[0].body);
    assert.deepEqual(
      body.map((e: { eventName: string }) => e.eventName),
      ["e2", "e3"],
    );
    assert.isTrue(
      loggerMessages.some((m) => m.message.includes("queue overflow")),
    );
  });

  it("drops a batch on 4xx responses (other than 429)", async function () {
    const { AnalyticsService } = await loadService();

    let callCount = 0;
    const loggerMessages: Array<{ message: string; context?: unknown }> = [];
    const service = new AnalyticsService({
      ...commonOptions,
      http: async (): Promise<AnalyticsHttpResponse> => {
        callCount += 1;
        return { status: 400, responseText: "bad request" };
      },
      logger: {
        log: (message, context) => loggerMessages.push({ message, context }),
      },
    });

    service.track("e1");
    await service.flush();
    assert.equal(callCount, 1);
    assert.isTrue(
      loggerMessages.some((m) => m.message.includes("batch rejected")),
    );

    service.track("e2");
    await service.flush();
    assert.equal(callCount, 2, "second batch should still be attempted");
  });

  it("requeues on 5xx and drops after max consecutive failures", async function () {
    const { AnalyticsService } = await loadService();

    const httpCalls: string[] = [];
    const loggerMessages: Array<{ message: string; context?: unknown }> = [];
    const service = new AnalyticsService({
      ...commonOptions,
      maxConsecutiveFailures: 2,
      http: async (request) => {
        httpCalls.push(request.body);
        return { status: 500, responseText: "boom" };
      },
      logger: {
        log: (message, context) => loggerMessages.push({ message, context }),
      },
    });

    service.track("e1");
    await service.flush();
    assert.equal(httpCalls.length, 1, "flush stops after first failure");
    await service.flush();
    await service.flush();
    await service.flush();

    assert.isTrue(
      loggerMessages.some((m) =>
        m.message.includes("dropping batch after max consecutive failures"),
      ),
    );
  });

  it("requeues on transport throw and swallows the error", async function () {
    const { AnalyticsService } = await loadService();

    let throws = 2;
    const httpCalls: string[] = [];
    const service = new AnalyticsService({
      ...commonOptions,
      maxConsecutiveFailures: 5,
      http: (async (request: AnalyticsHttpRequest) => {
        if (throws > 0) {
          throws -= 1;
          throw new Error("network down");
        }
        httpCalls.push(request.body);
        return { status: 200, responseText: "" };
      }) as AnalyticsHttpTransport,
    });

    service.track("e1");
    await service.flush();
    await service.flush();
    await service.flush();

    assert.lengthOf(httpCalls, 1);
    const body = JSON.parse(httpCalls[0]);
    assert.equal(body[0].eventName, "e1");
  });

  it("rotates the session id once activity exceeds the timeout", async function () {
    const { AnalyticsService } = await loadService();

    let currentTime = 1_700_000_000_000;
    let suffixCounter = 0;

    const service = new AnalyticsService({
      ...commonOptions,
      http: async () => ({ status: 200, responseText: "" }),
      now: () => currentTime,
      randomSessionIdSuffix: () => {
        suffixCounter += 1;
        return String(suffixCounter).padStart(8, "0");
      },
      sessionTimeoutMs: 1000,
      maxBatchSize: 100,
    });

    service.track("event_a");
    currentTime += 500;
    service.track("event_b");
    currentTime += 2000;
    service.track("event_c");

    const httpCalls: AnalyticsHttpRequest[] = [];
    (service as unknown as { http: AnalyticsHttpTransport }).http = async (
      request,
    ) => {
      httpCalls.push(request);
      return { status: 200, responseText: "" };
    };
    await service.flush();

    assert.lengthOf(httpCalls, 1);
    const body = JSON.parse(httpCalls[0].body);
    const sessionIds = body.map((e: { sessionId: string }) => e.sessionId);
    assert.equal(sessionIds[0], sessionIds[1], "within timeout reuses session");
    assert.notEqual(
      sessionIds[1],
      sessionIds[2],
      "after timeout rotates session",
    );
  });

  it("destroy() flushes queued events via http", async function () {
    const { AnalyticsService } = await loadService();

    const httpCalls: AnalyticsHttpRequest[] = [];
    const service = new AnalyticsService({
      ...commonOptions,
      http: async (request) => {
        httpCalls.push(request);
        return { status: 200, responseText: "" };
      },
    });

    service.track("e1");
    service.track("e2");
    await service.destroy();

    assert.lengthOf(httpCalls, 1);
    const body = JSON.parse(httpCalls[0].body);
    assert.lengthOf(body, 2);
  });

  it("destroy() waits for the in-flight batch and flushes remaining queued events", async function () {
    const { AnalyticsService } = await loadService();

    const httpCalls: AnalyticsHttpRequest[] = [];
    let resolveFirstRequest: (() => void) | null = null;
    const service = new AnalyticsService({
      ...commonOptions,
      maxBatchSize: 1,
      http: async (request) => {
        httpCalls.push(request);
        if (httpCalls.length === 1) {
          await new Promise<void>((resolve) => {
            resolveFirstRequest = resolve;
          });
        }
        return { status: 200, responseText: "" };
      },
    });

    service.track("e1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.track("e2");
    const destroyPromise = service.destroy();
    resolveFirstRequest?.();
    await destroyPromise;

    assert.lengthOf(httpCalls, 2);
    assert.equal(JSON.parse(httpCalls[0].body)[0].eventName, "e1");
    assert.equal(JSON.parse(httpCalls[1].body)[0].eventName, "e2");
  });

  it("destroy() is idempotent and drops subsequent track() calls", async function () {
    const { AnalyticsService } = await loadService();

    const httpCalls: AnalyticsHttpRequest[] = [];
    const service = new AnalyticsService({
      ...commonOptions,
      http: async (request) => {
        httpCalls.push(request);
        return { status: 200, responseText: "" };
      },
    });

    await service.destroy();
    await service.destroy();
    service.track("after_destroy");
    await service.flush();

    assert.lengthOf(httpCalls, 0);
  });
});
