import MarkdownIt from "markdown-it";
import { graphemeSegments } from "unicode-segmenter/grapheme";
import type { ChatMessage } from "../../../types/chat";
import { normalizeQuotedMessageRefs } from "../quoted-messages";
import type { SearchHighlightRange } from "./SearchTypes";

/**
 * Increment this whenever visible extraction or normalization semantics change.
 * Rows processed by an older projector remain in the backfill work set.
 */
export const CURRENT_SEARCH_VERSION = 2;

/** Reserved inside stored documents so a phrase cannot cross field boundaries. */
export const FIELD_BOUNDARY_TOKEN = "\u001f";

export type VisibleSearchSegmentKind =
  | "text"
  | "linkLabel"
  | "code"
  | "math"
  | "sourceText";

export type VisibleSearchSegment =
  | {
      kind: VisibleSearchSegmentKind;
      text: string;
      /**
       * How this segment joins the previous visible segment. Callers normally
       * omit this (an inline space is the public default); the Markdown
       * projector uses `none` to preserve source adjacency and `block` for
       * visible block boundaries.
       */
      separator?: "none" | "inline" | "block";
    }
  | { kind: "fieldBoundary" };

export interface NormalizedDisplaySpan {
  normalizedStart: number;
  normalizedEnd: number;
  displayStart: number;
  displayEnd: number;
}

export interface SearchDocument {
  displayText: string;
  normalizedText: string;
  spans: NormalizedDisplaySpan[];
}

export interface SearchSnippet {
  snippet: string;
  highlightRanges: SearchHighlightRange[];
}

interface DisplayPiece {
  kind: "text" | "fieldBoundary";
  text: string;
  displayStart: number;
  displayEnd: number;
}

interface NormalizedAtom {
  text: string;
  displayStart: number;
  displayEnd: number;
  whitespace: boolean;
}

interface Grapheme {
  text: string;
  start: number;
  end: number;
}

type MarkdownToken = ReturnType<MarkdownIt["parse"]>[number];

const markdown = new MarkdownIt({
  html: true,
  breaks: true,
  xhtmlOut: true,
  typographer: true,
  linkify: true,
});

const unicodeWhitespace = /^[\p{White_Space}\uFEFF]$/u;
const unicodeWhitespaceRun = /[\p{White_Space}\uFEFF]+/gu;
const graphemeSensitiveNormalization =
  /[\p{Mark}\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF\uFF61-\uFFDC]/u;
const contextSensitiveLowercase = /\u03A3/u;
const safePrefilterTerm = /^[a-z0-9\p{Script=Han}]+$/u;
const searchWordSkeletonNoise = /[^a-z0-9\p{Script=Han}]+/gu;
const characterEntitySyntax = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/iu;
const orderedListMarker = /^[ \t>0-9.*+()-]*\d{1,9}[.)][ \t]+/m;
const markdownTypographerReplacement = /\((?:c|r|p|tm)\)/iu;
const linkifyCandidateSyntax =
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|[^\s@]+@[^\s@]+|xn--|%[\da-f]{2})/iu;
const noProviderAssistantMessages = new Set([
  "⚠️ No AI provider available. Please configure a provider in Settings.",
  "⚠️ 没有可用的 AI 服务商，请在设置中配置。",
  // `getString()` returns its fully-prefixed id before locale initialization.
  "paperchat-chat-error-no-provider",
]);

function resolveRuntimeSegmenter(): typeof Intl.Segmenter | undefined {
  return typeof Intl.Segmenter === "function" ? Intl.Segmenter : undefined;
}

export function createNativeGraphemeSegmenter(
  resolveSegmenter: () =>
    | typeof Intl.Segmenter
    | undefined = resolveRuntimeSegmenter,
): Intl.Segmenter | null {
  const Segmenter = resolveSegmenter();
  return Segmenter ? new Segmenter("und", { granularity: "grapheme" }) : null;
}

const nativeGraphemeSegmenter = createNativeGraphemeSegmenter();

export function* iterateGraphemeSegments(
  value: string,
  segmenter: Intl.Segmenter | null = nativeGraphemeSegmenter,
): IterableIterator<{ segment: string; index: number }> {
  if (segmenter) {
    yield* segmenter.segment(value);
    return;
  }

  for (const { segment, index } of graphemeSegments(value)) {
    yield { segment, index };
  }
}

