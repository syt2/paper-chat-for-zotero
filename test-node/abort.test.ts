import { strict as assert } from "node:assert";
import {
  isAbortError,
  isAbortRequested,
  raceWithAbort,
  throwIfAborted,
} from "../src/utils/abort.ts";

describe("abort helpers", function () {
  it("does not start a pre-cancelled operation", async function () {
    const controller = new AbortController();
    controller.abort();
    let started = false;

    await assert.rejects(
      raceWithAbort(() => {
        started = true;
        return Promise.resolve("unexpected");
      }, controller.signal),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(started, false);
  });

  it("observes a late rejection after cancellation", async function () {
    const controller = new AbortController();
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
    let unhandled = false;
    const onUnhandled = (reason: unknown) => {
      if (
        !(reason instanceof Error) ||
        reason.message !== "late renderer failure"
      ) {
        return;
      }
      unhandled = true;
    };
    process.once("unhandledRejection", onUnhandled);
    try {
      const execution = raceWithAbort(() => operation, controller.signal);
      controller.abort();
      await assert.rejects(execution, (error: unknown) => {
        return error instanceof Error && error.name === "AbortError";
      });
      rejectOperation(new Error("late renderer failure"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(unhandled, false);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("normalizes custom abort reasons to AbortError", async function () {
    const controller = new AbortController();
    controller.abort(new Error("provider-specific cancellation"));

    let thrown: unknown;
    try {
      await raceWithAbort(() => Promise.resolve("never"), controller.signal);
    } catch (error) {
      thrown = error;
    }

    assert.equal((thrown as { name?: string } | undefined)?.name, "AbortError");
    assert.equal(isAbortError(thrown), true);
  });

  it("keeps observing an operation when a wrapped signal cannot install listeners", async function () {
    const signal = {
      aborted: false,
      addEventListener: () => {
        throw new Error("cross-compartment listener unavailable");
      },
      removeEventListener: () => {
        throw new Error("cross-compartment listener unavailable");
      },
    } as unknown as AbortSignal;
    const result = await raceWithAbort(
      () => Promise.resolve("observed"),
      signal,
    );
    assert.equal(result, "observed");
  });

  it("uses the abort event when a wrapped signal hides its aborted getter", async function () {
    let onAbort: (() => void) | undefined;
    const signal = {
      get aborted(): boolean {
        throw new Error("cross-compartment getter unavailable");
      },
      addEventListener: (_type: string, listener: () => void) => {
        onAbort = listener;
      },
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;

    const execution = raceWithAbort(
      () => new Promise<string>(() => undefined),
      signal,
    );
    onAbort?.();
    await assert.rejects(
      execution,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(isAbortRequested(signal), true);
    assert.throws(
      () => throwIfAborted(signal),
      (error: unknown) => {
        return error instanceof Error && error.name === "AbortError";
      },
    );
  });

  it("removes an installed abort listener when the operation settles", async function () {
    const controller = new AbortController();
    let removeCalls = 0;
    const signal = {
      aborted: false,
      addEventListener: controller.signal.addEventListener.bind(
        controller.signal,
      ),
      removeEventListener: () => {
        removeCalls += 1;
        controller.signal.removeEventListener("abort", () => undefined);
      },
    } as unknown as AbortSignal;

    await raceWithAbort(() => Promise.resolve("settled"), signal);
    assert.equal(removeCalls, 1);
  });

  it("does not start a cross-realm operation when the signal becomes aborted during listener setup", async function () {
    let started = false;
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads > 1;
      },
      addEventListener: () => {
        throw new Error("cross-compartment listener unavailable");
      },
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;

    await assert.rejects(
      raceWithAbort(() => {
        started = true;
        return Promise.resolve("unexpected");
      }, signal),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(started, false);
  });
});
