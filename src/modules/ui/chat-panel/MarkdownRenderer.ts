/**
 * MarkdownRenderer - Convert markdown to DOM elements (XHTML-safe)
 */

import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import katex from "katex";
import { chatColors } from "../../../utils/colors";
import { HTML_NS } from "./types";
import { isDarkMode } from "./ChatPanelTheme";

// Initialize markdown-it with XHTML output
const md = new MarkdownIt({
  html: true,
  breaks: true,
  xhtmlOut: true,
  typographer: true,
  linkify: true,
});

/**
 * Markdown-it plugin for math expressions ($...$ and $$...$$)
 */
function mathPlugin(mdInstance: MarkdownIt) {
  // Inline math: $...$ and $$...$$
  mdInstance.inline.ruler.after("escape", "math_inline", (state, silent) => {
    const src = state.src;
    const pos = state.pos;

    if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;

    // Determine delimiter: $$ or $
    const isDouble = pos + 1 < state.posMax && src.charCodeAt(pos + 1) === 0x24;
    const delimLen = isDouble ? 2 : 1;

    // Find closing delimiter
    let end = pos + delimLen;
    while (end <= state.posMax - delimLen) {
      if (src.charCodeAt(end) === 0x24) {
        // Count preceding backslashes for escape detection:
        // odd = escaped $, even = real closing $
        let backslashCount = 0;
        let bsPos = end - 1;
        while (bsPos >= pos + delimLen && src.charCodeAt(bsPos) === 0x5c) {
          backslashCount++;
          bsPos--;
        }
        if (backslashCount % 2 !== 0) {
          end++;
          continue;
        }

        if (isDouble) {
          // Need two consecutive $ for closing $$
          if (end + 1 < state.posMax && src.charCodeAt(end + 1) === 0x24) {
            break;
          }
          // Single $ inside $$...$$ content, skip
          end++;
          continue;
        } else {
          break;
        }
      }
      end++;
    }

    // Verify closing delimiter was found
    if (isDouble) {
      if (end > state.posMax - delimLen || src.charCodeAt(end + 1) !== 0x24) {
        return false;
      }
    } else {
      if (end >= state.posMax) return false;
    }

    const content = src.slice(pos + delimLen, end);
    if (!content.trim()) return false;

    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = content;
      token.markup = isDouble ? "$$" : "$";
    }

    state.pos = end + delimLen;
    return true;
  });

  // Block math: $$...$$
  mdInstance.block.ruler.after(
    "blockquote",
    "math_block",
    (state, startLine, endLine, silent) => {
      const startPos = state.bMarks[startLine] + state.tShift[startLine];
      const maxPos = state.eMarks[startLine];

      if (startPos + 2 > maxPos) return false;
      if (
        state.src.charCodeAt(startPos) !== 0x24 ||
        state.src.charCodeAt(startPos + 1) !== 0x24
      ) {
        return false;
      }

      const afterOpening = state.src.slice(startPos + 2, maxPos).trim();

      // Single-line: $$...$$ on same line
      if (afterOpening.endsWith("$$") && afterOpening.length > 2) {
        if (silent) return true;
        const token = state.push("math_block", "math", 0);
        token.content = afterOpening.slice(0, -2).trim();
        token.markup = "$$";
        token.map = [startLine, startLine + 1];
        state.line = startLine + 1;
        return true;
      }

      // Multi-line: find closing $$
      let nextLine = startLine + 1;
      let found = false;
      while (nextLine < endLine) {
        const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const lineEnd = state.eMarks[nextLine];
        const line = state.src.slice(lineStart, lineEnd).trim();
        if (line === "$$") {
          found = true;
          break;
        }
        nextLine++;
      }

      if (!found) return false;
      if (silent) return true;

      let content = afterOpening ? afterOpening + "\n" : "";
      for (let i = startLine + 1; i < nextLine; i++) {
        const lineStart = state.bMarks[i] + state.tShift[i];
        const lineEnd = state.eMarks[i];
        content += state.src.slice(lineStart, lineEnd) + "\n";
      }

      const token = state.push("math_block", "math", 0);
      token.content = content.trim();
      token.markup = "$$";
      token.map = [startLine, nextLine + 1];
      state.line = nextLine + 1;
      return true;
    },
  );
}

md.use(mathPlugin);

/**
 * Tool call card styles
 */
const toolCallStyles = {
  light: {
    cardBg: "#f6f8fa",
    cardBorder: "#d0d7de",
    nameBg: "#eef1f4",
    nameText: "#24292f",
    argsText: "#57606a",
    statusCalling: "#bf8700",
    statusDone: "#1a7f37",
    statusError: "#cf222e",
    resultBg: "#ffffff",
    resultText: "#57606a",
  },
  dark: {
    cardBg: "#161b22",
    cardBorder: "#30363d",
    nameBg: "#21262d",
    nameText: "#c9d1d9",
    argsText: "#8b949e",
    statusCalling: "#d29922",
    statusDone: "#3fb950",
    statusError: "#f85149",
    resultBg: "#0d1117",
    resultText: "#8b949e",
  },
};

