import type {
  RenderablePresentationSlide,
  ResolvedPresentationFigure,
} from "../PresentationSchema";
import type { ResolvedLayout } from "./PresentationDesignSystem";

export interface SceneBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GalleryScene {
  figureBoxes: SceneBox[];
  insightBoxes: SceneBox[];
}

export interface AblationScene {
  dominantBox: SceneBox;
  supportingFigureBox?: SceneBox;
  metricsBox?: SceneBox;
  narrativeBox: SceneBox;
}

export interface ProcessScene {
  nodeBand: SceneBox;
  narrativeBox?: SceneBox;
  figureBox?: SceneBox;
  metricsBox?: SceneBox;
  calloutBox?: SceneBox;
}

export interface TableFigureEvidenceScene {
  tableBox: SceneBox;
  figureBox: SceneBox;
}

export interface TableFigureInterpretationScene {
  tableBox: SceneBox;
  narrativeBox: SceneBox;
  figureBox: SceneBox;
}

const CONTENT: SceneBox = { x: 0.72, y: 1.68, w: 11.94, h: 4.78 };
const GAP = 0.2;
const FIGURE_CAPTION_HEIGHT = 0.34;

export function shouldUseFullCanvasWideFigure(
  slide: RenderablePresentationSlide,
): boolean {
  const primaryFigure = slide.figure || slide.figures?.[0];
  if (!primaryFigure) return false;
  // Full-canvas wide media is a figure-slide optimization, not a generic
  // escape hatch. Structured layouts own their composition and must retain
  // their authored process, comparison, result, or interpretation modules.
  // In particular, an ultra-wide architecture figure must not erase the
  // process nodes that explain how to read it.
  if (slide.layout && slide.layout !== "auto" && slide.layout !== "figure") {
    return false;
  }
  if (
    slide.process?.length ||
    slide.comparison ||
    slide.chart ||
    slide.table ||
    slide.equation ||
    slide.matrix ||
    slide.timeline?.length ||
    slide.groups?.length ||
    slide.callouts?.length ||
    slide.metrics?.length ||
    (slide.figures?.length || 0) > 1
  ) {
    return false;
  }
  const figureAspect =
    primaryFigure.pixelWidth / Math.max(1, primaryFigure.pixelHeight);
  const narrativeUnits =
    (slide.keyMessage ? 1 : 0) + (slide.bullets?.length || 0);
  const narrativeLength = Array.from(
    [slide.keyMessage, ...(slide.bullets || [])].filter(Boolean).join(" "),
  ).length;
  return figureAspect >= 2.2 && narrativeUnits <= 2 && narrativeLength <= 140;
}

/**
 * A compact academic result table and its qualitative source figure should
 * read as one evidence stage. Stacking them preserves a large table while a
 * full-width image band keeps the supporting figure legible from a distance;
 * a side-by-side split makes wide figures collapse into a thumbnail.
 */
export function planTableFigureEvidenceScene(
  evidenceBox: SceneBox,
  figureAspect: number,
): TableFigureEvidenceScene {
  const gap = 0.18;
  const naturalFigureHeight =
    evidenceBox.w / Math.max(0.5, figureAspect) + FIGURE_CAPTION_HEIGHT;
  const figureHeight = Math.min(
    evidenceBox.h * 0.56,
    Math.max(evidenceBox.h * 0.42, naturalFigureHeight),
  );
  const tableHeight = evidenceBox.h - figureHeight - gap;
  return {
    tableBox: { ...evidenceBox, h: tableHeight },
    figureBox: {
      x: evidenceBox.x,
      y: evidenceBox.y + tableHeight + gap,
      w: evidenceBox.w,
      h: figureHeight,
    },
  };
}

/**
 * Academic result slides with one quantitative table, one qualitative paper
 * figure, and a short interpretation should read top-to-bottom as a single
 * argument. The table owns the full upper stage; the lower band pairs concise
 * interpretation with a projection-sized source figure. Keeping the table in
 * a right rail leaves an empty upper-left quadrant and makes three related
 * evidence layers feel like unrelated template slots.
 */