function installMathPlugin(md: MarkdownIt): void {
  md.inline.ruler.after("escape", "math_inline", (state, silent) => {
    const source = state.src;
    const start = state.pos;
    if (source.charCodeAt(start) !== 0x24) return false;

    const double = source.charCodeAt(start + 1) === 0x24;
    const delimiterLength = double ? 2 : 1;
    let end = start + delimiterLength;

    while (end <= state.posMax - delimiterLength) {
      if (source.charCodeAt(end) !== 0x24) {
        end += 1;
        continue;
      }

      let backslashes = 0;
      let cursor = end - 1;
      while (
        cursor >= start + delimiterLength &&
        source.charCodeAt(cursor) === 0x5c
      ) {
        backslashes += 1;
        cursor -= 1;
      }
      if (backslashes % 2 !== 0) {
        end += 1;
        continue;
      }

      if (!double || source.charCodeAt(end + 1) === 0x24) break;
      end += 1;
    }

    const closed = double
      ? end <= state.posMax - delimiterLength &&
        source.charCodeAt(end + 1) === 0x24
      : end < state.posMax;
    if (!closed) return false;

    const content = source.slice(start + delimiterLength, end);
    if (!content.trim()) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = content;
      token.markup = double ? "$$" : "$";
    }
    state.pos = end + delimiterLength;
    return true;
  });

  md.block.ruler.after(
    "blockquote",
    "math_block",
    (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const lineEnd = state.eMarks[startLine];
      if (
        start + 2 > lineEnd ||
        state.src.charCodeAt(start) !== 0x24 ||
        state.src.charCodeAt(start + 1) !== 0x24
      ) {
        return false;
      }

      const afterOpening = state.src.slice(start + 2, lineEnd).trim();
      if (afterOpening.endsWith("$$") && afterOpening.length > 2) {
        if (silent) return true;
        const token = state.push("math_block", "math", 0);
        token.content = afterOpening.slice(0, -2).trim();
        token.markup = "$$";
        token.map = [startLine, startLine + 1];
        state.line = startLine + 1;
        return true;
      }

      let closingLine = startLine + 1;
      while (closingLine < endLine) {
        const nextStart = state.bMarks[closingLine] + state.tShift[closingLine];
        const nextEnd = state.eMarks[closingLine];
        if (state.src.slice(nextStart, nextEnd).trim() === "$$") break;
        closingLine += 1;
      }
      if (closingLine >= endLine) return false;
      if (silent) return true;

      const lines: string[] = [];
      if (afterOpening) lines.push(afterOpening);
      for (let line = startLine + 1; line < closingLine; line += 1) {
        const nextStart = state.bMarks[line] + state.tShift[line];
        lines.push(state.src.slice(nextStart, state.eMarks[line]));
      }

      const token = state.push("math_block", "math", 0);
      token.content = lines.join("\n").trim();
      token.markup = "$$";
      token.map = [startLine, closingLine + 1];
      state.line = closingLine + 1;
      return true;
    },
  );
}

installMathPlugin(markdown);

function canonicalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function segmentGraphemes(value: string): Grapheme[] {
  return Array.from(iterateGraphemeSegments(value), (part) => ({
    text: part.segment,
    start: part.index,
    end: part.index + part.segment.length,
  }));
}

function normalizeGrapheme(value: string): string {
  return canonicalizeNewlines(value.normalize("NFKC"))
    .toLowerCase()
    .replaceAll(FIELD_BOUNDARY_TOKEN, " ");
}

function appendNormalizedAtoms(
  atoms: NormalizedAtom[],
  normalized: string,
  displayStart: number,
  displayEnd: number,
): void {
  for (const character of normalized) {
    const whitespace = unicodeWhitespace.test(character);
    if (whitespace && atoms.at(-1)?.whitespace) {
      const previous = atoms.at(-1)!;
      previous.displayStart = Math.min(previous.displayStart, displayStart);
      previous.displayEnd = Math.max(previous.displayEnd, displayEnd);
      continue;
    }
    atoms.push({
      text: whitespace ? " " : character,
      displayStart,
      displayEnd,
      whitespace,
    });
  }
}

function normalizedAtomsForPieces(pieces: DisplayPiece[]): NormalizedAtom[] {
  const atoms: NormalizedAtom[] = [];
  for (const piece of pieces) {
    if (piece.kind === "fieldBoundary") {
      atoms.push({
        text: FIELD_BOUNDARY_TOKEN,
        displayStart: piece.displayStart,
        displayEnd: piece.displayEnd,
        whitespace: false,
      });
      continue;
    }

    for (const grapheme of segmentGraphemes(piece.text)) {
      appendNormalizedAtoms(
        atoms,
        normalizeGrapheme(grapheme.text),
        piece.displayStart + grapheme.start,
        piece.displayStart + grapheme.end,
      );
    }
  }

  let start = 0;
  let end = atoms.length;
  while (start < end && atoms[start].whitespace) start += 1;
  while (end > start && atoms[end - 1].whitespace) end -= 1;
  return start === 0 && end === atoms.length ? atoms : atoms.slice(start, end);
}