type SourceGroupType =
  | "paper"
  | "note"
  | "annotation"
  | "web"
  | "library"
  | "memory";

type SourceGroupFragment =
  | {
      kind: "markdown";
      content: string;
    }
  | {
      kind: "source-group";
      label: string;
      type: string;
      content: string;
    };

const sourceGroupStyles = {
  light: {
    cardBg: "#ffffff",
    cardBorder: "#d0d7de",
    headerBg: "#f6f8fa",
    labelText: "#24292f",
    bodyText: "#334155",
  },
  dark: {
    cardBg: "#161b22",
    cardBorder: "#30363d",
    headerBg: "#21262d",
    labelText: "#e6edf3",
    bodyText: "#c9d1d9",
  },
};

/**
 * Unescape XML entities back to original characters
 * This reverses the escaping done in ChatManager.formatToolCallCard
 */
function unescapeXml(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function renderMarkdownFragment(
  doc: Document,
  parent: HTMLElement,
  content: string,
): void {
  const normalized = content.trim();
  if (!normalized) return;

  const tokens = md.parse(preprocessMathDelimiters(normalized), {});
  const builtContent = buildDOMFromTokens(doc, tokens);
  while (builtContent.firstChild) {
    parent.appendChild(builtContent.firstChild);
  }
}

function getTagAttribute(attrs: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attrRegex = new RegExp(
    `(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
  );
  const match = attrs.match(attrRegex);
  if (!match) {
    return undefined;
  }
  return unescapeXml(match[1] || match[2] || "");
}

export function extractSourceGroupFragments(
  content: string,
): SourceGroupFragment[] {
  const sourceGroupRegex = /<source-group\b([^>]*)>([\s\S]*?)<\/source-group>/g;
  const fragments: SourceGroupFragment[] = [];

  let cursor = 0;
  let hasSourceGroup = false;
  let match: RegExpExecArray | null;

  const pushMarkdownFragment = (fragmentContent: string): void => {
    if (!fragmentContent.trim()) {
      return;
    }
    fragments.push({
      kind: "markdown",
      content: fragmentContent,
    });
  };

  while ((match = sourceGroupRegex.exec(content)) !== null) {
    const attrs = match[1] || "";
    const label = getTagAttribute(attrs, "label");
    const type = getTagAttribute(attrs, "type") || "paper";

    if (!label) {
      continue;
    }

    if (match.index > cursor) {
      pushMarkdownFragment(content.slice(cursor, match.index));
    }

    fragments.push({
      kind: "source-group",
      label,
      type,
      content: match[2] || "",
    });

    hasSourceGroup = true;
    cursor = match.index + match[0].length;
  }

  if (!hasSourceGroup) {
    return [{ kind: "markdown", content }];
  }

  if (cursor < content.length) {
    pushMarkdownFragment(content.slice(cursor));
  }

  return fragments;
}

function getSourceGroupPalette(
  type: string,
  dark: boolean,
): { badgeBg: string; badgeText: string; accent: string } {
  const normalizedType = type.toLowerCase() as SourceGroupType;
  switch (normalizedType) {
    case "paper":
      return dark
        ? { badgeBg: "#1f6feb33", badgeText: "#79c0ff", accent: "#1f6feb" }
        : { badgeBg: "#dbeafe", badgeText: "#1d4ed8", accent: "#60a5fa" };
    case "note":
      return dark
        ? { badgeBg: "#9a670033", badgeText: "#e3b341", accent: "#d29922" }
        : { badgeBg: "#fef3c7", badgeText: "#b45309", accent: "#f59e0b" };
    case "annotation":
      return dark
        ? { badgeBg: "#bc4c0033", badgeText: "#ffb77c", accent: "#fb8500" }
        : { badgeBg: "#ffedd5", badgeText: "#c2410c", accent: "#f97316" };
    case "web":
      return dark
        ? { badgeBg: "#0f766e33", badgeText: "#5eead4", accent: "#14b8a6" }
        : { badgeBg: "#ccfbf1", badgeText: "#0f766e", accent: "#2dd4bf" };
    case "memory":
      return dark
        ? { badgeBg: "#16653433", badgeText: "#86efac", accent: "#22c55e" }
        : { badgeBg: "#dcfce7", badgeText: "#15803d", accent: "#4ade80" };
    case "library":
    default:
      return dark
        ? { badgeBg: "#6e768133", badgeText: "#c9d1d9", accent: "#8b949e" }
        : { badgeBg: "#e5e7eb", badgeText: "#475569", accent: "#94a3b8" };
  }
}

function formatSourceGroupType(type: string): string {
  const normalized = type.trim().toLowerCase();
  if (!normalized) {
    return "Source";
  }
  return normalized
    .split(/[_\s-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function renderSourceGroupCard(
  doc: Document,
  parent: HTMLElement,
  group: Extract<SourceGroupFragment, { kind: "source-group" }>,
): void {
  const dark = isDarkMode();
  const colors = dark ? sourceGroupStyles.dark : sourceGroupStyles.light;
  const palette = getSourceGroupPalette(group.type, dark);

  const card = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  card.style.margin = "10px 0";
  card.style.border = `1px solid ${colors.cardBorder}`;
  card.style.borderLeft = `3px solid ${palette.accent}`;
  card.style.borderRadius = "10px";
  card.style.background = colors.cardBg;
  card.style.overflow = "hidden";

  const header = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "8px";
  header.style.padding = "8px 10px";
  header.style.background = colors.headerBg;
  header.style.borderBottom = `1px solid ${colors.cardBorder}`;

  const badge = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  badge.style.display = "inline-flex";
  badge.style.alignItems = "center";
  badge.style.padding = "2px 8px";
  badge.style.borderRadius = "999px";
  badge.style.fontSize = "11px";
  badge.style.fontWeight = "600";
  badge.style.background = palette.badgeBg;
  badge.style.color = palette.badgeText;
  badge.textContent = formatSourceGroupType(group.type);
  header.appendChild(badge);

  const label = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  label.style.fontSize = "13px";
  label.style.fontWeight = "600";
  label.style.color = colors.labelText;
  label.style.flex = "1";
  label.textContent = group.label;
  header.appendChild(label);

  card.appendChild(header);

  const body = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  body.style.padding = "10px 12px";
  body.style.color = colors.bodyText;
  renderMarkdownFragment(doc, body, group.content);
  card.appendChild(body);

  parent.appendChild(card);
}

function renderSourceGroupBlocks(
  doc: Document,
  parent: HTMLElement,
  content: string,
): boolean {
  const fragments = extractSourceGroupFragments(content);
  const hasSourceGroups = fragments.some(
    (fragment) => fragment.kind === "source-group",
  );

  if (!hasSourceGroups) {
    return false;
  }

  for (const fragment of fragments) {
    if (fragment.kind === "markdown") {
      renderMarkdownFragment(doc, parent, fragment.content);
      continue;
    }

    renderSourceGroupCard(doc, parent, fragment);
  }

  return true;
}

/**
 * Parse and render tool call cards from special markup
 * Format: <tool-call status="calling|completed|error">...</tool-call>
 * Features: Collapsible cards with expand/collapse toggle
 */
function renderToolCallCards(
  doc: Document,
  parent: HTMLElement,
  content: string,
): string {
  const dark = isDarkMode();
  const colors = dark ? toolCallStyles.dark : toolCallStyles.light;

  // Regex to match tool-call blocks
  const toolCallRegex =
    /<tool-call status="(calling|completed|error)">\s*<tool-name>([^<]*)<\/tool-name>\s*(?:<tool-args>([^<]*)<\/tool-args>\s*)?<tool-status>([^<]*)<\/tool-status>\s*(?:<tool-result>([^<]*)<\/tool-result>\s*)?<\/tool-call>/g;

  let lastIndex = 0;
  let match;
  let remainingContent = "";
  let hasToolCards = false;

  while ((match = toolCallRegex.exec(content)) !== null) {
    hasToolCards = true;

    // Add text before this match as remaining content to render as markdown
    if (match.index > lastIndex) {
      renderMarkdownFragment(
        doc,
        parent,
        content.slice(lastIndex, match.index),
      );
    }

    const [, status, toolName, toolArgs, statusText, toolResult] = match;
    const hasDetails = toolArgs || toolResult;
    const isCompleted = status === "completed";

    // Create tool call card
    const card = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    card.style.margin = "8px 0";
    card.style.border = `1px solid ${colors.cardBorder}`;
    card.style.borderRadius = "8px";
    card.style.background = colors.cardBg;
    card.style.overflow = "hidden";
    card.style.fontFamily =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
    card.style.fontSize = "12px";

    // Header row (clickable for expand/collapse)
    const header = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.padding = "8px 12px";
    header.style.background = colors.nameBg;
    header.style.gap = "8px";
    if (hasDetails && isCompleted) {
      header.style.cursor = "pointer";
      header.style.userSelect = "none";
    }

    // Expand/collapse chevron (only for completed cards with details)
    let chevron: HTMLElement | null = null;
    if (hasDetails && isCompleted) {
      chevron = doc.createElementNS(HTML_NS, "span") as HTMLElement;
      chevron.style.fontSize = "10px";
      chevron.style.color = colors.argsText;
      chevron.style.transition = "transform 0.2s";
      chevron.style.display = "inline-block";
      chevron.textContent = "▶"; // Collapsed state
      header.appendChild(chevron);
    }

    // Tool name (unescape XML entities)
    const nameEl = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    nameEl.style.fontWeight = "600";
    nameEl.style.color = colors.nameText;
    nameEl.style.flex = "1";
    nameEl.textContent = unescapeXml(toolName || "");
    header.appendChild(nameEl);

    // Status badge
    const statusEl = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    const statusColor =
      status === "calling"
        ? colors.statusCalling
        : status === "completed"
          ? colors.statusDone
          : colors.statusError;
    statusEl.style.fontSize = "11px";
    statusEl.style.color = statusColor;
    statusEl.style.fontWeight = "500";
    statusEl.textContent = statusText || "";
    header.appendChild(statusEl);

    card.appendChild(header);

    // Details container (collapsible)
    let detailsContainer: HTMLElement | null = null;
    if (hasDetails) {
      detailsContainer = doc.createElementNS(HTML_NS, "div") as HTMLElement;
      detailsContainer.style.borderTop = `1px solid ${colors.cardBorder}`;
      // Default: collapsed for completed, expanded for calling
      detailsContainer.style.display = isCompleted ? "none" : "block";
      detailsContainer.style.overflow = "hidden";

      // Args row (if present, unescape XML entities)
      if (toolArgs) {
        const argsEl = doc.createElementNS(HTML_NS, "div") as HTMLElement;
        argsEl.style.padding = "6px 12px";
        argsEl.style.color = colors.argsText;
        argsEl.style.fontFamily = '"SF Mono", Monaco, Consolas, monospace';
        argsEl.style.fontSize = "11px";
        argsEl.style.borderBottom = toolResult
          ? `1px solid ${colors.cardBorder}`
          : "none";
        argsEl.style.wordBreak = "break-all";
        argsEl.textContent = unescapeXml(toolArgs);
        detailsContainer.appendChild(argsEl);
      }

      // Result row (if present and completed, unescape XML entities)
      if (toolResult && isCompleted) {
        const resultEl = doc.createElementNS(HTML_NS, "div") as HTMLElement;
        resultEl.style.padding = "6px 12px";
        resultEl.style.color = colors.resultText;
        resultEl.style.fontSize = "11px";
        resultEl.style.background = colors.resultBg;
        resultEl.style.whiteSpace = "pre-wrap";
        resultEl.style.wordBreak = "break-word";
        resultEl.style.maxHeight = "150px";
        resultEl.style.overflow = "auto";
        resultEl.textContent = unescapeXml(toolResult);
        detailsContainer.appendChild(resultEl);
      }

      card.appendChild(detailsContainer);
    }

    // Add click handler for expand/collapse (only for completed cards)
    if (hasDetails && isCompleted && chevron && detailsContainer) {
      let isExpanded = false;
      const details = detailsContainer; // Capture for closure
      const chev = chevron;

      header.addEventListener("click", () => {
        isExpanded = !isExpanded;
        details.style.display = isExpanded ? "block" : "none";
        chev.style.transform = isExpanded ? "rotate(90deg)" : "rotate(0deg)";
      });

      // Hover effect
      header.addEventListener("mouseenter", () => {
        header.style.background = dark ? "#2d333b" : "#e6eaef";
      });
      header.addEventListener("mouseleave", () => {
        header.style.background = colors.nameBg;
      });
    }

    parent.appendChild(card);
    lastIndex = match.index + match[0].length;
  }

  // Return remaining content after last tool card
  if (hasToolCards) {
    remainingContent = content.slice(lastIndex).trim();
    return remainingContent;
  }

  // No tool cards found, return original content
  return content;
}

/**
 * Preprocess math delimiters: convert \(...\) and \[...\] to $...$ and $$...$$
 */
function preprocessMathDelimiters(content: string): string {
  const preserved: string[] = [];
  let processed = content;

  // Protect fenced code blocks
  processed = processed.replace(/```[\s\S]*?```/g, (match) => {
    preserved.push(match);
    return `\x00PRESERVE_${preserved.length - 1}\x00`;
  });
  // Protect inline code
  processed = processed.replace(/`[^`]+`/g, (match) => {
    preserved.push(match);
    return `\x00PRESERVE_${preserved.length - 1}\x00`;
  });

  // Convert \[...\] to $$...$$ (block math)
  processed = processed.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_, math) => `$$${math}$$`,
  );
  // Convert \(...\) to $...$ (inline math)
  processed = processed.replace(/\\\((.*?)\\\)/g, (_, math) => `$${math}$`);

  // Restore preserved blocks
  processed = processed.replace(
    /\x00PRESERVE_(\d+)\x00/g,
    (_, idx) => preserved[parseInt(idx)],
  );

  return processed;
}

