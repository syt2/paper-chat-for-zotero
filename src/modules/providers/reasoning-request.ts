import type {
  ApiKeyProviderConfig,
  ModelReasoningCapability,
  ReasoningEffort,
} from "../../types/provider";
import type { ChatMessage } from "../../types/chat";

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

export function resolveReasoningCapability(
  config: ApiKeyProviderConfig,
): ModelReasoningCapability | undefined {
  return config.reasoningCapability || getBuiltinDeepSeekCapability(config);
}

/**
 * DeepSeek requires the reasoning_content of every previous turn to be replayed
 * whenever the request carries tools. When the history has an assistant turn
 * without reasoning (produced by another model, by a non-thinking channel, or
 * dropped on resume) that requirement cannot be satisfied, so the caller must
 * fall back to thinking mode disabled instead of letting the upstream 400.
 */
export function needsThinkingDisabledForHistory(
  messages: ChatMessage[],
  config: ApiKeyProviderConfig,
  hasTools: boolean,
): boolean {
  if (
    !hasTools ||
    resolveReasoningCapability(config)?.protocol !== "deepseek"
  ) {
    return false;
  }
  return messages.some(
    (message) =>
      message.role === "assistant" && !message.reasoning?.trim().length,
  );
}

/**
 * Reasoning models reject non-default sampling values while reasoning is
 * enabled (OpenAI: "remove temperature, top_p and top_logprobs when reasoning
 * effort is not none"). Other upstreams accept temperature next to their own
 * reasoning controls, so the behaviour is declared per model via
 * `omitTemperature` and defaults to the OpenAI protocol.
 */
export function shouldSuppressTemperatureForReasoning(
  config: ApiKeyProviderConfig,
): boolean {
  const capability = resolveReasoningCapability(config);
  if (!capability) {
    return false;
  }
  const omitTemperature =
    capability.omitTemperature ?? capability.protocol === "openai";
  if (!omitTemperature) {
    return false;
  }
  return normalizeReasoningEffortPreference(config.reasoningEffort) !== "none";
}

export function applyReasoningRequestOptions(
  requestBody: Record<string, unknown>,
  config: ApiKeyProviderConfig,
  apiPath: "responses" | "chat_completions",
  options?: { disableThinking?: boolean },
): void {
  const effort = normalizeReasoningEffortPreference(config.reasoningEffort);
  const capability = resolveReasoningCapability(config);

  if (
    options?.disableThinking &&
    apiPath === "chat_completions" &&
    capability?.protocol === "deepseek"
  ) {
    requestBody.thinking = { type: "disabled" };
    return;
  }

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

  if (capability.protocol !== "deepseek") {
    // OpenAI-compatible Chat Completions uses the flat reasoning_effort field.
    // Only models whose published capability metadata declares reasoning
    // support reach this branch, so the stored preference stays inert
    // everywhere else.
    requestBody.reasoning_effort = effort;
    return;
  }

  if (effort === "none") {
    requestBody.thinking = { type: "disabled" };
    return;
  }

  requestBody.thinking = { type: "enabled" };
  requestBody.reasoning_effort = effort;
}
