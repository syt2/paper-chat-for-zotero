import { assert } from "chai";
import type { RenderablePresentationRequest } from "../src/modules/presentation/PresentationSchema.ts";
import { selectPresentationCoverHero } from "../src/modules/presentation/renderer/PresentationCoverPlanner.ts";

const DATA =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function figure(page: number, captionHint: string, width = 900, height = 600) {
  return {
    page,
    mode: "figure" as const,
    data: DATA,
    pixelWidth: width,
    pixelHeight: height,
    captionHint,
  };
}

describe("presentation cover planner", function () {
  it("prefers qualitative evidence over a training curve for the cover hero", function () {
    const curve = figure(
      3,
      "Figure 1: Training error curves for ReLU and tanh networks",
    );
    const predictions = figure(
      8,
      "Figure 4: Test images, predictions, and nearest-neighbor retrievals",
      1_180,
      660,
    );
    const hero = selectPresentationCoverHero({
      title: "AlexNet",
      sourceItemKey: "PAPER",
      coverFigure: curve,
      coverFigures: [curve, predictions],
      slides: [],
    } as RenderablePresentationRequest);

    assert.equal(hero, predictions);
  });

  it("keeps the explicit hero when there is no semantically stronger candidate", function () {
    const explicit = figure(6, "Figure 3: Learned convolutional filters");
    const architecture = figure(
      5,
      "Figure 2: Architecture of the convolutional neural network",
    );
    const hero = selectPresentationCoverHero({
      title: "AlexNet",
      sourceItemKey: "PAPER",
      coverFigure: explicit,
      coverFigures: [explicit, architecture],
      slides: [],
    } as RenderablePresentationRequest);

    assert.equal(hero, explicit);
  });

  it("prefers a rich prediction panel over an explicitly nominated filter grid", function () {
    const filters = figure(
      6,
      "Figure 3: learned first-layer convolutional filters",
      966,
      380,
    );
    const predictions = figure(
      8,
      "Figure 4: test images, predictions, and nearest-neighbor retrievals",
      1_180,
      660,
    );
    const hero = selectPresentationCoverHero({
      title: "AlexNet",
      sourceItemKey: "PAPER",
      coverFigure: filters,
      coverFigures: [filters, predictions],
      slides: [],
    } as RenderablePresentationRequest);

    assert.equal(hero, predictions);
  });
});
