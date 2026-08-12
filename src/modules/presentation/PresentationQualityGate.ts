import type {
  PresentationFigure,
  PresentationRequest,
  PresentationSlide,
} from "./PresentationSchema";

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function isPlaceholderText(value: string | undefined): boolean {
  return /^(?:placeholder|占位|占位图)$/i.test(value?.trim() || "");
}

function visibleSlideText(slide: PresentationSlide): string[] {
  return [
    slide.section,
    slide.eyebrow,
    slide.title,
    slide.subtitle,
    slide.keyMessage,
    ...(slide.bullets || []),
    ...(slide.groups || []).flatMap((group) => [group.title, ...group.bullets]),
    ...(slide.metrics || []).flatMap((metric) => [
      metric.value,
      metric.label,
      metric.detail,
    ]),
    ...(slide.callouts || []).flatMap((callout) => [
      callout.label,
      callout.text,
    ]),
    ...(slide.process || []).flatMap((step) => [step.title, step.detail]),
    ...(slide.timeline || []).flatMap((step) => [
      step.label,
      step.milestone,
      step.detail,
    ]),
    ...(slide.comparison
      ? [
          slide.comparison.left.title,
          ...slide.comparison.left.bullets,
          slide.comparison.right.title,
          ...slide.comparison.right.bullets,
        ]
      : []),
    ...(slide.matrix
      ? [
          slide.matrix.banner,
          ...slide.matrix.columns,
          ...slide.matrix.rows.flatMap((row) => [row.label, ...row.cells]),
        ]
      : []),
    ...(slide.table?.headers || []),
    ...(slide.table?.rows.flat() || []),
    slide.equation?.label,
    slide.equation?.expression,
    slide.equation?.explanation,
    slide.figure?.caption,
    slide.figure?.captionHint,
    ...(slide.figures || []).flatMap((figure) => [
      figure.caption,
      figure.captionHint,
    ]),
    slide.notes,
    slide.source,
  ].filter((value): value is string => typeof value === "string");
}

function hasVisualEvidence(slide: PresentationSlide): boolean {
  return Boolean(
    slide.figure ||
    slide.figures?.length ||
    slide.chart ||
    slide.table ||
    slide.process?.length ||
    slide.comparison ||
    slide.metrics?.length ||
    slide.equation ||
    slide.matrix ||
    slide.timeline?.length,
  );
}

function hasStructuredResult(slide: PresentationSlide): boolean {
  return Boolean(
    slide.chart || slide.table || slide.matrix || slide.comparison,
  );
}

function evidenceModuleCount(slide: PresentationSlide): number {
  return (
    (slide.figure ? 1 : 0) +
    (slide.figures?.length || 0) +
    (slide.chart ? 1 : 0) +
    (slide.table ? 1 : 0) +
    (slide.process ? 1 : 0) +
    (slide.comparison ? 1 : 0) +
    (slide.metrics?.length ? 1 : 0) +
    (slide.equation ? 1 : 0) +
    (slide.matrix ? 1 : 0) +
    (slide.timeline ? 1 : 0)
  );
}

/**
 * Development builds keep every editorial heuristic blocking so planner drift
 * is visible immediately. Production has already passed the TypeBox schema,
 * so planning-quality diagnostics are advisory: the renderer, preview pass,
 * explicit render-safety review, and final write are the release gates.
 *
 * Do not replace this with a denylist of editorial messages. New quality rules
 * are added frequently, and a denylist makes each new rule an accidental
 * production export blocker until somebody remembers to classify it.
 */
export function filterBlockingPresentationQualityIssues(
  issues: string[],
  strict: boolean,
): string[] {
  return strict ? issues : [];
}

export function shouldUseStrictPresentationQualityGate(
  environment: string | undefined,
): boolean {
  return environment !== "production";
}

function slideFigures(slide: PresentationSlide): PresentationFigure[] {
  return [...(slide.figure ? [slide.figure] : []), ...(slide.figures || [])];
}

function isTableFigure(figure: PresentationFigure): boolean {
  const caption = `${figure.captionHint || ""} ${figure.caption || ""}`
    .normalize("NFKC")
    .trim();
  return /^(?:table|tab\.?|表)\s*[A-Za-z0-9一二三四五六七八九十]/iu.test(
    caption,
  );
}

function isDensePlotFigure(figure: PresentationFigure): boolean {
  const caption = `${figure.captionHint || ""} ${figure.caption || ""}`
    .normalize("NFKC")
    .toLocaleLowerCase();
  return /(?:training|validation|test|error|accuracy|loss|curve|plot|graph|trajectory|convergence|训练|验证|测试|误差|错误率|准确率|损失|曲线|收敛)/u.test(
    caption,
  );
}

