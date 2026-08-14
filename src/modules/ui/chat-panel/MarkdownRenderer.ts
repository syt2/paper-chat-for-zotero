/**
 * MarkdownRenderer - Convert markdown to DOM elements (XHTML-safe)
 */

import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import katex from "katex";
import { chatColors } from "../../../utils/colors";
import { getString } from "../../../utils/locale";
import { HTML_NS } from "./types";
import { isDarkMode } from "./ChatPanelTheme";
import type { EvidenceRecord } from "../../../types/evidence";
import type { PresentationToolCardArtifact } from "../../../types/chat";
import type { PresentationCardProgress } from "../../presentation/contracts";
import { normalizeEvidenceRecords } from "../../chat/evidence";
import {
  getToolCallCardExpandKey,
  getToolCallGroupExpandKey,
  isToolCallGroupExpanded,
  setToolCallGroupExpanded,
} from "./ToolCallGroupExpandState";
import { AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF } from "../../../utils/internalLinks";
import { openAgentMaxPlanningIterationsSettings } from "../../preferences/navigation";
import {
  buildPresentationProgressCardElement,
  parsePresentationCardProgress,
} from "./PresentationProgressCard";

// Initialize markdown-it with XHTML output
const md = new MarkdownIt({
  html: true,
  breaks: true,
  xhtmlOut: true,
  typographer: true,
  linkify: true,
});

function evidenceRefPlugin(mdInstance: MarkdownIt) {
  mdInstance.inline.ruler.before(
    "html_inline",
    "evidence_ref",
    (state, silent) => {
      const remaining = state.src.slice(state.pos, state.posMax);
      const match = remaining.match(
        /^<evidence-ref ids="(ev-[a-f0-9]{16}(?:,ev-[a-f0-9]{16})*)"\/>/,
      );
      if (!match) return false;
      if (!silent) {
        const token = state.push("evidence_ref", "", 0);
        token.meta = { ids: match[1].split(",") };
      }
      state.pos += match[0].length;
      return true;
    },
  );
}

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

md.use(evidenceRefPlugin);
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

type ToolCallCardStatus = "calling" | "completed" | "error";

interface ToolCallCardData {
  status: ToolCallCardStatus;
  expandKey?: string;
  toolName: string;
  toolArgs?: string;
  statusText: string;
  toolResult?: string;
  presentationProgress?: PresentationCardProgress;
}

type ToolCallFragment =
  | {
      kind: "markdown";
      content: string;
    }
  | {
      kind: "tool";
      entry: ToolCallCardData;
    };

type SourceGroupType =
  | "paper"
  | "item"
  | "note"
  | "annotation"
  | "web"
  | "collection"
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
      key?: string;
      url?: string;
      page?: number;
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

interface ActiveEvidencePopover {
  card: HTMLElement;
  citation: HTMLElement;
}

const activeEvidencePopoverByDocument = new WeakMap<
  Document,
  ActiveEvidencePopover
>();
const evidencePopoverListenersInstalled = new WeakSet<Document>();

function closeActiveEvidencePopover(doc: Document): void {
  const active = activeEvidencePopoverByDocument.get(doc);
  if (!active) return;
  active.citation.setAttribute("aria-expanded", "false");
  active.card.style.display = "none";
  if (active.card.parentNode?.removeChild) {
    active.card.parentNode.removeChild(active.card);
  }
  activeEvidencePopoverByDocument.delete(doc);
}

function isNodeInside(
  container: HTMLElement,
  target: EventTarget | null,
): boolean {
  return (
    !!target &&
    typeof (target as Node).nodeType === "number" &&
    container.contains(target as Node)
  );
}

function ensureEvidencePopoverDismissListeners(doc: Document): void {
  if (evidencePopoverListenersInstalled.has(doc)) return;
  evidencePopoverListenersInstalled.add(doc);
  if (typeof doc.addEventListener !== "function") return;
  doc.addEventListener(
    "pointerdown",
    (event) => {
      const active = activeEvidencePopoverByDocument.get(doc);
      if (
        !active ||
        isNodeInside(active.card, event.target) ||
        isNodeInside(active.citation, event.target)
      ) {
        return;
      }
      closeActiveEvidencePopover(doc);
    },
    true,
  );
  doc.addEventListener(
    "scroll",
    (event) => {
      const active = activeEvidencePopoverByDocument.get(doc);
      if (active && isNodeInside(active.card, event.target)) return;
      closeActiveEvidencePopover(doc);
    },
    true,
  );
  doc.defaultView?.addEventListener("resize", () =>
    closeActiveEvidencePopover(doc),
  );
}

function positionEvidencePopover(
  doc: Document,
  citation: HTMLElement,
  card: HTMLElement,
): void {
  const view = doc.defaultView;
  if (!view) return;

  const margin = 12;
  const gap = 6;
  const viewportWidth = Math.max(
    1,
    view.innerWidth || doc.documentElement.clientWidth,
  );
  const viewportHeight = Math.max(
    1,
    view.innerHeight || doc.documentElement.clientHeight,
  );
  const width = Math.min(360, Math.max(1, viewportWidth - margin * 2));
  card.style.width = `${width}px`;
  card.style.maxWidth = `${width}px`;
  card.style.maxHeight = `${Math.max(1, viewportHeight - margin * 2)}px`;
  card.style.visibility = "hidden";
  card.style.display = "block";

  const anchorRect = citation.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const left = Math.min(
    Math.max(margin, anchorRect.left),
    Math.max(margin, viewportWidth - margin - cardRect.width),
  );
  const belowTop = anchorRect.bottom + gap;
  const aboveTop = anchorRect.top - cardRect.height - gap;
  const top =
    belowTop + cardRect.height <= viewportHeight - margin
      ? belowTop
      : aboveTop >= margin
        ? aboveTop
        : Math.max(
            margin,
            Math.min(belowTop, viewportHeight - margin - cardRect.height),
          );

  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
  card.style.visibility = "visible";
}