/**
 * Render math expression to DOM element using KaTeX with MathML output
 * MathML is natively supported by Firefox/Zotero, so no CSS needed
 */
function renderMathToElement(
  doc: Document,
  parent: HTMLElement,
  content: string,
  displayMode: boolean,
): void {
  try {
    const html = katex.renderToString(content, {
      displayMode,
      output: "mathml",
      throwOnError: false,
      strict: false,
    });

    // Parse KaTeX output into XHTML-compatible DOM nodes
    const parser = new DOMParser();
    const wrapper = `<span xmlns="${HTML_NS}">${html}</span>`;
    const mathDoc = parser.parseFromString(wrapper, "application/xhtml+xml");

    if (mathDoc.querySelector("parsererror")) {
      renderMathFallback(doc, parent, content, displayMode);
      return;
    }

    const sourceNode = mathDoc.documentElement;
    const children = Array.from(sourceNode.childNodes);
    for (const child of children) {
      if (child) {
        parent.appendChild(doc.importNode(child, true));
      }
    }
  } catch {
    renderMathFallback(doc, parent, content, displayMode);
  }
}

/**
 * Fallback: show raw LaTeX in styled code element
 */
function renderMathFallback(
  doc: Document,
  parent: HTMLElement,
  content: string,
  displayMode: boolean,
): void {
  const code = doc.createElementNS(HTML_NS, "code") as HTMLElement;
  const dark = isDarkMode();
  code.style.background = dark ? "#343942" : "#f0f0f0";
  code.style.color = dark ? "#e6e6e6" : "#24292e";
  code.style.padding = "2px 6px";
  code.style.borderRadius = "3px";
  code.style.fontFamily = "monospace";
  code.style.fontSize = "0.9em";
  code.textContent = displayMode ? `$$${content}$$` : `$${content}$`;
  parent.appendChild(code);
}

