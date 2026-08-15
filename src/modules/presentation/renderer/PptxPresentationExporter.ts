import PptxGenJS from "pptxgenjs";
import { normalizePresentationRequestInput } from "../PresentationRequestNormalizer";
import type { RenderablePresentationRequest } from "../PresentationSchema";
import { resolveLayout, resolveTheme } from "./PresentationDesignSystem";
import { validateResolvedVisualContract } from "./PresentationScenePlanner";
import { resolvePresentationThemeBlueprint } from "./PresentationThemeBlueprint";
import {
  assertWideCanvas,
  createRenderContext,
  renderContentSlide,
  renderCover,
} from "./PresentationLayoutRenderer";
import { verifyRenderedPresentation } from "./PresentationRenderVerifier";
import { renderPresentationPreviewSlides } from "./PresentationPreviewRenderer";

export interface PresentationRenderWithPreviewResult {
  bytes: Uint8Array;
  previewSlides: string[];
  visualWarnings: string[];
}

export interface PresentationRendererValidationOptions {
  /** Explicit strict seam for renderer tests; plugin exports stay advisory. */
  strictValidation?: boolean;
}

function normalizeRendererInput(
  spec: RenderablePresentationRequest,
  options?: PresentationRendererValidationOptions,
): {
  normalizedSpec: RenderablePresentationRequest;
  warnings: string[];
} {
  const normalized = normalizePresentationRequestInput(
    spec as unknown as Record<string, unknown>,
  ) as unknown as RenderablePresentationRequest;
  const warnings: string[] = [];
  type RendererFigure = NonNullable<
    RenderablePresentationRequest["coverFigure"]
  >;
  const normalizeFigure = (
    figure: RendererFigure,
    path: string,
  ): RendererFigure | undefined => {
    const data = String(figure.data);
    const pixelWidth = Number(figure.pixelWidth);
    const pixelHeight = Number(figure.pixelHeight);
    let issue: string | undefined;
    if (!/^data:image\/(?:png|jpe?g);base64,/i.test(data)) {
      issue = `invalid figure data on PDF page ${figure.page}: type=${typeof figure.data}, tag=${Object.prototype.toString.call(figure.data)}, prefix=${data.slice(0, 32)}, length=${data.length}`;
    } else if (
      !Number.isFinite(pixelWidth) ||
      !Number.isFinite(pixelHeight) ||
      pixelWidth <= 0 ||
      pixelHeight <= 0
    ) {
      issue = `invalid figure dimensions on PDF page ${figure.page}: ${figure.pixelWidth}x${figure.pixelHeight}`;
    }
    if (issue) {
      const message = `Presentation renderer received ${issue}.`;
      if (options?.strictValidation) throw new Error(message);
      warnings.push(`${path}: ${message} The unusable image was omitted.`);
      return undefined;
    }
    return { ...figure, data, pixelWidth, pixelHeight };
  };

  const coverCandidates = [
    ...(normalized.coverFigure
      ? [normalizeFigure(normalized.coverFigure, "/coverFigure")]
      : []),
    ...(normalized.coverFigures || []).map((figure, index) =>
      normalizeFigure(figure, `/coverFigures/${index}`),
    ),
  ].filter((figure): figure is RendererFigure => Boolean(figure));
  const slides = normalized.slides.map((slide, slideIndex) => {
    const candidates = [
      ...(slide.figure
        ? [normalizeFigure(slide.figure, `/slides/${slideIndex}/figure`)]
        : []),
      ...(slide.figures || []).map((figure, figureIndex) =>
        normalizeFigure(figure, `/slides/${slideIndex}/figures/${figureIndex}`),
      ),
    ].filter((figure): figure is RendererFigure => Boolean(figure));
    const {
      figure: _figure,
      figures: _figures,
      ...slideWithoutFigures
    } = slide;
    return {
      ...slideWithoutFigures,
      ...(candidates[0] ? { figure: candidates[0] } : {}),
      ...(candidates.length > 1 ? { figures: candidates.slice(1) } : {}),
    };
  });
  const {
    coverFigure: _coverFigure,
    coverFigures: _coverFigures,
    slides: _slides,
    ...requestWithoutFigures
  } = normalized;
  return {
    normalizedSpec: {
      ...requestWithoutFigures,
      ...(coverCandidates[0] ? { coverFigure: coverCandidates[0] } : {}),
      ...(coverCandidates.length > 1
        ? { coverFigures: coverCandidates.slice(1) }
        : {}),
      slides,
    },
    warnings,
  };
}

