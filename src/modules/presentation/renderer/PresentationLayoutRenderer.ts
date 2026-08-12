import PptxGenJS from "pptxgenjs";
import type {
  RenderablePresentationRequest,
  RenderablePresentationSlide,
  ResolvedPresentationFigure,
} from "../PresentationSchema";
import {
  BODY_FONT,
  chartColorsForSlide,
  coverTitleFontSize,
  MONO_FONT,
  resolveLayout,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  TITLE_FONT,
  titleFontSize,
  type ThemePalette,
} from "./PresentationDesignSystem";
import { resolvePresentationTableLayout } from "./PresentationTableLayout";
import type { PresentationThemeBlueprint } from "./PresentationThemeBlueprint";
import {
  planPresentationCoverFigures,
  selectPresentationCoverHero,
} from "./PresentationCoverPlanner";
import {
  planProcessScene,
  shouldUseFullCanvasWideFigure,
} from "./PresentationScenePlanner";
import {
  estimateTextBoxHeight,
  layoutProcessStepText,
  layoutFigureCaption,
  protectPresentationInlineTokens,
  protectPresentationQuantities,
  protectPresentationVisibleText,
  resolveChartTextLayout,
  wrapMixedScriptTitle,
} from "./PresentationTextLayout";
import {
  renderAblationLayout,
  renderConclusionLayout,
  renderEvidenceLayout,
  renderGalleryLayout,
  renderMatrixLayout,
  renderTimelineLayout,
} from "./PresentationAdvancedLayouts";
import {
  resolvePresentationRendererLabels,
  type PresentationRendererLabels,
} from "./PresentationLocalization";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function visibleText(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'");
}

interface RenderContext {
  presentation: PptxGenJS;
  palette: ThemePalette;
  blueprint: PresentationThemeBlueprint;
  sections: string[];
  slideCount: number;
  labels: PresentationRendererLabels;
}

const CONTENT_LEFT = 0.62;
const BODY_TOP = 1.58;
const BODY_BOTTOM = 6.72;

function addText(
  slide: PptxGenJS.Slide,
  text: string,
  box: Box,
  options: PptxGenJS.TextPropsOptions,
): void {
  slide.addText(protectPresentationVisibleText(visibleText(text)), {
    ...box,
    fontFace: BODY_FONT,
    margin: 0,
    breakLine: false,
    fit: "shrink",
    ...options,
  });
}

function addRule(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  x: number,
  y: number,
  w: number,
  color: string,
  width = 1,
): void {
  slide.addShape(context.presentation.ShapeType.line, {
    x,
    y,
    w,
    h: 0,
    line: { color, width },
  });
}

function slideSources(
  spec: RenderablePresentationRequest,
  slide: RenderablePresentationSlide,
): string[] {
  const sources: string[] = [];
  if (slide.source) sources.push(slide.source);
  if (slide.figure) {
    sources.push(
      `Zotero item ${slide.figure.itemKey || spec.sourceItemKey || "unknown"}, PDF page ${slide.figure.page}${slide.figure.caption ? `, ${slide.figure.caption}` : ""}`,
    );
  }
  for (const figure of slide.figures || []) {
    sources.push(
      `Zotero item ${figure.itemKey || spec.sourceItemKey || "unknown"}, PDF page ${figure.page}${figure.caption ? `, ${figure.caption}` : ""}`,
    );
  }
  return Array.from(new Set(sources));
}

function addNotes(
  spec: RenderablePresentationRequest,
  slide: PptxGenJS.Slide,
  slideSpec: RenderablePresentationSlide,
): void {
  const parts: string[] = [];
  if (slideSpec.notes?.trim()) parts.push(slideSpec.notes.trim());
  if (shouldUseFullCanvasWideFigure(slideSpec)) {
    const figureInterpretation = [
      slideSpec.keyMessage,
      ...(slideSpec.bullets || []).map((bullet) => `- ${bullet}`),
    ]
      .filter(Boolean)
      .join("\n");
    if (
      figureInterpretation &&
      !parts.some((part) => part.includes(figureInterpretation))
    ) {
      parts.push(figureInterpretation);
    }
  }
  const sources = slideSources(spec, slideSpec);
  if (sources.length) {
    parts.push(
      `[Sources]\n${sources.map((source) => `- ${source}`).join("\n")}`,
    );
  }
  slide.addNotes(parts.join("\n\n"));
}

function addFooter(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  slideSpec: RenderablePresentationSlide,
  pageNumber: number,
): void {
  const { palette, sections } = context;
  if (context.blueprint.id === "dark-editorial") {
    addRule(
      context,
      slide,
      context.blueprint.content.left,
      context.blueprint.content.footerRuleY,
      context.blueprint.content.right - context.blueprint.content.left,
      palette.border,
      0.45,
    );
    addText(
      slide,
      context.labels.researchBrief.toLocaleUpperCase(),
      { x: 0.72, y: 7.13, w: 3.5, h: 0.16 },
      {
        fontFace: MONO_FONT,
        fontSize: 7,
        bold: true,
        color: palette.faint,
        charSpacing: 1.5,
      },
    );
    addText(
      slide,
      `${String(pageNumber).padStart(2, "0")} / ${String(context.slideCount).padStart(2, "0")}`,
      { x: 11.45, y: 7.1, w: 1.18, h: 0.2 },
      {
        fontFace: MONO_FONT,
        fontSize: 8,
        bold: true,
        color: palette.muted,
        align: "right",
      },
    );
    return;
  }
  addRule(
    context,
    slide,
    context.blueprint.content.left,
    context.blueprint.content.footerRuleY,
    context.blueprint.content.right - context.blueprint.content.left,
    palette.border,
    0.7,
  );

  const currentSection =
    slideSpec.section ||
    defaultSectionForSlide(slideSpec, context.labels) ||
    sections[0] ||
    context.labels.researchBrief;
  addText(
    slide,
    currentSection.toLocaleUpperCase(),
    { x: CONTENT_LEFT, y: 7.11, w: 3.4, h: 0.16 },
    {
      fontFace: MONO_FONT,
      fontSize: 7.5,
      bold: true,
      color: palette.muted,
      charSpacing: 1.3,
    },
  );

  const navSections = sections.slice(0, 6);
  const dotGap = 0.16;
  const navWidth = Math.max(0, (navSections.length - 1) * dotGap);
  const navLeft = 11.08 - navWidth;
  for (const [index, section] of navSections.entries()) {
    const active = section === currentSection;
    const navX = navLeft + index * dotGap;
    const dotSize = active ? 0.09 : 0.055;
    slide.addShape(context.presentation.ShapeType.ellipse, {
      x: navX - dotSize / 2,
      y: 7.18 - dotSize / 2,
      w: dotSize,
      h: dotSize,
      line: {
        color: active ? palette.accent : palette.faint,
        transparency: 100,
      },
      fill: { color: active ? palette.accent : palette.faint },
    });
  }

  addText(
    slide,
    `${String(pageNumber).padStart(2, "0")} / ${String(context.slideCount).padStart(2, "0")}`,
    { x: 11.6, y: 7.08, w: 1.12, h: 0.22 },
    {
      fontFace: MONO_FONT,
      fontSize: 8,
      color: palette.muted,
      align: "right",
    },
  );
}

function addSlideHeading(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  const { palette } = context;
  const editorial = context.blueprint.id === "dark-editorial";
  const eyebrow = editorial
    ? spec.eyebrow?.trim() || spec.section?.trim()
    : spec.eyebrow?.trim();
  const hasEyebrow = Boolean(eyebrow);
  if (hasEyebrow) {
    addText(
      slide,
      eyebrow!,
      {
        x: editorial ? 0.72 : CONTENT_LEFT,
        y: editorial ? 0.24 : 0.22,
        w: 11.9,
        h: 0.2,
      },
      {
        fontFace: MONO_FONT,
        fontSize: editorial ? 8.2 : 9,
        bold: true,
        color: palette.accent,
        charSpacing: editorial ? 1.25 : 0.7,
        breakLine: false,
      },
    );
  }
  const editorialTitleSize = (() => {
    const length = Array.from(spec.title).length;
    if (length <= 24) return 35;
    if (length <= 38) return 32.5;
    if (length <= 55) return 29.5;
    return 27;
  })();
  addText(
    slide,
    spec.title,
    {
      x: editorial ? 0.72 : CONTENT_LEFT,
      y: editorial ? (hasEyebrow ? 0.54 : 0.38) : hasEyebrow ? 0.48 : 0.38,
      w: editorial ? 11.92 : 12.05,
      h: editorial ? 0.68 : hasEyebrow ? 0.56 : 0.66,
    },
    {
      fontFace: TITLE_FONT,
      fontSize: editorial ? editorialTitleSize : titleFontSize(spec.title),
      bold: editorial,
      color: palette.text,
      breakLine: false,
    },
  );
  if (spec.subtitle) {
    addText(
      slide,
      protectPresentationInlineTokens(spec.subtitle),
      {
        x: editorial ? 0.72 : CONTENT_LEFT,
        y: editorial ? 1.28 : hasEyebrow ? 1.12 : 1.1,
        w: editorial ? 10.8 : 11.9,
        h: editorial ? 0.24 : 0.28,
      },
      {
        fontSize: editorial ? 11.5 : 14,
        color: palette.muted,
        align: "left",
      },
    );
  }
}

