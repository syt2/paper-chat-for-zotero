import { assert } from "chai";
import { PresentationLaunchCoordinator } from "../src/modules/presentation/PresentationLaunchCoordinator.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("presentation launch coordinator", function () {
  it("coalesces repeated clicks for the same paper", async function () {
    const coordinator = new PresentationLaunchCoordinator();
    const gate = deferred<boolean>();
    let starts = 0;
    const task = () => {
      starts += 1;
      return gate.promise;
    };

    const first = coordinator.enqueue("1:PAPER-A", task);
    const second = coordinator.enqueue("1:PAPER-A", task);
    await Promise.resolve();

    assert.strictEqual(second, first);
    assert.equal(starts, 1);
    gate.resolve(true);
    assert.isTrue(await first);
  });

  it("queues different papers and starts each balance gate in order", async function () {
    const coordinator = new PresentationLaunchCoordinator();
    const firstGate = deferred<boolean>();
    const order: string[] = [];

    const first = coordinator.enqueue("1:PAPER-A", async () => {
      order.push("A:start");
      const result = await firstGate.promise;
      order.push("A:end");
      return result;
    });
    const second = coordinator.enqueue("1:PAPER-B", async () => {
      order.push("B:start");
      return true;
    });
    await Promise.resolve();
    assert.deepEqual(order, ["A:start"]);

    firstGate.resolve(true);
    assert.isTrue(await first);
    assert.isTrue(await second);
    assert.deepEqual(order, ["A:start", "A:end", "B:start"]);
  });

  it("continues with the next paper after an earlier launch rejects", async function () {
    const coordinator = new PresentationLaunchCoordinator();
    const order: string[] = [];

    const first = coordinator.enqueue("1:PAPER-A", async () => {
      order.push("A");
      throw new Error("launch failed");
    });
    const second = coordinator.enqueue("1:PAPER-B", async () => {
      order.push("B");
      return true;
    });

    let rejection: unknown;
    try {
      await first;
    } catch (error) {
      rejection = error;
    }
    assert.instanceOf(rejection, Error);
    assert.equal((rejection as Error).message, "launch failed");
    assert.isTrue(await second);
    assert.deepEqual(order, ["A", "B"]);
  });
});
