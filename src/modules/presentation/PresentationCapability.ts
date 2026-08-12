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

const PRESENTATIONS_FOLDER = "presentations";

export function createPresentationToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "presentation",
      description:
        "Create a polished, editable six-page PowerPoint from the current Zotero paper. Call this directly for a normal request such as '为这篇论文生成一个 PPT'. Provide only the current sourceItemKey and any explicit language or style preference; when language is omitted or auto, PaperChat uses Zotero's current interface language. PaperChat performs detailed evidence planning, figure selection, rendering, visual review, and export internally.",
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
    sourceItemKey: intent.sourceItemKey || planned.sourceItemKey,
    language: intent.language || planned.language,
    title: intent.title || planned.title,
    author:
      planned.author?.trim() ||
      resolvePresentationAuthor(paper.metadata.authors, intent.language),
    designSystem: intent.designSystem || planned.designSystem,
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

function validatePresentationCandidate(input: unknown): {
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
  const strictQuality = shouldUseStrictPresentationQualityGate(
    typeof __env__ === "undefined" ? undefined : __env__,
  );
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
): Promise<string> {
  const strictQuality = shouldUseStrictPresentationQualityGate(
    typeof __env__ === "undefined" ? undefined : __env__,
  );
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
      } as PresentationIntent;
      const mergeIntent = (planned: PresentationRequest): unknown =>
        mergePresentationPlanMetadata(planned, intent, paper);
      resolvedIntent = intent;
      mergePlannedIntent = mergeIntent;
      let planned = await planner({ intent, paper });
      planningRounds += 1;
      requestInput = mergeIntent(planned);
      let validation = validatePresentationCandidate(requestInput);
      if (!validation.request) {
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
        validation = validatePresentationCandidate(requestInput);
      }
      if (
        !strictQuality &&
        validation.request &&
        validation.issues.length > 0
      ) {
        const usableRequest = validation.request;
        const originalIssues = validation.issues;
        try {
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
          const improvedValidation =
            validatePresentationCandidate(improvedInput);
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

  const validation = validatePresentationCandidate(requestInput);
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

    const invariantIssues = [
      "Preserve the complete paper-deck contract while repairing the listed defect: exactly five content slides, at least three unique real paper-figure placements across at least two content slides, four composition silhouettes, and a complete conclusion slide.",
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
      );
      if (!repairedValidation.request) {
        throw new Error(
          `Presentation ${kind} repair remained invalid after targeted validation repair: ${repairedValidation.issues.join("; ")}`,
        );
      }
    }
    return repairedValidation.request;
  };

  try {
    const renderer = getPresentationRenderer();
    const resolveCandidate = async (
      candidate: PresentationRequest,
    ): Promise<{
      request: PresentationRequest;
      renderableRequest: Awaited<ReturnType<typeof resolvePresentationMedia>>;
    }> => {
      try {
        return {
          request: candidate,
          renderableRequest: await resolvePresentationMedia(candidate),
        };
      } catch (error) {
        if (!(error instanceof PresentationResolvedMediaDuplicateError)) {
          throw error;
        }
        const repaired = await runFullStructuralRepair(
          "media",
          error.issues,
          candidate,
        );
        if (!repaired) throw error;
        return {
          request: repaired,
          renderableRequest: await resolvePresentationMedia(repaired),
        };
      }
    };
    const renderPreview = async (
      candidate: Awaited<ReturnType<typeof resolvePresentationMedia>>,
      expectedContentSlides: number,
    ) => {
      const rendered = await renderer.renderPresentationWithPreview(candidate);
      if (rendered.previewSlides.length !== expectedContentSlides + 1) {
        throw new Error(
          `Presentation visual preview produced ${rendered.previewSlides.length} slides; expected ${expectedContentSlides + 1}.`,
        );
      }
      return rendered;
    };

    let resolved = await resolveCandidate(request);
    request = resolved.request;
    let renderableRequest = resolved.renderableRequest;
    let bytes: Uint8Array;
    let visualReviewRounds = 0;
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
          try {
            const revised = await renderPreview(
              revisedRequest,
              request.slides.length,
            );
            renderableRequest = revisedRequest;
            bytes = revised.bytes;
            let finalReview: PresentationVisualReviewResponse | undefined;
            try {
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
          const lastUsableBytes = bytes;
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
          } catch (repairRenderError) {
            if (strictQuality) throw repairRenderError;
            request = lastUsableRequest;
            renderableRequest = lastUsableRenderableRequest;
            bytes = lastUsableBytes;
            const summary = `Presentation visual repair could not replace the last usable deck: ${getErrorMessage(repairRenderError)}`;
            acceptReleaseVisualWarning(summary);
          }
        }
      }
    } else {
      bytes = await renderer.renderPresentation(renderableRequest);
    }
    const folder = getDataPath(PRESENTATIONS_FOLDER);
    await IOUtils.makeDirectory(folder, { createAncestors: true });

    const requestedBase = request.fileName?.replace(/\.pptx$/i, "");
    const fileBase = sanitizeFileBase(requestedBase || request.title);
    const outputPath = PathUtils.join(
      folder,
      `${fileBase}-${Date.now()}-${generateShortId()}.pptx`,
    );
    await IOUtils.write(outputPath, bytes, {
      flush: true,
      tmpPath: `${outputPath}.tmp-${generateShortId()}`,
    });
    const attachment = await attachPresentationToZotero({
      outputPath,
      presentationTitle: request.title,
      sourceItemKey: request.sourceItemKey,
    });
    if (attachment.warning) {
      acceptReleaseVisualWarning(attachment.warning);
    }

    return JSON.stringify({
      status: visualReviewSummary?.startsWith(
        "Exported with non-blocking visual review warnings:",
      )
        ? "completed_with_warnings"
        : "completed",
      path: attachment.path,
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