function addBulletList(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  bullets: readonly string[] | undefined,
  box: Box,
  options?: { numbered?: boolean; fontSize?: number },
): void {
  if (!bullets?.length) return;
  const { palette } = context;
  const gap = 0.13;
  const rowHeight = Math.min(
    0.95,
    (box.h - gap * (bullets.length - 1)) / bullets.length,
  );
  const fontSize =
    options?.fontSize ||
    (bullets.length <= 3 ? 14 : bullets.length === 4 ? 13.2 : 12.2);
  bullets.forEach((bullet, index) => {
    const y = box.y + index * (rowHeight + gap);
    if (options?.numbered) {
      addText(
        slide,
        String(index + 1).padStart(2, "0"),
        { x: box.x, y: y + 0.01, w: 0.42, h: 0.26 },
        {
          fontFace: MONO_FONT,
          fontSize: 12,
          bold: true,
          color: palette.accent,
        },
      );
      addRule(
        context,
        slide,
        box.x + 0.43,
        y + 0.18,
        0.24,
        palette.accent,
        1.2,
      );
    } else {
      slide.addShape(context.presentation.ShapeType.rect, {
        x: box.x,
        y: y + 0.13,
        w: 0.09,
        h: 0.09,
        line: { color: palette.accent, transparency: 100 },
        fill: { color: palette.accent },
      });
    }
    addText(
      slide,
      bullet,
      {
        x: box.x + (options?.numbered ? 0.78 : 0.25),
        y,
        w: box.w - (options?.numbered ? 0.78 : 0.25),
        h: rowHeight,
      },
      {
        fontSize,
        color: palette.text,
        valign: "top",
        paraSpaceAfter: 2,
        breakLine: true,
      },
    );
  });
}

function addKeyMessage(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  message: string | undefined,
  box: Box,
): void {
  if (!message) return;
  const { palette } = context;
  addRule(context, slide, box.x, box.y, box.w, palette.accent, 2.2);
  addText(
    slide,
    message,
    { x: box.x, y: box.y + 0.16, w: box.w, h: box.h - 0.16 },
    {
      fontFace: TITLE_FONT,
      fontSize: Array.from(message).length > 85 ? 14.5 : 17,
      bold: false,
      color: palette.accentDark,
      valign: "top",
    },
  );
}

function addCompactCallout(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  callout: NonNullable<RenderablePresentationSlide["callouts"]>[number],
  box: Box,
): void {
  const toneColor =
    callout.tone === "risk"
      ? context.palette.danger
      : callout.tone === "focus"
        ? context.palette.focus
        : callout.tone === "neutral"
          ? context.palette.muted
          : context.palette.accent;
  addRule(context, slide, box.x, box.y, Math.min(0.9, box.w), toneColor, 1.8);
  if (callout.label) {
    addText(
      slide,
      callout.label.toLocaleUpperCase(),
      { x: box.x, y: box.y + 0.13, w: box.w, h: 0.2 },
      {
        fontFace: MONO_FONT,
        fontSize: box.w >= 6 ? 10 : 8.5,
        bold: true,
        color: toneColor,
        charSpacing: 0.8,
      },
    );
  }
  addText(
    slide,
    protectPresentationQuantities(callout.text),
    {
      x: box.x,
      y: box.y + (callout.label ? 0.38 : 0.18),
      w: box.w,
      h: box.h - (callout.label ? 0.38 : 0.18),
    },
    {
      fontSize:
        box.w >= 6
          ? Array.from(callout.text).length > 155
            ? 11.5
            : 13
          : Array.from(callout.text).length > 155
            ? 10.5
            : 12,
      color: context.palette.text,
      valign: "top",
    },
  );
}

function addAcademicTakeawayBand(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  label: string,
  message: string,
  box: Box,
): void {
  const { palette, presentation } = context;
  const labelWidth = Math.min(1.42, Math.max(1.12, box.w * 0.13));
  slide.addShape(presentation.ShapeType.rect, {
    x: box.x,
    y: box.y,
    w: labelWidth,
    h: box.h,
    line: { color: palette.accent, transparency: 100 },
    fill: { color: palette.accent },
  });
  addText(
    slide,
    label,
    {
      x: box.x + 0.1,
      y: box.y + Math.max(0.14, (box.h - 0.18) / 2),
      w: labelWidth - 0.2,
      h: 0.18,
    },
    {
      fontFace: MONO_FONT,
      fontSize: 8.2,
      bold: true,
      color: palette.background,
      charSpacing: 0.6,
      align: "center",
    },
  );
  slide.addShape(presentation.ShapeType.rect, {
    x: box.x + labelWidth,
    y: box.y,
    w: box.w - labelWidth,
    h: box.h,
    line: { color: palette.accent, width: 0.8 },
    fill: { color: palette.background, transparency: 100 },
  });
  addText(
    slide,
    message,
    {
      x: box.x + labelWidth + 0.22,
      y: box.y + Math.max(0.11, (box.h - 0.26) / 2),
      w: box.w - labelWidth - 0.4,
      h: 0.26,
    },
    {
      fontSize: Array.from(message).length > 70 ? 10.8 : 12.2,
      bold: true,
      color: palette.text,
      align: "left",
      valign: "middle",
    },
  );
}

function keyMessageHeight(message: string | undefined, width: number): number {
  if (!message) return 0;
  const fontSize = Array.from(message).length > 85 ? 14.5 : 17;
  return Math.min(
    3.15,
    Math.max(0.92, 0.28 + estimateTextBoxHeight(message, width, fontSize)),
  );
}

function extractLeadEvidenceMetric(
  spec: RenderablePresentationSlide,
): string | undefined {
  const candidates = [spec.keyMessage, spec.title, spec.subtitle].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  const multiplier =
    /(?:约|≈|~)?(?:\d+(?:\.\d+)?|[一二两三四五六七八九十百]+)\s*(?:×|x|倍)/iu;
  const measured =
    /(?:约|≈|~)?\d+(?:\.\d+)?\s*(?:%|％|pp|pt|天|日|小时|h|ms|M|K|万|亿)/iu;
  for (const pattern of [multiplier, measured]) {
    for (const candidate of candidates) {
      const match = candidate.match(pattern)?.[0]?.trim();
      if (match) return match.replace(/x$/iu, "×");
    }
  }
  return undefined;
}

function addFigureNarrativeRail(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
  box: Box,
): void {
  const leadMetric = extractLeadEvidenceMetric(spec);
  const messageHeight = keyMessageHeight(spec.keyMessage, box.w);
  const bulletCount = spec.bullets?.length || 0;
  const contentHeight =
    (leadMetric ? 0.94 : 0) +
    (spec.keyMessage ? messageHeight + 0.24 : 0) +
    (bulletCount ? Math.min(2.35, 0.58 + bulletCount * 0.7) : 0);
  const contentY = box.y + Math.max(0.06, (box.h - contentHeight) / 2);
  let cursorY = contentY;

  if (leadMetric) {
    addRule(
      context,
      slide,
      box.x,
      cursorY,
      Math.min(1.22, box.w),
      context.palette.accent,
      2.4,
    );
    addText(
      slide,
      leadMetric,
      { x: box.x, y: cursorY + 0.15, w: box.w, h: 0.58 },
      {
        fontFace: TITLE_FONT,
        fontSize: Array.from(leadMetric).length > 8 ? 24 : 30,
        bold: true,
        color: context.palette.accentDark,
        valign: "middle",
      },
    );
    cursorY += 0.94;
  }

  if (spec.keyMessage) {
    addKeyMessage(context, slide, spec.keyMessage, {
      x: box.x,
      y: cursorY,
      w: box.w,
      h: messageHeight,
    });
    cursorY += messageHeight + 0.24;
  }

  if (bulletCount) {
    addBulletList(
      context,
      slide,
      spec.bullets,
      {
        x: box.x,
        y: cursorY,
        w: box.w,
        h: Math.max(0.72, box.y + box.h - cursorY),
      },
      { fontSize: leadMetric ? 12.6 : 14 },
    );
  }
}

function addMetrics(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  metrics: RenderablePresentationSlide["metrics"],
  box: Box,
): void {
  if (!metrics?.length) return;
  const { palette } = context;
  addRule(context, slide, box.x, box.y, box.w, palette.border, 0.8);
  const columnWidth = box.w / metrics.length;
  const valueFontSize =
    columnWidth < 0.98
      ? 13.5
      : columnWidth < 1.3
        ? 16.5
        : columnWidth < 1.7
          ? 19
          : metrics.length >= 4
            ? 22
            : 26;
  const labelFontSize = columnWidth < 0.98 ? 8 : columnWidth < 1.3 ? 9 : 11;
  metrics.forEach((metric, index) => {
    const x = box.x + columnWidth * index;
    if (index > 0) {
      slide.addShape(context.presentation.ShapeType.line, {
        x,
        y: box.y + 0.15,
        w: 0,
        h: box.h - 0.15,
        line: { color: palette.border, width: 0.8 },
      });
    }
    addText(
      slide,
      metric.value.replace(/\s+/g, "\u00a0"),
      { x: x + 0.08, y: box.y + 0.2, w: columnWidth - 0.16, h: 0.48 },
      {
        fontFace: TITLE_FONT,
        fontSize: valueFontSize,
        bold: true,
        color: index === 0 ? palette.accentDark : palette.text,
      },
    );
    addText(
      slide,
      metric.label,
      { x: x + 0.08, y: box.y + 0.76, w: columnWidth - 0.16, h: 0.42 },
      {
        fontSize: labelFontSize,
        bold: true,
        color: palette.text,
        valign: "top",
      },
    );
    if (metric.detail) {
      addText(
        slide,
        metric.detail,
        { x: x + 0.08, y: box.y + 1.14, w: columnWidth - 0.16, h: 0.32 },
        {
          fontSize: Math.max(6.8, labelFontSize - 1),
          color: palette.muted,
          valign: "top",
        },
      );
    }
  });
}