function atomsToDocument(
  displayText: string,
  atoms: NormalizedAtom[],
): SearchDocument {
  const normalizedText = atoms.map((atom) => atom.text).join("");
  const contentSpans: NormalizedDisplaySpan[] = [];
  let normalizedOffset = 0;

  for (const atom of atoms) {
    const atomStart = normalizedOffset;
    normalizedOffset += atom.text.length;
    const previous = contentSpans.at(-1);
    const overlapsPrevious =
      previous !== undefined &&
      atom.displayStart < previous.displayEnd &&
      atom.displayEnd > previous.displayStart;
    if (overlapsPrevious) {
      previous.normalizedEnd = normalizedOffset;
      previous.displayStart = Math.min(
        previous.displayStart,
        atom.displayStart,
      );
      previous.displayEnd = Math.max(previous.displayEnd, atom.displayEnd);
      continue;
    }
    contentSpans.push({
      normalizedStart: atomStart,
      normalizedEnd: normalizedOffset,
      displayStart: atom.displayStart,
      displayEnd: atom.displayEnd,
    });
  }

  return {
    displayText,
    normalizedText,
    spans: [
      {
        normalizedStart: 0,
        normalizedEnd: 0,
        displayStart: 0,
        displayEnd: 0,
      },
      ...contentSpans,
      {
        normalizedStart: normalizedText.length,
        normalizedEnd: normalizedText.length,
        displayStart: displayText.length,
        displayEnd: displayText.length,
      },
    ],
  };
}

function hasVisibleText(segment: VisibleSearchSegment | undefined): boolean {
  return segment?.kind !== "fieldBoundary" && !!segment?.text.trim();
}

function buildDisplayPieces(segments: VisibleSearchSegment[]): {
  displayText: string;
  pieces: DisplayPiece[];
} {
  const pieces: DisplayPiece[] = [];
  let displayText = "";
  let hasText = false;
  let afterFieldBoundary = false;

  const appendPiece = (kind: DisplayPiece["kind"], rawText: string): void => {
    const text = canonicalizeNewlines(rawText);
    const displayStart = displayText.length;
    displayText += text;
    pieces.push({
      kind,
      text,
      displayStart,
      displayEnd: displayText.length,
    });
  };

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.kind === "fieldBoundary") {
      if (hasText && segments.slice(index + 1).some(hasVisibleText)) {
        appendPiece("fieldBoundary", "\n\n");
        afterFieldBoundary = true;
      }
      continue;
    }
    if (!segment.text) continue;

    if (hasText && !afterFieldBoundary) {
      const separator = segment.separator ?? "inline";
      if (separator === "inline") appendPiece("text", " ");
      if (separator === "block") appendPiece("text", "\n");
    }
    appendPiece("text", segment.text);
    hasText = true;
    afterFieldBoundary = false;
  }

  return { displayText, pieces };
}

interface NormalizedTextState {
  text: string;
  pendingWhitespace: boolean;
}

function flushNormalizedWhitespace(state: NormalizedTextState): void {
  if (state.pendingWhitespace && state.text) state.text += " ";
  state.pendingWhitespace = false;
}

function appendNormalizedText(
  state: NormalizedTextState,
  normalized: string,
): void {
  const collapsed = normalized.replace(unicodeWhitespaceRun, " ");
  if (!collapsed) return;
  const hasLeadingWhitespace = collapsed.charCodeAt(0) === 0x20;
  const hasTrailingWhitespace =
    collapsed.charCodeAt(collapsed.length - 1) === 0x20;
  const start = hasLeadingWhitespace ? 1 : 0;
  const end = hasTrailingWhitespace ? collapsed.length - 1 : collapsed.length;
  if (hasLeadingWhitespace) state.pendingWhitespace = true;
  if (state.pendingWhitespace && end > start) {
    flushNormalizedWhitespace(state);
  }
  if (end > start) state.text += collapsed.slice(start, end);
  state.pendingWhitespace =
    hasTrailingWhitespace || (end === start && hasLeadingWhitespace);
}

function appendSearchText(state: NormalizedTextState, value: string): void {
  // Combining marks and conjoining Hangul Jamo can normalize across scalar
  // boundaries, so only those uncommon inputs need grapheme-aware splitting.
  if (graphemeSensitiveNormalization.test(value)) {
    for (const grapheme of iterateGraphemeSegments(value)) {
      appendNormalizedText(state, normalizeGrapheme(grapheme.segment));
    }
    return;
  }
  const compatible = canonicalizeNewlines(value.normalize("NFKC"));
  if (!contextSensitiveLowercase.test(compatible)) {
    appendNormalizedText(
      state,
      compatible.toLowerCase().replaceAll(FIELD_BOUNDARY_TOKEN, " "),
    );
    return;
  }
  for (const scalar of compatible) {
    appendNormalizedText(
      state,
      scalar.toLowerCase().replaceAll(FIELD_BOUNDARY_TOKEN, " "),
    );
  }
}

function appendSearchFieldBoundary(state: NormalizedTextState): void {
  flushNormalizedWhitespace(state);
  state.text += FIELD_BOUNDARY_TOKEN;
}

function normalizedTextForPieces(pieces: DisplayPiece[]): string {
  const state: NormalizedTextState = { text: "", pendingWhitespace: false };
  for (const piece of pieces) {
    if (piece.kind === "fieldBoundary") {
      appendSearchFieldBoundary(state);
    } else {
      appendSearchText(state, piece.text);
    }
  }
  return state.text;
}

function normalizedTextForSingleValue(value: string): string {
  const state: NormalizedTextState = { text: "", pendingWhitespace: false };
  appendSearchText(state, value);
  return state.text;
}

