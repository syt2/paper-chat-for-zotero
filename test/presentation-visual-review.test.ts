import { assert } from "chai";
import {
  applyPresentationVisualReviewPatches,
  buildPresentationVisualReviewOutline,
  parsePresentationVisualReviewResponse,
} from "../src/modules/presentation/PresentationVisualReview.ts";
import {
  executePresentationCapability,
  resetPresentationRendererForTests,
} from "../src/modules/presentation/index.ts";
import { PRESENTATION_RENDERER_GLOBAL } from "../src/modules/presentation/contracts.ts";
import { validatePresentationQuality } from "../src/modules/presentation/PresentationQualityGate.ts";

describe("presentation visual review", function () {
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
    const writes: Uint8Array[] = [];
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
      write: async (_path: string, bytes: Uint8Array) => writes.push(bytes),
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
      );

      assert.equal(reviewRound, 2);
      assert.equal(renderCount, 2);
      assert.deepEqual(renderedTitles, [
        "The original claim",
        "The evidence is decisive",
      ]);
      assert.lengthOf(writes, 1);
      assert.equal(writes[0][3], 2);
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

  it("does not write a deck when visual review rejects and no full replan is available", async function () {
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
      write: async () => {
        writeCount += 1;
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
      );

      assert.match(result, /^Error: Presentation generation failed/);
      assert.include(
        result,
        "no full structural replan was available: Final visual review did not approve the deck: The evidence is still too small.",
      );
      assert.equal(writeCount, 0);

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
      );

      assert.match(
        draftRejectedResult,
        /^Error: Presentation generation failed/,
      );
      assert.include(
        draftRejectedResult,
        "no full structural replan was available: Draft visual review rejected the deck: The composition is too repetitive.",
      );
      assert.equal(writeCount, 0);
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
      write: async () => {
        writeCount += 1;
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
      write: async () => {
        writeCount += 1;
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
      write: async () => {
        writeCount += 1;
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

  it("still blocks a production export for a render-safety visual failure", async function () {
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
      write: async () => {
        writeCount += 1;
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

      assert.match(result, /^Error: Presentation generation failed/);
      assert.include(result, "catastrophically cropped");
      assert.equal(writeCount, 0);
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
      write: async () => {
        writeCount += 1;
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

  it("does not write a deck when required visual review cannot complete", async function () {
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
      write: async () => {
        writeCount += 1;
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
      );

      assert.match(result, /^Error: Presentation generation failed/);
      assert.include(
        result,
        "Presentation visual quality review failed before export",
      );
      assert.include(result, "review transport unavailable");
      assert.equal(writeCount, 0);
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
      write: async () => {
        writeCount += 1;
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
      assert.equal(writeCount, 1);
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
      write: async () => {
        writeCount += 1;
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
      assert.equal(writeCount, 0);
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
      write: async () => {
        writeCount += 1;
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
      assert.equal(writeCount, 1);
    } finally {
      resetPresentationRendererForTests();
      runtime.Zotero = previousZotero;
      runtime.Services = previousServices;
      runtime.IOUtils = previousIOUtils;
      runtime.PathUtils = previousPathUtils;
    }
  });
});
