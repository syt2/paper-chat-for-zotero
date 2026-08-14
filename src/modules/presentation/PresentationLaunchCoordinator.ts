/**
 * Serializes account-wide presentation launches while coalescing repeated
 * clicks for the same paper. Each queued task starts only after the previous
 * task settles, so its balance check observes the freshest account state.
 */
export class PresentationLaunchCoordinator {
  private readonly runsByPaper = new Map<string, Promise<boolean>>();
  private queueTail: Promise<void> = Promise.resolve();

  enqueue(
    paperKey: string,
    task: () => Promise<boolean>,
    reactivateExisting?: () => void,
  ): Promise<boolean> {
    const existing = this.runsByPaper.get(paperKey);
    if (existing) {
      reactivateExisting?.();
      return existing;
    }

    const run = this.queueTail.then(task);
    // A rejected launch must not poison later launches for other papers.
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );

    const tracked = run.finally(() => {
      if (this.runsByPaper.get(paperKey) === tracked) {
        this.runsByPaper.delete(paperKey);
      }
    });
    this.runsByPaper.set(paperKey, tracked);
    return tracked;
  }
}
