import PptxGenJS from "pptxgenjs";
import type {
  RenderablePresentationSlide,
  ResolvedPresentationFigure,
} from "../PresentationSchema";
import { isAcademicPresentationDesignSystem } from "../PresentationLaunchSettings";
import {
  BODY_FONT,
  chartColorsForSlide,
  MONO_FONT,
  TITLE_FONT,
  type ThemePalette,
} from "./PresentationDesignSystem";
import type { PresentationThemeBlueprint } from "./PresentationThemeBlueprint";
import {
  planAblationScene,
  planGalleryScene,
  planTableFigureEvidenceScene,
  planTableFigureInterpretationScene,
  type SceneBox,
} from "./PresentationScenePlanner";
import { resolvePresentationTableLayout } from "./PresentationTableLayout";
import {
  estimateTextBoxHeight,
  layoutFigureCaption,
  layoutTimelineColumns,
  protectPresentationQuantities,
  protectPresentationVisibleText,
  resolveChartTextLayout,
} from "./PresentationTextLayout";
import {
  isOpenQuestionsLabel,
  type PresentationRendererLabels,
} from "./PresentationLocalization";
import { nextPresentationAnimationObjectName } from "./PresentationAnimationNames";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function sceneBox(box: SceneBox): Box {
  return box;
}

function visibleText(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'");
}

export interface AdvancedRenderContext {
  presentation: PptxGenJS;
  palette: ThemePalette;
  blueprint: PresentationThemeBlueprint;
  labels: PresentationRendererLabels;
}

type EvidenceItem =
  | { kind: "figure"; figure: ResolvedPresentationFigure }
  | { kind: "chart"; chart: NonNullable<RenderablePresentationSlide["chart"]> }
  | { kind: "table"; table: NonNullable<RenderablePresentationSlide["table"]> }
  | {
      kind: "matrix";
      matrix: NonNullable<RenderablePresentationSlide["matrix"]>;
    }
  | {
      kind: "equation";
      equation: NonNullable<RenderablePresentationSlide["equation"]>;
    }
  | {
      kind: "metrics";
      metrics: NonNullable<RenderablePresentationSlide["metrics"]>;
    };

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
    fit: "shrink",
    breakLine: false,
    ...options,
  });
}

function addRule(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  box: Box,
  color: string,
  width = 1,
): void {
  slide.addShape(context.presentation.ShapeType.line, {
    ...box,
    line: { color, width },
  });
}

function addGroupedNarrative(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
  box: Box,
): void {
  const { palette, presentation } = context;
  let cursorY = box.y;
  if (spec.keyMessage) {
    addRule(
      context,
      slide,
      { x: box.x, y: cursorY, w: Math.min(1.2, box.w), h: 0 },
      palette.accent,
      2.2,
    );
    const messageFontSize = Array.from(spec.keyMessage).length > 75 ? 15.5 : 18;
    const messageHeight = Math.min(
      2.35,
      Math.max(
        0.68,
        0.26 + estimateTextBoxHeight(spec.keyMessage, box.w, messageFontSize),
      ),
    );
    addText(
      slide,
      spec.keyMessage,
      { x: box.x, y: cursorY + 0.17, w: box.w, h: messageHeight },
      {
        fontFace: TITLE_FONT,
        fontSize: messageFontSize,
        bold: false,
        color: palette.accentDark,
        valign: "top",
        objectName: nextPresentationAnimationObjectName(slide, "key-message"),
      },
    );
    cursorY += messageHeight + 0.38;
  }

  const groups = spec.groups?.length
    ? spec.groups
    : spec.bullets?.length
      ? [{ title: context.labels.evidence, bullets: spec.bullets }]
      : [];
  const availableHeight = Math.max(0.6, box.y + box.h - cursorY);
  const groupGap = 0.14;
  // CJK mixed with equations and Latin tokens wraps much earlier in
  // LibreOffice/PowerPoint than a raw character count suggests. Reserve a
  // conservative line height so adjacent narrative boxes never collide.
  const desiredBulletHeights = groups.map((group) =>
    group.bullets.map((bullet) =>
      Math.max(0.32, estimateTextBoxHeight(bullet, box.w - 0.2, 13.2) + 0.15),
    ),
  );
  const desiredHeights = groups.map(
    (_group, groupIndex) =>
      0.36 +
      desiredBulletHeights[groupIndex].reduce(
        (height, bulletHeight) => height + bulletHeight,
        0,
      ),
  );
  const desiredTotal =
    desiredHeights.reduce((total, height) => total + height, 0) +
    groupGap * Math.max(0, groups.length - 1);
  const scale = Math.min(1, availableHeight / Math.max(0.1, desiredTotal));
  const groupTitleFontSize = Math.max(13.5, 15.5 * scale);
  const bulletFontSize = Math.max(11.5, 13.2 * Math.min(1, scale + 0.08));

  groups.forEach((group, groupIndex) => {
    const groupY = cursorY;
    const titleHeight = Math.max(0.24, 0.32 * scale);
    addText(
      slide,
      group.title,
      { x: box.x + 0.2, y: groupY, w: box.w - 0.2, h: titleHeight },
      {
        fontFace: TITLE_FONT,
        fontSize: groupTitleFontSize,
        bold: true,
        color: palette.text,
      },
    );
    slide.addShape(presentation.ShapeType.rect, {
      x: box.x,
      y: groupY + 0.08,
      w: 0.08,
      h: 0.08,
      line: { color: palette.accent, transparency: 100 },
      fill: { color: palette.accent },
    });
    cursorY += titleHeight + Math.max(0.08, 0.1 * scale);
    group.bullets.forEach((bullet, bulletIndex) => {
      const bulletHeight =
        desiredBulletHeights[groupIndex][bulletIndex] * scale;
      const bulletY = cursorY;
      slide.addShape(presentation.ShapeType.rect, {
        x: box.x + 0.04,
        y: bulletY + 0.09,
        w: 0.045,
        h: 0.045,
        line: { color: palette.accent, transparency: 100 },
        fill: { color: palette.accent },
      });
      addText(
        slide,
        bullet,
        { x: box.x + 0.2, y: bulletY, w: box.w - 0.2, h: bulletHeight },
        {
          fontSize: bulletFontSize,
          color: palette.text,
          valign: "top",
        },
      );
      cursorY += bulletHeight;
    });
    if (groupIndex < groups.length - 1) cursorY += groupGap * scale;
  });
}

function figureBox(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  figure: ResolvedPresentationFigure,
  box: Box,
): void {
  const { palette } = context;
  const sourceCaption = figure.caption || figure.captionHint;
  const caption = sourceCaption
    ? layoutFigureCaption(sourceCaption, box.w)
    : undefined;
  const captionHeight = caption?.height || 0;
  const imageArea = { ...box, h: box.h - captionHeight };
  const imageAspect = figure.pixelWidth / figure.pixelHeight;
  const boxAspect = imageArea.w / imageArea.h;
  const imageBox = { ...imageArea };
  if (imageAspect > boxAspect) {
    imageBox.h = imageArea.w / imageAspect;
    imageBox.y += (imageArea.h - imageBox.h) / 2;
  } else {
    imageBox.w = imageArea.h * imageAspect;
    imageBox.x += (imageArea.w - imageBox.w) / 2;
  }
  slide.addShape(context.presentation.ShapeType.rect, {
    ...imageBox,
    line: { color: palette.border, width: 0.75 },
    fill: { color: palette.paper },
  });
  slide.addImage({
    data: String(figure.data),
    ...imageBox,
    altText: sourceCaption || `PDF page ${figure.page}`,
    objectName: nextPresentationAnimationObjectName(slide, "evidence-visual"),
  });
  if (caption) {
    addText(
      slide,
      caption.text,
      {
        x: box.x,
        y: box.y + box.h - caption.height + 0.04,
        w: box.w,
        h: caption.height - 0.04,
      },
      { fontSize: 10.2, color: palette.muted, italic: true, valign: "top" },
    );
  }
}