function figureSignature(figure: PresentationFigure): string {
  const crop = figure.crop
    ? `${figure.crop.x}:${figure.crop.y}:${figure.crop.width}:${figure.crop.height}`
    : "auto";
  return [
    figure.itemKey || "request-item",
    figure.page,
    figure.captionHint || "",
    crop,
  ].join("|");
}

function figureEvidenceIdentity(
  figure: PresentationFigure,
  defaultItemKey?: string,
): string {
  const caption = (figure.captionHint || figure.caption || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const latinAnchor = caption.match(
    /(?:^|\b)(fig(?:ure)?|table)\s*\.?\s*([a-z]?\d+[a-z]?)/i,
  );
  const cjkAnchor = caption.match(
    /(?:^|\s)(图|表)\s*([0-9一二三四五六七八九十]+)/u,
  );
  const anchor = latinAnchor
    ? `${latinAnchor[1].startsWith("tab") ? "table" : "figure"}:${latinAnchor[2]}`
    : cjkAnchor
      ? `${cjkAnchor[1] === "表" ? "table" : "figure"}:${cjkAnchor[2]}`
      : caption.replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 80);
  return [
    figure.itemKey || defaultItemKey || "request-item",
    figure.page,
    anchor || "unanchored",
  ].join("|");
}

function cropsMateriallyDistinct(
  left: PresentationFigure["crop"],
  right: PresentationFigure["crop"],
): boolean {
  if (!left || !right) return false;
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  );
  const intersectionArea = intersectionWidth * intersectionHeight;
  const smallerArea = Math.min(
    left.width * left.height,
    right.width * right.height,
  );
  return smallerArea > 0 && intersectionArea / smallerArea <= 0.15;
}

function countOpenDirections(slide: PresentationSlide): number {
  return (slide.callouts || []).reduce((count, callout) => {
    const questionMarks = callout.text.match(/[?？]/g)?.length || 0;
    return count + Math.max(1, questionMarks);
  }, 0);
}

function slideTextLength(slide: PresentationSlide): number {
  return [
    slide.title,
    slide.subtitle || "",
    slide.keyMessage || "",
    ...(slide.bullets || []),
    ...(slide.groups || []).flatMap((group) => [group.title, ...group.bullets]),
    ...(slide.metrics || []).flatMap((metric) => [
      metric.value,
      metric.label,
      metric.detail || "",
    ]),
    ...(slide.callouts || []).flatMap((callout) => [
      callout.label || "",
      callout.text,
    ]),
    ...(slide.process || []).flatMap((step) => [step.title, step.detail || ""]),
    ...(slide.timeline || []).flatMap((step) => [
      step.label,
      step.milestone || "",
      step.detail || "",
    ]),
    ...(slide.comparison
      ? [
          slide.comparison.left.title,
          ...slide.comparison.left.bullets,
          slide.comparison.right.title,
          ...slide.comparison.right.bullets,
        ]
      : []),
    ...(slide.matrix
      ? [
          slide.matrix.banner || "",
          ...slide.matrix.columns,
          ...slide.matrix.rows.flatMap((row) => [row.label, ...row.cells]),
        ]
      : []),
    ...(slide.table?.headers || []),
    ...(slide.table?.rows.flat() || []),
    slide.equation?.label || "",
    slide.equation?.expression || "",
    slide.equation?.explanation || "",
    ...slideFigures(slide).map((figure) =>
      Array.from(figure.caption || figure.captionHint || "")
        .slice(0, 72)
        .join(""),
    ),
  ].reduce((total, value) => total + Array.from(value).length, 0);
}

function englishWordCount(value: string): number {
  return value.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length || 0;
}

function cjkCharacterCount(value: string): number {
  return (
    value.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    )?.length || 0
  );
}

function compositionSignature(slide: PresentationSlide): string {
  if (slide.layout && slide.layout !== "auto") return slide.layout;
  if (slide.matrix) return "matrix";
  if (slide.timeline?.length) return "conclusion";
  if (slide.process?.length) return "process";
  if (slide.comparison) return "comparison";
  if ((slide.figure ? 1 : 0) + (slide.figures?.length || 0) >= 2) {
    return "gallery";
  }
  if (slide.chart || slide.table) return "data";
  if (slide.figure || slide.figures?.length) return "figure";
  if (slide.equation || slide.metrics?.length) return "evidence";
  return "statement";
}