function assertPptxBytes(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error("PptxGenJS did not return a Uint8Array.");
  }
  if (
    value.length < 4 ||
    value[0] !== 0x50 ||
    value[1] !== 0x4b ||
    value[2] !== 0x03 ||
    value[3] !== 0x04
  ) {
    throw new Error("PptxGenJS returned data without a valid ZIP signature.");
  }
}

function createPresentationDocument(
  spec: RenderablePresentationRequest,
  options?: PresentationRendererValidationOptions,
): {
  presentation: PptxGenJS;
  normalizedSpec: RenderablePresentationRequest;
  visualWarnings: string[];
} {
  const { normalizedSpec, warnings: inputWarnings } = normalizeRendererInput(
    spec,
    options,
  );
  const visualWarnings = [
    ...inputWarnings,
    ...(normalizedSpec.sourceItemKey
      ? validateResolvedVisualContract(
          normalizedSpec.slides,
          normalizedSpec.slides.map((slide, index) =>
            resolveLayout(slide, index),
          ),
        )
      : []),
  ];
  assertWideCanvas();
  const presentation = new PptxGenJS();
  const palette = resolveTheme(normalizedSpec);
  const blueprint = resolvePresentationThemeBlueprint(normalizedSpec);
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = normalizedSpec.author || "PaperChat";
  presentation.company = "PaperChat";
  presentation.subject =
    "Editable evidence-first presentation generated inside PaperChat";
  presentation.title = normalizedSpec.title;
  presentation.theme = {
    headFontFace: blueprint.fonts.title,
    bodyFontFace: blueprint.fonts.body,
  };

  const context = createRenderContext(
    presentation,
    palette,
    blueprint,
    normalizedSpec,
  );
  const cover = presentation.addSlide();
  renderCover(context, cover, normalizedSpec);

  normalizedSpec.slides.forEach((slideSpec, index) => {
    const slide = presentation.addSlide();
    renderContentSlide(context, slide, normalizedSpec, slideSpec, index);
  });

  return { presentation, normalizedSpec, visualWarnings };
}

async function writeAndVerifyPresentation(
  presentation: PptxGenJS,
  normalizedSpec: RenderablePresentationRequest,
  options?: PresentationRendererValidationOptions,
): Promise<{ bytes: Uint8Array; verificationWarnings: string[] }> {
  const bytes = await presentation.write({
    outputType: "uint8array",
    compression: true,
  });
  assertPptxBytes(bytes);
  const verificationWarnings = await verifyRenderedPresentation(
    bytes,
    normalizedSpec,
    { strict: options?.strictValidation },
  );
  return { bytes, verificationWarnings };
}

export async function renderPresentation(
  spec: RenderablePresentationRequest,
  options?: PresentationRendererValidationOptions,
): Promise<Uint8Array> {
  const { presentation, normalizedSpec } = createPresentationDocument(
    spec,
    options,
  );
  const { bytes } = await writeAndVerifyPresentation(
    presentation,
    normalizedSpec,
    options,
  );
  return bytes;
}

export async function renderPresentationWithPreview(
  spec: RenderablePresentationRequest,
  options?: PresentationRendererValidationOptions,
): Promise<PresentationRenderWithPreviewResult> {
  const { presentation, normalizedSpec, visualWarnings } =
    createPresentationDocument(spec, options);
  const previewSlides = await renderPresentationPreviewSlides(presentation);
  const { bytes, verificationWarnings } = await writeAndVerifyPresentation(
    presentation,
    normalizedSpec,
    options,
  );
  return {
    bytes,
    previewSlides,
    visualWarnings: [...visualWarnings, ...verificationWarnings],
  };
}
