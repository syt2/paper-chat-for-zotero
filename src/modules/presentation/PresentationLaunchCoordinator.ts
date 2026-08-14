export const MAX_CONCURRENT_PRESENTATION_RUNS = 3;

export interface PresentationLaunchLifecycle {
  /** Reserve a generation slot after the settings gate has been confirmed. */
  beginRunning(focusTask: () => void): boolean;
}

export interface PresentationLaunchHandlers {
  focusConfiguration?: () => void;
  onCapacityExceeded?: () => void;
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
    const existing = this.runsByPaper.get(paperKey);
    if (existing) {
      if (existing.phase === "running") {
        existing.focusTask?.();
      } else {
        existing.focusConfiguration?.();
      }
      return existing.promise;
    }

    if (this.runningCount >= this.maximumConcurrentRuns) {
      handlers.onCapacityExceeded?.();
      return Promise.resolve(false);
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
    return tracked;
  }
}