/**
 * Render markdown content to DOM elements directly
 * This avoids XHTML parsing issues by building elements programmatically
 */
export function renderMarkdownToElement(
  element: HTMLElement,
  markdownContent: string,
): void {
  element.textContent = "";
  const doc = element.ownerDocument;
  if (!doc) return;

  // First, check for and render tool call cards
  const remainingContent = renderToolCallCards(doc, element, markdownContent);

  if (!remainingContent) {
    return;
  }

  if (renderSourceGroupBlocks(doc, element, remainingContent)) {
    return;
  }

  renderMarkdownFragment(doc, element, remainingContent);
}

/**
 * Build DOM elements from markdown-it tokens
 */
export function buildDOMFromTokens(
  doc: Document,
  tokens: ReturnType<typeof md.parse>,
): HTMLElement {
  const container = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  const stack: HTMLElement[] = [container];

  for (const token of tokens) {
    const parent = stack[stack.length - 1];

    switch (token.type) {
      case "paragraph_open": {
        const p = doc.createElementNS(HTML_NS, "p") as HTMLElement;
        parent.appendChild(p);
        stack.push(p);
        break;
      }
      case "paragraph_close":
        stack.pop();
        break;

      case "heading_open": {
        const h = doc.createElementNS(HTML_NS, token.tag) as HTMLElement;
        parent.appendChild(h);
        stack.push(h);
        break;
      }
      case "heading_close":
        stack.pop();
        break;

      case "bullet_list_open": {
        const ul = doc.createElementNS(HTML_NS, "ul") as HTMLElement;
        parent.appendChild(ul);
        stack.push(ul);
        break;
      }
      case "bullet_list_close":
        stack.pop();
        break;

      case "ordered_list_open": {
        const ol = doc.createElementNS(HTML_NS, "ol") as HTMLElement;
        parent.appendChild(ol);
        stack.push(ol);
        break;
      }
      case "ordered_list_close":
        stack.pop();
        break;

      case "list_item_open": {
        const li = doc.createElementNS(HTML_NS, "li") as HTMLElement;
        parent.appendChild(li);
        stack.push(li);
        break;
      }
      case "list_item_close":
        stack.pop();
        break;

      case "blockquote_open": {
        const bq = doc.createElementNS(HTML_NS, "blockquote") as HTMLElement;
        const darkBq = isDarkMode();
        bq.style.borderLeft = `3px solid ${darkBq ? "#444" : chatColors.blockquoteBorder}`;
        bq.style.paddingLeft = "10px";
        bq.style.margin = "10px 0";
        bq.style.color = darkBq ? "#a0a0a0" : chatColors.blockquoteText;
        parent.appendChild(bq);
        stack.push(bq);
        break;
      }
      case "blockquote_close":
        stack.pop();
        break;

      case "code_block":
      case "fence": {
        const pre = doc.createElementNS(HTML_NS, "pre") as HTMLElement;
        const code = doc.createElementNS(HTML_NS, "code") as HTMLElement;

        // Get language from fence info (e.g., ```javascript)
        const lang = token.info?.trim() || "";

        // Apply dark/light theme styles
        const dark = isDarkMode();
        pre.style.background = dark ? "#1e1e1e" : "#f6f8fa";
        pre.style.color = dark ? "#d4d4d4" : "#24292e";
        pre.style.padding = "12px";
        pre.style.borderRadius = "6px";
        pre.style.overflow = "auto";
        pre.style.fontSize = "13px";
        pre.style.fontFamily =
          "'SF Mono', Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
        pre.style.lineHeight = "1.45";
        pre.style.margin = "8px 0";

        // Try to highlight with language detection
        try {
          let highlighted: string;
          if (lang && hljs.getLanguage(lang)) {
            highlighted = hljs.highlight(token.content, {
              language: lang,
            }).value;
          } else {
            highlighted = hljs.highlightAuto(token.content).value;
          }
          // Safely convert highlight.js HTML to DOM elements
          renderHighlightedCode(doc, code, highlighted, dark);
        } catch {
          // Fallback to plain text if highlighting fails
          code.textContent = token.content;
        }

        pre.appendChild(code);
        parent.appendChild(pre);
        break;
      }

      case "hr": {
        const hr = doc.createElementNS(HTML_NS, "hr") as HTMLElement;
        const darkHr = isDarkMode();
        hr.style.border = "none";
        hr.style.borderTop = `1px solid ${darkHr ? "#444" : chatColors.hrBorder}`;
        hr.style.margin = "15px 0";
        parent.appendChild(hr);
        break;
      }

      case "table_open": {
        const table = doc.createElementNS(HTML_NS, "table") as HTMLElement;
        table.style.borderCollapse = "collapse";
        table.style.width = "100%";
        table.style.margin = "10px 0";
        table.style.fontSize = "12px";
        parent.appendChild(table);
        stack.push(table);
        break;
      }
      case "table_close":
        stack.pop();
        break;

      case "thead_open": {
        const thead = doc.createElementNS(HTML_NS, "thead") as HTMLElement;
        parent.appendChild(thead);
        stack.push(thead);
        break;
      }
      case "thead_close":
        stack.pop();
        break;

      case "tbody_open": {
        const tbody = doc.createElementNS(HTML_NS, "tbody") as HTMLElement;
        parent.appendChild(tbody);
        stack.push(tbody);
        break;
      }
      case "tbody_close":
        stack.pop();
        break;

      case "tr_open": {
        const tr = doc.createElementNS(HTML_NS, "tr") as HTMLElement;
        parent.appendChild(tr);
        stack.push(tr);
        break;
      }
      case "tr_close":
        stack.pop();
        break;

      case "th_open": {
        const th = doc.createElementNS(HTML_NS, "th") as HTMLElement;
        const darkTh = isDarkMode();
        th.style.border = `1px solid ${darkTh ? "#444" : chatColors.tableBorder}`;
        th.style.padding = "8px";
        th.style.background = darkTh ? "#2d2d2d" : chatColors.tableBg;
        th.style.fontWeight = "bold";
        th.style.textAlign = "left";
        parent.appendChild(th);
        stack.push(th);
        break;
      }
      case "th_close":
        stack.pop();
        break;

      case "td_open": {
        const td = doc.createElementNS(HTML_NS, "td") as HTMLElement;
        const darkTd = isDarkMode();
        td.style.border = `1px solid ${darkTd ? "#444" : chatColors.tableBorder}`;
        td.style.padding = "8px";
        parent.appendChild(td);
        stack.push(td);
        break;
      }
      case "td_close":
        stack.pop();
        break;

      case "inline":
        if (token.children) {
          renderInlineTokens(doc, parent, token.children);
        }
        break;

      case "softbreak":
        parent.appendChild(doc.createTextNode(" "));
        break;

      case "hardbreak":
        parent.appendChild(doc.createElementNS(HTML_NS, "br"));
        break;

      case "math_block": {
        const mathDiv = doc.createElementNS(HTML_NS, "div") as HTMLElement;
        mathDiv.style.textAlign = "center";
        mathDiv.style.margin = "12px 0";
        mathDiv.style.overflowX = "auto";
        renderMathToElement(doc, mathDiv, token.content, true);
        parent.appendChild(mathDiv);
        break;
      }
    }
  }

  return container;
}