/** Normalize stored text and raw queries with the canonical literal contract. */
export function normalizeSearchValue(value: string): string {
  const text = canonicalizeNewlines(value);
  const piece: DisplayPiece = {
    kind: "text",
    text,
    displayStart: 0,
    displayEnd: text.length,
  };
  return normalizedAtomsForPieces([piece])
    .map((atom) => atom.text)
    .join("");
}

/** Project visible segments into display text, normalized text, and source spans. */
export function projectSearchDocument(
  segments: VisibleSearchSegment[],
): SearchDocument {
  const { displayText, pieces } = buildDisplayPieces(segments);
  return atomsToDocument(displayText, normalizedAtomsForPieces(pieces));
}

/**
 * Project only the canonical stored/matching value. This intentionally skips
 * grapheme-to-display span construction; snippets still use the full document
 * projector for the small set of returned rows.
 */
export function projectSearchNormalizedText(
  segments: VisibleSearchSegment[],
): string {
  return normalizedTextForPieces(buildDisplayPieces(segments).pieces);
}

/** Titles use the same normalization and grapheme/source mapping as messages. */
export function projectSearchTitle(title: string): SearchDocument {
  return projectSearchDocument([
    { kind: "text", text: title, separator: "none" },
  ]);
}

function preprocessMathDelimiters(content: string): string {
  const preserved: string[] = [];
  let marker = "\uE000PAPERCHAT_SEARCH_PRESERVE_";
  while (content.includes(marker)) marker += "_";
  const markerEnd = "\uE001";
  let processed = content.replace(/```[\s\S]*?```/g, (match) => {
    preserved.push(match);
    return `${marker}${preserved.length - 1}${markerEnd}`;
  });
  processed = processed.replace(/`[^`]+`/g, (match) => {
    preserved.push(match);
    return `${marker}${preserved.length - 1}${markerEnd}`;
  });
  processed = processed.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_match, math) => `$$${math}$$`,
  );
  processed = processed.replace(
    /\\\((.*?)\\\)/g,
    (_match, math) => `$${math}$`,
  );
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return processed.replace(
    new RegExp(`${escapedMarker}(\\d+)${markerEnd}`, "g"),
    (_match, index) => preserved[Number(index)],
  );
}

function stripToolCallMarkup(content: string): string {
  if (!/<tool-call\b/i.test(content)) return content;
  const lower = content.toLowerCase();
  const openingPattern = /<tool-call\b/gi;
  const closingTag = "</tool-call>";
  let cursor = 0;
  let output = "";
  let match: RegExpExecArray | null;

  while ((match = openingPattern.exec(content)) !== null) {
    output += content.slice(cursor, match.index);
    const closing = lower.indexOf(closingTag, openingPattern.lastIndex);
    if (closing < 0) return output;
    cursor = closing + closingTag.length;
    openingPattern.lastIndex = cursor;
  }
  return output + content.slice(cursor);
}

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function parseTagAttributes(value: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] || "")) index += 1;
    if (index >= value.length) break;
    if (!/[A-Za-z_:]/.test(value[index])) return null;

    const nameStart = index++;
    while (/[A-Za-z0-9_.:-]/.test(value[index] || "")) index += 1;
    const name = value.slice(nameStart, index).toLowerCase();
    while (/\s/.test(value[index] || "")) index += 1;
    if (value[index++] !== "=") return null;
    while (/\s/.test(value[index] || "")) index += 1;
    const quote = value[index++];
    if (quote !== '"' && quote !== "'") return null;
    const valueStart = index;
    while (index < value.length && value[index] !== quote) index += 1;
    if (index >= value.length) return null;
    if (!attributes.has(name)) {
      attributes.set(name, unescapeXml(value.slice(valueStart, index)));
    }
    index += 1;
  }
  return attributes;
}

function findTagEnd(content: string, start: number): number | null {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return null;
}

function buildSearchWordSkeleton(content: string): string {
  return canonicalizeNewlines(content.normalize("NFKC"))
    .toLowerCase()
    .replace(searchWordSkeletonNoise, "");
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function asciiLowerCode(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

function isAsciiSearchWordCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

/** Prove a literal lowercase ASCII query is visible without allocating. */
function asciiCaseInsensitiveIncludes(content: string, query: string): boolean {
  if (!query || query.length > content.length) return false;
  const limit = content.length - query.length;
  for (let start = 0; start <= limit; start += 1) {
    let offset = 0;
    while (
      offset < query.length &&
      asciiLowerCode(content.charCodeAt(start + offset)) ===
        query.charCodeAt(offset)
    ) {
      offset += 1;
    }
    if (offset === query.length) return true;
  }
  return false;
}

/** Search the ASCII word skeleton without materializing its normalized string. */
function asciiSearchWordSkeletonIncludes(
  content: string,
  term: string,
): boolean {
  if (!term || !isAscii(term)) return false;
  for (let start = 0; start < content.length; start += 1) {
    if (!isAsciiSearchWordCode(content.charCodeAt(start))) continue;
    let sourceIndex = start;
    let termIndex = 0;
    while (sourceIndex < content.length && termIndex < term.length) {
      const sourceCode = content.charCodeAt(sourceIndex);
      sourceIndex += 1;
      if (!isAsciiSearchWordCode(sourceCode)) continue;
      if (asciiLowerCode(sourceCode) !== term.charCodeAt(termIndex)) break;
      termIndex += 1;
    }
    if (termIndex === term.length) return true;
  }
  return false;
}

function stripSimpleDirectLinksForPrefilter(content: string): string | null {
  let output = "";
  let cursor = 0;

  while (cursor < content.length) {
    const opening = content.indexOf("[", cursor);
    if (opening < 0) return output + content.slice(cursor);

    const image = opening > 0 && content[opening - 1] === "!";
    const constructStart = image ? opening - 1 : opening;
    const prefix = content.slice(0, opening);
    if (
      prefix.includes("`") ||
      prefix.includes("~~~") ||
      prefix.includes("$") ||
      prefix.includes("\\")
    ) {
      return null;
    }
    const lineStart = content.lastIndexOf("\n", opening - 1) + 1;
    const linePrefix = content.slice(lineStart, constructStart);
    if (linePrefix.includes("\t") || linePrefix.includes("    ")) return null;
    let backslashes = 0;
    for (let index = constructStart - 1; content[index] === "\\"; index -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 !== 0) return null;

    const labelEnd = content.indexOf("](", opening + 1);
    if (labelEnd < 0) return null;
    const label = content.slice(opening + 1, labelEnd);
    if (label.includes("[") || label.includes("]") || /[\\\r\n]/u.test(label)) {
      return null;
    }

    let depth = 1;
    let index = labelEnd + 2;
    while (index < content.length && depth > 0) {
      const character = content[index];
      const codePoint = character.codePointAt(0)!;
      if (
        character === "\\" ||
        unicodeWhitespace.test(character) ||
        codePoint < 0x20 ||
        codePoint === 0x7f ||
        character === "%" ||
        character === '"' ||
        character === "'"
      ) {
        return null;
      }
      if (character === "(") depth += 1;
      if (depth > 32) return null;
      if (character === ")") depth -= 1;
      index += 1;
    }
    if (depth !== 0) return null;
    const destination = content.slice(labelEnd + 2, index - 1);
    if (!markdown.validateLink(destination)) return null;

    output += content.slice(cursor, constructStart);
    if (!image) output += label;
    cursor = index;
  }
  return output;
}

