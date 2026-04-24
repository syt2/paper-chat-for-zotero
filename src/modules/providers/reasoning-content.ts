export interface ReasoningContentRequestContext {
  providerId: string;
  modelId: string;
  baseUrl: string;
}

export function shouldIncludeReasoningContentForRequest(
  context: ReasoningContentRequestContext,
): boolean {
  const providerId = context.providerId.toLowerCase();
  const modelId = context.modelId.toLowerCase();
  const baseUrl = context.baseUrl.toLowerCase();
  return (
    providerId === "deepseek" ||
    modelId.includes("deepseek") ||
    baseUrl.includes("deepseek")
  );
}
