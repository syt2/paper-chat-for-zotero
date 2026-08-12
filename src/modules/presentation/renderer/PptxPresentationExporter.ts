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

function normalizeRendererInput(
  spec: RenderablePresentationRequest,
): RenderablePresentationRequest {
  const figures = [
    ...(spec.coverFigure ? [spec.coverFigure] : []),
    ...(spec.coverFigures || []),
    ...spec.slides.flatMap((slide) => [
      ...(slide.figure ? [slide.figure] : []),
      ...(slide.figures || []),
    ]),
  ];
  for (const figure of figures) {
    const data = String(figure.data);
    if (!/^data:image\/(?:png|jpe?g);base64,/i.test(data)) {
      throw new Error(
        `Presentation renderer received invalid figure data on PDF page ${figure.page}: type=${typeof figure.data}, tag=${Object.prototype.toString.call(figure.data)}, prefix=${data.slice(0, 32)}, length=${data.length}.`,
      );
    }
    if (
      !Number.isFinite(figure.pixelWidth) ||
      !Number.isFinite(figure.pixelHeight) ||
      figure.pixelWidth <= 0 ||
      figure.pixelHeight <= 0
    ) {
      throw new Error(
        `Presentation renderer received invalid figure dimensions on PDF page ${figure.page}: ${figure.pixelWidth}x${figure.pixelHeight}.`,
      );
    }
    figure.data = data;
  }
  return spec;
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

function createPresentationDocument(spec: RenderablePresentationRequest): {
  presentation: PptxGenJS;
  normalizedSpec: RenderablePresentationRequest;
  visualWarnings: string[];
} {
  const normalizedSpec = normalizeRendererInput(
    normalizePresentationRequestInput(
      spec as unknown as Record<string, unknown>,
    ) as unknown as RenderablePresentationRequest,
  );
  const visualWarnings = normalizedSpec.sourceItemKey
    ? validateResolvedVisualContract(
        normalizedSpec.slides,
        normalizedSpec.slides.map((slide, index) =>
          resolveLayout(slide, index),
        ),
      )
    : [];
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
): Promise<{ bytes: Uint8Array; verificationWarnings: string[] }> {
  const bytes = await presentation.write({
    outputType: "uint8array",
    compression: true,
  });
  assertPptxBytes(bytes);
  const verificationWarnings = await verifyRenderedPresentation(
    bytes,
    normalizedSpec,
  );
  return { bytes, verificationWarnings };
}

export async function renderPresentation(
  spec: RenderablePresentationRequest,
): Promise<Uint8Array> {
  const { presentation, normalizedSpec } = createPresentationDocument(spec);
  const { bytes } = await writeAndVerifyPresentation(
    presentation,
    normalizedSpec,
  );
  return bytes;
}

export async function renderPresentationWithPreview(
  spec: RenderablePresentationRequest,
): Promise<PresentationRenderWithPreviewResult> {
  const { presentation, normalizedSpec, visualWarnings } =
    createPresentationDocument(spec);
  const previewSlides = await renderPresentationPreviewSlides(presentation);
  const { bytes, verificationWarnings } = await writeAndVerifyPresentation(
    presentation,
    normalizedSpec,
  );
  return {
    bytes,
    previewSlides,
    visualWarnings: [...visualWarnings, ...verificationWarnings],
  };
}
