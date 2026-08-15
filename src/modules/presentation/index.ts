export {
  createPresentationToolDefinition,
  executePresentationCapability,
  isPathInsidePresentationRoot,
  isTrustedPresentationPreviewPath,
} from "./PresentationCapability";
export {
  createPresentationLaunchToolDefinition,
  PRESENTATION_LAUNCH_TOOL_NAME,
  type PresentationToolLaunchResult,
  type PresentationToolLaunchSession,
} from "./PresentationToolLaunchSession";
export {
  canLaunchPresentationFromChat,
  createPresentationChatLaunchSession,
  registerPresentationChatLaunchBridge,
  unregisterPresentationChatLaunchBridge,
  type PresentationChatLaunchBridge,
  type PresentationChatLaunchOptions,
  type PresentationTaskLocation,
} from "./PresentationChatLaunchBridge";
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
export type {
  PresentationCapabilityTestOptions,
  PresentationCardProgress,
  PresentationCardStage,
  PresentationProgressCallback,
  PresentationProgressPhase,
  PresentationProgressUpdate,
  PresentationSourceContext,
  PresentationRendererApi,
} from "./contracts";
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
