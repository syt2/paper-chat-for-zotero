import {
  sortModelsByTierThenWeight,
  type PaperChatModelRoutingMetaMap,
} from "../providers/paperchat-routing-metadata";

/**
 * Routes the admin marked as needing a purchase, ordered the way the tier
 * pickers read so the hint and the locked entries agree with the ladder.
 */
export function getDeclaredUpgradeModels(
  routingMeta: PaperChatModelRoutingMetaMap,
): string[] {
  const declared = Object.entries(routingMeta)
    .filter(([, meta]) => meta?.upgradeOnly === true)
    .map(([model]) => model);

  return sortModelsByTierThenWeight(declared, routingMeta);
}

/**
 * Declared routes this account does not have.
 *
 * The account's own model list comes from the relay, which only reports models
 * the account's group may use, so a declared route missing from that list is
 * one a purchase would have to unlock.
 *
 * An empty model list means the list is not known yet. Reporting every declared
 * route as locked in that state would advertise the upgrade to accounts that
 * may already own it, so nothing is reported instead.
 */
export function getMissingUpgradeModels(
  declaredModels: readonly string[],
  availableModels: readonly string[],
): string[] {
  if (availableModels.length === 0) {
    return [];
  }

  const available = new Set(availableModels);
  return declaredModels.filter((model) => !available.has(model));
}