function addFigure(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  figure: ResolvedPresentationFigure,
  box: Box,
  mode: "contain" | "cover" = "contain",
): void {
  const { palette } = context;
  slide.addShape(context.presentation.ShapeType.rect, {
    ...box,
    line: { color: palette.border, width: 0.8 },
    fill: { color: palette.paper },
  });
  if (mode === "cover") {
    slide.addImage({
      data: String(figure.data),
      x: box.x,
      y: box.y,
      // PptxGenJS derives cover cropping from the image object's initial
      // dimensions. Base64 images do not expose those dimensions to it, so
      // passing the target box here would produce a zero crop and visibly
      // stretch the figure. Seed it with the real pixel aspect first; the
      // sizing box below becomes the final on-slide extent.
      w: figure.pixelWidth / 96,
      h: figure.pixelHeight / 96,
      sizing: { type: "cover", w: box.w, h: box.h },
      altText: figure.caption || `PDF page ${figure.page}`,
    });
    return;
  }
  const imageAspect = figure.pixelWidth / figure.pixelHeight;
  const boxAspect = box.w / box.h;
  const imageBox = { ...box };
  if (imageAspect > boxAspect) {
    imageBox.h = box.w / imageAspect;
    imageBox.y += (box.h - imageBox.h) / 2;
  } else {
    imageBox.w = box.h * imageAspect;
    imageBox.x += (box.w - imageBox.w) / 2;
  }
  slide.addImage({
    data: String(figure.data),
    ...imageBox,
    altText: figure.caption || `PDF page ${figure.page}`,
  });
}

function addFigureCaption(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  figure: ResolvedPresentationFigure,
  box: Box,
): void {
  const { palette } = context;
  const caption =
    figure.caption ||
    figure.captionHint ||
    `Evidence from PDF page ${figure.page}`;
  const display = layoutFigureCaption(caption, box.w);
  addText(
    slide,
    display.text,
    { ...box, h: Math.max(box.h, display.height) },
    {
      fontSize: 10.2,
      color: palette.muted,
      italic: true,
      valign: "top",
    },
  );
}

function addChart(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  chart: NonNullable<RenderablePresentationSlide["chart"]>,
  box: Box,
): void {
  const { palette, presentation } = context;
  const darkEditorial = context.blueprint.id === "dark-editorial";
  const chartTextColor = darkEditorial ? "17191B" : palette.text;
  const chartMutedColor = darkEditorial ? "53585C" : palette.muted;
  const chartBorderColor = darkEditorial ? "C9C5BB" : palette.border;
  if (darkEditorial) {
    slide.addShape(presentation.ShapeType.rect, {
      ...box,
      line: { color: chartBorderColor, width: 0.75 },
      fill: { color: palette.paper },
    });
  }
  const data = chart.series
    ? chart.series.map((series) => ({
        name: series.name,
        labels: [...chart.labels],
        values: [...series.values],
      }))
    : [
        {
          name: chart.title || "Value",
          labels: [...chart.labels],
          values: [...(chart.values || [])],
        },
      ];
  const chartTextLayout = resolveChartTextLayout(
    chart.labels,
    chart.orientation,
    data.length > 1,
  );
  const showEditableValues =
    chart.type === "bar" &&
    (data.length === 1 || chart.labels.length * data.length <= 8);
  const seriesColors = chartColorsForSlide(chart, palette);
  const hasMultipleSeries = data.length > 1;
  const chartBox = hasMultipleSeries
    ? { ...box, y: box.y + 0.3, h: Math.max(0.8, box.h - 0.3) }
    : box;
  if (hasMultipleSeries) {
    const legendWidth = Math.min(2.8, Math.max(1.25, box.w / data.length));
    data.slice(0, 4).forEach((series, index) => {
      const x = box.x + index * legendWidth;
      slide.addShape(presentation.ShapeType.rect, {
        x,
        y: box.y + 0.08,
        w: 0.13,
        h: 0.13,
        line: { color: seriesColors[index], transparency: 100 },
        fill: { color: seriesColors[index] },
      });
      addText(
        slide,
        series.name,
        { x: x + 0.2, y: box.y + 0.02, w: legendWidth - 0.24, h: 0.24 },
        { fontSize: 9.5, color: chartTextColor, valign: "middle" },
      );
    });
  }
  slide.addChart(
    chart.type === "line"
      ? presentation.ChartType.line
      : presentation.ChartType.bar,
    data,
    {
      ...chartBox,
      fontFace: BODY_FONT,
      fontSize: 11,
      catAxisLabelFontFace: BODY_FONT,
      catAxisLabelFontSize: chartTextLayout.catAxisLabelFontSize,
      catAxisLabelColor: chartMutedColor,
      catAxisLineColor: chartBorderColor,
      valAxisLabelFontFace: BODY_FONT,
      valAxisLabelFontSize: 10,
      valAxisLabelColor: chartMutedColor,
      valAxisLineColor: chartBorderColor,
      catAxisTitle: chart.xAxisTitle,
      valAxisTitle: chart.yAxisTitle,
      catAxisTitleFontFace: BODY_FONT,
      catAxisTitleFontSize: 10,
      valAxisTitleFontFace: BODY_FONT,
      valAxisTitleFontSize: 10,
      showLegend: false,
      legendPos: "b",
      legendFontFace: BODY_FONT,
      legendFontSize: 9.5,
      showTitle: Boolean(chart.title),
      title: chart.title,
      titleFontFace: TITLE_FONT,
      titleFontSize: 13,
      titleColor: chartTextColor,
      dataLabelColor: chartTextColor,
      showValue: showEditableValues,
      barDir: chart.orientation === "horizontal" ? "bar" : "col",
      dataLabelPosition: "outEnd",
      dataLabelFormatCode: "0.0#",
      chartColors: seriesColors,
      showPercent: false,
      chartArea: {
        roundedCorners: false,
        fill: {
          color: darkEditorial ? palette.paper : palette.background,
          transparency: darkEditorial ? 0 : 100,
        },
        border: {
          color: darkEditorial ? chartBorderColor : palette.background,
          pt: 0.1,
        },
      },
      plotArea: {
        fill: {
          color: darkEditorial ? palette.paper : palette.background,
          transparency: darkEditorial ? 0 : 100,
        },
        border: {
          color: darkEditorial ? chartBorderColor : palette.background,
          pt: 0.1,
        },
      },
      catGridLine: { style: "none" },
      valGridLine: { color: chartBorderColor, size: 0.7 },
      layout: chartTextLayout.layout,
    },
  );
  if (chart.highlightIndex !== undefined) {
    addText(
      slide,
      `FOCUS · ${chart.labels[chart.highlightIndex]}`,
      { x: box.x + box.w - 2.1, y: box.y + 0.05, w: 1.95, h: 0.2 },
      {
        fontFace: MONO_FONT,
        fontSize: 8,
        bold: true,
        color: palette.focus,
        align: "right",
      },
    );
  }
}

function addTable(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  table: NonNullable<RenderablePresentationSlide["table"]>,
  box: Box,
): void {
  const { palette } = context;
  const tableLayout = resolvePresentationTableLayout(
    table.rows.length,
    table.headers.length,
    box.h,
  );
  const headerBorder: [
    PptxGenJS.BorderProps,
    PptxGenJS.BorderProps,
    PptxGenJS.BorderProps,
    PptxGenJS.BorderProps,
  ] = [
    { type: "solid", color: palette.text, pt: 1.1 },
    { type: "none", color: palette.background, pt: 0 },
    { type: "solid", color: palette.border, pt: 0.7 },
    { type: "none", color: palette.background, pt: 0 },
  ];
  const rows: PptxGenJS.TableRow[] = [
    table.headers.map((text) => ({
      text,
      options: {
        bold: true,
        color: palette.text,
        fill: { color: palette.frameworkSoft },
        border: headerBorder,
      },
    })),
    ...table.rows.map((row, rowIndex) =>
      row.map((text) => ({
        text,
        options: {
          bold: rowIndex === table.highlightRow,
          color:
            rowIndex === table.highlightRow ? palette.accentDark : palette.text,
          fill: {
            color:
              rowIndex === table.highlightRow
                ? palette.accentSoft
                : palette.background,
          },
          border: [
            { type: "none", color: palette.background, pt: 0 },
            { type: "none", color: palette.background, pt: 0 },
            {
              type: "solid",
              color:
                rowIndex === table.rows.length - 1
                  ? palette.text
                  : palette.border,
              pt: rowIndex === table.rows.length - 1 ? 1.1 : 0.45,
            },
            { type: "none", color: palette.background, pt: 0 },
          ] as [
            PptxGenJS.BorderProps,
            PptxGenJS.BorderProps,
            PptxGenJS.BorderProps,
            PptxGenJS.BorderProps,
          ],
        },
      })),
    ),
  ];
  slide.addTable(rows, {
    ...box,
    color: palette.text,
    fill: { color: palette.background },
    fontFace: BODY_FONT,
    fontSize: tableLayout.fontSize,
    margin: tableLayout.margin,
    rowH: tableLayout.rowHeight,
    valign: "middle",
  });
}

