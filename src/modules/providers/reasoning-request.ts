import type {
  ApiKeyProviderConfig,
  ModelReasoningCapability,
  ReasoningEffort,
} from "../../types/provider";
import type { ChatMessage } from "../../types/chat";
import { HttpResponseError } from "./HttpResponseError";

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

/**
 * Upstreams that keep thinking mode on insist that the reasoning of an earlier
 * tool-calling turn is replayed, and answer 400 when it is missing. The history
 * loses that reasoning whenever the turn came from another model, another
 * channel, or a resumed session, so the request cannot be repaired - but it can
 * be sent again with thinking switched off.
 *
 * Matching is deliberately narrow: only errors that name reasoning/thinking
 * replay qualify, so an unrelated 400 (bad parameters, missing model, context
 * overflow) still surfaces to the user untouched.
 */
const REASONING_REPLAY_REQUIRED_PATTERN =
  /(?:reasoning(?:_content|_text)?|thinking)\b[\s\S]{0,80}?(?:must be passed back|should be passed back|must be provided|is required|in the thinking mode)|thinking\b[\s\S]{0,120}?(?:must be passed back|should be passed back|must be provided|is required)/i;

export function isReasoningReplayRequiredError(error: unknown): boolean {
  if (!(error instanceof HttpResponseError)) {
    return false;
  }
  if (error.status !== 400 && error.status !== 422) {
    return false;
  }
  return REASONING_REPLAY_REQUIRED_PATTERN.test(error.responseBody);
}

/**
 * Shape of the retry: no thinking at all, and no thinking-only effort hint
 * either, so neither field can be rejected a second time.
 */
export function applyReasoningReplayFallback(
  requestBody: Record<string, unknown>,
): void {
  delete requestBody.reasoning_effort;
  requestBody.thinking = { type: "disabled" };
}

/**
 * Responses requests have no flat reasoning_effort field. DeepSeek's Responses
 * endpoint instead treats `reasoning.effort: "none"` as thinking disabled.
 * Replayed reasoning items from another model are dropped at the same time:
 * the new upstream cannot validate their encrypted reasoning, and the visible
 * assistant messages already carry the conversation forward.
 */
export function applyResponsesReasoningReplayFallback(
  requestBody: Record<string, unknown>,
): void {
  const reasoning =
    requestBody.reasoning &&
    typeof requestBody.reasoning === "object" &&
    !Array.isArray(requestBody.reasoning)
      ? (requestBody.reasoning as Record<string, unknown>)
      : {};
  requestBody.reasoning = { ...reasoning, effort: "none" };

  if (Array.isArray(requestBody.input)) {
    requestBody.input = requestBody.input.filter(
      (item) =>
        !(
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>).type === "reasoning"
        ),
    );
  }
}
