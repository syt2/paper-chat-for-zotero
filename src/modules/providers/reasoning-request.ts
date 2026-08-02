import type {
  ApiKeyProviderConfig,
  ModelReasoningCapability,
  ReasoningEffort,
} from "../../types/provider";

export const REASONING_EFFORT_OPTIONS = [
  "default",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffortPreference =
  (typeof REASONING_EFFORT_OPTIONS)[number];

export function normalizeReasoningEffortPreference(
  value: unknown,
): ReasoningEffortPreference {
  return typeof value === "string" &&
    REASONING_EFFORT_OPTIONS.includes(value as ReasoningEffortPreference)
    ? (value as ReasoningEffortPreference)
    : "default";
}

function getBuiltinDeepSeekCapability(
  config: ApiKeyProviderConfig,
): ModelReasoningCapability | undefined {
  if (
    config.id !== "deepseek" ||
    !/^deepseek-v4-(?:flash|pro)(?:[-.]|$)/i.test(config.defaultModel)
  ) {
    return undefined;
  }
  return {
    protocol: "deepseek",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    default: "high",
  };
}

function resolveCapability(
  config: ApiKeyProviderConfig,
): ModelReasoningCapability | undefined {
  return config.reasoningCapability || getBuiltinDeepSeekCapability(config);
}

export function applyReasoningRequestOptions(
  requestBody: Record<string, unknown>,
  config: ApiKeyProviderConfig,
  apiPath: "responses" | "chat_completions",
): void {
  const effort = normalizeReasoningEffortPreference(config.reasoningEffort);
  const capability = resolveCapability(config);
  if (
    effort === "default" ||
    !capability ||
    !capability.efforts.includes(effort as ReasoningEffort)
  ) {
    return;
  }

  if (apiPath === "responses") {
    requestBody.reasoning = { effort };
    return;
  }

  // Keep OpenAI Chat Completions exactly as before. PaperChat may disable
  // Responses temporarily, and the stored UI preference must then be inert.
  if (capability.protocol !== "deepseek") {
    return;
  }

  if (effort === "none") {
    requestBody.thinking = { type: "disabled" };
    return;
  }

  requestBody.thinking = { type: "enabled" };
  requestBody.reasoning_effort = effort;
}
