const ELLIPSIS = "…";
const WORD_JOINER = "\u2060";
const NON_BREAKING_SPACE = "\u00a0";

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function characterWidthUnits(character: string): number {
  if (character === WORD_JOINER) return 0;
  if (/\s/u.test(character)) return 0.3;
  if (/[\u2e80-\u9fff\uf900-\ufaff]/u.test(character)) return 1;
  if (/[ilI1.,:;!|]/u.test(character)) return 0.28;
  if (/[MW@#%&]/u.test(character)) return 0.78;
  return 0.52;
}

/**
 * Keep scientific quantities readable in PowerPoint's CJK line breaker.
 *
 * Office may split a compact quantity between the number and its unit even
 * when the source string has no normal word boundary (for example `3GB` or
 * `65 万`). Word joiners protect adjacent forms while a non-breaking space
 * preserves intentional visual spacing. The characters are invisible and the
 * render verifier removes them before comparing audience-facing copy.
 */
export function protectPresentationQuantities(value: string): string {
  const units = [
    "%",
    "％",
    "‰",
    "个百分点",
    "pp",
    "px",
    "pt",
    "ns",
    "μs",
    "µs",
    "ms",
    "sec",
    "min",
    "hr",
    "Hz",
    "kHz",
    "MHz",
    "GHz",
    "KB",
    "MB",
    "GB",
    "TB",
    "bit",
    "bits",
    "mm",
    "cm",
    "km",
    "μm",
    "µm",
    "nm",
    "kg",
    "mg",
    "μg",
    "µg",
    "mV",
    "kV",
    "mA",
    "kA",
    "mW",
    "kW",
    "MW",
    "kJ",
    "mM",
    "μM",
    "µM",
    "nM",
    "pM",
    "°C",
    "℃",
    "万",
    "亿",
    "千",
    "百",
    "秒",
    "分钟",
    "小时",
    "天",
    "周",
    "个月",
    "月",
    "年",
    "层",
    "路",
    "张",
    "类",
    "次",
    "倍",
    "点",
  ].sort((left, right) => right.length - left.length);
  const unitPattern = units
    .map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const quantityPattern = new RegExp(
    `([+\\-−]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)([ \\t]*)(?:${unitPattern})`,
    "giu",
  );

  const protectedValue = value.replace(
    quantityPattern,
    (match, number, spacing) => {
      const unit = match.slice(String(number).length + String(spacing).length);
      const protectedNumber = Array.from(String(number)).join(WORD_JOINER);
      return spacing
        ? `${protectedNumber}${NON_BREAKING_SPACE}${unit}`
        : `${protectedNumber}${WORD_JOINER}${unit}`;
    },
  );

  // Grouped and decimal numbers can still be split by Office's CJK line
  // breaker even when they do not carry a recognized unit. Keep the numeric
  // token itself intact; the joiners are invisible and stripped by the
  // verifier before audience-facing text comparison.
  return protectedValue.replace(
    /(^|[^A-Za-z0-9\u2060])(\d{1,3}(?:,\d{3})+(?:\.\d+)?)(?![A-Za-z0-9\u2060])/g,
    (_match, prefix, number) =>
      `${prefix}${Array.from(String(number)).join(WORD_JOINER)}`,
  );
}

/**
 * Keep Latin scientific terms and numbered evidence labels indivisible.
 *
 * PowerPoint applies CJK line-breaking rules to an entire mixed-script text
 * box and may split even short tokens such as `CNN`, `Top-5`, or `Table 1`.
 * Protecting this at the shared text-entry boundary is more reliable than
 * remembering to patch individual layouts.
 */
export function protectPresentationInlineTokens(value: string): string {
  const protectedAnchors = value.replace(
    /\b(?:fig(?:ure)?|table)\.?\s+\d+[A-Za-z]?\b/giu,
    (anchor) =>
      Array.from(anchor.replace(/\s+/g, NON_BREAKING_SPACE)).join(WORD_JOINER),
  );
  return protectPresentationQuantities(protectedAnchors).replace(
    /[A-Za-z][A-Za-z0-9+./:_-]*/g,
    (token) => Array.from(token).join(WORD_JOINER),
  );
}

/**
 * Apply full token protection only where PowerPoint's CJK line breaker is
 * likely to split Latin copy. Ordinary English paragraphs retain their normal
 * word boundaries; mixed-script copy and compact scientific labels do not.
 */
export function protectPresentationVisibleText(value: string): string {
  const protectedTokens = /[\u2e80-\u9fff\uf900-\ufaff]/u.test(value)
    ? protectPresentationInlineTokens(value)
    : value
        .replace(/\b(?:fig(?:ure)?|table)\.?\s+\d+[A-Za-z]?\b/giu, (anchor) =>
          Array.from(anchor.replace(/\s+/g, NON_BREAKING_SPACE)).join(
            WORD_JOINER,
          ),
        )
        .replace(/\b[A-Z]{2,5}\b/g, (token) =>
          Array.from(token).join(WORD_JOINER),
        )
        .replace(
          /\b[A-Za-z]*[a-z][A-Za-z0-9+./:_-]*[A-Z][A-Za-z0-9+./:_-]*\b/g,
          (token) => Array.from(token).join(WORD_JOINER),
        )
        .replace(/\b[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9-]+\b/g, (token) =>
          Array.from(token).join(WORD_JOINER),
        );

  // Office and LibreOffice can place closing CJK punctuation on a line by
  // itself in narrow conclusion or callout columns. Bind the mark to the
  // preceding visible character. The verifier strips the invisible joiner
  // before comparing audience-facing copy.
  return protectedTokens.replace(
    /([^\s\u2060])([，。！？；：、）》】”’])/gu,
    `$1${WORD_JOINER}$2`,
  );
}

function textWidthUnits(value: string): number {
  return Array.from(normalizeText(value)).reduce(
    (total, character) => total + characterWidthUnits(character),
    0,
  );
}

/**
 * PowerPoint and LibreOffice may break a Latin scientific token at any
 * character when it is embedded directly in CJK copy. Insert a semantic line
 * break before the token when the current line cannot hold it intact. This
 * keeps titles such as "...ImageNet..." from rendering as "ImageN / et" while
 * leaving the audience-facing text unchanged.
 */
export function wrapMixedScriptTitle(
  value: string,
  widthInches: number,
  fontSize: number,
): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!/[\u2e80-\u9fff\uf900-\ufaff]/u.test(normalized)) return normalized;

  // Leave a small safety margin for PowerPoint's actual font metrics. Without
  // explicit semantic line breaks it may wrap one character earlier than our
  // estimate and split a short CJK word such as “跨越” across two lines.
  const lineCapacity =
    (Math.max(8, widthInches * 72) / Math.max(1, fontSize)) * 0.94;
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale: string,
        options: { granularity: "word" },
      ) => { segment: (input: string) => Iterable<{ segment: string }> };
    }
  ).Segmenter;
  const segments = Segmenter
    ? Array.from(
        new Segmenter("zh-CN", { granularity: "word" }).segment(normalized),
        (entry) => entry.segment,
      )
    : normalized.match(
        /[A-Za-z0-9][A-Za-z0-9+./:_-]*|[\u2e80-\u9fff\uf900-\ufaff]{1,2}|[^A-Za-z0-9\u2e80-\u9fff\uf900-\ufaff]+/gu,
      ) || [normalized];
  let currentWidth = 0;
  let output = "";

  for (const segment of segments) {
    const segmentWidth = textWidthUnits(segment);
    const closingPunctuation = /^[，。！？、；：,.!?;:）】》]/u.test(segment);
    if (
      currentWidth > 0 &&
      currentWidth + segmentWidth > lineCapacity &&
      segmentWidth <= lineCapacity &&
      !closingPunctuation
    ) {
      output = output.replace(/[ \t]+$/u, "");
      output += "\n";
      currentWidth = 0;
    }

    output += segment;
    for (const character of Array.from(segment)) {
      if (character === "\n") {
        currentWidth = 0;
        continue;
      }
      const width = characterWidthUnits(character);
      currentWidth += width;
    }
  }
  const lines = output.split("\n");
  if (lines.length < 2) return output;
  const lastLine = lines.at(-1)?.trim() || "";
  const previousLine = lines.at(-2)?.trimEnd() || "";
  if (
    !lastLine ||
    textWidthUnits(lastLine) >= lineCapacity * 0.28 ||
    !previousLine
  ) {
    return output;
  }

  // A final two-character CJK orphan looks accidental on an academic cover.
  // Pull the previous scientific token (or a short CJK phrase) onto the last
  // line when both lines still fit comfortably. This turns, for example,
  // `... ImageNet / 分类` into `... / ImageNet 分类` without shrinking type.
  const trailing = previousLine.match(
    /(?:^|\s)([A-Za-z][A-Za-z0-9+./:_-]*)\s*$|([\u2e80-\u9fff\uf900-\ufaff]{2,4})\s*$/u,
  );
  const token = trailing?.[1] || trailing?.[2] || "";
  if (!token) return output;
  const remainingPrevious = previousLine
    .slice(0, previousLine.length - token.length)
    .trimEnd();
  const rebalancedLast = /^[A-Za-z]/u.test(token)
    ? `${token} ${lastLine}`
    : `${token}${lastLine}`;
  if (
    !remainingPrevious ||
    textWidthUnits(remainingPrevious) < lineCapacity * 0.35 ||
    textWidthUnits(rebalancedLast) > lineCapacity * 0.88
  ) {
    return output;
  }
  lines[lines.length - 2] = remainingPrevious;
  lines[lines.length - 1] = rebalancedLast;
  return lines.join("\n");
}

