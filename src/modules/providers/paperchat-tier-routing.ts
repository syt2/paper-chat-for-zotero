export const PAPERCHAT_TIERS = [
  "paperchat-lite",
  "paperchat-standard",
  "paperchat-pro",
] as const;

export type PaperChatTier = (typeof PAPERCHAT_TIERS)[number];
export type PaperChatTierMode = "auto" | "manual";

export interface PaperChatTierEntry {
  mode: PaperChatTierMode;
  modelId: string | null;
}

export interface PaperChatTierState {
  selectedTier: PaperChatTier;
  tiers: Record<PaperChatTier, PaperChatTierEntry>;
}

export type PaperChatTierPools = Record<PaperChatTier, string[]>;

export type PickRandom = (candidates: string[]) => string | null | undefined;

const DEFAULT_SELECTED_TIER: PaperChatTier = "paperchat-standard";
const STANDARD_MIN_RATIO = 0.51;
const PRO_MIN_RATIO = 1.01;

function isPaperChatTier(value: unknown): value is PaperChatTier {
  return (
    typeof value === "string" &&
    (PAPERCHAT_TIERS as readonly string[]).includes(value)
  );
}

function normalizeModelId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function defaultPickRandom(candidates: string[]): string | null {
  if (candidates.length === 0) {
    return null;
  }
  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index] ?? null;
}

function pickCandidate(
  candidates: string[],
  pickRandom: PickRandom,
): string | null {
  if (candidates.length === 0) {
    return null;
  }

  const picked = pickRandom(candidates);
  if (typeof picked === "string" && candidates.includes(picked)) {
    return picked;
  }

  return candidates[0] ?? null;
}

function dedupeModels(models: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const model of models) {
    if (typeof model !== "string" || model.length === 0 || seen.has(model)) {
      continue;
    }
    seen.add(model);
    unique.push(model);
  }

  return unique;
}

function hasCompleteRatioCoverage(
  models: string[],
  ratios: Record<string, number>,
): boolean {
  return models.every((model) => Number.isFinite(ratios[model]));
}

function sortModelsByRatio(models: string[], ratios: Record<string, number>): string[] {
  return [...models].sort((a, b) => {
    const ratioA = ratios[a] ?? 0;
    const ratioB = ratios[b] ?? 0;

    if (ratioA !== ratioB) {
      return ratioA - ratioB;
    }

    return a.localeCompare(b);
  });
}

function createDefaultEntry(): PaperChatTierEntry {
  return {
    mode: "auto",
    modelId: null,
  };
}

function createDefaultState(): PaperChatTierState {
  return {
    selectedTier: DEFAULT_SELECTED_TIER,
    tiers: {
      "paperchat-lite": createDefaultEntry(),
      "paperchat-standard": createDefaultEntry(),
      "paperchat-pro": createDefaultEntry(),
    },
  };
}

export function deriveTierPools(
  models: string[],
  ratios: Record<string, number>,
): PaperChatTierPools {
  const availableModels = dedupeModels(models);
  const count = availableModels.length;

  if (count === 0) {
    return {
      "paperchat-lite": [],
      "paperchat-standard": [],
      "paperchat-pro": [],
    };
  }

  if (!hasCompleteRatioCoverage(availableModels, ratios)) {
    return {
      "paperchat-lite": [...availableModels],
      "paperchat-standard": [...availableModels],
      "paperchat-pro": [...availableModels],
    };
  }

  const sortedModels = sortModelsByRatio(availableModels, ratios);
  const fallbackModel = sortedModels[sortedModels.length - 1];
  const liteModels = sortedModels.filter(
    (model) => ratios[model] < STANDARD_MIN_RATIO,
  );
  const standardModels = sortedModels.filter((model) => {
    const ratio = ratios[model];
    return ratio >= STANDARD_MIN_RATIO && ratio <= PRO_MIN_RATIO;
  });
  const proModels = sortedModels.filter((model) => ratios[model] > PRO_MIN_RATIO);

  return {
    "paperchat-lite": liteModels.length > 0 ? liteModels : [fallbackModel],
    "paperchat-standard": standardModels.length > 0 ? standardModels : [fallbackModel],
    "paperchat-pro": proModels.length > 0 ? proModels : [fallbackModel],
  };
}