export interface MarkdownRenderOptions {
  /** Enable the trusted app-authored max-iterations settings action. */
  enableAgentMaxPlanningIterationsSettingsLink?: boolean;
  presentationArtifactAction?: {
    openLabel: string;
    draftLabel: string;
    onOpen: (artifact: PresentationToolCardArtifact) => void | Promise<void>;
    onError?: (error: Error) => void;
  };
  /** Trusted app-owned artifacts keyed by the producing tool call ID. */
  presentationArtifacts?: ReadonlyMap<string, PresentationToolCardArtifact>;
  /** Restrict local preview images to app-owned presentation directories. */
  isTrustedPresentationPreviewPath?: (path: string) => boolean;
  blockquoteAction?: {
    label: string;
    title: string;
    onClick: (
      quoteText: string,
      sourceGroup?: SourceGroupActionContext,
    ) => void | Promise<void>;
  };
  sourceGroupAction?: {
    getTitle: (group: SourceGroupActionContext) => string | null;
    onClick: (group: SourceGroupActionContext) => void | Promise<void>;
    onError?: (error: Error) => void;
  };
  evidenceRecords?: EvidenceRecord[];
  evidenceAction?: {
    citationTitle: string;
    viewSourceLabel: string;
    onClick: (record: EvidenceRecord) => void | Promise<void>;
    onError?: (error: Error) => void;
  };
  sourceGroupContext?: SourceGroupActionContext;
}

export interface SourceGroupActionContext {
  label: string;
  type: string;
  key?: string;
  url?: string;
  page?: number;
  content: string;
}

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

function truncateInlineText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeToolCardText(text: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return "";
  }

  return truncateInlineText(
    firstLine
      .replace(/^Error:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim(),
    120,
  );
}

function getToolCardStatusColor(
  colors: typeof toolCallStyles.light,
  status: ToolCallCardStatus,
): string {
  return status === "calling"
    ? colors.statusCalling
    : status === "completed"
      ? colors.statusDone
      : colors.statusError;
}

export function stripIncompleteTrailingToolCall(content: string): string {
  const lastOpen = content.lastIndexOf("<tool-call");
  if (lastOpen === -1) {
    return content;
  }

  const lastClose = content.lastIndexOf("</tool-call>");
  if (lastClose >= lastOpen) {
    return content;
  }

  return content.slice(0, lastOpen);
}

function parseToolCallFragments(content: string): ToolCallFragment[] {
  const stableContent = stripIncompleteTrailingToolCall(content);
  const toolCallRegex =
    /<tool-call status="(calling|completed|error)"(?: expand-key="([^"]*)")?(?: presentation-phase="([^"]*)" presentation-stage="([^"]*)" presentation-message="([^"]*)" presentation-started-at="(\d+)" presentation-stage-started-at="(\d+)" presentation-updated-at="(\d+)")?>\s*<tool-name>([^<]*)<\/tool-name>\s*(?:<tool-args>([^<]*)<\/tool-args>\s*)?<tool-status>([^<]*)<\/tool-status>\s*(?:<tool-result>([^<]*)<\/tool-result>\s*)?(?:<presentation-artifact([^>]*)>\s*([\s\S]*?)<\/presentation-artifact>\s*)?<\/tool-call>/g;

  const fragments: ToolCallFragment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = toolCallRegex.exec(stableContent)) !== null) {
    if (match.index > lastIndex) {
      const markdownBefore = stableContent.slice(lastIndex, match.index);
      if (markdownBefore.trim()) {
        fragments.push({
          kind: "markdown",
          content: markdownBefore,
        });
      }
    }

    const [
      ,
      status,
      expandKey,
      presentationPhase,
      presentationStage,
      presentationMessage,
      presentationStartedAt,
      presentationStageStartedAt,
      presentationUpdatedAt,
      toolName,
      toolArgs,
      statusText,
      toolResult,
    ] = match;

    fragments.push({
      kind: "tool",
      entry: {
        status: status as ToolCallCardStatus,
        expandKey,
        toolName,
        toolArgs,
        statusText,
        toolResult,
        presentationProgress: parsePresentationCardProgress(
          presentationPhase,
          presentationStage,
          unescapeXml(presentationMessage || ""),
          presentationStartedAt,
          presentationStageStartedAt,
          presentationUpdatedAt,
        ),
      },
    });

    lastIndex = match.index + match[0].length;
  }

  if (fragments.length === 0) {
    return [{ kind: "markdown", content: stableContent }];
  }

  if (lastIndex < stableContent.length) {
    const trailingMarkdown = stableContent.slice(lastIndex);
    if (trailingMarkdown.trim()) {
      fragments.push({
        kind: "markdown",
        content: trailingMarkdown,
      });
    }
  }

  return fragments;
}

