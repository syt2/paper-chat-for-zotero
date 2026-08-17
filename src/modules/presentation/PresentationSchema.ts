import { Type, type Static } from "@sinclair/typebox";
import {
  PRESENTATION_DESIGN_SYSTEMS,
  PRESENTATION_MAXIMUM_SLIDE_COUNT,
  PRESENTATION_MINIMUM_SLIDE_COUNT,
} from "./PresentationLaunchSettings";

export const PresentationDesignSystemSchema = Type.Union(
  PRESENTATION_DESIGN_SYSTEMS.map((designSystem) => Type.Literal(designSystem)),
  {
    description:
      "Bundled visual system. Paper summaries default to teal-green-academic-defense; five additional academic courseware and data styles plus PaperChat editorial and dark presentation styles are available when selected.",
  },
);

const NormalizedCropSchema = Type.Object(
  {
    x: Type.Number({ minimum: 0, maximum: 0.98 }),
    y: Type.Number({ minimum: 0, maximum: 0.98 }),
    width: Type.Number({ minimum: 0.02, maximum: 1 }),
    height: Type.Number({ minimum: 0.02, maximum: 1 }),
  },
  {
    additionalProperties: false,
    description:
      "Optional normalized crop rectangle using top-left coordinates. Omit it when the exact crop is unknown; PaperChat will locate the figure above its caption.",
  },
);

export const PresentationFigureSchema = Type.Object(
  {
    itemKey: Type.Optional(
      Type.String({
        maxLength: 32,
        description:
          "Zotero item key. Omit to use the request-level sourceItemKey.",
      }),
    ),
    page: Type.Integer({
      minimum: 1,
      maximum: 10_000,
      description: "One-based PDF page number containing the visual evidence.",
    }),
    mode: Type.Optional(
      Type.Union([Type.Literal("figure"), Type.Literal("page")], {
        description:
          "figure crops the evidence above a matching caption and automatically scans up to two neighboring PDF pages when extracted-text page numbers differ from PDF.js. Full-page mode is reserved for short non-paper decks and is rejected for research presentations.",
      }),
    ),
    captionHint: Type.Optional(
      Type.String({
        maxLength: 300,
        description:
          "Exact beginning of the printed figure/table caption used for automatic cropping. Start with the anchored label, for example 'Figure 4:' or 'Table 2:'. PaperChat scans the requested page and up to two neighboring PDF pages; a body-text mention such as 'see Figure 4' is not accepted.",
      }),
    ),
    caption: Type.Optional(
      Type.String({
        maxLength: 300,
        description: "Audience-facing figure caption shown below the image.",
      }),
    ),
    crop: Type.Optional(NormalizedCropSchema),
  },
  {
    additionalProperties: false,
    description:
      "A real visual extracted from the selected Zotero paper. Prefer figures, method diagrams, result plots, ablations, and representative tables over decorative imagery.",
  },
);

const ChartSeriesSchema = Type.Object(
  {
    name: Type.String({ maxLength: 80 }),
    values: Type.Array(Type.Number(), { minItems: 1, maxItems: 12 }),
  },
  { additionalProperties: false },
);

const ChartSchema = Type.Object(
  {
    type: Type.Union([Type.Literal("bar"), Type.Literal("line")]),
    orientation: Type.Optional(
      Type.Union([Type.Literal("vertical"), Type.Literal("horizontal")], {
        description:
          "Bar-chart direction. Use horizontal for ablations, rankings, and long category labels; line charts ignore this field.",
      }),
    ),
    title: Type.Optional(Type.String({ maxLength: 120 })),
    labels: Type.Array(Type.String({ maxLength: 80 }), {
      minItems: 1,
      maxItems: 12,
    }),
    values: Type.Optional(
      Type.Array(Type.Number(), { minItems: 1, maxItems: 12 }),
    ),
    series: Type.Optional(
      Type.Array(ChartSeriesSchema, { minItems: 1, maxItems: 5 }),
    ),
    xAxisTitle: Type.Optional(Type.String({ maxLength: 80 })),
    yAxisTitle: Type.Optional(Type.String({ maxLength: 80 })),
    highlightIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 11 })),
  },
  {
    additionalProperties: false,
    description:
      "Editable evidence chart. Use either values for one series or series for multiple series, never invented data.",
  },
);