function addEvidenceObject(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
  box: Box,
): void {
  const primaryFigure = spec.figure || spec.figures?.[0];
  if (primaryFigure) {
    const aspect = primaryFigure.pixelWidth / primaryFigure.pixelHeight;
    const dominant =
      spec.visualTuning?.figureEmphasis === "dominant" ||
      context.blueprint.id === "dark-editorial";
    const captionHeight =
      primaryFigure.caption || primaryFigure.captionHint ? 0.4 : 0;
    const naturalHeight = box.w / Math.max(0.1, aspect) + captionHeight;
    const fittedHeight = Math.min(
      box.h,
      Math.max(dominant ? 2.08 : 1.62, naturalHeight),
    );
    const visualBox =
      fittedHeight < box.h - 0.16
        ? {
            x: box.x,
            y: box.y + (box.h - fittedHeight) / 2,
            w: box.w,
            h: fittedHeight,
          }
        : box;
    addFigure(
      context,
      slide,
      primaryFigure,
      { ...visualBox, h: visualBox.h - captionHeight },
      "contain",
    );
    if (captionHeight) {
      addFigureCaption(context, slide, primaryFigure, {
        x: visualBox.x,
        y: visualBox.y + visualBox.h - captionHeight + 0.08,
        w: visualBox.w,
        h: captionHeight - 0.08,
      });
    }
  } else if (spec.chart) {
    addChart(context, slide, spec.chart, box);
  } else if (spec.table) {
    addTable(context, slide, spec.table, box);
  }
}

function renderStatement(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  const { palette } = context;
  const statement = spec.keyMessage || spec.bullets?.[0];
  if (statement) {
    addText(
      slide,
      statement,
      { x: 0.72, y: BODY_TOP + 0.08, w: 7.45, h: 1.38 },
      {
        fontFace: TITLE_FONT,
        fontSize: Array.from(statement).length > 85 ? 18 : 21.5,
        bold: true,
        color: palette.accentDark,
        valign: "top",
      },
    );
    addRule(context, slide, 0.72, BODY_TOP, 1.35, palette.focus, 3);
  }
  const remainingBullets = spec.keyMessage
    ? spec.bullets
    : spec.bullets?.slice(1);
  addBulletList(context, slide, remainingBullets, {
    x: 8.7,
    y: BODY_TOP + 0.14,
    w: 3.72,
    h: spec.metrics?.length ? 2.45 : 4.5,
  });
  if (spec.metrics?.length) {
    addMetrics(context, slide, spec.metrics, {
      x: 0.72,
      y: 4.72,
      w: 11.7,
      h: 1.65,
    });
  } else if (spec.subtitle) {
    addText(
      slide,
      protectPresentationInlineTokens(spec.subtitle),
      { x: 0.76, y: 4.75, w: 7.25, h: 0.85 },
      { fontSize: 14.5, color: palette.muted, valign: "top" },
    );
  }
}

function renderSplit(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
  index: number,
): void {
  const visualLeft = index % 2 === 1;
  const narrativeBox: Box = visualLeft
    ? { x: 8.32, y: BODY_TOP, w: 4.35, h: 4.85 }
    : { x: 0.72, y: BODY_TOP, w: 4.18, h: 4.85 };
  const evidenceBox: Box = visualLeft
    ? { x: 0.72, y: BODY_TOP, w: 6.92, h: 4.85 }
    : { x: 5.5, y: BODY_TOP, w: 7.17, h: 4.85 };
  const messageHeight = keyMessageHeight(spec.keyMessage, narrativeBox.w);
  if (spec.keyMessage) {
    addKeyMessage(context, slide, spec.keyMessage, {
      x: narrativeBox.x,
      y: narrativeBox.y,
      w: narrativeBox.w,
      h: messageHeight,
    });
  }
  addBulletList(context, slide, spec.bullets, {
    x: narrativeBox.x,
    y: narrativeBox.y + (spec.keyMessage ? messageHeight + 0.24 : 0.1),
    w: narrativeBox.w,
    h: narrativeBox.h - (spec.keyMessage ? messageHeight + 0.24 : 0.1),
  });
  addEvidenceObject(context, slide, spec, evidenceBox);
}

function renderFigure(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  if (!spec.figure && !spec.figures?.length) {
    renderStatement(context, slide, spec);
    return;
  }
  const hasNarrative = Boolean(spec.keyMessage || spec.bullets?.length);
  const useFullCanvasForWideFigure = shouldUseFullCanvasWideFigure(spec);
  const renderNarrative = hasNarrative && !useFullCanvasForWideFigure;
  const dominant =
    spec.visualTuning?.figureEmphasis === "dominant" ||
    context.blueprint.id === "dark-editorial";
  const figureBox: Box = renderNarrative
    ? dominant
      ? { x: 4.34, y: BODY_TOP, w: 8.32, h: 4.9 }
      : { x: 0.72, y: BODY_TOP, w: 8.25, h: 4.9 }
    : { x: 0.72, y: BODY_TOP, w: 11.95, h: 4.9 };
  addEvidenceObject(context, slide, spec, figureBox);
  if (renderNarrative) {
    const narrativeBox = dominant
      ? { x: 0.72, y: BODY_TOP + 0.08, w: 3.28, h: 4.72 }
      : { x: 9.4, y: BODY_TOP + 0.08, w: 3.26, h: 4.72 };
    addFigureNarrativeRail(context, slide, spec, narrativeBox);
  }
}

function renderData(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
  index: number,
): void {
  if (spec.equation && !spec.chart && !spec.table && !spec.figure) {
    renderEvidenceLayout(context, slide, spec);
    return;
  }
  const evidenceLeft = index % 2 === 0;
  const editorial = context.blueprint.id === "dark-editorial";
  const evidenceBox: Box = evidenceLeft
    ? {
        x: editorial ? 4.05 : 0.72,
        y: BODY_TOP,
        w: editorial ? 8.62 : 8.12,
        h: 4.88,
      }
    : { x: 4.5, y: BODY_TOP, w: editorial ? 8.17 : 8.17, h: 4.88 };
  const narrativeBox: Box = evidenceLeft
    ? editorial
      ? { x: 0.72, y: BODY_TOP + 0.05, w: 2.98, h: 4.75 }
      : { x: 9.35, y: BODY_TOP + 0.05, w: 3.3, h: 4.75 }
    : { x: 0.72, y: BODY_TOP + 0.05, w: 3.28, h: 4.75 };
  addEvidenceObject(context, slide, spec, evidenceBox);
  const messageHeight = keyMessageHeight(spec.keyMessage, narrativeBox.w);
  addKeyMessage(context, slide, spec.keyMessage, {
    x: narrativeBox.x,
    y: narrativeBox.y,
    w: narrativeBox.w,
    h: messageHeight,
  });
  addBulletList(
    context,
    slide,
    spec.bullets,
    {
      x: narrativeBox.x,
      y: narrativeBox.y + (spec.keyMessage ? messageHeight + 0.28 : 0.1),
      w: narrativeBox.w,
      h: spec.keyMessage ? 4.47 - messageHeight : 4.55,
    },
    { fontSize: 12.2 },
  );
}

