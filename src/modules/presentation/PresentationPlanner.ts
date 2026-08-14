import { Type, type Static } from "@sinclair/typebox";
import type { PaperStructureExtended } from "../../types/tool";
import {
  PresentationRequestSchema,
  type PresentationRequest,
} from "./PresentationSchema";
import {
  PRESENTATION_MAXIMUM_SLIDE_COUNT,
  PRESENTATION_MINIMUM_SLIDE_COUNT,
  PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH,
  resolvePresentationSlideCount,
} from "./PresentationLaunchSettings";

export const PresentationIntentSchema = Type.Object(
  {
    sourceItemKey: Type.Optional(
      Type.String({
        maxLength: 32,
        description:
          "Zotero item key for the current paper. Omit only when PaperChat already has an active paper.",
      }),
    ),
    language: Type.Optional(
      Type.String({
        minLength: 2,
        maxLength: 35,
        description:
          "Audience-facing language or locale. Omit or use auto to follow Zotero's current interface language.",
      }),
    ),
    title: Type.Optional(Type.String({ maxLength: 160 })),
    instructions: Type.Optional(
      Type.String({
        maxLength: PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH,
        description:
          "Optional audience, emphasis, or style request. A normal paper PPT request does not need this field.",
      }),
    ),
    designSystem: Type.Optional(
      Type.Union([
        Type.Literal("teal-green-academic-defense"),
        Type.Literal("paperchat-editorial"),
        Type.Literal("dark-editorial"),
      ]),
    ),
    slideCount: Type.Optional(
      Type.Integer({
        minimum: PRESENTATION_MINIMUM_SLIDE_COUNT,
        maximum: PRESENTATION_MAXIMUM_SLIDE_COUNT,
        description:
          "Total exported slide count including PaperChat's automatic cover.",
      }),
    ),
    fileName: Type.Optional(Type.String({ maxLength: 120 })),
  },
  {
    additionalProperties: false,
    description:
      "A lightweight request to create an editable presentation from the current Zotero paper. PaperChat performs detailed planning, figure selection, rendering, and visual review internally.",
  },
);

export type PresentationIntent = Static<typeof PresentationIntentSchema>;

export interface PresentationPlanningRequest {
  intent: PresentationIntent;
  paper: PaperStructureExtended;
  /** Internal-only repair context. Never exposed through the public tool. */
  repair?: {
    issues: string[];
    previousDraft?: unknown;
  };
}

export type PresentationPlanner = (
  request: PresentationPlanningRequest,
) => Promise<PresentationRequest>;

const MAX_PAPER_CONTEXT_CHARACTERS = 140_000;
const MAX_PAGE_CHARACTERS = 18_000;

