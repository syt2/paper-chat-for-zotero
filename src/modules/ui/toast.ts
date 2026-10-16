/**
 * Transient message that can be mounted in any Zotero window or pane.
 *
 * Zotero's own progress window is a separate top-level window that can outlive
 * the click which opened it, so panels use this instead: one element per mount
 * point, reused for every message, faded out on a timer and dismissed early by
 * a click.
 *
 * The mount point matters. The chat panel and the Zotero main window share one
 * document, so the panel passes its own pane together with
 * `positioning: "container"`; without a container the toast floats at the
 * bottom of the window instead.
 */
export interface ToastTarget {
  /** Document to mount the toast in. Defaults to the Zotero main window. */
  doc?: Document;
  /** Element to mount inside. Defaults to the document's root element. */
  container?: Element;
  /**
   * `"container"` places the toast inside the given container (the default as
   * soon as a container is passed), `"viewport"` pins it to the bottom of the
   * window instead.
   */
  positioning?: "viewport" | "container";
  /** How long the toast stays visible, in milliseconds. */
  durationMs?: number;
  /** Message font size, so callers can follow their own scaling. */
  fontSize?: string;
  /** Distance from the bottom of the mount point. */
  bottom?: string;
  /** Style overrides, applied on every call so theme changes follow along. */
  styles?: Record<string, string>;
}

const DEFAULT_DURATION_MS = 3200;
const DEFAULT_BOTTOM = "76px";

const toastElements = new WeakMap<Element, HTMLElement>();
const toastTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function resolveDocument(doc?: Document): Document | null {
  if (doc) {
    return doc;
  }
  const mainWindow = Zotero.getMainWindow?.();
  return mainWindow?.document ?? null;
}

function createToast(doc: Document): HTMLElement {
  const toast = doc.createElement("div");
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  Object.assign(toast.style, {
    left: "50%",
    transform: "translate(-50%, 6px)",
    maxWidth: "78%",
    padding: "8px 14px",
    borderRadius: "10px",
    // Neutral by default so a caller without theme plumbing still gets a
    // readable toast; callers with a theme pass their own colors instead.
    border: "1px solid rgba(128,128,128,0.4)",
    background: "rgba(32,32,36,0.94)",
    color: "#ffffff",
    fontSize: "12px",
    lineHeight: "1.45",
    textAlign: "center",
    whiteSpace: "normal",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity .18s ease, transform .18s ease",
    // Above the chat panel's own layers (its model menu sits at 10002) so a
    // toast is never buried by the popup that triggered it.
    zIndex: "10030",
  });
  const element = toast;
  toast.addEventListener("click", () => hideToast(element));
  return toast;
}

/**
 * Show (or re-show) the toast for one mount point. Returns the element so
 * callers can hide it early or assert on it, or null when there is nowhere to
 * mount it.
 */
export function showToast(
  message: string,
  target: ToastTarget = {},
): HTMLElement | null {
  const text = message.trim();
  const doc = resolveDocument(target.doc);
  const host = target.container ?? doc?.documentElement;
  if (!doc || !host || !text) {
    return null;
  }

  let toast = toastElements.get(host);
  if (!toast || !toast.isConnected) {
    toast = createToast(doc);
    toastElements.set(host, toast);
  }
  if (toast.parentElement !== host) {
    host.appendChild(toast);
  }

  const inContainer =
    (target.positioning ?? (target.container ? "container" : "viewport")) ===
    "container";
  const hostPosition = doc.defaultView?.getComputedStyle?.(host)?.position;
  if (inContainer && (hostPosition === "static" || !hostPosition)) {
    (host as HTMLElement).style.position = "relative";
  }

  toast.style.position = inContainer ? "absolute" : "fixed";
  toast.style.bottom = target.bottom ?? DEFAULT_BOTTOM;
  toast.style.fontSize = target.fontSize ?? (toast.style.fontSize || "12px");
  toast.style.boxShadow = inContainer
    ? "0 6px 18px rgba(0,0,0,0.18)"
    : "0 6px 18px rgba(0,0,0,0.28)";
  Object.assign(toast.style, target.styles ?? {});

  toast.textContent = text;
  toast.style.pointerEvents = "auto";
  toast.style.opacity = "1";
  toast.style.transform = "translate(-50%, 0)";

  const pending = toastTimers.get(toast);
  if (pending) {
    clearTimeout(pending);
  }
  const element = toast;
  toastTimers.set(
    element,
    setTimeout(
      () => hideToast(element),
      target.durationMs ?? DEFAULT_DURATION_MS,
    ),
  );
  return element;
}

/** Hide a toast right away. */
export function hideToast(toast: HTMLElement | null | undefined): void {
  if (!toast) {
    return;
  }
  const pending = toastTimers.get(toast);
  if (pending) {
    clearTimeout(pending);
    toastTimers.delete(toast);
  }
  toast.style.opacity = "0";
  toast.style.transform = "translate(-50%, 6px)";
  toast.style.pointerEvents = "none";
}
