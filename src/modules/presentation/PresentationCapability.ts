import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ToolDefinition } from "../../types/tool";
import {
  generateShortId,
  getDataPath,
  getErrorMessage,
} from "../../utils/common";
import { getPresentationRenderer } from "./PresentationRendererLoader";
import { attachPresentationToZotero } from "./PresentationAttachment";
import {
  PresentationResolvedMediaDuplicateError,
  resolvePresentationMedia,
} from "./PresentationMediaResolver";
import { formatPresentationAuthors } from "./PresentationMetadata";
import {
  filterBlockingPresentationQualityIssues,
  shouldUseStrictPresentationQualityGate,
  validatePresentationQuality,
} from "./PresentationQualityGate";
import {
  PresentationRequestSchema,
  type PresentationRequest,
} from "./PresentationSchema";
import {
  PresentationIntentSchema,
  type PresentationIntent,
  type PresentationPlanner,
} from "./PresentationPlanner";
import { normalizePresentationRequestInput } from "./PresentationRequestNormalizer";
import {
  applyPresentationVisualReviewPatches,
  buildPresentationVisualReviewOutline,
  type PresentationVisualReviewResponse,
  type PresentationVisualReviewer,
} from "./PresentationVisualReview";
import type {
  PresentationCapabilityTestOptions,
  PresentationProgressCallback,
  PresentationProgressPhase,
  PresentationSourceContext,
  PresentationRenderWithPreviewResult,
} from "./contracts";
import { resolvePresentationSlideCount } from "./PresentationLaunchSettings";

const PRESENTATIONS_FOLDER = "presentations";
const PRESENTATION_PROGRESS_ORDER: PresentationProgressPhase[] = [
  "analyzing",
  "planning",
  "resolving_media",
  "rendering",
  "reviewing",
  "repairing",
  "exporting",
  "attaching",
  "completed",
];

type PresentationProgressMessages = Record<
  PresentationProgressPhase,
  string
> & {
  draftReady: string;
  renderingRevision: string;
};

function getPresentationProgressMessages(
  language: string,
  slideCount: number,
): PresentationProgressMessages {
  if (/^zh(?:-|$)/i.test(language)) {
    return {
      analyzing: "正在读取论文",
      planning: `正在规划 ${slideCount} 页结构`,
      resolving_media: "正在提取论文证据图",
      rendering: "正在生成首版 PPT",
      reviewing: "正在进行视觉检查",
      repairing: "正在改进版式与内容",
      exporting: "正在保存可编辑 PPTX",
      attaching: "正在挂载到 Zotero",
      completed: "PPT 已生成",
      draftReady: "已生成可打开的 PPTX 草稿",
      renderingRevision: "正在生成改进版 PPT",
    };
  }
  return {
    analyzing: "Reading the paper",
    planning: `Planning the ${slideCount}-slide structure`,
    resolving_media: "Extracting evidence figures from the paper",
    rendering: "Rendering the first editable draft",
    reviewing: "Reviewing visual quality",
    repairing: "Improving the content and layout",
    exporting: "Saving the editable PPTX",
    attaching: "Attaching the presentation to Zotero",
    completed: "Presentation completed",
    draftReady: "An openable PPTX draft is ready",
    renderingRevision: "Rendering an improved draft",
  };
}

async function atomicWritePresentationFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await IOUtils.write(path, bytes, {
    flush: true,
    tmpPath: `${path}.tmp-${generateShortId()}`,
  });
}