export function parseTierState(raw: unknown): PaperChatTierState {
  const defaults = createDefaultState();

  if (raw === null || raw === undefined) {
    return defaults;
  }

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return defaults;
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return defaults;
  }

  const parsedState = parsed as {
    selectedTier?: unknown;
    tiers?: Record<string, { mode?: unknown; modelId?: unknown }>;
  };

  const selectedTier = isPaperChatTier(parsedState.selectedTier)
    ? parsedState.selectedTier
    : defaults.selectedTier;

  const tiers = {} as Record<PaperChatTier, PaperChatTierEntry>;

  for (const tier of PAPERCHAT_TIERS) {
    const rawEntry = parsedState.tiers?.[tier];
    tiers[tier] = {
      mode: rawEntry?.mode === "manual" ? "manual" : "auto",
      modelId: normalizeModelId(rawEntry?.modelId),
    };
  }

  return {
    selectedTier,
    tiers,
  };
}

export function rerollTierModel(
  candidates: string[],
  excludedModelId: string | null,
  pickRandom: PickRandom,
): string | null {
  const uniqueCandidates = dedupeModels(candidates).filter(
    (candidate) => candidate !== excludedModelId,
  );

  return pickCandidate(uniqueCandidates, pickRandom);
}

export function isPaperChatModelHardFailure(error: Error): boolean {
  const message = error.message.toLowerCase();
  return message.includes("model not found") || message.includes("unsupported model");
}

export function validateTierState(
  state: unknown,
  models: string[],
  ratios: Record<string, number>,
  pickRandom: PickRandom = defaultPickRandom,
): PaperChatTierState {
  const parsedState = parseTierState(state);
  const availableModels = dedupeModels(models);
  const availableSet = new Set(availableModels);
  const pools = deriveTierPools(availableModels, ratios);

  const normalizedTiers = {} as Record<PaperChatTier, PaperChatTierEntry>;

  for (const tier of PAPERCHAT_TIERS) {
    const current = parsedState.tiers[tier];
    const currentModel = current.modelId;

    if (
      current.mode === "manual" &&
      currentModel !== null &&
      availableSet.has(currentModel)
    ) {
      normalizedTiers[tier] = {
        mode: "manual",
        modelId: currentModel,
      };
      continue;
    }

    const stickyAutoModel =
      current.mode === "auto" &&
      currentModel !== null &&
      availableSet.has(currentModel)
        ? currentModel
        : null;

    normalizedTiers[tier] = {
      mode: "auto",
      modelId:
        stickyAutoModel ?? pickCandidate(pools[tier], pickRandom),
    };
  }

  return {
    selectedTier: parsedState.selectedTier,
    tiers: normalizedTiers,
  };
}

function deriveEffectiveTierPools(
  state: PaperChatTierState,
  models: string[],
  ratios: Record<string, number>,
): PaperChatTierPools {
  const availableModels = dedupeModels(models);
  const availableSet = new Set(availableModels);
  const basePools = deriveTierPools(availableModels, ratios);

  const effectivePools = {} as PaperChatTierPools;

  for (const tier of PAPERCHAT_TIERS) {
    const entry = state.tiers[tier];
    const pool = [...basePools[tier]];

    if (
      entry.mode === "auto" &&
      entry.modelId !== null &&
      availableSet.has(entry.modelId) &&
      !pool.includes(entry.modelId)
    ) {
      pool.unshift(entry.modelId);
    }

    effectivePools[tier] = pool;
  }

  return effectivePools;
}

export function resolveTierModel(
  state: unknown,
  tier: PaperChatTier,
  models: string[],
  ratios: Record<string, number>,
  pickRandom: PickRandom = defaultPickRandom,
): {
  state: PaperChatTierState;
  modelId: string | null;
  pools: PaperChatTierPools;
} {
  const validatedState = validateTierState(state, models, ratios, pickRandom);
  const pools = deriveEffectiveTierPools(validatedState, models, ratios);

  return {
    state: validatedState,
    modelId: validatedState.tiers[tier].modelId,
    pools,
  };
}

export function resolveSelectedTierModel(
  state: unknown,
  models: string[],
  ratios: Record<string, number>,
  pickRandom: PickRandom = defaultPickRandom,
): {
  state: PaperChatTierState;
  selectedTier: PaperChatTier;
  modelId: string | null;
  pools: PaperChatTierPools;
} {
  const parsedState = parseTierState(state);
  const selectedTier = parsedState.selectedTier;
  const resolved = resolveTierModel(
    parsedState,
    selectedTier,
    models,
    ratios,
    pickRandom,
  );

  return {
    state: resolved.state,
    selectedTier,
    modelId: resolved.modelId,
    pools: resolved.pools,
  };
}
