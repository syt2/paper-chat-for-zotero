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
): number | undefined {
  let lowest: number | undefined;
  for (const group of groups) {
    const ratio = groupRatios[group] ?? 1;
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

export function getEffectivePricingModelRatio(
  item: Record<string, unknown>,
  context: {
    groupRatio?: unknown;
    usableGroup?: unknown;
    autoGroups?: unknown;
  } = {},
): number | undefined {
  const modelRatio = getPricingModelRatio(item);
  if (modelRatio === undefined) {
    return undefined;
  }

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

  const selectedGroupRatio = getLowestGroupRatio(candidateGroups, groupRatios);
  return roundRatio(modelRatio * (selectedGroupRatio ?? 1));
}
