/**
 * Count the models the account can actually use after the PaperChat routing
 * whitelist is applied. Duplicate ids are ignored on both sides.
 */
export function countIntersectingPaperchatModels(
  keyModels: readonly string[],
  routingModels: readonly string[],
): number {
  const routing = new Set(
    routingModels.filter(
      (model): model is string => typeof model === "string" && model.length > 0,
    ),
  );
  return new Set(
    keyModels.filter(
      (model): model is string =>
        typeof model === "string" && routing.has(model),
    ),
  ).size;
}

/**
 * Use the routing intersection when fresh routing metadata was applied. If
 * routing could not be fetched, keep the raw relay count instead of showing a
 * misleading zero.
 */
export function getPaperchatLoadedModelCount(
  keyModels: readonly string[],
  routingModels: readonly string[],
  routingMetaApplied: boolean,
): number {
  return routingMetaApplied
    ? countIntersectingPaperchatModels(keyModels, routingModels)
    : keyModels.length;
}
