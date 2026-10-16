import { assert } from "chai";
import { parseModelRoutingConfig } from "../src/modules/providers/paperchat-routing-metadata";
import {
  PAPERCHAT_TIERS,
  deriveTierPools,
  getAvailablePaperChatTiers,
  getFallbackPaperChatTier,
  parseTierState,
} from "../src/modules/providers/paperchat-tier-routing";

/**
 * The free / discounted tier is declared by the admin with `tier: promo`; the
 * ratio fallback never assigns it, because a model does not become a
 * limited-time freebie just because it is cheap.
 */
const ROUTING = parseModelRoutingConfig({
  models: {
    "promo-model": { tier: "promo", priority: 1 },
    "lite-model": { tier: "lite", priority: 1 },
    "standard-model": { tier: "standard", priority: 1 },
  },
});

describe("free / discounted tier", function () {
  it("sits at the bottom of the ladder", function () {
    assert.deepEqual(
      [...PAPERCHAT_TIERS],
      [
        "paperchat-promo",
        "paperchat-lite",
        "paperchat-standard",
        "paperchat-pro",
        "paperchat-ultra",
      ],
    );
  });

  it("collects the declared models into its own pool", function () {
    const pools = deriveTierPools(
      ["promo-model", "lite-model", "standard-model"],
      { "promo-model": 0.01, "lite-model": 0.2, "standard-model": 1 },
      ROUTING,
    );

    assert.deepEqual(pools["paperchat-promo"], ["promo-model"]);
    assert.deepEqual(pools["paperchat-lite"], ["lite-model"]);
    assert.deepEqual(pools["paperchat-standard"], ["standard-model"]);
    // The tier is only offered when it actually has models.
    assert.include(getAvailablePaperChatTiers(pools), "paperchat-promo");
  });

  it("keeps the tier empty when no route declares it", function () {
    const legacyRouting = parseModelRoutingConfig({
      models: { "lite-model": { tier: "lite" } },
    });
    const declared = deriveTierPools(
      ["lite-model"],
      { "lite-model": 0.2 },
      legacyRouting,
    );
    assert.deepEqual(declared["paperchat-promo"], []);
    assert.notInclude(getAvailablePaperChatTiers(declared), "paperchat-promo");

    // Ratio-only routing (no tier in the config at all) never invents the tier
    // either, so a cheap model cannot be advertised as a limited-time freebie.
    const ratioOnly = deriveTierPools(
      ["cheap-model", "pricey-model"],
      { "cheap-model": 0.05, "pricey-model": 3 },
      {},
    );
    assert.deepEqual(ratioOnly["paperchat-promo"], []);
    assert.notInclude(getAvailablePaperChatTiers(ratioOnly), "paperchat-promo");
  });

  it("round-trips through the stored tier state", function () {
    const state = parseTierState({
      selectedTier: "paperchat-promo",
      tiers: { "paperchat-promo": { mode: "manual", modelId: "promo-model" } },
    });

    assert.equal(state.selectedTier, "paperchat-promo");
    assert.deepEqual(state.tiers["paperchat-promo"], {
      mode: "manual",
      modelId: "promo-model",
    });
  });

  it("is never the fallback while a regular tier is available", function () {
    const pools = deriveTierPools(
      ["promo-model", "lite-model"],
      { "promo-model": 0.01, "lite-model": 0.2 },
      ROUTING,
    );

    // A vanished selection lands on the cheapest regular tier, not on models
    // whose quality is explicitly not promised.
    assert.equal(getFallbackPaperChatTier(pools), "paperchat-lite");

    // When the tier is all this account has, it is still selectable.
    const promoOnly = deriveTierPools(
      ["promo-model"],
      { "promo-model": 0.01 },
      ROUTING,
    );
    assert.equal(getFallbackPaperChatTier(promoOnly), "paperchat-promo");
  });
});
