import type {
  PaperChatTier,
  PaperChatTierPools,
} from "./paperchat-tier-routing";
import type {
  ModelReasoningCapability,
  ReasoningEffort,
  ReasoningProtocol,
} from "../../types/provider";

export interface PaperChatModelRoutingMeta {
  ratio?: number;
  tierCode?: number;
  priority?: number;
  contextWindow?: number;
  maxOutput?: number;
  apiCapabilities?: {
    responses?: boolean;
    hostedWebSearch?: boolean;
    reasoning?: ModelReasoningCapability;
  };
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

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function parseReasoningCapability(
  value: unknown,
): ModelReasoningCapability | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record.protocol !== "openai" && record.protocol !== "deepseek") {
    return undefined;
  }
  if (!Array.isArray(record.efforts)) {
    return undefined;
  }

  const efforts = record.efforts.filter(
    (effort): effort is ReasoningEffort =>
      typeof effort === "string" &&
      REASONING_EFFORTS.has(effort as ReasoningEffort),
  );
  if (efforts.length === 0) {
    return undefined;
  }

  const uniqueEfforts = [...new Set(efforts)];
  const defaultEffort =
    typeof record.default === "string" &&
    REASONING_EFFORTS.has(record.default as ReasoningEffort) &&
    uniqueEfforts.includes(record.default as ReasoningEffort)
      ? (record.default as ReasoningEffort)
      : undefined;
  if (!defaultEffort) {
    return undefined;
  }

  return {
    protocol: record.protocol as ReasoningProtocol,
    efforts: uniqueEfforts,
    default: defaultEffort,
  };
}

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

    const metaRecord = rawMeta as {
      tier?: unknown;
      priority?: unknown;
      contextWindow?: unknown;
      maxOutput?: unknown;
      apiCapabilities?: unknown;
    };
    const tier =
      typeof metaRecord.tier === "string"
        ? metaRecord.tier.trim().toLowerCase()
        : "";
    const tierCode = ROUTING_TIER_TO_CODE[tier];
    const priority =
      typeof metaRecord.priority === "number" &&
      Number.isFinite(metaRecord.priority)
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
    if (
      typeof metaRecord.contextWindow === "number" &&
      Number.isFinite(metaRecord.contextWindow) &&
      metaRecord.contextWindow > 0
    ) {
      meta.contextWindow = metaRecord.contextWindow;
    }
    if (
      typeof metaRecord.maxOutput === "number" &&
      Number.isFinite(metaRecord.maxOutput) &&
      metaRecord.maxOutput > 0
    ) {
      meta.maxOutput = metaRecord.maxOutput;
    }
    if (
      metaRecord.apiCapabilities &&
      typeof metaRecord.apiCapabilities === "object" &&
      !Array.isArray(metaRecord.apiCapabilities)
    ) {
      const capabilities = metaRecord.apiCapabilities as Record<
        string,
        unknown
      >;
      const responses = capabilities.responses === true;
      const reasoning = parseReasoningCapability(capabilities.reasoning);
      if (responses || reasoning) {
        meta.apiCapabilities = {
          responses,
          hostedWebSearch: responses && capabilities.hostedWebSearch === true,
          ...(reasoning ? { reasoning } : {}),
        };
      }
    }

    if (
      meta.tierCode !== undefined ||
      meta.priority !== undefined ||
      meta.contextWindow !== undefined ||
      meta.maxOutput !== undefined ||
      meta.apiCapabilities !== undefined
    ) {
      routingMeta[modelName] = meta;
    }
  }

  return routingMeta;
}

export function getPaperChatApiCapabilities(
  model: string,
  routingMeta: PaperChatModelRoutingMetaMap,
): {
  responses: boolean;
  hostedWebSearch: boolean;
  reasoning?: ModelReasoningCapability;
} {
  const capabilities = routingMeta[model]?.apiCapabilities;
  return {
    responses: capabilities?.responses === true,
    hostedWebSearch: capabilities?.hostedWebSearch === true,
    reasoning: capabilities?.reasoning,
  };
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
  return models.some(
    (model) => getRoutingTier(model, routingMeta) !== undefined,
  );
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