export function planTableFigureInterpretationScene(
  contentBox: SceneBox,
  figureAspect: number,
): TableFigureInterpretationScene {
  const verticalGap = 0.18;
  const horizontalGap = 0.28;
  const tableHeight = Math.min(2.2, Math.max(1.84, contentBox.h * 0.43));
  const lowerY = contentBox.y + tableHeight + verticalGap;
  const lowerHeight = contentBox.y + contentBox.h - lowerY;
  // The interpretation rail must fit one natural academic claim without
  // collapsing its closing punctuation into an orphan line. The supporting
  // figure remains projection-sized because wide paper figures need less
  // height than width to stay legible.
  const narrativeWidth = Math.min(4.18, contentBox.w * 0.35);
  const figureX = contentBox.x + narrativeWidth + horizontalGap;
  const figureWidth = contentBox.x + contentBox.w - figureX;

  // A very wide crop needs the complete lower height to stay above two inches
  // after its caption is reserved. Narrower figures retain the same scene so
  // the quantitative-to-qualitative reading order remains stable.
  const naturalFigureHeight =
    figureWidth / Math.max(0.5, figureAspect) + FIGURE_CAPTION_HEIGHT;
  const figureHeight = Math.min(
    lowerHeight,
    Math.max(Math.min(lowerHeight, 2.42), naturalFigureHeight),
  );

  return {
    tableBox: { ...contentBox, h: tableHeight },
    narrativeBox: {
      x: contentBox.x,
      y: lowerY,
      w: narrativeWidth,
      h: lowerHeight,
    },
    figureBox: {
      x: figureX,
      y: lowerY + lowerHeight - figureHeight,
      w: figureWidth,
      h: figureHeight,
    },
  };
}

function area(box: SceneBox): number {
  return Math.max(0, box.w) * Math.max(0, box.h);
}

export function fittedFigureArea(
  figure: ResolvedPresentationFigure,
  box: SceneBox,
  captionHeight = 0.34,
): number {
  const availableHeight = Math.max(0.1, box.h - captionHeight);
  const figureAspect = figure.pixelWidth / Math.max(1, figure.pixelHeight);
  const boxAspect = box.w / availableHeight;
  if (figureAspect > boxAspect) {
    return box.w * (box.w / figureAspect);
  }
  return availableHeight * figureAspect * availableHeight;
}