export interface TimelineColumnLayout {
  markerX: number;
  boxX: number;
  boxWidth: number;
}

/**
 * A conclusion timeline is a set of equal editorial columns, not a series of
 * tiny labels centered on the two endpoints of a line. Equal columns give
 * three- and four-step research roadmaps enough width for readable CJK copy.
 */
export function layoutTimelineColumns(
  stepCount: number,
  regionX = 0.72,
  regionWidth = 11.88,
): TimelineColumnLayout[] {
  const count = Math.max(1, Math.floor(stepCount));
  const columnWidth = regionWidth / count;
  const boxWidth = Math.min(3.15, Math.max(1.72, columnWidth - 0.42));
  return Array.from({ length: count }, (_, index) => {
    const markerX = regionX + columnWidth * (index + 0.5);
    return {
      markerX,
      boxX: markerX - boxWidth / 2,
      boxWidth,
    };
  });
}

export function estimateWrappedLineCount(
  value: string,
  widthInches: number,
  fontSize: number,
): number {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return 0;
  const availablePoints = Math.max(8, widthInches * 72);
  const lineCapacity = availablePoints / Math.max(1, fontSize);
  let lines = 1;
  let currentWidth = 0;
  for (const character of Array.from(normalized)) {
    if (character === "\n") {
      lines += 1;
      currentWidth = 0;
      continue;
    }
    const width = characterWidthUnits(character);
    if (currentWidth > 0 && currentWidth + width > lineCapacity) {
      lines += 1;
      currentWidth = width;
    } else {
      currentWidth += width;
    }
  }
  return lines;
}

