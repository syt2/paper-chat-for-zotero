import type {
  PresentationRequest,
  RenderablePresentationRequest,
} from "./PresentationSchema";

export type PresentationProgressPhase =
  | "analyzing"
  | "planning"
  | "resolving_media"
  | "rendering"
  | "reviewing"
  | "repairing"
  | "exporting"
  | "attaching"
  | "completed";

export interface PresentationProgressUpdate {
  phase: PresentationProgressPhase;
  message: string;
  pptxPath?: string;
  previewPaths?: string[];
  isDraft?: boolean;
  current?: number;
  total?: number;
}

export type PresentationProgressCallback = (
  update: PresentationProgressUpdate,
) => void | Promise<void>;

/** App-owned Zotero identity for the paper bound to the current chat turn. */
export interface PresentationSourceContext {
  itemKey?: string;
  libraryID?: number;
}

/**
 * Explicit test seam for exercising refusal behavior. Runtime callers should
 * omit this argument: user-facing presentation generation is advisory by
 * default, independent of development or release build mode.
 */
export interface PresentationCapabilityTestOptions {
  strictQualityGate?: boolean;
  mediaResolver?: (
    request: PresentationRequest,
    sourceLibraryID?: number,
  ) => Promise<RenderablePresentationRequest>;
}

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