function findFirstRiskIndex(content: string, exactPhrase: string): number {
  let limit = content.length;
  const consider = (index: number): void => {
    if (index >= 0 && index < limit) limit = index;
  };

  for (const marker of ["<", "[", "```", "~~~"] as const) {
    consider(content.indexOf(marker));
  }
  consider(linkifyCandidateSyntax.exec(content)?.index ?? -1);
  consider(markdownTypographerReplacement.exec(content)?.index ?? -1);
  if (/\d/u.test(exactPhrase)) {
    consider(orderedListMarker.exec(content)?.index ?? -1);
  }
  return limit;
}

function proveAssistantExactMatch(
  content: string,
  exactPhrase: string,
): boolean {
  const prefix = content.slice(0, findFirstRiskIndex(content, exactPhrase));
  if (!prefix.trim()) return false;
  return normalizedTextForSingleValue(prefix).includes(exactPhrase);
}

type SourceFragment =
  | { kind: "markdown"; content: string }
  | { kind: "source"; label: string; content: string };

function extractSourceFragments(content: string): SourceFragment[] {
  const openingPattern = /<source-group\b/gi;
  const closingTag = "</source-group>";
  const fragments: SourceFragment[] = [];
  let cursor = 0;
  let found = false;
  let match: RegExpExecArray | null;

  const pushMarkdown = (value: string): void => {
    if (value.trim()) fragments.push({ kind: "markdown", content: value });
  };

  while ((match = openingPattern.exec(content)) !== null) {
    const tagEnd = findTagEnd(content, openingPattern.lastIndex);
    if (tagEnd === null) break;
    const closing = content.toLowerCase().indexOf(closingTag, tagEnd + 1);
    if (closing < 0) {
      openingPattern.lastIndex = tagEnd + 1;
      continue;
    }
    const attributes = parseTagAttributes(
      content.slice(openingPattern.lastIndex, tagEnd),
    );
    const label = attributes?.get("label");
    if (!label) {
      openingPattern.lastIndex = tagEnd + 1;
      continue;
    }

    pushMarkdown(content.slice(cursor, match.index));
    fragments.push({
      kind: "source",
      label,
      content: content.slice(tagEnd + 1, closing),
    });
    found = true;
    cursor = closing + closingTag.length;
    openingPattern.lastIndex = cursor;
  }

  if (!found) return [{ kind: "markdown", content }];
  pushMarkdown(content.slice(cursor));
  return fragments;
}

function pushSegment(
  output: VisibleSearchSegment[],
  kind: VisibleSearchSegmentKind,
  text: string,
  separator: "none" | "block",
): void {
  if (!text) return;
  output.push({ kind, text, separator });
}