/**
 * Render inline tokens (text, bold, italic, code, links, etc.)
 */
export function renderInlineTokens(
  doc: Document,
  parent: HTMLElement,
  tokens: ReturnType<typeof md.parse>,
): void {
  const stack: HTMLElement[] = [parent];

  for (const token of tokens) {
    const current = stack[stack.length - 1];

    switch (token.type) {
      case "text":
        current.appendChild(doc.createTextNode(token.content));
        break;

      case "strong_open": {
        const strong = doc.createElementNS(HTML_NS, "strong") as HTMLElement;
        current.appendChild(strong);
        stack.push(strong);
        break;
      }
      case "strong_close":
        stack.pop();
        break;

      case "em_open": {
        const em = doc.createElementNS(HTML_NS, "em") as HTMLElement;
        current.appendChild(em);
        stack.push(em);
        break;
      }
      case "em_close":
        stack.pop();
        break;

      case "s_open": {
        const s = doc.createElementNS(HTML_NS, "s") as HTMLElement;
        current.appendChild(s);
        stack.push(s);
        break;
      }
      case "s_close":
        stack.pop();
        break;

      case "code_inline": {
        const codeInline = doc.createElementNS(HTML_NS, "code") as HTMLElement;
        const darkInline = isDarkMode();
        codeInline.style.background = darkInline ? "#343942" : "#f0f0f0";
        codeInline.style.color = darkInline ? "#e6e6e6" : "#24292e";
        codeInline.style.padding = "2px 6px";
        codeInline.style.borderRadius = "3px";
        codeInline.style.fontFamily = "monospace";
        codeInline.style.fontSize = "0.9em";
        codeInline.textContent = token.content;
        current.appendChild(codeInline);
        break;
      }

      case "link_open": {
        const a = doc.createElementNS(HTML_NS, "a") as HTMLAnchorElement;
        const href = token.attrGet("href");
        if (href) a.href = href;
        const darkLink = isDarkMode();
        a.style.color = darkLink ? "#58a6ff" : chatColors.markdownLink;
        a.style.textDecoration = "underline";
        current.appendChild(a);
        stack.push(a);
        break;
      }
      case "link_close":
        stack.pop();
        break;

      case "math_inline": {
        const mathSpan = doc.createElementNS(HTML_NS, "span") as HTMLElement;
        // Always use displayMode: false for inline math to avoid
        // <math display="block"> which breaks paragraph flow in Firefox.
        // Block-level display math is handled by math_block tokens.
        renderMathToElement(doc, mathSpan, token.content, false);
        current.appendChild(mathSpan);
        break;
      }

      case "softbreak":
        current.appendChild(doc.createTextNode(" "));
        break;

      case "hardbreak":
        current.appendChild(doc.createElementNS(HTML_NS, "br"));
        break;
    }
  }
}

