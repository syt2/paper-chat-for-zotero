function getPricingModelRatio(
  item: Record<string, unknown>,
): number | undefined {
  const value = item.model_ratio ?? item.ModelRatio;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function getPricingEnableGroups(item: Record<string, unknown>): string[] {
  const value = item.enable_groups ?? item.EnableGroup;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((group): group is string => typeof group === "string")
    .map((group) => group.trim())
    .filter(Boolean);
}

function toStringSet(value: unknown): Set<string> {
  if (Array.isArray(value)) {
    return new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }

  if (value && typeof value === "object") {
    return new Set(
      Object.keys(value as Record<string, unknown>).filter(
        (key) => key.length > 0,
      ),
    );
  }

  return new Set();
}

function toNumberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const map: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim().length > 0
          ? Number(raw)
          : undefined;
    if (typeof parsed === "number" && Number.isFinite(parsed)) {
      map[key] = parsed;
    }
  }
  return map;
}

function intersectGroups(groups: string[], allowed: Set<string>): string[] {
  return groups.filter((group) => allowed.has(group));
}

function getLowestGroupRatio(
  groups: string[],
  groupRatios: Record<string, number>,
  requireKnownRatios = false,
): number | undefined {
  let lowest: number | undefined;
  for (const group of groups) {
    // A missing billing ratio is safe to default for legacy routing, but must
    // not be presented to the user as a confirmed discount.
    if (requireKnownRatios && !(group in groupRatios)) {
      return undefined;
    }
    const ratio = groupRatios[group] ?? 1;
    if (requireKnownRatios && ratio < 0) {
      return undefined;
    }
    if (!Number.isFinite(ratio)) {
      continue;
    }
    if (lowest === undefined || ratio < lowest) {
      lowest = ratio;
    }
  }
  return lowest;
}

function roundRatio(value: number): number {
  return Number(value.toFixed(4));
}

interface PricingGroupContext {
  groupRatio?: unknown;
  usableGroup?: unknown;
  autoGroups?: unknown;
}

function resolvePricingModelGroupRatio(
  item: Record<string, unknown>,
  context: PricingGroupContext,
  requireKnownRatios: boolean,
): number | undefined {
  const usableGroups = toStringSet(context.usableGroup);
  const autoGroups = toStringSet(context.autoGroups);
  const groupRatios = toNumberMap(context.groupRatio);
  const enableGroups = getPricingEnableGroups(item);
  const modelGroups = enableGroups.includes("all")
    ? [...usableGroups]
    : enableGroups;

  let candidateGroups = intersectGroups(modelGroups, autoGroups);
  if (candidateGroups.length === 0) {
    candidateGroups = intersectGroups(modelGroups, usableGroups);
  }

  return getLowestGroupRatio(candidateGroups, groupRatios, requireKnownRatios);
}

/** The group multiplier alone, for comparison with the model's standard price. */
export function getPricingModelGroupRatio(
  item: Record<string, unknown>,
  context: PricingGroupContext = {},
): number | undefined {
  return resolvePricingModelGroupRatio(item, context, true);
}

export function getEffectivePricingModelRatio(
  item: Record<string, unknown>,
  context: PricingGroupContext = {},
): number | undefined {
  const modelRatio = getPricingModelRatio(item);
  if (modelRatio === undefined) {
    return undefined;
  }
  const selectedGroupRatio = resolvePricingModelGroupRatio(
    item,
    context,
    false,
  );
  return roundRatio(modelRatio * (selectedGroupRatio ?? 1));
}
