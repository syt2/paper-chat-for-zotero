export interface ManagedAbortController {
  readonly aborted: boolean;
  signal?: AbortSignal;
  abort(): void;
}

type AbortControllerConstructor = new () => {
  readonly signal: AbortSignal;
  abort(): void;
};

// Firefox/Xray wrappers can expose an abort event while rejecting reads of
// `signal.aborted`. Remembering the event lets later catch/finally boundaries
// preserve cancellation instead of treating the AbortError as an ordinary
// renderer failure. Weak references keep this bookkeeping from retaining a
// completed turn.
const observedAbortedSignals = new WeakSet<object>();

function rememberAbortSignal(signal?: AbortSignal): void {
  if (!signal || (typeof signal !== "object" && typeof signal !== "function")) {
    return;
  }
  observedAbortedSignals.add(signal as object);
}

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
        return isAbortRequested(controller.signal);
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

/** Read a signal without letting a cross-compartment getter throw. */
export function isAbortRequested(signal?: AbortSignal): boolean {
  if (!signal) return false;
  if (
    (typeof signal === "object" || typeof signal === "function") &&
    observedAbortedSignals.has(signal as object)
  ) {
    return true;
  }
  try {
    const aborted = signal.aborted === true;
    if (aborted) rememberAbortSignal(signal);
    return aborted;
  } catch {
    return false;
  }
}

export function createAbortError(signal?: AbortSignal): Error {
  rememberAbortSignal(signal);
  let reason: unknown;
  try {
    reason = signal?.reason;
  } catch {
    reason = undefined;
  }
  let reasonName: unknown;
  try {
    reasonName =
      reason && typeof reason === "object"
        ? (reason as { name?: unknown }).name
        : undefined;
  } catch {
    reasonName = undefined;
  }
  if (reason && typeof reason === "object" && reasonName === "AbortError") {
    if (reason instanceof Error) return reason;
    const wrapped = new Error("Operation aborted.");
    wrapped.name = "AbortError";
    return wrapped;
  }
  const error = new Error(
    reason instanceof Error && reason.message
      ? reason.message
      : "Operation aborted.",
  );
  error.name = "AbortError";
  return error;
}

/** Return true for DOM/Firefox abort errors as well as our fallback error. */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  try {
    return (error as { name?: unknown }).name === "AbortError";
  } catch {
    return false;
  }
}

/**
 * Throw a stable AbortError for long-running capabilities that need to stop
 * between non-cancellable renderer/file-system operations.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!isAbortRequested(signal)) return;
  throw createAbortError(signal);
}

/**
 * Reject promptly when a signal aborts while an underlying operation is still
 * unwinding. The underlying promise remains observed so a later rejection does
 * not become unhandled; callers use this only around operations whose result
 * must no longer be consumed after cancellation.
 */
export function raceWithAbort<T>(
  operation: () => PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  // The operation is deliberately lazy. A pre-aborted signal must not start
  // a renderer/PDF request whose eventual rejection would otherwise become an
  // unhandled promise (and whose work could not be reclaimed by the caller).
  if (!signal) {
    return Promise.resolve().then(operation);
  }
  if (isAbortRequested(signal)) {
    return Promise.reject(createAbortError(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let operationPromise: PromiseLike<T> | undefined;
    // Treat a listener registration that throws as possibly partially
    // successful. Firefox/Xray wrappers can throw after forwarding the call
    // to the underlying signal; attempting removal on every settle avoids a
    // permanent listener in that case. A failed remove is still swallowed by
    // cleanup because the wrapper itself is not callable from this realm.
    let listenerRegistrationAttempted = false;
    const cleanup = () => {
      if (listenerRegistrationAttempted) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          // A Firefox compartment wrapper may expose a signal whose event
          // methods cannot be called from this realm. Cancellation still gets
          // checked at the surrounding await boundaries.
        }
        listenerRegistrationAttempted = false;
      }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // The event itself proves cancellation even when the wrapped signal's
      // `aborted` getter is not readable from this compartment.
      reject(createAbortError(signal));
    };

    try {
      if (isAbortRequested(signal)) {
        onAbort();
        return;
      }
      listenerRegistrationAttempted = true;
      signal.addEventListener("abort", onAbort, { once: true });
      if (isAbortRequested(signal)) {
        onAbort();
        return;
      }
    } catch {
      // Keep the operation observed even when a cross-compartment signal does
      // not support DOM event methods in this realm. Callers still perform
      // explicit throwIfAborted checks after each boundary.
      try {
        if (isAbortRequested(signal)) {
          onAbort();
          return;
        }
      } catch {
        // If even the aborted getter is unavailable, the surrounding caller
        // remains responsible for its explicit post-await check.
      }
    }

    // An abort can arrive immediately after listener registration. Do not
    // start a new renderer/PDF operation once the race has already settled.
    if (settled) return;

    try {
      operationPromise = operation();
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      return;
    }

    // Always observe the underlying promise, even when abort won the race.
    // This prevents a late renderer/PDF rejection from surfacing as an
    // unhandled rejection after the caller has already stopped the turn.
    Promise.resolve(operationPromise).then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
