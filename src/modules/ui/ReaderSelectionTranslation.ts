import {
  translationLanguages,
  normalizeTranslationLanguage,
} from "./SelectionTranslationLanguage";
import type { SelectionTranslationContext } from "./SelectionTranslationContext";
import { getPref, setPref } from "../../utils/prefs";
import { getTranslationModelOptions } from "./SelectionTranslationModels";
import { SelectionTranslationError } from "./SelectionTranslationRouting";
import {
  parsePaperChatQuotaError,
  getPaperChatErrorDisplayMessage,
} from "../providers/paperchat-errors";
import { createTopupButton } from "./chat-panel/PaperChatTopupButton";
import { createTypingIndicator } from "./chat-panel/TypingIndicator";
import { darkTheme, lightTheme } from "./chat-panel/ChatPanelTheme";
import { getString } from "../../utils/locale";
import { streamSelectionTranslation } from "./SelectionTranslationService";
import type { SelectionRect } from "./reader-chat-selection";

/** One disposable popover per reader; closing it also cancels its request. */
export function showReaderSelectionTranslation(
  sourceDoc: Document,
  text: string,
  anchor: SelectionRect,
  context?: SelectionTranslationContext,
): () => void {
  // Render beside the PDF iframe, above Zotero's native selection palette.
  // A z-index inside the PDF cannot rise above that sibling palette.
  const frame = sourceDoc.defaultView?.frameElement;
  const doc = frame?.ownerDocument || sourceDoc;
  const win = doc.defaultView;
  if (!win || !doc.body) return () => {};
  let controller = new (win as Window & typeof globalThis).AbortController();
  const panel = doc.createElement("section");
  panel.className = "paperchat-selection-translation";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", getString("chat-reader-translate"));
  panel.setAttribute("aria-busy", "true");
  const dark = win.matchMedia("(prefers-color-scheme: dark)")?.matches;
  Object.assign(panel.style, {
    position: "fixed",
    zIndex: "2147483647",
    boxSizing: "border-box",
    width: `${Math.max(0, Math.min(360, win.innerWidth - 16))}px`,
    maxHeight: `${Math.max(0, Math.min(260, win.innerHeight - 16))}px`,
    display: "flex",
    flexDirection: "column",
    borderRadius: "10px",
    border: `1px solid ${dark ? "#505055" : "#dedee3"}`,
    background: dark ? "#27272b" : "#fff",
    color: dark ? "#eeeeef" : "#292930",
    boxShadow: "0 4px 18px rgba(0,0,0,.14)",
    font: "13px/1.65 system-ui, sans-serif",
    overflow: "hidden",
    pointerEvents: "auto",
    userSelect: "text",
  });
  const header = doc.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    padding: "7px 10px",
    gap: "4px",
    flexShrink: "0",
    cursor: "grab",
    userSelect: "none",
    touchAction: "none",
  });
  const title = doc.createElement("span");
  title.textContent = getString("chat-reader-translate");
  title.style.flexShrink = "0";
  title.style.opacity = ".65";
  title.style.marginRight = "4px";
  const modelSelect = doc.createElement("select");
  modelSelect.setAttribute("aria-label", getString("chat-translation-model"));
  Object.assign(modelSelect.style, {
    flex: "1",
    minWidth: "0",
    maxWidth: "230px",
    height: "24px",
    marginRight: "auto",
    border: "none",
    borderRadius: "5px",
    background: dark ? "#36363c" : "#f2f2f5",
    color: "inherit",
    font: "11px system-ui, sans-serif",
    cursor: "pointer",
    padding: "0 5px",
    textOverflow: "ellipsis",
  });
  for (const item of getTranslationModelOptions()) {
    const option = doc.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    modelSelect.appendChild(option);
  }
  modelSelect.value = getPref("translationModel") || "auto";
  if (!modelSelect.value) {
    modelSelect.value = "auto";
    setPref("translationModel", "auto");
  }
  const languageSelect = doc.createElement("select");
  languageSelect.setAttribute(
    "aria-label",
    getString("chat-translation-language"),
  );
  languageSelect.style.cssText = modelSelect.style.cssText;
  languageSelect.style.flex = "0 1 88px";
  languageSelect.style.minWidth = "64px";
  languageSelect.style.marginRight = "0";
  for (const item of [
    { value: "auto", label: getString("pref-translation-auto") },
    ...translationLanguages,
  ]) {
    const option = doc.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    languageSelect.appendChild(option);
  }
  languageSelect.value = normalizeTranslationLanguage(
    getPref("translationLanguage"),
  );
  const close = doc.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", getString("chat-reader-translation-close"));
  Object.assign(close.style, {
    border: "0",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    width: "24px",
    height: "24px",
    padding: "0",
    borderRadius: "6px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    appearance: "none",
    font: "18px/1 system-ui, sans-serif",
  });
  const modelLabel = doc.createElement("span");
  modelLabel.textContent = getString("chat-translation-model-label");
  const languageLabel = doc.createElement("span");
  languageLabel.textContent = getString("chat-translation-language-label");
  for (const label of [modelLabel, languageLabel]) {
    label.style.fontSize = "11px";
    label.style.opacity = ".65";
    label.style.whiteSpace = "nowrap";
    label.style.flexShrink = "0";
  }
  languageLabel.style.marginLeft = "4px";
  close.style.flexShrink = "0";
  header.append(
    title,
    modelLabel,
    modelSelect,
    languageLabel,
    languageSelect,
    close,
  );
  const body = doc.createElement("div");
  Object.assign(body.style, {
    padding: "0 12px 12px",
    minHeight: "48px",
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  });
  const content = doc.createElement("div");
  const loading = createTypingIndicator(doc, dark ? darkTheme : lightTheme);
  body.append(content, loading);
  panel.append(header, body);
  doc.body.append(panel);
  let manualPosition: { left: number; top: number } | undefined;
  const place = () => {
    panel.style.width = `${Math.max(0, Math.min(360, win.innerWidth - 16))}px`;
    panel.style.maxHeight = `${Math.max(0, Math.min(260, win.innerHeight - 16))}px`;
    const width = panel.getBoundingClientRect().width;
    const height = panel.getBoundingClientRect().height;
    const frameRect = frame?.getBoundingClientRect();
    const left = anchor.left + (frameRect?.left || 0);
    const top = anchor.top + (frameRect?.top || 0);
    const below = top + anchor.height + 8;
    panel.style.left = `${Math.max(8, Math.min(manualPosition?.left ?? left, win.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(manualPosition?.top ?? (below + height <= win.innerHeight - 8 ? below : top - height - 8), win.innerHeight - height - 8))}px`;
  };
  place();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    panel.remove();
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", keydown, true);

    sourceDoc.removeEventListener("pointerdown", outside, true);
    sourceDoc.removeEventListener("keydown", keydown, true);

    sourceDoc.defaultView?.removeEventListener("pagehide", dispose);
    win.removeEventListener("pagehide", dispose);
    win.removeEventListener("resize", place);
  };
  const outside = (event: Event) => {
    if (!panel.contains(event.target as Node)) dispose();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dispose();
    }
  };
  let drag:
    | { id: number; x: number; y: number; left: number; top: number }
    | undefined;
  header.addEventListener("pointerdown", (event) => {
    if (
      event.button !== 0 ||
      close.contains(event.target as Node) ||
      modelSelect.contains(event.target as Node) ||
      languageSelect.contains(event.target as Node)
    )
      return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    header.setPointerCapture(event.pointerId);
    header.style.cursor = "grabbing";
  });
  header.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    manualPosition = {
      left: drag.left + event.clientX - drag.x,
      top: drag.top + event.clientY - drag.y,
    };
    place();
  });
  const endDrag = () => {
    drag = undefined;
    header.style.cursor = "grab";
  };
  header.addEventListener("pointerup", endDrag);
  header.addEventListener("pointercancel", endDrag);
  header.addEventListener("lostpointercapture", endDrag);
  close.addEventListener("click", dispose);
  // Let readers copy translated text without PDF.js treating it as a PDF drag.
  panel.addEventListener("pointerdown", (event) => event.stopPropagation());
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", keydown, true);

  sourceDoc.addEventListener("pointerdown", outside, true);
  sourceDoc.addEventListener("keydown", keydown, true);

  sourceDoc.defaultView?.addEventListener("pagehide", dispose);
  win.addEventListener("pagehide", dispose);
  win.addEventListener("resize", place);
  // CSS transitions work across the privileged reader boundary in both
  // supported Gecko versions, unlike Web Animations keyframe objects.
  if (!win.matchMedia("(prefers-reduced-motion: reduce)")?.matches) {
    panel.style.opacity = "0";
    panel.style.transform = "translateY(-4px)";
    panel.style.transition = "opacity 180ms ease-out, transform 180ms ease-out";
    panel.getBoundingClientRect();
    win.requestAnimationFrame(() => {
      if (disposed) return;
      panel.style.opacity = "1";
      panel.style.transform = "translateY(0)";
    });
  }
  const translate = () => {
    controller.abort();
    controller = new (win as Window & typeof globalThis).AbortController();
    const request = controller;
    content.textContent = "";
    body.replaceChildren(content, loading);
    panel.setAttribute("aria-busy", "true");
    modelSelect.title = modelSelect.selectedOptions[0]?.textContent || "";
    languageSelect.title = languageSelect.selectedOptions[0]?.textContent || "";
    place();
    void streamSelectionTranslation(
      text,
      request.signal,
      (translation) => {
        if (disposed || request !== controller) return;
        content.textContent = translation;
        place();
      },
      context,
    )
      .catch((error: unknown) => {
        if (disposed || request !== controller) return;
        const message = doc.createElement("div");
        const raw = error instanceof Error ? error.message : String(error);
        const paperchat =
          error instanceof SelectionTranslationError && error.paperchat;
        const quota = paperchat ? parsePaperChatQuotaError(raw) : null;
        message.textContent = `⚠️ ${quota?.displayMessage || (paperchat ? getPaperChatErrorDisplayMessage(raw) : raw)}`;
        message.setAttribute("role", "alert");
        message.style.color = dark ? "#fda4af" : "#b42335";
        body.append(message);
        if (quota) body.append(createTopupButton(doc));
        place();
      })
      .finally(() => {
        if (request !== controller) return;
        loading.remove();
        if (!disposed) panel.setAttribute("aria-busy", "false");
      });
  };
  modelSelect.addEventListener("change", () => {
    setPref("translationModel", modelSelect.value);
    translate();
  });
  languageSelect.addEventListener("change", () => {
    setPref("translationLanguage", languageSelect.value);
    translate();
  });
  translate();
  return dispose;
}
