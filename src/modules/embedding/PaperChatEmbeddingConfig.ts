import { getPref } from "../../utils/prefs";

export interface PaperChatEmbeddingConfig {
  models: string[];
  defaultModel?: string;
}

export function parsePaperChatEmbeddingConfig(
  value: unknown,
): PaperChatEmbeddingConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.models) ||
    record.models.some((model) => typeof model !== "string" || !model.trim())
  )
    return null;
  const models = [
    ...new Set((record.models as string[]).map((model) => model.trim())),
  ];
  const defaultModel =
    typeof record.defaultModel === "string"
      ? record.defaultModel.trim()
      : undefined;
  return {
    models,
    ...(defaultModel && models.includes(defaultModel) ? { defaultModel } : {}),
  };
}

export function getPaperChatEmbeddingConfig(): PaperChatEmbeddingConfig | null {
  try {
    return parsePaperChatEmbeddingConfig(
      JSON.parse(getPref("paperchatEmbeddingConfigCache") || "null"),
    );
  } catch {
    return null;
  }
}