function appendInlineTokens(
  output: VisibleSearchSegment[],
  tokens: MarkdownToken[],
  firstSeparator: "none" | "block",
): void {
  let nextSeparator = firstSeparator;
  let linkDepth = 0;
  for (const token of tokens) {
    switch (token.type) {
      case "link_open":
        linkDepth += 1;
        break;
      case "link_close":
        linkDepth = Math.max(0, linkDepth - 1);
        break;
      case "text":
        pushSegment(
          output,
          linkDepth > 0 ? "linkLabel" : "text",
          token.content,
          nextSeparator,
        );
        if (token.content) nextSeparator = "none";
        break;
      case "code_inline":
        pushSegment(output, "code", token.content, nextSeparator);
        if (token.content) nextSeparator = "none";
        break;
      case "math_inline":
        pushSegment(output, "math", token.content, nextSeparator);
        if (token.content) nextSeparator = "none";
        break;
      case "softbreak":
        pushSegment(output, "text", " ", nextSeparator);
        nextSeparator = "none";
        break;
      case "hardbreak":
        pushSegment(output, "text", "\n", nextSeparator);
        nextSeparator = "none";
        break;
      // Images, their transport alt text, and raw HTML are intentionally absent.
      case "image":
      case "html_inline":
        break;
    }
  }
}

function appendMarkdownSegments(
  output: VisibleSearchSegment[],
  content: string,
): void {
  const normalized = content.trim();
  if (!normalized) return;
  const tokens = markdown.parse(preprocessMathDelimiters(normalized), {});
  for (const token of tokens) {
    const separator = output.length > 0 ? "block" : "none";
    if (token.type === "inline" && token.children) {
      appendInlineTokens(output, token.children, separator);
    } else if (token.type === "fence" || token.type === "code_block") {
      pushSegment(output, "code", token.content.replace(/\n$/, ""), separator);
    } else if (token.type === "math_block") {
      pushSegment(output, "math", token.content, separator);
    }
  }
}

function extractAssistantSegments(content: string): VisibleSearchSegment[] {
  const output: VisibleSearchSegment[] = [];
  const withoutTools = stripToolCallMarkup(content);
  for (const fragment of extractSourceFragments(withoutTools)) {
    if (fragment.kind === "markdown") {
      appendMarkdownSegments(output, fragment.content);
      continue;
    }
    pushSegment(
      output,
      "sourceText",
      fragment.label.trim(),
      output.length > 0 ? "block" : "none",
    );
    appendMarkdownSegments(output, fragment.content);
  }
  return output;
}

interface AssistantTransportSearchSource {
  text: string;
  literalLabelHasBracketSyntax: boolean;
}

function buildAssistantTransportSearchSource(
  content: string,
): AssistantTransportSearchSource {
  if (!/<(?:tool-call|source-group)\b/i.test(content)) {
    return { text: content, literalLabelHasBracketSyntax: false };
  }
  const output: string[] = [];
  let literalLabelHasBracketSyntax = false;
  const withoutTools = stripToolCallMarkup(content);
  for (const fragment of extractSourceFragments(withoutTools)) {
    if (fragment.kind === "source" && fragment.label.trim()) {
      const label = fragment.label.trim();
      output.push(label);
      if (label.includes("[")) literalLabelHasBracketSyntax = true;
    }
    if (fragment.content.trim()) output.push(fragment.content);
  }
  return {
    text: output.join("\n"),
    literalLabelHasBracketSyntax,
  };
}

function extractVisibleQuestion(content: string): string {
  const marker = "[Question]:";
  const markerIndex = content.lastIndexOf(marker);
  return (
    markerIndex < 0 ? content : content.slice(markerIndex + marker.length)
  ).trim();
}

function getVisibleUserSearchFields(
  message: ChatMessage,
): Array<{ kind: "text" | "sourceText"; text: string }> {
  const fields: Array<{ kind: "text" | "sourceText"; text: string }> = [];
  for (const quote of normalizeQuotedMessageRefs(message.quotedMessages)) {
    fields.push({ kind: "sourceText", text: quote.preview });
  }
  const selectedText = message.selectedText?.trim() || "";
  if (selectedText) fields.push({ kind: "sourceText", text: selectedText });
  const question = extractVisibleQuestion(message.content);
  if (question) fields.push({ kind: "text", text: question });
  return fields;
}

function isCompletedAssistantAnswer(message: ChatMessage): boolean {
  const content = message.content.trim();
  return (
    message.role === "assistant" &&
    message.streamingState === undefined &&
    !message.tool_calls?.length &&
    !message.tool_call_id &&
    !!content &&
    !noProviderAssistantMessages.has(content)
  );
}

/** Extract only text the chat renderer exposes as user-facing message content. */
export function buildVisibleSearchSegments(
  message: ChatMessage,
): VisibleSearchSegment[] {
  if (message.apiOnly || message.isSystemNotice) return [];

  if (message.role === "user") {
    if (message.streamingState !== undefined) return [];
    const segments: VisibleSearchSegment[] = [];
    for (const field of getVisibleUserSearchFields(message)) {
      if (segments.length > 0) segments.push({ kind: "fieldBoundary" });
      segments.push({ ...field, separator: "none" });
    }
    return segments;
  }

  return isCompletedAssistantAnswer(message)
    ? extractAssistantSegments(message.content)
    : [];
}

