import { assert } from "chai";
import {
  applyPresentationVisualReviewPatches,
  buildPresentationVisualReviewOutline,
  parsePresentationVisualReviewResponse,
} from "../src/modules/presentation/PresentationVisualReview.ts";
import {
  executePresentationCapability,
  isPathInsidePresentationRoot,
  resetPresentationRendererForTests,
} from "../src/modules/presentation/index.ts";
import { isTrustedPresentationPreviewPath } from "../src/modules/presentation/PresentationCapability.ts";
import { PRESENTATION_RENDERER_GLOBAL } from "../src/modules/presentation/contracts.ts";
import { validatePresentationQuality } from "../src/modules/presentation/PresentationQualityGate.ts";

describe("presentation visual review", function () {
  it("accepts preview images only below the PaperChat presentations root across platforms", function () {
    assert.isTrue(
      isTrustedPresentationPreviewPath(
        "/zotero-data/paper-chat/presentations/deck-previews/generation-01-slide-01.png",
        "/zotero-data/paper-chat/presentations",
      ),
    );
    assert.isFalse(
      isTrustedPresentationPreviewPath(
        "/zotero-data/paper-chat/presentations-elsewhere/slide-01.png",
        "/zotero-data/paper-chat/presentations",
      ),
    );
    assert.isFalse(
      isTrustedPresentationPreviewPath(
        "/zotero-data/paper-chat/presentations/deck-previews/../../outside.png",
        "/zotero-data/paper-chat/presentations",
      ),
    );
    assert.isTrue(
      isTrustedPresentationPreviewPath(
        "c:\\Zotero\\paper-chat\\presentations\\deck-previews\\generation-02-slide-01.PNG",
        "C:\\Zotero\\paper-chat\\presentations",
      ),
    );
    assert.isFalse(
      isTrustedPresentationPreviewPath(
        "C:\\Zotero\\paper-chat\\presentations-old\\slide-01.png",
        "C:\\Zotero\\paper-chat\\presentations",
      ),
    );
    assert.isTrue(
      isTrustedPresentationPreviewPath(
        "\\\\Server\\Zotero\\paper-chat\\presentations\\deck-previews\\generation-03-slide-01.png",
        "\\\\server\\zotero\\paper-chat\\presentations",
      ),
    );
  });

  it("authorizes PPTX paths without prefix, traversal, or Windows case bypasses", function () {
    assert.isTrue(
      isPathInsidePresentationRoot(
        "/zotero-data/paper-chat/presentations/deck.pptx",
        "/zotero-data/paper-chat/presentations",
      ),
    );
    assert.isFalse(
      isPathInsidePresentationRoot(
        "/zotero-data/paper-chat/presentations-old/deck.pptx",
        "/zotero-data/paper-chat/presentations",
      ),
    );
    assert.isFalse(
      isPathInsidePresentationRoot(
        "/zotero-data/paper-chat/presentations/../../deck.pptx",
        "/zotero-data/paper-chat/presentations",
      ),
    );
    assert.isTrue(
      isPathInsidePresentationRoot(
        "\\\\SERVER\\Zotero\\Storage\\ABCD\\deck.pptx",
        "\\\\server\\zotero\\storage",
      ),
    );
  });

  it("parses a fenced review and applies only bounded presentation patches", function () {
    const review = parsePresentationVisualReviewResponse(`\n\`\`\`json\n{
      "verdict": "revise",
      "summary": "The second slide is too dense.",
      "deckPatch": {
        "coverLayout": "editorial-collage",
        "coverTitleScale": "large",
        "swapCoverFigureOrder": true,
        "dropCoverEvidenceLine": true
      },
      "patches": [{
        "slideNumber": 2,
        "title": "One figure carries the argument",
        "figureEmphasis": "dominant",
        "swapFigureOrder": true,
        "dropFields": ["bullets", "metrics", "figure", "matrix", "timeline", "chart"]
      }]
    }\n\`\`\``);
    assert.equal(review.verdict, "revise");
    assert.deepEqual(review.deckPatch, {
      coverLayout: "editorial-collage",
      coverTitleScale: "large",
      swapCoverFigureOrder: true,
      dropCoverEvidenceLine: true,
    });
    assert.deepEqual(review.patches?.[0].dropFields, [
      "bullets",
      "metrics",
      "figure",
      "matrix",
      "timeline",
      "chart",
    ]);

    const figure1 = {
      itemKey: "paper-item",
      page: 3,
      captionHint: "Figure 1:",
      data: "data:image/png;base64,AAAA",
      pixelWidth: 800,
      pixelHeight: 500,
    };
    const figure2 = {
      itemKey: "paper-item",
      page: 4,
      captionHint: "Figure 2:",
      data: "data:image/png;base64,BBBB",
      pixelWidth: 900,
      pixelHeight: 520,
    };
    const revised = applyPresentationVisualReviewPatches(
      {
        title: "Paper",
        coverFigure: figure1,
        coverFigures: [figure1, figure2],
        slides: [
          {
            title: "Dense slide",
            layout: "split",
            bullets: ["A", "B"],
            metrics: [{ value: "15.3%", label: "Top-5 error" }],
            figures: [figure1, figure2],
          },
        ],
      },
      review.patches || [],
      review.deckPatch,
    );
    assert.equal(revised.visualTuning?.layout, "editorial-collage");
    assert.equal(revised.visualTuning?.titleScale, "large");
    assert.equal(revised.visualTuning?.hideEvidenceLine, true);
    assert.deepEqual(revised.coverFigures, [figure2, figure1]);
    assert.deepEqual(revised.coverFigure, figure2);
    assert.equal(revised.slides[0].layout, "gallery");
    assert.equal(revised.slides[0].title, "One figure carries the argument");
    assert.notProperty(revised.slides[0], "bullets");
    assert.equal(revised.slides[0].keyMessage, "A");
    assert.notProperty(revised.slides[0], "metrics");
    assert.deepEqual(revised.slides[0].figures, [figure2, figure1]);
    assert.equal(revised.slides[0].visualTuning?.figureEmphasis, "dominant");
  });

  it("parses an explicit visual failure class for release gating", function () {
    const review = parsePresentationVisualReviewResponse(`{
      "verdict": "reject",
      "summary": "The primary figure is catastrophically cropped.",
      "failureClass": "render_safety"
    }`);

    assert.equal(review.failureClass, "render_safety");
  });

  it("includes cover and slide figure anchors in the visual-review outline", function () {
    const outline = buildPresentationVisualReviewOutline({
      title: "Paper",
      language: "zh-CN",
      sourceItemKey: "paper-item",
      coverFigure: {
        page: 3,
        captionHint: "Figure 1:",
        data: "data:image/png;base64,AAAA",
        pixelWidth: 800,
        pixelHeight: 500,
      },
      slides: [
        {
          title: "Method",
          layout: "figure",
          chart: {
            type: "bar",
            orientation: "horizontal",
            labels: ["Sparse coding", "SIFT + FVs", "CNN"],
            series: [
              { name: "Top-1 error", values: [47.1, 45.7, 37.5] },
              { name: "Top-5 error", values: [28.2, 25.7, 17] },
            ],
          },
          figure: {
            page: 4,
            captionHint: "Figure 2:",
            data: "data:image/png;base64,BBBB",
            pixelWidth: 900,
            pixelHeight: 420,
          },
        },
      ],
    });

    assert.include(outline, '"captionAnchor": "Figure 1:"');
    assert.include(outline, '"captionAnchor": "Figure 2:"');
    assert.include(outline, '"pixelSize": "900x420"');
    assert.include(outline, '"language": "zh-CN"');
    assert.include(outline, '"labels": [');
    assert.include(outline, '"Sparse coding"');
    assert.include(outline, '"name": "Top-5 error"');
    assert.include(outline, "28.2");
  });

  it("keeps an explicit process layout when dominant evidence is requested", function () {
    const figure = {
      itemKey: "paper-item",
      page: 5,
      captionHint: "Figure 2:",
      data: "data:image/png;base64,AAAA",
      pixelWidth: 1400,
      pixelHeight: 500,
    };
    const revised = applyPresentationVisualReviewPatches(
      {
        title: "Paper",
        slides: [
          {
            title: "The method stays a process",
            layout: "process",
            process: [
              { title: "Input" },
              { title: "Features" },
              { title: "Prediction" },
            ],
            figure,
            callouts: [{ label: "Detail", text: "Compact supporting detail." }],
          },
        ],
      } as any,
      [
        {
          slideNumber: 2,
          layout: "process",
          figureEmphasis: "dominant",
          dropFields: ["callouts"],
        },
      ],
    );

    assert.equal(revised.slides[0].layout, "process");
    assert.equal(revised.slides[0].visualTuning?.figureEmphasis, "dominant");
    assert.lengthOf(revised.slides[0].process || [], 3);
    assert.notProperty(revised.slides[0], "callouts");
  });

  it("renders, revises, re-reviews, and writes only the visually approved deck", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const renderedTitles: string[] = [];
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const removedPaths: string[] = [];
    const progressUpdates: any[] = [];
    let renderCount = 0;
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 4]),
            renderPresentationWithPreview: async (spec: any) => {
              renderCount += 1;
              renderedTitles.push(spec.slides[0].title);
              return {
                bytes: new Uint8Array([0x50, 0x4b, 3, renderCount]),
                previewSlides: [
                  "data:image/png;base64,AAAA",
                  "data:image/png;base64,BBBB",
                ],
                visualWarnings:
                  renderCount === 1
                    ? ["gallery slide 2 gives figures too little canvas."]
                    : [],
              };
            },
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string, bytes: Uint8Array) => {
        writes.push({ path, bytes });
      },
      remove: async (path: string) => {
        removedPaths.push(path);
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    let reviewRound = 0;
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {
          title: "Visual review deck",
          slides: [
            {
              title: "The original claim",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async ({ stage, previewSlides, outline }) => {
          reviewRound += 1;
          assert.lengthOf(previewSlides, 2);
          if (stage === "draft") {
            assert.include(outline, "Pre-render visual diagnostics");
            assert.include(outline, "gallery slide 2");
          }
          return stage === "draft"
            ? {
                verdict: "revise",
                summary: "Shorten the title.",
                patches: [
                  {
                    slideNumber: 2,
                    title: "The evidence is decisive",
                    layout: "evidence",
                  },
                ],
              }
            : { verdict: "pass", summary: "Presentation-ready." };
        },
        undefined,
        undefined,
        async (update) => progressUpdates.push(update),
      );

      assert.equal(reviewRound, 2);
      assert.equal(renderCount, 2);
      assert.deepEqual(renderedTitles, [
        "The original claim",
        "The evidence is decisive",
      ]);
      const pptxWrites = writes.filter(({ path }) => path.endsWith(".pptx"));
      const pngWrites = writes.filter(({ path }) => path.endsWith(".png"));
      assert.lengthOf(pptxWrites, 2);
      assert.equal(pptxWrites[0].bytes[3], 1);
      assert.equal(pptxWrites[1].bytes[3], 2);
      assert.equal(pptxWrites[0].path, pptxWrites[1].path);
      assert.lengthOf(pngWrites, 4);
      assert.equal(new Set(pngWrites.map(({ path }) => path)).size, 4);
      assert.match(
        pngWrites[0].path,
        /-previews\/generation-01-slide-01\.png$/,
      );
      assert.match(
        pngWrites[2].path,
        /-previews\/generation-02-slide-01\.png$/,
      );
      assert.deepEqual(
        progressUpdates.slice(0, 4).map(({ phase }) => phase),
        ["analyzing", "planning", "resolving_media", "rendering"],
      );
      assert.includeMembers(
        progressUpdates.map(({ phase }) => phase),
        ["reviewing", "repairing", "exporting", "attaching", "completed"],
      );
      const draftReady = progressUpdates.find(
        ({ pptxPath, previewPaths, isDraft }) =>
          pptxPath && previewPaths?.length === 2 && isDraft === true,
      );
      assert.match(draftReady.pptxPath, /\/presentations\/.*\.pptx$/);
      assert.match(
        draftReady.previewPaths[0],
        /-previews\/generation-01-slide-01\.png$/,
      );
      assert.notMatch(
        JSON.stringify(progressUpdates),
        /data:image\/png;base64/,
      );
      const payload = JSON.parse(result);
      assert.equal(payload.draftPath, payload.path);
      assert.lengthOf(payload.previewPaths, 2);
      assert.match(
        payload.previewPaths[0],
        /-previews\/generation-02-slide-01\.png$/,
      );
      assert.lengthOf(removedPaths, 2);
      assert.isTrue(
        removedPaths.every((path) => path.includes("generation-01-slide-")),
      );
      assert.isFalse(
        removedPaths.some((path) => path.includes("generation-02-slide-")),
      );
      assert.include(result, '"visualReview":"passed"');
      assert.include(result, '"visualReviewRounds":2');
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });

  it("exports without previews when preview rendering transport fails in advisory mode", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const pptxWrites: Uint8Array[] = [];
    let fallbackRenderCount = 0;
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => {
              fallbackRenderCount += 1;
              return new Uint8Array([0x50, 0x4b, 3, 9]);
            },
            renderPresentationWithPreview: async () => {
              throw new Error("preview transport unavailable");
            },
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string, bytes: Uint8Array) => {
        if (path.endsWith(".pptx")) pptxWrites.push(bytes);
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {
          title: "Preview transport fallback",
          slides: [
            {
              title: "The evidence remains editable",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async ({ previewSlides }) => {
          assert.deepEqual(previewSlides, []);
          return { verdict: "pass", summary: "PPTX fallback is usable." };
        },
      );

      const payload = JSON.parse(result);
      assert.equal(payload.status, "completed_with_warnings");
      assert.equal(payload.visualReview, "warnings");
      assert.include(
        payload.visualReviewSummary,
        "preview transport unavailable",
      );
      assert.deepEqual(payload.previewPaths, []);
      assert.equal(fallbackRenderCount, 1);
      assert.lengthOf(pptxWrites, 1);
      assert.equal(pptxWrites[0][3], 9);

      const strictResult = await executePresentationCapability(
        {
          title: "Strict preview transport failure",
          slides: [
            {
              title: "The evidence remains editable",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async () => ({ verdict: "pass", summary: "Not reached." }),
        undefined,
        undefined,
        undefined,
        { strictQualityGate: true },
      );

      assert.match(strictResult, /^Error: Presentation generation failed/);
      assert.include(strictResult, "preview transport unavailable");
      assert.equal(fallbackRenderCount, 1);
      assert.lengthOf(pptxWrites, 1);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });

  it("exports PPTX bytes but omits an incomplete preview set in advisory mode", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 8]),
            renderPresentationWithPreview: async () => ({
              bytes: new Uint8Array([0x50, 0x4b, 3, 7]),
              previewSlides: ["data:image/png;base64,AAAA"],
            }),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string, bytes: Uint8Array) => {
        writes.push({ path, bytes });
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {
          title: "Incomplete preview fallback",
          slides: [
            {
              title: "The evidence remains editable",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async ({ previewSlides }) => {
          assert.deepEqual(previewSlides, []);
          return { verdict: "pass", summary: "PPTX bytes are usable." };
        },
      );

      const payload = JSON.parse(result);
      assert.equal(payload.status, "completed_with_warnings");
      assert.equal(payload.visualReview, "warnings");
      assert.include(
        payload.visualReviewSummary,
        "visual preview produced 1 slides; expected 2",
      );
      assert.deepEqual(payload.previewPaths, []);
      const pptxWrites = writes.filter(({ path }) => path.endsWith(".pptx"));
      const pngWrites = writes.filter(({ path }) => path.endsWith(".png"));
      assert.lengthOf(pptxWrites, 1);
      assert.equal(pptxWrites[0].bytes[3], 7);
      assert.lengthOf(pngWrites, 0);

      const strictResult = await executePresentationCapability(
        {
          title: "Strict incomplete preview",
          slides: [
            {
              title: "The evidence remains editable",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async () => ({ verdict: "pass", summary: "Not reached." }),
        undefined,
        undefined,
        undefined,
        { strictQualityGate: true },
      );

      assert.match(strictResult, /^Error: Presentation generation failed/);
      assert.include(
        strictResult,
        "visual preview produced 1 slides; expected 2",
      );
      assert.lengthOf(
        writes.filter(({ path }) => path.endsWith(".pptx")),
        1,
      );
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });

  it("keeps safe visual edits when media resolution already left a diagnostic", function () {
    const repeatedComposition = {
      title: "Paper deck",
      sourceItemKey: "paper-item",
      coverFigure: { page: 1, captionHint: "Figure 0:" },
      slides: Array.from({ length: 5 }, (_, index) => ({
        title: `Evidence claim ${index + 1}`,
        layout: "evidence" as const,
        figure: {
          page: index + 2,
          captionHint: `Figure ${index + 1}:`,
        },
        equation: { expression: `x_${index + 1} = y_${index + 1}` },
      })),
    };
    const baselineErrors = validatePresentationQuality(repeatedComposition);
    assert.include(baselineErrors.join("\n"), "composition silhouette");

    const revised = applyPresentationVisualReviewPatches(
      repeatedComposition as any,
      [
        {
          slideNumber: 2,
          title: "A safer and clearer evidence claim",
          layout: "matrix",
        },
      ],
    );

    assert.equal(revised.slides[0].title, "A safer and clearer evidence claim");
    assert.equal(revised.slides[0].layout, "evidence");
    assert.deepEqual(
      validatePresentationQuality(revised as any),
      baselineErrors,
    );
  });

  it("keeps recoverable drafts when the explicit strict seam rejects visual review", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    let writeCount = 0;
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 4]),
            renderPresentationWithPreview: async () => ({
              bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
              previewSlides: [
                "data:image/png;base64,AAAA",
                "data:image/png;base64,BBBB",
              ],
            }),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string) => {
        if (path.endsWith(".pptx")) writeCount += 1;
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {
          title: "Rejected deck",
          slides: [
            {
              title: "The original claim",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async ({ stage }) =>
          stage === "draft"
            ? {
                verdict: "revise",
                summary: "Try a shorter title.",
                patches: [{ slideNumber: 2, title: "Shorter claim" }],
              }
            : {
                verdict: "reject",
                summary: "The evidence is still too small.",
              },
        undefined,
        undefined,
        undefined,
        { strictQualityGate: true },
      );

      assert.match(result, /^Error: Presentation generation failed/);
      assert.include(
        result,
        "no full structural replan was available: Final visual review did not approve the deck: The evidence is still too small.",
      );
      assert.equal(writeCount, 2);

      const draftRejectedResult = await executePresentationCapability(
        {
          title: "Draft rejected deck",
          slides: [
            {
              title: "The original claim",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async () => ({
          verdict: "reject",
          summary: "The composition is too repetitive.",
        }),
        undefined,
        undefined,
        undefined,
        { strictQualityGate: true },
      );

      assert.match(
        draftRejectedResult,
        /^Error: Presentation generation failed/,
      );
      assert.include(
        draftRejectedResult,
        "no full structural replan was available: Draft visual review rejected the deck: The composition is too repetitive.",
      );
      assert.equal(writeCount, 3);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });

  it("exports in production when single-module evidence only fails editorial gates", async function () {
    const runtime = globalThis as any;
    const previousEnv = runtime.__env__;
    const hadEnv = Object.prototype.hasOwnProperty.call(runtime, "__env__");
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    let writeCount = 0;
    runtime.__env__ = "production";
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 4]),
            renderPresentationWithPreview: async () => ({
              bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
              previewSlides: [
                "data:image/png;base64,AAAA",
                "data:image/png;base64,BBBB",
              ],
            }),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string) => {
        if (path.endsWith(".pptx")) writeCount += 1;
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {
          title: "Release deck",
          slides: [
            {
              title: "Evidence remains editable",
              layout: "evidence",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async () => ({
          verdict: "reject",
          summary:
            "Slide 2 lacks two separate evidence modules and needs more composition variety.",
        }),
      );

      if (result.startsWith("Error:")) throw new Error(result);
      const payload = JSON.parse(result);
      assert.equal(payload.status, "completed_with_warnings");
      assert.equal(payload.visualReview, "warnings");
      assert.include(payload.visualReviewSummary, "non-blocking");
      assert.equal(writeCount, 1);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
      if (hadEnv) runtime.__env__ = previousEnv;
      else delete runtime.__env__;
    }
  });

  it("writes a production deck when the planner returns the exact single-module evidence failure", async function () {
    const runtime = globalThis as any;
    const previousEnv = runtime.__env__;
    const hadEnv = Object.prototype.hasOwnProperty.call(runtime, "__env__");
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    let writeCount = 0;
    runtime.__env__ = "production";
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 4]),
            renderPresentationWithPreview: async () => ({
              bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
              previewSlides: [
                "data:image/png;base64,AAAA",
                "data:image/png;base64,BBBB",
              ],
            }),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string) => {
        if (path.endsWith(".pptx")) writeCount += 1;
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {},
        undefined,
        async () =>
          ({
            title: "Release deck",
            slides: [
              {
                title: "Single evidence module",
                layout: "evidence",
                metrics: [{ value: "17.0%", label: "Top-5 error" }],
              },
            ],
          }) as any,
        {
          metadata: { title: "Paper" },
          sections: [],
          fullText: "Evidence",
          pages: [],
          pageCount: 0,
        } as any,
      );

      const payload = JSON.parse(result);
      assert.equal(payload.status, "completed_with_warnings");
      assert.equal(payload.planningRounds, 2);
      assert.include(
        payload.visualReviewSummary,
        "Planning quality diagnostics",
      );
      assert.equal(writeCount, 1);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
      if (hadEnv) runtime.__env__ = previousEnv;
      else delete runtime.__env__;
    }
  });

  it("exports the original production draft when advisory planning repair fails", async function () {
    const runtime = globalThis as any;
    const previousEnv = runtime.__env__;
    const hadEnv = Object.prototype.hasOwnProperty.call(runtime, "__env__");
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    let writeCount = 0;
    let plannerCalls = 0;
    runtime.__env__ = "production";
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 4]),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string) => {
        if (path.endsWith(".pptx")) writeCount += 1;
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {},
        undefined,
        async (request) => {
          plannerCalls += 1;
          if (request.repair) {
            throw new Error("advisory repair unavailable");
          }
          return {
            title: "Usable release draft",
            slides: [
              {
                title: "Single evidence module",
                layout: "evidence",
                metrics: [{ value: "17.0%", label: "Top-5 error" }],
              },
            ],
          } as any;
        },
        {
          metadata: { title: "Paper" },
          sections: [],
          fullText: "Evidence",
          pages: [],
          pageCount: 0,
        } as any,
      );

      const payload = JSON.parse(result);
      assert.equal(payload.status, "completed_with_warnings");
      assert.equal(payload.planningRounds, 1);
      assert.include(
        payload.visualReviewSummary,
        "advisory repair unavailable",
      );
      assert.equal(plannerCalls, 2);
      assert.equal(writeCount, 1);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
      if (hadEnv) runtime.__env__ = previousEnv;
      else delete runtime.__env__;
    }
  });

  it("exports the best rendered production deck even when visual review reports render safety", async function () {
    const runtime = globalThis as any;
    const previousEnv = runtime.__env__;
    const hadEnv = Object.prototype.hasOwnProperty.call(runtime, "__env__");
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    let writeCount = 0;
    runtime.__env__ = "production";
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
      Libraries: { userLibraryID: 1, getAll: () => [] },
      Items: { getByLibraryAndKey: () => false, get: () => false },
      Attachments: {
        importFromFile: async () => {
          throw new Error("library is read-only");
        },
      },
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 4]),
            renderPresentationWithPreview: async () => ({
              bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
              previewSlides: [
                "data:image/png;base64,AAAA",
                "data:image/png;base64,BBBB",
              ],
            }),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string) => {
        if (path.endsWith(".pptx")) writeCount += 1;
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {
          title: "Unsafe release deck",
          slides: [
            {
              title: "Unreadable evidence",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async () => ({
          verdict: "reject",
          failureClass: "render_safety",
          summary: "The primary figure is catastrophically cropped.",
        }),
      );

      assert.notMatch(result, /^Error:/);
      const payload = JSON.parse(result);
      assert.equal(payload.status, "completed_with_warnings");
      assert.include(payload.visualReviewSummary, "catastrophically cropped");
      assert.include(payload.visualReviewSummary, "library is read-only");
      assert.include(payload.attachmentWarning, "library is read-only");
      assert.equal(writeCount, 1);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
      if (hadEnv) runtime.__env__ = previousEnv;
      else delete runtime.__env__;
    }
  });

  it("keeps the last usable production deck when a visual repair cannot render", async function () {
    const runtime = globalThis as any;
    const previousEnv = runtime.__env__;
    const hadEnv = Object.prototype.hasOwnProperty.call(runtime, "__env__");
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const writes: Uint8Array[] = [];
    const attemptedPreviewRemovals: string[] = [];
    let renderCount = 0;
    runtime.__env__ = "production";
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => {
              if (renderCount > 1) throw new Error("repair renderer failed");
              return new Uint8Array([0x50, 0x4b, 3, 1]);
            },
            renderPresentationWithPreview: async () => {
              renderCount += 1;
              if (renderCount > 1) throw new Error("repair renderer failed");
              return {
                bytes: new Uint8Array([0x50, 0x4b, 3, 1]),
                previewSlides: [
                  "data:image/png;base64,AAAA",
                  "data:image/png;base64,BBBB",
                ],
              };
            },
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string, bytes: Uint8Array) => {
        if (path.endsWith(".pptx")) writes.push(bytes);
        return bytes.length;
      },
      remove: async (path: string) => {
        attemptedPreviewRemovals.push(path);
        throw new Error("preview cleanup unavailable");
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {
          title: "Repair fallback deck",
          slides: [
            {
              title: "The usable original claim",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async () => ({
          verdict: "revise",
          summary: "Try a visual repair.",
          patches: [{ slideNumber: 2, subtitle: "Repaired subtitle" }],
        }),
      );

      if (result.startsWith("Error:")) throw new Error(result);
      const payload = JSON.parse(result);
      assert.equal(payload.status, "completed_with_warnings");
      assert.include(payload.visualReviewSummary, "repair renderer failed");
      assert.lengthOf(writes, 1);
      assert.equal(writes[0][3], 1);
      assert.deepEqual(attemptedPreviewRemovals, []);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
      if (hadEnv) runtime.__env__ = previousEnv;
      else delete runtime.__env__;
    }
  });

  it("restores the last usable production deck when a visual revision fails final review", async function () {
    const runtime = globalThis as any;
    const previousEnv = runtime.__env__;
    const hadEnv = Object.prototype.hasOwnProperty.call(runtime, "__env__");
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const diskWrites = new Map<string, Uint8Array>();
    const pptxWrites: Uint8Array[] = [];
    const attemptedPreviewRemovals: string[] = [];
    let renderCount = 0;
    runtime.__env__ = "production";
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () =>
              new Uint8Array([0x50, 0x4b, 3, renderCount || 1]),
            renderPresentationWithPreview: async () => {
              renderCount += 1;
              return {
                bytes: new Uint8Array([0x50, 0x4b, 3, renderCount]),
                previewSlides: [
                  "data:image/png;base64,AAAA",
                  "data:image/png;base64,BBBB",
                ],
              };
            },
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string, bytes: Uint8Array) => {
        const snapshot = new Uint8Array(bytes);
        diskWrites.set(path, snapshot);
        if (path.endsWith(".pptx")) pptxWrites.push(snapshot);
        return bytes.length;
      },
      remove: async (path: string) => {
        attemptedPreviewRemovals.push(path);
        throw new Error("preview cleanup unavailable");
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    let reviewRound = 0;
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {
          title: "Final-review fallback deck",
          slides: [
            {
              title: "The usable original claim",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async ({ stage }) => {
          reviewRound += 1;
          if (reviewRound === 1) {
            assert.equal(stage, "draft");
            return {
              verdict: "revise",
              summary: "Try one bounded title repair.",
              patches: [{ slideNumber: 2, title: "Revised claim" }],
            };
          }
          assert.equal(stage, "final");
          return {
            verdict: "reject",
            summary: "The revision made the evidence harder to read.",
          };
        },
      );

      if (result.startsWith("Error:")) throw new Error(result);
      const payload = JSON.parse(result);
      assert.equal(payload.status, "completed_with_warnings");
      assert.include(
        payload.visualReviewSummary,
        "The revision made the evidence harder to read",
      );
      assert.match(
        payload.previewPaths[0],
        /-previews\/generation-01-slide-01\.png$/,
      );
      assert.equal(diskWrites.get(payload.path)?.[3], 1);
      assert.deepEqual(
        pptxWrites.map((bytes) => bytes[3]),
        [1, 2, 1],
      );
      assert.lengthOf(attemptedPreviewRemovals, 2);
      assert.isTrue(
        attemptedPreviewRemovals.every((path) =>
          path.includes("generation-02-slide-"),
        ),
      );
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
      if (hadEnv) runtime.__env__ = previousEnv;
      else delete runtime.__env__;
    }
  });

  it("restores the last usable production deck when final visual review throws", async function () {
    const runtime = globalThis as any;
    const previousEnv = runtime.__env__;
    const hadEnv = Object.prototype.hasOwnProperty.call(runtime, "__env__");
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const diskWrites = new Map<string, Uint8Array>();
    const pptxWrites: number[] = [];
    let renderCount = 0;
    runtime.__env__ = "production";
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () =>
              new Uint8Array([0x50, 0x4b, 3, renderCount || 1]),
            renderPresentationWithPreview: async () => {
              renderCount += 1;
              return {
                bytes: new Uint8Array([0x50, 0x4b, 3, renderCount]),
                previewSlides: [
                  "data:image/png;base64,AAAA",
                  "data:image/png;base64,BBBB",
                ],
              };
            },
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string, bytes: Uint8Array) => {
        const snapshot = new Uint8Array(bytes);
        diskWrites.set(path, snapshot);
        if (path.endsWith(".pptx")) pptxWrites.push(snapshot[3]);
        return bytes.length;
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    let reviewRound = 0;
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {
          title: "Final-review exception fallback deck",
          slides: [
            {
              title: "The usable original claim",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async ({ stage }) => {
          reviewRound += 1;
          if (reviewRound === 1) {
            assert.equal(stage, "draft");
            return {
              verdict: "revise",
              summary: "Try one bounded title repair.",
              patches: [{ slideNumber: 2, title: "Revised claim" }],
            };
          }
          assert.equal(stage, "final");
          throw new Error("visual reviewer transport stopped");
        },
      );

      if (result.startsWith("Error:")) throw new Error(result);
      const payload = JSON.parse(result);
      assert.equal(payload.status, "completed_with_warnings");
      assert.include(
        payload.visualReviewSummary,
        "visual reviewer transport stopped",
      );
      assert.match(
        payload.previewPaths[0],
        /-previews\/generation-01-slide-01\.png$/,
      );
      assert.equal(diskWrites.get(payload.path)?.[3], 1);
      assert.deepEqual(pptxWrites, [1, 2, 1]);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
      if (hadEnv) runtime.__env__ = previousEnv;
      else delete runtime.__env__;
    }
  });

  it("exports the best rendered deck in production when an editorial structural repair fails", async function () {
    const runtime = globalThis as any;
    const previousEnv = runtime.__env__;
    const hadEnv = Object.prototype.hasOwnProperty.call(runtime, "__env__");
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    let writeCount = 0;
    let plannerCalls = 0;
    runtime.__env__ = "production";
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 4]),
            renderPresentationWithPreview: async () => ({
              bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
              previewSlides: [
                "data:image/png;base64,AAAA",
                "data:image/png;base64,BBBB",
              ],
            }),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string) => {
        if (path.endsWith(".pptx")) writeCount += 1;
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {},
        async () => ({
          verdict: "reject",
          failureClass: "editorial",
          summary: "Slide 2 needs two evidence modules.",
        }),
        async (request) => {
          plannerCalls += 1;
          if (request.repair) {
            throw new Error("editorial repair planner unavailable");
          }
          return {
            title: "Release deck",
            language: request.intent.language,
            slides: [
              {
                title: "Evidence remains editable",
                metrics: [{ value: "24%", label: "relative improvement" }],
              },
            ],
          } as any;
        },
        {
          metadata: { title: "Paper" },
          sections: [],
          fullText: "Evidence",
          pages: [],
          pageCount: 0,
        } as any,
      );

      if (!result.trim().startsWith("{")) throw new Error(result);
      const payload = JSON.parse(result);
      assert.equal(payload.status, "completed_with_warnings");
      assert.equal(payload.visualReview, "warnings");
      assert.include(
        payload.visualReviewSummary,
        "editorial repair planner unavailable",
      );
      assert.equal(plannerCalls, 2);
      assert.equal(writeCount, 1);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
      if (hadEnv) runtime.__env__ = previousEnv;
      else delete runtime.__env__;
    }
  });

  it("keeps the first draft when the explicit strict seam requires visual review", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    let writeCount = 0;
    runtime.Zotero = {
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 4]),
            renderPresentationWithPreview: async () => ({
              bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
              previewSlides: [
                "data:image/png;base64,AAAA",
                "data:image/png;base64,BBBB",
              ],
            }),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string) => {
        if (path.endsWith(".pptx")) writeCount += 1;
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {
          title: "Unreviewed deck",
          slides: [
            {
              title: "The evidence claim",
              metrics: [{ value: "24%", label: "relative improvement" }],
            },
          ],
        },
        async () => {
          throw new Error("review transport unavailable");
        },
        undefined,
        undefined,
        undefined,
        { strictQualityGate: true },
      );

      assert.match(result, /^Error: Presentation generation failed/);
      assert.include(
        result,
        "Presentation visual quality review failed before export",
      );
      assert.include(result, "review transport unavailable");
      assert.equal(writeCount, 1);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });

  it("repairs a structurally invalid visual replan before starting a fresh outer tool attempt", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const plannerRequests: any[] = [];
    let writeCount = 0;
    const validDeck = () => ({
      title: "证据支持核心结论",
      language: "zh-CN",
      slides: [
        {
          title: "一项关键指标验证研究判断",
          metrics: [{ value: "24%", label: "相对提升" }],
        },
      ],
    });
    runtime.Zotero = {
      locale: "zh-CN",
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 4]),
            renderPresentationWithPreview: async () => ({
              bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
              previewSlides: [
                "data:image/png;base64,AAAA",
                "data:image/png;base64,BBBB",
              ],
            }),
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string) => {
        if (path.endsWith(".pptx")) writeCount += 1;
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    let reviewRound = 0;
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {},
        async () => {
          reviewRound += 1;
          return reviewRound === 1
            ? {
                verdict: "reject",
                summary: "The evidence hierarchy still needs structural work.",
              }
            : { verdict: "pass", summary: "Presentation-ready." };
        },
        async (request) => {
          plannerRequests.push(request);
          if (plannerRequests.length === 1) return validDeck() as any;
          if (plannerRequests.length === 2) {
            const weak = validDeck() as any;
            weak.slides[0].title = "placeholder";
            return weak;
          }
          return validDeck() as any;
        },
        {
          metadata: { title: "Paper" },
          sections: [],
          fullText: "Evidence",
          pages: [],
          pageCount: 0,
        } as any,
        undefined,
        { strictQualityGate: true },
      );

      assert.lengthOf(plannerRequests, 3);
      assert.include(
        plannerRequests[1].repair.issues.join("\n"),
        "The first content slide must still express the research problem and gap",
      );
      assert.include(
        plannerRequests[2].repair.issues.join("\n"),
        "placeholder",
      );
      assert.include(result, '"visualReview":"passed"');
      assert.include(result, '"visualReviewRounds":2');
      assert.include(result, '"planningRounds":3');
      assert.equal(writeCount, 2);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });

  it("does not export a structurally repaired deck until terminal visual review passes", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const renderedTitles: string[] = [];
    const plannerRequests: any[] = [];
    let writeCount = 0;
    runtime.Zotero = {
      locale: "zh-CN",
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 4]),
            renderPresentationWithPreview: async (spec: any) => {
              renderedTitles.push(spec.slides[0].title);
              return {
                bytes: new Uint8Array([0x50, 0x4b, 3, renderedTitles.length]),
                previewSlides: [
                  "data:image/png;base64,AAAA",
                  "data:image/png;base64,BBBB",
                ],
              };
            },
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string) => {
        if (path.endsWith(".pptx")) writeCount += 1;
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    let reviewRound = 0;
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {},
        async () => {
          reviewRound += 1;
          return reviewRound === 1
            ? {
                verdict: "reject",
                summary:
                  "The evidence table is too small and leaves empty canvas.",
              }
            : {
                verdict: "reject",
                summary:
                  "The repaired evidence is usable but still leaves polish work.",
              };
        },
        async (request) => {
          plannerRequests.push(request);
          const repaired = Boolean(request.repair);
          return {
            title: repaired ? "重规划版本" : "初始版本",
            language: request.intent.language,
            slides: [
              {
                title: repaired ? "证据已占据主画布" : "证据仍然偏小",
                metrics: [{ value: "24%", label: "相对提升" }],
              },
            ],
          } as any;
        },
        {
          metadata: { title: "Paper" },
          sections: [],
          fullText: "Evidence",
          pages: [],
          pageCount: 0,
        } as any,
        undefined,
        { strictQualityGate: true },
      );

      assert.match(result, /^Error: Presentation generation failed/);
      assert.include(
        result,
        "Presentation visual quality gate did not approve the structurally repaired deck",
      );
      assert.include(result, "still leaves polish work");
      assert.deepEqual(renderedTitles, ["证据仍然偏小", "证据已占据主画布"]);
      assert.lengthOf(plannerRequests, 2);
      assert.include(
        plannerRequests[1].repair.issues.join("\n"),
        "evidence table is too small",
      );
      assert.equal(writeCount, 2);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });

  it("applies one bounded visual patch after a full structural replan before the terminal gate", async function () {
    const runtime = globalThis as any;
    const previousZotero = runtime.Zotero;
    const previousServices = runtime.Services;
    const previousIOUtils = runtime.IOUtils;
    const previousPathUtils = runtime.PathUtils;
    const target: Record<string, unknown> = {};
    const renderedTitles: string[] = [];
    const reviewStages: string[] = [];
    const plannerRequests: any[] = [];
    let writeCount = 0;
    runtime.Zotero = {
      locale: "zh-CN",
      DataDirectory: { dir: "/zotero-data" },
      getMainWindow: () => target,
    };
    runtime.Services = {
      scriptloader: {
        loadSubScript: () => {
          target[PRESENTATION_RENDERER_GLOBAL] = {
            renderPresentation: async () => new Uint8Array([0x50, 0x4b, 3, 4]),
            renderPresentationWithPreview: async (spec: any) => {
              renderedTitles.push(spec.slides[0].title);
              return {
                bytes: new Uint8Array([0x50, 0x4b, 3, renderedTitles.length]),
                previewSlides: [
                  "data:image/png;base64,AAAA",
                  "data:image/png;base64,BBBB",
                ],
              };
            },
          };
        },
      },
    };
    runtime.IOUtils = {
      makeDirectory: async () => undefined,
      write: async (path: string) => {
        if (path.endsWith(".pptx")) writeCount += 1;
      },
    };
    runtime.PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      filename: (path: string) => path.split("/").pop(),
    };
    let reviewRound = 0;
    try {
      resetPresentationRendererForTests();
      const result = await executePresentationCapability(
        {},
        async (request) => {
          reviewStages.push(request.stage);
          reviewRound += 1;
          if (reviewRound === 1) {
            return {
              verdict: "reject",
              summary: "The evidence region leaves too much empty canvas.",
            };
          }
          if (reviewRound === 2) {
            return {
              verdict: "revise",
              summary: "One bounded title and narrative repair is sufficient.",
              patches: [
                {
                  slideNumber: 2,
                  title: "最终修复",
                  dropFields: ["bullets"],
                },
              ],
            };
          }
          return {
            verdict: "pass",
            summary: "The repaired deck is presentation-ready.",
          };
        },
        async (request) => {
          plannerRequests.push(request);
          const repaired = Boolean(request.repair);
          return {
            title: repaired ? "重规划版本" : "初始版本",
            language: request.intent.language,
            slides: [
              {
                title: repaired ? "重规划" : "初始",
                bullets: ["需要在最终视觉门禁前删除的冗余叙述。"],
                metrics: [{ value: "24%", label: "相对提升" }],
              },
            ],
          } as any;
        },
        {
          metadata: { title: "Paper" },
          sections: [],
          fullText: "Evidence",
          pages: [],
          pageCount: 0,
        } as any,
      );

      assert.include(result, '"status":"completed"');
      assert.deepEqual(reviewStages, ["draft", "draft", "final"]);
      assert.deepEqual(renderedTitles, ["初始", "重规划", "最终修复"]);
      assert.lengthOf(plannerRequests, 2);
      assert.equal(writeCount, 3);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });
});
