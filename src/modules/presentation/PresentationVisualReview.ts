import type {
  PresentationRequest,
  PresentationSlide,
  RenderablePresentationRequest,
  RenderablePresentationSlide,
} from "./PresentationSchema";
import { validatePresentationQuality } from "./PresentationQualityGate";

export type PresentationVisualReviewStage = "draft" | "final";
export type PresentationVisualReviewVerdict = "pass" | "revise" | "reject";

export interface PresentationVisualReviewPatch {
  /** One-based exported slide number. The automatic cover is slide 1. */
  slideNumber: number;
  layout?: PresentationSlide["layout"];
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  keyMessage?: string;
  bullets?: string[];
  figureEmphasis?: "standard" | "dominant";
  swapFigureOrder?: boolean;
  dropFields?: Array<
    | "subtitle"
    | "keyMessage"
    | "bullets"
    | "groups"
    | "metrics"
    | "callouts"
    | "figure"
    | "figures"
    | "chart"
    | "table"
    | "equation"
    | "matrix"
    | "timeline"
    | "process"
    | "comparison"
  >;
}

export interface PresentationVisualReviewDeckPatch {
  coverLayout?: "single-hero" | "editorial-collage";
  coverTitleScale?: "compact" | "standard" | "large";
  swapCoverFigureOrder?: boolean;
  dropCoverEvidenceLine?: boolean;
}

export interface PresentationVisualReviewResponse {
  verdict: PresentationVisualReviewVerdict;
  summary: string;
  /**
   * Editorial findings may trigger repair but never suppress a production
   * export. Render-safety findings cover catastrophic clipping or unreadable
   * overflow and remain release-blocking.
   */
  failureClass?: "editorial" | "render_safety";
  deckPatch?: PresentationVisualReviewDeckPatch;
  patches?: PresentationVisualReviewPatch[];
}

export interface PresentationVisualReviewRequest {
  stage: PresentationVisualReviewStage;
  title: string;
  outline: string;
  previewSlides: string[];
}

export type PresentationVisualReviewer = (
  request: PresentationVisualReviewRequest,
) => Promise<PresentationVisualReviewResponse>;

const ALLOWED_LAYOUTS = new Set<NonNullable<PresentationSlide["layout"]>>([
  "auto",
  "statement",
  "split",
  "figure",
  "data",
  "process",
  "comparison",
  "summary",
  "evidence",
  "matrix",
  "timeline",
  "gallery",
  "ablation",
  "conclusion",
]);

const ALLOWED_DROP_FIELDS = new Set<
  NonNullable<PresentationVisualReviewPatch["dropFields"]>[number]
