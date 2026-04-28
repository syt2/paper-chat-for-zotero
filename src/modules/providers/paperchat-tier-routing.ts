import { parsePaperChatError } from "./paperchat-errors";
import {
  buildRoutingWeights,
  deriveRoutingMetaTierPools,
  getRoutingTier,
  hasAnyRoutingTierCoverage,
  hasCompleteRoutingTierCoverage,
  type PaperChatModelRoutingMetaMap,
} from "./paperchat-routing-metadata";

export const PAPERCHAT_TIERS = [
  "paperchat-lite",
  "paperchat-standard",
  "paperchat-pro",
  "paperchat-ultra",
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

export type PickRandom = (
  candidates: string[],
  weights?: Record<string, number>,
) => string | null | undefined;

const DEFAULT_SELECTED_TIER: PaperChatTier = "paperchat-pro";
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

export function getAvailablePaperChatTiers(
  pools: PaperChatTierPools,
): PaperChatTier[] {
  return PAPERCHAT_TIERS.filter((tier) => pools[tier].length > 0);
}

function getFirstAvailablePaperChatTier(
  pools: PaperChatTierPools,
): PaperChatTier | null {
  return getAvailablePaperChatTiers(pools)[0] ?? null;
}

function defaultPickRandom(
  candidates: string[],
  weights: Record<string, number> = {},
): string | null {
  if (candidates.length === 0) {
    return null;
  }

  let totalWeight = 0;
  for (const candidate of candidates) {
    const weight = weights[candidate] ?? 1;
    if (Number.isFinite(weight) && weight > 0) {
      totalWeight += weight;
    }
  }

  if (totalWeight <= 0) {
    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index] ?? null;
  }

  let cursor = Math.random() * totalWeight;
  for (const candidate of candidates) {
    const weight = weights[candidate] ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }
    cursor -= weight;
    if (cursor < 0) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1] ?? null;
}

function pickCandidate(
  candidates: string[],
  pickRandom: PickRandom,
  routingMeta: PaperChatModelRoutingMetaMap = {},
): string | null {
  if (candidates.length === 0) {
    return null;
  }

  const picked = pickRandom(
    candidates,
    buildRoutingWeights(candidates, routingMeta),
  );
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

function sortModelsByRatio(
  models: string[],
  ratios: Record<string, number>,
): string[] {
  return [...models].sort((a, b) => {
    const ratioA = ratios[a] ?? 0;
    const ratioB = ratios[b] ?? 0;

    if (ratioA !== ratioB) {
      return ratioA - ratioB;
    }

    return a.localeCompare(b);
  });
}

function createEmptyTierPools(): PaperChatTierPools {
  return {
    "paperchat-lite": [],
    "paperchat-standard": [],
    "paperchat-pro": [],
    "paperchat-ultra": [],
  };
}

function deriveRatioTierPools(
  availableModels: string[],
  ratios: Record<string, number>,
): PaperChatTierPools {
  if (availableModels.length === 0) {
    return createEmptyTierPools();
  }

  if (!hasCompleteRatioCoverage(availableModels, ratios)) {
    return {
      "paperchat-lite": [...availableModels],
      "paperchat-standard": [...availableModels],
      "paperchat-pro": [...availableModels],
      "paperchat-ultra": [...availableModels],
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
    "paperchat-ultra": [],
  };
}

function deriveMixedTierPools(
  availableModels: string[],
  ratios: Record<string, number>,
  routingMeta: PaperChatModelRoutingMetaMap,
): PaperChatTierPools {
  const metadataModels = availableModels.filter(
    (model) => getRoutingTier(model, routingMeta) !== undefined,
  );
  const legacyModels = availableModels.filter(
    (model) => getRoutingTier(model, routingMeta) === undefined,
  );

  const pools = createEmptyTierPools();
  const addModel = (tier: PaperChatTier, model: string) => {
    if (!pools[tier].includes(model)) {
      pools[tier].push(model);
    }
  };

  if (legacyModels.length > 0) {
    const legacyPools = deriveRatioTierPools(legacyModels, ratios);
    for (const tier of PAPERCHAT_TIERS) {
      for (const model of legacyPools[tier]) {
        addModel(tier, model);
      }
    }
  }

  const weights = buildRoutingWeights(metadataModels, routingMeta);
  const sortedMetadataModels = [...metadataModels].sort((a, b) => {
    const priorityDelta = (weights[b] ?? 1) - (weights[a] ?? 1);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return a.localeCompare(b);
  });
  for (const model of sortedMetadataModels) {
    const tier = getRoutingTier(model, routingMeta);
    if (tier) {
      addModel(tier, model);
    }
  }

  return pools;
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
      "paperchat-ultra": createDefaultEntry(),
    },
  };
}