export function estimateTextBoxHeight(
  value: string,
  widthInches: number,
  fontSize: number,
  lineHeight: number = 1.18,
): number {
  const lines = estimateWrappedLineCount(value, widthInches, fontSize);
  if (lines === 0) return 0;
  return (lines * fontSize * lineHeight) / 72;
}

export interface ProcessStepTextLayout {
  titleFontSize: number;
  titleHeight: number;
  detailFontSize: number;
  detailHeight: number;
}

/**
 * Process nodes must reserve the height their copy actually needs. Relying on
 * PowerPoint's shrink-to-fit inside two fixed one-line boxes makes a valid
 * four-stage method unreadable after CJK or mixed scientific terms wrap.
 */
export function layoutProcessStepText(
  title: string,
  detail: string | undefined,
  widthInches: number,
  stepCount: number,
): ProcessStepTextLayout {
  const titleFontSize = stepCount >= 4 ? 16.8 : 17.5;
  const detailFontSize = stepCount >= 4 ? 12.2 : 12.8;
  const titleHeight = Math.max(
    0.4,
    Math.min(
      0.62,
      estimateTextBoxHeight(title, widthInches, titleFontSize, 1.08) + 0.04,
    ),
  );
  const detailHeight = detail
    ? Math.max(
        0.38,
        Math.min(
          0.7,
          estimateTextBoxHeight(detail, widthInches, detailFontSize, 1.08) +
            0.04,
        ),
      )
    : 0;
  return { titleFontSize, titleHeight, detailFontSize, detailHeight };
}

export interface ChartTextLayout {
  catAxisLabelFontSize: number;
  layout?: { x: number; y: number; w: number; h: number };
}

/**
 * Horizontal bar charts need an explicit plot-area gutter for category text.
 * Otherwise PowerPoint and LibreOffice both let the plot consume the whole
 * chart frame and clip long labels against the left edge.
 */
export function resolveChartTextLayout(
  labels: readonly string[],
  orientation: "horizontal" | "vertical" | undefined,
  hasLegend: boolean,
): ChartTextLayout {
  const longestLabel = labels.reduce(
    (longest, label) => Math.max(longest, textWidthUnits(label)),
    0,
  );
  const catAxisLabelFontSize =
    longestLabel > 22 ? 8.5 : longestLabel > 15 ? 9 : 9.5;
  if (orientation !== "horizontal") return { catAxisLabelFontSize };

  const leftGutter = Math.max(
    0.23,
    Math.min(0.37, 0.2 + longestLabel * 0.0075),
  );
  return {
    catAxisLabelFontSize,
    layout: {
      x: leftGutter,
      y: 0.12,
      w: Math.max(0.5, 0.94 - leftGutter),
      h: hasLegend ? 0.68 : 0.76,
    },
  };
}