>([
  "subtitle",
  "keyMessage",
  "bullets",
  "groups",
  "metrics",
  "callouts",
  "figure",
  "figures",
  "chart",
  "table",
  "equation",
  "matrix",
  "timeline",
  "process",
  "comparison",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function parsePatch(value: unknown): PresentationVisualReviewPatch | null {
  if (!isRecord(value)) return null;
  const slideNumber = Number(value.slideNumber);
  if (!Number.isInteger(slideNumber) || slideNumber < 2 || slideNumber > 30) {
    return null;
  }
  const patch: PresentationVisualReviewPatch = { slideNumber };
  if (
    typeof value.layout === "string" &&
    ALLOWED_LAYOUTS.has(
      value.layout as NonNullable<PresentationSlide["layout"]>,
    )
  ) {
    patch.layout = value.layout as PresentationSlide["layout"];
  }
  patch.title = boundedString(value.title, 160);
  patch.subtitle = boundedString(value.subtitle, 260);
  patch.eyebrow = boundedString(value.eyebrow, 80);
  patch.keyMessage = boundedString(value.keyMessage, 420);
  if (Array.isArray(value.bullets)) {
    patch.bullets = value.bullets
      .map((entry) => boundedString(entry, 220))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 6);
  }
  if (
    value.figureEmphasis === "standard" ||
    value.figureEmphasis === "dominant"
  ) {
    patch.figureEmphasis = value.figureEmphasis;
  }
  if (typeof value.swapFigureOrder === "boolean") {
    patch.swapFigureOrder = value.swapFigureOrder;
  }
  if (Array.isArray(value.dropFields)) {
    patch.dropFields = value.dropFields
      .filter(
        (
          entry,
        ): entry is NonNullable<
          PresentationVisualReviewPatch["dropFields"]
        >[number] =>
          typeof entry === "string" &&
          ALLOWED_DROP_FIELDS.has(
            entry as NonNullable<
              PresentationVisualReviewPatch["dropFields"]
            >[number],
          ),
      )
      .slice(0, ALLOWED_DROP_FIELDS.size);
  }
  return patch;
}

function parseDeckPatch(
  value: unknown,
): PresentationVisualReviewDeckPatch | undefined {
  if (!isRecord(value)) return undefined;
  const patch: PresentationVisualReviewDeckPatch = {};
  if (
    value.coverLayout === "single-hero" ||
    value.coverLayout === "editorial-collage"
  ) {
    patch.coverLayout = value.coverLayout;
  }
  if (
    value.coverTitleScale === "compact" ||
    value.coverTitleScale === "standard" ||
    value.coverTitleScale === "large"
  ) {
    patch.coverTitleScale = value.coverTitleScale;
  }
  if (typeof value.swapCoverFigureOrder === "boolean") {
    patch.swapCoverFigureOrder = value.swapCoverFigureOrder;
  }
  if (typeof value.dropCoverEvidenceLine === "boolean") {
    patch.dropCoverEvidenceLine = value.dropCoverEvidenceLine;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Visual reviewer did not return a JSON object.");
    }
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

export function parsePresentationVisualReviewResponse(
  content: string,
): PresentationVisualReviewResponse {
  const value = extractJsonObject(content);
  if (!isRecord(value)) {
    throw new Error("Visual reviewer returned an invalid response.");
  }
  const verdict = value.verdict;
  if (verdict !== "pass" && verdict !== "revise" && verdict !== "reject") {
    throw new Error("Visual reviewer returned an unknown verdict.");
  }
  const summary = boundedString(value.summary, 600) || "No review summary.";
  const failureClass =
    value.failureClass === "editorial" || value.failureClass === "render_safety"
      ? value.failureClass
      : undefined;
  const deckPatch = parseDeckPatch(value.deckPatch);
  const patches = Array.isArray(value.patches)
    ? value.patches
        .map(parsePatch)
        .filter((patch): patch is PresentationVisualReviewPatch =>
          Boolean(patch),
        )
        .slice(0, 5)
    : [];
  if (verdict === "revise" && patches.length === 0 && !deckPatch) {
    throw new Error(
      "Visual reviewer requested revision without a usable patch.",
    );
  }
  return {
    verdict,
    summary,
    failureClass,
    deckPatch,
    patches: patches.length > 0 ? patches : undefined,
  };
}

function slideModules(slide: RenderablePresentationSlide): string[] {
  const modules: string[] = [];
  for (const key of [
    "figure",
    "figures",
    "chart",
    "table",
    "equation",
    "matrix",
    "timeline",
    "process",
    "comparison",
    "groups",
    "metrics",
    "callouts",
    "keyMessage",
    "bullets",
  ] as const) {
    const value = (slide as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value) ? value.length > 0 : Boolean(value)) {
      modules.push(key);
    }
  }
  return modules;
}

function figureReviewSummary(
  figure: NonNullable<RenderablePresentationSlide["figure"]>,
): Record<string, unknown> {
  return {
    page: figure.page,
    captionAnchor: figure.captionHint || figure.caption,
    crop: figure.crop,
    pixelSize: `${figure.pixelWidth}x${figure.pixelHeight}`,
  };
}

function chartReviewSummary(
  chart: NonNullable<RenderablePresentationSlide["chart"]>,
): Record<string, unknown> {
  return {
    type: chart.type,
    orientation: chart.orientation,
    title: chart.title,
    labels: chart.labels,
    series: chart.series?.map((series) => ({
      name: series.name,
      values: series.values,
    })),
    values: chart.values,
    xAxisTitle: chart.xAxisTitle,
    yAxisTitle: chart.yAxisTitle,
  };
}

export function buildPresentationVisualReviewOutline(
  request: RenderablePresentationRequest,
): string {
  return JSON.stringify(
    {
      title: request.title,
      subtitle: request.subtitle,
      language: request.language,
      designSystem: request.designSystem,
      slideCount: request.slides.length + 1,
      cover: {
        title: request.title,
        figures: [
          ...(request.coverFigure ? [request.coverFigure] : []),
          ...(request.coverFigures || []),
        ].map(figureReviewSummary),
      },
      slides: request.slides.map((slide, index) => ({
        slideNumber: index + 2,
        title: slide.title,
        subtitle: slide.subtitle,
        layout: slide.layout,
        modules: slideModules(slide),
        chart: slide.chart ? chartReviewSummary(slide.chart) : undefined,
        figures: [
          ...(slide.figure ? [slide.figure] : []),
          ...(slide.figures || []),
        ].map(figureReviewSummary),
      })),
    },
    null,
    2,
  );
}

function cloneRenderableRequest(
  request: RenderablePresentationRequest,
): RenderablePresentationRequest {
  return {
    ...request,
    visualTuning: request.visualTuning
      ? { ...request.visualTuning }
      : undefined,
    coverFigure: request.coverFigure ? { ...request.coverFigure } : undefined,
    coverFigures: request.coverFigures?.map((figure) => ({ ...figure })),
    slides: request.slides.map((slide) => ({
      ...slide,
      visualTuning: slide.visualTuning ? { ...slide.visualTuning } : undefined,
      figure: slide.figure ? { ...slide.figure } : undefined,
      figures: slide.figures?.map((figure) => ({ ...figure })),
      bullets: slide.bullets ? [...slide.bullets] : undefined,
    })),
  };
}

function applyPresentationVisualReviewPatchesUnchecked(
  request: RenderablePresentationRequest,
  patches: readonly PresentationVisualReviewPatch[],
  deckPatch?: PresentationVisualReviewDeckPatch,
): RenderablePresentationRequest {
  const revised = cloneRenderableRequest(request);
  if (deckPatch) {
    revised.visualTuning = {
      ...revised.visualTuning,
      layout: deckPatch.coverLayout || revised.visualTuning?.layout,
      titleScale: deckPatch.coverTitleScale || revised.visualTuning?.titleScale,
      hideEvidenceLine:
        deckPatch.dropCoverEvidenceLine ??
        revised.visualTuning?.hideEvidenceLine,
    };
    if (
      deckPatch.swapCoverFigureOrder &&
      revised.coverFigures &&
      revised.coverFigures.length > 1
    ) {
      revised.coverFigures = [
        revised.coverFigures[1],
        revised.coverFigures[0],
        ...revised.coverFigures.slice(2),
      ];
      revised.coverFigure = revised.coverFigures[0];
    }
    if (deckPatch.coverLayout === "editorial-collage") {
      const candidates = [
        ...(revised.coverFigure ? [revised.coverFigure] : []),
        ...(revised.coverFigures || []),
        ...revised.slides.flatMap((slide) => [
          ...(slide.figure ? [slide.figure] : []),
          ...(slide.figures || []),
        ]),
      ];
      const unique = candidates.filter(
        (figure, index) =>
          candidates.findIndex(
            (candidate) =>
              candidate.page === figure.page &&
              candidate.pixelWidth === figure.pixelWidth &&
              candidate.pixelHeight === figure.pixelHeight &&
              (candidate.caption || candidate.captionHint) ===
                (figure.caption || figure.captionHint),
          ) === index,
      );
      if (unique.length > 1) {
        revised.coverFigure = unique[0];
        revised.coverFigures = unique.slice(0, 2);
      }
    }
  }
  for (const patch of patches) {
    const slideIndex = patch.slideNumber - 2;
    const slide = revised.slides[slideIndex];
    if (!slide) continue;
    const originalSlide = request.slides[slideIndex];
    const narrativeFallback =
      originalSlide?.keyMessage ||
      originalSlide?.bullets?.find((bullet) => bullet.trim()) ||
      originalSlide?.groups
        ?.flatMap((group) => group.bullets)
        .find((bullet) => bullet.trim());
    if (patch.layout) slide.layout = patch.layout;
    if (patch.title) slide.title = patch.title;
    if (patch.subtitle) slide.subtitle = patch.subtitle;
    if (patch.eyebrow) slide.eyebrow = patch.eyebrow;
    if (patch.keyMessage) slide.keyMessage = patch.keyMessage;
    if (patch.bullets) slide.bullets = patch.bullets;
    if (patch.swapFigureOrder && slide.figures?.length) {
      slide.figures = [...slide.figures].reverse();
    }
    for (const field of patch.dropFields || []) {
      delete (slide as unknown as Record<string, unknown>)[field];
    }
    if (patch.figureEmphasis) {
      slide.visualTuning = {
        ...slide.visualTuning,
        figureEmphasis: patch.figureEmphasis,
      };
      if (patch.figureEmphasis === "dominant" && !patch.layout) {
        const figureCount =
          (slide.figure ? 1 : 0) + (slide.figures?.length || 0);
        if (figureCount > 1) slide.layout = "gallery";
        else if (figureCount === 1) slide.layout = "figure";
      }
    }
    if (
      slide.layout === "gallery" &&
      !slide.keyMessage &&
      !slide.bullets?.length &&
      !slide.groups?.length &&
      narrativeFallback
    ) {
      slide.keyMessage = narrativeFallback;
    }
  }
  return revised;
}

/**
 * Visual review is allowed to reshape a deck, but a model-authored repair must
 * never invalidate the renderer contract. Try the full patch first. If a
 * structural change is incompatible, keep the safe copy edits and ordering
 * changes; if those are still invalid, retain only the cover repair. The final
 * visual-review pass then judges the actual fallback render instead of failing
 * before it can see the result.
 */
export function applyPresentationVisualReviewPatches(
  request: RenderablePresentationRequest,
  patches: readonly PresentationVisualReviewPatch[],
  deckPatch?: PresentationVisualReviewDeckPatch,
): RenderablePresentationRequest {
  const baselineQualityErrors = new Set(
    validatePresentationQuality(request as unknown as PresentationRequest),
  );
  const introducesQualityRegression = (
    candidate: RenderablePresentationRequest,
  ): boolean =>
    validatePresentationQuality(
      candidate as unknown as PresentationRequest,
    ).some((error) => !baselineQualityErrors.has(error));

  const full = applyPresentationVisualReviewPatchesUnchecked(
    request,
    patches,
    deckPatch,
  );
  if (!introducesQualityRegression(full)) {
    return full;
  }

  const safePatches = patches.map(
    ({
      layout: _layout,
      figureEmphasis: _emphasis,
      dropFields: _drop,
      ...safe
    }) => safe,
  );
  const safe = applyPresentationVisualReviewPatchesUnchecked(
    request,
    safePatches,
    deckPatch,
  );
  if (!introducesQualityRegression(safe)) {
    return safe;
  }

  return applyPresentationVisualReviewPatchesUnchecked(request, [], deckPatch);
}

export function toPresentationRequest(
  request: RenderablePresentationRequest,
): PresentationRequest {
  return request as unknown as PresentationRequest;
}