export function planGalleryScene(
  figures: readonly ResolvedPresentationFigure[],
): GalleryScene {
  const selected = figures.slice(0, 4);
  const visualHeight = selected.length <= 2 ? 4.08 : 3.82;
  const visualRegion: SceneBox = {
    x: CONTENT.x,
    y: CONTENT.y,
    w: CONTENT.w,
    h: visualHeight,
  };
  let figureBoxes: SceneBox[];
  if (selected.length === 2) {
    // The planner orders gallery evidence by narrative importance. Preserve
    // that hierarchy instead of letting raw aspect ratios decide which image
    // dominates: the first paper figure gets a Swiss-poster 7:5 stage and the
    // second acts as supporting evidence.
    const firstShare = 0.58;
    const firstWidth = (visualRegion.w - GAP) * firstShare;
    figureBoxes = [
      {
        x: visualRegion.x,
        y: visualRegion.y,
        w: firstWidth,
        h: visualRegion.h,
      },
      {
        x: visualRegion.x + firstWidth + GAP,
        y: visualRegion.y,
        w: visualRegion.w - firstWidth - GAP,
        h: visualRegion.h,
      },
    ];
    // A fixed-height two-column grid leaves very wide research figures floating
    // in the middle of a large empty rectangle. Size each evidence frame to the
    // actual media aspect ratio instead, then let the interpretation band begin
    // immediately below the taller figure. This mirrors the reference deck's
    // image-first composition while preserving editable captions.
    figureBoxes = figureBoxes.map((box, index) => {
      const figure = selected[index];
      const aspect = figure.pixelWidth / Math.max(1, figure.pixelHeight);
      return {
        ...box,
        h: Math.min(
          visualRegion.h,
          Math.max(
            1.42,
            box.w / Math.max(0.25, aspect) + FIGURE_CAPTION_HEIGHT,
          ),
        ),
      };
    });
  } else if (selected.length === 3) {
    const mainWidth = visualRegion.w * 0.56;
    const secondaryWidth = visualRegion.w - mainWidth - GAP;
    const secondaryHeight = (visualRegion.h - GAP) / 2;
    figureBoxes = [
      {
        x: visualRegion.x,
        y: visualRegion.y,
        w: mainWidth,
        h: visualRegion.h,
      },
      {
        x: visualRegion.x + mainWidth + GAP,
        y: visualRegion.y,
        w: secondaryWidth,
        h: secondaryHeight,
      },
      {
        x: visualRegion.x + mainWidth + GAP,
        y: visualRegion.y + secondaryHeight + GAP,
        w: secondaryWidth,
        h: secondaryHeight,
      },
    ];
  } else {
    const columns = selected.length <= 2 ? selected.length : 2;
    const rows = Math.ceil(selected.length / Math.max(1, columns));
    const width =
      (visualRegion.w - GAP * Math.max(0, columns - 1)) / Math.max(1, columns);
    const height =
      (visualRegion.h - GAP * Math.max(0, rows - 1)) / Math.max(1, rows);
    figureBoxes = selected.map((_, index) => ({
      x: visualRegion.x + (index % columns) * (width + GAP),
      y: visualRegion.y + Math.floor(index / columns) * (height + GAP),
      w: width,
      h: height,
    }));
  }

  const visualBottom = figureBoxes.reduce(
    (bottom, box) => Math.max(bottom, box.y + box.h),
    CONTENT.y,
  );
  const insightY = Math.min(CONTENT.y + CONTENT.h - 0.58, visualBottom + 0.16);
  const insightHeight = CONTENT.y + CONTENT.h - insightY;
  const insightColumns = Math.min(3, Math.max(1, selected.length));
  const insightWidth =
    (CONTENT.w - GAP * Math.max(0, insightColumns - 1)) / insightColumns;
  const insightBoxes = Array.from({ length: insightColumns }, (_, index) => ({
    x: CONTENT.x + index * (insightWidth + GAP),
    y: insightY,
    w: insightWidth,
    h: insightHeight,
  }));
  return { figureBoxes, insightBoxes };
}

export function planAblationScene(
  hasSupportingFigure: boolean,
  hasMetrics: boolean,
  supportingFigureAspect = 1.6,
): AblationScene {
  // Ultra-wide paper figures become illegible in the default narrow sidebar.
  // Give them a real evidence column and let the editable result remain the
  // visual anchor on the left. This yields one coherent two-column results
  // composition instead of chart + prose + thumbnail competing in three rails.
  const usesWideEvidenceColumn =
    hasSupportingFigure && supportingFigureAspect >= 2.2;
  const evidenceWidth = usesWideEvidenceColumn
    ? 7.08
    : hasSupportingFigure
      ? 7.56
      : 8.1;
  const narrativeX = CONTENT.x + evidenceWidth + 0.28;
  const sideWidth = CONTENT.x + CONTENT.w - narrativeX;
  if (!hasSupportingFigure) {
    const metricsHeight = hasMetrics ? 1.28 : 0;
    const narrativeY = CONTENT.y + metricsHeight + (hasMetrics ? 0.22 : 0);
    return {
      dominantBox: {
        x: CONTENT.x,
        y: CONTENT.y,
        w: evidenceWidth,
        h: CONTENT.h,
      },
      metricsBox: hasMetrics
        ? {
            x: narrativeX,
            y: CONTENT.y,
            w: sideWidth,
            h: metricsHeight,
          }
        : undefined,
      narrativeBox: {
        x: narrativeX,
        y: narrativeY,
        w: sideWidth,
        h: CONTENT.y + CONTENT.h - narrativeY,
      },
    };
  }

  // Keep the editable result dominant. A medium-aspect source figure can use a
  // compact evidence sidebar; a wide figure receives a broader column so its
  // labels and image structure survive presentation-distance viewing.
  const supportingHeight = Math.min(
    usesWideEvidenceColumn ? 2.2 : 2.62,
    Math.max(
      usesWideEvidenceColumn ? 1.86 : 1.82,
      sideWidth / Math.max(0.4, supportingFigureAspect) + FIGURE_CAPTION_HEIGHT,
    ),
  );
  const supportingY = CONTENT.y;
  const sidebarContentY = supportingY + supportingHeight + 0.18;
  return {
    dominantBox: {
      x: CONTENT.x,
      y: CONTENT.y,
      w: evidenceWidth,
      h: hasMetrics ? 3.98 : CONTENT.h,
    },
    supportingFigureBox: {
      x: narrativeX,
      y: supportingY,
      w: sideWidth,
      h: supportingHeight,
    },
    metricsBox: hasMetrics
      ? {
          x: CONTENT.x,
          y: CONTENT.y + 4.12,
          w: evidenceWidth,
          h: 0.66,
        }
      : undefined,
    narrativeBox: {
      x: narrativeX,
      y: sidebarContentY,
      w: sideWidth,
      h: CONTENT.y + CONTENT.h - sidebarContentY,
    },
  };
}