function decodePngDataUrl(dataUrl: string): Uint8Array {
  const match = /^data:image\/png(?:;[^,]*)?;base64,([\s\S]+)$/iu.exec(dataUrl);
  if (!match) {
    throw new Error("Presentation preview was not a base64 PNG data URL.");
  }
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

interface CanonicalPresentationPath {
  comparisonKey: string;
  style: "posix" | "windows";
}

function canonicalizePresentationPath(
  value: string,
): CanonicalPresentationPath | undefined {
  if (!value || /[\0\r\n]/u.test(value)) return undefined;

  const path = value.replace(/\\/g, "/");
  let prefix: string;
  let remainder: string;
  let style: CanonicalPresentationPath["style"];
  const driveMatch = /^([a-z]):\/(.*)$/iu.exec(path);
  const uncMatch = /^\/{2,}([^/]+)\/([^/]+)(?:\/(.*))?$/u.exec(path);
  if (driveMatch) {
    prefix = `${driveMatch[1].toLowerCase()}:/`;
    remainder = driveMatch[2];
    style = "windows";
  } else if (uncMatch) {
    prefix = `//${uncMatch[1]}/${uncMatch[2]}`;
    remainder = uncMatch[3] || "";
    style = "windows";
  } else if (path.startsWith("/")) {
    prefix = "/";
    remainder = path.slice(1);
    style = "posix";
  } else {
    return undefined;
  }

  const components: string[] = [];
  for (const component of remainder.split("/")) {
    if (!component || component === ".") continue;
    if (component === "..") {
      if (!components.length) return undefined;
      components.pop();
      continue;
    }
    components.push(component);
  }
  const separator = prefix.endsWith("/") || !components.length ? "" : "/";
  const normalized = `${prefix}${separator}${components.join("/")}`;
  return {
    comparisonKey: style === "windows" ? normalized.toLowerCase() : normalized,
    style,
  };
}

export function isTrustedPresentationPreviewPath(
  previewPath: string,
  presentationsRoot = getDataPath(PRESENTATIONS_FOLDER),
): boolean {
  if (!/\.png$/iu.test(previewPath)) return false;
  const candidate = canonicalizePresentationPath(previewPath);
  const root = canonicalizePresentationPath(presentationsRoot);
  if (!candidate || !root || candidate.style !== root.style) return false;
  const rootPrefix = `${root.comparisonKey.replace(/\/+$/u, "")}/`;
  return candidate.comparisonKey.startsWith(rootPrefix);
}

export function isPathInsidePresentationRoot(
  filePath: string,
  rootPath: string,
): boolean {
  const candidate = canonicalizePresentationPath(filePath);
  const root = canonicalizePresentationPath(rootPath);
  if (!candidate || !root || candidate.style !== root.style) return false;
  const normalizedRoot = root.comparisonKey.replace(/\/+$/u, "");
  return (
    candidate.comparisonKey === normalizedRoot ||
    candidate.comparisonKey.startsWith(`${normalizedRoot}/`)
  );
}

async function persistPresentationPreviewFiles(
  previewFolder: string,
  previewSlides: readonly string[],
  renderGeneration: number,
  presentationsRoot: string,
  onPersisted?: (path: string) => void,
): Promise<string[]> {
  const generation = String(renderGeneration).padStart(2, "0");
  const previewPaths = previewSlides.map((_previewSlide, index) =>
    PathUtils.join(
      previewFolder,
      `generation-${generation}-slide-${String(index + 1).padStart(2, "0")}.png`,
    ),
  );
  if (
    previewPaths.some(
      (path) => !isTrustedPresentationPreviewPath(path, presentationsRoot),
    )
  ) {
    throw new Error(
      "Presentation preview path escaped the PaperChat presentations directory.",
    );
  }
  if (!previewPaths.length) return [];

  await IOUtils.makeDirectory(previewFolder, { createAncestors: true });
  for (const [index, previewSlide] of previewSlides.entries()) {
    await atomicWritePresentationFile(
      previewPaths[index],
      decodePngDataUrl(previewSlide),
    );
    onPersisted?.(previewPaths[index]);
  }
  return previewPaths;
}

async function cleanupUnreferencedPresentationPreviews(
  persistedPaths: ReadonlySet<string>,
  retainedPaths: readonly string[],
  presentationsRoot: string | undefined,
): Promise<void> {
  if (!presentationsRoot || typeof IOUtils.remove !== "function") return;
  const retained = new Set(retainedPaths);
  for (const path of persistedPaths) {
    if (
      retained.has(path) ||
      !isTrustedPresentationPreviewPath(path, presentationsRoot)
    ) {
      continue;
    }
    try {
      if (
        typeof IOUtils.exists !== "function" ||
        (await IOUtils.exists(path))
      ) {
        await IOUtils.remove(path);
      }
    } catch (error) {
      if (typeof ztoolkit !== "undefined") {
        ztoolkit.log(
          `[presentation] Could not remove an unreferenced preview; export remains successful: ${path}: ${getErrorMessage(error)}`,
        );
      }
    }
  }
}

export function createPresentationToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "presentation",
      description:
        "Create a polished, editable 4- to 30-slide PowerPoint from the current Zotero paper. Call this directly for a normal request such as '为这篇论文生成一个 PPT'. Provide only the current sourceItemKey and any explicit language, length, or style preference; when language is omitted or auto, PaperChat uses Zotero's current interface language. PaperChat performs detailed evidence planning, figure selection, rendering, visual review, and export internally.",
      parameters:
        PresentationIntentSchema as unknown as ToolDefinition["function"]["parameters"],
    },
  };
}

export function resolvePresentationLanguage(
  requestedLanguage: unknown,
): string {
  const explicit =
    typeof requestedLanguage === "string" ? requestedLanguage.trim() : "";
  if (explicit && explicit.toLowerCase() !== "auto") {
    return explicit.replace(/_/g, "-");
  }

  try {
    const zoteroLocale = String(Zotero.locale || "").trim();
    if (zoteroLocale) {
      return zoteroLocale.replace(/_/g, "-");
    }
  } catch {
    // Node tests and early startup may not expose Zotero yet.
  }
  return "en-US";
}

export function resolvePresentationAuthor(
  authors: readonly string[] | undefined,
  language: string | undefined,
): string | undefined {
  return formatPresentationAuthors(authors, language);
}

export function mergePresentationPlanMetadata(
  planned: PresentationRequest,
  intent: PresentationIntent,
  paper: Parameters<PresentationPlanner>[0]["paper"],
): PresentationRequest {
  return {
    ...planned,
    // The app-bound intent identifies the paper the user authorized. Never let
    // an internal planner response redirect export or attachment to another
    // Zotero item.
    sourceItemKey: intent.sourceItemKey,
    language: intent.language || planned.language,
    title: intent.title || planned.title,
    author:
      planned.author?.trim() ||
      resolvePresentationAuthor(paper.metadata.authors, intent.language),
    designSystem: intent.designSystem || planned.designSystem,
    slideCount: intent.slideCount || planned.slideCount,
    fileName: intent.fileName || planned.fileName,
  };
}

function sanitizeFileBase(value: string): string {
  const withoutControlCharacters = Array.from(value.normalize("NFKC"))
    .map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
    .join("");
  const normalized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/[.\s-]+$/g, "")
    .trim();
  return (normalized || "presentation").slice(0, 80);
}

function formatValidationErrorsForSchema(
  schema: TSchema,
  value: unknown,
): string {
  return [...Value.Errors(schema, value)]
    .slice(0, 6)
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
}

function formatValidationErrors(value: unknown): string {
  return formatValidationErrorsForSchema(PresentationRequestSchema, value);
}

function formatPresentationError(options: {
  summary: string;
  cause: string;
  category?: "invalid_arguments" | "unavailable" | "execution_failed";
  retryable?: boolean;
  suggestedFix?: string;
  alternative?: string;
}): string {
  return [
    `Error: ${options.summary}`,
    `Category: ${options.category || "execution_failed"}`,
    `Retryable: ${options.retryable ? "yes" : "no"}`,
    `Cause: ${options.cause}`,
    `Fix hint: ${
      options.suggestedFix ||
      "Retry the presentation request. PaperChat will start a fresh planning and rendering attempt."
    }`,
    options.alternative
      ? `Alternative: ${options.alternative}`
      : "Alternative: Continue the conversation without claiming that a PPTX was created.",
  ].join("\n");
}

