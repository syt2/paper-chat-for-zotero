import MarkdownIt from "markdown-it";

const noteMarkdown = new MarkdownIt({
  html: false,
  breaks: true,
  xhtmlOut: true,
  linkify: true,
  typographer: true,
});

function isAllowedNoteLink(destination: string): boolean {
  return (
    destination.startsWith("#") || /^(?:https?:\/\/|mailto:)/i.test(destination)
  );
}

noteMarkdown.validateLink = isAllowedNoteLink;

interface InlineMathScan {
  escaped: Uint8Array;
  lineEndAt: Int32Array;
  nextSingleDollarAt: Int32Array;
  nextDoubleDollarAt: Int32Array;
  nextBracketCloseAt: Int32Array;
  adjacentDollarOpeners: Set<number>;
}

const inlineMathScans = new WeakMap<object, InlineMathScan>();

function createInlineMathScan(source: string): InlineMathScan {
  const escaped = new Uint8Array(source.length);
  let precedingBackslashes = 0;
  for (let index = 0; index < source.length; index += 1) {
    escaped[index] = precedingBackslashes % 2;
    if (source.charCodeAt(index) === 0x5c) {
      precedingBackslashes += 1;
    } else {
      precedingBackslashes = 0;
    }
  }

  const lineEndAt = new Int32Array(source.length + 1);
  const nextSingleDollarAt = new Int32Array(source.length + 1);
  const nextDoubleDollarAt = new Int32Array(source.length + 1);
  const nextBracketCloseAt = new Int32Array(source.length + 1);
  nextSingleDollarAt.fill(-1);
  nextDoubleDollarAt.fill(-1);
  nextBracketCloseAt.fill(-1);

  let lineEnd = source.length;
  let nextSingleDollar = -1;
  let nextDoubleDollar = -1;
  let nextBracketClose = -1;
  lineEndAt[source.length] = source.length;

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const code = source.charCodeAt(index);
    if (code === 0x0a) {
      lineEnd = index;
    }
    lineEndAt[index] = lineEnd;

    if (code === 0x24 && escaped[index] === 0) {
      const previous = source[index - 1] || "";
      const nextCode = source.charCodeAt(index + 1);
      if (!/\s/.test(previous) && !(nextCode >= 0x30 && nextCode <= 0x39)) {
        nextSingleDollar = index;
      }
      if (nextCode === 0x24) {
        nextDoubleDollar = index;
      }
    }
    if (
      code === 0x5c &&
      source.charCodeAt(index + 1) === 0x29 &&
      escaped[index] === 0
    ) {
      nextBracketClose = index;
    }

    nextSingleDollarAt[index] = nextSingleDollar;
    nextDoubleDollarAt[index] = nextDoubleDollar;
    nextBracketCloseAt[index] = nextBracketClose;
  }

  return {
    escaped,
    lineEndAt,
    nextSingleDollarAt,
    nextDoubleDollarAt,
    nextBracketCloseAt,
    adjacentDollarOpeners: new Set<number>(),
  };
}

function getInlineMathScan(state: object & { src: string }): InlineMathScan {
  let scan = inlineMathScans.get(state);
  if (!scan) {
    scan = createInlineMathScan(state.src);
    inlineMathScans.set(state, scan);
  }
  return scan;
}

interface BlockMathState {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  listIndent: number;
  parentType: string;
}

interface BlockMathScanContext {
  fromLine: number;
  toLine: number;
  closingLines: number[];
}

const blockMathScans = new WeakMap<
  object,
  Map<string, BlockMathScanContext[]>
>();

function findBlockMathClosingLine(
  state: object & BlockMathState,
  startLine: number,
  endLine: number,
  closing: string,
): number {
  let scansByContext = blockMathScans.get(state);
  if (!scansByContext) {
    scansByContext = new Map<string, BlockMathScanContext[]>();
    blockMathScans.set(state, scansByContext);
  }

  const contextKey = [
    closing,
    endLine,
    state.blkIndent,
    state.listIndent,
    state.parentType,
  ].join(":");
  let contexts = scansByContext.get(contextKey);
  if (!contexts) {
    contexts = [];
    scansByContext.set(contextKey, contexts);
  }

  let context: BlockMathScanContext | undefined;
  let contextLow = 0;
  let contextHigh = contexts.length;
  while (contextLow < contextHigh) {
    const middle = Math.floor((contextLow + contextHigh) / 2);
    if (contexts[middle].fromLine <= startLine) {
      contextLow = middle + 1;
    } else {
      contextHigh = middle;
    }
  }
  const precedingContext = contexts[contextLow - 1];
  if (precedingContext && startLine < precedingContext.toLine) {
    context = precedingContext;
  }
  if (!context) {
    const closingLines: number[] = [];
    let toLine = endLine;
    for (let line = startLine + 1; line < endLine; line += 1) {
      const lineStart = state.bMarks[line] + state.tShift[line];
      const lineEnd = state.eMarks[line];
      if (lineStart < lineEnd && state.sCount[line] < state.blkIndent) {
        toLine = line;
        break;
      }
      if (state.src.slice(lineStart, lineEnd).trim() === closing) {
        closingLines.push(line);
      }
    }
    context = { fromLine: startLine, toLine, closingLines };
    contexts.push(context);
  }

  let low = 0;
  let high = context.closingLines.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (context.closingLines[middle] <= startLine) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return context.closingLines[low] ?? -1;
}

