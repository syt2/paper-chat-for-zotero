import { assert } from "chai";
import type { ResolvedPresentationFigure } from "../src/modules/presentation/PresentationSchema.ts";
import {
  planAblationScene,
  planGalleryScene,
  planProcessScene,
  planTableFigureEvidenceScene,
  planTableFigureInterpretationScene,
  shouldUseFullCanvasWideFigure,
  validateResolvedVisualContract,
  visualCanvasRatio,
} from "../src/modules/presentation/renderer/PresentationScenePlanner.ts";

function figure(
  pixelWidth: number,
  pixelHeight: number,
): ResolvedPresentationFigure {
  return {
    page: 1,
    mode: "figure",
    data: "data:image/png;base64,AA==",
    pixelWidth,
    pixelHeight,
    caption: "Figure 1: Evidence",
  };
}

describe("presentation scene planner", function () {
  it("uses the right rail for metrics above interpretation on chart-only results", function () {
    const scene = planAblationScene(false, true);

    assert.equal(scene.dominantBox.h, 4.78);
    assert.isDefined(scene.metricsBox);
    assert.isAbove(scene.metricsBox?.x || 0, scene.dominantBox.x);
    assert.equal(scene.metricsBox?.w, scene.narrativeBox.w);
    assert.isAtMost(
      (scene.metricsBox?.y || 0) + (scene.metricsBox?.h || 0),
      scene.narrativeBox.y,
    );
    assert.closeTo(
      scene.narrativeBox.y + scene.narrativeBox.h,
      scene.dominantBox.y + scene.dominantBox.h,
      0.001,
    );
  });

  it("uses the full canvas only for wide figures with sparse narrative", function () {
    const wideFigure = figure(1_320, 456);

    assert.isTrue(
      shouldUseFullCanvasWideFigure({
        title: "Wide evidence",
        figure: wideFigure,
        keyMessage: "One concise interpretation belongs in speaker notes.",
      }),
    );
    assert.isFalse(
      shouldUseFullCanvasWideFigure({
        title: "Wide evidence with a real narrative rail",
        figure: wideFigure,
        keyMessage: "The rail has enough evidence to earn its space.",
        bullets: [
          "The experiment condition is explicit.",
          "The interpretation boundary remains visible.",
        ],
      }),
    );
  });

  it("never lets a wide figure erase authored process or evidence modules", function () {
    const wideFigure = figure(1_400, 420);

    assert.isFalse(
      shouldUseFullCanvasWideFigure({
        layout: "process",
        title: "Architecture",
        figure: wideFigure,
        process: [
          { title: "Input" },
          { title: "Convolution" },
          { title: "Classifier" },
        ],
        callouts: [{ text: "Selective cross-GPU communication" }],
      }),
    );
    assert.isFalse(
      shouldUseFullCanvasWideFigure({
        layout: "evidence",
        title: "Results",
        figure: wideFigure,
        table: {
          headers: ["Model", "Error"],
          rows: [["CNN", "17.0%"]],
        },
      }),
    );
  });

  it("stacks a compact table above a full-width supporting figure", function () {
    const evidenceBox = { x: 4.18, y: 1.68, w: 8.48, h: 4.78 };
    const scene = planTableFigureEvidenceScene(evidenceBox, 2.54);

    assert.equal(scene.tableBox.w, evidenceBox.w);
    assert.equal(scene.figureBox.w, evidenceBox.w);
    assert.isAtLeast(scene.tableBox.h, 1.8);
    assert.isAtLeast(scene.figureBox.h, 2);
    assert.isBelow(scene.tableBox.y, scene.figureBox.y);
    assert.closeTo(
      scene.figureBox.y + scene.figureBox.h,
      evidenceBox.y + evidenceBox.h,
      0.001,
    );
  });

  it("builds a full-width academic table over interpretation and a large figure", function () {
    const contentBox = { x: 0.72, y: 1.68, w: 11.94, h: 4.78 };
    const scene = planTableFigureInterpretationScene(contentBox, 2.54);

    assert.equal(scene.tableBox.x, contentBox.x);
    assert.equal(scene.tableBox.w, contentBox.w);
    assert.isAtLeast(scene.tableBox.h, 1.68);
    assert.isBelow(scene.tableBox.y + scene.tableBox.h, scene.narrativeBox.y);
    assert.equal(scene.narrativeBox.y, scene.figureBox.y);
    assert.isBelow(
      scene.narrativeBox.x + scene.narrativeBox.w,
      scene.figureBox.x,
    );
    assert.isAtLeast(scene.figureBox.h - 0.34, 2);
    assert.closeTo(
      scene.figureBox.x + scene.figureBox.w,
      contentBox.x + contentBox.w,
      0.001,
    );
    assert.closeTo(
      scene.figureBox.y + scene.figureBox.h,
      contentBox.y + contentBox.h,
      0.001,
    );
  });

  it("gives a two-figure gallery the main canvas instead of a narrative sidebar", function () {
    const figures = [figure(900, 520), figure(760, 500)];
    const scene = planGalleryScene(figures);

    assert.lengthOf(scene.figureBoxes, 2);
    assert.lengthOf(scene.insightBoxes, 2);
    assert.isAbove(
      scene.figureBoxes[0].w,
      scene.figureBoxes[1].w,
      "the first, narratively primary figure should own the larger stage",
    );
    assert.closeTo(
      scene.figureBoxes.reduce((total, box) => total + box.w, 0),
      11.74,
      0.01,
    );
    assert.isAtLeast(
      visualCanvasRatio({ title: "Gallery", figures }, "gallery"),
      0.46,
    );
  });

  it("fits two wide figures to their natural height instead of centering them in empty frames", function () {
    const figures = [figure(1_360, 420), figure(1_000, 390)];
    const scene = planGalleryScene(figures);

    assert.isBelow(scene.figureBoxes[0].h, 3);
    assert.isBelow(scene.figureBoxes[1].h, 3);
    assert.isAbove(
      scene.insightBoxes[0].y,
      Math.max(
        scene.figureBoxes[0].y + scene.figureBoxes[0].h,
        scene.figureBoxes[1].y + scene.figureBoxes[1].h,
      ),
    );
    assert.isAbove(scene.insightBoxes[0].h, 1.2);
  });

  it("rejects an unresolved two-ultra-wide gallery as too small for projection", function () {
    const figures = [figure(1_359, 463), figure(1_351, 456)];
    const scene = planGalleryScene(figures);
    const ratio = visualCanvasRatio(
      { title: "Wide gallery", figures },
      "gallery",
    );
    const errors = validateResolvedVisualContract(
      [{ title: "Wide gallery", figures }],
      ["gallery"],
    );

    assert.isBelow(ratio, 0.46);
    assert.match(errors.join("\n"), /too little visible canvas/);
  });

  it("keeps a wide process figure above one fifth of the content canvas", function () {
    const sourceFigure = figure(1_360, 420);
    const scene = planProcessScene(true, true, true);

    assert.isAbove(scene.figureBox?.w || 0, 8.5);
    assert.isAtLeast(
      visualCanvasRatio(
        {
          title: "Process",
          figure: sourceFigure,
          process: [{ title: "Input" }, { title: "Output" }],
          metrics: [{ value: "60M", label: "parameters" }],
          callouts: [{ text: "Architecture insight" }],
        },
        "process",
      ),
      0.2,
    );
  });

  it("separates narrow process metrics from the bottom callout", function () {
    const scene = planProcessScene(true, true, true, 1.55);
    const metricsBottom =
      (scene.metricsBox?.y || 0) + (scene.metricsBox?.h || 0);

    assert.isAtMost(metricsBottom, scene.calloutBox?.y || 0);
    assert.isAtMost(
      (scene.narrativeBox?.y || 0) + (scene.narrativeBox?.h || 0),
      scene.metricsBox?.y || 0,
    );
    assert.isAbove(scene.figureBox?.w || 0, 8.5);
  });

  it("keeps visible breathing room between process narrative and figure caption", function () {
    const scene = planProcessScene(true, true, false, 1.55);
    const narrativeRight =
      (scene.narrativeBox?.x || 0) + (scene.narrativeBox?.w || 0);

    assert.isAtLeast((scene.figureBox?.x || 0) - narrativeRight, 0.34);
    assert.isAtLeast(scene.narrativeBox?.w || 0, 2.3);
    assert.isAbove(scene.figureBox?.w || 0, 8.8);
  });

  it("keeps a medium-aspect process figure above one fifth with a callout", function () {
    const sourceFigure = figure(668, 456);

    assert.isAtLeast(
      visualCanvasRatio(
        {
          title: "Process",
          figure: sourceFigure,
          process: [{ title: "Input" }, { title: "Output" }],
          callouts: [{ text: "Architecture insight" }],
        },
        "process",
      ),
      0.2,
    );
  });

  it("gives an ultra-wide process figure the full lower canvas", function () {
    const sourceFigure = figure(1_359, 246);
    const scene = planProcessScene(
      true,
      false,
      true,
      sourceFigure.pixelWidth / sourceFigure.pixelHeight,
    );

    assert.isAbove(scene.figureBox?.w || 0, 11.5);
    assert.isAtLeast(scene.calloutBox?.h || 0, 0.68);
    assert.isAtMost(
      (scene.figureBox?.y || 0) + (scene.figureBox?.h || 0),
      scene.calloutBox?.y || 0,
    );
    assert.isAtLeast(
      visualCanvasRatio(
        {
          title: "Process",
          figure: sourceFigure,
          process: [{ title: "Input" }, { title: "Output" }],
          callouts: [{ text: "Architecture insight" }],
        },
        "process",
      ),
      0.2,
    );
  });

  it("keeps a wide ablation support visible while reserving room for metrics", function () {
    const sourceFigure = figure(1_400, 450);
    const scene = planAblationScene(true, true, 1_400 / 450);

    assert.isAbove(scene.dominantBox.h, 3.5);
    assert.isBelow(scene.metricsBox?.x || Number.MAX_SAFE_INTEGER, 1);
    assert.isAtLeast(scene.supportingFigureBox?.h || 0, 1.85);
    assert.isAbove(scene.supportingFigureBox?.x || 0, 8);
    assert.isAtLeast(
      visualCanvasRatio(
        {
          title: "Ablation",
          chart: { type: "bar", labels: ["A"], values: [1] },
          figure: sourceFigure,
          metrics: [{ value: "15.3%", label: "top-5 error" }],
        },
        "ablation",
      ),
      0.07,
    );
  });

  it("uses the ablation sidebar efficiently for a medium-aspect figure", function () {
    const sourceFigure = figure(668, 456);
    const scene = planAblationScene(true, true);

    assert.isAtLeast(scene.supportingFigureBox?.w || 0, 4.05);
    assert.isAtLeast(scene.supportingFigureBox?.h || 0, 2.6);
    assert.isAtLeast(
      visualCanvasRatio(
        {
          title: "Ablation",
          chart: { type: "bar", labels: ["A"], values: [1] },
          figure: sourceFigure,
          metrics: [{ value: "15.3%", label: "top-5 error" }],
        },
        "ablation",
      ),
      0.11,
    );
  });

  it("moves metrics under the dominant result and gives wide-figure callouts readable space", function () {
    const scene = planAblationScene(true, true, 2.55);

    assert.isAtLeast(scene.supportingFigureBox?.w || 0, 4.5);
    assert.isAtLeast(scene.supportingFigureBox?.h || 0, 2);
    assert.isAbove(scene.narrativeBox.h, 2.2);
    assert.isBelow(scene.metricsBox?.x || Number.MAX_SAFE_INTEGER, 1);
    assert.isBelow(scene.dominantBox.h, 4);
    assert.isAtMost(scene.dominantBox.w, 7.1);
  });

  it("uses an asymmetric 68/32 result split without collapsing the narrative", function () {
    const scene = planAblationScene(false, false);

    assert.isAtLeast(scene.narrativeBox.w, 3.4);
    assert.isAtLeast(scene.dominantBox.w / 11.94, 0.675);
    assert.isAtMost(scene.dominantBox.w, 8.2);
  });

  it("rejects paper decks whose resolved layouts shrink every real figure", function () {
    const errors = validateResolvedVisualContract(
      [
        {
          title: "Gallery",
          figures: [figure(9_000, 200), figure(8_000, 180)],
        },
      ],
      ["gallery"],
    );

    assert.isNotEmpty(errors);
    assert.match(errors.join("\n"), /too little visible canvas/);
  });

  it("does not misclassify an ablation support crop as an image-dominant composition", function () {
    const wideFigure = figure(1_400, 450);
    const errors = validateResolvedVisualContract(
      [
        { title: "Gallery", figures: [figure(900, 520), figure(760, 500)] },
        {
          title: "Ablation",
          chart: { type: "bar", labels: ["A"], values: [1] },
          figure: wideFigure,
        },
        {
          title: "Matrix",
          matrix: {
            columns: ["A", "B"],
            rows: [
              { label: "One", cells: ["1", "2"] },
              { label: "Two", cells: ["3", "4"] },
            ],
          },
          figure: wideFigure,
        },
        { title: "Conclusion", bullets: ["Supported"] },
      ],
      ["gallery", "ablation", "matrix", "conclusion"],
    );

    assert.match(errors.join("\n"), /at least two image-dominant/);
  });

  it("still requires a second image-dominant composition when other figure layouts stay secondary", function () {
    const wideFigure = figure(1_400, 450);
    const errors = validateResolvedVisualContract(
      [
        { title: "Gallery", figures: [figure(900, 520), figure(760, 500)] },
        { title: "Split", figure: wideFigure, bullets: ["Narrative"] },
        {
          title: "Matrix",
          matrix: {
            columns: ["A", "B"],
            rows: [{ label: "One", cells: ["1", "2"] }],
          },
          figure: wideFigure,
        },
        { title: "Conclusion", bullets: ["Supported"] },
      ],
      ["gallery", "split", "matrix", "conclusion"],
    );

    assert.match(errors.join("\n"), /at least two image-dominant/);
  });
});
