import { clearElement } from "./utils";
import {
  getCachedPaperChatNotice,
  getPaperChatNoticeDebugOverride,
  hasPaperChatNoticeDebugOverrideEnabled,
  refreshPaperChatNotice,
} from "../providers/PaperChatNoticeService";
import { renderMarkdownToElement } from "../ui/chat-panel/MarkdownRenderer";
import { getString } from "../../utils/locale";

const HTML_NS = "http://www.w3.org/1999/xhtml";

const ALLOWED_HTML_TAGS = new Set([
  "a",
  "article",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

function isNonNullNode(node: Node | null): node is Node {
  return node !== null;
}

function getNoticeElements(doc: Document): {
  wrap: HTMLElement | null;
  body: HTMLElement | null;
  debugWrap: HTMLElement | null;
  debugInput: HTMLTextAreaElement | null;
  debugStatus: HTMLElement | null;
} {
  return {
    wrap: doc.getElementById("pref-paperchat-notice-wrap") as HTMLElement | null,
    body: doc.getElementById("pref-paperchat-notice-scroll") as HTMLElement | null,
    debugWrap: doc.getElementById(
      "pref-paperchat-notice-debug-wrap",
    ) as HTMLElement | null,
    debugInput: doc.getElementById(
      "pref-paperchat-notice-debug-input",
    ) as HTMLTextAreaElement | null,
    debugStatus: doc.getElementById(
      "pref-paperchat-notice-debug-status",
    ) as HTMLElement | null,
  };
}

function looksLikeHtml(content: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(content);
}

function sanitizeStyle(styleText: string): string {
  return styleText
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const lower = declaration.toLowerCase();
      return !(
        lower.includes("expression(") ||
        lower.includes("javascript:") ||
        lower.includes("@import") ||
        lower.includes("-moz-binding") ||
        lower.includes("url(")
      );
    })
    .join("; ");
}

function sanitizeUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl, "https://paperchat.zotero.store");
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // Ignore invalid links.
  }
  return null;
}

function cloneSanitizedNode(
  doc: Document,
  node: Node,
): Node | DocumentFragment | null {
  if (node.nodeType === node.TEXT_NODE) {
    return doc.createTextNode(node.textContent || "");
  }

  if (node.nodeType !== node.ELEMENT_NODE) {
    return null;
  }

  const sourceElement = node as HTMLElement;
  const tagName = sourceElement.tagName.toLowerCase();
  const childNodes = Array.from(sourceElement.childNodes).filter(isNonNullNode);

  if (!ALLOWED_HTML_TAGS.has(tagName)) {
    const fragment = doc.createDocumentFragment();
    for (const child of childNodes) {
      const sanitizedChild = cloneSanitizedNode(doc, child);
      if (sanitizedChild) {
        fragment.appendChild(sanitizedChild);
      }
    }
    return fragment;
  }

  const targetElement = doc.createElementNS(HTML_NS, tagName) as HTMLElement;

  for (const attr of Array.from(sourceElement.attributes)) {
    const attrName = attr.name.toLowerCase();
    const attrValue = attr.value;

    if (attrName.startsWith("on")) {
      continue;
    }

    if (attrName === "style") {
      const safeStyle = sanitizeStyle(attrValue);
      if (safeStyle) {
        targetElement.setAttribute("style", safeStyle);
      }
      continue;
    }

    if (tagName === "a" && attrName === "href") {
      const safeHref = sanitizeUrl(attrValue);
      if (safeHref) {
        targetElement.setAttribute("href", safeHref);
        targetElement.style.cursor = "pointer";
        targetElement.addEventListener("click", (event) => {
          event.preventDefault();
          Zotero.launchURL(safeHref);
        });
      }
      continue;
    }

    if (
      attrName === "title" ||
      attrName === "colspan" ||
      attrName === "rowspan" ||
      attrName === "target" ||
      attrName === "rel" ||
      attrName.startsWith("aria-") ||
      attrName === "role"
    ) {
      targetElement.setAttribute(attr.name, attrValue);
    }
  }

  for (const child of childNodes) {
    const sanitizedChild = cloneSanitizedNode(doc, child);
    if (sanitizedChild) {
      targetElement.appendChild(sanitizedChild);
    }
  }

  return targetElement;
}

function renderSanitizedHtmlToElement(element: HTMLElement, htmlContent: string): void {
  clearElement(element);
  const doc = element.ownerDocument;
  if (!doc) {
    return;
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(htmlContent, "text/html");
  const sourceRoot = parsed.body;

  for (const child of Array.from(sourceRoot.childNodes).filter(isNonNullNode)) {
    const sanitized = cloneSanitizedNode(doc, child);
    if (sanitized) {
      element.appendChild(sanitized);
    }
  }
}

function normalizeNoticeContentSpacing(element: HTMLElement): void {
  const firstElement = element.firstElementChild as HTMLElement | null;
  if (firstElement) {
    firstElement.style.marginTop = "0";
  }

  const lastElement = element.lastElementChild as HTMLElement | null;
  if (lastElement) {
    lastElement.style.marginBottom = "0";
  }
}

export function renderPaperChatNotice(doc: Document): void {
  const { wrap, body } = getNoticeElements(doc);
  if (!wrap || !body) {
    return;
  }

  const notice = getCachedPaperChatNotice();
  if (!notice) {
    wrap.removeAttribute("open");
    clearElement(body);
    return;
  }

  wrap.setAttribute("open", "true");
  if (looksLikeHtml(notice)) {
    renderSanitizedHtmlToElement(body, notice);
    normalizeNoticeContentSpacing(body);
    return;
  }

  renderMarkdownToElement(body, notice);
  normalizeNoticeContentSpacing(body);
}

export async function refreshPaperChatNoticeUI(doc: Document): Promise<void> {
  await refreshPaperChatNotice();
  renderPaperChatNotice(doc);
  syncPaperChatNoticeDebugUI(doc);
}

export function syncPaperChatNoticeDebugUI(doc: Document): void {
  const { debugWrap, debugInput, debugStatus } = getNoticeElements(doc);
  const isProduction = typeof __env__ !== "undefined" && __env__ === "production";

  if (debugWrap) {
    debugWrap.hidden = isProduction;
  }

  if (isProduction) {
    return;
  }

  if (debugInput) {
    debugInput.value = getPaperChatNoticeDebugOverride() || "";
  }

  if (!debugStatus) {
    return;
  }

  if (hasPaperChatNoticeDebugOverrideEnabled()) {
    debugStatus.textContent = getString("pref-paperchat-notice-debug-active");
    debugStatus.hidden = false;
    return;
  }

  debugStatus.textContent = "";
  debugStatus.hidden = true;
}