/** Project a message's canonical stored search value without display spans. */
export function projectMessageSearchNormalizedText(
  message: ChatMessage,
): string {
  if (message.apiOnly || message.isSystemNotice) return "";
  if (message.role === "user") {
    if (message.streamingState !== undefined) return "";
    const state: NormalizedTextState = {
      text: "",
      pendingWhitespace: false,
    };
    for (const field of getVisibleUserSearchFields(message)) {
      if (state.text) appendSearchFieldBoundary(state);
      appendSearchText(state, field.text);
    }
    return state.text;
  }
  return isCompletedAssistantAnswer(message)
    ? projectSearchNormalizedText(extractAssistantSegments(message.content))
    : "";
}

export type AssistantSearchFastDecision = "skip" | "exactMatch" | "project";

/**
 * Apply allocation-light decisions to simple user fields before falling back
 * to the assistant Markdown proof or the canonical projector.
 */
export function getMessageSearchFastDecision(
  message: ChatMessage,
  query: { exactPhrase: string; terms: readonly string[] },
): AssistantSearchFastDecision {
  if (message.role === "assistant") {
    return getAssistantSearchFastDecision(message, query);
  }
  if (message.role !== "user") return "skip";
  if (
    message.apiOnly ||
    message.isSystemNotice ||
    message.streamingState !== undefined
  ) {
    return "skip";
  }
  if (
    !query.terms.length ||
    query.terms.some((term) => !safePrefilterTerm.test(term)) ||
    !isAscii(query.exactPhrase)
  ) {
    return "project";
  }

  const fields = getVisibleUserSearchFields(message).map((field) => field.text);
  if (fields.some((field) => !isAscii(field))) return "project";
  if (
    fields.some((field) =>
      asciiCaseInsensitiveIncludes(field, query.exactPhrase),
    )
  ) {
    return "exactMatch";
  }
  if (
    query.terms.some(
      (term) =>
        !fields.some((field) => asciiSearchWordSkeletonIncludes(field, term)),
    )
  ) {
    return "skip";
  }
  return "project";
}

/**
 * `skip` is proved from a conservative visible upper source; `exactMatch` is
 * proved only inside a safe visible prefix. Uncertain Markdown falls through to
 * the canonical projector.
 */
