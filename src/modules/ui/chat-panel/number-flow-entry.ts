import NumberFlow, { canAnimate } from "number-flow";
import type { BalanceFlowElement } from "./AnimatedBalance";

const TAG = "paperchat-balance-flow";

/** Runs in the owning DOM window, not Zotero's plugin sandbox. */
class PaperChatBalanceFlow extends NumberFlow implements BalanceFlowElement {
  updateBalance(
    number: number,
    decimals: number,
    prefix: string,
    suffix: string,
    trend: number,
    animated: boolean,
  ): void {
    this.locales = "en-US";
    this.format = {
      useGrouping: false,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    };
    this.numberPrefix = prefix;
    this.numberSuffix = suffix;
    // Compact notation can decrease while the actual quota increases (999K → 1M).
    this.trend = trend;
    this.animated = animated;
    this.transformTiming = {
      duration: 420,
      easing: "cubic-bezier(.22,1,.36,1)",
    };
    this.opacityTiming = { duration: 200, easing: "ease-out" };
    this.update(number);
  }
}

if (canAnimate && !customElements.get(TAG)) {
  // Zotero's ambient XUL types also require a callable constructor signature.
  customElements.define(
    TAG,
    PaperChatBalanceFlow as unknown as CustomElementConstructor,
  );
}

export function create(): BalanceFlowElement | null {
  if (!canAnimate) return null;
  const flow = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    TAG,
  ) as PaperChatBalanceFlow;
  flow.style.fontVariantNumeric = "tabular-nums";
  flow.style.setProperty("--number-flow-mask-height", "0.1em");
  return flow;
}
