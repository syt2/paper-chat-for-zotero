import JSZip from "jszip";
import type {
  RenderablePresentationRequest,
  RenderablePresentationSlide,
} from "../PresentationSchema";
import { planPresentationCoverFigures } from "./PresentationCoverPlanner";
import { resolveLayout } from "./PresentationDesignSystem";
import { figureCaptionVerificationAnchor } from "./PresentationTextLayout";
import { estimateTextBoxHeight } from "./PresentationTextLayout";
import { resolvePresentationThemeBlueprint } from "./PresentationThemeBlueprint";
import { shouldUseFullCanvasWideFigure } from "./PresentationScenePlanner";

const EMU_PER_INCH = 914_400;
const SLIDE_WIDTH_EMU = 13.333 * EMU_PER_INCH;
const SLIDE_HEIGHT_EMU = 7.5 * EMU_PER_INCH;
// OOXML text extents do not include every bit of PowerPoint's autofit and
// internal padding behavior. Capacity estimates are therefore advisory: the
// PNG visual reviewer, which sees the actual rendered slide, is the reliable
// place to reject unreadable text without aborting on false positives here.
const NOTICEABLE_TEXT_FIT_RATIO = 0.82;

export interface PictureExtent {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PresentationRenderVerificationOptions {
  /** Explicit strict seam for tests; normal plugin exports are advisory. */
  strict?: boolean;
}

function reportVerificationIssue(
  warnings: string[],
  message: string,
  options?: PresentationRenderVerificationOptions,
): void {
  if (options?.strict) {
    throw new Error(message);
  }
  warnings.push(message);
}

interface TextShapeExtent extends PictureExtent {
  text: string;
  fontSize: number;
}

export function extractPictureExtents(xml: string): PictureExtent[] {
  return Array.from(xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)).flatMap(
    (match) => {
      const block = match[0];
      const offset = block.match(/<a:off\s+x="(\d+)"\s+y="(\d+)"\s*\/>/);
      const extent = block.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/);
      if (!offset || !extent) return [];
      return [
        {
          x: Number(offset[1]),
          y: Number(offset[2]),
          w: Number(extent[1]),
          h: Number(extent[2]),
        },
      ];
    },
  );
}

function pictureAreaRatio(extents: readonly PictureExtent[]): number {
  return (
    extents.reduce((total, extent) => total + extent.w * extent.h, 0) /
    (SLIDE_WIDTH_EMU * SLIDE_HEIGHT_EMU)
  );
}

function minimumPictureAreaRatio(
  slide: RenderablePresentationSlide,
  layout: ReturnType<typeof resolveLayout>,
): number {
  // This verifier is the catastrophic geometry floor, not the aesthetic
  // judge. The PNG visual reviewer sees the complete slide and can enlarge,
  // relayout, or reject weak evidence. Keep only thresholds that catch actual
  // thumbnails or broken placement before that review can run.
  if (layout === "gallery") return 0.18;
  if (layout === "process") return 0.06;
  // An ablation's dominant evidence is its editable chart or table. A paper
  // crop in the sidebar is supporting context, so do not force it to displace
  // the primary result merely to satisfy the same area threshold as a hero.
  if (layout === "ablation") return 0.02;
  if (layout !== "figure") return 0;

  const figures = [
    ...(slide.figure ? [slide.figure] : []),
    ...(slide.figures || []),
  ];
  const onlyFigure = figures.length === 1 ? figures[0] : undefined;
  const sourceAspectRatio =
    onlyFigure && onlyFigure.pixelHeight > 0
      ? onlyFigure.pixelWidth / onlyFigure.pixelHeight
      : 0;

  // Ultra-wide paper diagrams can fill the available width while occupying
  // slightly less slide area than a conventional landscape figure.
  return sourceAspectRatio >= 2.8 ? 0.1 : 0.12;
}

