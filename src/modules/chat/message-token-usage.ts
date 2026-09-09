export interface MessageTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
}

/** Only provider-reported counts; missing usage must never look like zero cost. */
export function normalizeTokenUsage(
  raw: unknown,
  format = "openai",
): MessageTokenUsage | undefined {
  if (!raw || typeof raw !== "object") return;
  const data = raw as Record<string, unknown>;
  const number = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  let input = number(
    data.input_tokens ?? data.prompt_tokens ?? data.promptTokenCount,
  );
  let output = number(
    data.output_tokens ?? data.completion_tokens ?? data.candidatesTokenCount,
  );
  if (input === undefined || output === undefined) return;
  if (format === "anthropic") {
    input +=
      (number(data.cache_read_input_tokens) || 0) +
      (number(data.cache_creation_input_tokens) || 0);
  }
  if (format === "gemini") output += number(data.thoughtsTokenCount) || 0;
  const cachedInputTokens = number(
    (data.input_tokens_details as { cached_tokens?: unknown } | null)
      ?.cached_tokens ??
      (data.prompt_tokens_details as { cached_tokens?: unknown } | null)
        ?.cached_tokens ??
      data.cache_read_input_tokens ??
      data.cachedContentTokenCount ??
      data.prompt_cache_hit_tokens,
  );
  return {
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    inputTokens: input,
    outputTokens: output,
    totalTokens:
      number(data.total_tokens ?? data.totalTokenCount) ?? input + output,
  };
}

export function addTokenUsage(
  previous: MessageTokenUsage | undefined,
  next: MessageTokenUsage | undefined,
): MessageTokenUsage | undefined {
  if (!next) return previous;
  const cachedInputTokens =
    previous?.cachedInputTokens !== undefined ||
    next.cachedInputTokens !== undefined
      ? (previous?.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0)
      : undefined;
  return {
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    inputTokens: (previous?.inputTokens || 0) + next.inputTokens,
    outputTokens: (previous?.outputTokens || 0) + next.outputTokens,
    totalTokens: (previous?.totalTokens || 0) + next.totalTokens,
  };
}

export function parseStoredTokenUsage(
  raw: unknown,
): MessageTokenUsage | undefined {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return normalizeTokenUsage({
      input_tokens: value?.inputTokens,
      output_tokens: value?.outputTokens,
      total_tokens: value?.totalTokens,
      input_tokens_details: { cached_tokens: value?.cachedInputTokens },
    });
  } catch {
    return undefined;
  }
}