const TableSchema = Type.Object(
  {
    headers: Type.Array(Type.String({ maxLength: 80 }), {
      minItems: 1,
      maxItems: 7,
    }),
    rows: Type.Array(
      Type.Array(Type.String({ maxLength: 180 }), {
        minItems: 1,
        maxItems: 7,
      }),
      { minItems: 1, maxItems: 10 },
    ),
    highlightRow: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
  },
  {
    additionalProperties: false,
    description:
      "Editable evidence table. Keep only the rows and columns needed to prove the slide claim.",
  },
);

const MetricSchema = Type.Object(
  {
    value: Type.String({ maxLength: 32 }),
    label: Type.String({ maxLength: 90 }),
    detail: Type.Optional(Type.String({ maxLength: 120 })),
  },
  { additionalProperties: false },
);

const ProcessStepSchema = Type.Object(
  {
    title: Type.String({ maxLength: 70 }),
    detail: Type.Optional(Type.String({ maxLength: 130 })),
  },
  { additionalProperties: false },
);

const ContentGroupSchema = Type.Object(
  {
    title: Type.String({ maxLength: 90 }),
    bullets: Type.Array(Type.String({ maxLength: 170 }), {
      minItems: 1,
      maxItems: 4,
    }),
  },
  {
    additionalProperties: false,
    description:
      "A compact evidence or interpretation group. Use two or three groups instead of one undifferentiated bullet wall.",
  },
);

const CalloutSchema = Type.Object(
  {
    label: Type.Optional(Type.String({ maxLength: 60 })),
    text: Type.String({ maxLength: 180 }),
    tone: Type.Optional(
      Type.Union([
        Type.Literal("evidence"),
        Type.Literal("focus"),
        Type.Literal("risk"),
        Type.Literal("neutral"),
      ]),
    ),
  },
  { additionalProperties: false },
);

const EquationSchema = Type.Object(
  {
    expression: Type.String({ maxLength: 280 }),
    label: Type.Optional(Type.String({ maxLength: 80 })),
    explanation: Type.Optional(Type.String({ maxLength: 220 })),
  },
  {
    additionalProperties: false,
    description:
      "A core equation or compact mathematical objective. Use plain Unicode/math text that remains editable in PowerPoint.",
  },
);

const MatrixRowSchema = Type.Object(
  {
    label: Type.String({ maxLength: 80 }),
    cells: Type.Array(Type.String({ maxLength: 100 }), {
      minItems: 2,
      maxItems: 5,
    }),
  },
  { additionalProperties: false },
);

const MatrixSchema = Type.Object(
  {
    banner: Type.Optional(Type.String({ maxLength: 150 })),
    columns: Type.Array(Type.String({ maxLength: 80 }), {
      minItems: 2,
      maxItems: 5,
    }),
    rows: Type.Array(MatrixRowSchema, { minItems: 2, maxItems: 6 }),
    highlightColumn: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
  },
  {
    additionalProperties: false,
    description:
      "A goal, method, or comparison matrix. Every row must contain exactly one cell per column.",
  },
);

const TimelineStepSchema = Type.Object(
  {
    label: Type.String({ maxLength: 80 }),
    detail: Type.Optional(Type.String({ maxLength: 150 })),
    milestone: Type.Optional(Type.String({ maxLength: 80 })),
  },
  { additionalProperties: false },
);

const ComparisonColumnSchema = Type.Object(
  {
    title: Type.String({ maxLength: 90 }),
    bullets: Type.Array(Type.String({ maxLength: 180 }), {
      minItems: 1,
      maxItems: 4,
    }),
  },
  { additionalProperties: false },
);