function verifyPictureGeometry(
  xml: string,
  slide: RenderablePresentationSlide,
  slideNumber: number,
  options?: PresentationRenderVerificationOptions,
): string[] {
  const warnings: string[] = [];
  const extents = extractPictureExtents(xml);
  extents.forEach((extent) => {
    const tolerance = 2_000;
    if (
      extent.w <= 0 ||
      extent.h <= 0 ||
      extent.x < -tolerance ||
      extent.y < -tolerance ||
      extent.x + extent.w > SLIDE_WIDTH_EMU + tolerance ||
      extent.y + extent.h > SLIDE_HEIGHT_EMU + tolerance
    ) {
      reportVerificationIssue(
        warnings,
        `Presentation render verification failed on slide ${slideNumber}: a picture is outside the slide canvas.`,
        options,
      );
    }
  });

  const layout = resolveLayout(slide, slideNumber - 2);
  const ratio = pictureAreaRatio(extents);
  const minimum = minimumPictureAreaRatio(slide, layout);
  if (expectedFigureCount(slide) > 0 && ratio < minimum) {
    warnings.push(
      `Slide ${slideNumber}: ${layout} pictures occupy only ${Math.round(ratio * 100)}% of the slide; recommended minimum is ${Math.round(minimum * 100)}%.`,
    );
  }
  return warnings;
}

function verifyCoverPictureGeometry(
  xml: string,
  hasPaperSource: boolean,
  expectedFigures: number,
  options?: PresentationRenderVerificationOptions,
): string[] {
  const warnings: string[] = [];
  const extents = extractPictureExtents(xml);
  extents.forEach((extent) => {
    const tolerance = 2_000;
    if (
      extent.w <= 0 ||
      extent.h <= 0 ||
      extent.x < -tolerance ||
      extent.y < -tolerance ||
      extent.x + extent.w > SLIDE_WIDTH_EMU + tolerance ||
      extent.y + extent.h > SLIDE_HEIGHT_EMU + tolerance
    ) {
      reportVerificationIssue(
        warnings,
        "Presentation render verification failed on the cover: a picture is outside the slide canvas.",
        options,
      );
    }
  });
  if (hasPaperSource && expectedFigures > 0) {
    const ratio = pictureAreaRatio(extents);
    if (ratio < 0.16) {
      warnings.push(
        `Cover: paper figures occupy only ${Math.round(ratio * 100)}% of the slide; recommended minimum is 16%.`,
      );
    }
  }
  return warnings;
}

function decodeXmlText(value: string): string {
  let decoded = value;
  for (let index = 0; index < 3; index++) {
    decoded = decoded
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#([0-9]+);/g, (_, decimal: string) =>
        String.fromCodePoint(Number.parseInt(decimal, 10)),
      )
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }
  return decoded;
}

function normalizeText(value: string): string {
  return decodeXmlText(value)
    .replace(/[\u2060\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function slideText(xml: string): string {
  const runs = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g), (match) =>
    decodeXmlText(match[1]),
  );
  return normalizeText(runs.join(" "));
}

function extractTextShapeExtents(xml: string): TextShapeExtent[] {
  return Array.from(xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)).flatMap(
    (match) => {
      const block = match[0];
      const text = Array.from(
        block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g),
        (textMatch) => decodeXmlText(textMatch[1]),
      )
        .join(" ")
        .trim();
      const offset = block.match(/<a:off\s+x="(\d+)"\s+y="(\d+)"\s*\/>/);
      const extent = block.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/);
      const fontSizes = Array.from(
        block.matchAll(/\ssz="(\d+)"/g),
        (size) => Number(size[1]) / 100,
      ).filter((size) => Number.isFinite(size) && size > 0);
      if (!text || !offset || !extent || !fontSizes.length) return [];
      return [
        {
          text,
          x: Number(offset[1]),
          y: Number(offset[2]),
          w: Number(extent[1]),
          h: Number(extent[2]),
          fontSize: Math.max(...fontSizes),
        },
      ];
    },
  );
}