function renderProcess(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  const steps = spec.process || [];
  const supportingFigure = spec.figure || spec.figures?.[0];
  const { palette, presentation } = context;
  const scene = planProcessScene(
    Boolean(supportingFigure),
    Boolean(spec.metrics?.length),
    Boolean(spec.callouts?.length),
    supportingFigure
      ? supportingFigure.pixelWidth / Math.max(1, supportingFigure.pixelHeight)
      : undefined,
  );
  const left = scene.nodeBand.x;
  const right = scene.nodeBand.x + scene.nodeBand.w;
  const gap = 0.28;
  const nodeWidth = (right - left - gap * (steps.length - 1)) / steps.length;
  const nodeY = scene.nodeBand.y;

  // Draw the process spine first so every connector sits behind the numbered
  // stages. A flat editorial pipeline keeps the source figure dominant and
  // avoids turning an academic method slide into a row of UI cards.
  for (let index = 0; index < steps.length - 1; index++) {
    const x = left + index * (nodeWidth + gap) + 0.36;
    const nextX = left + (index + 1) * (nodeWidth + gap) + 0.1;
    slide.addShape(presentation.ShapeType.line, {
      x,
      y: nodeY + 0.42,
      w: Math.max(0.16, nextX - x),
      h: 0,
      line: {
        color: palette.border,
        width: 1.1,
        endArrowType: "triangle",
      },
    });
  }

  steps.forEach((step, index) => {
    const x = left + index * (nodeWidth + gap);
    const figureLed = Boolean(supportingFigure);
    const figureLedTitleFontSize = steps.length >= 4 ? 15.5 : 16.2;
    const textLayout = figureLed
      ? {
          titleFontSize: figureLedTitleFontSize,
          titleHeight: Math.min(
            0.42,
            Math.max(
              0.3,
              estimateTextBoxHeight(
                step.title,
                nodeWidth - 0.54,
                figureLedTitleFontSize,
                1.02,
              ) + 0.03,
            ),
          ),
          detailFontSize: 10.4,
          detailHeight: 0.38,
        }
      : layoutProcessStepText(
          step.title,
          step.detail,
          nodeWidth - 0.5,
          steps.length,
        );
    slide.addShape(presentation.ShapeType.ellipse, {
      x: x + 0.02,
      y: nodeY + 0.2,
      w: 0.36,
      h: 0.36,
      line: {
        color: index === 0 ? palette.focus : palette.accent,
        width: index === 0 ? 1.5 : 1.1,
      },
      fill: {
        color: index === 0 ? palette.focus : palette.background,
        transparency: index === 0 ? 0 : 100,
      },
    });
    addText(
      slide,
      String(index + 1),
      { x: x + 0.02, y: nodeY + 0.292, w: 0.36, h: 0.14 },
      {
        fontFace: MONO_FONT,
        fontSize: 9.2,
        bold: true,
        color: index === 0 ? palette.background : palette.accentDark,
        align: "center",
      },
    );
    addText(
      slide,
      protectPresentationInlineTokens(step.title),
      {
        x: x + 0.5,
        y: nodeY + (figureLed ? 0.08 : 0.04),
        w: nodeWidth - 0.54,
        h: textLayout.titleHeight,
      },
      {
        fontFace: TITLE_FONT,
        fontSize: textLayout.titleFontSize,
        bold: index === 0,
        color: palette.text,
        align: "left",
        valign: "top",
      },
    );
    if (step.detail) {
      addText(
        slide,
        protectPresentationInlineTokens(step.detail),
        {
          x: x + 0.46,
          y: nodeY + (figureLed ? 0.47 : 0.08 + textLayout.titleHeight),
          w: nodeWidth - 0.5,
          h: textLayout.detailHeight,
        },
        {
          fontSize: textLayout.detailFontSize,
          color: palette.muted,
          align: "left",
          valign: "top",
        },
      );
    }
  });
  if (supportingFigure && scene.figureBox) {
    const narrativeBox = scene.narrativeBox;
    if (narrativeBox) {
      const messageHeight = keyMessageHeight(spec.keyMessage, narrativeBox.w);
      addKeyMessage(context, slide, spec.keyMessage, {
        x: narrativeBox.x,
        y: narrativeBox.y,
        w: narrativeBox.w,
        h: messageHeight,
      });
      addBulletList(
        context,
        slide,
        spec.bullets,
        {
          x: narrativeBox.x,
          y: narrativeBox.y + (spec.keyMessage ? messageHeight + 0.18 : 0.05),
          w: narrativeBox.w,
          h:
            narrativeBox.h -
            (spec.keyMessage ? messageHeight + 0.18 : 0.05) -
            (spec.metrics?.length ? 1.35 : 0),
        },
        { fontSize: 11.5 },
      );
    }
    const figureCaptionHeight =
      supportingFigure.caption || supportingFigure.captionHint ? 0.34 : 0;
    addFigure(context, slide, supportingFigure, {
      x: scene.figureBox.x,
      y: scene.figureBox.y,
      w: scene.figureBox.w,
      h: scene.figureBox.h - figureCaptionHeight,
    });
    if (figureCaptionHeight) {
      addFigureCaption(context, slide, supportingFigure, {
        x: scene.figureBox.x,
        y: scene.figureBox.y + scene.figureBox.h - 0.28,
        w: scene.figureBox.w,
        h: 0.26,
      });
    }
    if (spec.callouts?.length && scene.calloutBox) {
      addCompactCallout(context, slide, spec.callouts[0], scene.calloutBox);
    }
    if (spec.equation) {
      addRule(context, slide, 1.68, 5.88, 10.05, palette.border, 0.7);
      addText(
        slide,
        spec.equation.expression,
        { x: 1.35, y: 6.02, w: 10.65, h: 0.42 },
        {
          fontFace: "Cambria Math",
          fontSize:
            Array.from(spec.equation.expression).length > 72 ? 13.5 : 16.5,
          color: palette.text,
          align: "center",
          valign: "middle",
        },
      );
    } else if (spec.metrics?.length && scene.metricsBox) {
      const hasNarrative = Boolean(
        narrativeBox && (spec.keyMessage || spec.bullets?.length),
      );
      addMetrics(
        context,
        slide,
        spec.metrics.slice(0, 2),
        hasNarrative && narrativeBox
          ? scene.metricsBox
          : narrativeBox
            ? {
                x: narrativeBox.x,
                y: narrativeBox.y + 0.12,
                w: narrativeBox.w,
                h: 1.38,
              }
            : scene.metricsBox,
      );
    }
    return;
  }

  addKeyMessage(context, slide, spec.keyMessage, {
    x: 0.82,
    y: 3.86,
    w: 5.35,
    h: 0.92,
  });
  addBulletList(
    context,
    slide,
    spec.bullets,
    {
      x: 6.7,
      y: 3.87,
      w: 5.8,
      h: 1.04,
    },
    { fontSize: 11.5 },
  );
  if (spec.equation) {
    addRule(context, slide, 3.2, 5.17, 6.95, palette.border, 0.7);
    addText(
      slide,
      spec.equation.expression,
      { x: 2.2, y: 5.38, w: 8.95, h: 0.54 },
      {
        fontFace: "Cambria Math",
        fontSize: Array.from(spec.equation.expression).length > 72 ? 14.5 : 18,
        color: palette.text,
        align: "center",
        valign: "middle",
      },
    );
    if (spec.equation.explanation) {
      addText(
        slide,
        spec.equation.explanation,
        { x: 2.0, y: 6.0, w: 9.35, h: 0.3 },
        { fontSize: 8.5, color: palette.muted, align: "center" },
      );
    }
  } else if (spec.metrics?.length) {
    addMetrics(context, slide, spec.metrics, {
      x: 1.35,
      y: 5.12,
      w: 10.65,
      h: 1.14,
    });
  }
}

function renderComparison(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  const comparison = spec.comparison;
  if (!comparison) {
    renderStatement(context, slide, spec);
    return;
  }
  const { palette, presentation } = context;
  const figures = [
    ...(spec.figure ? [spec.figure] : []),
    ...(spec.figures || []),
  ].slice(0, 2);
  const hasFigures = figures.length > 0;
  const hasBottomEvidence = Boolean(
    !hasFigures && (spec.metrics?.length || spec.callouts?.length),
  );
  const columns = [comparison.left, comparison.right];

  if (!hasFigures) {
    const tableX = 0.82;
    const tableWidth = 11.68;
    const indexWidth = 0.62;
    const columnGap = 0.34;
    const columnWidth = (tableWidth - indexWidth - columnGap) / 2;
    const leftX = tableX + indexWidth;
    const rightX = leftX + columnWidth + columnGap;
    const headerY = BODY_TOP + 0.02;
    const headerHeight = 0.58;
    slide.addShape(presentation.ShapeType.rect, {
      x: tableX,
      y: headerY,
      w: indexWidth + columnWidth,
      h: headerHeight,
      line: { color: palette.frameworkSoft, transparency: 100 },
      fill: { color: palette.frameworkSoft },
    });
    slide.addShape(presentation.ShapeType.rect, {
      x: rightX - 0.12,
      y: headerY,
      w: columnWidth + 0.12,
      h: headerHeight,
      line: { color: palette.accentSoft, transparency: 100 },
      fill: { color: palette.accentSoft },
    });
    addText(
      slide,
      context.labels.evidence,
      { x: tableX + 0.08, y: headerY + 0.18, w: indexWidth - 0.08, h: 0.2 },
      {
        fontFace: MONO_FONT,
        fontSize: 7.3,
        bold: true,
        color: palette.muted,
        charSpacing: 0.55,
      },
    );
    columns.forEach((column, columnIndex) => {
      addText(
        slide,
        column.title,
        {
          x: columnIndex === 0 ? leftX : rightX,
          y: headerY + 0.14,
          w: columnWidth - 0.16,
          h: 0.26,
        },
        {
          fontFace: TITLE_FONT,
          fontSize: 14.5,
          bold: true,
          color: columnIndex === 0 ? palette.text : palette.accentDark,
          align: "center",
        },
      );
    });

    const rowCount = Math.max(
      comparison.left.bullets.length,
      comparison.right.bullets.length,
    );
    const rowsTop = headerY + headerHeight + 0.08;
    const rowsHeight = hasBottomEvidence ? 2.52 : spec.keyMessage ? 3.82 : 4.22;
    const rowHeight = rowsHeight / Math.max(1, rowCount);
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const y = rowsTop + rowIndex * rowHeight;
      addRule(context, slide, tableX, y, tableWidth, palette.border, 0.55);
      addText(
        slide,
        String(rowIndex + 1).padStart(2, "0"),
        { x: tableX + 0.08, y: y + 0.16, w: indexWidth - 0.12, h: 0.22 },
        {
          fontFace: MONO_FONT,
          fontSize: 9,
          bold: true,
          color: rowIndex === rowCount - 1 ? palette.focus : palette.faint,
        },
      );
      const leftBullet = comparison.left.bullets[rowIndex] || "—";
      const rightBullet = comparison.right.bullets[rowIndex] || "—";
      addText(
        slide,
        leftBullet,
        {
          x: leftX + 0.14,
          y: y + 0.1,
          w: columnWidth - 0.32,
          h: rowHeight - 0.14,
        },
        {
          fontSize: rowCount >= 4 ? 11.3 : 12.6,
          color: palette.muted,
          valign: "middle",
          align: "center",
        },
      );
      addText(
        slide,
        rightBullet,
        {
          x: rightX + 0.08,
          y: y + 0.1,
          w: columnWidth - 0.22,
          h: rowHeight - 0.14,
        },
        {
          fontSize: rowCount >= 4 ? 11.3 : 12.6,
          bold: rowIndex === rowCount - 1,
          color: rowIndex === rowCount - 1 ? palette.accentDark : palette.text,
          valign: "middle",
          align: "center",
        },
      );
    }
    addRule(
      context,
      slide,
      tableX,
      rowsTop + rowsHeight,
      tableWidth,
      palette.border,
      0.55,
    );
    slide.addShape(presentation.ShapeType.line, {
      x: rightX - columnGap / 2,
      y: headerY,
      w: 0,
      h: headerHeight + rowsHeight + 0.08,
      line: { color: palette.border, width: 0.8 },
    });

    const calloutAsTakeaway = !spec.keyMessage && spec.callouts?.[0];
    if (spec.metrics?.length) {
      addMetrics(context, slide, spec.metrics, {
        x: 0.82,
        y: 5.18,
        w: calloutAsTakeaway ? 11.68 : spec.callouts?.length ? 7.42 : 11.68,
        h: 1.26,
      });
    }
    if (spec.callouts?.length && !calloutAsTakeaway) {
      addCompactCallout(context, slide, spec.callouts[0], {
        x: spec.metrics?.length ? 8.58 : 0.82,
        y: 5.2,
        w: spec.metrics?.length ? 4.02 : 11.68,
        h: 1.2,
      });
    }
    if (calloutAsTakeaway) {
      addAcademicTakeawayBand(
        context,
        slide,
        calloutAsTakeaway.label || context.labels.researchGap,
        calloutAsTakeaway.text,
        { x: tableX, y: 6.2, w: tableWidth, h: 0.54 },
      );
    }
    if (spec.keyMessage) {
      const bandY = hasBottomEvidence ? 4.78 : 6.05;
      addAcademicTakeawayBand(
        context,
        slide,
        context.labels.researchGap,
        spec.keyMessage,
        { x: tableX, y: bandY, w: tableWidth, h: 0.54 },
      );
    }
    return;
  }

  slide.addShape(presentation.ShapeType.line, {
    x: 6.665,
    y: BODY_TOP,
    w: 0,
    h: 4.75,
    line: { color: palette.border, width: 1.1 },
  });
  columns.forEach((column, index) => {
    const x = index === 0 ? 0.82 : 7.13;
    addText(
      slide,
      column.title,
      { x, y: BODY_TOP + 0.05, w: 5.35, h: 0.55 },
      {
        fontFace: TITLE_FONT,
        fontSize: 19.5,
        bold: false,
        color: index === 0 ? palette.text : palette.accentDark,
      },
    );
    addRule(
      context,
      slide,
      x,
      BODY_TOP + 0.72,
      index === 0 ? 0.7 : 1.15,
      index === 0 ? palette.faint : palette.accent,
      2.2,
    );
    addBulletList(
      context,
      slide,
      column.bullets,
      {
        x,
        y: BODY_TOP + 1.02,
        w: 5.25,
        h: hasFigures ? 1.88 : hasBottomEvidence ? 2.42 : 3.55,
      },
      { fontSize: 12 },
    );
    const figure = figures[index];
    if (figure) {
      addFigure(context, slide, figure, {
        x,
        y: BODY_TOP + 3.02,
        w: 5.25,
        h: 1.42,
      });
      addFigureCaption(context, slide, figure, {
        x,
        y: BODY_TOP + 4.5,
        w: 5.25,
        h: 0.22,
      });
    }
  });
  if (spec.keyMessage) {
    addText(
      slide,
      spec.keyMessage,
      { x: 3.6, y: 6.27, w: 6.15, h: 0.34 },
      {
        fontSize: 13,
        bold: true,
        color: palette.accentDark,
        align: "center",
      },
    );
  }
}

