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
const NOTICE_COLLAPSED_HEIGHT_PX = 100;
const NOTICE_EXPANDED_MIN_HEIGHT_PX = 220;
const NOTICE_EXPANDED_BOTTOM_MARGIN_PX = 32;

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
  card: HTMLElement | null;
  viewport: HTMLElement | null;
  body: HTMLElement | null;
  toggle: HTMLButtonElement | null;
  toggleIcon: HTMLImageElement | null;
  debugWrap: HTMLElement | null;
  debugInput: HTMLTextAreaElement | null;
  debugStatus: HTMLElement | null;
} {
  return {
    wrap: doc.getElementById("pref-paperchat-notice-wrap") as HTMLElement | null,
    card: doc.getElementById("pref-paperchat-notice-card") as HTMLElement | null,
    viewport: doc.getElementById(
      "pref-paperchat-notice-viewport",
    ) as HTMLElement | null,
    body: doc.getElementById("pref-paperchat-notice-scroll") as HTMLElement | null,
    toggle: doc.getElementById(
      "pref-paperchat-notice-toggle",
    ) as HTMLButtonElement | null,
    toggleIcon: doc.getElementById(
      "pref-paperchat-notice-toggle-icon",
    ) as HTMLImageElement | null,
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

function getActivePaperChatNotice(): string | null {
  return getPaperChatNoticeDebugOverride() || getCachedPaperChatNotice();
}

function isDarkColorScheme(doc: Document): boolean {
  const mediaQuery = doc.defaultView?.matchMedia?.(
    "(prefers-color-scheme: dark)",
  );
  return !!mediaQuery?.matches;
}

function applyNoticeTheme(doc: Document): void {
  const { card, toggle } = getNoticeElements(doc);
  if (!card || !toggle) {
    return;
  }

  const dark = isDarkColorScheme(doc);

  card.style.background = dark
    ? "color-mix(in srgb, var(--material-sidepane, #1f2937) 94%, #818cf8 6%)"
    : "color-mix(in srgb, var(--material-sidepane, #fff) 92%, #6366f1 8%)";
  card.style.borderColor = dark
    ? "color-mix(in srgb, var(--color-border, #4b5563) 72%, #818cf8 28%)"
    : "color-mix(in srgb, var(--color-border, #ddd) 86%, #6366f1 14%)";

  toggle.style.background = dark
    ? "color-mix(in srgb, var(--material-sidepane, #111827) 86%, #334155 14%)"
    : "color-mix(in srgb, var(--material-sidepane, #fff) 90%, #ffffff 10%)";
  toggle.style.borderColor = dark
    ? "color-mix(in srgb, var(--color-border, #4b5563) 74%, #93c5fd 26%)"
    : "color-mix(in srgb, var(--color-border, #ddd) 88%, #6366f1 12%)";
  toggle.style.boxShadow = dark
    ? "0 6px 18px rgba(2, 6, 23, 0.28)"
    : "0 4px 12px rgba(15, 23, 42, 0.08)";
}

function getNoticeIconUrl(iconFileName: string): string {
  return `chrome://${addon.data.config.addonRef}/content/icons/${iconFileName}`;
}

function isNoticeExpanded(card: HTMLElement | null): boolean {
  return card?.dataset.noticeExpanded === "true";
}

function measureNoticeContentHeight(
  viewport: HTMLElement | null,
  body: HTMLElement,
): number {
  const previousViewportHeight = viewport?.style.height || "";
  const previousBodyHeight = body.style.height;
  const previousOverflowY = body.style.overflowY;

  if (viewport) {
    viewport.style.height = "auto";
  }
  body.style.height = "auto";
  body.style.overflowY = "visible";

  const measuredHeight = Math.max(
    NOTICE_COLLAPSED_HEIGHT_PX,
    Math.ceil(body.scrollHeight),
  );

  if (viewport) {
    viewport.style.height = previousViewportHeight;
  }
  body.style.height = previousBodyHeight;
  body.style.overflowY = previousOverflowY;

  return measuredHeight;
}

function getExpandedNoticeHeight(
  doc: Document,
  viewport: HTMLElement | null,
  body: HTMLElement,
): number {
  const panel = doc.getElementById("pref-panel-paperchat") as HTMLElement | null;
  const win = doc.defaultView;
  const measuredContentHeight = measureNoticeContentHeight(viewport, body) + 44;

  if (!panel || !win) {
    return Math.max(NOTICE_EXPANDED_MIN_HEIGHT_PX, measuredContentHeight);
  }

  const panelRect = panel.getBoundingClientRect();
  const maxHeight = Math.max(
    NOTICE_EXPANDED_MIN_HEIGHT_PX,
    Math.min(
      Math.round(win.innerHeight - panelRect.top - NOTICE_EXPANDED_BOTTOM_MARGIN_PX),
      Math.round(panelRect.height - 48),
    ),
  );

  return Math.min(measuredContentHeight, maxHeight);
}

function applyCollapsedNoticeLayout(
  card: HTMLElement,
  viewport: HTMLElement | null,
  body: HTMLElement,
): void {
  card.style.boxShadow = "";
  card.style.backdropFilter = "";

  if (viewport) {
    viewport.style.height = `${NOTICE_COLLAPSED_HEIGHT_PX}px`;
  }

  body.style.height = "100%";
  body.style.padding = "6px 42px 10px 10px";
}

function applyExpandedNoticeLayout(
  card: HTMLElement,
  viewport: HTMLElement | null,
  body: HTMLElement,
  expandedHeight: number,
): void {
  card.style.boxShadow = "0 10px 26px rgba(15, 23, 42, 0.12)";
  card.style.backdropFilter = "";

  if (viewport) {
    viewport.style.height = `${Math.round(expandedHeight)}px`;
  }

  body.style.height = "100%";
  body.style.padding = "10px 48px 14px 14px";
}

function syncNoticeToggleUI(doc: Document): void {
  const { card, toggle, toggleIcon } = getNoticeElements(doc);
  if (!toggle || !toggleIcon) {
    return;
  }

  const expanded = isNoticeExpanded(card);
  const label = getString(
    (
      expanded
        ? "pref-paperchat-notice-collapse"
        : "pref-paperchat-notice-expand"
    ) as any,
  );

  toggle.title = label;
  toggle.setAttribute("aria-label", label);
  toggleIcon.setAttribute(
    "src",
    getNoticeIconUrl(
      expanded ? "collapse-text-input.svg" : "expand-text-input.svg",
    ),
  );
  toggle.setAttribute("tooltiptext", label);
}

function syncExpandedNoticeLayout(doc: Document): void {
  const { card, viewport, body } = getNoticeElements(doc);
  if (!card || !body || !isNoticeExpanded(card)) {
    return;
  }

  applyExpandedNoticeLayout(
    card,
    viewport,
    body,
    getExpandedNoticeHeight(doc, viewport, body),
  );
}

function setPaperChatNoticeExpanded(
  doc: Document,
  expanded: boolean,
): void {
  const { card, viewport, body } = getNoticeElements(doc);
  if (!card || !body) {
    return;
  }

  const currentlyExpanded = isNoticeExpanded(card);
  if (currentlyExpanded === expanded) {
    if (!expanded) {
      applyCollapsedNoticeLayout(card, viewport, body);
    } else {
      syncExpandedNoticeLayout(doc);
    }
    applyNoticeTheme(doc);
    syncNoticeToggleUI(doc);
    return;
  }

  if (expanded) {
    applyExpandedNoticeLayout(
      card,
      viewport,
      body,
      getExpandedNoticeHeight(doc, viewport, body),
    );
  } else {
    applyCollapsedNoticeLayout(card, viewport, body);
  }

  card.dataset.noticeExpanded = expanded ? "true" : "false";
  applyNoticeTheme(doc);
  syncNoticeToggleUI(doc);
}

export function bindPaperChatNoticeEvents(doc: Document): void {
  const { toggle } = getNoticeElements(doc);
  if (!toggle || toggle.dataset.bound === "true") {
    syncNoticeToggleUI(doc);
    return;
  }

  toggle.dataset.bound = "true";
  let lastToggleTimestamp = 0;
  const handleToggle = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();

    const now = Date.now();
    if (now - lastToggleTimestamp < 80) {
      return;
    }
    lastToggleTimestamp = now;

    const { card } = getNoticeElements(doc);
    setPaperChatNoticeExpanded(doc, !isNoticeExpanded(card));
  };
  toggle.addEventListener("command", handleToggle);
  toggle.addEventListener("click", handleToggle);

  const win = doc.defaultView as (Window & {
    __paperchatNoticeResizeHandler?: () => void;
    __paperchatNoticeThemeMediaQuery?: MediaQueryList;
    __paperchatNoticeThemeHandler?: () => void;
    __paperchatNoticeCleanupRegistered?: boolean;
    __paperchatPrefsCleanup?: Array<() => void>;
  }) | null;
  if (!win) {
    applyNoticeTheme(doc);
    syncNoticeToggleUI(doc);
    return;
  }

  if (win.__paperchatNoticeResizeHandler) {
    win.removeEventListener("resize", win.__paperchatNoticeResizeHandler);
  }
  if (win.__paperchatNoticeThemeMediaQuery && win.__paperchatNoticeThemeHandler) {
    win.__paperchatNoticeThemeMediaQuery.removeEventListener(
      "change",
      win.__paperchatNoticeThemeHandler,
    );
  }

  const resizeHandler = () => {
    applyNoticeTheme(doc);
    syncExpandedNoticeLayout(doc);
  };
  win.__paperchatNoticeResizeHandler = resizeHandler;
  win.addEventListener("resize", resizeHandler);

  const mediaQuery = win.matchMedia?.("(prefers-color-scheme: dark)");
  const themeHandler = () => {
    applyNoticeTheme(doc);
  };
  mediaQuery?.addEventListener?.("change", themeHandler);
  if (mediaQuery) {
    win.__paperchatNoticeThemeMediaQuery = mediaQuery;
  } else {
    delete win.__paperchatNoticeThemeMediaQuery;
  }
  win.__paperchatNoticeThemeHandler = themeHandler;

  if (!win.__paperchatNoticeCleanupRegistered) {
    win.__paperchatNoticeCleanupRegistered = true;
    if (!win.__paperchatPrefsCleanup) {
      win.__paperchatPrefsCleanup = [];
    }
    win.__paperchatPrefsCleanup.push(() => {
      if (win.__paperchatNoticeResizeHandler) {
        win.removeEventListener("resize", win.__paperchatNoticeResizeHandler);
        delete win.__paperchatNoticeResizeHandler;
      }
      if (win.__paperchatNoticeThemeMediaQuery && win.__paperchatNoticeThemeHandler) {
        win.__paperchatNoticeThemeMediaQuery.removeEventListener(
          "change",
          win.__paperchatNoticeThemeHandler,
        );
      }
      delete win.__paperchatNoticeThemeMediaQuery;
      delete win.__paperchatNoticeThemeHandler;
      delete win.__paperchatNoticeCleanupRegistered;
    });
  }

  applyNoticeTheme(doc);
  syncNoticeToggleUI(doc);
}

export function collapsePaperChatNotice(doc: Document): void {
  setPaperChatNoticeExpanded(doc, false);
}

export function togglePaperChatNotice(doc: Document): void {
  const { card } = getNoticeElements(doc);
  setPaperChatNoticeExpanded(doc, !isNoticeExpanded(card));
}

export function renderPaperChatNotice(doc: Document): void {
  const { wrap, body, toggle } = getNoticeElements(doc);
  if (!wrap || !body || !toggle) {
    return;
  }

  const notice = getActivePaperChatNotice();
  if (!notice) {
    collapsePaperChatNotice(doc);
    toggle.hidden = true;
    wrap.removeAttribute("open");
    clearElement(body);
    return;
  }

  toggle.hidden = false;
  applyNoticeTheme(doc);
  wrap.setAttribute("open", "true");
  if (looksLikeHtml(notice)) {
    renderSanitizedHtmlToElement(body, notice);
    normalizeNoticeContentSpacing(body);
    syncExpandedNoticeLayout(doc);
    syncNoticeToggleUI(doc);
    return;
  }

  renderMarkdownToElement(body, notice);
  normalizeNoticeContentSpacing(body);
  syncExpandedNoticeLayout(doc);
  syncNoticeToggleUI(doc);
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
