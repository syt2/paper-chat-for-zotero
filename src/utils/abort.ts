export interface ManagedAbortController {
  readonly aborted: boolean;
  signal?: AbortSignal;
  abort(): void;
}

type AbortControllerConstructor = new () => {
  readonly signal: AbortSignal;
  abort(): void;
};

function readAbortControllerConstructor(
  owner: unknown,
): AbortControllerConstructor | undefined {
  try {
    const candidate = (owner as { AbortController?: unknown } | null)
      ?.AbortController;
    return typeof candidate === "function"
      ? (candidate as AbortControllerConstructor)
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveAbortControllerConstructor():
  | AbortControllerConstructor
  | undefined {
  const globalConstructor = readAbortControllerConstructor(globalThis);
  if (globalConstructor) return globalConstructor;

  try {
    if (
      typeof Zotero !== "undefined" &&
      typeof Zotero.getMainWindow === "function"
    ) {
      const windowConstructor = readAbortControllerConstructor(
        Zotero.getMainWindow(),
      );
      if (windowConstructor) return windowConstructor;
    }
  } catch {
    // Fall through to Firefox's hidden DOM window.
  }

  try {
    if (typeof Services !== "undefined") {
      return readAbortControllerConstructor(
        (
          Services as unknown as {
            appShell?: { hiddenDOMWindow?: unknown };
          }
        ).appShell?.hiddenDOMWindow,
      );
    }
  } catch {
    // The non-DOM fallback below still supports best-effort cancellation.
  }

  return undefined;
}

export function createAbortController(): ManagedAbortController {
  const AbortControllerImpl = resolveAbortControllerConstructor();
  if (AbortControllerImpl) {
    const controller = new AbortControllerImpl();
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
