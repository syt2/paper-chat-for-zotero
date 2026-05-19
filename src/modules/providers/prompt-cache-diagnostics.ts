type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface PromptCacheUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

const previousRequestByKey = new Map<string, string>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function canonicalizeForPromptCache(value: unknown): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForPromptCache(item));
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (typeof item === "undefined") {
        continue;
      }
      sorted[key] = canonicalizeForPromptCache(item);
    }
    return sorted;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}

export function stablePromptCacheStringify(value: unknown): string {
  return JSON.stringify(canonicalizeForPromptCache(value));
}

export function normalizePromptCacheTools<T>(tools: T[]): T[] {
  return canonicalizeForPromptCache(tools) as T[];
}

export function recordPromptCacheRequestShape(params: {
  providerId: string;
  model: string;
  requestKind: string;
  requestBody: Record<string, unknown>;
}): void {
  const key = `${params.providerId}:${params.model}:${params.requestKind}`;
  const current = stablePromptCacheStringify(params.requestBody);
  const previous = previousRequestByKey.get(key);
  previousRequestByKey.set(key, current);

  const estimatedTokens = estimatePromptCacheTokens(current);
  if (!previous) {
    ztoolkit.log(
      "[PromptCache] baseline",
      key,
      `chars=${current.length}`,
      `estimatedTokens=${estimatedTokens}`,
    );
    return;
  }

  const commonPrefixChars = countCommonPrefixChars(previous, current);
  const commonPrefixTokens = estimatePromptCacheTokens(
    current.slice(0, commonPrefixChars),
  );
  const ratio =
    current.length > 0
      ? Math.round((commonPrefixChars / current.length) * 1000) / 10
      : 100;
  ztoolkit.log(
    "[PromptCache] prefix",
    key,
    `stable=${ratio}%`,
    `commonChars=${commonPrefixChars}/${current.length}`,
    `commonTokens~${commonPrefixTokens}/${estimatedTokens}`,
    `firstDiff=${findFirstDifferencePath(previous, current)}`,
  );
}

export function logPromptCacheUsage(params: {
  providerId: string;
  model: string;
  requestKind: string;
  usage: unknown;
}): void {
  const usage = normalizePromptCacheUsage(params.usage);
  if (!usage) {
    return;
  }

  const billableInput = Math.max(
    0,
    (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0),
  );
  const hitRatio =
    usage.inputTokens && usage.inputTokens > 0
      ? Math.round(((usage.cacheReadTokens ?? 0) / usage.inputTokens) * 1000) /
        10
      : 0;
  ztoolkit.log(
    "[PromptCache] usage",
    `${params.providerId}:${params.model}:${params.requestKind}`,
    `input=${usage.inputTokens ?? 0}`,
    `output=${usage.outputTokens ?? 0}`,
    `cacheRead=${usage.cacheReadTokens ?? 0}`,
    `cacheCreate=${usage.cacheCreationTokens ?? 0}`,
    `billableInput~${billableInput}`,
    `hit=${hitRatio}%`,
  );
}

export function normalizePromptCacheUsage(
  usage: unknown,
): PromptCacheUsage | null {
  if (!isPlainObject(usage)) {
    return null;
  }
  const promptDetails = isPlainObject(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  const inputDetails = isPlainObject(usage.input_tokens_details)
    ? usage.input_tokens_details
    : {};

  return {
    inputTokens: readNumber(
      usage.input_tokens,
      usage.prompt_tokens,
      usage.total_input_tokens,
    ),
    outputTokens: readNumber(
      usage.output_tokens,
      usage.completion_tokens,
      usage.total_output_tokens,
    ),
    cacheReadTokens: readNumber(
      usage.cache_read_input_tokens,
      usage.cached_tokens,
      promptDetails.cached_tokens,
      inputDetails.cached_tokens,
      inputDetails.cache_read_tokens,
    ),
    cacheCreationTokens: readNumber(
      usage.cache_creation_input_tokens,
      usage.cache_write_input_tokens,
      usage.cache_created_input_tokens,
      promptDetails.cache_creation_tokens,
      inputDetails.cache_creation_tokens,
    ),
  };
}

function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function countCommonPrefixChars(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let i = 0; i < limit; i++) {
    if (left.charCodeAt(i) !== right.charCodeAt(i)) {
      return i;
    }
  }
  return limit;
}

function estimatePromptCacheTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const cjkMatches = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
  const cjkChars = cjkMatches?.length ?? 0;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars / 1.5 + otherChars / 4);
}

function findFirstDifferencePath(
  previousJson: string,
  currentJson: string,
): string {
  try {
    const previous = JSON.parse(previousJson);
    const current = JSON.parse(currentJson);
    return findFirstDifferencePathInValue(previous, current) || "<none>";
  } catch {
    return `char:${countCommonPrefixChars(previousJson, currentJson)}`;
  }
}

function findFirstDifferencePathInValue(
  previous: unknown,
  current: unknown,
  path = "$",
): string | null {
  if (Object.is(previous, current)) {
    return null;
  }
  if (Array.isArray(previous) || Array.isArray(current)) {
    if (!Array.isArray(previous) || !Array.isArray(current)) {
      return path;
    }
    const length = Math.max(previous.length, current.length);
    for (let i = 0; i < length; i++) {
      if (i >= previous.length || i >= current.length) {
        return `${path}[${i}]`;
      }
      const child = findFirstDifferencePathInValue(
        previous[i],
        current[i],
        `${path}[${i}]`,
      );
      if (child) {
        return child;
      }
    }
    return null;
  }
  if (isPlainObject(previous) || isPlainObject(current)) {
    if (!isPlainObject(previous) || !isPlainObject(current)) {
      return path;
    }
    const keys = Array.from(
      new Set([...Object.keys(previous), ...Object.keys(current)]),
    ).sort();
    for (const key of keys) {
      if (!(key in previous) || !(key in current)) {
        return `${path}.${key}`;
      }
      const child = findFirstDifferencePathInValue(
        previous[key],
        current[key],
        `${path}.${key}`,
      );
      if (child) {
        return child;
      }
    }
    return null;
  }
  return path;
}