export function planProcessScene(
  hasFigure: boolean,
  hasMetrics: boolean,
  hasCallout: boolean,
  figureAspect = 1.6,
): ProcessScene {
  const nodeBand: SceneBox = {
    x: 0.82,
    y: 1.56,
    w: 11.68,
    h: 0.96,
  };
  if (!hasFigure) return { nodeBand };

  if (figureAspect >= 2.2) {
    const hasBottomBand = hasMetrics || hasCallout;
    const metricsWidth = hasMetrics && hasCallout ? 3.5 : 11.68;
    return {
      nodeBand,
      figureBox: {
        x: 0.82,
        y: 2.64,
        w: 11.68,
        h: hasBottomBand ? 3.04 : 3.84,
      },
      metricsBox: hasMetrics
        ? { x: 0.82, y: 5.86, w: metricsWidth, h: 0.72 }
        : undefined,
      calloutBox: hasCallout
        ? {
            x: hasMetrics ? 4.62 : 0.82,
            y: 5.86,
            w: hasMetrics ? 7.88 : 11.68,
            h: 0.72,
          }
        : undefined,
    };
  }

  if (!hasMetrics) {
    return {
      nodeBand,
      figureBox: { x: 3.42, y: 2.6, w: 9.08, h: 3.9 },
      calloutBox: hasCallout
        ? { x: 0.82, y: 5.62, w: 2.24, h: 0.86 }
        : undefined,
    };
  }

  const narrativeBox: SceneBox = {
    x: 0.82,
    y: 2.68,
    w: hasCallout ? 2.68 : 2.36,
    h: hasCallout ? 1.34 : 2.18,
  };
  const figureBox: SceneBox = {
    x: hasCallout ? 3.84 : 3.54,
    y: 2.6,
    w: hasCallout ? 8.66 : 8.96,
    h: 3.9,
  };
  return {
    nodeBand,
    narrativeBox,
    figureBox,
    metricsBox: hasMetrics
      ? hasCallout
        ? { x: 0.82, y: 4.2, w: 2.68, h: 1.18 }
        : { x: 0.82, y: 5.08, w: 2.36, h: 1.38 }
      : undefined,
    calloutBox: hasCallout
      ? {
          x: 0.82,
          y: 5.58,
          w: 2.68,
          h: 0.9,
        }
      : undefined,
  };
}

