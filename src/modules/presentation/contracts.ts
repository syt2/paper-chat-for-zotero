import type { RenderablePresentationRequest } from "./PresentationSchema";

export interface PresentationRenderWithPreviewResult {
  bytes: Uint8Array;
  previewSlides: string[];
  visualWarnings?: string[];
}

export interface PresentationRendererApi {
  renderPresentation(spec: RenderablePresentationRequest): Promise<Uint8Array>;
  renderPresentationWithPreview(
    spec: RenderablePresentationRequest,
  ): Promise<PresentationRenderWithPreviewResult>;
}

export interface PresentationRendererBundleApi {
  renderPresentation(spec: RenderablePresentationRequest): Promise<Uint8Array>;
  renderPresentationWithPreview?: (
    spec: RenderablePresentationRequest,
  ) => Promise<PresentationRenderWithPreviewResult>;
}

export const PRESENTATION_RENDERER_GLOBAL =
  "PaperChatPresentationRendererBundle" as const;
