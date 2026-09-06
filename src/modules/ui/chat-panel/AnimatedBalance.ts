const HTML_NS = "http://www.w3.org/1999/xhtml";
const states = new WeakMap<HTMLElement, BalanceState>();

interface BalanceState {
  label: string;
  value?: number;
  animations: Animation[];
}

/** Animate only the presentation; the formatted balance remains authoritative. */
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
  previous?.animations.forEach((animation) => animation.cancel());
  const state: BalanceState = { label, value, animations: [] };
  states.set(element, state);
  element.textContent = label;

  const win = element.ownerDocument.defaultView;
  if (
    !previous ||
    !Number.isFinite(previous.value) ||
    !Number.isFinite(value) ||
    !element.isConnected ||
    !element.getClientRects().length ||
    win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ||
    typeof element.animate !== "function"
  ) {
    return;
  }

  const oldNumber = previous.label.match(/-?\d+(?:\.\d+)?/);
  const newNumber = label.match(/-?\d+(?:\.\d+)?/);
  if (!oldNumber || !newNumber) return;
  const oldParts = oldNumber[0].replace("-", "").split(".");
  const newParts = newNumber[0].replace("-", "").split(".");
  const increasing = value! > previous.value!;
  const span = (text = "") => {
    const node = element.ownerDocument.createElementNS(HTML_NS, "span");
    node.textContent = text;
    return node;
  };
  const visual = span();
  visual.setAttribute("aria-hidden", "true");
  visual.style.fontVariantNumeric = "tabular-nums";
  visual.appendChild(span(label.slice(0, newNumber.index)));
  let integerIndex = 0;
  let fractionIndex = 0;
  let fractional = false;
  for (const character of newNumber[0]) {
    if (!/\d/.test(character)) {
      visual.appendChild(span(character));
      if (character === ".") fractional = true;
      continue;
    }
    const oldDigit = fractional
      ? oldParts[1]?.[fractionIndex++]
      : oldParts[0][oldParts[0].length - newParts[0].length + integerIndex++];
    const cell = span(character);
    visual.appendChild(cell);
    if (oldDigit === character) continue;
    Object.assign(cell.style, {
      display: "inline-block",
      position: "relative",
      height: "1.4em",
      lineHeight: "1.4",
      width: "1ch",
      overflow: "hidden",
      verticalAlign: "bottom",
    });
    const outgoing = span(oldDigit || "0");
    const incoming = span(character);
    for (const digit of [outgoing, incoming]) {
      Object.assign(digit.style, {
        position: "absolute",
        inset: "0",
        textAlign: "center",
      });
    }
    cell.textContent = "";
    cell.appendChild(outgoing);
    cell.appendChild(incoming);
    const distance = increasing ? 100 : -100;
    const timing = {
      duration: 420,
      easing: "cubic-bezier(.22,1,.36,1)",
      fill: "forwards" as const,
    };
    state.animations.push(
      outgoing.animate(
        [
          { transform: "translateY(0)" },
          { transform: `translateY(${-distance}%)` },
        ],
        timing,
      ),
      incoming.animate(
        [
          { transform: `translateY(${distance}%)` },
          { transform: "translateY(0)" },
        ],
        timing,
      ),
    );
  }
  visual.appendChild(span(label.slice(newNumber.index! + newNumber[0].length)));
  const accessible = span(label);
  Object.assign(accessible.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  });
  element.textContent = "";
  element.appendChild(accessible);
  element.appendChild(visual);
  void Promise.all(
    state.animations.map((animation) => animation.finished),
  ).then(
    () => {
      if (states.get(element) !== state) return;
      element.textContent = label;
      state.animations.forEach((animation) => animation.cancel());
      state.animations = [];
    },
    () => {
      /* A newer balance cancelled this transition. */
    },
  );
}
