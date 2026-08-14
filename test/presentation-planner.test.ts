import { assert } from "chai";
import {
  buildPresentationPaperContext,
  buildPresentationPlannerSystemPrompt,
  buildPresentationPlannerUserPrompt,
  parsePresentationPlannerResponse,
} from "../src/modules/presentation/PresentationPlanner.ts";

describe("presentation planner", function () {
  const request = {
    intent: {
      sourceItemKey: "SBZ2M99R",
      language: "zh-CN" as const,
      designSystem: "teal-green-academic-defense" as const,
      slideCount: 6 as const,
    },
    paper: {
      metadata: {
        title:
          "ImageNet classification with deep convolutional neural networks",
        authors: ["Alex Krizhevsky", "Ilya Sutskever", "Geoffrey Hinton"],
        year: 2012,
      },
      sections: [],
      fullText: "Fig. 1. Architecture",
      pages: [
        {
          pageNumber: 1,
          startIndex: 0,
          endIndex: 40,
          content: "Fig. 1. An illustration of the architecture of our CNN.",
        },
        {
          pageNumber: 2,
          startIndex: 41,
          endIndex: 80,
          content: "Table 1. ILSVRC-2010 test set results.",
        },
      ],
      pageCount: 2,
      nativePageCount: 9,
      nativeOutline: [
        { title: "3 The Architecture", pageNumber: 3, children: [] },
      ],
    },
  };

  it("builds page-addressable paper evidence for the hidden planner", function () {
    const context = buildPresentationPaperContext(request);

    assert.include(context, "Source item key: SBZ2M99R");
    assert.include(context, "PDF.js pages: 9");
    assert.include(context, "3 The Architecture (PDF page 3)");
    assert.include(context, "[EXTRACTED PAGE 1]");
    assert.include(context, "Fig. 1. An illustration");
    assert.include(context, "Table 1. ILSVRC-2010 test set results");
  });

  it("keeps visual quality and evidence rules inside the planner", function () {
    const prompt = buildPresentationPlannerSystemPrompt();

    assert.include(
      prompt,
      "count-specific narrative, evidence, and composition contract in the user message",
    );
    assert.include(
      prompt,
      "Allocate every content-slide evidence figure before choosing the cover hero",
    );
    assert.include(
      prompt,
      "scientific evidence on a content slide always has priority",
    );
    assert.include(prompt, "Never reuse the same Figure/Table");
    assert.include(prompt, "Reserve architecture or pipeline figures");
    assert.include(
      prompt,
      "The cover must never consume the only qualitative figure",
    );
    assert.include(prompt, "prefer a gallery or figure-led composition");
    assert.include(prompt, "not displace stronger paper visuals");
    assert.include(prompt, "Any chart-like paper figure");
    assert.include(prompt, "must use the dedicated figure layout");
    assert.include(prompt, "never end it with an ellipsis");
    assert.include(
      prompt,
      "Tiny or clipped axis labels are a release-blocking defect",
    );
    assert.include(prompt, "first content slide must make the research gap");
    assert.include(prompt, "exactly three distinct evidence-backed findings");
    assert.include(prompt, "do not count as findings");
    assert.include(prompt, "Never switch one slide into another language");
    assert.include(prompt, "Zotero's current interface locale");
    assert.include(prompt, "supported by the evidence visibly rendered");
    assert.include(prompt, "Avoid card grids");
    assert.include(prompt, "60-75% of the usable canvas");
    assert.include(prompt, "premium academic information design");
    assert.include(
      prompt,
      "fail the quality contract instead of exporting a sparse cover",
    );
    assert.include(prompt, "not a poster");
    assert.include(prompt, "figure uses one dominant non-table PDF figure");
    assert.include(prompt, "single sentence floating in empty space");
    assert.include(
      prompt,
      "provide exactly two or three paper-grounded coverMetrics",
    );
    assert.include(prompt, "Default to teal-green-academic-defense");
    assert.include(
      prompt,
      "Use dark-editorial only when the user explicitly asks",
    );
    assert.include(
      prompt,
      "rank real-world samples, predictions, retrievals, and error-case panels above learned filters",
    );
    assert.include(prompt, "Return one JSON object only");
  });

  it("turns preset and custom lengths into exact planner contracts", function () {
    for (const [slideCount, contentSlideCount] of [
      [4, 3],
      [6, 5],
      [8, 7],
      [10, 9],
      [15, 14],
      [30, 29],
    ] as const) {
      const systemPrompt = buildPresentationPlannerSystemPrompt();
      const userPrompt = buildPresentationPlannerUserPrompt({
        ...request,
        intent: { ...request.intent, slideCount },
      });

      assert.notInclude(
        systemPrompt,
        `${slideCount}-page research presentation`,
      );
      assert.include(userPrompt, `Selected total slide count: ${slideCount}`);
      assert.include(
        userPrompt,
        `Required content slide count: exactly ${contentSlideCount}`,
      );
      assert.include(
        userPrompt,
        `Create a premium, editable, evidence-first ${slideCount}-page research presentation`,
      );
      assert.include(
        userPrompt,
        `Set request-level slideCount to ${slideCount}`,
      );
    }
  });

  it("uses a coherent compact evidence arc for a four-page deck", function () {
    const prompt = buildPresentationPlannerUserPrompt({
      ...request,
      intent: { ...request.intent, slideCount: 4 },
    });

    assert.include(prompt, "three content slides");
    assert.include(prompt, "On content slide 2");
    assert.notInclude(prompt, "slides 3 through 2");
    assert.include(prompt, "Use at least 3 different composition silhouettes");
  });

  it("keeps the full evidence contract after the cache breakpoint", function () {
    const prompt = buildPresentationPlannerUserPrompt(request);

    assert.include(prompt, "at least three real PDF figure placements");
    assert.include(prompt, "content slides 3 through 4");
    assert.include(prompt, "structured experimental or ablation results");
    assert.include(prompt, "pair it with a distinct non-table PDF figure");
    assert.include(
      prompt,
      "Do not simplify a table-plus-figure result page into table-only",
    );
    assert.include(prompt, "Use at least 4 different composition silhouettes");
  });

  it("states the resolved Zotero interface language in the planner prompt", function () {
    const prompt = buildPresentationPlannerUserPrompt(request);

    assert.include(
      prompt,
      "Zotero display locale resolved for this presentation: zh-CN",
    );
    assert.include(prompt, "Required default PPT language: zh-CN");
    assert.include(prompt, "hard output-language requirement");
    assert.include(prompt, "follows Zotero's current display language");
    assert.include(prompt, "Never infer or switch the PPT language");
  });

  it("places one-time user requirements only in the dynamic planner prompt", function () {
    const instructions = "面向本科生，重点解释消融实验，少用公式。";
    const systemPrompt = buildPresentationPlannerSystemPrompt();
    const userPrompt = buildPresentationPlannerUserPrompt({
      ...request,
      intent: { ...request.intent, instructions },
    });

    assert.notInclude(systemPrompt, instructions);
    assert.include(
      userPrompt,
      "User-provided requirements for this generation",
    );
    assert.include(userPrompt, instructions);
    assert.equal(userPrompt.split(instructions).length - 1, 1);
    assert.include(userPrompt, "selected output language, slide count");
  });

  it("feeds contract failures back through one internal repair prompt", function () {
    const prompt = buildPresentationPlannerUserPrompt({
      ...request,
      repair: {
        issues: [
          "/slides: expected exactly five content slides",
          "/slides/2: dominant figure is missing",
        ],
        previousDraft: {
          title: "Incomplete deck",
          slides: [{ title: "Only one slide" }],
        },
      },
    });

    assert.include(prompt, "Repair the previous internal presentation draft");
    assert.include(prompt, "expected exactly five content slides");
    assert.include(prompt, '"title": "Incomplete deck"');
    assert.include(prompt, "Return a complete corrected JSON object");
    assert.include(prompt, "Preserve every already-valid real PDF figure");
    assert.include(
      prompt,
      "Never solve a composition problem by deleting valid evidence",
    );
  });

  it("parses fenced planner JSON without weakening the internal schema", function () {
    const parsed = parsePresentationPlannerResponse(`\n\`\`\`json\n{
      "title": "AlexNet changed large-scale vision",
      "sourceItemKey": "SBZ2M99R",
      "slides": [{"title": "Eight learned layers scale ImageNet"}]
    }\n\`\`\``);

    assert.equal(parsed.sourceItemKey, "SBZ2M99R");
    assert.equal(parsed.slides[0].title, "Eight learned layers scale ImageNet");
  });
});