function addChart(
  context: AdvancedRenderContext,
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
      fontSize: 10.5,
      catAxisLabelFontFace: BODY_FONT,
      catAxisLabelFontSize: chartTextLayout.catAxisLabelFontSize,
      catAxisLabelColor: chartMutedColor,
      catAxisLineColor: chartBorderColor,
      valAxisLabelFontFace: BODY_FONT,
      valAxisLabelFontSize: 9.5,
      valAxisLabelColor: chartMutedColor,
      valAxisLineColor: chartBorderColor,
      catAxisTitle: chart.xAxisTitle,
      valAxisTitle: chart.yAxisTitle,
      catAxisTitleFontSize: 9.5,
      valAxisTitleFontSize: 9.5,
      // A direct, editable legend is placed above grouped charts. This avoids
      // PowerPoint/LibreOffice differences that can clip the native legend
      // when the plot uses a manual layout.
      showLegend: false,
      legendPos: "b",
      legendFontFace: BODY_FONT,
      legendFontSize: 9,
      showTitle: Boolean(chart.title),
      title: chart.title,
      titleFontFace: TITLE_FONT,
      titleFontSize: 13.5,
      titleColor: chartTextColor,
      dataLabelColor: chartTextColor,
      // Small grouped comparisons are evidence, not decoration. Direct values
      // keep each series verifiable without forcing the audience to estimate
      // from gridlines or repeatedly scan a distant legend.
      showValue: showEditableValues,
      barDir: chart.orientation === "horizontal" ? "bar" : "col",
      dataLabelPosition: "outEnd",
      dataLabelFormatCode: "0.0#",
      chartColors: seriesColors,
      objectName: nextPresentationAnimationObjectName(slide, "chart"),
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
      valGridLine: { color: chartBorderColor, size: 0.6 },
      layout: chartTextLayout.layout,
    },
  );
}

function addTable(
  context: AdvancedRenderContext,
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
  const academic = isAcademicPresentationDesignSystem(context.blueprint.id);
  const noBorder: PptxGenJS.BorderProps = {
    type: "none",
    color: palette.background,
    pt: 0,
  };
  const headerBorder: [
    PptxGenJS.BorderProps,
    PptxGenJS.BorderProps,
    PptxGenJS.BorderProps,
    PptxGenJS.BorderProps,
  ] = academic
    ? [
        { type: "solid", color: palette.text, pt: 1.1 },
        noBorder,
        { type: "solid", color: palette.border, pt: 0.7 },
        noBorder,
      ]
    : (Array(4).fill({
        type: "solid",
        color: palette.border,
        pt: 0.45,
      }) as [
        PptxGenJS.BorderProps,
        PptxGenJS.BorderProps,
        PptxGenJS.BorderProps,
        PptxGenJS.BorderProps,
      ]);
  const rows: PptxGenJS.TableRow[] = [
    table.headers.map((text) => ({
      text,
      options: {
        bold: true,
        color: palette.text,
        fill: {
          color: academic ? palette.background : palette.frameworkSoft,
        },
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
          border: academic
            ? ([
                noBorder,
                noBorder,
                {
                  type: "solid",
                  color:
                    rowIndex === table.rows.length - 1
                      ? palette.text
                      : palette.border,
                  pt: rowIndex === table.rows.length - 1 ? 1.1 : 0.35,
                },
                noBorder,
              ] as [
                PptxGenJS.BorderProps,
                PptxGenJS.BorderProps,
                PptxGenJS.BorderProps,
                PptxGenJS.BorderProps,
              ])
            : undefined,
        },
      })),
    ),
  ];
  slide.addTable(rows, {
    ...box,
    color: palette.text,
    fill: { color: palette.background },
    border: academic
      ? { type: "none", color: palette.background, pt: 0 }
      : { type: "solid", color: palette.border, pt: 0.45 },
    fontFace: BODY_FONT,
    fontSize: tableLayout.fontSize,
    margin: tableLayout.margin,
    rowH: tableLayout.rowHeight,
    valign: "middle",
  });
}

function addEquation(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  equation: NonNullable<RenderablePresentationSlide["equation"]>,
  box: Box,
): void {
  const { palette } = context;
  addRule(
    context,
    slide,
    { x: box.x, y: box.y + 0.08, w: box.w, h: 0 },
    palette.border,
    0.8,
  );
  if (equation.label) {
    addText(
      slide,
      equation.label.toLocaleUpperCase(),
      { x: box.x, y: box.y + 0.2, w: box.w, h: 0.22 },
      {
        fontFace: MONO_FONT,
        fontSize: 8.2,
        bold: true,
        color: palette.accentDark,
        charSpacing: 1,
      },
    );
  }
  addText(
    slide,
    equation.expression,
    { x: box.x + 0.1, y: box.y + 0.55, w: box.w - 0.2, h: box.h * 0.45 },
    {
      fontFace: "Cambria Math",
      fontSize: Array.from(equation.expression).length > 70 ? 17 : 21,
      color: palette.text,
      align: "center",
      valign: "middle",
    },
  );
  if (equation.explanation) {
    addText(
      slide,
      equation.explanation,
      {
        x: box.x + 0.12,
        y: box.y + box.h * 0.7,
        w: box.w - 0.24,
        h: box.h * 0.25,
      },
      { fontSize: 9.2, color: palette.muted, align: "center" },
    );
  }
}

function addMetrics(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  metrics: NonNullable<RenderablePresentationSlide["metrics"]>,
  box: Box,
): void {
  const { palette } = context;
  const width = box.w / metrics.length;
  const compact = box.h < 0.95;
  const valueFontSize = Math.min(
    compact ? 19 : 26,
    width < 0.98 ? 14.5 : width < 1.3 ? 18 : width < 1.7 ? 21 : 26,
  );
  const labelFontSize = width < 0.98 ? 8 : width < 1.3 ? 9 : 10.2;
  addRule(
    context,
    slide,
    { x: box.x, y: box.y + 0.05, w: box.w, h: 0 },
    palette.border,
    0.8,
  );
  metrics.forEach((metric, index) => {
    const x = box.x + index * width;
    addText(
      slide,
      metric.value.replace(/\s+/g, "\u00a0"),
      {
        x: x + 0.06,
        y: box.y + (compact ? 0.16 : 0.22),
        w: width - 0.12,
        h: compact ? 0.26 : 0.48,
      },
      {
        fontFace: TITLE_FONT,
        fontSize: valueFontSize,
        bold: true,
        color: index === 0 ? palette.accentDark : palette.text,
        align: "center",
      },
    );
    addText(
      slide,
      metric.label,
      {
        x: x + 0.06,
        y: box.y + (compact ? 0.43 : 0.78),
        w: width - 0.12,
        h: compact ? 0.18 : 0.44,
      },
      {
        fontSize: labelFontSize,
        bold: true,
        color: palette.text,
        align: "center",
        valign: "top",
      },
    );
    if (metric.detail && !compact) {
      addText(
        slide,
        metric.detail,
        { x: x + 0.06, y: box.y + 1.2, w: width - 0.12, h: 0.32 },
        {
          fontSize: Math.max(6.8, labelFontSize - 1),
          color: palette.muted,
          align: "center",
        },
      );
    }
  });
}