function validateFigure(
  figure: PresentationFigure,
  path: string,
  defaultItemKey?: string,
): string[] {
  const errors: string[] = [];
  if (!figure.itemKey && !defaultItemKey) {
    errors.push(`${path}: itemKey or request-level sourceItemKey is required.`);
  }
  if (
    (figure.mode || "figure") === "figure" &&
    !figure.crop &&
    !figure.captionHint
  ) {
    errors.push(
      `${path}: figure mode requires captionHint or crop so PaperChat can extract the intended evidence reliably.`,
    );
  }
  if (
    figure.crop &&
    (figure.crop.x + figure.crop.width > 1.000_001 ||
      figure.crop.y + figure.crop.height > 1.000_001)
  ) {
    errors.push(`${path}/crop: x+width and y+height must stay within 1.`);
  }
  return errors;
}

function validateSlide(slide: PresentationSlide, index: number): string[] {
  const path = `/slides/${index}`;
  const errors: string[] = [];

  if (visibleSlideText(slide).some(isPlaceholderText)) {
    errors.push(
      `${path}: placeholder sentinel text is not presentation content. Omit unused optional modules instead of filling them with placeholder values.`,
    );
  }

  if (slide.chart) {
    const hasValues = Array.isArray(slide.chart.values);
    const hasSeries = Array.isArray(slide.chart.series);
    if (hasValues === hasSeries) {
      errors.push(`${path}/chart: provide exactly one of values or series.`);
    }
    if (
      slide.chart.values &&
      slide.chart.labels.length !== slide.chart.values.length
    ) {
      errors.push(
        `${path}/chart: labels and values must have the same length.`,
      );
    }
    for (const [seriesIndex, series] of (slide.chart.series || []).entries()) {
      if (series.values.length !== slide.chart.labels.length) {
        errors.push(
          `${path}/chart/series/${seriesIndex}: values must match the labels length.`,
        );
      }
    }
    if (
      slide.chart.highlightIndex !== undefined &&
      slide.chart.highlightIndex >= slide.chart.labels.length
    ) {
      errors.push(`${path}/chart/highlightIndex: index exceeds labels length.`);
    }
  }

  if (
    slide.table &&
    slide.table.rows.some((row) => row.length !== slide.table!.headers.length)
  ) {
    errors.push(`${path}/table: every row must match the header count.`);
  }
  if (
    slide.table?.highlightRow !== undefined &&
    slide.table.highlightRow >= slide.table.rows.length
  ) {
    errors.push(`${path}/table/highlightRow: index exceeds row count.`);
  }

  if (
    slide.matrix &&
    slide.matrix.rows.some(
      (row) => row.cells.length !== slide.matrix!.columns.length,
    )
  ) {
    errors.push(
      `${path}/matrix: every row must contain exactly one cell per column.`,
    );
  }
  if (
    slide.matrix?.highlightColumn !== undefined &&
    slide.matrix.highlightColumn >= slide.matrix.columns.length
  ) {
    errors.push(`${path}/matrix/highlightColumn: index exceeds column count.`);
  }

  if (slide.layout === "figure" && !slide.figure && !slide.figures?.length) {
    errors.push(`${path}: figure layout requires figure.`);
  }
  if (
    slide.layout === "figure" &&
    slide.keyMessage &&
    !slide.bullets?.length &&
    !slide.groups?.length &&
    !slide.metrics?.length &&
    !slide.callouts?.length
  ) {
    errors.push(
      `${path}: a figure narrative rail cannot contain only one sentence. Add at least one experiment condition, quantified result, interpretation boundary, or supporting evidence item, or remove the narrative rail and let the figure own the full canvas.`,
    );
  }
  if (slide.layout === "split" && slide.keyMessage && slide.bullets?.length) {
    errors.push(
      `${path}: split layout supports one narrative mode, either one keyMessage or at most two bullets, not both. Two stacked narratives cause text overflow and shrink the evidence canvas.`,
    );
  }
  if (slide.layout === "split" && (slide.bullets?.length || 0) > 2) {
    errors.push(`${path}: split layout supports at most two concise bullets.`);
  }
  if (
    slide.layout === "statement" &&
    (slide.figure ||
      slide.figures?.length ||
      slide.chart ||
      slide.table ||
      slide.process?.length ||
      slide.matrix ||
      slide.timeline?.length ||
      slide.comparison)
  ) {
    errors.push(
      `${path}: statement layout cannot hide supplied visual evidence. Use auto, figure, data, process, matrix, timeline, comparison, gallery, ablation, or conclusion.`,
    );
  }
  if (
    slide.layout === "data" &&
    !slide.chart &&
    !slide.table &&
    !slide.figure &&
    !slide.figures?.length &&
    !slide.matrix
  ) {
    errors.push(`${path}: data layout requires chart, table, or figure.`);
  }
  if (slide.layout === "process" && !slide.process) {
    errors.push(`${path}: process layout requires process steps.`);
  }
  if (slide.layout === "process" && (slide.process?.length || 0) > 4) {
    errors.push(
      `${path}: process layout supports at most four readable stages. Merge adjacent stages instead of shrinking the architecture figure and labels.`,
    );
  }
  if (
    slide.layout === "process" &&
    (slide.figure ? 1 : 0) + (slide.figures?.length || 0) > 1
  ) {
    errors.push(
      `${path}: process layout supports one source figure beside the pipeline. Use gallery or evidence when multiple PDF figures must remain visible.`,
    );
  }
  if (slide.layout === "process" && (slide.callouts?.length || 0) > 1) {
    errors.push(
      `${path}: process layout supports one compact callout; merge the training details or move them into a dedicated evidence slide.`,
    );
  }
  if (slide.layout === "comparison" && !slide.comparison) {
    errors.push(`${path}: comparison layout requires comparison content.`);
  }
  if (slide.layout === "comparison" && (slide.callouts?.length || 0) > 1) {
    errors.push(
      `${path}: comparison layout supports one bottom conclusion callout. Merge the messages so no supplied content is hidden.`,
    );
  }
  if (slide.layout === "matrix" && !slide.matrix) {
    errors.push(`${path}: matrix layout requires matrix content.`);
  }
  if (slide.layout === "timeline" && !slide.timeline) {
    errors.push(`${path}: timeline layout requires timeline content.`);
  }
  if (
    slide.layout === "gallery" &&
    (slide.figure ? 1 : 0) + (slide.figures?.length || 0) < 2
  ) {
    errors.push(`${path}: gallery layout requires at least two PDF figures.`);
  }
  if (
    slide.layout === "gallery" &&
    (slide.figure ? 1 : 0) + (slide.figures?.length || 0) > 2
  ) {
    errors.push(
      `${path}: gallery layout supports exactly two dominant paper figures. More figures create thumbnail grids instead of an editorial comparison.`,
    );
  }
  if (
    slide.layout === "gallery" &&
    !slide.keyMessage &&
    !slide.groups?.length &&
    !slide.bullets?.length
  ) {
    errors.push(
      `${path}: gallery layout needs one concise takeaway or two aligned insight groups below the figures so the lower canvas is intentional rather than empty.`,
    );
  }
  if (
    slide.layout !== "figure" &&
    slideFigures(slide).some(isDensePlotFigure)
  ) {
    errors.push(
      `${path}: a chart-like paper figure with axes, curves, or dense labels must use the dedicated figure layout as the primary evidence object. It cannot be a gallery panel, ablation support, process illustration, or secondary evidence thumbnail. Reconstruct exact values as an editable chart only when the paper supplies those values.`,
    );
  }
  if (
    ["figure", "gallery", "process"].includes(slide.layout || "") &&
    slideFigures(slide).some(isTableFigure)
  ) {
    errors.push(
      `${path}: rasterized paper tables cannot be the primary visual for ${slide.layout}. Rebuild the comparison as an editable chart, table, or matrix and reserve gallery/figure/process for visual evidence.`,
    );
  }
  if (
    slide.layout === "ablation" &&
    !slide.chart &&
    !slide.table &&
    !slide.matrix &&
    !slide.figure &&
    !slide.figures?.length
  ) {
    errors.push(
      `${path}: ablation layout requires one editable chart, table, matrix, or a non-table PDF figure as the dominant result.`,
    );
  }
  if (slide.layout === "ablation" && slide.chart && slide.table) {
    errors.push(
      `${path}: ablation layout accepts one dominant chart or table, not both. Move the secondary evidence to another slide so it is not hidden.`,
    );
  }
  if (
    slide.layout === "ablation" &&
    [slide.chart, slide.table, slide.matrix].filter(Boolean).length > 1
  ) {
    errors.push(
      `${path}: ablation layout accepts exactly one dominant editable result. Remove secondary charts, tables, and matrices so the result owns the canvas; one non-table supporting paper figure may remain in the evidence sidebar.`,
    );
  }
  if (
    slide.layout === "ablation" &&
    (slide.chart || slide.table || slide.matrix) &&
    slide.figure &&
    isTableFigure(slide.figure)
  ) {
    errors.push(
      `${path}: a rasterized paper table cannot serve as the ablation support visual. Keep the editable result dominant and use a non-table figure crop for the evidence sidebar.`,
    );
  }
  if (
    slide.layout === "ablation" &&
    !slide.chart &&
    !slide.table &&
    !slide.matrix &&
    slide.figure &&
    isTableFigure(slide.figure)
  ) {
    errors.push(
      `${path}: a rasterized paper table is not an acceptable ablation main visual. Reconstruct the values as an editable chart, table, or matrix.`,
    );
  }
  if (
    slide.layout === "ablation" &&
    slide.table &&
    (slide.table.rows.length > 5 || slide.table.headers.length > 4)
  ) {
    errors.push(
      `${path}: ablation table is too dense (${slide.table.rows.length} rows × ${slide.table.headers.length} columns). Keep at most five evidence rows and four columns, or convert the main comparison into an editable chart.`,
    );
  }
  if (
    slide.layout === "ablation" &&
    slide.matrix &&
    (slide.matrix.rows.length > 4 || slide.matrix.columns.length > 4)
  ) {
    errors.push(
      `${path}: ablation matrix is too dense (${slide.matrix.rows.length} rows × ${slide.matrix.columns.length} columns). Keep a focused four-by-four comparison at most.`,
    );
  }
  if (
    slide.layout === "ablation" &&
    (slide.figure ? 1 : 0) + (slide.figures?.length || 0) >
      (slide.chart || slide.table ? 1 : 2)
  ) {
    errors.push(
      `${path}: ablation layout cannot display every supplied PDF figure. Keep one supporting figure beside the dominant result, or use gallery/evidence.`,
    );
  }
  if (
    slide.layout === "conclusion" &&
    !slide.bullets?.length &&
    !slide.groups?.length &&
    !slide.timeline?.length
  ) {
    errors.push(
      `${path}: conclusion layout requires numbered findings, grouped conclusions, or milestones.`,
    );
  }
  if (
    slide.layout === "conclusion" &&
    (slide.figure ||
      slide.figures?.length ||
      slide.chart ||
      slide.table ||
      slide.matrix ||
      slide.equation ||
      slide.process?.length ||
      slide.comparison ||
      slide.metrics?.length ||
      slide.keyMessage)
  ) {
    errors.push(
      `${path}: conclusion uses a fixed editorial structure: three findings, two open questions or limitations, and a three-to-four-step roadmap. Remove figures, tables, charts, matrices, metrics, and keyMessage modules from the final slide.`,
    );
  }
  if (
    slide.layout === "conclusion" &&
    slide.timeline?.length &&
    (slide.timeline.length < 3 || slide.timeline.length > 4)
  ) {
    errors.push(
      `${path}: conclusion roadmap requires three or four readable milestones; found ${slide.timeline.length}.`,
    );
  }
  if (
    slide.layout === "conclusion" &&
    slide.timeline?.length &&
    !slide.matrix &&
    !slide.keyMessage &&
    !slide.bullets?.length &&
    !slide.groups?.length &&
    !slide.figure &&
    !slide.figures?.length &&
    !slide.callouts?.length
  ) {
    errors.push(
      `${path}: a conclusion timeline needs findings, a matrix, a key conclusion, open questions, or a source figure above it; timeline-only conclusions leave the primary canvas empty.`,
    );
  }
  if (
    slide.layout === "conclusion" &&
    slide.matrix &&
    (slide.figure || slide.figures?.length || slide.callouts?.length)
  ) {
    errors.push(
      `${path}: conclusion matrix mode uses the matrix plus findings/keyMessage and timeline. Move extra figures or callouts to the preceding evidence slide so no field is silently discarded.`,
    );
  }
  if (slide.layout === "evidence" && evidenceModuleCount(slide) < 2) {
    errors.push(
      `${path}: evidence layout requires at least two evidence modules such as PDF figures, a chart, table, equation, matrix, or metrics.`,
    );
  }
  return errors;
}