function buildToolCallCardElement(
  doc: Document,
  entry: ToolCallCardData,
  expandStateKey: string | null = null,
  presentationArtifact?: PresentationToolCardArtifact,
  options: MarkdownRenderOptions = {},
): HTMLElement {
  if (entry.presentationProgress) {
    return buildPresentationProgressCardElement(
      doc,
      {
        status: entry.status,
        progress: entry.presentationProgress,
        errorText: unescapeXml(entry.toolResult || entry.statusText || ""),
      },
      presentationArtifact
        ? buildPresentationArtifactElement(
            doc,
            presentationArtifact,
            options,
            true,
          )
        : undefined,
    );
  }
  const dark = isDarkMode();
  const colors = dark ? toolCallStyles.dark : toolCallStyles.light;
  const { status, toolName, toolArgs, statusText, toolResult } = entry;
  const isError = status === "error";
  const hasDetails = Boolean(toolArgs || toolResult);
  const isCompleted = status === "completed";
  const canToggle =
    hasDetails && (isCompleted || isError || Boolean(toolResult));
  const summaryText =
    isError || (status === "calling" && toolResult)
      ? summarizeToolCardText(unescapeXml(toolResult || statusText || ""))
      : "";

  const card = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  card.style.margin = isError ? "6px 0" : "8px 0";
  card.style.border = `1px solid ${isError ? colors.statusError : colors.cardBorder}`;
  card.style.borderRadius = "8px";
  card.style.background = colors.cardBg;
  card.style.overflow = "hidden";
  card.style.fontFamily =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
  card.style.fontSize = "12px";

  const header = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.padding = isError ? "7px 10px" : "8px 12px";
  header.style.background = isError ? colors.cardBg : colors.nameBg;
  header.style.gap = "8px";
  if (canToggle) {
    header.style.cursor = "pointer";
    header.style.userSelect = "none";
  }

  let chevron: HTMLElement | null = null;
  if (canToggle) {
    chevron = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    chevron.style.fontSize = "10px";
    chevron.style.color = colors.argsText;
    chevron.style.transition = "transform 0.2s";
    chevron.style.display = "inline-block";
    chevron.textContent = "▶";
    header.appendChild(chevron);
  }

  const textGroup = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  textGroup.style.display = "flex";
  textGroup.style.flexDirection = "column";
  textGroup.style.minWidth = "0";
  textGroup.style.flex = "1";
  textGroup.style.gap = "2px";

  const nameEl = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  nameEl.style.fontWeight = "600";
  nameEl.style.color = colors.nameText;
  nameEl.style.minWidth = "0";
  nameEl.style.overflow = "hidden";
  nameEl.style.textOverflow = "ellipsis";
  nameEl.style.whiteSpace = "nowrap";
  nameEl.textContent = unescapeXml(toolName || "");
  textGroup.appendChild(nameEl);

  if (summaryText) {
    const summaryEl = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    if (status === "calling") {
      summaryEl.setAttribute("data-tool-progress", "true");
    }
    summaryEl.style.fontSize = "10px";
    summaryEl.style.color = colors.argsText;
    summaryEl.style.minWidth = "0";
    summaryEl.style.overflow = "hidden";
    summaryEl.style.textOverflow = "ellipsis";
    summaryEl.style.whiteSpace = "nowrap";
    summaryEl.textContent = summaryText;
    textGroup.appendChild(summaryEl);
  }
  header.appendChild(textGroup);

  const statusEl = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  statusEl.style.fontSize = "11px";
  statusEl.style.color = getToolCardStatusColor(colors, status);
  statusEl.style.fontWeight = "500";
  statusEl.style.flexShrink = "0";
  statusEl.textContent = statusText || "";
  header.appendChild(statusEl);

  card.appendChild(header);

  let detailsContainer: HTMLElement | null = null;
  if (hasDetails) {
    detailsContainer = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    detailsContainer.style.borderTop = `1px solid ${colors.cardBorder}`;
    detailsContainer.style.display = canToggle ? "none" : "block";
    detailsContainer.style.overflow = "hidden";

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

    if (toolResult) {
      const resultEl = doc.createElementNS(HTML_NS, "div") as HTMLElement;
      resultEl.style.padding = "6px 12px";
      resultEl.style.color = isError ? colors.nameText : colors.resultText;
      resultEl.style.fontSize = "11px";
      resultEl.style.background = isError ? colors.cardBg : colors.resultBg;
      resultEl.style.whiteSpace = "pre-wrap";
      resultEl.style.wordBreak = "break-word";
      resultEl.style.maxHeight = "150px";
      resultEl.style.overflow = "auto";
      resultEl.textContent = unescapeXml(toolResult);
      detailsContainer.appendChild(resultEl);
    }

    card.appendChild(detailsContainer);
  }

  if (canToggle && chevron && detailsContainer) {
    let isExpanded = isToolCallGroupExpanded(expandStateKey);
    const details = detailsContainer;
    const chev = chevron;

    details.style.display = isExpanded ? "block" : "none";
    chev.style.transform = isExpanded ? "rotate(90deg)" : "rotate(0deg)";

    header.addEventListener("click", () => {
      isExpanded = !isExpanded;
      details.style.display = isExpanded ? "block" : "none";
      chev.style.transform = isExpanded ? "rotate(90deg)" : "rotate(0deg)";
      setToolCallGroupExpanded(expandStateKey, isExpanded);
    });

    header.addEventListener("mouseenter", () => {
      header.style.background = isError
        ? dark
          ? "#1f2937"
          : "#fef2f2"
        : dark
          ? "#2d333b"
          : "#e6eaef";
    });
    header.addEventListener("mouseleave", () => {
      header.style.background = isError ? colors.cardBg : colors.nameBg;
    });
  }

  return card;
}

