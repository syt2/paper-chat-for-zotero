import { assert } from "chai";
import { parseModelRoutingConfig } from "../src/modules/providers/paperchat-routing-metadata";
import {
  PAPERCHAT_TIERS,
  deriveTierPools,
} from "../src/modules/providers/paperchat-tier-routing";
import {
  getDeclaredUpgradeModels,
  getMissingUpgradeModels,
} from "../src/modules/preferences/paperchat-upgrade-models";

/**
 * The routing payload every account receives. `upgradeOnly` is the admin's
 * declaration that a route needs a purchase; the relay's own model list decides
 * whether an account still misses it.
 */
const ROUTING = parseModelRoutingConfig({
  models: {
    "standard-model": { tier: "standard", priority: 1 },
    "paid-pro-model": { tier: "pro", priority: 2, upgradeOnly: true },
    "paid-ultra-model": { tier: "ultra", priority: 1, upgradeOnly: true },
    "not-declared": { tier: "ultra", priority: 1 },
    "string-flag": { tier: "pro", priority: 1, upgradeOnly: "true" },
  },
});

describe("purchase-only model hint", function () {
  it("collects the declared routes in tier-ladder order", function () {
    assert.deepEqual(getDeclaredUpgradeModels(ROUTING), [
      "paid-pro-model",
      "paid-ultra-model",
    ]);
  });

  it("only accepts an explicit boolean flag", function () {
    // A string is not a declaration, so the route keeps its normal path.
    assert.equal(ROUTING["string-flag"].upgradeOnly, undefined);
    assert.equal(ROUTING["not-declared"].upgradeOnly, undefined);
  });

  it("reports only the declared routes the account is missing", function () {
    const declared = getDeclaredUpgradeModels(ROUTING);

    // A paying account already has both, so nothing is advertised.
    assert.deepEqual(
      getMissingUpgradeModels(declared, ["paid-pro-model", "paid-ultra-model"]),
      [],
    );

    // A free account has neither, and its list also covers models the routing
    // config does not describe.
    assert.deepEqual(
      getMissingUpgradeModels(declared, ["standard-model", "unlisted-model"]),
      ["paid-pro-model", "paid-ultra-model"],
    );

    // Partially unlocked: only the route the account still misses is reported.
    assert.deepEqual(getMissingUpgradeModels(declared, ["paid-pro-model"]), [
      "paid-ultra-model",
    ]);
  });

  it("stays quiet while the account's model list is unknown", function () {
    const declared = getDeclaredUpgradeModels(ROUTING);

    // An empty list means "not fetched yet", not "has nothing": advertising the
    // upgrade there would tell a paying account to buy what it already owns.
    assert.deepEqual(getMissingUpgradeModels(declared, []), []);
  });

  it("says nothing when no route is declared", function () {
    const plain = parseModelRoutingConfig({
      models: { "standard-model": { tier: "standard" } },
    });

    assert.deepEqual(getDeclaredUpgradeModels(plain), []);
    assert.deepEqual(getMissingUpgradeModels([], ["standard-model"]), []);
  });

  it("lists a missing route under the tier the config gives it", function () {
    const missing = getMissingUpgradeModels(getDeclaredUpgradeModels(ROUTING), [
      "standard-model",
    ]);
    // Cheap enough for lite under the ratio thresholds, but the routing config
    // calls it pro: the lock belongs where the model shows up once the account
    // has it.
    const ratios = { "paid-pro-model": 0.2, "paid-ultra-model": 3.5 };

    const pools = deriveTierPools(missing, ratios, ROUTING);

    assert.deepEqual(pools["paperchat-pro"], ["paid-pro-model"]);
    assert.deepEqual(pools["paperchat-ultra"], ["paid-ultra-model"]);
    assert.deepEqual(pools["paperchat-lite"], []);
    assert.deepEqual(pools["paperchat-standard"], []);
    for (const tier of PAPERCHAT_TIERS) {
      assert.isArray(pools[tier], tier);
    }
  });
});