export function validatePresentationQuality(
  request: PresentationRequest,
): string[] {
  const errors: string[] = [];
  if (
    [request.title, request.subtitle, request.author].some(isPlaceholderText)
  ) {
    errors.push(
      "/title: placeholder sentinel text is not valid audience-facing presentation content.",
    );
  }
  const deckTitle = normalizeTitle(request.title);
  const firstSlideTitle = normalizeTitle(request.slides[0]?.title || "");
  if (
    deckTitle.length >= 8 &&
    firstSlideTitle.length >= 8 &&
    (deckTitle === firstSlideTitle ||
      deckTitle.startsWith(firstSlideTitle) ||
      firstSlideTitle.startsWith(deckTitle))
  ) {
    errors.push(
      "/slides/0/title: content slides must not duplicate the automatic cover. Start with the research problem, gap, or main contribution.",
    );
  }

  const visualCount = request.slides.filter(hasVisualEvidence).length;
  const isPaperDeck = Boolean(request.sourceItemKey);
  if (isPaperDeck && request.slides.length !== 5) {
    errors.push(
      `/slides: paper presentations require exactly five content slides plus the automatic cover, producing six pages total; found ${request.slides.length} content slides.`,
    );
  }
  const usesDefaultAcademicDesign =
    !request.designSystem ||
    request.designSystem === "teal-green-academic-defense";
  if (isPaperDeck && request.slides.length === 5 && usesDefaultAcademicDesign) {
    const coverMetricCount = request.coverMetrics?.length || 0;
    if (coverMetricCount < 2 || coverMetricCount > 3) {
      errors.push(
        `/coverMetrics: the default academic paper deck requires two or three paper-grounded cover metrics; found ${coverMetricCount}. Use defensible dataset, model, experiment, or headline-result values. If the paper cannot support them, fail instead of exporting a sparse cover.`,
      );
    }
    const lateEvidenceSlides = request.slides.slice(2, 4);
    if (!lateEvidenceSlides.some(hasStructuredResult)) {
      errors.push(
        "/slides/2-3: the experimental or ablation half of a full paper deck must include at least one structured result as an editable chart, table, matrix, or comparison. Two consecutive figure-only pages produce a weak evidence story; repair the plan or fail instead of exporting it.",
      );
    }
    for (const [offset, slide] of lateEvidenceSlides.entries()) {
      if (
        slide.layout === "ablation" &&
        slide.table &&
        slide.table.rows.length <= 5 &&
        slide.table.headers.length <= 4 &&
        slideFigures(slide).length === 0
      ) {
        errors.push(
          `/slides/${offset + 2}: a compact academic ablation table needs one distinct non-table PDF figure as supporting qualitative evidence when the paper supplies one. Reserve content evidence before choosing the cover hero; do not reduce a table-plus-figure result page to table-only.`,
        );
      }
    }
  }
  const minimumVisualRatio =
    isPaperDeck && request.slides.length >= 4 ? 0.8 : 0.6;
  const minimumVisualCount = Math.max(
    1,
    Math.ceil(request.slides.length * minimumVisualRatio),
  );
  if (visualCount < minimumVisualCount) {
    errors.push(
      `/slides: ${visualCount}/${request.slides.length} content slides contain visual evidence; at least ${minimumVisualCount} are required. Use real paper figures, editable charts/tables, matrices, equations, metrics, comparisons, or a method process.`,
    );
  }

  if (isPaperDeck && request.slides.length >= 4) {
    const paperFigures: Array<[PresentationFigure, string]> = [
      ...(request.coverFigure
        ? ([[request.coverFigure, "/coverFigure"]] as Array<
            [PresentationFigure, string]
          >)
        : []),
      ...(request.coverFigures || []).map(
        (figure, index) =>
          [figure, `/coverFigures/${index}`] as [PresentationFigure, string],
      ),
      ...request.slides.flatMap((slide, slideIndex) =>
        slideFigures(slide).map(
          (figure, figureIndex) =>
            [figure, `/slides/${slideIndex}/figures/${figureIndex}`] as [
              PresentationFigure,
              string,
            ],
        ),
      ),
    ];
    for (const [figure, path] of paperFigures) {
      if (figure.mode === "page") {
        errors.push(
          `${path}: full PDF pages are not acceptable visual evidence in a paper presentation. Use figure mode with an anchored captionHint; PaperChat scans neighboring PDF pages automatically.`,
        );
      }
    }

    const coverCandidates = [
      ...(request.coverFigure ? [request.coverFigure] : []),
      ...(request.coverFigures || []),
    ];
    const coverFigures = coverCandidates.filter(
      (figure, index) =>
        coverCandidates.findIndex(
          (candidate) => figureSignature(candidate) === figureSignature(figure),
        ) === index,
    );
    if (coverFigures.length > 0 && coverFigures.every(isTableFigure)) {
      errors.push(
        "/coverFigure: a paper table screenshot cannot serve as the cover hero. Use a qualitative result, sample image, learned representation, or other visually meaningful non-table figure.",
      );
    }
    const figurePlacements = [
      ...coverFigures.map((figure, index) => ({
        figure,
        path: `/coverFigures/${index}`,
      })),
      ...request.slides.flatMap((slide, slideIndex) =>
        slideFigures(slide).map((figure, figureIndex) => ({
          figure,
          path: `/slides/${slideIndex}/figures/${figureIndex}`,
        })),
      ),
    ];
    for (let leftIndex = 0; leftIndex < figurePlacements.length; leftIndex++) {
      const left = figurePlacements[leftIndex];
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < figurePlacements.length;
        rightIndex++
      ) {
        const right = figurePlacements[rightIndex];
        if (
          figureEvidenceIdentity(left.figure, request.sourceItemKey) !==
          figureEvidenceIdentity(right.figure, request.sourceItemKey)
        ) {
          continue;
        }
        if (cropsMateriallyDistinct(left.figure.crop, right.figure.crop)) {
          continue;
        }
        errors.push(
          `${right.path}: repeats the same paper Figure/Table used at ${left.path}. Use a different anchored visual, or explicit non-overlapping subfigure crops; do not repeat one image inside a gallery, across the cover and content slides, or across multiple content slides.`,
        );
      }
    }

    const moduleCount = request.slides.reduce(
      (total, slide) => total + evidenceModuleCount(slide),
      0,
    );
    const minimumModuleCount = Math.ceil(request.slides.length * 1.2);
    if (moduleCount < minimumModuleCount) {
      errors.push(
        `/slides: the deck contains ${moduleCount} evidence modules; at least ${minimumModuleCount} are required for medium-density academic composition. Combine figures, charts, equations, matrices, metrics, or annotated callouts where the paper supports them.`,
      );
    }

    const statementCount = request.slides.filter(
      (slide) => slide.layout === "statement" || !hasVisualEvidence(slide),
    ).length;
    const maximumStatementCount = request.slides.length >= 5 ? 0 : 1;
    if (statementCount > maximumStatementCount) {
      errors.push(
        `/slides: ${statementCount} slides resolve to text-forward statements; this paper deck may contain at most ${maximumStatementCount}. Use evidence, process, matrix, timeline, or multi-figure compositions instead of oversized text.`,
      );
    }

    const compositionCount = new Set(request.slides.map(compositionSignature))
      .size;
    const minimumCompositionCount = request.slides.length >= 5 ? 4 : 3;
    if (compositionCount < minimumCompositionCount) {
      errors.push(
        `/slides: the deck uses only ${compositionCount} composition silhouette; at least ${minimumCompositionCount} are required. Mix dominant figures, gallery, process, matrix, ablation/data, and conclusion layouts according to the evidence instead of repeating one template.`,
      );
    }

    for (const [index, slide] of request.slides.entries()) {
      const textLength = slideTextLength(slide);
      const maximumTextLength =
        slide.layout === "gallery"
          ? 420
          : slide.layout === "process"
            ? 460
            : slide.layout === "split"
              ? 520
              : slide.layout === "ablation"
                ? 620
                : slide.layout === "conclusion"
                  ? 680
                  : 760;
      if (textLength > maximumTextLength) {
        errors.push(
          `/slides/${index}: ${textLength} visible characters exceed the ${maximumTextLength}-character budget for the ${slide.layout || "auto"} composition. Keep one claim, remove secondary modules, and give the evidence more canvas.`,
        );
      }
      const wordCount = englishWordCount(slide.title);
      const cjkCount = cjkCharacterCount(slide.title);
      if (wordCount > 12 || cjkCount > 30) {
        errors.push(
          `/slides/${index}/title: the claim title is too long (${wordCount || cjkCount} ${wordCount ? "words" : "CJK characters"}). Keep it within 12 English words or 30 CJK characters so evidence, not oversized copy, owns the canvas.`,
        );
      }
    }

    const firstContentSlide = request.slides[0];
    if (
      firstContentSlide &&
      !firstContentSlide.comparison &&
      !firstContentSlide.matrix &&
      !firstContentSlide.chart &&
      !firstContentSlide.table
    ) {
      errors.push(
        "/slides/0: the research problem and gap must use structured comparison evidence such as a comparison, matrix, chart, or table. Metrics and prose alone create a sparse outline slide.",
      );
    }

    const conclusion = request.slides[request.slides.length - 1];
    if (conclusion?.layout !== "conclusion") {
      errors.push(
        `/slides/${request.slides.length - 1}: the final content slide must use the conclusion layout and resolve the deck's argument.`,
      );
    } else {
      const findingCount = Math.max(
        conclusion.groups?.length || 0,
        conclusion.bullets?.length || 0,
      );
      if (findingCount < 3) {
        errors.push(
          `/slides/${request.slides.length - 1}: the conclusion must contain three distinct findings as three groups or three bullets; found ${findingCount}. Do not compress numbered findings into one paragraph.`,
        );
      }
      const openDirectionCount = countOpenDirections(conclusion);
      if (openDirectionCount < 2) {
        errors.push(
          `/slides/${request.slides.length - 1}: the conclusion must surface at least two open questions or limitations; found ${openDirectionCount}.`,
        );
      }
      if (!conclusion.timeline?.length) {
        errors.push(
          `/slides/${request.slides.length - 1}: the conclusion must include a paper-grounded three-to-four-step roadmap timeline. A text-only ending or a small decorative figure is not a complete closing slide.`,
        );
      }
    }

    const titleTexts = [
      request.title,
      ...request.slides.map((slide) => slide.title),
    ];
    const chineseTitleCount = titleTexts.filter(
      (title) => cjkCharacterCount(title) >= 4,
    ).length;
    const englishTitleCount = titleTexts.filter(
      (title) => cjkCharacterCount(title) === 0 && englishWordCount(title) >= 4,
    ).length;
    const chineseDeck = chineseTitleCount >= Math.ceil(titleTexts.length * 0.6);
    const englishDeck = englishTitleCount >= Math.ceil(titleTexts.length * 0.6);
    for (const [index, slide] of request.slides.entries()) {
      const slideCjk = cjkCharacterCount(slide.title);
      const slideEnglishWords = englishWordCount(slide.title);
      if (chineseDeck && slideCjk === 0 && slideEnglishWords >= 4) {
        errors.push(
          `/slides/${index}/title: this otherwise Chinese deck switches to a full English slide title. Keep the audience-facing language consistent while preserving necessary paper names and acronyms.`,
        );
      }
      if (englishDeck && slideCjk >= 4) {
        errors.push(
          `/slides/${index}/title: this otherwise English deck switches to a Chinese slide title. Keep the audience-facing language consistent.`,
        );
      }
    }
  }

  const contentFigures = request.slides.flatMap(slideFigures);
  if (
    request.sourceItemKey &&
    request.slides.length >= 4 &&
    contentFigures.length < 3
  ) {
    errors.push(
      `/slides: a paper summary with four or more content slides must include at least three real PDF figure placements; found ${contentFigures.length}. Use figures on the problem, method/evidence, and conclusion or qualitative-result slides.`,
    );
  }
  if (request.sourceItemKey && request.slides.length >= 4) {
    const figureSlideCount = request.slides.filter(
      (slide) => slideFigures(slide).length > 0,
    ).length;
    if (figureSlideCount < 2) {
      errors.push(
        `/slides: real PDF figures appear on only ${figureSlideCount}/${request.slides.length} content slides; at least 2 figure-bearing slides are required, with at least three total figure placements, so editable charts can coexist with the paper's visual evidence without forcing screenshots into every page.`,
      );
    }
    const distinctFigureCount = new Set(contentFigures.map(figureSignature))
      .size;
    if (distinctFigureCount < 2) {
      errors.push(
        `/slides: found only ${distinctFigureCount} distinct PDF figure crop; use at least two different figures or materially different crops instead of repeating one image throughout the deck.`,
      );
    }
    if (!request.coverFigure && !request.coverFigures?.length) {
      errors.push(
        "/coverFigure: paper decks require a real PDF cover hero. Supply coverFigure or coverFigures so the automatic cover is not a text-only template.",
      );
    }
    const dominantFigureSlides = request.slides.filter((slide) => {
      const signature = compositionSignature(slide);
      return (
        slideFigures(slide).length > 0 &&
        (signature === "figure" ||
          signature === "gallery" ||
          signature === "evidence" ||
          signature === "process")
      );
    }).length;
    // Keep one strong paper-led composition as a structural floor, then let
    // the rendered-slide reviewer judge whether the remaining figures are too
    // small. Requiring two dominant figure pages here made otherwise coherent
    // repairs fail before the visual reviewer could assess the actual PNGs.
    const requiredDominantFigureSlides = 1;
    if (dominantFigureSlides < requiredDominantFigureSlides) {
      errors.push(
        `/slides: ${requiredDominantFigureSlides} content slides must use a dominant figure, gallery, evidence, or figure-backed process composition; found ${dominantFigureSlides}. Real paper visuals must own the canvas rather than appear as thumbnails beside text.`,
      );
    }
  }
  if (request.coverFigure) {
    errors.push(
      ...validateFigure(
        request.coverFigure,
        "/coverFigure",
        request.sourceItemKey,
      ),
    );
  }
  for (const [index, figure] of (request.coverFigures || []).entries()) {
    errors.push(
      ...validateFigure(
        figure,
        `/coverFigures/${index}`,
        request.sourceItemKey,
      ),
    );
  }
  for (const [index, slide] of request.slides.entries()) {
    errors.push(...validateSlide(slide, index));
    for (const [figureIndex, figure] of slideFigures(slide).entries()) {
      errors.push(
        ...validateFigure(
          figure,
          `/slides/${index}/figures/${figureIndex}`,
          request.sourceItemKey,
        ),
      );
    }
  }
  return errors;
}
