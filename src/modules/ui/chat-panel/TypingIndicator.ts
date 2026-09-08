import { createElement } from "./ChatPanelBuilder";
import { HTML_NS, type ThemeColors } from "./types";

/**
 * Inject typing animation CSS keyframes into the document (once)
 */
function injectTypingAnimation(doc: Document): void {
  if (doc.querySelector("#typing-indicator-style")) return;
  const style = doc.createElementNS(HTML_NS, "style") as HTMLStyleElement;
  style.id = "typing-indicator-style";
  style.textContent = `
    .typing-indicator span {
      display: block;
      animation: typing-bounce 1.4s ease-in-out infinite;
    }
    .typing-indicator span:nth-child(2) {
      animation-delay: 0.2s;
    }
    .typing-indicator span:nth-child(3) {
      animation-delay: 0.4s;
    }
    @keyframes typing-bounce {
      0%, 60%, 100% { opacity: 0.4; transform: translateY(0); }
      30% { opacity: 1; transform: translateY(-4px); }
    }
  `;
  doc.head?.appendChild(style);
}

export function createTypingIndicator(
  doc: Document,
  theme: ThemeColors,
): HTMLElement {
  injectTypingAnimation(doc);

  const loader = createElement(
    doc,
    "div",
    {
      display: "flex",
      alignItems: "center",
      gap: "4px",
      marginTop: "6px",
      padding: "4px 0",
    },
    {
      class: "typing-indicator",
      ["data-streaming-typing-indicator"]: "true",
      "aria-hidden": "true",
    },
  );

  for (let i = 0; i < 3; i++) {
    const dot = createElement(doc, "span", {
      width: "6px",
      height: "6px",
      borderRadius: "50%",
      background: theme.textMuted,
      opacity: "0.4",
    });
    loader.appendChild(dot);
  }

  return loader;
}