function narrativeMarkers(slide: RenderablePresentationSlide): string[] {
  const visibleFigureNarrative = !shouldUseFullCanvasWideFigure(slide);
  return [
    visibleFigureNarrative ? slide.keyMessage : undefined,
    ...(visibleFigureNarrative ? slide.bullets || [] : []),
    ...(slide.groups || []).flatMap((group) => [group.title, ...group.bullets]),
    ...(slide.callouts || []).flatMap((callout) => [
      callout.label,
      callout.text,
    ]),
    ...(slide.process || []).flatMap((step) => [step.title, step.detail]),
    ...(slide.timeline || []).flatMap((step) => [
      step.label,
      step.milestone,
      step.detail,
    ]),
  ].filter((marker): marker is string => Array.from(marker || "").length >= 12);
}

function verifyNarrativeTextCapacity(
  xml: string,
  slide: RenderablePresentationSlide,
  slideNumber: number,
): string[] {
  const warnings: string[] = [];
  const shapes = extractTextShapeExtents(xml);
  for (const marker of narrativeMarkers(slide)) {
    const normalizedMarker = normalizeText(marker);
    const shape = shapes.find((candidate) => {
      const normalizedShape = normalizeText(candidate.text);
      return (
        normalizedShape.includes(normalizedMarker) ||
        normalizedMarker.includes(normalizedShape)
      );
    });
    if (!shape) continue;
    const requiredHeight =
      estimateTextBoxHeight(
        shape.text,
        shape.w / EMU_PER_INCH,
        shape.fontSize,
      ) + 0.05;
    const availableHeight = shape.h / EMU_PER_INCH;
    if (requiredHeight <= 0) continue;
    const fitRatio = availableHeight / requiredHeight;
    if (fitRatio < NOTICEABLE_TEXT_FIT_RATIO) {
      warnings.push(
        `Slide ${slideNumber}: text for "${marker.slice(0, 80)}" has ${availableHeight.toFixed(2)}in height versus about ${requiredHeight.toFixed(2)}in estimated (${Math.round(fitRatio * 100)}%); inspect the rendered slide for shrinkage or clipping.`,
      );
    }
  }
  return warnings;
}

function expectedMarkers(slide: RenderablePresentationSlide): string[] {
  const visibleFigureNarrative = !shouldUseFullCanvasWideFigure(slide);
  const figureCaptionMarkers = [
    ...(slide.figure ? [slide.figure] : []),
    ...(slide.figures || []),
  ].flatMap((figure) => {
    const sourceCaption = figure.caption || figure.captionHint;
    return sourceCaption
      ? [figureCaptionVerificationAnchor(sourceCaption)]
      : [];
  });
  return [
    slide.eyebrow,
    slide.title,
    slide.subtitle,
    visibleFigureNarrative ? slide.keyMessage : undefined,
    ...(visibleFigureNarrative ? slide.bullets || [] : []),
    ...(slide.groups || []).flatMap((group) => [group.title, ...group.bullets]),
    ...(slide.metrics || []).flatMap((metric) => [
      metric.value,
      metric.label,
      metric.detail,
    ]),
    ...(slide.callouts || []).flatMap((callout) => [
      callout.label,
      callout.text,
    ]),
    ...(slide.process || []).flatMap((step) => [step.title, step.detail]),
    ...(slide.timeline || []).flatMap((step) => [
      step.label,
      step.milestone,
      step.detail,
    ]),
    ...(slide.comparison
      ? [
          slide.comparison.left.title,
          ...slide.comparison.left.bullets,
          slide.comparison.right.title,
          ...slide.comparison.right.bullets,
        ]
      : []),
    ...(slide.matrix
      ? [
          slide.matrix.banner,
          ...slide.matrix.columns,
          ...slide.matrix.rows.flatMap((row) => [row.label, ...row.cells]),
        ]
      : []),
    ...(slide.table?.headers || []),
    ...(slide.table?.rows.flat() || []),
    slide.equation?.label,
    slide.equation?.expression,
    slide.equation?.explanation,
    ...figureCaptionMarkers,
    slide.source,
  ].filter((marker): marker is string => Boolean(marker?.trim()));
}

function expectedFigureCount(slide: RenderablePresentationSlide): number {
  return (slide.figure ? 1 : 0) + (slide.figures?.length || 0);
}

