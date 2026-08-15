export const MAX_CONCURRENT_PRESENTATION_RUNS = 3;

export function createPresentationLaunchKey(source: {
  libraryID: number;
  itemKey: string;
}): string {
  return `${source.libraryID}:${source.itemKey}`;
}

export interface PresentationLaunchLifecycle {
  /** Reserve a generation slot after the settings gate has been confirmed. */
  beginRunning(focusTask: () => void): boolean;
}

export interface PresentationLaunchHandlers {
  focusConfiguration?: () => void;
  onCapacityExceeded?: () => void;
}

export type PresentationLaunchDisposition =
  | "started"
  | "existing"
  | "capacity_exceeded";

export interface PresentationLaunchEnqueueResult {
  disposition: PresentationLaunchDisposition;
  promise: Promise<boolean>;
}

type PresentationLaunchEntry = {
  phase: "configuring" | "running";
  promise: Promise<boolean>;
  focusConfiguration?: () => void;
  focusTask?: () => void;
  occupiesRunSlot: boolean;
};

/**
 * Coalesces duplicate launches for one paper while allowing different papers
 * to generate concurrently. Settings windows do not consume a run slot; the
 * slot is reserved atomically when the user confirms the expensive task.
 */
export class PresentationLaunchCoordinator {
  private readonly runsByPaper = new Map<string, PresentationLaunchEntry>();
  private runningCount = 0;

  constructor(
    private readonly maximumConcurrentRuns = MAX_CONCURRENT_PRESENTATION_RUNS,
  ) {}

  enqueue(
    paperKey: string,
    task: (lifecycle: PresentationLaunchLifecycle) => Promise<boolean>,
    handlers: PresentationLaunchHandlers = {},
  ): Promise<boolean> {
    return this.enqueueWithDisposition(paperKey, task, handlers).promise;
  }

  /**
   * Start or focus a launch while also telling callers whether they own the
   * new task. The regular UI entries only need the shared promise, whereas a
   * model-facing launcher must return immediately when an existing task was
   * focused instead of waiting for that unrelated task to finish.
   */
  enqueueWithDisposition(
    paperKey: string,
    task: (lifecycle: PresentationLaunchLifecycle) => Promise<boolean>,
    handlers: PresentationLaunchHandlers = {},
  ): PresentationLaunchEnqueueResult {
    const existing = this.runsByPaper.get(paperKey);
    if (existing) {
      if (existing.phase === "running") {
        existing.focusTask?.();
      } else {
        existing.focusConfiguration?.();
      }
      return { disposition: "existing", promise: existing.promise };
    }

    if (this.runningCount >= this.maximumConcurrentRuns) {
      handlers.onCapacityExceeded?.();
      return {
        disposition: "capacity_exceeded",
        promise: Promise.resolve(false),
      };
    }

    const entry: PresentationLaunchEntry = {
      phase: "configuring",
      promise: Promise.resolve(false),
      focusConfiguration: handlers.focusConfiguration,
      occupiesRunSlot: false,
    };
    const lifecycle: PresentationLaunchLifecycle = {
      beginRunning: (focusTask) => {
        if (
          this.runsByPaper.get(paperKey) !== entry ||
          entry.phase !== "configuring"
        ) {
          return false;
        }
        if (this.runningCount >= this.maximumConcurrentRuns) {
          handlers.onCapacityExceeded?.();
          return false;
        }
        entry.phase = "running";
        entry.focusConfiguration = undefined;
        entry.focusTask = focusTask;
        entry.occupiesRunSlot = true;
        this.runningCount += 1;
        return true;
      },
    };

    const run = Promise.resolve().then(() => task(lifecycle));
    const tracked = run.finally(() => {
      if (entry.occupiesRunSlot) {
        entry.occupiesRunSlot = false;
        this.runningCount = Math.max(0, this.runningCount - 1);
      }
      if (this.runsByPaper.get(paperKey) === entry) {
        this.runsByPaper.delete(paperKey);
      }
    });
    entry.promise = tracked;
    this.runsByPaper.set(paperKey, entry);
    return { disposition: "started", promise: tracked };
  }
}