export function visualCanvasRatio(
  slide: RenderablePresentationSlide,
  layout: ResolvedLayout,
): number {
  const figures = [
    ...(slide.figure ? [slide.figure] : []),
    ...(slide.figures || []),
  ];
  const contentArea = area(CONTENT);
  if (!figures.length || contentArea <= 0) return 0;

  if (layout === "gallery") {
    const plan = planGalleryScene(figures);
    return (
      plan.figureBoxes.reduce(
        (total, box, index) => total + fittedFigureArea(figures[index], box),
        0,
      ) / contentArea
    );
  }
  if (layout === "ablation") {
    const plan = planAblationScene(
      Boolean(slide.chart || slide.table) && figures.length > 0,
      Boolean(slide.metrics?.length),
      figures[0]
        ? figures[0].pixelWidth / Math.max(1, figures[0].pixelHeight)
        : undefined,
    );
    const box = plan.supportingFigureBox || plan.dominantBox;
    return fittedFigureArea(figures[0], box) / contentArea;
  }
  if (layout === "process") {
    const plan = planProcessScene(
      true,
      Boolean(slide.metrics?.length),
      Boolean(slide.callouts?.length),
      figures[0].pixelWidth / Math.max(1, figures[0].pixelHeight),
    );
    return plan.figureBox
      ? fittedFigureArea(figures[0], plan.figureBox) / contentArea
      : 0;
  }
  if (layout === "figure") {
    const hasNarrative = Boolean(slide.keyMessage || slide.bullets?.length);
    const box: SceneBox = hasNarrative
      ? { x: 0.72, y: 1.62, w: 8.55, h: 4.9 }
      : { x: 0.72, y: 1.62, w: 11.95, h: 4.9 };
    return fittedFigureArea(figures[0], box) / contentArea;
  }
  return 0;
}

export function validateResolvedVisualContract(
  slides: readonly RenderablePresentationSlide[],
  layouts: readonly ResolvedLayout[],
): string[] {
  const errors: string[] = [];
  let dominantFigureSlides = 0;
  slides.forEach((slide, index) => {
    const layout = layouts[index];
    const ratio = visualCanvasRatio(slide, layout);
    const slideFigures = [
      ...(slide.figure ? [slide.figure] : []),
      ...(slide.figures || []),
    ];
    if (layout === "gallery") {
      const minimum = 0.46;
      if (ratio < minimum) {
        errors.push(
          "gallery slide " +
            (index + 2) +
            " gives real PDF figures too little visible canvas (" +
            Math.round(ratio * 100) +
            "%; minimum " +
            Math.round(minimum * 100) +
            "%; " +
            slideFigures
              .map(
                (figure) =>
                  `${figure.pixelWidth}×${figure.pixelHeight} px, ${figure.cropTrace || "crop trace unavailable"}`,
              )
              .join(" | ") +
            ").",
        );
      }
      if (ratio >= minimum) dominantFigureSlides += 1;
    }
    if (layout === "process" && slide.figure) {
      if (ratio < 0.2) {
        errors.push(
          "process slide " +
            (index + 2) +
            " reduces its source figure below 20% of the content canvas (" +
            Math.round(ratio * 100) +
            "%, " +
            slide.figure.pixelWidth +
            "×" +
            slide.figure.pixelHeight +
            " px; " +
            (slide.figure.cropTrace || "crop trace unavailable") +
            ").",
        );
      } else {
        dominantFigureSlides += 1;
      }
    }
    if (layout === "ablation" && slide.figure) {
      if (ratio < 0.07) {
        errors.push(
          "ablation slide " +
            (index + 2) +
            " reduces its supporting paper figure below 7% of the content canvas (" +
            Math.round(ratio * 100) +
            "%, " +
            slide.figure.pixelWidth +
            "×" +
            slide.figure.pixelHeight +
            " px; " +
            (slide.figure.cropTrace || "crop trace unavailable") +
            ").",
        );
      }
    }
    if (layout === "figure") {
      if (ratio < 0.34) {
        errors.push(
          "figure slide " +
            (index + 2) +
            " gives its primary PDF figure too little visible canvas (" +
            Math.round(ratio * 100) +
            "%; minimum 34%).",
        );
      } else {
        dominantFigureSlides += 1;
      }
    }
  });
  if (
    slides.some((slide) => slide.figures?.length || slide.figure) &&
    dominantFigureSlides === 0 &&
    slides.length >= 4
  ) {
    errors.push(
      "no content slide gives real PDF figures a dominant evidence-first canvas.",
    );
  }
  const figureSlideCount = slides.filter(
    (slide) => slide.figure || slide.figures?.length,
  ).length;
  if (slides.length >= 4 && figureSlideCount >= 3 && dominantFigureSlides < 2) {
    errors.push(
      "paper decks with three or more figure-bearing slides require at least two image-dominant compositions.",
    );
  }
  return errors;
}