export function deriveTierPools(
  models: string[],
  ratios: Record<string, number>,
  routingMeta: PaperChatModelRoutingMetaMap = {},
): PaperChatTierPools {
  const availableModels = dedupeModels(models);
  const count = availableModels.length;

  if (count === 0) {
    return {
      "paperchat-lite": [],
      "paperchat-standard": [],
      "paperchat-pro": [],
      "paperchat-ultra": [],
    };
  }

  if (hasCompleteRoutingTierCoverage(availableModels, routingMeta)) {
    return deriveRoutingMetaTierPools(availableModels, routingMeta);
  }

  if (hasAnyRoutingTierCoverage(availableModels, routingMeta)) {
    return deriveMixedTierPools(availableModels, ratios, routingMeta);
  }

  return deriveRatioTierPools(availableModels, ratios);
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
  routingMeta: PaperChatModelRoutingMetaMap = {},
): string | null {
  const uniqueCandidates = dedupeModels(candidates).filter(
    (candidate) => candidate !== excludedModelId,
  );

  return pickCandidate(uniqueCandidates, pickRandom, routingMeta);
}

export function isPaperChatModelHardFailure(error: Error): boolean {
  const { message, code } = parsePaperChatError(error.message);
  const normalized = `${error.message}\n${message}\n${code || ""}`.toLowerCase();

  return (
    code === "model_not_found" ||
    code === "unsupported_model" ||
    normalized.includes("model not found") ||
    normalized.includes("unsupported model") ||
    normalized.includes("无可用渠道")
  );
}

export function validateTierState(
  state: unknown,
  models: string[],
  ratios: Record<string, number>,
  pickRandom: PickRandom = defaultPickRandom,
  routingMeta: PaperChatModelRoutingMetaMap = {},
): PaperChatTierState {
  const parsedState = parseTierState(state);
  const availableModels = dedupeModels(models);
  const availableSet = new Set(availableModels);
  const pools = deriveTierPools(availableModels, ratios, routingMeta);

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
        stickyAutoModel ?? pickCandidate(pools[tier], pickRandom, routingMeta),
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
  routingMeta: PaperChatModelRoutingMetaMap = {},
): PaperChatTierPools {
  const availableModels = dedupeModels(models);
  const availableSet = new Set(availableModels);
  const basePools = deriveTierPools(availableModels, ratios, routingMeta);

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
  routingMeta: PaperChatModelRoutingMetaMap = {},
): {
  state: PaperChatTierState;
  modelId: string | null;
  pools: PaperChatTierPools;
} {
  const validatedState = validateTierState(
    state,
    models,
    ratios,
    pickRandom,
    routingMeta,
  );
  const pools = deriveEffectiveTierPools(
    validatedState,
    models,
    ratios,
    routingMeta,
  );
  const effectiveTier =
    pools[tier]?.length > 0
      ? tier
      : (getFirstAvailablePaperChatTier(pools) ?? tier);

  return {
    state: {
      ...validatedState,
      selectedTier: effectiveTier,
    },
    modelId: validatedState.tiers[effectiveTier].modelId,
    pools,
  };
}

export function resolveSelectedTierModel(
  state: unknown,
  models: string[],
  ratios: Record<string, number>,
  pickRandom: PickRandom = defaultPickRandom,
  routingMeta: PaperChatModelRoutingMetaMap = {},
): {
  state: PaperChatTierState;
  selectedTier: PaperChatTier;
  modelId: string | null;
  pools: PaperChatTierPools;
} {
  const parsedState = parseTierState(state);
  const resolved = resolveTierModel(
    parsedState,
    parsedState.selectedTier,
    models,
    ratios,
    pickRandom,
    routingMeta,
  );

  return {
    state: resolved.state,
    selectedTier: resolved.state.selectedTier,
    modelId: resolved.modelId,
    pools: resolved.pools,
  };
}
