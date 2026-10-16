/**
 * Transient message that can be mounted in any Zotero window.
 *
 * Zotero's own progress window is a separate top-level window that can outlive
 * the click which opened it, so panels use this instead: one element per
 * document, reused for every message, faded out on a timer and dismissed early
 * by a click. The caller decides where it lives - the Zotero main window by
 * default, or the document of a panel such as the chat sidebar.
 */
export interface ToastTarget {
  /** Document to mount the toast in. Defaults to the Zotero main window. */
  doc?: Document;
  /** Element to append to. Defaults to the document's root element. */
  container?: Element;
  /** How long the toast stays visible, in milliseconds. */
  durationMs?: number;
  /** Message font size, so callers can follow their own scaling. */
  fontSize?: string;
  /** Distance from the bottom of the viewport. */
  bottom?: string;
}

const DEFAULT_DURATION_MS = 3200;
const DEFAULT_BOTTOM = "76px";

const toastElements = new WeakMap<Document, HTMLElement>();
const toastTimers = new WeakMap<Document, ReturnType<typeof setTimeout>>();

function resolveDocument(doc?: Document): Document | null {
  if (doc) {
    return doc;
  }
  const mainWindow = Zotero.getMainWindow?.();
  return mainWindow?.document ?? null;
}

function createToast(doc: Document, target: ToastTarget): HTMLElement {
  const toast = doc.createElement("div");
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  Object.assign(toast.style, {
    position: "fixed",
    left: "50%",
    bottom: target.bottom ?? DEFAULT_BOTTOM,
    transform: "translate(-50%, 6px)",
    maxWidth: "78%",
    padding: "8px 14px",
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.12)",
    // A dark snackbar reads fine in both Zotero themes, which keeps this
    // component free of the panel's theme plumbing.
    background: "rgba(32,32,36,0.94)",
    color: "#ffffff",
    boxShadow: "0 6px 18px rgba(0,0,0,0.28)",
    fontSize: target.fontSize ?? "12px",
    lineHeight: "1.45",
    textAlign: "center",
    whiteSpace: "normal",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity .18s ease, transform .18s ease",
    zIndex: "6",
  });
  toast.addEventListener("click", () => {
    hideToast(doc);
  });
  return toast;
}

/**
 * Show (or re-show) the toast for one document. Returns the element so callers
 * can assert or style it, or null when there is nowhere to mount it.
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

  let toast = toastElements.get(doc);
  if (!toast || !toast.isConnected) {
    toast = createToast(doc, target);
    toastElements.set(doc, toast);
  }
  if (toast.parentElement !== host) {
    host.appendChild(toast);
  }
  toast.textContent = text;
  toast.style.pointerEvents = "auto";
  toast.style.opacity = "1";
  toast.style.transform = "translate(-50%, 0)";

  const pending = toastTimers.get(doc);
  if (pending) {
    clearTimeout(pending);
  }
  toastTimers.set(
    doc,
    setTimeout(() => hideToast(doc), target.durationMs ?? DEFAULT_DURATION_MS),
  );
  return toast;
}

/** Hide the toast of one document right away. */
export function hideToast(doc?: Document): void {
  const resolved = resolveDocument(doc);
  if (!resolved) {
    return;
  }
  const pending = toastTimers.get(resolved);
  if (pending) {
    clearTimeout(pending);
    toastTimers.delete(resolved);
  }
  const toast = toastElements.get(resolved);
  if (!toast) {
    return;
  }
  toast.style.opacity = "0";
  toast.style.transform = "translate(-50%, 6px)";
  toast.style.pointerEvents = "none";
}