function renderSummary(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  const { palette } = context;
  const bullets = spec.bullets || [];
  const figure = spec.figure || spec.figures?.[0];
  addBulletList(
    context,
    slide,
    bullets,
    { x: 0.78, y: BODY_TOP + 0.08, w: 7.7, h: 4.55 },
    { numbered: true, fontSize: 13.5 },
  );
  addRule(context, slide, 8.92, BODY_TOP + 0.08, 3.55, palette.framework, 3);
  addText(
    slide,
    context.labels.whatThisChanges,
    { x: 8.92, y: BODY_TOP + 0.35, w: 3.55, h: 0.28 },
    {
      fontFace: MONO_FONT,
      fontSize: 9,
      bold: true,
      color: palette.framework,
      charSpacing: 1.2,
    },
  );
  if (figure) {
    addFigure(context, slide, figure, {
      x: 8.92,
      y: BODY_TOP + 0.78,
      w: 3.55,
      h: 2.48,
    });
    addFigureCaption(context, slide, figure, {
      x: 8.92,
      y: BODY_TOP + 3.34,
      w: 3.55,
      h: 0.28,
    });
    if (spec.keyMessage || spec.subtitle) {
      addText(
        slide,
        spec.keyMessage || spec.subtitle || "",
        { x: 8.92, y: BODY_TOP + 3.78, w: 3.55, h: 0.76 },
        {
          fontFace: TITLE_FONT,
          fontSize: 14.5,
          bold: true,
          color: palette.text,
          valign: "top",
        },
      );
    }
  } else {
    addText(
      slide,
      spec.keyMessage ||
        spec.subtitle ||
        "The evidence narrows the next decision.",
      { x: 8.92, y: BODY_TOP + 0.82, w: 3.55, h: 1.65 },
      {
        fontFace: TITLE_FONT,
        fontSize: 23,
        bold: true,
        color: palette.text,
        valign: "top",
      },
    );
  }
  if (spec.metrics?.length) {
    if (figure) {
      const metrics = spec.metrics.slice(0, 2);
      const metricWidth = 3.55 / metrics.length;
      addRule(context, slide, 8.92, 5.86, 3.55, palette.border, 0.7);
      metrics.forEach((metric, index) => {
        const x = 8.92 + index * metricWidth;
        addText(
          slide,
          metric.value,
          { x, y: 5.98, w: metricWidth - 0.08, h: 0.34 },
          {
            fontFace: TITLE_FONT,
            fontSize: 18,
            bold: true,
            color: index === 0 ? palette.accentDark : palette.text,
            align: "center",
          },
        );
        addText(
          slide,
          metric.label,
          { x, y: 6.37, w: metricWidth - 0.08, h: 0.2 },
          { fontSize: 8.5, bold: true, color: palette.muted, align: "center" },
        );
      });
    } else {
      addMetrics(context, slide, spec.metrics.slice(0, 2), {
        x: 8.92,
        y: 4.72,
        w: 3.55,
        h: 1.45,
      });
    }
  }
}

function coverMetrics(
  spec: RenderablePresentationRequest,
): NonNullable<RenderablePresentationSlide["metrics"]> {
  if (spec.coverMetrics?.length) return spec.coverMetrics.slice(0, 3);
  const seen = new Set<string>();
  const metrics: NonNullable<RenderablePresentationSlide["metrics"]> = [];
  for (const slide of spec.slides) {
    for (const metric of slide.metrics || []) {
      const signature = `${metric.value}:${metric.label}`;
      if (
        seen.has(signature) ||
        Array.from(metric.value).length > 14 ||
        Array.from(metric.label).length > 26
      ) {
        continue;
      }
      seen.add(signature);
      metrics.push(metric);
      if (metrics.length === 3) return metrics;
    }
  }
  return metrics;
}

function addCoverEvidenceLine(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  metrics: NonNullable<RenderablePresentationSlide["metrics"]>,
  box: Box,
): void {
  if (!metrics.length) return;
  const { palette } = context;
  const evidence = metrics
    .slice(0, 3)
    .map((metric) => `${metric.value} ${metric.label}`)
    .join("  ·  ");
  addText(slide, evidence, box, {
    fontFace: MONO_FONT,
    fontSize: 8.3,
    bold: true,
    color: palette.text,
    valign: "middle",
  });
}