function buildPresentationArtifactElement(
  doc: Document,
  artifact: PresentationToolCardArtifact,
  options: MarkdownRenderOptions,
  embedded = false,
): HTMLElement {
  const dark = isDarkMode();
  const colors = dark ? toolCallStyles.dark : toolCallStyles.light;
  const artifactContainer = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  artifactContainer.setAttribute("data-presentation-artifact", "true");
  artifactContainer.setAttribute(
    "data-presentation-artifact-tool-call-id",
    artifact.toolCallId,
  );
  if (artifact.localId) {
    artifactContainer.setAttribute(
      "data-presentation-artifact-local-id",
      artifact.localId,
    );
  }
  Object.assign(artifactContainer.style, {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    margin: embedded ? "2px 0 0" : "8px 0",
    padding: embedded ? "10px 0 0" : "9px 12px 10px",
    border: embedded ? "none" : `1px solid ${colors.cardBorder}`,
    borderTop: `1px solid ${colors.cardBorder}`,
    borderRadius: embedded ? "0" : "8px",
    background: embedded ? "transparent" : colors.resultBg,
    overflow: "hidden",
  });

  const trustedPreviewPaths = (artifact.previewPaths || [])
    .filter(
      (previewPath) =>
        options.isTrustedPresentationPreviewPath?.(previewPath) === true,
    )
    .slice(0, 6);
  if (trustedPreviewPaths.length > 0) {
    const previewRail = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    Object.assign(previewRail.style, {
      display: "flex",
      gap: "6px",
      overflowX: "auto",
      paddingBottom: "2px",
    });
    for (const previewPath of trustedPreviewPaths) {
      const image = doc.createElementNS(HTML_NS, "img") as HTMLImageElement;
      image.setAttribute("src", PathUtils.toFileURI(previewPath));
      image.setAttribute("alt", "Presentation slide preview");
      image.setAttribute("data-presentation-preview", "true");
      Object.assign(image.style, {
        width: "112px",
        aspectRatio: "16 / 9",
        objectFit: "cover",
        flex: "0 0 auto",
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: "5px",
        background: colors.cardBg,
      });
      previewRail.appendChild(image);
    }
    artifactContainer.appendChild(previewRail);
  }

  const action = options.presentationArtifactAction;
  if (action && (artifact.path || artifact.attachmentItemID)) {
    const button = doc.createElementNS(HTML_NS, "button") as HTMLElement;
    button.setAttribute("type", "button");
    button.setAttribute("data-presentation-open", "true");
    button.textContent = artifact.isDraft
      ? action.draftLabel
      : action.openLabel;
    Object.assign(button.style, {
      alignSelf: "flex-start",
      border: `1px solid ${colors.cardBorder}`,
      borderRadius: "6px",
      padding: "5px 10px",
      cursor: "pointer",
      color: colors.nameText,
      background: colors.cardBg,
      fontSize: "11px",
      fontWeight: "600",
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(action.onOpen(artifact)).catch((error) => {
        action.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
    artifactContainer.appendChild(button);
  }

  if (artifact.path) {
    const pathEl = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    pathEl.setAttribute("data-presentation-path", "true");
    pathEl.textContent = artifact.path;
    Object.assign(pathEl.style, {
      color: colors.argsText,
      fontFamily: '"SF Mono", Monaco, Consolas, monospace',
      fontSize: "10px",
      lineHeight: "1.35",
      overflowWrap: "anywhere",
      userSelect: "text",
    });
    artifactContainer.appendChild(pathEl);
  }

  return artifactContainer;
}

function renderPresentationArtifacts(
  doc: Document,
  parent: HTMLElement,
  options: MarkdownRenderOptions,
  renderedArtifactKeys: ReadonlySet<string>,
): void {
  for (const [
    artifactKey,
    artifact,
  ] of options.presentationArtifacts?.entries() || []) {
    if (renderedArtifactKeys.has(artifactKey)) continue;
    parent.appendChild(
      buildPresentationArtifactElement(doc, artifact, options),
    );
  }
}

/**
 * Render a run of consecutive tool-call entries. Single entries render as a
 * plain card. Two or more: the latest entry stays visible, earlier ones fold
 * into a native `<details>`. Group state uses message/group indexes; cards
 * with an explicit expand key use their stable identity across re-renders.
 */
function renderToolCallGroup(
  doc: Document,
  parent: HTMLElement,
  entries: ToolCallCardData[],
  messageId: string | undefined,
  groupIndex: number,
  options: MarkdownRenderOptions,
  renderedArtifactKeys: Set<string>,
): void {
  const getEntryExpandStateKey = (entry: ToolCallCardData): string | null =>
    getToolCallCardExpandKey(
      messageId,
      entry.expandKey ? unescapeXml(entry.expandKey) : undefined,
    );
  const buildEntryCard = (entry: ToolCallCardData): HTMLElement => {
    const artifactKey =
      entry.presentationProgress && entry.expandKey
        ? unescapeXml(entry.expandKey)
        : undefined;
    const artifact = artifactKey
      ? options.presentationArtifacts?.get(artifactKey)
      : undefined;
    if (artifact && artifactKey) {
      renderedArtifactKeys.add(artifactKey);
    }
    return buildToolCallCardElement(
      doc,
      entry,
      getEntryExpandStateKey(entry),
      artifact,
      options,
    );
  };

  if (entries.length === 1) {
    parent.appendChild(buildEntryCard(entries[0]));
    return;
  }

  const earlier = entries.slice(0, -1);
  const latest = entries[entries.length - 1];
  const stateKey = getToolCallGroupExpandKey(messageId, groupIndex);
  const earlierExpandStateKeys = earlier.map(getEntryExpandStateKey);
  const isOpen =
    isToolCallGroupExpanded(stateKey) ||
    earlierExpandStateKeys.some((key) => isToolCallGroupExpanded(key));

  const dark = isDarkMode();
  const colors = dark ? toolCallStyles.dark : toolCallStyles.light;

  const details = doc.createElementNS(HTML_NS, "details") as HTMLDetailsElement;
  details.style.margin = "6px 0";
  if (isOpen) {
    details.setAttribute("open", "");
  }

  const summary = doc.createElementNS(HTML_NS, "summary") as HTMLElement;
  summary.style.cursor = "pointer";
  summary.style.userSelect = "none";
  summary.style.fontSize = "11px";
  summary.style.color = colors.argsText;
  summary.style.padding = "4px 2px";
  summary.textContent = getString("chat-tool-group-earlier", {
    args: { count: earlier.length },
  });
  details.appendChild(summary);

  const earlierBody = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  earlierBody.style.paddingLeft = "4px";
  for (const entry of earlier) {
    earlierBody.appendChild(buildEntryCard(entry));
  }
  details.appendChild(earlierBody);

  if (stateKey !== null) {
    details.addEventListener("toggle", () => {
      setToolCallGroupExpanded(stateKey, details.open);
      if (!details.open) {
        for (const key of earlierExpandStateKeys) {
          setToolCallGroupExpanded(key, false);
        }
      }
    });
  }

  parent.appendChild(details);
  parent.appendChild(buildEntryCard(latest));
}

function renderMarkdownFragment(
  doc: Document,
  parent: HTMLElement,
  content: string,
  options: MarkdownRenderOptions = {},
): void {
  const normalized = content.trim();
  if (!normalized) return;

  const tokens = md.parse(preprocessMathDelimiters(normalized), {});
  const builtContent = buildDOMFromTokens(doc, tokens, options);
  while (builtContent.firstChild) {
    parent.appendChild(builtContent.firstChild);
  }
}

function parseTagAttributes(attrs: string): Map<string, string> | null {
  const parsed = new Map<string, string>();
  let index = 0;

  while (index < attrs.length) {
    while (index < attrs.length && /\s/.test(attrs[index])) {
      index += 1;
    }
    if (index >= attrs.length) {
      break;
    }

    if (!/[A-Za-z_:]/.test(attrs[index])) {
      return null;
    }
    const nameStart = index;
    index += 1;
    while (index < attrs.length && /[A-Za-z0-9_.:-]/.test(attrs[index])) {
      index += 1;
    }
    const name = attrs.slice(nameStart, index).toLowerCase();

    while (index < attrs.length && /\s/.test(attrs[index])) {
      index += 1;
    }
    if (attrs[index] !== "=") {
      return null;
    }
    index += 1;

    while (index < attrs.length && /\s/.test(attrs[index])) {
      index += 1;
    }
    const quote = attrs[index];
    if (quote !== '"' && quote !== "'") {
      return null;
    }
    index += 1;
    const valueStart = index;
    while (index < attrs.length && attrs[index] !== quote) {
      index += 1;
    }
    if (index >= attrs.length) {
      return null;
    }
    const value = unescapeXml(attrs.slice(valueStart, index));
    index += 1;

    if (!parsed.has(name)) {
      parsed.set(name, value);
    }
  }

  return parsed;
}

function findOpeningTagEnd(content: string, start: number): number | null {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      return index;
    }
  }
  return null;
}

export function extractSourceGroupFragments(
  content: string,
): SourceGroupFragment[] {
  const openingTagPattern = /<source-group\b/gi;
  const closingTag = "</source-group>";
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

  while ((match = openingTagPattern.exec(content)) !== null) {
    const tagEnd = findOpeningTagEnd(content, openingTagPattern.lastIndex);
    if (tagEnd === null) {
      break;
    }
    const closingTagStart = content.indexOf(closingTag, tagEnd + 1);
    if (closingTagStart < 0) {
      openingTagPattern.lastIndex = tagEnd + 1;
      continue;
    }

    const attrs = parseTagAttributes(
      content.slice(openingTagPattern.lastIndex, tagEnd),
    );
    if (!attrs) {
      openingTagPattern.lastIndex = tagEnd + 1;
      continue;
    }
    const label = attrs.get("label");
    const type = attrs.get("type") || "paper";
    const key = attrs.get("key");
    const url = attrs.get("url");
    const rawPage = attrs.get("page");
    const page = rawPage && /^\d+$/.test(rawPage) ? Number(rawPage) : undefined;

    if (!label) {
      openingTagPattern.lastIndex = tagEnd + 1;
      continue;
    }

    if (match.index > cursor) {
      pushMarkdownFragment(content.slice(cursor, match.index));
    }

    fragments.push({
      kind: "source-group",
      label,
      type,
      key,
      url,
      page,
      content: content.slice(tagEnd + 1, closingTagStart),
    });

    hasSourceGroup = true;
    cursor = closingTagStart + closingTag.length;
    openingTagPattern.lastIndex = cursor;
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
    case "item":
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
    case "collection":
      return dark
        ? { badgeBg: "#7e22ce33", badgeText: "#d8b4fe", accent: "#a855f7" }
        : { badgeBg: "#f3e8ff", badgeText: "#7e22ce", accent: "#c084fc" };
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
  options: MarkdownRenderOptions = {},
): void {
  const dark = isDarkMode();
  const colors = dark ? sourceGroupStyles.dark : sourceGroupStyles.light;
  const palette = getSourceGroupPalette(group.type, dark);
  const sourceGroupAction = options.sourceGroupAction;
  const actionTitle = sourceGroupAction?.getTitle(group) || null;

  const card = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  card.style.margin = "10px 0";
  card.style.border = `1px solid ${colors.cardBorder}`;
  card.style.borderLeft = `3px solid ${palette.accent}`;
  card.style.borderRadius = "10px";
  card.style.background = colors.cardBg;
  card.style.overflow = "hidden";

  const header = doc.createElementNS(
    HTML_NS,
    actionTitle ? "button" : "div",
  ) as HTMLElement;
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "8px";
  header.style.width = "100%";
  header.style.boxSizing = "border-box";
  header.style.padding = "16px 10px";
  header.style.background = colors.headerBg;
  header.style.borderBottom = `1px solid ${colors.cardBorder}`;
  header.style.borderTop = "none";
  header.style.borderLeft = "none";
  header.style.borderRight = "none";
  header.style.borderRadius = "0";
  header.style.margin = "0";
  header.style.appearance = "none";
  header.style.fontFamily = "inherit";
  header.style.textAlign = "left";

  if (actionTitle && sourceGroupAction) {
    header.setAttribute("type", "button");
    header.setAttribute("title", `${actionTitle}: ${group.label}`);
    header.setAttribute("aria-label", `${actionTitle}: ${group.label}`);
    header.style.cursor = "pointer";
    header.addEventListener("mouseenter", () => {
      header.style.background = dark ? "#2d333b" : "#eef2f6";
    });
    header.addEventListener("mouseleave", () => {
      header.style.background = colors.headerBg;
    });
    header.addEventListener("focus", () => {
      header.style.boxShadow = `inset 0 0 0 2px ${palette.accent}`;
    });
    header.addEventListener("blur", () => {
      header.style.boxShadow = "none";
    });
    header.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void Promise.resolve()
        .then(() => sourceGroupAction.onClick(group))
        .catch((error: unknown) => {
          sourceGroupAction.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });
  }

  const badge = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  badge.style.display = "inline-flex";
  badge.style.alignItems = "center";
  badge.style.padding = "2px 8px";
  badge.style.borderRadius = "999px";
  badge.style.fontSize = "11px";
  badge.style.fontWeight = "600";
  badge.style.flexShrink = "0";
  badge.style.background = palette.badgeBg;
  badge.style.color = palette.badgeText;
  badge.textContent = formatSourceGroupType(group.type);
  header.appendChild(badge);

  const label = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  label.style.fontSize = "13px";
  label.style.fontWeight = "600";
  label.style.color = colors.labelText;
  label.style.flex = "1";
  label.style.minWidth = "0";
  label.style.whiteSpace = "nowrap";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.lineHeight = "1.4";
  label.setAttribute("title", group.label);
  label.textContent = group.label;
  header.appendChild(label);

  if (actionTitle) {
    const openIndicator = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    openIndicator.setAttribute("aria-hidden", "true");
    openIndicator.style.color = colors.bodyText;
    openIndicator.style.fontSize = "12px";
    openIndicator.style.flexShrink = "0";
    openIndicator.textContent = "↗";
    header.appendChild(openIndicator);
  }

  card.appendChild(header);

  const body = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  body.style.padding = "10px 12px";
  body.style.color = colors.bodyText;
  renderMarkdownFragment(doc, body, group.content, {
    ...options,
    sourceGroupContext: group,
  });
  card.appendChild(body);

  parent.appendChild(card);
}

function renderSourceGroupBlocks(
  doc: Document,
  parent: HTMLElement,
  content: string,
  options: MarkdownRenderOptions = {},
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
      renderMarkdownFragment(doc, parent, fragment.content, options);
      continue;
    }

    renderSourceGroupCard(doc, parent, fragment, options);
  }

  return true;
}

interface MarkdownMessageCopyOptions {
  reasoning?: string | null;
  evidenceRecords?: EvidenceRecord[];
}

function formatEvidenceReferencesForMarkdownCopy(
  content: string,
  evidenceRecords: EvidenceRecord[] | undefined,
): {
  content: string;
  referencedRecords: Array<{ record: EvidenceRecord; citationNumber: number }>;
} {
  const records = normalizeEvidenceRecords(evidenceRecords);
  const byId = new Map(
    records.map((record, index) => [record.id, { record, index }]),
  );
  const referencedIds = new Set<string>();
  const formatted = content.replace(
    /<evidence-ref ids="(ev-[a-f0-9]{16}(?:,ev-[a-f0-9]{16})*)"\/>/g,
    (_match, rawIds: string) => {
      const indexes: number[] = [];
      for (const id of rawIds.split(",")) {
        const entry = byId.get(id);
        if (!entry) continue;
        referencedIds.add(id);
        indexes.push(entry.index + 1);
      }
      return indexes.length > 0 ? `[${indexes.join(", ")}]` : "";
    },
  );
  return {
    content: formatted.replace(/<\/?evidence-ref\b[^>]*>/gi, ""),
    referencedRecords: records.flatMap((record, index) =>
      referencedIds.has(record.id)
        ? [{ record, citationNumber: index + 1 }]
        : [],
    ),
  };
}

function formatEvidenceAppendix(
  records: Array<{ record: EvidenceRecord; citationNumber: number }>,
): string {
  if (records.length === 0) return "";
  const entries = records.map(({ record, citationNumber }) => {
    const location = formatEvidenceLocation(record);
    const quote = record.quote.replace(/\n/g, "\n   > ");
    return [
      `${citationNumber}. ${location ? `**${location}**` : "Supporting passage"}`,
      `   > ${quote}`,
    ].join("\n\n");
  });
  return ["### Evidence", ...entries].join("\n\n");
}

function formatToolCallFragmentsForMarkdownCopy(content: string): string {
  return parseToolCallFragments(content)
    .map((fragment) => {
      if (fragment.kind === "markdown") {
        return fragment.content.trim();
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function formatSourceGroupForMarkdownCopy(
  fragment: Extract<SourceGroupFragment, { kind: "source-group" }>,
): string {
  const title = [formatSourceGroupType(fragment.type), fragment.label]
    .filter(Boolean)
    .join(": ");
  const body = formatToolCallFragmentsForMarkdownCopy(fragment.content);
  return [`### ${title}`, body].filter(Boolean).join("\n\n");
}

export function formatMarkdownForMessageCopy(
  content: string,
  options: MarkdownMessageCopyOptions = {},
): string {
  const stableContent = stripIncompleteTrailingToolCall(content);
  const evidenceCopy = formatEvidenceReferencesForMarkdownCopy(
    stableContent,
    options.evidenceRecords,
  );
  const copiedContent = extractSourceGroupFragments(evidenceCopy.content)
    .map((fragment) => {
      if (fragment.kind === "markdown") {
        return formatToolCallFragmentsForMarkdownCopy(fragment.content);
      }
      return formatSourceGroupForMarkdownCopy(fragment);
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const evidenceAppendix = formatEvidenceAppendix(
    evidenceCopy.referencedRecords,
  );
  const answerWithEvidence = [copiedContent, evidenceAppendix]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const reasoning = options.reasoning?.trim();
  if (!reasoning) {
    return answerWithEvidence;
  }

  return [`## Thinking`, reasoning, answerWithEvidence]
    .filter(Boolean)
    .join("\n\n")
    .trim();
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
  messageId: string | undefined,
  options: MarkdownRenderOptions = {},
  renderedArtifactKeys: Set<string> = new Set(),
): string {
  const fragments = parseToolCallFragments(content);
  if (fragments.length === 1 && fragments[0].kind === "markdown") {
    return fragments[0].content;
  }

  let groupIndex = 0;
  for (let i = 0; i < fragments.length; ) {
    const fragment = fragments[i];
    if (fragment.kind === "markdown") {
      if (!renderSourceGroupBlocks(doc, parent, fragment.content, options)) {
        renderMarkdownFragment(doc, parent, fragment.content, options);
      }
      i++;
      continue;
    }

    const entries: ToolCallCardData[] = [];
    while (i < fragments.length && fragments[i].kind === "tool") {
      entries.push(
        (fragments[i] as Extract<ToolCallFragment, { kind: "tool" }>).entry,
      );
      i++;
    }

    if (entries.length > 0) {
      renderToolCallGroup(
        doc,
        parent,
        entries,
        messageId,
        groupIndex,
        options,
        renderedArtifactKeys,
      );
      groupIndex++;
    }
  }

  return "";
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
    // eslint-disable-next-line no-control-regex
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
  messageId?: string,
  options: MarkdownRenderOptions = {},
): void {
  const doc = element.ownerDocument;
  if (!doc) return;
  closeActiveEvidencePopover(doc);
  element.textContent = "";

  // First, check for and render tool call cards
  const renderedPresentationArtifactKeys = new Set<string>();
  const remainingContent = renderToolCallCards(
    doc,
    element,
    markdownContent,
    messageId,
    options,
    renderedPresentationArtifactKeys,
  );

  // Presentation artifacts are a privileged, app-owned side channel. Render
  // them independently of assistant-authored markup so copied or fabricated
  // `<presentation-artifact>` tags cannot create or relocate file actions.
  renderPresentationArtifacts(
    doc,
    element,
    options,
    renderedPresentationArtifactKeys,
  );

  if (!remainingContent) {
    return;
  }

  if (renderSourceGroupBlocks(doc, element, remainingContent, options)) {
    return;
  }

  renderMarkdownFragment(doc, element, remainingContent, options);
}

function appendBlockquoteAction(
  doc: Document,
  blockquote: HTMLElement,
  action: NonNullable<MarkdownRenderOptions["blockquoteAction"]>,
  sourceGroup?: SourceGroupActionContext,
): void {
  const quoteText = getBlockquoteActionText(blockquote).trim();
  if (!quoteText) {
    return;
  }

  const dark = isDarkMode();
  const button = doc.createElementNS(HTML_NS, "button") as HTMLElement;
  button.setAttribute("type", "button");
  button.setAttribute("title", action.title);
  button.setAttribute("data-blockquote-action", "true");
  button.textContent = action.label;
  Object.assign(button.style, {
    display: "inline-flex",
    alignItems: "center",
    marginTop: "6px",
    padding: "2px 7px",
    border: `1px solid ${dark ? "#4b5563" : "#d0d7de"}`,
    borderRadius: "6px",
    background: dark ? "#21262d" : "#f6f8fa",
    color: dark ? "#c9d1d9" : "#57606a",
    cursor: "pointer",
    fontSize: "11px",
    lineHeight: "1.4",
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void action.onClick(quoteText, sourceGroup);
  });
  blockquote.appendChild(button);
}

function getBlockquoteActionText(node: Node): string {
  if (
    node.nodeType === node.ELEMENT_NODE &&
    (node as Element).getAttribute("data-blockquote-action") === "true"
  ) {
    return "";
  }

  if (node.nodeType === node.TEXT_NODE) {
    return node.textContent || "";
  }

  let text = "";
  for (const child of Array.from(node.childNodes)) {
    if (child) {
      text += getBlockquoteActionText(child);
    }
  }
  return text;
}

function formatEvidenceLocation(record: EvidenceRecord): string {
  return [
    record.page
      ? getEvidenceLocaleString(
          "chat-evidence-page",
          { page: record.page },
          `Page ${record.page}`,
        )
      : "",
    record.section
      ? getEvidenceLocaleString(
          "chat-evidence-section",
          { section: record.section },
          `Section: ${record.section}`,
        )
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function getEvidenceLocaleString(
  key: "chat-evidence-page" | "chat-evidence-section",
  args: Record<string, unknown>,
  fallback: string,
): string {
  try {
    return getString(key, { args });
  } catch {
    return fallback;
  }
}

function appendEvidenceReference(
  doc: Document,
  parent: HTMLElement,
  ids: string[],
  options: MarkdownRenderOptions,
): void {
  const records = normalizeEvidenceRecords(options.evidenceRecords);
  const recordIndex = new Map(
    records.map((record, index) => [record.id, { record, index }]),
  );
  const resolved = ids
    .map((id) => recordIndex.get(id))
    .filter(
      (
        entry,
      ): entry is {
        record: EvidenceRecord;
        index: number;
      } => !!entry,
    );
  if (resolved.length === 0) return;

  const dark = isDarkMode();
  for (const { record, index } of resolved) {
    const wrapper = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    wrapper.style.display = "inline-block";
    wrapper.style.position = "relative";
    wrapper.style.margin = "0 1px";
    wrapper.style.lineHeight = "1";
    wrapper.style.verticalAlign = "super";

    const citation = doc.createElementNS(
      HTML_NS,
      options.evidenceAction ? "button" : "span",
    ) as HTMLElement;
    citation.setAttribute("data-evidence-ref", record.id);
    citation.setAttribute(
      "title",
      options.evidenceAction?.citationTitle ||
        truncateInlineText(record.quote.replace(/\s+/g, " "), 180),
    );
    citation.style.display = "inline";
    citation.style.padding = "0 2px";
    citation.style.border = "none";
    citation.style.borderRadius = "4px";
    citation.style.background = "transparent";
    citation.style.color = dark ? "#79c0ff" : "#2563eb";
    citation.style.fontSize = "0.72em";
    citation.style.fontWeight = "650";
    citation.style.lineHeight = "1";
    citation.style.verticalAlign = "baseline";
    citation.textContent = `[${index + 1}]`;
    wrapper.appendChild(citation);

    const action = options.evidenceAction;
    if (action) {
      citation.setAttribute("type", "button");
      citation.setAttribute("aria-expanded", "false");
      citation.style.cursor = "pointer";

      const card = doc.createElementNS(HTML_NS, "span") as HTMLElement;
      card.setAttribute("data-evidence-card", record.id);
      card.setAttribute("role", "note");
      card.style.display = "none";
      card.style.position = "fixed";
      card.style.zIndex = "2147483000";
      card.style.width = "360px";
      card.style.maxWidth = "calc(100vw - 24px)";
      card.style.overflowY = "auto";
      card.style.boxSizing = "border-box";
      card.style.padding = "10px";
      card.style.border = `1px solid ${dark ? "#4b5563" : "#d0d7de"}`;
      card.style.borderRadius = "8px";
      card.style.background = dark ? "#161b22" : "#ffffff";
      card.style.color = dark ? "#c9d1d9" : "#334155";
      card.style.boxShadow = dark
        ? "0 8px 24px rgba(0, 0, 0, 0.45)"
        : "0 8px 24px rgba(15, 23, 42, 0.16)";
      card.style.fontSize = "12px";
      card.style.fontWeight = "400";
      card.style.lineHeight = "1.5";
      card.style.textAlign = "left";
      card.style.whiteSpace = "normal";

      const location = formatEvidenceLocation(record);
      if (location) {
        const locationElement = doc.createElementNS(
          HTML_NS,
          "span",
        ) as HTMLElement;
        locationElement.style.display = "block";
        locationElement.style.marginBottom = "5px";
        locationElement.style.color = dark ? "#8b949e" : "#64748b";
        locationElement.style.fontSize = "11px";
        locationElement.style.fontWeight = "600";
        locationElement.textContent = location;
        card.appendChild(locationElement);
      }

      const quote = doc.createElementNS(HTML_NS, "span") as HTMLElement;
      quote.style.display = "block";
      quote.style.whiteSpace = "pre-wrap";
      quote.textContent = record.quote;
      card.appendChild(quote);

      const viewSource = doc.createElementNS(HTML_NS, "button") as HTMLElement;
      viewSource.setAttribute("type", "button");
      viewSource.setAttribute("data-evidence-source-action", record.id);
      viewSource.style.display = "inline-flex";
      viewSource.style.marginTop = "8px";
      viewSource.style.padding = "3px 8px";
      viewSource.style.border = `1px solid ${dark ? "#4b5563" : "#cbd5e1"}`;
      viewSource.style.borderRadius = "6px";
      viewSource.style.background = dark ? "#21262d" : "#f8fafc";
      viewSource.style.color = dark ? "#79c0ff" : "#2563eb";
      viewSource.style.cursor = "pointer";
      viewSource.style.fontSize = "11px";
      viewSource.textContent = action.viewSourceLabel;
      viewSource.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeActiveEvidencePopover(doc);
        void Promise.resolve()
          .then(() => action.onClick(record))
          .catch((error: unknown) => {
            action.onError?.(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      });
      card.appendChild(viewSource);

      citation.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const active = activeEvidencePopoverByDocument.get(doc);
        if (active?.card === card) {
          closeActiveEvidencePopover(doc);
          return;
        }

        closeActiveEvidencePopover(doc);
        const host = doc.body || doc.documentElement || wrapper;
        host.appendChild(card);
        card.style.display = "block";
        citation.setAttribute("aria-expanded", "true");
        activeEvidencePopoverByDocument.set(doc, { card, citation });
        ensureEvidencePopoverDismissListeners(doc);
        positionEvidencePopover(doc, citation, card);
      });
    }

    parent.appendChild(wrapper);
  }
}

/**
 * Build DOM elements from markdown-it tokens
 */
export function buildDOMFromTokens(
  doc: Document,
  tokens: ReturnType<typeof md.parse>,
  options: MarkdownRenderOptions = {},
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
      case "blockquote_close": {
        const blockquote = stack.pop();
        if (blockquote && options.blockquoteAction) {
          appendBlockquoteAction(
            doc,
            blockquote,
            options.blockquoteAction,
            options.sourceGroupContext,
          );
        }
        break;
      }

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
          renderInlineTokens(doc, parent, token.children, options);
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
  options: MarkdownRenderOptions = {},
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
        if (href === AGENT_MAX_PLANNING_ITERATIONS_SETTINGS_HREF) {
          a.href = "#";
          if (options.enableAgentMaxPlanningIterationsSettingsLink) {
            a.setAttribute(
              "data-paperchat-settings-target",
              "agent-max-planning-iterations",
            );
            a.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              openAgentMaxPlanningIterationsSettings();
            });
          } else {
            // Internal app actions are inert in untrusted model markdown.
            a.addEventListener("click", (event) => event.preventDefault());
          }
        } else if (href) {
          a.href = href;
        }
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

      case "evidence_ref": {
        const ids = Array.isArray((token.meta as { ids?: unknown })?.ids)
          ? ((token.meta as { ids: unknown[] }).ids.filter(
              (id): id is string => typeof id === "string",
            ) as string[])
          : [];
        appendEvidenceReference(doc, current, ids, options);
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