/**
 * Highlight.js color themes for syntax highlighting
 */
const highlightColors = {
  light: {
    keyword: "#d73a49", // red - if, const, return
    string: "#032f62", // dark blue - "strings"
    number: "#005cc5", // blue - 123
    comment: "#6a737d", // gray - // comments
    function: "#6f42c1", // purple - function names
    class: "#6f42c1", // purple - class names
    variable: "#e36209", // orange - variables
    operator: "#d73a49", // red - =, +, -
    punctuation: "#24292e", // black - {, }, (, )
    property: "#005cc5", // blue - object properties
    builtin: "#005cc5", // blue - built-in functions
    attr: "#22863a", // green - attributes
    tag: "#22863a", // green - HTML tags
    selector: "#6f42c1", // purple - CSS selectors
    type: "#d73a49", // red - type names
    literal: "#005cc5", // blue - true, false, null
    meta: "#6a737d", // gray - meta info
    regexp: "#032f62", // dark blue - regex
    symbol: "#e36209", // orange - symbols
  },
  dark: {
    keyword: "#ff7b72", // red - if, const, return
    string: "#a5d6ff", // light blue - "strings"
    number: "#79c0ff", // blue - 123
    comment: "#8b949e", // gray - // comments
    function: "#d2a8ff", // purple - function names
    class: "#d2a8ff", // purple - class names
    variable: "#ffa657", // orange - variables
    operator: "#ff7b72", // red - =, +, -
    punctuation: "#c9d1d9", // light gray - {, }, (, )
    property: "#79c0ff", // blue - object properties
    builtin: "#79c0ff", // blue - built-in functions
    attr: "#7ee787", // green - attributes
    tag: "#7ee787", // green - HTML tags
    selector: "#d2a8ff", // purple - CSS selectors
    type: "#ff7b72", // red - type names
    literal: "#79c0ff", // blue - true, false, null
    meta: "#8b949e", // gray - meta info
    regexp: "#a5d6ff", // light blue - regex
    symbol: "#ffa657", // orange - symbols
  },
} as const;