function renderCoverEvidencePlate(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  figures: readonly ResolvedPresentationFigure[],
): Box {
  const firstAspect = figures[0]
    ? figures[0].pixelWidth / Math.max(1, figures[0].pixelHeight)
    : 1;
  const useWideEditorialBand = figures.length === 1 && firstAspect >= 2.35;
  const region = useWideEditorialBand
    ? { x: 4.54, y: 2.62, w: 8.42, h: 3.92 }
    : { ...context.blueprint.cover.hero };
  if (useWideEditorialBand) {
    addRule(
      context,
      slide,
      region.x,
      region.y + 0.38,
      region.w,
      context.palette.border,
      0.65,
    );
    const sourceLabel =
      figures[0]?.captionHint?.match(/^(?:Figure|Fig\.|Table)\s*\d+/iu)?.[0] ||
      `PDF ${figures[0]?.page || ""}`.trim();
    addText(
      slide,
      sourceLabel.toLocaleUpperCase(),
      { x: region.x, y: region.y + 0.08, w: region.w, h: 0.2 },
      {
        fontFace: MONO_FONT,
        fontSize: 8.5,
        bold: true,
        color: context.palette.accentDark,
        charSpacing: 1.05,
      },
    );
  }
  if (figures.length > 1 && firstAspect >= 1.6) {
    const heroHeight = firstAspect <= 1.8 ? 2.9 : 2.72;
    const heroWidth = Math.min(6.95, heroHeight * firstAspect);
    const heroBox = {
      x: 12.62 - heroWidth,
      y: 6.46 - heroHeight,
      w: heroWidth,
      h: heroHeight,
    };
    addFigure(context, slide, figures[0], heroBox, "contain");
    addFigure(
      context,
      slide,
      figures[1],
      { x: 7.08, y: 0.28, w: 5.9, h: 3.04 },
      "contain",
    );
    return heroBox;
  }
  if (figures.length <= 1) {
    const figure = figures[0];
    if (!figure) return region;
    if (useWideEditorialBand) {
      const heroBox = {
        x: region.x,
        y: region.y + 0.52,
        w: region.w,
        h: region.w / firstAspect,
      };
      // Ultra-wide figures need horizontal room, not a portrait frame. Let the
      // title own the upper-left and place one complete, readable evidence hero
      // across the lower-right. This preserves every source panel while still
      // giving the visual more than one fifth of the cover canvas.
      slide.addImage({
        data: String(figure.data),
        ...heroBox,
        altText: figure.caption || `PDF page ${figure.page}`,
      });
      return heroBox;
    }
    const imageAspect = figure.pixelWidth / Math.max(1, figure.pixelHeight);
    const imageRegion = region;
    const regionAspect = imageRegion.w / imageRegion.h;
    const heroBox = { ...imageRegion };
    if (imageAspect > regionAspect) {
      heroBox.h = imageRegion.w / imageAspect;
      heroBox.y += (imageRegion.h - heroBox.h) / 2;
    } else {
      heroBox.w = imageRegion.h * imageAspect;
      heroBox.x = imageRegion.x + imageRegion.w - heroBox.w;
    }
    addFigure(context, slide, figure, heroBox, "contain");
    return heroBox;
  }

  const gap = 0.16;
  const primaryHeight = region.h * 0.62;
  addFigure(context, slide, figures[0], {
    x: region.x,
    y: region.y,
    w: region.w,
    h: primaryHeight,
  });

  const supporting = figures.slice(1, 3);
  const supportingY = region.y + primaryHeight + gap;
  const supportingHeight = region.h - primaryHeight - gap;
  if (supporting.length === 1) {
    const supportAspect =
      supporting[0].pixelWidth / Math.max(1, supporting[0].pixelHeight);
    const supportWidth = supportAspect >= 1.6 ? region.w : region.w * 0.82;
    addFigure(context, slide, supporting[0], {
      x: region.x + region.w - supportWidth,
      y: supportingY,
      w: supportWidth,
      h: supportingHeight,
    });
  } else {
    const supportingWidth = (region.w - gap) / 2;
    supporting.forEach((figure, index) => {
      addFigure(context, slide, figure, {
        x: region.x + index * (supportingWidth + gap),
        y: supportingY,
        w: supportingWidth,
        h: supportingHeight,
      });
    });
  }
  return region;
}

function renderDarkEditorialCover(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationRequest,
): void {
  const { palette, presentation } = context;
  const hero = selectPresentationCoverHero(spec);
  slide.background = { color: palette.background };

  if (hero) {
    slide.addImage({
      data: String(hero.data),
      x: 0,
      y: 0,
      w: SLIDE_WIDTH,
      h: SLIDE_HEIGHT,
      sizing: { type: "cover", w: SLIDE_WIDTH, h: SLIDE_HEIGHT },
      altText: hero.caption || hero.captionHint || `PDF page ${hero.page}`,
    });
    // Two overlays approximate a cinematic gradient while remaining editable
    // in PowerPoint: the whole frame is toned down and the title side gets a
    // stronger stage. The paper evidence remains visible instead of becoming
    // a decorative thumbnail in a white template.
    slide.addShape(presentation.ShapeType.rect, {
      x: 0,
      y: 0,
      w: SLIDE_WIDTH,
      h: SLIDE_HEIGHT,
      line: { color: "000000", transparency: 100 },
      fill: { color: "000000", transparency: 42 },
    });
    slide.addShape(presentation.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 8.15,
      h: SLIDE_HEIGHT,
      line: { color: "000000", transparency: 100 },
      fill: { color: "000000", transparency: 14 },
    });
  } else {
    slide.addShape(presentation.ShapeType.rect, {
      x: 8.72,
      y: 0,
      w: 4.61,
      h: 7.5,
      line: { color: palette.surface, transparency: 100 },
      fill: { color: palette.surface },
    });
    for (let index = 0; index < 6; index++) {
      addRule(
        context,
        slide,
        9.04,
        1.2 + index * 0.78,
        3.35 - index * 0.24,
        index === 1 ? palette.accent : palette.border,
        index === 1 ? 2.6 : 0.8,
      );
    }
  }

  slide.addShape(presentation.ShapeType.rect, {
    x: 0.82,
    y: 0.62,
    w: 0.08,
    h: 0.34,
    line: { color: palette.accent, transparency: 100 },
    fill: { color: palette.accent },
  });
  addText(
    slide,
    context.labels.coverBrief,
    { x: 1.04, y: 0.68, w: 5.2, h: 0.2 },
    {
      fontFace: MONO_FONT,
      fontSize: 8.2,
      bold: true,
      color: palette.coverText,
      charSpacing: 1.35,
    },
  );

  const tuning = spec.visualTuning?.titleScale;
  const baseTitleSize = coverTitleFontSize(spec.title) + 5;
  const titleSize = Math.max(
    34,
    Math.min(
      46,
      baseTitleSize + (tuning === "large" ? 4 : tuning === "compact" ? -4 : 0),
    ),
  );
  const coverTitle = wrapMixedScriptTitle(spec.title, 8.8, titleSize);
  const titleHeight = Math.min(
    1.38,
    Math.max(0.68, estimateTextBoxHeight(coverTitle, 8.8, titleSize, 1.02)),
  );
  const titleY = 5.76 - titleHeight;
  addRule(context, slide, 0.84, 4.26, 0.82, palette.accent, 3.4);
  addText(
    slide,
    coverTitle,
    { x: 0.82, y: titleY, w: 8.8, h: titleHeight },
    {
      fontFace: TITLE_FONT,
      fontSize: titleSize,
      bold: true,
      color: palette.coverText,
      valign: "bottom",
    },
  );
  if (spec.subtitle) {
    addText(
      slide,
      protectPresentationInlineTokens(spec.subtitle),
      { x: 0.84, y: titleY + titleHeight + 0.12, w: 8.35, h: 0.48 },
      {
        fontSize: 15.2,
        color: "D7D3CA",
        valign: "top",
      },
    );
  }

  addText(
    slide,
    spec.author || "PaperChat",
    { x: 0.84, y: 6.9, w: 5.3, h: 0.22 },
    { fontSize: 10.5, bold: true, color: palette.coverText },
  );
  addText(
    slide,
    spec.year || new Date().getFullYear().toString(),
    { x: 11.62, y: 6.88, w: 0.84, h: 0.22 },
    {
      fontFace: MONO_FONT,
      fontSize: 9,
      bold: true,
      color: palette.coverText,
      align: "right",
    },
  );

  const sourceFigures = [
    ...(spec.coverFigure ? [spec.coverFigure] : []),
    ...(spec.coverFigures || []),
  ];
  slide.addNotes(
    sourceFigures.length
      ? `[Sources]\n${sourceFigures
          .map(
            (figure) =>
              `- Zotero item ${figure.itemKey || spec.sourceItemKey || "unknown"}, PDF page ${figure.page}`,
          )
          .join("\n")}`
      : "",
  );
}

