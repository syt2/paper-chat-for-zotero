import { assert } from "chai";
import { PresentationLaunchCoordinator } from "../src/modules/presentation/PresentationLaunchCoordinator.ts";
import { createPresentationButtonLaunchHandler } from "../src/modules/ui/chat-panel/ChatPanelEvents.ts";

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
  it("coalesces repeated configuring clicks and focuses the settings window", async function () {
    const coordinator = new PresentationLaunchCoordinator();
    const gate = deferred<boolean>();
    let starts = 0;
    let configurationFocuses = 0;
    const task = () => {
      starts += 1;
      return gate.promise;
    };

    const first = coordinator.enqueue("1:PAPER-A", task, {
      focusConfiguration: () => {
        configurationFocuses += 1;
      },
    });
    const second = coordinator.enqueue("1:PAPER-A", task);
    await Promise.resolve();

    assert.strictEqual(second, first);
    assert.equal(starts, 1);
    assert.equal(configurationFocuses, 1);
    gate.resolve(true);
    assert.isTrue(await first);
  });

  it("starts different papers concurrently without a cross-paper queue", async function () {
    const coordinator = new PresentationLaunchCoordinator();
    const firstGate = deferred<boolean>();
    const secondGate = deferred<boolean>();
    const order: string[] = [];

    const first = coordinator.enqueue("1:PAPER-A", async () => {
      order.push("A:start");
      const result = await firstGate.promise;
      order.push("A:end");
      return result;
    });
    const second = coordinator.enqueue("1:PAPER-B", async () => {
      order.push("B:start");
      const result = await secondGate.promise;
      order.push("B:end");
      return result;
    });
    await Promise.resolve();
    assert.deepEqual(order, ["A:start", "B:start"]);

    secondGate.resolve(true);
    assert.isTrue(await second);
    firstGate.resolve(true);
    assert.isTrue(await first);
    assert.deepEqual(order, ["A:start", "B:start", "B:end", "A:end"]);
  });

  it("focuses the existing task card when the same paper is already running", async function () {
    const coordinator = new PresentationLaunchCoordinator();
    const running = deferred<void>();
    const gate = deferred<boolean>();
    let starts = 0;
    let taskFocuses = 0;
    let configurationFocuses = 0;

    const first = coordinator.enqueue(
      "1:PAPER-A",
      async (lifecycle) => {
        starts += 1;
        assert.isTrue(
          lifecycle.beginRunning(() => {
            taskFocuses += 1;
          }),
        );
        running.resolve();
        return gate.promise;
      },
      {
        focusConfiguration: () => {
          configurationFocuses += 1;
        },
      },
    );
    await running.promise;

    const second = coordinator.enqueue("1:PAPER-A", async () => {
      starts += 1;
      return false;
    });

    assert.strictEqual(second, first);
    assert.equal(starts, 1);
    assert.equal(taskFocuses, 1);
    assert.equal(configurationFocuses, 0);
    gate.resolve(true);
    assert.isTrue(await first);
  });

  it("rejects a fourth running paper and gives same-paper focus priority", async function () {
    const coordinator = new PresentationLaunchCoordinator(3);
    const gates = [
      deferred<boolean>(),
      deferred<boolean>(),
      deferred<boolean>(),
    ];
    const started = [deferred<void>(), deferred<void>(), deferred<void>()];
    const taskFocuses = [0, 0, 0];
    let fourthStarts = 0;
    let capacityWarnings = 0;

    const runs = gates.map((gate, index) =>
      coordinator.enqueue(`1:PAPER-${index}`, async (lifecycle) => {
        assert.isTrue(
          lifecycle.beginRunning(() => {
            taskFocuses[index] += 1;
          }),
        );
        started[index].resolve();
        return gate.promise;
      }),
    );
    await Promise.all(started.map((entry) => entry.promise));

    const fourth = coordinator.enqueue(
      "1:PAPER-4",
      async () => {
        fourthStarts += 1;
        return true;
      },
      {
        onCapacityExceeded: () => {
          capacityWarnings += 1;
        },
      },
    );
    assert.isFalse(await fourth);
    assert.equal(fourthStarts, 0);
    assert.equal(capacityWarnings, 1);

    const duplicate = coordinator.enqueue("1:PAPER-0", async () => false, {
      onCapacityExceeded: () => {
        capacityWarnings += 1;
      },
    });
    assert.strictEqual(duplicate, runs[0]);
    assert.deepEqual(taskFocuses, [1, 0, 0]);
    assert.equal(capacityWarnings, 1);

    gates.forEach((gate) => gate.resolve(true));
    assert.deepEqual(await Promise.all(runs), [true, true, true]);
  });

  it("reserves the third slot atomically after concurrent settings windows", async function () {
    const coordinator = new PresentationLaunchCoordinator(3);
    const confirmations = Array.from({ length: 4 }, () => deferred<void>());
    const completionGates = Array.from({ length: 3 }, () =>
      deferred<boolean>(),
    );
    let capacityWarnings = 0;
    const beganRunning: boolean[] = [];

    const runs = confirmations.map((confirmation, index) =>
      coordinator.enqueue(
        `1:CONFIG-${index}`,
        async (lifecycle) => {
          await confirmation.promise;
          const reserved = lifecycle.beginRunning(() => undefined);
          beganRunning[index] = reserved;
          return reserved ? completionGates[index].promise : false;
        },
        {
          onCapacityExceeded: () => {
            capacityWarnings += 1;
          },
        },
      ),
    );
    await Promise.resolve();

    confirmations[0].resolve();
    confirmations[1].resolve();
    confirmations[2].resolve();
    await Promise.resolve();
    await Promise.resolve();
    confirmations[3].resolve();

    assert.isFalse(await runs[3]);
    assert.deepEqual(beganRunning, [true, true, true, false]);
    assert.equal(capacityWarnings, 1);
    completionGates.forEach((gate) => gate.resolve(true));
    assert.deepEqual(await Promise.all(runs.slice(0, 3)), [true, true, true]);
  });

  it("releases the sole running slot after every settled outcome", async function () {
    for (const outcome of ["success", "rejection", "cancelled"] as const) {
      const coordinator = new PresentationLaunchCoordinator(1);
      let capacityWarnings = 0;
      const first = coordinator.enqueue(
        `1:${outcome}`,
        async (lifecycle) => {
          assert.isTrue(lifecycle.beginRunning(() => undefined));
          if (outcome === "rejection") {
            throw new Error("launch failed");
          }
          return outcome === "success";
        },
        {
          onCapacityExceeded: () => {
            capacityWarnings += 1;
          },
        },
      );

      if (outcome === "rejection") {
        let rejection: unknown;
        try {
          await first;
        } catch (error) {
          rejection = error;
        }
        assert.instanceOf(rejection, Error);
        assert.equal((rejection as Error).message, "launch failed");
      } else {
        assert.equal(await first, outcome === "success");
      }

      const next = coordinator.enqueue(
        `1:${outcome}-next`,
        async (lifecycle) => {
          assert.isTrue(lifecycle.beginRunning(() => undefined));
          return true;
        },
        {
          onCapacityExceeded: () => {
            capacityWarnings += 1;
          },
        },
      );
      assert.isTrue(await next);
      assert.equal(capacityWarnings, 0);
    }
  });

  it("keeps the chat button activatable while the shared launch is pending", async function () {
    const gate = deferred<boolean>();
    const attributes = new Map<string, string>();
    let launches = 0;
    const handler = createPresentationButtonLaunchHandler(
      {
        launchPresentation: () => {
          launches += 1;
          return gate.promise;
        },
        appendError: (message: string) => {
          throw new Error(`Unexpected launch error: ${message}`);
        },
      },
      {
        setAttribute: (name: string, value: string) => {
          attributes.set(name, value);
        },
        removeAttribute: (name: string) => {
          attributes.delete(name);
        },
      },
    );

    handler();
    handler();

    assert.equal(launches, 2);
    assert.equal(attributes.get("aria-busy"), "true");
    gate.resolve(true);
    await gate.promise;
    await Promise.resolve();
    await Promise.resolve();
    assert.isFalse(attributes.has("aria-busy"));
  });
});