function validatePresentationCandidate(
  input: unknown,
  strictQuality: boolean,
): {
  request?: PresentationRequest;
  issues: string[];
  phase: "schema" | "quality" | "valid";
} {
  const normalized = normalizePresentationRequestInput(
    input as Record<string, unknown>,
  );
  if (!Value.Check(PresentationRequestSchema, normalized)) {
    return {
      issues: [formatValidationErrors(normalized)],
      phase: "schema",
    };
  }
  const request = normalized as PresentationRequest;
  const allQualityErrors = validatePresentationQuality(request);
  const qualityErrors = filterBlockingPresentationQualityIssues(
    allQualityErrors,
    strictQuality,
  );
  if (
    qualityErrors.length !== allQualityErrors.length &&
    typeof ztoolkit !== "undefined"
  ) {
    const softIssues = allQualityErrors.filter(
      (issue) => !qualityErrors.includes(issue),
    );
    ztoolkit.log(
      `[presentation] Production soft quality diagnostics deferred to rendered-slide review: ${softIssues.join("; ")}`,
    );
  }
  if (qualityErrors.length > 0) {
    return {
      issues: qualityErrors.slice(0, 12),
      phase: "quality",
    };
  }
  return {
    request,
    // Production treats these as advisory for export, but the internal planner
    // still gets one bounded chance to improve the draft before rendering.
    issues: allQualityErrors.slice(0, 12),
    phase: "valid",
  };
}

