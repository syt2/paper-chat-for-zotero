import type { RenderablePresentationRequest } from "../PresentationSchema";
import {
  renderPresentation as renderPresentationSpec,
  renderPresentationWithPreview as renderPresentationWithPreviewSpec,
} from "./PptxPresentationExporter";

export function renderPresentation(
  spec: RenderablePresentationRequest,
): Promise<Uint8Array> {
  return renderPresentationSpec(spec);
}

export function renderPresentationWithPreview(
  spec: RenderablePresentationRequest,
) {
  return renderPresentationWithPreviewSpec(spec);
}
