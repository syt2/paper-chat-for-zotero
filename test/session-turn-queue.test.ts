import { assert } from "chai";
import {
  MAX_QUEUED_TURNS,
  SessionTurnQueue,
  type QueuedTurn,
  type TurnRunResult,
} from "../src/modules/ui/chat-panel/SessionTurnQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

function turn(
  id: string,
  run: () => Promise<TurnRunResult>,
  cancel: () => Promise<boolean> = async () => false,
): QueuedTurn {
  return {
    id,
    content: id,
    draft: {
      content: id,
      attachmentState: {
        pendingImages: [],
        pendingFiles: [],
        pendingSelectedText: null,
        pendingQuotedMessages: [],
      },
    },
    run,
    cancel,
  };
}

const accepted = async (): Promise<TurnRunResult> => ({ accepted: true });

describe("SessionTurnQueue", function () {
  it("runs FIFO with one active turn and at most three waiting turns", async function () {
    const queue = new SessionTurnQueue();
    const first = deferred<TurnRunResult>();
    const order: string[] = [];
    const queuedTurn = (id: string, gate?: Promise<TurnRunResult>) =>
      turn(id, async () => {
        order.push(id);
        return gate ? gate : { accepted: true };
      });

    assert.isTrue(queue.enqueue("s", queuedTurn("one", first.promise)));
    assert.isTrue(queue.enqueue("s", queuedTurn("two")));
    assert.isTrue(queue.enqueue("s", queuedTurn("three")));
    assert.isTrue(queue.enqueue("s", queuedTurn("four")));
    assert.equal(MAX_QUEUED_TURNS, 3);
    assert.isFalse(queue.enqueue("s", queuedTurn("five")));

    first.resolve({ accepted: true });
    await flush();
    assert.deepEqual(order, ["one", "two", "three", "four"]);
    assert.equal(queue.snapshot("s").status, "idle");
  });

  it("keeps sessions independent and stops only the active turn", async function () {
    const queue = new SessionTurnQueue();
    const gateA = deferred<TurnRunResult>();
    const gateB = deferred<TurnRunResult>();
    let cancelledA = 0;

    queue.enqueue(
      "a",
      turn(
        "a1",
        () => gateA.promise,
        async () => {
          cancelledA++;
          gateA.resolve({ accepted: true });
          return true;
        },
      ),
    );
    queue.enqueue(
      "b",
      turn("b1", () => gateB.promise),
    );

    assert.isTrue(await queue.stop("a"));
    await flush();
    assert.equal(cancelledA, 1);
    assert.equal(queue.snapshot("a").status, "idle");
    assert.equal(queue.snapshot("b").status, "running");
    gateB.resolve({ accepted: true });
  });

  it("moves Guide Now to the front and cancels the current turn", async function () {
    const queue = new SessionTurnQueue();
    const active = deferred<TurnRunResult>();
    const order: string[] = [];
    queue.enqueue(
      "s",
      turn(
        "active",
        async () => {
          order.push("active");
          return active.promise;
        },
        async () => {
          active.resolve({ accepted: true });
          return true;
        },
      ),
    );
    queue.enqueue(
      "s",
      turn("older", async () => {
        order.push("older");
        return { accepted: true };
      }),
    );
    queue.enqueue(
      "s",
      turn("guide", async () => {
        order.push("guide");
        return { accepted: true };
      }),
    );

    assert.isTrue(await queue.guide("s", "guide"));
    await flush();
    assert.deepEqual(order, ["active", "guide", "older"]);
  });

  it("sends the queue head after cancellation even if the old run never settles", async function () {
    const queue = new SessionTurnQueue();
    const never = new Promise<TurnRunResult>(() => undefined);
    const order: string[] = [];
    queue.enqueue(
      "s",
      turn(
        "active",
        () => never,
        async () => true,
      ),
    );
    queue.enqueue(
      "s",
      turn("waiting", async () => {
        order.push("waiting");
        return { accepted: true };
      }),
    );

    assert.isTrue(await queue.stop("s"));
    await flush();
    assert.deepEqual(order, ["waiting"]);
    assert.equal(queue.snapshot("s").status, "idle");
  });

  it("ignores an old run that rejects after cancellation", async function () {
    const queue = new SessionTurnQueue();
    let rejectOldRun!: (error: Error) => void;
    const oldRun = new Promise<TurnRunResult>((_resolve, reject) => {
      rejectOldRun = reject;
    });
    const order: string[] = [];
    queue.enqueue(
      "s",
      turn(
        "active",
        () => oldRun,
        async () => true,
      ),
    );
    queue.enqueue(
      "s",
      turn("waiting", async () => {
        order.push("waiting");
        return { accepted: true };
      }),
    );

    assert.isTrue(await queue.stop("s"));
    rejectOldRun(new Error("late abort"));
    await flush();
    assert.deepEqual(order, ["waiting"]);
    assert.equal(queue.snapshot("s").status, "idle");
    assert.deepEqual(queue.snapshot("s").queued, []);
  });

  it("coalesces concurrent stop requests for the same active turn", async function () {
    const queue = new SessionTurnQueue();
    const cancellation = deferred<boolean>();
    let cancelCalls = 0;
    queue.enqueue(
      "s",
      turn(
        "active",
        () => new Promise<TurnRunResult>(() => undefined),
        async () => {
          cancelCalls++;
          return cancellation.promise;
        },
      ),
    );

    const firstStop = queue.stop("s");
    const secondStop = queue.stop("s");
    assert.equal(cancelCalls, 1);
    cancellation.resolve(true);
    assert.isTrue(await firstStop);
    assert.isTrue(await secondStop);
    assert.equal(queue.snapshot("s").status, "idle");
  });

  it("removes a queued draft without changing the remaining order", function () {
    const queue = new SessionTurnQueue();
    const active = deferred<TurnRunResult>();
    queue.enqueue(
      "s",
      turn("active", () => active.promise),
    );
    queue.enqueue("s", turn("edit", accepted));
    queue.enqueue("s", turn("later", accepted));

    assert.equal(queue.remove("s", "edit")?.draft.content, "edit");
    assert.deepEqual(
      queue.snapshot("s").queued.map((entry) => entry.id),
      ["later"],
    );
    active.resolve({ accepted: true });
  });

  it("pauses on failure, retries it, then sends the waiting head", async function () {
    const queue = new SessionTurnQueue();
    const order: string[] = [];
    const retry = async (): Promise<TurnRunResult> => {
      order.push("retry");
      return { accepted: true };
    };
    queue.enqueue(
      "s",
      turn("failed", async () => {
        order.push("failed");
        return { accepted: true, errorId: "error", retry };
      }),
    );
    queue.enqueue(
      "s",
      turn("waiting", async () => {
        order.push("waiting");
        return { accepted: true };
      }),
    );
    await flush();

    assert.equal(queue.snapshot("s").status, "paused");
    assert.equal(queue.snapshot("s").failureErrorId, "error");
    assert.isTrue(await queue.retry("s", "error"));
    await flush();
    assert.deepEqual(order, ["failed", "retry", "waiting"]);
  });

  it("abandons Retry state when a new turn resumes the waiting queue", async function () {
    const queue = new SessionTurnQueue();
    const order: string[] = [];
    queue.enqueue(
      "s",
      turn("failed", async () => ({
        accepted: true,
        errorId: "error",
        retry: accepted,
      })),
    );
    queue.enqueue(
      "s",
      turn("waiting", async () => {
        order.push("waiting");
        return { accepted: true };
      }),
    );
    await flush();

    queue.enqueue(
      "s",
      turn("new", async () => {
        order.push("new");
        return { accepted: true };
      }),
    );
    await flush();
    assert.deepEqual(order, ["waiting", "new"]);
  });

  it("keeps a pre-persist failure at the head until removed or resumed", async function () {
    const queue = new SessionTurnQueue();
    const failed = turn("failed", async () => {
      throw new Error("preflight failed");
    });
    queue.enqueue("s", failed);
    queue.enqueue("s", turn("waiting", accepted));
    await flush();

    assert.equal(queue.snapshot("s").status, "paused");
    assert.deepEqual(
      queue.snapshot("s").queued.map((entry) => entry.id),
      ["failed", "waiting"],
    );
    assert.equal(queue.remove("s", "failed"), failed);
    await flush();
    assert.equal(queue.snapshot("s").status, "idle");
  });

  it("does not drain stale turns after a session is cleared", async function () {
    const queue = new SessionTurnQueue();
    const active = deferred<TurnRunResult>();
    let waitingRan = false;
    queue.enqueue(
      "s",
      turn("active", () => active.promise),
    );
    queue.enqueue(
      "s",
      turn("waiting", async () => {
        waitingRan = true;
        return { accepted: true };
      }),
    );

    queue.clear("s");
    active.resolve({ accepted: true });
    await flush();
    assert.isFalse(waitingRan);
    assert.equal(queue.snapshot("s").status, "idle");
  });
});
