export {
  createPresentationToolDefinition,
  executePresentationCapability,
} from "./PresentationCapability";
export {
  attachPresentationToZotero,
  type PresentationAttachmentResult,
} from "./PresentationAttachment";
export {
  getPresentationRenderer,
  resetPresentationRendererForTests,
} from "./PresentationRendererLoader";
export {
  PresentationRequestSchema,
  PresentationSlideSchema,
} from "./PresentationSchema";
export {
  PresentationIntentSchema,
  buildPresentationPaperContext,
  buildPresentationPlannerSystemPrompt,
  buildPresentationPlannerUserPrompt,
  parsePresentationPlannerResponse,
} from "./PresentationPlanner";
export { normalizePresentationToolCall } from "./PresentationToolCallPolicy";
export type { PresentationRendererApi } from "./contracts";
export type {
  PresentationVisualReviewer,
  PresentationVisualReviewRequest,
  PresentationVisualReviewResponse,
} from "./PresentationVisualReview";
export type {
  PresentationIntent,
  PresentationPlanner,
  PresentationPlanningRequest,
} from "./PresentationPlanner";
export type {
  PresentationFigure,
  PresentationRequest,
  PresentationSlide,
  RenderablePresentationRequest,
  RenderablePresentationSlide,
  ResolvedPresentationFigure,
} from "./PresentationSchema";
