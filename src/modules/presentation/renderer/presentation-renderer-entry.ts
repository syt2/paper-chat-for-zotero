import type { RenderablePresentationRequest } from "../PresentationSchema";
import {
  renderPresentation as renderPresentationSpec,
  renderPresentationWithPreview as renderPresentationWithPreviewSpec,
} from "./PptxPresentationExporter";

export function renderPresentation(
  spec: RenderablePresentationRequest,
  abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  return renderPresentationSpec(spec, undefined, abortSignal);
}

export function renderPresentationWithPreview(
  spec: RenderablePresentationRequest,
  abortSignal?: AbortSignal,
) {
  return renderPresentationWithPreviewSpec(spec, undefined, abortSignal);
}