function gridBoxes(box: Box, count: number): Box[] {
  if (count <= 1) return [box];
  const gap = 0.18;
  if (count === 2) {
    const width = (box.w - gap) / 2;
    return [
      { x: box.x, y: box.y, w: width, h: box.h },
      { x: box.x + width + gap, y: box.y, w: width, h: box.h },
    ];
  }
  if (count === 3) {
    const mainWidth = box.w * 0.62;
    const sideWidth = box.w - mainWidth - gap;
    const sideHeight = (box.h - gap) / 2;
    return [
      { x: box.x, y: box.y, w: mainWidth, h: box.h },
      { x: box.x + mainWidth + gap, y: box.y, w: sideWidth, h: sideHeight },
      {
        x: box.x + mainWidth + gap,
        y: box.y + sideHeight + gap,
        w: sideWidth,
        h: sideHeight,
      },
    ];
  }
  const columns = count > 4 ? 3 : 2;
  const rows = Math.ceil(count / columns);
  const width = (box.w - gap * (columns - 1)) / columns;
  const height = (box.h - gap * (rows - 1)) / rows;
  return Array.from({ length: count }, (_, index) => ({
    x: box.x + (index % columns) * (width + gap),
    y: box.y + Math.floor(index / columns) * (height + gap),
    w: width,
    h: height,
  }));
}

function editorialEvidenceBoxes(
  items: readonly EvidenceItem[],
  box: Box,
): Box[] {
  if (items.length !== 2) return gridBoxes(box, items.length);
  const bothFigures = items.every((item) => item.kind === "figure");
  if (bothFigures) return gridBoxes(box, items.length);
  const gap = 0.22;
  const dominantWidth = box.w * 0.64;
  return [
    { x: box.x, y: box.y, w: dominantWidth, h: box.h },
    {
      x: box.x + dominantWidth + gap,
      y: box.y,
      w: box.w - dominantWidth - gap,
      h: box.h,
    },
  ];
}

function evidenceItems(spec: RenderablePresentationSlide): EvidenceItem[] {
  const figures = [
    ...(spec.figure ? [spec.figure] : []),
    ...(spec.figures || []),
  ];
  return [
    ...(spec.chart ? [{ kind: "chart" as const, chart: spec.chart }] : []),
    ...(spec.table ? [{ kind: "table" as const, table: spec.table }] : []),
    ...(spec.matrix ? [{ kind: "matrix" as const, matrix: spec.matrix }] : []),
    ...figures.map((figure) => ({ kind: "figure" as const, figure })),
    ...(spec.equation
      ? [{ kind: "equation" as const, equation: spec.equation }]
      : []),
    ...(spec.metrics?.length
      ? [{ kind: "metrics" as const, metrics: spec.metrics }]
      : []),
  ];
}

function renderEvidenceItem(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  item: EvidenceItem,
  box: Box,
): void {
  switch (item.kind) {
    case "figure":
      figureBox(context, slide, item.figure, box);
      return;
    case "chart":
      addChart(context, slide, item.chart, box);
      return;
    case "table":
      addTable(context, slide, item.table, box);
      return;
    case "matrix":
      addMatrixBlock(context, slide, item.matrix, box, { compact: true });
      return;
    case "equation":
      addEquation(context, slide, item.equation, box);
      return;
    case "metrics":
      addMetrics(context, slide, item.metrics, box);
  }
}