function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n[page text truncated]`;
}

function formatNativeOutline(
  outline: PaperStructureExtended["nativeOutline"],
  depth = 0,
): string[] {
  if (!outline?.length) return [];
  const lines: string[] = [];
  for (const entry of outline) {
    lines.push(
      `${"  ".repeat(depth)}- ${entry.title}${entry.pageNumber > 0 ? ` (PDF page ${entry.pageNumber})` : ""}`,
    );
    lines.push(...formatNativeOutline(entry.children, depth + 1));
  }
  return lines;
}

export function buildPresentationPaperContext(
  request: PresentationPlanningRequest,
): string {
  const { intent, paper } = request;
  const parts: string[] = [
    `Source item key: ${intent.sourceItemKey || "unknown"}`,
    `Title: ${paper.metadata.title || intent.title || "Untitled paper"}`,
    `Authors: ${(paper.metadata.authors || []).join(", ") || "unknown"}`,
    `Year: ${paper.metadata.year || "unknown"}`,
    `DOI: ${paper.metadata.doi || "unknown"}`,
    `Extracted pages: ${paper.pageCount}`,
    `PDF.js pages: ${paper.nativePageCount || "unknown"}`,
  ];
  if (paper.metadata.abstract) {
    parts.push(`Abstract:\n${paper.metadata.abstract}`);
  }
  const outline = formatNativeOutline(paper.nativeOutline);
  if (outline.length > 0) {
    parts.push(`PDF outline:\n${outline.join("\n")}`);
  }

  let usedCharacters = parts.join("\n\n").length;
  for (const page of paper.pages) {
    if (usedCharacters >= MAX_PAPER_CONTEXT_CHARACTERS) break;
    const remaining = MAX_PAPER_CONTEXT_CHARACTERS - usedCharacters;
    const content = boundedText(
      page.content,
      Math.min(MAX_PAGE_CHARACTERS, remaining),
    );
    const section = `\n\n[EXTRACTED PAGE ${page.pageNumber}]\n${content}`;
    parts.push(section);
    usedCharacters += section.length;
  }
  return parts.join("\n\n");
}

function buildPresentationPlannerLengthContract(
  requestedSlideCount: unknown = 6,
): string {
  const slideCount = resolvePresentationSlideCount(requestedSlideCount);
  const contentSlideCount = slideCount - 1;
  const evidenceEnd = contentSlideCount - 1;
  const storyArcRule =
    contentSlideCount === 3
      ? "The three content slides must tell one compressed cumulative argument: (1) research problem, gap, and contribution; (2) method plus the strongest experimental evidence; and (3) conclusion, limitations, and implications. Combine related evidence intentionally rather than omitting one of these jobs."
      : `The deck must tell one cumulative argument across exactly ${contentSlideCount} content slides: research problem and gap, method, experimental evidence, ablation or limitations, then conclusion and implications. For formats longer than six pages, expand the truthful evidence arc with related-work contrasts, method details, experimental setup, additional results, ablations, failure cases, and limitations instead of duplicating claims or padding with prose.`;
  const figurePlacementRule =
    contentSlideCount >= 4
      ? "Use at least three real PDF figure placements across at least two content slides, at least two distinct crops, and a real cover hero."
      : "For this compact three-content-slide deck, use at least two real PDF figure placements where the paper supports them, keep the method or strongest result visually dominant, and use a distinct real cover hero.";
  const experimentalEvidenceRule =
    contentSlideCount === 3
      ? "On content slide 2, combine the method with the strongest truthful experimental or ablation result as an editable chart, table, matrix, or comparison when the paper supplies exact values. Keep any paired paper figure large enough to interpret. Do not invent values or shrink evidence into thumbnails."
      : `Across the experimental evidence portion, content slides 3 through ${evidenceEnd}, include structured experimental or ablation results as editable charts, tables, matrices, or comparisons. At least one such result is mandatory, and longer decks should use additional distinct results where the paper supports them. Do not spend the whole evidence arc on figure-only interpretation. When one of these result pages uses a compact table or chart, pair it with a distinct non-table PDF figure that adds qualitative or mechanistic evidence when the paper supplies one; for example, learned features, predictions, retrievals, samples, error cases, or an implementation detail. Keep the editable result dominant and the paper figure large enough to interpret. For one measurement across several categories, use values and highlightIndex rather than wrapping it in a one-entry series array. Use series only for two or more genuinely comparable measurements, give every series a short localized name, and ensure the categories mean the same thing for every series; PaperChat will render a direct series legend. Do not simplify a table-plus-figure result page into table-only. If the supplied paper evidence cannot support a truthful structured result, fail the quality contract instead of inventing values or exporting a visually weak deck.`;
  const minimumCompositionCount = Math.min(
    contentSlideCount,
    contentSlideCount >= 5 ? 4 : 3,
  );
  return [
    `Create a premium, editable, evidence-first ${slideCount}-page research presentation. The cover is automatic, so return exactly ${contentSlideCount} content slides and never create a second cover. Set request-level slideCount to ${slideCount}.`,
    storyArcRule,
    figurePlacementRule,
    experimentalEvidenceRule,
    `Use at least ${minimumCompositionCount} different composition silhouettes across the ${contentSlideCount} content slides${contentSlideCount >= 5 ? ", and use five or more when the selected length provides enough truthful evidence" : ""}. Prefer gallery, figure, evidence, process, ablation, comparison, and conclusion according to the evidence. Never use statement for a paper deck.`,
  ].join("\n");
}

export function buildPresentationPlannerSystemPrompt(): string {
  return [
    "You are PaperChat's internal academic presentation planner.",
    "Follow the selected deck length and its count-specific narrative, evidence, and composition contract in the user message exactly.",
    "Use the exact locale stated as the required audience-facing output language in the user prompt. It has already been resolved from an explicit user preference or Zotero's current interface locale; never infer the deck language from the paper's language. Write every audience-facing field in that locale. For zh-CN, zh-TW, or another Chinese locale, write every slide title, subtitle, group heading, bullet, metric label, callout, and timeline label in the matching Chinese variant except unavoidable paper names, acronyms, equations, and quoted figure captions. Never switch one slide into another language.",
    "Use the paper's actual printed figure and table captions for evidence lookup. Every figure captionHint must begin with the exact anchored label such as 'Fig. 2.' or 'Table 3'. Never use a body-text mention. Also provide a concise audience-facing caption as one complete sentence in the requested output language; keep the Figure/Table anchor, never end it with an ellipsis, and do not paste the full source paragraph into the visible caption. PaperChat scans neighboring PDF pages when extracted page numbers differ from PDF.js.",
    "Allocate every content-slide evidence figure before choosing the cover hero: scientific evidence on a content slide always has priority over cover decoration. Never reuse the same Figure/Table or the same automatic crop inside one gallery, on the cover and a content slide, or across two content slides. Different non-overlapping subfigure crops are allowed only when the crop coordinates are explicit.",
    "Treat the cover and method slide as separate visual jobs. Reserve architecture or pipeline figures for the method slide. Reserve the strongest qualitative result, sample comparison, learned representation, or other figure needed to complete the experimental evidence arc for a content slide. Only after those reservations, choose a different visually strong non-method figure for the cover. For the cover, rank real-world samples, predictions, retrievals, and error-case panels above learned filters or feature maps; they create a richer first impression. Learned filters and feature maps are preferred supporting evidence beside an editable result table or chart. Never use a training/error curve, axes-heavy plot, rasterized table, architecture diagram, or dense pipeline as the cover hero when any qualitative candidate exists; tiny axes and diagram labels are not a premium first impression. The cover must never consume the only qualitative figure that can complete a table- or chart-led result page. If the paper provides both a rich sample/prediction panel and learned filters, use both in different roles rather than dropping either: sample/prediction panel on the cover and learned filters beside the result, unless the experimental narrative clearly requires the reverse. If no unique cover visual remains, repair the content/cover allocation instead of deleting content evidence or duplicating a figure.",
    "When the paper provides two complementary real figures for one claim, prefer a gallery or figure-led composition over recreating one figure as an oversized editable chart. In a two-figure gallery, order the figures by narrative importance because the renderer gives the first figure the dominant 7:5 stage. Editable charts should clarify numeric comparisons, not displace stronger paper visuals or reduce them to thumbnails.",
    "Any chart-like paper figure with axes, training curves, loss/error plots, or dense labels must use the dedicated figure layout as the primary evidence object. Never place it on the cover, in gallery, ablation, process, split, or a secondary evidence slot. Reconstruct exact paper values as an editable chart only when the supplied evidence contains those values. Tiny or clipped axis labels are a release-blocking defect.",
    "The first content slide must make the research gap legible as structured evidence. Prefer a comparison matrix, editable chart/table, or paired comparison with 2-4 aligned evidence rows; do not make it a sparse left/right prose page with decorative metrics. When using the comparison field, set layout to comparison. Never attach comparison or process to layout evidence because the evidence renderer does not display those fields.",
    "Compose every slide as premium academic information design, not a poster, paper handout, or dashboard. Use asymmetric whitespace, thin rules, direct labels, precise diagrams, and restrained emphasis. Avoid card grids, pills, repeated panels, large-text empty pages, tiny figure thumbnails, and decorative shapes without meaning. Give one primary evidence object roughly 60-75% of the usable canvas; use an asymmetric 3:9 or 4:8 split or a full-width evidence stage. Reserve deliberate full-bleed imagery for an explicitly requested dark-editorial deck. Never leave a planned region visibly empty.",
    "Titles are audience-facing claims, at most 12 English words or 30 Chinese characters. The sequence of titles must tell the complete story when read alone. Keep visible copy concise and medium-density. Shorten text before adding modules or shrinking type.",
    "Every slide title must be supported by the evidence visibly rendered on that same slide. Do not mention test error, accuracy, ablation effects, or another quantitative outcome when the selected figures or editable data only demonstrate optimization speed, learned representations, architecture, or qualitative examples.",
    "Emit only fields that the chosen layout visibly uses. Do not populate every optional field. split uses exactly one of keyMessage or at most two bullets beside one visual. figure uses one dominant non-table PDF figure; if it has a narrative rail, provide a concise keyMessage plus at least one paper-grounded experiment condition, quantified result, interpretation boundary, metric, or callout so the rail is not a single sentence floating in empty space. If the evidence cannot support that density, omit the narrative rail and let the figure own the full canvas. gallery uses exactly two non-table figures with different anchored Figure/Table labels plus either one concise keyMessage or two aligned insight groups; two caption variants of the same Figure label are still duplicates. evidence uses at least two compatible modules chosen from PDF figures, chart, table, matrix, equation, and metrics; it never uses comparison or process. If only one compatible module exists, choose its dedicated layout instead of forcing evidence. process uses three or four stages plus at most one architecture figure and one callout; when an architecture figure is present, keep every stage title short enough for one line because the figure-led renderer intentionally omits stage details from the visible pipeline. ablation uses exactly one editable chart, table, or matrix as the dominant result and may retain one distinct non-table PDF figure as supporting qualitative evidence, plus only one concise interpretation or limitations block. For the default academic paper deck, a compact ablation table with at most five rows and four columns should use that table-plus-figure composition whenever a relevant paper figure exists; otherwise pair the table with one concise bottom interpretation band or replace it with a stronger chart/matrix. Never leave a small table alone in the upper-left with empty canvas around it. Rasterized paper tables must never be the main visual; reconstruct their values as an editable chart, table, or matrix.",
    "The final content slide must use conclusion and always close with exactly three distinct evidence-backed findings, at least two open questions or limitations, and a paper-grounded three-to-four-step roadmap timeline. Each of the three groups or bullets must itself state a concrete finding established by the paper; research significance, implications, limitations, and future work do not count as findings and belong in the open-question callouts or roadmap. Use three groups or bullets, exactly two concise callouts, and no figure, chart, table, matrix, metrics, or keyMessage on the conclusion slide.",
    "Every number, chart value, table cell, and scientific claim must be traceable to the supplied paper. Never invent data. Include concise speaker notes with source page or caption references.",
    "For the default teal-green paper deck, provide exactly two or three paper-grounded coverMetrics at request level: prefer one scale metric, one model or experiment metric, and one headline outcome. These are a compact evidence rail on the cover, not repeated slide-body cards. Never invent or guess values; if the paper has no defensible anchors, fail the quality contract instead of exporting a sparse cover.",
    "Default to teal-green-academic-defense unless the intent explicitly requests another bundled design system. It uses a white scholarly canvas, measured claim titles, thin precise lines, restrained teal accents, medium information density, and one dominant evidence object per page. Use dark-editorial only when the user explicitly asks for a dark or cinematic presentation.",
    "Return one JSON object only. Do not wrap it in markdown and do not call tools.",
  ].join("\n");
}

export function buildPresentationPlannerUserPrompt(
  request: PresentationPlanningRequest,
): string {
  const outputLanguage = request.intent.language || "en-US";
  const slideCount = resolvePresentationSlideCount(request.intent.slideCount);
  const contentSlideCount = slideCount - 1;
  const userInstructions = request.intent.instructions?.trim();
  const structuredIntent: Record<string, unknown> = { ...request.intent };
  delete structuredIntent.instructions;
  const sections = [
    [
      `Zotero display locale resolved for this presentation: ${outputLanguage}`,
      `Required default PPT language: ${outputLanguage}`,
      "This is a hard output-language requirement. It follows Zotero's current display language unless the user explicitly requested another language.",
      "Use this exact locale for all model-authored visible slide text and speaker notes. Never infer or switch the PPT language from the source paper's language; preserve only unavoidable original-language paper names, acronyms, equations, and quoted Figure/Table captions.",
    ].join("\n"),
    [
      `Selected total slide count: ${slideCount}`,
      `Required content slide count: exactly ${contentSlideCount}`,
      "The cover is generated automatically and is not part of the slides array. This length is a hard application-owned requirement.",
    ].join("\n"),
    `Deck-length contract:\n${buildPresentationPlannerLengthContract(slideCount)}`,
    `Presentation intent:\n${JSON.stringify(structuredIntent, null, 2)}`,
    `Internal output JSON schema:\n${JSON.stringify(PresentationRequestSchema)}`,
    `Paper evidence:\n${buildPresentationPaperContext(request)}`,
  ];
  if (userInstructions) {
    sections.splice(
      2,
      0,
      [
        "User-provided requirements for this generation:",
        userInstructions,
        "Honor these requirements when they do not conflict with the selected output language, slide count, design system, paper evidence, or renderer contract.",
      ].join("\n"),
    );
  }
  if (request.repair) {
    const issues = request.repair.issues
      .map((issue) => String(issue).trim())
      .filter(Boolean)
      .slice(0, 12);
    sections.unshift(
      [
        "Repair the previous internal presentation draft.",
        "Return a complete corrected JSON object, not a patch and not an explanation.",
        `Fix only the listed contract problems while preserving valid paper evidence and the selected ${slideCount}-page narrative with exactly ${contentSlideCount} content slides.`,
        "Preserve every already-valid real PDF figure, table, chart, matrix, and process module unless the listed issue explicitly identifies that exact module as duplicated, incorrect, unreadable, or unsafe. Never solve a composition problem by deleting valid evidence or replacing a figure-backed evidence slide with a single table or prose-only slide; recombine the existing modules in a compatible layout instead.",
        "When a validation issue says that an evidence layout is underfilled, either add a truthful compatible module or switch to the dedicated comparison, matrix, figure, data, or ablation layout. Never keep layout evidence while placing its missing evidence in comparison or process fields, because those fields are intentionally not rendered there.",
        `Validation issues:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
        request.repair.previousDraft === undefined
          ? "Previous draft: unavailable"
          : `Previous draft:\n${JSON.stringify(request.repair.previousDraft, null, 2)}`,
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
}

function extractJsonObject(content: string): unknown {
  const unfenced = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Presentation planner did not return a JSON object.");
    }
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

export function parsePresentationPlannerResponse(
  content: string,
): PresentationRequest {
  const value = extractJsonObject(content);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Presentation planner returned an invalid response.");
  }
  return value as PresentationRequest;
}