function installZoteroNoteMath(md: MarkdownIt): void {
  md.inline.ruler.before(
    "escape",
    "zotero_note_math_inline",
    (state, silent) => {
      const source = state.src;
      const start = state.pos;
      const bracketPrefix = source.startsWith("\\(", start);
      const dollarPrefix = source.charCodeAt(start) === 0x24;
      if (!bracketPrefix && !dollarPrefix) {
        return false;
      }

      const scan = getInlineMathScan(state);
      const bracketDelimited = bracketPrefix && scan.escaped[start] === 0;
      const dollarDelimited = dollarPrefix && scan.escaped[start] === 0;
      if (!bracketDelimited && !dollarDelimited) {
        return false;
      }

      let contentStart = start;
      let contentEnd = -1;
      let closingLength = 0;
      const inlineEnd = Math.min(scan.lineEndAt[start], state.posMax);

      if (bracketDelimited) {
        contentStart = start + 2;
        contentEnd = scan.nextBracketCloseAt[contentStart];
        closingLength = 2;
      } else if (source.charCodeAt(start) === 0x24) {
        if (
          start > 0 &&
          source.charCodeAt(start - 1) === 0x24 &&
          scan.escaped[start - 1] === 0 &&
          !scan.adjacentDollarOpeners.has(start)
        ) {
          return false;
        }
        const delimiterLength: 1 | 2 = source.startsWith("$$", start) ? 2 : 1;
        if (
          delimiterLength === 1 &&
          /\s/.test(source[start + delimiterLength] || "")
        ) {
          return false;
        }
        contentStart = start + delimiterLength;
        contentEnd =
          delimiterLength === 2
            ? scan.nextDoubleDollarAt[contentStart]
            : scan.nextSingleDollarAt[contentStart];
        closingLength = delimiterLength;
      }

      if (contentEnd < contentStart || contentEnd + closingLength > inlineEnd) {
        return false;
      }
      const content = source.slice(contentStart, contentEnd).trim();
      if (!content) {
        return false;
      }

      if (!silent) {
        const token = state.push("zotero_note_math_inline", "math", 0);
        token.content = content;
      }
      state.pos = contentEnd + closingLength;
      if (closingLength === 1 && source.charCodeAt(state.pos) === 0x24) {
        scan.adjacentDollarOpeners.add(state.pos);
      }
      return true;
    },
  );

  md.block.ruler.before(
    "paragraph",
    "zotero_note_math_block",
    (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const lineEnd = state.eMarks[startLine];
      const firstLine = state.src.slice(start, lineEnd).trim();
      const dollarDelimited = firstLine.startsWith("$$");
      const bracketDelimited = firstLine.startsWith("\\[");
      if (!dollarDelimited && !bracketDelimited) {
        return false;
      }

      const opening = dollarDelimited ? "$$" : "\\[";
      const closing = dollarDelimited ? "$$" : "\\]";
      const singleLine =
        firstLine.length > opening.length + closing.length &&
        firstLine.endsWith(closing);
      const afterOpening = singleLine
        ? firstLine.slice(opening.length, -closing.length).trim()
        : "";
      if (singleLine && afterOpening) {
        if (silent) {
          return true;
        }
        const token = state.push("zotero_note_math_block", "math", 0);
        token.content = afterOpening;
        token.map = [startLine, startLine + 1];
        state.line = startLine + 1;
        return true;
      }

      // Multiline display math deliberately requires a standalone opening
      // delimiter. Besides matching conventional Markdown math, this avoids
      // repeatedly scanning the rest of a note for ordinary `$$price` text.
      if (firstLine !== opening) {
        return false;
      }

      const closingLine = findBlockMathClosingLine(
        state,
        startLine,
        endLine,
        closing,
      );
      if (closingLine < 0) {
        return false;
      }

      const lines: string[] = [];
      for (let line = startLine + 1; line < closingLine; line += 1) {
        lines.push(
          state.src.slice(
            state.bMarks[line] + state.tShift[line],
            state.eMarks[line],
          ),
        );
      }
      const content = lines.join("\n").trim();
      if (!content) {
        return false;
      }
      if (silent) {
        return true;
      }

      const token = state.push("zotero_note_math_block", "math", 0);
      token.content = content;
      token.map = [startLine, closingLine + 1];
      state.line = closingLine + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );

  md.renderer.rules.zotero_note_math_inline = (tokens, index) =>
    `<span class="math">$${md.utils.escapeHtml(tokens[index].content)}$</span>`;
  md.renderer.rules.zotero_note_math_block = (tokens, index) =>
    `<pre class="math">$$${md.utils.escapeHtml(tokens[index].content)}$$</pre>\n`;

  // Zotero's note schema does not allow math_inline nodes inside headings.
  // Keep the source readable there instead of creating HTML that the editor
  // will normalize unpredictably on its first round trip.
  md.core.ruler.after("text_join", "zotero_note_math_heading", (state) => {
    for (let index = 0; index < state.tokens.length - 1; index += 1) {
      if (state.tokens[index].type !== "heading_open") {
        continue;
      }
      const inline = state.tokens[index + 1];
      for (const child of inline.children || []) {
        if (child.type !== "zotero_note_math_inline") {
          continue;
        }
        child.type = "text";
        child.tag = "";
        child.nesting = 0;
        child.content = `$${child.content}$`;
      }
    }
  });
}

installZoteroNoteMath(noteMarkdown);

// A model-authored Markdown image must not become an automatic remote request
// when the user opens the Zotero note. Preserve its destination as a link.
noteMarkdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const source = token.attrGet("src") || "";
  const label = token.content.trim() || source || "image";
  const escapedLabel = noteMarkdown.utils.escapeHtml(label);
  if (!source) {
    return escapedLabel;
  }
  return `<a href="${noteMarkdown.utils.escapeHtml(source)}">${escapedLabel}</a>`;
};

export function markdownToNoteHtml(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return "";
  }
  return noteMarkdown.render(trimmed).trim();
}