export async function verifyRenderedPresentation(
  bytes: Uint8Array,
  spec: RenderablePresentationRequest,
  options?: PresentationRenderVerificationOptions,
): Promise<string[]> {
  const warnings: string[] = [];
  const archive = await JSZip.loadAsync(bytes);
  const expectedSlideCount = spec.slides.length + 1;
  const coverXml = await archive.file("ppt/slides/slide1.xml")?.async("string");
  if (!coverXml) {
    reportVerificationIssue(
      warnings,
      "Presentation render verification failed: cover slide missing.",
      options,
    );
  } else {
    const coverText = slideText(coverXml);
    const compactCoverText = coverText.replace(/\s+/gu, "");
    const compactExpectedTitle = normalizeText(spec.title).replace(/\s+/gu, "");
    if (!compactCoverText.includes(compactExpectedTitle)) {
      reportVerificationIssue(
        warnings,
        `Presentation render verification failed: cover omitted the deck title "${spec.title}".`,
        options,
      );
    }
    for (const marker of [spec.subtitle, spec.author].filter(
      (value): value is string => Boolean(value?.trim()),
    )) {
      if (!coverText.includes(normalizeText(marker))) {
        warnings.push(`Cover: renderer omitted optional text "${marker}".`);
      }
    }
    const coverFigureCount = planPresentationCoverFigures(
      spec,
      resolvePresentationThemeBlueprint(spec).id !== "paperchat-editorial",
    ).length;
    const renderedCoverFigures = (coverXml.match(/<p:pic>/g) || []).length;
    if (renderedCoverFigures < coverFigureCount) {
      warnings.push(
        `Cover: rendered ${renderedCoverFigures}/${coverFigureCount} planned figures.`,
      );
    }
    warnings.push(
      ...verifyCoverPictureGeometry(
        coverXml,
        Boolean(spec.sourceItemKey),
        coverFigureCount,
        options,
      ),
    );
  }

  for (let index = 0; index < expectedSlideCount; index++) {
    const path = `ppt/slides/slide${index + 1}.xml`;
    if (!archive.file(path)) {
      reportVerificationIssue(
        warnings,
        `Presentation render verification failed: expected ${expectedSlideCount} slides but ${path} is missing.`,
        options,
      );
    }
  }
  if (archive.file(`ppt/slides/slide${expectedSlideCount + 1}.xml`)) {
    reportVerificationIssue(
      warnings,
      `Presentation render verification failed: output contains more than ${expectedSlideCount} slides.`,
      options,
    );
  }

  for (const [index, slide] of spec.slides.entries()) {
    const path = `ppt/slides/slide${index + 2}.xml`;
    const slideEntry = archive.file(path);
    if (!slideEntry) continue;
    const xml = await slideEntry.async("string");
    const text = slideText(xml);
    const missing = expectedMarkers(slide).filter(
      (marker) => !text.includes(normalizeText(marker)),
    );
    if (missing.length) {
      warnings.push(
        `Slide ${index + 2}: renderer omitted or shortened ${missing
          .slice(0, 4)
          .map((marker) => `"${marker}"`)
          .join(", ")}.`,
      );
    }
    warnings.push(...verifyNarrativeTextCapacity(xml, slide, index + 2));

    const figureCount = expectedFigureCount(slide);
    const renderedFigures = (xml.match(/<p:pic>/g) || []).length;
    if (renderedFigures < figureCount) {
      warnings.push(
        `Slide ${index + 2}: rendered ${renderedFigures}/${figureCount} supplied figures.`,
      );
    }
    if (spec.sourceItemKey) {
      warnings.push(...verifyPictureGeometry(xml, slide, index + 2, options));
    }
    if (slide.chart && !xml.includes("<c:chart")) {
      reportVerificationIssue(
        warnings,
        `Presentation render verification failed on slide ${index + 2}: chart relationship missing.`,
        options,
      );
    }
    const layout = resolveLayout(slide, index);
    const requiresNativeTable = Boolean(
      slide.table || (slide.matrix && layout !== "conclusion"),
    );
    if (requiresNativeTable && !xml.includes("<a:tbl>")) {
      reportVerificationIssue(
        warnings,
        `Presentation render verification failed on slide ${index + 2}: table or matrix missing.`,
        options,
      );
    }
  }
  return warnings;
}