function addCallouts(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
  box: Box,
): void {
  if (!spec.callouts?.length) return;
  const { palette, presentation } = context;
  const gap = 0.12;
  const charactersPerLine = Math.max(20, Math.floor((box.w - 0.24) * 10));
  const desiredHeights = spec.callouts.map((callout) => {
    const lines = Math.max(
      1,
      Math.ceil(Array.from(callout.text).length / charactersPerLine),
    );
    return (callout.label ? 0.42 : 0.2) + lines * 0.23 + 0.14;
  });
  const desiredTotal =
    desiredHeights.reduce((total, height) => total + height, 0) +
    gap * (spec.callouts.length - 1);
  const scale = Math.min(1, box.h / Math.max(0.1, desiredTotal));
  let cursorY = box.y;
  spec.callouts.forEach((callout, index) => {
    const height = desiredHeights[index] * scale;
    const y = cursorY;
    const toneColor =
      callout.tone === "risk"
        ? palette.danger
        : callout.tone === "focus"
          ? palette.focus
          : callout.tone === "neutral"
            ? palette.muted
            : palette.accent;
    slide.addShape(presentation.ShapeType.line, {
      x: box.x,
      y,
      w: Math.min(0.72, box.w),
      h: 0,
      line: { color: toneColor, width: 1.6 },
    });
    if (callout.label) {
      addText(
        slide,
        callout.label.toLocaleUpperCase(),
        { x: box.x, y: y + 0.12, w: box.w, h: 0.18 },
        {
          fontFace: MONO_FONT,
          fontSize: 7.5,
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
        y: y + (callout.label ? 0.34 : 0.14),
        w: box.w,
        h: height - (callout.label ? 0.4 : 0.2),
      },
      {
        fontSize: Math.max(10.2, 11.2 * scale),
        color: palette.text,
        valign: "top",
      },
    );
    cursorY += height + gap * scale;
  });
}

function desiredCalloutsHeight(
  spec: RenderablePresentationSlide,
  width: number,
): number {
  if (!spec.callouts?.length) return 0;
  const gap = 0.12;
  const charactersPerLine = Math.max(20, Math.floor((width - 0.24) * 10));
  return (
    spec.callouts.reduce((total, callout) => {
      const lines = Math.max(
        1,
        Math.ceil(Array.from(callout.text).length / charactersPerLine),
      );
      return total + (callout.label ? 0.42 : 0.2) + lines * 0.23 + 0.14;
    }, 0) +
    gap * (spec.callouts.length - 1)
  );
}

function galleryInsightTexts(spec: RenderablePresentationSlide): string[] {
  const texts: string[] = [];
  if (spec.keyMessage) texts.push(spec.keyMessage);
  if (spec.groups?.length) {
    texts.push(
      ...spec.groups.map((group) =>
        [group.title, ...group.bullets].filter(Boolean).join("\n"),
      ),
    );
  } else if (spec.bullets?.length) {
    texts.push(...spec.bullets);
  }
  if (spec.callouts?.length) {
    texts.push(
      ...spec.callouts.map((callout) =>
        [callout.label, callout.text].filter(Boolean).join("\n"),
      ),
    );
  }
  return texts;
}

function addGalleryInsights(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
  boxes: readonly SceneBox[],
): void {
  const texts = galleryInsightTexts(spec);
  if (!texts.length || !boxes.length) return;
  if (texts.length === 1) {
    const left = boxes[0].x;
    const right = boxes[boxes.length - 1].x + boxes[boxes.length - 1].w;
    const y = Math.min(...boxes.map((box) => box.y));
    const h = Math.min(...boxes.map((box) => box.h));
    addRule(
      context,
      slide,
      { x: left, y, w: Math.min(1.3, right - left), h: 0 },
      context.palette.accent,
      2.2,
    );
    addText(
      slide,
      texts[0],
      { x: left, y: y + 0.16, w: right - left, h: Math.max(0.3, h - 0.16) },
      {
        fontFace: TITLE_FONT,
        fontSize: Array.from(texts[0]).length > 150 ? 13.5 : 16,
        bold: false,
        color: context.palette.accentDark,
        valign: "top",
        breakLine: true,
      },
    );
    return;
  }
  const buckets = Array.from({ length: boxes.length }, () => [] as string[]);
  texts.forEach((text, index) => buckets[index % buckets.length].push(text));
  buckets.forEach((parts, index) => {
    if (!parts.length) return;
    const box = boxes[index];
    slide.addShape(context.presentation.ShapeType.rect, {
      x: box.x,
      y: box.y + 0.05,
      w: 0.07,
      h: 0.07,
      line: { color: context.palette.accent, transparency: 100 },
      fill: { color: context.palette.accent },
    });
    addText(
      slide,
      parts.join("\n"),
      {
        x: box.x + 0.19,
        y: box.y,
        w: box.w - 0.19,
        h: box.h,
      },
      {
        fontSize: parts.join(" ").length > 260 ? 10.8 : 12.5,
        color: context.palette.text,
        valign: "top",
        breakLine: true,
      },
    );
  });
}

function addMatrixBlock(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  matrix: NonNullable<RenderablePresentationSlide["matrix"]>,
  box: Box,
  options?: { compact?: boolean },
): void {
  const { palette, presentation } = context;
  const compact = Boolean(options?.compact);
  const darkEditorial = context.blueprint.id === "dark-editorial";
  const bannerHeight = matrix.banner ? (compact ? 0.46 : 0.58) : 0;
  if (matrix.banner) {
    slide.addShape(presentation.ShapeType.rect, {
      x: box.x,
      y: box.y,
      w: box.w,
      h: bannerHeight,
      line: { color: palette.border, width: 0.65 },
      fill: { color: palette.frameworkSoft },
    });
    slide.addShape(presentation.ShapeType.rect, {
      x: box.x + 0.18,
      y: box.y + (compact ? 0.11 : 0.13),
      w: compact ? 0.07 : 0.08,
      h: compact ? 0.22 : 0.28,
      line: { color: palette.accent, transparency: 100 },
      fill: { color: palette.accent },
    });
    addText(
      slide,
      matrix.banner,
      {
        x: box.x + (compact ? 0.42 : 0.5),
        y: box.y + (compact ? 0.11 : 0.14),
        w: box.w - (compact ? 0.62 : 0.72),
        h: compact ? 0.22 : 0.26,
      },
      {
        fontFace: TITLE_FONT,
        fontSize: compact ? 10.8 : 13.5,
        bold: true,
        color: palette.accentDark,
        align: "left",
      },
    );
  }

  const rows: PptxGenJS.TableRow[] = [
    [
      { text: "", options: { fill: { color: palette.background } } },
      ...matrix.columns.map((column, columnIndex) => ({
        text: column,
        options: {
          bold: true,
          color: palette.text,
          fill: {
            color:
              columnIndex === matrix.highlightColumn
                ? palette.accentSoft
                : palette.frameworkSoft,
          },
          align: "center" as const,
        },
      })),
    ],
    ...matrix.rows.map((row) => [
      {
        text: row.label,
        options: {
          bold: true,
          color: palette.text,
          fill: {
            color: darkEditorial ? palette.frameworkSoft : "E8ECEF",
          },
        },
      },
      ...row.cells.map((cell, columnIndex) => ({
        text: cell,
        options: {
          color: palette.text,
          fill: {
            color:
              columnIndex === matrix.highlightColumn
                ? palette.accentSoft
                : palette.background,
          },
          align: "center" as const,
        },
      })),
    ]),
  ];
  const tableY = box.y + bannerHeight + (bannerHeight ? 0.16 : 0);
  const tableHeight = box.h - bannerHeight - (bannerHeight ? 0.16 : 0);
  const labelColumnWidth = compact
    ? Math.min(1.72, box.w * 0.2)
    : Math.min(1.95, box.w * 0.22);
  const dataColumnWidth =
    (box.w - labelColumnWidth) / Math.max(1, matrix.columns.length);
  slide.addTable(rows, {
    x: box.x,
    y: tableY,
    w: box.w,
    h: tableHeight,
    colW: [labelColumnWidth, ...matrix.columns.map(() => dataColumnWidth)],
    border: { type: "solid", color: palette.border, pt: 0.45 },
    fontFace: BODY_FONT,
    fontSize: compact
      ? matrix.columns.length >= 4
        ? 8.2
        : 9
      : matrix.columns.length >= 5
        ? 9.5
        : 10.5,
    margin: compact ? 0.045 : 0.07,
    valign: "middle",
    rowH: Math.min(compact ? 0.76 : 0.7, tableHeight / rows.length),
  });
}

function addConclusionMatrixBlock(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  matrix: NonNullable<RenderablePresentationSlide["matrix"]>,
  box: Box,
  options?: { showRowLabels?: boolean },
): void {
  const { palette } = context;
  const columns = matrix.columns;
  const rows = matrix.rows;
  const showRowLabels = options?.showRowLabels !== false;
  const titleHeight = matrix.banner ? 0.66 : 0.28;
  const headerY = box.y + titleHeight;
  const headerHeight = 0.38;
  const bodyY = headerY + headerHeight;
  const rowHeight = (box.y + box.h - bodyY) / Math.max(1, rows.length);
  const gutterWidth = showRowLabels
    ? Math.min(1.28, Math.max(0.96, box.w * 0.15))
    : 0.34;
  const columnWidth = (box.w - gutterWidth) / Math.max(1, columns.length);

  addRule(
    context,
    slide,
    { x: box.x, y: box.y, w: box.w, h: 0 },
    palette.border,
    0.8,
  );
  addText(
    slide,
    context.labels.openQuestions,
    { x: box.x, y: box.y + 0.13, w: 1.5, h: 0.18 },
    {
      fontFace: MONO_FONT,
      fontSize: 7.8,
      bold: true,
      color: palette.accentDark,
      charSpacing: 0.9,
    },
  );
  if (matrix.banner) {
    addText(
      slide,
      matrix.banner,
      { x: box.x + 1.56, y: box.y + 0.08, w: box.w - 1.56, h: 0.34 },
      {
        fontFace: TITLE_FONT,
        fontSize: Array.from(matrix.banner).length > 70 ? 10.2 : 11.8,
        bold: true,
        color: palette.text,
        align: "right",
      },
    );
  }

  columns.forEach((column, columnIndex) => {
    const x = box.x + gutterWidth + columnIndex * columnWidth;
    if (columnIndex > 0) {
      addRule(
        context,
        slide,
        { x, y: headerY, w: 0, h: box.y + box.h - headerY },
        palette.border,
        0.45,
      );
    }
    if (columnIndex === matrix.highlightColumn) {
      addRule(
        context,
        slide,
        { x: x + 0.12, y: headerY + 0.02, w: columnWidth - 0.24, h: 0 },
        palette.accent,
        1.8,
      );
    }
    addText(
      slide,
      column.toLocaleUpperCase(),
      { x: x + 0.12, y: headerY + 0.12, w: columnWidth - 0.24, h: 0.16 },
      {
        fontFace: MONO_FONT,
        fontSize: 7.6,
        bold: true,
        color:
          columnIndex === matrix.highlightColumn
            ? palette.accentDark
            : palette.muted,
        align: "left",
        charSpacing: 0.65,
      },
    );
  });
  addRule(
    context,
    slide,
    { x: box.x, y: bodyY, w: box.w, h: 0 },
    palette.border,
    0.55,
  );

  rows.forEach((row, rowIndex) => {
    const y = bodyY + rowIndex * rowHeight;
    addText(
      slide,
      String(rowIndex + 1).padStart(2, "0"),
      { x: box.x, y: y + 0.14, w: 0.24, h: 0.16 },
      {
        fontFace: MONO_FONT,
        fontSize: 7.2,
        bold: true,
        color: palette.accent,
        align: "left",
      },
    );
    if (showRowLabels) {
      addText(
        slide,
        row.label,
        {
          x: box.x + 0.31,
          y: y + 0.11,
          w: gutterWidth - 0.39,
          h: Math.max(0.34, rowHeight - 0.2),
        },
        {
          fontFace: TITLE_FONT,
          fontSize: Array.from(row.label).length > 24 ? 8.1 : 9,
          bold: true,
          color: palette.text,
          valign: "top",
        },
      );
    }
    row.cells.forEach((cell, columnIndex) => {
      const x = box.x + gutterWidth + columnIndex * columnWidth;
      addText(
        slide,
        cell,
        {
          x: x + 0.12,
          y: y + 0.11,
          w: columnWidth - 0.24,
          h: Math.max(0.34, rowHeight - 0.2),
        },
        {
          fontSize:
            columns.length >= 5 ? 7.2 : Array.from(cell).length > 72 ? 8 : 8.8,
          color: palette.text,
          valign: "top",
          breakLine: true,
        },
      );
    });
    if (rowIndex < rows.length - 1) {
      addRule(
        context,
        slide,
        { x: box.x, y: y + rowHeight, w: box.w, h: 0 },
        palette.border,
        0.4,
      );
    }
  });
}

export function renderEvidenceLayout(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  const items = evidenceItems(spec).slice(0, 6);
  const tableIndex = items.findIndex((item) => item.kind === "table");
  const supportingFigureIndex = items.findIndex(
    (item) => item.kind === "figure",
  );
  const usesAcademicTableFigureInterpretation = Boolean(
    context.blueprint.id !== "dark-editorial" &&
    items.length === 2 &&
    tableIndex >= 0 &&
    supportingFigureIndex >= 0 &&
    (spec.keyMessage ||
      spec.groups?.length ||
      spec.bullets?.length ||
      spec.callouts?.length),
  );

  if (usesAcademicTableFigureInterpretation) {
    const tableItem = items[tableIndex];
    const figureItem = items[supportingFigureIndex];
    if (tableItem.kind !== "table" || figureItem.kind !== "figure") {
      throw new Error("Academic table/figure scene could not be resolved.");
    }
    const scene = planTableFigureInterpretationScene(
      { x: 0.72, y: 1.68, w: 11.94, h: 4.78 },
      figureItem.figure.pixelWidth / Math.max(1, figureItem.figure.pixelHeight),
    );
    addTable(context, slide, tableItem.table, sceneBox(scene.tableBox));
    if (spec.keyMessage || spec.groups?.length || spec.bullets?.length) {
      addGroupedNarrative(context, slide, spec, sceneBox(scene.narrativeBox));
    } else {
      addCallouts(context, slide, spec, sceneBox(scene.narrativeBox));
    }
    figureBox(context, slide, figureItem.figure, sceneBox(scene.figureBox));
    return;
  }

  const usesAcademicTableInterpretation = Boolean(
    context.blueprint.id !== "dark-editorial" &&
    items.length === 1 &&
    tableIndex === 0 &&
    (spec.keyMessage ||
      spec.groups?.length ||
      spec.bullets?.length ||
      spec.callouts?.length),
  );
  if (usesAcademicTableInterpretation) {
    const tableItem = items[0];
    if (tableItem.kind !== "table") {
      throw new Error("Academic table interpretation could not be resolved.");
    }
    const tableBox: Box = { x: 0.72, y: 1.68, w: 11.94, h: 3.52 };
    const interpretationBox: Box = {
      x: 0.72,
      y: 5.42,
      w: 11.94,
      h: 1.02,
    };
    addTable(context, slide, tableItem.table, tableBox);
    if (spec.keyMessage || spec.groups?.length || spec.bullets?.length) {
      addGroupedNarrative(context, slide, spec, interpretationBox);
    } else {
      addCallouts(context, slide, spec, interpretationBox);
    }
    return;
  }

  const hasNarrative = Boolean(
    spec.keyMessage ||
    spec.groups?.length ||
    spec.bullets?.length ||
    spec.callouts?.length,
  );
  const narrativeDensity =
    (spec.groups || []).reduce(
      (total, group) => total + 1 + group.bullets.length,
      0,
    ) + (spec.keyMessage ? 2 : 0);
  const dominantEvidence =
    spec.visualTuning?.figureEmphasis === "dominant" ||
    context.blueprint.id === "dark-editorial";
  const narrativeWidth = dominantEvidence
    ? context.blueprint.evidence.narrativeWidth
    : narrativeDensity >= 6
      ? 4.18
      : 3.46;
  const narrativeBox: Box = {
    x: 0.72,
    y: 1.68,
    w: narrativeWidth,
    h: 4.72,
  };
  const evidenceX =
    narrativeBox.x +
    narrativeBox.w +
    (dominantEvidence ? context.blueprint.evidence.gap : 0.34);
  const evidenceBox: Box = hasNarrative
    ? { x: evidenceX, y: 1.68, w: 12.66 - evidenceX, h: 4.78 }
    : { x: 0.72, y: 1.68, w: 11.94, h: 4.78 };
  if (hasNarrative) {
    const calloutHeight = spec.callouts?.length
      ? Math.min(
          1.58,
          Math.max(0.9, desiredCalloutsHeight(spec, narrativeBox.w)),
        )
      : 0;
    addGroupedNarrative(context, slide, spec, {
      ...narrativeBox,
      h: narrativeBox.h - calloutHeight - (calloutHeight ? 0.16 : 0),
    });
    if (spec.callouts?.length) {
      addCallouts(context, slide, spec, {
        x: narrativeBox.x,
        y: narrativeBox.y + narrativeBox.h - calloutHeight,
        w: narrativeBox.w,
        h: calloutHeight,
      });
    }
  }
  const wideFigureIndex = items.findIndex(
    (item) =>
      item.kind === "figure" &&
      item.figure.pixelWidth / item.figure.pixelHeight > 4,
  );
  let orderedItems = items;
  let boxes: Box[];
  if (items.length === 2 && tableIndex >= 0 && supportingFigureIndex >= 0) {
    const tableItem = items[tableIndex];
    const figureItem = items[supportingFigureIndex];
    if (tableItem.kind !== "table" || figureItem.kind !== "figure") {
      throw new Error("Table/figure evidence pair could not be resolved.");
    }
    orderedItems = [tableItem, figureItem];
    const scene = planTableFigureEvidenceScene(
      evidenceBox,
      figureItem.figure.pixelWidth / Math.max(1, figureItem.figure.pixelHeight),
    );
    boxes = [scene.tableBox, scene.figureBox];
  } else if (wideFigureIndex >= 0 && items.length > 1) {
    orderedItems = [
      items[wideFigureIndex],
      ...items.filter((_, index) => index !== wideFigureIndex),
    ];
    const bannerHeight = Math.min(1.52, evidenceBox.h * 0.32);
    boxes = [
      { ...evidenceBox, h: bannerHeight },
      ...gridBoxes(
        {
          x: evidenceBox.x,
          y: evidenceBox.y + bannerHeight + 0.18,
          w: evidenceBox.w,
          h: evidenceBox.h - bannerHeight - 0.18,
        },
        items.length - 1,
      ),
    ];
  } else {
    boxes = editorialEvidenceBoxes(items, evidenceBox);
  }
  orderedItems.forEach((item, index) => {
    renderEvidenceItem(context, slide, item, boxes[index]);
  });
}

export function renderGalleryLayout(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  const figures = [
    ...(spec.figure ? [spec.figure] : []),
    ...(spec.figures || []),
  ].slice(0, 6);
  if (figures.length < 2) {
    renderEvidenceLayout(context, slide, spec);
    return;
  }

  const scene = planGalleryScene(figures);
  scene.figureBoxes.forEach((box, index) =>
    figureBox(context, slide, figures[index], sceneBox(box)),
  );
  addGalleryInsights(context, slide, spec, scene.insightBoxes);
}

export function renderAblationLayout(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  const dominant = spec.chart
    ? ({ kind: "chart", chart: spec.chart } as const)
    : spec.table
      ? ({ kind: "table", table: spec.table } as const)
      : spec.matrix
        ? ({ kind: "matrix", matrix: spec.matrix } as const)
        : spec.figure
          ? ({ kind: "figure", figure: spec.figure } as const)
          : spec.figures?.[0]
            ? ({ kind: "figure", figure: spec.figures[0] } as const)
            : undefined;
  if (!dominant) {
    renderEvidenceLayout(context, slide, spec);
    return;
  }

  const supportingFigure =
    dominant.kind === "figure"
      ? spec.figures?.find((figure) => figure !== dominant.figure)
      : spec.figure || spec.figures?.[0];
  const tableWithBottomInterpretation = Boolean(
    dominant.kind === "table" &&
    !supportingFigure &&
    !spec.metrics?.length &&
    !spec.keyMessage &&
    !spec.groups?.length &&
    !spec.bullets?.length &&
    spec.callouts?.length,
  );
  if (tableWithBottomInterpretation) {
    renderEvidenceItem(context, slide, dominant, {
      x: 0.72,
      y: 1.72,
      w: 11.94,
      h: 3.86,
    });
    addCallouts(context, slide, spec, {
      x: 0.72,
      y: 5.76,
      w: 11.94,
      h: 0.72,
    });
    return;
  }
  const scene = planAblationScene(
    Boolean(supportingFigure),
    Boolean(spec.metrics?.length),
    supportingFigure
      ? supportingFigure.pixelWidth / Math.max(1, supportingFigure.pixelHeight)
      : undefined,
  );
  renderEvidenceItem(context, slide, dominant, sceneBox(scene.dominantBox));
  if (supportingFigure && scene.supportingFigureBox) {
    figureBox(
      context,
      slide,
      supportingFigure,
      sceneBox(scene.supportingFigureBox),
    );
  }
  if (spec.metrics?.length && scene.metricsBox) {
    addMetrics(context, slide, spec.metrics, sceneBox(scene.metricsBox));
  }

  const narrativeBox = sceneBox(scene.narrativeBox);
  const hasPrimaryNarrative = Boolean(
    spec.keyMessage || spec.groups?.length || spec.bullets?.length,
  );
  const calloutHeight = spec.callouts?.length
    ? Math.min(
        2.02,
        desiredCalloutsHeight(spec, narrativeBox.w),
        Math.max(0.5, narrativeBox.h - 0.18),
      )
    : 0;
  const groupedNarrativeHeight = hasPrimaryNarrative
    ? Math.max(0, narrativeBox.h - calloutHeight - (calloutHeight ? 0.18 : 0))
    : 0;
  const keyMessageHeight = spec.keyMessage
    ? Math.min(
        1.15,
        Math.max(0.68, 0.3 + Array.from(spec.keyMessage).length / 120),
      )
    : 0;
  const groupSpaceAfterKeyMessage =
    groupedNarrativeHeight - (keyMessageHeight ? keyMessageHeight + 0.38 : 0);
  // Model responses can redundantly supply a key message, grouped findings,
  // metrics, and multiple limitations to the same narrow ablation sidebar.
  // Preserve the conclusion and limitations first; drawing groups into less
  // than one readable line of space causes them to overlap the callout block.
  const narrativeSpec =
    keyMessageHeight && groupSpaceAfterKeyMessage < 0.55
      ? { ...spec, groups: undefined, bullets: undefined }
      : spec;
  if (hasPrimaryNarrative) {
    addGroupedNarrative(context, slide, narrativeSpec, {
      ...narrativeBox,
      h: groupedNarrativeHeight,
    });
  }
  if (calloutHeight) {
    addCallouts(context, slide, spec, {
      x: narrativeBox.x,
      y: hasPrimaryNarrative
        ? narrativeBox.y + narrativeBox.h - calloutHeight
        : narrativeBox.y,
      w: narrativeBox.w,
      h: calloutHeight,
    });
  }
}

export function renderConclusionLayout(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  const { palette, presentation } = context;
  const figure = spec.figure || spec.figures?.[0];
  const matrix = spec.matrix;
  const usesMatrixRowsAsClaims = Boolean(
    matrix && !spec.groups?.length && !spec.bullets?.length,
  );
  const hasOpenQuestions = Boolean(spec.callouts?.length);
  const hasTimeline = Boolean(spec.timeline?.length);
  const groups = spec.groups?.length
    ? spec.groups.slice(0, 3)
    : spec.bullets?.length
      ? spec.bullets.slice(0, 3).map((bullet) => ({
          title: bullet,
          bullets: [] as string[],
        }))
      : (matrix?.rows || []).slice(0, 3).map((row) => ({
          title: row.label,
          bullets: [] as string[],
        }));
  const hasClaims = groups.length > 0 || Boolean(spec.keyMessage);
  const claimsBox: Box = matrix
    ? { x: 0.72, y: 1.72, w: hasClaims ? 3.92 : 0, h: 3.58 }
    : {
        x: 0.72,
        y: 1.72,
        w: figure
          ? hasOpenQuestions
            ? 4.42
            : 5.7
          : hasOpenQuestions
            ? 7.82
            : 11.88,
        h: hasTimeline ? 3.04 : 4.78,
      };
  if (spec.keyMessage) {
    addRule(
      context,
      slide,
      { x: claimsBox.x, y: claimsBox.y, w: 1.15, h: 0 },
      palette.accent,
      2,
    );
    addText(
      slide,
      context.labels.coreConclusion,
      { x: claimsBox.x, y: claimsBox.y + 0.16, w: claimsBox.w, h: 0.2 },
      {
        fontFace: MONO_FONT,
        fontSize: 7.8,
        bold: true,
        color: palette.accentDark,
        charSpacing: 0.9,
      },
    );
    addText(
      slide,
      spec.keyMessage,
      {
        x: claimsBox.x,
        y: claimsBox.y + 0.5,
        w: claimsBox.w,
        h: groups.length ? 1.18 : 2.62,
      },
      {
        fontFace: TITLE_FONT,
        fontSize:
          Array.from(spec.keyMessage).length > 170
            ? 13
            : Array.from(spec.keyMessage).length > 110
              ? 14.5
              : 17,
        bold: false,
        color: palette.text,
        valign: "top",
        objectName: nextPresentationAnimationObjectName(slide, "key-message"),
      },
    );
  }
  if (!spec.keyMessage && groups.length && !matrix) {
    addRule(
      context,
      slide,
      { x: claimsBox.x, y: claimsBox.y, w: claimsBox.w, h: 0 },
      palette.border,
      0.8,
    );
    addText(
      slide,
      context.labels.paperEstablishes,
      { x: claimsBox.x, y: claimsBox.y + 0.16, w: claimsBox.w - 0.72, h: 0.2 },
      {
        fontFace: MONO_FONT,
        fontSize: 8.5,
        bold: true,
        color: palette.accentDark,
        charSpacing: 0.85,
      },
    );
    addText(
      slide,
      String(groups.length).padStart(2, "0"),
      {
        x: claimsBox.x + claimsBox.w - 0.68,
        y: claimsBox.y + 0.08,
        w: 0.68,
        h: 0.28,
      },
      {
        fontFace: MONO_FONT,
        fontSize: 15,
        bold: true,
        color: palette.accent,
        align: "right",
      },
    );
  }
  const groupStart =
    claimsBox.y +
    (spec.keyMessage ? 1.88 : !matrix && groups.length ? 0.62 : 0);
  const rowHeight = Math.min(
    matrix ? 0.62 : hasTimeline ? 1.08 : 1.36,
    (claimsBox.y + claimsBox.h - groupStart) / Math.max(1, groups.length),
  );
  groups.forEach((group, index) => {
    const y = groupStart + index * rowHeight;
    addText(
      slide,
      String(index + 1).padStart(2, "0"),
      { x: claimsBox.x, y: y + 0.05, w: 0.42, h: 0.3 },
      {
        fontFace: MONO_FONT,
        fontSize: 14.5,
        bold: true,
        color: palette.accent,
        align: "left",
      },
    );
    slide.addShape(presentation.ShapeType.line, {
      x: claimsBox.x,
      y: y + rowHeight - 0.08,
      w: claimsBox.w,
      h: 0,
      line: { color: palette.border, width: 0.5 },
    });
    addText(
      slide,
      group.title,
      { x: claimsBox.x + 0.58, y, w: claimsBox.w - 0.58, h: 0.38 },
      {
        fontFace: TITLE_FONT,
        fontSize: 17.5,
        bold: true,
        color: palette.text,
      },
    );
    if (group.bullets.length) {
      addText(
        slide,
        group.bullets.join(" · "),
        {
          x: claimsBox.x + 0.58,
          y: y + 0.43,
          w: claimsBox.w - 0.58,
          h: rowHeight - 0.36,
        },
        { fontSize: 13, color: palette.muted, valign: "top" },
      );
    }
  });

  if (matrix) {
    addConclusionMatrixBlock(
      context,
      slide,
      matrix,
      {
        x: hasClaims ? 4.98 : 0.74,
        y: 1.72,
        w: hasClaims ? 7.66 : 11.9,
        h: 3.6,
      },
      { showRowLabels: !usesMatrixRowsAsClaims },
    );
  }

  if (figure && !matrix) {
    const region: Box = hasOpenQuestions
      ? { x: 5.48, y: 1.86, w: 3.36, h: 3.22 }
      : { x: 7.02, y: 1.72, w: 5.38, h: 3.72 };
    figureBox(context, slide, figure, region);
  }

  if (spec.callouts?.length && !matrix) {
    const questionColumnX = figure ? 9.25 : 9.02;
    const questionColumnW = figure ? 3.35 : 3.58;
    addRule(
      context,
      slide,
      { x: questionColumnX, y: 1.72, w: questionColumnW, h: 0 },
      palette.border,
      0.8,
    );
    addText(
      slide,
      context.labels.openQuestions,
      { x: questionColumnX, y: 1.9, w: questionColumnW - 0.6, h: 0.22 },
      {
        fontFace: MONO_FONT,
        fontSize: 9,
        bold: true,
        color: palette.danger,
        charSpacing: 0.9,
      },
    );
    const questions = spec.callouts
      .flatMap((callout) => {
        const sentences = callout.text
          .split(/(?<=\?)/)
          .map((sentence) => sentence.trim())
          .filter(Boolean);
        return (sentences.length ? sentences : [callout.text]).map((text) => ({
          text,
          label: isOpenQuestionsLabel(callout.label, context.labels)
            ? undefined
            : callout.label,
        }));
      })
      .slice(0, 3);
    addText(
      slide,
      String(questions.length).padStart(2, "0"),
      {
        x: questionColumnX + questionColumnW - 0.58,
        y: 1.82,
        w: 0.58,
        h: 0.3,
      },
      {
        fontFace: MONO_FONT,
        fontSize: 15,
        bold: true,
        color: palette.focus,
        align: "right",
      },
    );
    const questionRowHeight = hasTimeline
      ? 0.92
      : Math.min(1.72, 4.08 / Math.max(1, questions.length));
    questions.forEach((question, index) => {
      const y = hasTimeline
        ? 2.34 + index * 0.92
        : 2.42 + index * questionRowHeight;
      slide.addShape(presentation.ShapeType.rect, {
        x: questionColumnX,
        y: y + 0.08,
        w: 0.07,
        h: 0.07,
        line: { color: palette.focus, transparency: 100 },
        fill: { color: palette.focus },
      });
      if (question.label) {
        addText(
          slide,
          question.label.toLocaleUpperCase(),
          { x: questionColumnX + 0.23, y, w: questionColumnW - 0.23, h: 0.18 },
          {
            fontFace: MONO_FONT,
            fontSize: 7.5,
            bold: true,
            color: palette.focus,
            charSpacing: 0.7,
          },
        );
      }
      addText(
        slide,
        question.text,
        {
          x: questionColumnX + 0.23,
          y: y + (question.label ? 0.23 : 0),
          w: questionColumnW - 0.23,
          h: question.label
            ? hasTimeline
              ? 0.5
              : questionRowHeight - 0.36
            : hasTimeline
              ? 0.76
              : questionRowHeight - 0.18,
        },
        {
          fontSize: hasTimeline ? 12.2 : 14,
          color: palette.text,
          valign: "top",
        },
      );
    });
  }

  const timeline = spec.timeline || [];
  if (timeline.length) {
    addRule(
      context,
      slide,
      { x: 0.72, y: 4.96, w: 11.88, h: 0 },
      palette.border,
      0.8,
    );
    addText(
      slide,
      context.labels.researchMilestones,
      { x: 0.72, y: 5.12, w: 3.2, h: 0.22 },
      {
        fontFace: MONO_FONT,
        fontSize: 8.5,
        bold: true,
        color: palette.muted,
        charSpacing: 0.8,
      },
    );
    const lineY = 6.02;
    const timelineColumns = layoutTimelineColumns(timeline.length);
    const firstMarkerX = timelineColumns[0]?.markerX || 1.0;
    const lastMarkerX =
      timelineColumns[timelineColumns.length - 1]?.markerX || 12.35;
    slide.addShape(presentation.ShapeType.line, {
      x: firstMarkerX,
      y: lineY,
      w: Math.max(0.5, lastMarkerX - firstMarkerX + 0.18),
      h: 0,
      line: { color: palette.text, width: 0.9, endArrowType: "triangle" },
    });
    timeline.forEach((step, index) => {
      const column = timelineColumns[index];
      const x = column.markerX;
      slide.addShape(presentation.ShapeType.diamond, {
        x: x - 0.065,
        y: lineY - 0.065,
        w: 0.13,
        h: 0.13,
        line: { color: palette.accent, transparency: 100 },
        fill: { color: palette.accent },
      });
      addText(
        slide,
        step.label,
        {
          x: column.boxX,
          y: lineY - 0.72,
          w: column.boxWidth,
          h: 0.34,
        },
        {
          fontSize: timeline.length <= 3 ? 14 : 12.8,
          bold: true,
          color: palette.text,
          align: "center",
        },
      );
      if (step.milestone) {
        addText(
          slide,
          step.milestone,
          {
            x: column.boxX,
            y: lineY - 0.34,
            w: column.boxWidth,
            h: 0.2,
          },
          {
            fontSize: timeline.length <= 3 ? 11.2 : 10.5,
            bold: true,
            color: palette.accent,
            align: "center",
          },
        );
      }
      if (step.detail) {
        addText(
          slide,
          step.detail,
          {
            x: column.boxX,
            y: lineY + 0.18,
            w: column.boxWidth,
            h: 0.62,
          },
          {
            fontSize: timeline.length <= 3 ? 12.4 : 11.4,
            color: palette.muted,
            align: "center",
            valign: "top",
          },
        );
      }
    });
  }
}

export function renderMatrixLayout(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  const matrix = spec.matrix;
  if (!matrix) {
    renderEvidenceLayout(context, slide, spec);
    return;
  }
  const { palette } = context;
  const supportingFigure = spec.figure || spec.figures?.[0];
  addMatrixBlock(context, slide, matrix, {
    x: 0.82,
    y: 1.62,
    w: supportingFigure ? 7.55 : 11.7,
    h: 4.62,
  });
  if (supportingFigure) {
    figureBox(context, slide, supportingFigure, {
      x: 8.65,
      y: matrix.banner ? 2.42 : 1.72,
      w: 3.87,
      h: matrix.banner ? 3.82 : 4.52,
    });
  }
  if (spec.keyMessage) {
    addText(
      slide,
      spec.keyMessage,
      { x: 1.05, y: 6.32, w: 11.2, h: 0.28 },
      {
        fontSize: 11.5,
        bold: true,
        color: palette.accentDark,
        align: "center",
        objectName: nextPresentationAnimationObjectName(slide, "key-message"),
      },
    );
  }
}

export function renderTimelineLayout(
  context: AdvancedRenderContext,
  slide: PptxGenJS.Slide,
  spec: RenderablePresentationSlide,
): void {
  const timeline = spec.timeline || [];
  const { palette, presentation } = context;
  const timelineFigure = spec.figure || spec.figures?.[0];
  if (spec.keyMessage) {
    addRule(
      context,
      slide,
      { x: 0.74, y: 1.68, w: 1.25, h: 0 },
      palette.accent,
      2.2,
    );
    addText(
      slide,
      spec.keyMessage,
      { x: 0.74, y: 1.86, w: 8.15, h: 0.62 },
      {
        fontFace: TITLE_FONT,
        fontSize: Array.from(spec.keyMessage).length > 90 ? 16 : 18,
        bold: true,
        color: palette.accentDark,
        valign: "top",
        objectName: nextPresentationAnimationObjectName(slide, "key-message"),
      },
    );
  }
  addGroupedNarrative(
    context,
    slide,
    { ...spec, keyMessage: undefined },
    {
      x: 0.74,
      y: spec.keyMessage ? 2.68 : 1.68,
      w: timelineFigure ? 4.02 : 8.15,
      h: spec.keyMessage ? 2.35 : 3.35,
    },
  );
  if (timelineFigure) {
    figureBox(context, slide, timelineFigure, {
      x: 4.98,
      y: spec.keyMessage ? 2.6 : 1.72,
      w: 3.92,
      h: spec.keyMessage ? 2.5 : 3.38,
    });
  }
  if (spec.callouts?.length) {
    addRule(
      context,
      slide,
      { x: 9.25, y: 1.76, w: 3.35, h: 0 },
      palette.border,
      0.8,
    );
    addText(
      slide,
      context.labels.openQuestions,
      { x: 9.25, y: 1.94, w: 3.35, h: 0.22 },
      {
        fontFace: MONO_FONT,
        fontSize: 8,
        bold: true,
        color: palette.danger,
        charSpacing: 0.9,
      },
    );
    const calloutHeight = 0.64;
    spec.callouts.forEach((callout, index) => {
      const y = 2.35 + index * 0.76;
      slide.addShape(presentation.ShapeType.rect, {
        x: 9.25,
        y: y + 0.08,
        w: 0.08,
        h: 0.08,
        line: { color: palette.accent, transparency: 100 },
        fill: { color: palette.accent },
      });
      addText(
        slide,
        protectPresentationQuantities(callout.text),
        { x: 9.48, y, w: 3.12, h: calloutHeight },
        { fontSize: 10.2, color: palette.text, valign: "top" },
      );
    });
  }
  const lineY = timelineFigure ? 6.08 : 5.7;
  slide.addShape(presentation.ShapeType.line, {
    x: 0.96,
    y: lineY,
    w: 11.45,
    h: 0,
    line: { color: palette.text, width: 1.1, endArrowType: "triangle" },
  });
  const stepWidth = 10.85 / Math.max(1, timeline.length - 1);
  timeline.forEach((step, index) => {
    const x = 1.12 + index * stepWidth;
    slide.addShape(presentation.ShapeType.diamond, {
      x: x - 0.08,
      y: lineY - 0.08,
      w: 0.16,
      h: 0.16,
      line: { color: palette.accent, transparency: 100 },
      fill: { color: palette.accent },
    });
    addText(
      slide,
      step.label,
      { x: x - 0.78, y: lineY - 0.82, w: 1.56, h: 0.42 },
      {
        fontSize: 9.5,
        bold: true,
        color: palette.text,
        align: "center",
        valign: "bottom",
      },
    );
    if (step.milestone) {
      addText(
        slide,
        step.milestone,
        { x: x - 0.78, y: lineY - 0.39, w: 1.56, h: 0.22 },
        { fontSize: 8.2, bold: true, color: palette.accent, align: "center" },
      );
    }
    if (step.detail) {
      addText(
        slide,
        step.detail,
        { x: x - 0.82, y: lineY + 0.26, w: 1.64, h: 0.46 },
        { fontSize: 8.3, color: palette.muted, align: "center", valign: "top" },
      );
    }
  });
}