/**
 * Map highlight.js class names to color keys
 */
const classToColorKey: Record<string, keyof typeof highlightColors.light> = {
  "hljs-keyword": "keyword",
  "hljs-string": "string",
  "hljs-number": "number",
  "hljs-comment": "comment",
  "hljs-function": "function",
  "hljs-class": "class",
  "hljs-variable": "variable",
  "hljs-operator": "operator",
  "hljs-punctuation": "punctuation",
  "hljs-property": "property",
  "hljs-built_in": "builtin",
  "hljs-attr": "attr",
  "hljs-tag": "tag",
  "hljs-selector-tag": "selector",
  "hljs-selector-class": "selector",
  "hljs-selector-id": "selector",
  "hljs-type": "type",
  "hljs-literal": "literal",
  "hljs-meta": "meta",
  "hljs-regexp": "regexp",
  "hljs-symbol": "symbol",
  "hljs-title": "function",
  "hljs-title.function_": "function",
  "hljs-title.class_": "class",
  "hljs-params": "variable",
  "hljs-name": "tag",
  "hljs-attribute": "attr",
  "hljs-doctag": "keyword",
  "hljs-template-variable": "variable",
  "hljs-template-tag": "tag",
  "hljs-subst": "variable",
  "hljs-section": "function",
  "hljs-link": "string",
  "hljs-bullet": "punctuation",
  "hljs-addition": "attr",
  "hljs-deletion": "keyword",
  "hljs-quote": "comment",
  "hljs-selector-attr": "attr",
  "hljs-selector-pseudo": "selector",
  "hljs-strong": "keyword",
  "hljs-emphasis": "comment",
  "hljs-code": "string",
};