export function renderCover(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationRequest,
): void {
  const { palette, presentation } = context;
  if (context.blueprint.id === "dark-editorial") {
    renderDarkEditorialCover(context, slide, spec);
    return;
  }
  slide.background = { color: palette.background };
  const heroFigure = selectPresentationCoverHero(spec);
  const requestedCoverLayout = spec.visualTuning?.layout;
  const coverFigures = planPresentationCoverFigures(
    spec,
    requestedCoverLayout === "single-hero" ||
      (requestedCoverLayout !== "editorial-collage" &&
        context.blueprint.id === "teal-green-academic-defense"),
  );
  const heroAspect = heroFigure
    ? heroFigure.pixelWidth / Math.max(1, heroFigure.pixelHeight)
    : 0;
  const landscapeCollage = Boolean(
    heroFigure && coverFigures.length > 1 && heroAspect >= 1.6,
  );
  const wideHero = Boolean(
    heroFigure && coverFigures.length === 1 && heroAspect >= 2.35,
  );
  if (heroFigure) {
    const heroBox = renderCoverEvidencePlate(context, slide, coverFigures);
    const coverCaption =
      heroFigure.caption ||
      heroFigure.captionHint ||
      `PDF page ${heroFigure.page}`;
    const captionLayout = layoutFigureCaption(coverCaption, heroBox.w);
    const desiredCaptionY = landscapeCollage
      ? 6.58
      : wideHero
        ? Math.min(6.98, heroBox.y + heroBox.h + 0.08)
        : Math.min(5.82, heroBox.y + heroBox.h + 0.12);
    const captionY = Math.min(desiredCaptionY, 7.14 - captionLayout.height);
    addRule(
      context,
      slide,
      heroBox.x,
      captionY,
      heroBox.w,
      palette.border,
      0.65,
    );
    addText(
      slide,
      captionLayout.text,
      {
        x: heroBox.x,
        y: captionY + 0.1,
        w: heroBox.w,
        h: captionLayout.height,
      },
      {
        fontSize: 10,
        color: palette.muted,
        italic: true,
        valign: "top",
      },
    );
  } else {
    slide.addShape(presentation.ShapeType.rect, {
      x: 8.72,
      y: 0,
      w: 4.61,
      h: 7.5,
      line: { color: palette.accentDark, transparency: 100 },
      fill: { color: palette.accentDark },
    });
    for (let index = 0; index < 7; index++) {
      addRule(
        context,
        slide,
        9.15,
        1.15 + index * 0.72,
        3.3 - index * 0.2,
        index === 2 ? palette.focus : palette.accent,
        index === 2 ? 2.2 : 0.75,
      );
    }
  }

  slide.addShape(presentation.ShapeType.rect, {
    x: 0.74,
    y: 0.68,
    w: 0.09,
    h: 0.32,
    line: { color: palette.accent, transparency: 100 },
    fill: { color: palette.accent },
  });
  addText(
    slide,
    context.labels.coverBrief,
    { x: 0.98, y: 0.72, w: 4.6, h: 0.2 },
    {
      fontFace: MONO_FONT,
      fontSize: 8.5,
      bold: true,
      color: palette.accentDark,
      charSpacing: 1.25,
    },
  );
  addText(
    slide,
    wrapMixedScriptTitle(
      spec.title,
      wideHero ? 7.35 : landscapeCollage ? 6.62 : 6.3,
      wideHero
        ? Math.min(
            spec.visualTuning?.titleScale === "large"
              ? 36
              : spec.visualTuning?.titleScale === "compact"
                ? 29
                : 33,
            spec.visualTuning?.titleScale === "compact"
              ? coverTitleFontSize(spec.title) - 3
              : coverTitleFontSize(spec.title),
          )
        : landscapeCollage
          ? Math.min(
              spec.visualTuning?.titleScale === "large"
                ? 31
                : spec.visualTuning?.titleScale === "compact"
                  ? 26
                  : 29.5,
              spec.visualTuning?.titleScale === "compact"
                ? coverTitleFontSize(spec.title) - 4
                : coverTitleFontSize(spec.title),
            )
          : Math.max(
              28,
              coverTitleFontSize(spec.title) -
                (spec.visualTuning?.titleScale === "compact" ? 4 : 0),
            ),
    ),
    wideHero
      ? { x: 0.76, y: 1.16, w: 7.35, h: 1.54 }
      : landscapeCollage
        ? { x: 0.76, y: 1.44, w: 6.62, h: 1.76 }
        : {
            ...context.blueprint.cover.title,
            w: heroFigure
              ? context.blueprint.cover.title.w
              : context.blueprint.cover.title.w + 0.45,
          },
    {
      fontFace: TITLE_FONT,
      fontSize: wideHero
        ? Math.min(
            spec.visualTuning?.titleScale === "large"
              ? 36
              : spec.visualTuning?.titleScale === "compact"
                ? 29
                : 33,
            spec.visualTuning?.titleScale === "compact"
              ? coverTitleFontSize(spec.title) - 3
              : coverTitleFontSize(spec.title),
          )
        : landscapeCollage
          ? Math.min(
              spec.visualTuning?.titleScale === "large"
                ? 31
                : spec.visualTuning?.titleScale === "compact"
                  ? 26
                  : 29.5,
              spec.visualTuning?.titleScale === "compact"
                ? coverTitleFontSize(spec.title) - 4
                : coverTitleFontSize(spec.title),
            )
          : Math.max(
              28,
              coverTitleFontSize(spec.title) -
                (spec.visualTuning?.titleScale === "compact" ? 4 : 0),
            ),
      bold: false,
      color: palette.text,
      valign: "middle",
    },
  );
  if (spec.subtitle) {
    const coverSubtitleBox = wideHero
      ? { x: 0.76, y: 3.34, w: 3.72, h: 0.92 }
      : landscapeCollage
        ? { x: 0.76, y: 3.55, w: 6.42, h: 0.72 }
        : {
            ...context.blueprint.cover.subtitle,
            w: heroFigure
              ? context.blueprint.cover.subtitle.w
              : context.blueprint.cover.subtitle.w + 0.4,
          };
    addRule(
      context,
      slide,
      0.76,
      coverSubtitleBox.y - 0.14,
      1.35,
      palette.focus,
      2.6,
    );
    addText(
      slide,
      protectPresentationInlineTokens(spec.subtitle),
      coverSubtitleBox,
      { fontSize: 14.5, color: palette.muted, valign: "top" },
    );
  }
  if (
    context.blueprint.id === "teal-green-academic-defense" &&
    !spec.visualTuning?.hideEvidenceLine
  ) {
    const metrics = coverMetrics(spec);
    if (wideHero) {
      // A wide evidence hero and a three-row KPI rail create competing focal
      // points. The reference academic system treats cover numbers as one
      // quiet evidence sentence so the title and paper image remain primary.
      addCoverEvidenceLine(context, slide, metrics, {
        x: 0.76,
        y: 4.74,
        w: 3.72,
        h: 0.42,
      });
    } else {
      addCoverEvidenceLine(
        context,
        slide,
        metrics,
        landscapeCollage
          ? { x: 0.76, y: 4.62, w: 6.3, h: 0.3 }
          : { x: 0.76, y: 5.34, w: 6.1, h: 0.28 },
      );
    }
  }
  const coverYearX = wideHero ? 3.66 : landscapeCollage ? 4.72 : 5.85;
  const coverAuthorX = 0.76;
  const coverAuthorWidth = Math.max(1.6, coverYearX - coverAuthorX - 0.16);
  addText(
    slide,
    spec.author || "PaperChat",
    {
      x: coverAuthorX,
      y: landscapeCollage ? 6.46 : 6.45,
      w: coverAuthorWidth,
      h: 0.25,
    },
    {
      fontSize: 12,
      bold: true,
      color: palette.text,
      align: "left",
    },
  );
  addText(
    slide,
    spec.year || new Date().getFullYear().toString(),
    {
      x: coverYearX,
      y: landscapeCollage ? 6.46 : 6.45,
      w: 0.82,
      h: 0.25,
    },
    {
      fontFace: MONO_FONT,
      fontSize: 9.5,
      color: palette.muted,
      align: "right",
    },
  );
  const coverSourceFigures = [
    ...(spec.coverFigure ? [spec.coverFigure] : []),
    ...(spec.coverFigures || []),
  ];
  const coverSources = coverSourceFigures.length
    ? `[Sources]\n${coverSourceFigures
        .map(
          (figure) =>
            `- Zotero item ${figure.itemKey || spec.sourceItemKey || "unknown"}, PDF page ${figure.page}`,
        )
        .join("\n")}`
    : "";
  slide.addNotes(coverSources);
}

export function renderContentSlide(
  context: RenderContext,
  slide: PptxGenJS.Slide,
  deckSpec: RenderablePresentationRequest,
  spec: RenderablePresentationSlide,
  index: number,
): void {
  slide.background = { color: context.palette.background };
  addSlideHeading(context, slide, spec);
  const layout = resolveLayout(spec, index);
  switch (layout) {
    case "statement":
      renderStatement(context, slide, spec);
      break;
    case "split":
      renderSplit(context, slide, spec, index);
      break;
    case "figure":
      renderFigure(context, slide, spec);
      break;
    case "data":
      renderData(context, slide, spec, index);
      break;
    case "process":
      renderProcess(context, slide, spec);
      break;
    case "comparison":
      renderComparison(context, slide, spec);
      break;
    case "summary":
      renderSummary(context, slide, spec);
      break;
    case "evidence":
      renderEvidenceLayout(context, slide, spec);
      break;
    case "matrix":
      renderMatrixLayout(context, slide, spec);
      break;
    case "timeline":
      renderTimelineLayout(context, slide, spec);
      break;
    case "gallery":
      renderGalleryLayout(context, slide, spec);
      break;
    case "ablation":
      renderAblationLayout(context, slide, spec);
      break;
    case "conclusion":
      renderConclusionLayout(context, slide, spec);
      break;
  }
  if (spec.source) {
    addText(
      slide,
      spec.source,
      { x: CONTENT_LEFT, y: BODY_BOTTOM + 0.08, w: 10.25, h: 0.18 },
      { fontSize: 8, color: context.palette.muted, italic: true },
    );
  }
  addFooter(context, slide, spec, index + 2);
  addNotes(deckSpec, slide, spec);
}

export function createRenderContext(
  presentation: PptxGenJS,
  palette: ThemePalette,
  blueprint: PresentationThemeBlueprint,
  spec: RenderablePresentationRequest,
): RenderContext {
  const labels = resolvePresentationRendererLabels(spec.language);
  const sections = Array.from(
    new Set(
      spec.slides
        .map(
          (slide) =>
            slide.section?.trim() || defaultSectionForSlide(slide, labels),
        )
        .filter((section): section is string => Boolean(section)),
    ),
  );
  return {
    presentation,
    palette,
    blueprint,
    sections,
    slideCount: spec.slides.length + 1,
    labels,
  };
}

function defaultSectionForSlide(
  slide: RenderablePresentationSlide,
  labels?: PresentationRendererLabels,
): string | undefined {
  const sectionLabels = labels || resolvePresentationRendererLabels("en-US");
  switch (resolveLayout(slide, 0)) {
    case "comparison":
      return sectionLabels.sections.problem;
    case "process":
      return sectionLabels.sections.method;
    case "gallery":
    case "figure":
    case "evidence":
      return sectionLabels.sections.evidence;
    case "data":
    case "ablation":
      return sectionLabels.sections.results;
    case "matrix":
      return sectionLabels.sections.framework;
    case "timeline":
      return sectionLabels.sections.progress;
    case "conclusion":
    case "summary":
      return sectionLabels.sections.conclusion;
    case "statement":
    case "split":
      return undefined;
  }
}

export function assertWideCanvas(): void {
  if (SLIDE_WIDTH !== 13.333 || SLIDE_HEIGHT !== 7.5) {
    throw new Error("PaperChat presentation design requires a 16:9 canvas.");
  }
}
