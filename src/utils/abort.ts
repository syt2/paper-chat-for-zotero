export interface ManagedAbortController {
  readonly aborted: boolean;
  signal?: AbortSignal;
  abort(): void;
}

export function createAbortController(): ManagedAbortController {
  if (typeof AbortController !== "undefined") {
    const controller = new AbortController();
    return {
      get aborted() {
        return controller.signal.aborted;
      },
      get signal() {
        return controller.signal;
      },
      abort: () => controller.abort(),
    };
  }

  let aborted = false;
  return {
    get aborted() {
      return aborted;
    },
    signal: undefined,
    abort: () => {
      aborted = true;
    },
  };
}