/**
 * Safely render highlight.js HTML output to DOM elements
 * This parses the HTML string and builds DOM elements manually to avoid innerHTML
 */
function renderHighlightedCode(
  doc: Document,
  parent: HTMLElement,
  html: string,
  dark: boolean,
): void {
  const colors = dark ? highlightColors.dark : highlightColors.light;

  // Simple regex-based parser for highlight.js output
  // highlight.js only outputs: text, <span class="hljs-xxx">text</span>, and nested spans
  let pos = 0;
  const len = html.length;

  while (pos < len) {
    // Check for span tag
    if (html.startsWith("<span", pos)) {
      const classMatch = html.slice(pos).match(/^<span class="([^"]+)">/);
      if (classMatch) {
        const className = classMatch[1];
        const openTagEnd = pos + classMatch[0].length;

        // Find the matching closing tag (handle nesting)
        let depth = 1;
        let closePos = openTagEnd;
        while (depth > 0 && closePos < len) {
          if (html.startsWith("<span", closePos)) {
            depth++;
            const innerMatch = html.slice(closePos).match(/^<span[^>]*>/);
            closePos += innerMatch ? innerMatch[0].length : 5;
          } else if (html.startsWith("</span>", closePos)) {
            depth--;
            if (depth > 0) closePos += 7;
          } else {
            closePos++;
          }
        }

        // Extract inner content and create span
        const innerHtml = html.slice(openTagEnd, closePos);
        const span = doc.createElementNS(HTML_NS, "span") as HTMLElement;

        // Apply color based on class
        const colorKey = classToColorKey[className];
        if (colorKey && colors[colorKey]) {
          span.style.color = colors[colorKey];
        }

        // Recursively render inner content
        renderHighlightedCode(doc, span, innerHtml, dark);
        parent.appendChild(span);

        pos = closePos + 7; // Skip past </span>
        continue;
      }
    }

    // Check for HTML entities
    if (html[pos] === "&") {
      const entityMatch = html
        .slice(pos)
        .match(/^&(amp|lt|gt|quot|#39|#x27|nbsp);/);
      if (entityMatch) {
        const entity = entityMatch[1];
        let char = "";
        switch (entity) {
          case "amp":
            char = "&";
            break;
          case "lt":
            char = "<";
            break;
          case "gt":
            char = ">";
            break;
          case "quot":
            char = '"';
            break;
          case "#39":
          case "#x27":
            char = "'";
            break;
          case "nbsp":
            char = "\u00A0";
            break;
          default:
            char = entityMatch[0];
        }
        parent.appendChild(doc.createTextNode(char));
        pos += entityMatch[0].length;
        continue;
      }
    }

    // Regular text - collect until next tag or entity
    let textEnd = pos;
    while (textEnd < len && html[textEnd] !== "<" && html[textEnd] !== "&") {
      textEnd++;
    }
    if (textEnd > pos) {
      parent.appendChild(doc.createTextNode(html.slice(pos, textEnd)));
      pos = textEnd;
    } else {
      // Single character that's not part of a tag or entity
      parent.appendChild(doc.createTextNode(html[pos]));
      pos++;
    }
  }
}