const ComparisonSchema = Type.Object(
  {
    left: ComparisonColumnSchema,
    right: ComparisonColumnSchema,
  },
  { additionalProperties: false },
);

export const PresentationSlideSchema = Type.Object(
  {
    layout: Type.Optional(
      Type.Union(
        [
          Type.Literal("auto"),
          Type.Literal("statement"),
          Type.Literal("split"),
          Type.Literal("figure"),
          Type.Literal("data"),
          Type.Literal("process"),
          Type.Literal("comparison"),
          Type.Literal("summary"),
          Type.Literal("evidence"),
          Type.Literal("matrix"),
          Type.Literal("timeline"),
          Type.Literal("gallery"),
          Type.Literal("ablation"),
          Type.Literal("conclusion"),
        ],
        {
          description:
            "Select a composition that matches the evidence. split uses one visual plus one narrative mode; gallery uses exactly two non-table paper figures plus one concise insight band; process uses at most four stages, one architecture figure, and one compact callout; comparison uses aligned evidence plus at most one conclusion callout; ablation uses exactly one editable chart, table, or matrix plus one interpretation block; conclusion always uses three findings, two open questions or limitations, and a three-to-four-step roadmap with no competing visual. Vary adjacent slide silhouettes; use auto when unsure.",
        },
      ),
    ),
    section: Type.Optional(Type.String({ maxLength: 60 })),
    eyebrow: Type.Optional(Type.String({ maxLength: 80 })),
    title: Type.String({
      minLength: 1,
      maxLength: 140,
      description:
        "A claim or takeaway, not a generic section label. Reading slide titles alone should tell the complete story.",
    }),
    subtitle: Type.Optional(Type.String({ maxLength: 220 })),
    bullets: Type.Optional(
      Type.Array(Type.String({ maxLength: 220 }), {
        minItems: 1,
        maxItems: 5,
        description:
          "Short evidence or interpretation points. Avoid prose walls and repeated restatements of the title.",
      }),
    ),
    groups: Type.Optional(
      Type.Array(ContentGroupSchema, {
        minItems: 1,
        maxItems: 3,
        description:
          "Two or three titled groups create the medium-density academic hierarchy used by the reference design.",
      }),
    ),
    keyMessage: Type.Optional(Type.String({ maxLength: 240 })),
    metrics: Type.Optional(
      Type.Array(MetricSchema, { minItems: 1, maxItems: 4 }),
    ),
    figure: Type.Optional(PresentationFigureSchema),
    figures: Type.Optional(
      Type.Array(PresentationFigureSchema, {
        minItems: 1,
        maxItems: 6,
        description:
          "Multiple real PDF visuals for small multiples, before/after evidence, qualitative comparisons, or a compact image sequence.",
      }),
    ),
    chart: Type.Optional(ChartSchema),
    table: Type.Optional(TableSchema),
    equation: Type.Optional(EquationSchema),
    matrix: Type.Optional(MatrixSchema),
    timeline: Type.Optional(
      Type.Array(TimelineStepSchema, { minItems: 3, maxItems: 6 }),
    ),
    callouts: Type.Optional(
      Type.Array(CalloutSchema, { minItems: 1, maxItems: 3 }),
    ),
    process: Type.Optional(
      Type.Array(ProcessStepSchema, { minItems: 3, maxItems: 6 }),
    ),
    comparison: Type.Optional(ComparisonSchema),
    notes: Type.Optional(Type.String({ maxLength: 4_000 })),
    source: Type.Optional(Type.String({ maxLength: 500 })),
  },
  {
    additionalProperties: false,
    description:
      "One content slide. Do not add a cover slide here; PaperChat creates the cover automatically.",
  },
);

