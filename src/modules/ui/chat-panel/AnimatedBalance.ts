const HTML_NS = "http://www.w3.org/1999/xhtml";
const states = new WeakMap<HTMLElement, BalanceState>();
const failedWindows = new WeakSet<Window>();

export interface BalanceNumberParts {
  number: number;
  decimals: number;
  prefix: string;
  suffix: string;
}

export interface BalanceFlowElement extends HTMLElement {
  updateBalance(
    number: number,
    decimals: number,
    prefix: string,
    suffix: string,
    trend: number,
    animated: boolean,
  ): void;
}

interface NumberFlowBundle {
  create(): BalanceFlowElement | null;
}

type BalanceWindow = Window & {
  PaperChatNumberFlowBundle?: NumberFlowBundle;
};

interface BalanceState {
  label: string;
  value?: number;
  flow?: BalanceFlowElement;
}

/** Preserve the existing formatter's precision and compact units exactly. */
export function parseBalanceNumber(label: string): BalanceNumberParts | null {
  const match = /-?\d+(?:\.\d+)?/.exec(label);
  if (!match) return null;
  const number = Number(match[0]);
  const decimals = match[0].split(".")[1]?.length || 0;
  if (!Number.isFinite(number) || decimals > 20) return null;
  return {
    number,
    decimals,
    prefix: label.slice(0, match.index),
    suffix: label.slice(match.index + match[0].length),
  };
}

function createBalanceFlow(win: BalanceWindow): BalanceFlowElement | null {
  // Zotero 7 (Firefox 115) cannot animate NumberFlow's registered properties.
  // Leave the normal label intact and avoid loading browser-only code there.
  if (!win.CSS?.registerProperty || failedWindows.has(win)) return null;
  try {
    if (!win.PaperChatNumberFlowBundle) {
      // Custom element definitions and CSS registrations live for the window's
      // lifetime. Reuse this bundle across plugin reloads; never register twice.
      Services.scriptloader.loadSubScript(
        "chrome://paperchat/content/scripts/paperchat-number-flow.js",
        win,
      );
    }
    return win.PaperChatNumberFlowBundle?.create() || null;
  } catch (error) {
    failedWindows.add(win);
    ztoolkit.log("[AnimatedBalance] NumberFlow unavailable:", error);
    return null;
  }
}

/** Animate presentation only. API quota values and formatting remain authoritative. */
export function updateAnimatedBalance(
  element: HTMLElement,
  label: string,
  value?: number,
): void {
  const previous = states.get(element);
  if (previous?.label === label) {
    previous.value = value;
    return;
  }
  const state: BalanceState = { label, value, flow: previous?.flow };
  states.set(element, state);
  const parts = Number.isFinite(value) ? parseBalanceNumber(label) : null;
  const win = element.ownerDocument.defaultView as BalanceWindow | null;
  if (!parts || !win) {
    element.textContent = label;
    state.flow = undefined;
    return;
  }

  state.flow ||= createBalanceFlow(win) || undefined;
  if (!state.flow) {
    element.textContent = label;
    return;
  }
  try {
    if (state.flow.parentElement !== element) {
      element.textContent = "";
      // Expose a single exact label, independent of animated/intermediate digits.
      const accessible = element.ownerDocument.createElementNS(HTML_NS, "span");
      accessible.setAttribute("data-balance-label", "true");
      Object.assign(accessible.style, {
        position: "absolute",
        width: "1px",
        height: "1px",
        overflow: "hidden",
        clipPath: "inset(50%)",
        whiteSpace: "nowrap",
      });
      state.flow.setAttribute("aria-hidden", "true");
      element.appendChild(accessible);
      element.appendChild(state.flow);
    }
    const accessible = element.querySelector("[data-balance-label]");
    if (accessible) accessible.textContent = label;
    const animated =
      Number.isFinite(previous?.value) &&
      element.isConnected &&
      element.getClientRects().length > 0 &&
      !win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    state.flow.updateBalance(
      parts.number,
      parts.decimals,
      parts.prefix,
      parts.suffix,
      Math.sign(value! - (previous?.value ?? value!)),
      animated,
    );
  } catch (error) {
    // A visual failure must never block login controls or display stale quota.
    failedWindows.add(win);
    state.flow = undefined;
    element.textContent = label;
    ztoolkit.log("[AnimatedBalance] Failed to update NumberFlow:", error);
  }
}