export async function executePresentationCapability(
  args: Record<string, unknown>,
  visualReviewer?: PresentationVisualReviewer,
  planner?: PresentationPlanner,
  paper?: Parameters<PresentationPlanner>[0]["paper"],
  onProgress?: PresentationProgressCallback,
  testOptions?: PresentationCapabilityTestOptions,
  sourceContext?: PresentationSourceContext,
): Promise<string> {
  const strictQuality = shouldUseStrictPresentationQualityGate(testOptions);
  const mediaResolver = testOptions?.mediaResolver || resolvePresentationMedia;
  const progressLanguage = resolvePresentationLanguage(args.language);
  const requestedSlideCount = resolvePresentationSlideCount(args.slideCount);
  const progressMessages = getPresentationProgressMessages(
    progressLanguage,
    requestedSlideCount,
  );
  const emitProgress = async (
    phase: PresentationProgressPhase,
    update: Omit<
      Parameters<PresentationProgressCallback>[0],
      "phase" | "message"
    > = {},
    message = progressMessages[phase],
  ): Promise<void> => {
    if (!onProgress) return;
    try {
      await onProgress({
        phase,
        message,
        current: PRESENTATION_PROGRESS_ORDER.indexOf(phase) + 1,
        total: PRESENTATION_PROGRESS_ORDER.length,
        ...update,
      });
    } catch (error) {
      if (typeof ztoolkit !== "undefined") {
        ztoolkit.log(
          `[presentation] Progress callback failed during ${phase}: ${getErrorMessage(error)}`,
        );
      }
    }
  };
  await emitProgress("analyzing");
  await emitProgress("planning");
  let requestInput: unknown = args;
  let planningRounds = 0;
  const planningQualityWarnings: string[] = [];
  let resolvedIntent: PresentationIntent | undefined;
  let mergePlannedIntent:
    | ((planned: PresentationRequest) => unknown)
    | undefined;
  const containsDetailedSlides = Object.prototype.hasOwnProperty.call(
    args,
    "slides",
  );
  if (!containsDetailedSlides) {
    if (!Value.Check(PresentationIntentSchema, args)) {
      const detail = formatValidationErrorsForSchema(
        PresentationIntentSchema,
        args,
      );
      return formatPresentationError({
        summary: "Invalid presentation request.",
        category: "invalid_arguments",
        retryable: true,
        cause: detail,
        suggestedFix:
          "Retry with only sourceItemKey and any explicit language, title, style, or filename preference.",
      });
    }
    if (!planner || !paper) {
      return formatPresentationError({
        summary: "Presentation planning is unavailable for this request.",
        category: "unavailable",
        retryable: false,
        cause:
          "The current PaperChat runtime did not provide the internal presentation planner or paper context.",
      });
    }
    try {
      const intent = {
        ...args,
        language: resolvePresentationLanguage(args.language),
        ...(args.slideCount === undefined
          ? {}
          : { slideCount: requestedSlideCount }),
      } as PresentationIntent;
      const mergeIntent = (planned: PresentationRequest): unknown =>
        mergePresentationPlanMetadata(planned, intent, paper);
      resolvedIntent = intent;
      mergePlannedIntent = mergeIntent;
      let planned = await planner({ intent, paper });
      planningRounds += 1;
      requestInput = mergeIntent(planned);
      let validation = validatePresentationCandidate(
        requestInput,
        strictQuality,
      );
      if (!validation.request) {
        await emitProgress("repairing");
        planned = await planner({
          intent,
          paper,
          repair: {
            issues: validation.issues,
            previousDraft: planned,
          },
        });
        planningRounds += 1;
        requestInput = mergeIntent(planned);
        validation = validatePresentationCandidate(requestInput, strictQuality);
      }
      if (
        !strictQuality &&
        validation.request &&
        validation.issues.length > 0
      ) {
        const usableRequest = validation.request;
        const originalIssues = validation.issues;
        try {
          await emitProgress("repairing");
          const improved = await planner({
            intent,
            paper,
            repair: {
              issues: originalIssues,
              previousDraft: planned,
            },
          });
          planningRounds += 1;
          const improvedInput = mergeIntent(improved);
          const improvedValidation = validatePresentationCandidate(
            improvedInput,
            strictQuality,
          );
          if (
            improvedValidation.request &&
            improvedValidation.issues.length <= originalIssues.length
          ) {
            planned = improved;
            requestInput = improvedValidation.request;
            validation = improvedValidation;
          } else {
            requestInput = usableRequest;
            validation = {
              request: usableRequest,
              issues: originalIssues,
              phase: "valid",
            };
          }
        } catch (error) {
          requestInput = usableRequest;
          validation = {
            request: usableRequest,
            issues: originalIssues,
            phase: "valid",
          };
          planningQualityWarnings.push(
            `Best-effort editorial planning repair failed: ${getErrorMessage(error)}`,
          );
        }
      }
      if (!validation.request) {
        const detail = validation.issues.join("; ");
        if (typeof ztoolkit !== "undefined") {
          ztoolkit.log(
            `[presentation] Internal planning remained invalid after repair: ${detail}`,
          );
        }
        return formatPresentationError({
          summary:
            "Presentation internal planning did not pass the quality contract.",
          retryable: true,
          cause: detail,
          suggestedFix:
            "Retry the presentation request. PaperChat will start a fresh internal planning pass.",
        });
      }
      planningQualityWarnings.push(...validation.issues);
      requestInput = validation.request;
    } catch (error) {
      return formatPresentationError({
        summary: "Presentation internal planning failed.",
        retryable: true,
        cause: getErrorMessage(error),
        suggestedFix:
          "Retry the presentation request. PaperChat will start a fresh internal planning pass.",
      });
    }
  }

  const validation = validatePresentationCandidate(requestInput, strictQuality);
  if (!validation.request) {
    const detail = validation.issues.join("; ");
    if (typeof ztoolkit !== "undefined") {
      ztoolkit.log(
        validation.phase === "schema"
          ? `[presentation] Invalid specification: ${detail}`
          : `[presentation] Quality gate rejected specification: ${detail}`,
      );
    }
    return formatPresentationError({
      summary:
        validation.phase === "schema"
          ? "Invalid presentation specification."
          : "Presentation quality gate rejected the specification.",
      category:
        validation.phase === "schema"
          ? "invalid_arguments"
          : "execution_failed",
      retryable: true,
      cause: detail,
      suggestedFix:
        validation.phase === "schema" && containsDetailedSlides
          ? "Retry with a valid detailed presentation object that matches the internal schema."
          : "Retry the presentation request. PaperChat will rebuild the deck specification from the current paper.",
    });
  }
  let request = validation.request;
  let mediaRepairUsed = false;
  let visualRepairUsed = false;

  const runFullStructuralRepair = async (
    kind: "media" | "visual",
    issues: string[],
    previousDraft: PresentationRequest,
  ): Promise<PresentationRequest | undefined> => {
    if (!planner || !paper || !resolvedIntent || !mergePlannedIntent) {
      return undefined;
    }
    if (kind === "media" ? mediaRepairUsed : visualRepairUsed) {
      return undefined;
    }
    if (kind === "media") mediaRepairUsed = true;
    else visualRepairUsed = true;
    await emitProgress("repairing");

    const repairSlideCount = resolvePresentationSlideCount(
      resolvedIntent.slideCount,
    );
    const repairContentSlideCount = repairSlideCount - 1;
    const repairFigureContract =
      repairContentSlideCount >= 4
        ? "at least three unique real paper-figure placements across at least two content slides"
        : "at least two real paper-figure placements with one dominant method or result visual";
    const repairCompositionCount = Math.min(
      repairContentSlideCount,
      repairContentSlideCount >= 5 ? 4 : 3,
    );
    const invariantIssues = [
      `Preserve the complete paper-deck contract while repairing the listed defect: exactly ${repairContentSlideCount} content slides plus the automatic cover (${repairSlideCount} pages total), ${repairFigureContract}, at least ${repairCompositionCount} composition silhouettes, and a complete conclusion slide.`,
      "Preserve every valid real PDF figure and structured evidence module from the previous draft unless the reported defect names that exact module as duplicate, incorrect, unreadable, or unsafe. Repair composition around valid evidence; do not simplify a figure-plus-table or figure-plus-chart slide into a single table, chart, or prose block.",
      "The first content slide must still express the research problem and gap through a real comparison, matrix, editable chart, or editable table. Metrics plus prose alone are invalid even when another slide is being repaired.",
    ];
    let planned: PresentationRequest;
    try {
      planned = await planner({
        intent: resolvedIntent,
        paper,
        repair: {
          issues: [...issues, ...invariantIssues].slice(0, 12),
          previousDraft,
        },
      });
      planningRounds += 1;
    } catch (error) {
      throw new Error(
        `Presentation ${kind} repair planning failed: ${getErrorMessage(error)}`,
      );
    }
    let repairedValidation = validatePresentationCandidate(
      mergePlannedIntent(planned),
      strictQuality,
    );
    if (!repairedValidation.request) {
      try {
        planned = await planner({
          intent: resolvedIntent,
          paper,
          repair: {
            issues: [
              `The previous full ${kind} repair was still invalid. Correct every validation issue below without dropping valid evidence or changing the requested language/design system.`,
              ...repairedValidation.issues,
              ...invariantIssues,
            ].slice(0, 12),
            previousDraft: planned,
          },
        });
        planningRounds += 1;
      } catch (error) {
        throw new Error(
          `Presentation ${kind} validation repair planning failed: ${getErrorMessage(error)}`,
        );
      }
      repairedValidation = validatePresentationCandidate(
        mergePlannedIntent(planned),
        strictQuality,
      );
      if (!repairedValidation.request) {
        throw new Error(
          `Presentation ${kind} repair remained invalid after targeted validation repair: ${repairedValidation.issues.join("; ")}`,
        );
      }
    }
    return repairedValidation.request;
  };

  let persistedPresentationPath: string | undefined;
  let persistedPresentationPreviewPaths: string[] = [];
  let persistedPresentationsRoot: string | undefined;
  const persistedPresentationPreviewHistory = new Set<string>();
  try {
    const renderer = getPresentationRenderer();
    let presentationsRoot: string | undefined;
    let outputPath: string | undefined;
    let previewFolder: string | undefined;
    let previewPaths: string[] = [];
    let hasPersistedDraft = false;
    let renderGeneration = 0;
    let visualReviewStatus: "passed" | "warnings" | "not_requested" =
      visualReviewer ? "passed" : "not_requested";
    let visualReviewSummary: string | undefined;
    const releaseVisualWarnings: string[] = [];
    const acceptReleaseVisualWarning = (summary: string) => {
      if (!releaseVisualWarnings.includes(summary)) {
        releaseVisualWarnings.push(summary);
      }
      visualReviewStatus = "warnings";
      visualReviewSummary = `Exported with non-blocking visual review warnings: ${releaseVisualWarnings.join(
        "; ",
      )}`;
      if (typeof ztoolkit !== "undefined") {
        ztoolkit.log(
          `[presentation] Production export continued after visual review warning: ${summary}`,
        );
      }
    };
    const acceptVisualReviewSuccess = (summary: string) => {
      if (releaseVisualWarnings.length > 0) {
        visualReviewStatus = "warnings";
        visualReviewSummary = `Exported with non-blocking visual review warnings: ${releaseVisualWarnings.join(
          "; ",
        )}. ${summary}`;
        return;
      }
      visualReviewStatus = "passed";
      visualReviewSummary = summary;
    };

    const ensureOutputPaths = async (): Promise<{
      outputPath: string;
      previewFolder: string;
      presentationsRoot: string;
    }> => {
      if (!outputPath || !previewFolder || !presentationsRoot) {
        presentationsRoot = getDataPath(PRESENTATIONS_FOLDER);
        persistedPresentationsRoot = presentationsRoot;
        await IOUtils.makeDirectory(presentationsRoot, {
          createAncestors: true,
        });
        const requestedBase = request.fileName?.replace(/\.pptx$/i, "");
        const fileBase = sanitizeFileBase(requestedBase || request.title);
        const outputStem = `${fileBase}-${Date.now()}-${generateShortId()}`;
        outputPath = PathUtils.join(presentationsRoot, `${outputStem}.pptx`);
        previewFolder = PathUtils.join(
          presentationsRoot,
          `${outputStem}-previews`,
        );
      }
      return { outputPath, previewFolder, presentationsRoot };
    };

    const persistRenderedDraft = async (
      rendered: PresentationRenderWithPreviewResult,
    ): Promise<void> => {
      const paths = await ensureOutputPaths();
      await emitProgress("exporting", {
        pptxPath: hasPersistedDraft ? paths.outputPath : undefined,
        previewPaths: previewPaths.length ? [...previewPaths] : undefined,
        isDraft: true,
      });
      await atomicWritePresentationFile(paths.outputPath, rendered.bytes);
      hasPersistedDraft = true;
      persistedPresentationPath = paths.outputPath;
      try {
        previewPaths = await persistPresentationPreviewFiles(
          paths.previewFolder,
          rendered.previewSlides,
          renderGeneration,
          paths.presentationsRoot,
          (path) => persistedPresentationPreviewHistory.add(path),
        );
      } catch (error) {
        previewPaths = [];
        if (typeof ztoolkit !== "undefined") {
          ztoolkit.log(
            `[presentation] PPTX draft was saved, but preview persistence failed: ${getErrorMessage(error)}`,
          );
        }
      }
      persistedPresentationPreviewPaths = [...previewPaths];
      await emitProgress(
        "rendering",
        {
          pptxPath: paths.outputPath,
          previewPaths: [...previewPaths],
          isDraft: true,
        },
        progressMessages.draftReady,
      );
    };

    const restorePersistedDraft = async (snapshot: {
      bytes: Uint8Array;
      previewPaths: string[];
    }): Promise<void> => {
      if (!outputPath) {
        throw new Error("Presentation draft path was unavailable for restore.");
      }
      await atomicWritePresentationFile(outputPath, snapshot.bytes);
      bytes = snapshot.bytes;
      previewPaths = [...snapshot.previewPaths];
      persistedPresentationPreviewPaths = [...snapshot.previewPaths];
      await emitProgress("rendering", {
        pptxPath: outputPath,
        previewPaths: [...previewPaths],
        isDraft: true,
      });
    };

    const resolveCandidate = async (
      candidate: PresentationRequest,
    ): Promise<{
      request: PresentationRequest;
      renderableRequest: Awaited<ReturnType<typeof resolvePresentationMedia>>;
    }> => {
      await emitProgress("resolving_media", {
        pptxPath: hasPersistedDraft ? outputPath : undefined,
        previewPaths: previewPaths.length ? [...previewPaths] : undefined,
        isDraft: hasPersistedDraft || undefined,
      });
      try {
        return {
          request: candidate,
          renderableRequest: await mediaResolver(
            candidate,
            sourceContext?.libraryID,
          ),
        };
      } catch (error) {
        if (!(error instanceof PresentationResolvedMediaDuplicateError)) {
          throw error;
        }
        const acceptDuplicateMedia = (
          acceptedRequest: PresentationRequest,
          duplicateError: PresentationResolvedMediaDuplicateError,
          context: string,
        ) => {
          if (!duplicateError.resolvedRequest) {
            throw duplicateError;
          }
          acceptReleaseVisualWarning(
            `${context}: ${duplicateError.issues.slice(0, 6).join("; ")}`,
          );
          return {
            request: acceptedRequest,
            renderableRequest: duplicateError.resolvedRequest,
          };
        };

        let repaired: PresentationRequest | undefined;
        try {
          repaired = await runFullStructuralRepair(
            "media",
            error.issues,
            candidate,
          );
        } catch (repairError) {
          if (strictQuality) throw repairError;
          return acceptDuplicateMedia(
            candidate,
            error,
            `Duplicate-image repair failed, so PaperChat exported the original usable media instead of blocking (${getErrorMessage(repairError)})`,
          );
        }
        if (!repaired) {
          if (strictQuality) throw error;
          return acceptDuplicateMedia(
            candidate,
            error,
            "Duplicate-image validation remained advisory because no internal repair planner was available",
          );
        }
        try {
          return {
            request: repaired,
            renderableRequest: await mediaResolver(
              repaired,
              sourceContext?.libraryID,
            ),
          };
        } catch (repairedError) {
          if (
            !(repairedError instanceof PresentationResolvedMediaDuplicateError)
          ) {
            throw repairedError;
          }
          if (strictQuality) throw repairedError;
          if (!repairedError.resolvedRequest && error.resolvedRequest) {
            return acceptDuplicateMedia(
              candidate,
              error,
              "The repaired plan still repeated a crop, so PaperChat exported the original usable media instead of blocking",
            );
          }
          return acceptDuplicateMedia(
            repaired,
            repairedError,
            "The repaired plan still repeated a crop, so PaperChat exported it with a non-blocking warning",
          );
        }
      }
    };
    const renderPreview = async (
      candidate: Awaited<ReturnType<typeof resolvePresentationMedia>>,
      expectedContentSlides: number,
    ) => {
      renderGeneration += 1;
      await emitProgress(
        "rendering",
        {
          pptxPath: hasPersistedDraft ? outputPath : undefined,
          previewPaths: previewPaths.length ? [...previewPaths] : undefined,
          isDraft: hasPersistedDraft || undefined,
        },
        renderGeneration === 1
          ? progressMessages.rendering
          : progressMessages.renderingRevision,
      );
      let rendered: PresentationRenderWithPreviewResult;
      try {
        rendered = await renderer.renderPresentationWithPreview(candidate);
      } catch (error) {
        if (strictQuality) throw error;
        const summary = `Presentation preview rendering failed; exported the editable PPTX without previews: ${getErrorMessage(error)}`;
        acceptReleaseVisualWarning(summary);
        rendered = {
          bytes: await renderer.renderPresentation(candidate),
          previewSlides: [],
          visualWarnings: [summary],
        };
      }
      const expectedPreviewSlides = expectedContentSlides + 1;
      if (rendered.previewSlides.length !== expectedPreviewSlides) {
        const summary = `Presentation visual preview produced ${rendered.previewSlides.length} slides; expected ${expectedPreviewSlides}.`;
        if (strictQuality) throw new Error(summary);
        acceptReleaseVisualWarning(
          `${summary} Exported the editable PPTX and omitted the incomplete preview set.`,
        );
        rendered = {
          ...rendered,
          previewSlides: [],
          visualWarnings: [...(rendered.visualWarnings || []), summary],
        };
      }
      await persistRenderedDraft(rendered);
      return rendered;
    };

    let resolved = await resolveCandidate(request);
    request = resolved.request;
    let renderableRequest = resolved.renderableRequest;
    let bytes: Uint8Array;
    let visualReviewRounds = 0;
    if (planningQualityWarnings.length > 0) {
      acceptReleaseVisualWarning(
        `Planning quality diagnostics remain after best-effort repair: ${planningQualityWarnings
          .slice(0, 8)
          .join("; ")}`,
      );
    }
    const releaseBlocksVisualReview = (
      _review: PresentationVisualReviewResponse,
    ) => strictQuality;
    if (visualReviewer) {
      const draft = await renderPreview(
        renderableRequest,
        request.slides.length,
      );
      bytes = draft.bytes;
      let draftReview: PresentationVisualReviewResponse | undefined;
      try {
        await emitProgress("reviewing", {
          pptxPath: outputPath,
          previewPaths: [...previewPaths],
          isDraft: true,
        });
        draftReview = await visualReviewer({
          stage: "draft",
          title: request.title,
          outline: appendPresentationVisualWarnings(
            buildPresentationVisualReviewOutline(renderableRequest),
            draft.visualWarnings,
          ),
          previewSlides: draft.previewSlides,
        });
        visualReviewRounds += 1;
      } catch (reviewError) {
        const summary = `Presentation visual quality review failed before export: ${getErrorMessage(reviewError)}`;
        if (strictQuality) throw new Error(summary);
        acceptReleaseVisualWarning(summary);
      }

      let structuralRepairIssue: string | undefined;
      if (draftReview?.verdict === "reject") {
        structuralRepairIssue = `Draft visual review rejected the deck: ${draftReview.summary}`;
      } else if (draftReview?.verdict === "revise") {
        const baselineQualityErrors = new Set(
          validatePresentationQuality(
            renderableRequest as unknown as PresentationRequest,
          ),
        );
        const revisedRequest = applyPresentationVisualReviewPatches(
          renderableRequest,
          draftReview.patches || [],
          draftReview.deckPatch,
        );
        const revisedQualityErrors = filterBlockingPresentationQualityIssues(
          validatePresentationQuality(
            revisedRequest as unknown as PresentationRequest,
          ).filter((error) => !baselineQualityErrors.has(error)),
          strictQuality,
        );
        if (revisedQualityErrors.length > 0) {
          structuralRepairIssue = `Visual revision introduced new quality diagnostics: ${revisedQualityErrors
            .slice(0, 8)
            .join("; ")}`;
        } else {
          const lastUsableRenderableRequest = renderableRequest;
          const lastUsableDraft = {
            bytes,
            previewPaths: [...previewPaths],
          };
          try {
            await emitProgress("repairing", {
              pptxPath: outputPath,
              previewPaths: [...previewPaths],
              isDraft: true,
            });
            const revised = await renderPreview(
              revisedRequest,
              request.slides.length,
            );
            renderableRequest = revisedRequest;
            bytes = revised.bytes;
            let finalReview: PresentationVisualReviewResponse | undefined;
            try {
              await emitProgress("reviewing", {
                pptxPath: outputPath,
                previewPaths: [...previewPaths],
                isDraft: true,
              });
              finalReview = await visualReviewer({
                stage: "final",
                title: request.title,
                outline: appendPresentationVisualWarnings(
                  buildPresentationVisualReviewOutline(renderableRequest),
                  revised.visualWarnings,
                ),
                previewSlides: revised.previewSlides,
              });
              visualReviewRounds += 1;
            } catch (reviewError) {
              const summary = `Final presentation visual quality review failed before export: ${getErrorMessage(reviewError)}`;
              if (strictQuality) throw new Error(summary);
              acceptReleaseVisualWarning(summary);
            }
            if (finalReview && finalReview.verdict !== "pass") {
              structuralRepairIssue = `Final visual review did not approve the deck: ${finalReview.summary}`;
            }
            if (!strictQuality && finalReview?.verdict !== "pass") {
              await restorePersistedDraft(lastUsableDraft);
              renderableRequest = lastUsableRenderableRequest;
              acceptReleaseVisualWarning(
                "Kept the previous usable deck because the bounded visual revision was not approved.",
              );
            }
          } catch (revisionError) {
            const summary = `Presentation visual revision could not produce a replacement deck: ${getErrorMessage(revisionError)}`;
            if (strictQuality) throw new Error(summary);
            acceptReleaseVisualWarning(summary);
          }
        }
      }

      if (structuralRepairIssue) {
        let repairedRequest: PresentationRequest | undefined;
        let structuralRepairAttemptFailed = false;
        try {
          repairedRequest = await runFullStructuralRepair(
            "visual",
            [
              structuralRepairIssue,
              "Rebuild the affected slide structure instead of returning another lightweight patch. Replace duplicate or weak evidence, enlarge the primary evidence region, and remove planned empty canvas.",
            ],
            request,
          );
        } catch (repairError) {
          const summary = `Presentation visual structural repair failed after a usable deck was already rendered: ${getErrorMessage(repairError)}`;
          if (strictQuality) {
            throw new Error(summary);
          }
          structuralRepairAttemptFailed = true;
          acceptReleaseVisualWarning(summary);
        }
        if (structuralRepairAttemptFailed) {
          // Production preserves the last successfully rendered deck when an
          // editorial repair attempt fails. The bytes above remain exportable.
        } else if (!repairedRequest) {
          const summary = `Presentation visual quality gate rejected the deck and no full structural replan was available: ${structuralRepairIssue}`;
          if (strictQuality) {
            throw new Error(summary);
          }
          acceptReleaseVisualWarning(summary);
        } else {
          const lastUsableRequest = request;
          const lastUsableRenderableRequest = renderableRequest;
          const lastUsableDraft = {
            bytes,
            previewPaths: [...previewPaths],
          };
          let repairedDeckApproved = false;
          try {
            const repairedResolved = await resolveCandidate(repairedRequest);
            let repaired = await renderPreview(
              repairedResolved.renderableRequest,
              repairedResolved.request.slides.length,
            );
            resolved = repairedResolved;
            request = repairedResolved.request;
            renderableRequest = repairedResolved.renderableRequest;
            bytes = repaired.bytes;
            let repairedReview: PresentationVisualReviewResponse | undefined;
            try {
              await emitProgress("reviewing", {
                pptxPath: outputPath,
                previewPaths: [...previewPaths],
                isDraft: true,
              });
              repairedReview = await visualReviewer({
                stage: "draft",
                title: request.title,
                outline: appendPresentationVisualWarnings(
                  buildPresentationVisualReviewOutline(renderableRequest),
                  repaired.visualWarnings,
                ),
                previewSlides: repaired.previewSlides,
              });
              visualReviewRounds += 1;
            } catch (reviewError) {
              const summary = `Presentation visual review failed after structural repair: ${getErrorMessage(reviewError)}`;
              if (strictQuality) throw new Error(summary);
              acceptReleaseVisualWarning(summary);
            }
            if (repairedReview?.verdict === "pass") {
              repairedDeckApproved = true;
              acceptVisualReviewSuccess(
                `Full structural repair approved after visual rejection: ${repairedReview.summary}`,
              );
            } else if (repairedReview?.verdict === "revise") {
              const baselineQualityErrors = new Set(
                validatePresentationQuality(
                  renderableRequest as unknown as PresentationRequest,
                ),
              );
              const patchedRequest = applyPresentationVisualReviewPatches(
                renderableRequest,
                repairedReview.patches || [],
                repairedReview.deckPatch,
              );
              const patchedQualityErrors =
                filterBlockingPresentationQualityIssues(
                  validatePresentationQuality(
                    patchedRequest as unknown as PresentationRequest,
                  ).filter((error) => !baselineQualityErrors.has(error)),
                  strictQuality,
                );
              if (patchedQualityErrors.length > 0) {
                const summary = `Presentation visual patch after structural repair introduced new quality diagnostics: ${patchedQualityErrors
                  .slice(0, 8)
                  .join("; ")}`;
                throw new Error(summary);
              } else {
                const patched = await renderPreview(
                  patchedRequest,
                  request.slides.length,
                );
                renderableRequest = patchedRequest;
                repaired = patched;
                bytes = repaired.bytes;
                let terminalReview:
                  | PresentationVisualReviewResponse
                  | undefined;
                try {
                  await emitProgress("reviewing", {
                    pptxPath: outputPath,
                    previewPaths: [...previewPaths],
                    isDraft: true,
                  });
                  terminalReview = await visualReviewer({
                    stage: "final",
                    title: request.title,
                    outline: appendPresentationVisualWarnings(
                      buildPresentationVisualReviewOutline(renderableRequest),
                      repaired.visualWarnings,
                    ),
                    previewSlides: repaired.previewSlides,
                  });
                  visualReviewRounds += 1;
                } catch (reviewError) {
                  const summary = `Terminal visual review failed after the bounded structural-repair patch: ${getErrorMessage(reviewError)}`;
                  if (strictQuality) throw new Error(summary);
                  acceptReleaseVisualWarning(summary);
                }
                if (terminalReview?.verdict === "pass") {
                  repairedDeckApproved = true;
                  acceptVisualReviewSuccess(
                    `Full structural repair and one bounded visual patch approved: ${terminalReview.summary}`,
                  );
                } else if (terminalReview) {
                  const summary = `Presentation visual quality gate did not approve the patched structural repair: ${terminalReview.summary}`;
                  if (releaseBlocksVisualReview(terminalReview)) {
                    throw new Error(summary);
                  }
                  acceptReleaseVisualWarning(summary);
                }
              }
            } else if (repairedReview) {
              const summary = `Presentation visual quality gate did not approve the structurally repaired deck: ${repairedReview.summary}`;
              if (releaseBlocksVisualReview(repairedReview)) {
                throw new Error(summary);
              }
              acceptReleaseVisualWarning(summary);
            }
            if (!strictQuality && !repairedDeckApproved) {
              await restorePersistedDraft(lastUsableDraft);
              request = lastUsableRequest;
              renderableRequest = lastUsableRenderableRequest;
              acceptReleaseVisualWarning(
                "Kept the previous usable deck because the visual repair was not approved.",
              );
            }
          } catch (repairRenderError) {
            if (strictQuality) throw repairRenderError;
            request = lastUsableRequest;
            renderableRequest = lastUsableRenderableRequest;
            await restorePersistedDraft(lastUsableDraft);
            const summary = `Presentation visual repair could not replace the last usable deck: ${getErrorMessage(repairRenderError)}`;
            acceptReleaseVisualWarning(summary);
          }
        }
      }
    } else {
      await emitProgress("rendering");
      bytes = await renderer.renderPresentation(renderableRequest);
      const paths = await ensureOutputPaths();
      await emitProgress("exporting", { isDraft: true });
      await atomicWritePresentationFile(paths.outputPath, bytes);
      hasPersistedDraft = true;
      persistedPresentationPath = paths.outputPath;
      await emitProgress(
        "rendering",
        { pptxPath: paths.outputPath, previewPaths: [], isDraft: true },
        progressMessages.draftReady,
      );
    }
    if (!hasPersistedDraft || !outputPath) {
      throw new Error("Presentation renderer completed without a saved PPTX.");
    }
    await cleanupUnreferencedPresentationPreviews(
      persistedPresentationPreviewHistory,
      previewPaths,
      persistedPresentationsRoot,
    );
    await emitProgress("attaching", {
      pptxPath: outputPath,
      previewPaths: [...previewPaths],
      isDraft: true,
    });
    const attachment = await attachPresentationToZotero({
      outputPath,
      presentationTitle: request.title,
      sourceItemKey: request.sourceItemKey,
      sourceLibraryID: sourceContext?.libraryID,
    });
    if (attachment.warning) {
      acceptReleaseVisualWarning(attachment.warning);
    }

    await emitProgress("completed", {
      pptxPath: attachment.path,
      previewPaths: [...previewPaths],
      isDraft: false,
    });

    return JSON.stringify({
      status: visualReviewSummary?.startsWith(
        "Exported with non-blocking visual review warnings:",
      )
        ? "completed_with_warnings"
        : "completed",
      path: attachment.path,
      draftPath: attachment.path,
      previewPaths,
      fileName: PathUtils.filename(outputPath),
      slideCount: request.slides.length + 1,
      bytes: bytes.length,
      editable: true,
      runtime: "PaperChat XPI",
      visualReview: visualReviewStatus,
      visualReviewSummary,
      visualReviewRounds,
      planningRounds,
      attachmentStatus: attachment.status,
      attachmentItemID: attachment.itemID,
      attachmentItemKey: attachment.itemKey,
      attachmentParentItemID: attachment.parentItemID,
      attachmentMode: attachment.mode,
      attachmentWarning: attachment.warning,
    });
  } catch (error) {
    const detail = getErrorMessage(error);
    if (typeof ztoolkit !== "undefined") {
      ztoolkit.log(`[presentation] Generation failed: ${detail}`);
    }
    if (!strictQuality && persistedPresentationPath) {
      await cleanupUnreferencedPresentationPreviews(
        persistedPresentationPreviewHistory,
        persistedPresentationPreviewPaths,
        persistedPresentationsRoot,
      );
      await emitProgress("attaching", {
        pptxPath: persistedPresentationPath,
        previewPaths: persistedPresentationPreviewPaths,
        isDraft: true,
      });
      let recoveredAttachment;
      try {
        recoveredAttachment = await attachPresentationToZotero({
          outputPath: persistedPresentationPath,
          presentationTitle: request.title,
          sourceItemKey: request.sourceItemKey,
          sourceLibraryID: sourceContext?.libraryID,
        });
      } catch (attachmentError) {
        const attachmentWarning = `PPTX was generated and remains available at ${persistedPresentationPath}, but Zotero could not attach the recovered draft: ${getErrorMessage(attachmentError)}`;
        if (typeof ztoolkit !== "undefined") {
          ztoolkit.log(`[presentation] ${attachmentWarning}`);
        }
        await emitProgress("completed", {
          pptxPath: persistedPresentationPath,
          previewPaths: persistedPresentationPreviewPaths,
          isDraft: false,
        });
        return JSON.stringify({
          status: "completed_with_warnings",
          path: persistedPresentationPath,
          draftPath: persistedPresentationPath,
          previewPaths: persistedPresentationPreviewPaths,
          fileName: PathUtils.filename(persistedPresentationPath),
          slideCount: request.slides.length + 1,
          editable: true,
          runtime: "PaperChat XPI",
          visualReview: "warnings",
          visualReviewSummary: `Exported the last successfully rendered draft after a later generation step failed: ${detail}`,
          attachmentStatus: "not_attached",
          attachmentWarning,
        });
      }
      await emitProgress("completed", {
        pptxPath: recoveredAttachment.path,
        previewPaths: persistedPresentationPreviewPaths,
        isDraft: false,
      });
      return JSON.stringify({
        status: "completed_with_warnings",
        path: recoveredAttachment.path,
        draftPath: recoveredAttachment.path,
        previewPaths: persistedPresentationPreviewPaths,
        fileName: PathUtils.filename(recoveredAttachment.path),
        slideCount: request.slides.length + 1,
        editable: true,
        runtime: "PaperChat XPI",
        visualReview: "warnings",
        visualReviewSummary: `Exported the last successfully rendered draft after a later generation step failed: ${detail}`,
        attachmentStatus: recoveredAttachment.status,
        attachmentItemID: recoveredAttachment.itemID,
        attachmentItemKey: recoveredAttachment.itemKey,
        attachmentParentItemID: recoveredAttachment.parentItemID,
        attachmentMode: recoveredAttachment.mode,
        attachmentWarning: recoveredAttachment.warning,
      });
    }
    return formatPresentationError({
      summary: "Presentation generation failed.",
      retryable: true,
      cause: detail,
      suggestedFix:
        "PaperChat did not write a PPTX. Retry the presentation request to rerun planning, rendering, verification, and file export from scratch.",
    });
  }
}

function appendPresentationVisualWarnings(
  outline: string,
  warnings: readonly string[] | undefined,
): string {
  if (!warnings?.length) return outline;
  return [
    outline,
    "Pre-render visual diagnostics (judge against the supplied slide images; revise or reject when these are visibly harmful):",
    ...warnings.map((warning) => `- ${warning}`),
  ].join("\n");
}