export const PresentationRequestSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 160 }),
    language: Type.Optional(
      Type.String({
        minLength: 2,
        maxLength: 35,
        description:
          "Resolved audience-facing locale inherited from the explicit request or Zotero's current interface language.",
      }),
    ),
    subtitle: Type.Optional(Type.String({ maxLength: 300 })),
    author: Type.Optional(Type.String({ maxLength: 120 })),
    year: Type.Optional(
      Type.String({
        pattern: "^(?:19|20)\\d{2}$",
        description:
          "Publication year shown on the cover. PaperChat fills this from the Zotero item when omitted.",
      }),
    ),
    sourceItemKey: Type.Optional(
      Type.String({
        maxLength: 32,
        description:
          "Zotero item key for the paper being presented. Required when paper figures are used.",
      }),
    ),
    sourceLibraryID: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Zotero library ID paired with sourceItemKey, including group libraries.",
      }),
    ),
    theme: Type.Optional(
      Type.Union([
        Type.Literal("paperchat"),
        Type.Literal("academic"),
        Type.Literal("dark"),
      ]),
    ),
    designSystem: Type.Optional(PresentationDesignSystemSchema),
    slideCount: Type.Optional(
      Type.Integer({
        minimum: PRESENTATION_MINIMUM_SLIDE_COUNT,
        maximum: PRESENTATION_MAXIMUM_SLIDE_COUNT,
        description:
          "Requested total exported slide count, including the automatic cover. PaperChat validates slides.length against slideCount - 1.",
      }),
    ),
    fileName: Type.Optional(Type.String({ maxLength: 120 })),
    coverFigure: Type.Optional(PresentationFigureSchema),
    coverFigures: Type.Optional(
      Type.Array(PresentationFigureSchema, {
        minItems: 2,
        maxItems: 4,
        description:
          "Optional cover evidence set. PaperChat selects one visually representative crop as the dominant hero and uses the remaining crops only as restrained supporting details.",
      }),
    ),
    coverMetrics: Type.Optional(
      Type.Array(MetricSchema, {
        minItems: 2,
        maxItems: 3,
        description:
          "Two or three paper-grounded scale or outcome metrics used only to give the academic cover a compact evidence rail. Prefer dataset scale, model scale, and the headline result; omit when the paper has no defensible quantitative anchors.",
      }),
    ),
    slides: Type.Array(PresentationSlideSchema, {
      minItems: 1,
      maxItems: 29,
      description:
        "Content slides only. Total exported slide count is slides.length + 1 because PaperChat creates a designed cover.",
    }),
  },
  {
    additionalProperties: false,
    description:
      "A polished, evidence-first presentation specification. slides contains content pages only because PaperChat creates the cover automatically.",
  },
);

export type PresentationRequest = Static<typeof PresentationRequestSchema>;
export type PresentationSlide = Static<typeof PresentationSlideSchema>;
export type PresentationFigure = Static<typeof PresentationFigureSchema>;

export interface ResolvedPresentationFigure extends PresentationFigure {
  data: string;
  pixelWidth: number;
  pixelHeight: number;
  cropTrace?: string;
}

/** Internal renderer overrides produced only by the visual-review pass. */
export interface PresentationCoverVisualTuning {
  layout?: "single-hero" | "editorial-collage";
  titleScale?: "compact" | "standard" | "large";
  hideEvidenceLine?: boolean;
}

/** Internal slide overrides produced only by the visual-review pass. */
export interface PresentationSlideVisualTuning {
  figureEmphasis?: "standard" | "dominant";
}

export interface RenderablePresentationSlide extends Omit<
  PresentationSlide,
  "figure" | "figures"
> {
  figure?: ResolvedPresentationFigure;
  figures?: ResolvedPresentationFigure[];
  visualTuning?: PresentationSlideVisualTuning;
}

export interface RenderablePresentationRequest extends Omit<
  PresentationRequest,
  "coverFigure" | "coverFigures" | "slides"
> {
  coverFigure?: ResolvedPresentationFigure;
  coverFigures?: ResolvedPresentationFigure[];
  visualTuning?: PresentationCoverVisualTuning;
  slides: RenderablePresentationSlide[];
}