export function getAssistantSearchFastDecision(
  message: ChatMessage,
  query: { exactPhrase: string; terms: readonly string[] },
): AssistantSearchFastDecision {
  if (message.role !== "assistant") return "project";
  if (message.apiOnly || message.isSystemNotice) return "skip";
  if (!isCompletedAssistantAnswer(message)) return "skip";
  if (
    !query.terms.length ||
    query.terms.some((term) => !safePrefilterTerm.test(term))
  ) {
    return "project";
  }
  const transportSource = buildAssistantTransportSearchSource(message.content);
  const visibleTransportSource = transportSource.text;

  let prefilterSource: string | null = null;
  if (
    !transportSource.literalLabelHasBracketSyntax &&
    !visibleTransportSource.includes("<")
  ) {
    prefilterSource = stripSimpleDirectLinksForPrefilter(
      visibleTransportSource,
    );
  }
  if (prefilterSource !== null && characterEntitySyntax.test(prefilterSource)) {
    if (
      /[`$\\]/u.test(prefilterSource) ||
      prefilterSource.includes("~~~") ||
      prefilterSource.includes("    ") ||
      prefilterSource.includes("\t")
    ) {
      prefilterSource = null;
    } else {
      prefilterSource = markdown.utils.unescapeAll(prefilterSource);
    }
  }
  if (
    prefilterSource !== null &&
    !linkifyCandidateSyntax.test(prefilterSource)
  ) {
    const skeleton = buildSearchWordSkeleton(prefilterSource);
    if (query.terms.some((term) => !skeleton.includes(term))) {
      return "skip";
    }
  }

  return proveAssistantExactMatch(
    prefilterSource ?? visibleTransportSource,
    query.exactPhrase,
  )
    ? "exactMatch"
    : "project";
}

/** Map a normalized half-open range outward to complete display graphemes. */
export function mapNormalizedRangeToDisplayRange(
  document: SearchDocument,
  start: number,
  end: number,
): SearchHighlightRange | null {
  if (start < 0 || end <= start || end > document.normalizedText.length) {
    return null;
  }
  const matching = document.spans.filter(
    (span) =>
      span.normalizedEnd > span.normalizedStart &&
      span.normalizedStart < end &&
      span.normalizedEnd > start,
  );
  if (!matching.length) return null;
  return {
    start: Math.min(...matching.map((span) => span.displayStart)),
    end: Math.max(...matching.map((span) => span.displayEnd)),
  };
}

function findFirstOccurrence(
  haystack: string,
  needle: string,
): SearchHighlightRange | undefined {
  if (!needle) return undefined;
  const start = haystack.indexOf(needle);
  return start < 0 ? undefined : { start, end: start + needle.length };
}

function findOccurrencesOverlappingRange(
  haystack: string,
  needle: string,
  start: number,
  end: number,
): SearchHighlightRange[] {
  if (!needle || start >= end) return [];
  const ranges: SearchHighlightRange[] = [];
  let offset = Math.max(0, start - needle.length + 1);
  const lastStart = Math.min(end - 1, haystack.length - needle.length);
  while (offset <= lastStart) {
    const occurrenceStart = haystack.indexOf(needle, offset);
    if (occurrenceStart < 0 || occurrenceStart > lastStart) break;
    const occurrenceEnd = occurrenceStart + needle.length;
    if (occurrenceEnd > start) {
      ranges.push({ start: occurrenceStart, end: occurrenceEnd });
    }
    offset = occurrenceStart + 1;
  }
  return ranges;
}

function mapNormalizedRangeToDisplayRangeInSpans(
  spans: readonly NormalizedDisplaySpan[],
  start: number,
  end: number,
): SearchHighlightRange | null {
  let displayStart = Number.POSITIVE_INFINITY;
  let displayEnd = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    if (
      span.normalizedEnd <= span.normalizedStart ||
      span.normalizedStart >= end ||
      span.normalizedEnd <= start
    ) {
      continue;
    }
    displayStart = Math.min(displayStart, span.displayStart);
    displayEnd = Math.max(displayEnd, span.displayEnd);
  }
  return Number.isFinite(displayStart) && Number.isFinite(displayEnd)
    ? { start: displayStart, end: displayEnd }
    : null;
}

function mergeRanges(ranges: SearchHighlightRange[]): SearchHighlightRange[] {
  const ordered = [...ranges].sort((left, right) =>
    left.start === right.start
      ? left.end - right.end
      : left.start - right.start,
  );
  const merged: SearchHighlightRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Build the fixed 200-grapheme, escaped-by-the-caller literal-search snippet. */
export function createSearchSnippet(
  document: SearchDocument,
  rawQuery: string,
): SearchSnippet {
  const normalizedQuery = normalizeSearchValue(rawQuery);
  const terms = [...new Set(normalizedQuery.split(" ").filter(Boolean))];
  let anchor = findFirstOccurrence(document.normalizedText, normalizedQuery);
  if (!anchor) {
    anchor = terms
      .map((term, ordinal) => ({
        range: findFirstOccurrence(document.normalizedText, term),
        ordinal,
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          range: SearchHighlightRange;
          ordinal: number;
        } => !!candidate.range,
      )
      .sort((left, right) =>
        left.range.start === right.range.start
          ? left.ordinal - right.ordinal
          : left.range.start - right.range.start,
      )[0]?.range;
  }

  const graphemes = segmentGraphemes(document.displayText);
  const anchorDisplay = anchor
    ? mapNormalizedRangeToDisplayRange(document, anchor.start, anchor.end)
    : null;
  const anchorStart = anchorDisplay
    ? Math.max(
        0,
        graphemes.findIndex((part) => part.end > anchorDisplay.start),
      )
    : 0;
  let windowStart = Math.max(0, anchorStart - 60);
  const windowEnd = Math.min(graphemes.length, windowStart + 200);
  if (windowEnd - windowStart < 200) {
    windowStart = Math.max(0, windowEnd - 200);
  }

  const displayStart = graphemes[windowStart]?.start ?? 0;
  const displayEnd =
    graphemes[windowEnd - 1]?.end ?? document.displayText.length;
  const hasPrefix = windowStart > 0;
  const hasSuffix = windowEnd < graphemes.length;
  const prefix = hasPrefix ? "…" : "";
  const suffix = hasSuffix ? "…" : "";
  const snippet =
    prefix + document.displayText.slice(displayStart, displayEnd) + suffix;

  const windowSpans = document.spans.filter(
    (span) =>
      span.normalizedEnd > span.normalizedStart &&
      span.displayStart < displayEnd &&
      span.displayEnd > displayStart,
  );
  const normalizedStart = windowSpans[0]?.normalizedStart ?? 0;
  const normalizedEnd =
    windowSpans.at(-1)?.normalizedEnd ?? document.normalizedText.length;
  const exactRanges = findOccurrencesOverlappingRange(
    document.normalizedText,
    normalizedQuery,
    normalizedStart,
    normalizedEnd,
  );
  const termRanges = terms.flatMap((term) =>
    findOccurrencesOverlappingRange(
      document.normalizedText,
      term,
      normalizedStart,
      normalizedEnd,
    ),
  );
  const mapped = [...exactRanges, ...termRanges]
    .map((range) =>
      mapNormalizedRangeToDisplayRangeInSpans(
        windowSpans,
        range.start,
        range.end,
      ),
    )
    .filter((range): range is SearchHighlightRange => !!range)
    .filter((range) => range.start < displayEnd && range.end > displayStart)
    .map((range) => ({
      start: prefix.length + Math.max(range.start, displayStart) - displayStart,
      end: prefix.length + Math.min(range.end, displayEnd) - displayStart,
    }));

  return { snippet, highlightRanges: mergeRanges(mapped) };
}
