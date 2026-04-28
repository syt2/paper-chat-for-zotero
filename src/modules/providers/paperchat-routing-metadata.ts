import type { PaperChatTier, PaperChatTierPools } from "./paperchat-tier-routing";

export interface PaperChatModelRoutingMeta {
  ratio?: number;
  tierCode?: number;
  priority?: number;
}

export type PaperChatModelRoutingMetaMap = Record<
  string,
  PaperChatModelRoutingMeta
>;

const TIER_CODE_TO_TIER: Record<number, PaperChatTier> = {
  1: "paperchat-lite",
  2: "paperchat-standard",
  3: "paperchat-pro",
  4: "paperchat-ultra",
};

const ROUTING_TIER_TO_CODE: Record<string, number> = {
  lite: 1,
  "paperchat-lite": 1,
  standard: 2,
  "paperchat-standard": 2,
  pro: 3,
  "paperchat-pro": 3,
  ultra: 4,
  "paperchat-ultra": 4,
};

export function parseModelRoutingConfig(
  value: unknown,
): PaperChatModelRoutingMetaMap {
  if (!value || typeof value !== "object") {
    return {};
  }

  const rawModels = (value as { models?: unknown }).models;
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) {
    return {};
  }

  const routingMeta: PaperChatModelRoutingMetaMap = {};
  for (const [modelName, rawMeta] of Object.entries(rawModels)) {
    if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
      continue;
    }

    const metaRecord = rawMeta as { tier?: unknown; priority?: unknown };
    const tier =
      typeof metaRecord.tier === "string"
        ? metaRecord.tier.trim().toLowerCase()
        : "";
    const tierCode = ROUTING_TIER_TO_CODE[tier];
    const priority =
      typeof metaRecord.priority === "number" && Number.isFinite(metaRecord.priority)
        ? metaRecord.priority
        : typeof metaRecord.priority === "string" &&
            metaRecord.priority.trim().length > 0
          ? Number(metaRecord.priority)
          : undefined;

    const meta: PaperChatModelRoutingMeta = {};
    if (tierCode !== undefined) {
      meta.tierCode = tierCode;
    }
    if (typeof priority === "number" && Number.isFinite(priority)) {
      meta.priority = priority;
    }

    if (meta.tierCode !== undefined || meta.priority !== undefined) {
      routingMeta[modelName] = meta;
    }
  }

  return routingMeta;
}

export function getRoutingPriorityWeight(
  model: string,
  routingMeta: PaperChatModelRoutingMetaMap = {},
): number {
  const priority = routingMeta[model]?.priority;
  if (typeof priority !== "number" || !Number.isFinite(priority)) {
    return 1;
  }

  return priority > 0 ? priority : 1;
}

export function buildRoutingWeights(
  candidates: string[],
  routingMeta: PaperChatModelRoutingMetaMap = {},
): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const candidate of candidates) {
    weights[candidate] = getRoutingPriorityWeight(candidate, routingMeta);
  }
  return weights;
}

export function hasCompleteRoutingTierCoverage(
  models: string[],
  routingMeta: PaperChatModelRoutingMetaMap,
): boolean {
  return models.every((model) => {
    return getRoutingTier(model, routingMeta) !== undefined;
  });
}

export function hasAnyRoutingTierCoverage(
  models: string[],
  routingMeta: PaperChatModelRoutingMetaMap,
): boolean {
  return models.some((model) => getRoutingTier(model, routingMeta) !== undefined);
}

export function getRoutingTier(
  model: string,
  routingMeta: PaperChatModelRoutingMetaMap,
): PaperChatTier | undefined {
  const tierCode = routingMeta[model]?.tierCode;
  return typeof tierCode === "number" ? TIER_CODE_TO_TIER[tierCode] : undefined;
}

export function deriveRoutingMetaTierPools(
  models: string[],
  routingMeta: PaperChatModelRoutingMetaMap,
): PaperChatTierPools {
  if (models.length === 0) {
    return {
      "paperchat-lite": [],
      "paperchat-standard": [],
      "paperchat-pro": [],
      "paperchat-ultra": [],
    };
  }

  const sortedModels = [...models].sort((a, b) => {
    const priorityDelta =
      getRoutingPriorityWeight(b, routingMeta) -
      getRoutingPriorityWeight(a, routingMeta);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return a.localeCompare(b);
  });
  const pools: PaperChatTierPools = {
    "paperchat-lite": [],
    "paperchat-standard": [],
    "paperchat-pro": [],
    "paperchat-ultra": [],
  };

  for (const model of sortedModels) {
    const tier = getRoutingTier(model, routingMeta);
    if (tier) {
      pools[tier].push(model);
    }
  }

  return pools;
}