function truncateAtWordBoundary(
  value: string,
  maximumCharacters: number,
): string {
  const characters = Array.from(value);
  if (characters.length <= maximumCharacters) return value;
  const candidate = characters
    .slice(0, Math.max(1, maximumCharacters - 1))
    .join("");
  const boundary = Math.max(
    candidate.lastIndexOf(" "),
    candidate.lastIndexOf("，"),
    candidate.lastIndexOf(","),
    candidate.lastIndexOf("；"),
    candidate.lastIndexOf(";"),
  );
  const trimmed = (
    boundary >= maximumCharacters * 0.62
      ? candidate.slice(0, boundary)
      : candidate
  ).trimEnd();
  return `${trimmed}${ELLIPSIS}`;
}

export interface FigureCaptionLayout {
  text: string;
  height: number;
}

function completeEditorialCaption(
  value: string,
  maximumCharacters: number,
): string {
  const characters = Array.from(value);
  if (characters.length <= maximumCharacters) return value;

  const anchorLength =
    value.match(/^(?:fig(?:ure)?|table)\.?\s*\d+[A-Za-z]?\s*[:.：。]?/iu)?.[0]
      .length || 0;
  const minimumSemanticLength = Math.max(24, anchorLength + 18);
  const softMaximum = Math.min(
    characters.length,
    maximumCharacters + Math.min(42, Math.floor(maximumCharacters * 0.28)),
  );
  const candidate = characters.slice(0, softMaximum).join("");

  const sentenceEnds = Array.from(candidate.matchAll(/[.!?。！？](?=\s|$)/gu))
    .map((match) => (match.index || 0) + match[0].length)
    .filter((index) => index >= minimumSemanticLength);
  if (sentenceEnds.length > 0) {
    return candidate.slice(0, sentenceEnds[0]).trimEnd();
  }

  const strictCandidate = characters.slice(0, maximumCharacters).join("");
  const clauseEnds = Array.from(strictCandidate.matchAll(/[,，;；](?=\s|$)/gu))
    .map((match) => (match.index || 0) + match[0].length)
    .filter((index) => index >= minimumSemanticLength);
  if (clauseEnds.length > 0) {
    const clause = strictCandidate.slice(0, clauseEnds.at(-1)).trimEnd();
    return `${clause.replace(/[,，;；]+$/u, "")}${/[\u2e80-\u9fff\uf900-\ufaff]/u.test(clause) ? "。" : "."}`;
  }

  const wordBoundary = Math.max(
    strictCandidate.lastIndexOf(" "),
    strictCandidate.lastIndexOf("，"),
    strictCandidate.lastIndexOf(","),
  );
  const complete = (
    wordBoundary >= minimumSemanticLength
      ? strictCandidate.slice(0, wordBoundary)
      : strictCandidate
  ).trimEnd();
  return `${complete.replace(/[,，;；:：]+$/u, "")}${/[\u2e80-\u9fff\uf900-\ufaff]/u.test(complete) ? "。" : "."}`;
}

/**
 * Render verification should prove that the audience-facing caption exists,
 * without requiring the full source paragraph to fit on the slide. The
 * renderer deliberately shortens long paper captions, so use a stable leading
 * anchor shared with the same normalization rules as the visible caption.
 */
export function figureCaptionVerificationAnchor(value: string): string {
  const normalized = normalizeText(value);
  if (Array.from(normalized).length <= 64) return normalized;
  return truncateAtWordBoundary(normalized, 64)
    .replace(new RegExp(`${ELLIPSIS}$`), "")
    .trimEnd();
}

/**
 * Keeps the source caption intact in notes/alt text while making the visible
 * caption editorial rather than a paragraph. Long captions end at a complete
 * sentence or clause; the renderer must never publish a visibly truncated
 * caption with an ellipsis.
 */
export function layoutFigureCaption(
  value: string,
  widthInches: number,
): FigureCaptionLayout {
  const normalized = normalizeText(value);
  const maximumCharacters = Math.max(
    72,
    Math.min(210, Math.floor(widthInches * 32)),
  );
  const text = completeEditorialCaption(normalized, maximumCharacters);
  // Captions render at 10.2 pt. Estimating them at 8.6 pt under-counted lines
  // and produced clipped final lines or a single orphan at the slide bottom.
  const lines = Math.min(4, estimateWrappedLineCount(text, widthInches, 10.2));
  return {
    text,
    height: Math.max(0.34, Math.min(0.88, 0.34 + (lines - 1) * 0.18)),
  };
}
