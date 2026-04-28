import { assert } from "chai";
import type { ChatSession } from "../src/types/chat";
import {
  deriveTierPools,
  isPaperChatModelHardFailure,
  parseTierState,
  rerollTierModel,
  resolveSelectedTierModel,
  resolveTierModel,
  validateTierState,
} from "../src/modules/providers/paperchat-tier-routing.ts";
import { mapSessionRowToChatSession } from "../src/modules/chat/SessionStorageService.ts";
import { resolveSessionPaperChatModel } from "../src/modules/chat/paperchat-session-routing.ts";
import {
  applyPaperChatSessionBinding,
  clearPaperChatRetryableState,
  repairPaperChatSessionBindingAfterHardFailure,
  resolvePaperChatSessionBinding,
} from "../src/modules/chat/paperchat-session-state.ts";
import { parseModelRoutingConfig } from "../src/modules/providers/paperchat-routing-metadata.ts";

describe("paperchat tier routing", function () {
  it("defaults undefined state to paperchat-pro with auto tier entries", function () {
    const parsed = parseTierState(undefined);

    assert.equal(parsed.selectedTier, "paperchat-pro");
    assert.deepEqual(parsed.tiers, {
      "paperchat-lite": { mode: "auto", modelId: null },
      "paperchat-standard": { mode: "auto", modelId: null },
      "paperchat-pro": { mode: "auto", modelId: null },
      "paperchat-ultra": { mode: "auto", modelId: null },
    });
  });

  it("recovers from invalid persisted tier state", function () {
    const invalidJson = parseTierState("{not-json");
    const invalidShape = parseTierState({
      selectedTier: "not-a-tier",
      tiers: {
        "paperchat-lite": { mode: "manual", modelId: "m1" },
        "paperchat-standard": { mode: "bad-mode", modelId: 42 },
        "paperchat-pro": "bad-entry",
      },
    });

    assert.deepEqual(invalidJson, {
      selectedTier: "paperchat-pro",
      tiers: {
        "paperchat-lite": { mode: "auto", modelId: null },
        "paperchat-standard": { mode: "auto", modelId: null },
        "paperchat-pro": { mode: "auto", modelId: null },
        "paperchat-ultra": { mode: "auto", modelId: null },
      },
    });
    assert.deepEqual(invalidShape, {
      selectedTier: "paperchat-pro",
      tiers: {
        "paperchat-lite": { mode: "manual", modelId: "m1" },
        "paperchat-standard": { mode: "auto", modelId: null },
        "paperchat-pro": { mode: "auto", modelId: null },
        "paperchat-ultra": { mode: "auto", modelId: null },
      },
    });
  });

  it("returns empty pools when no models are available", function () {
    const pools = deriveTierPools([], {});

    assert.deepEqual(pools, {
      "paperchat-lite": [],
      "paperchat-standard": [],
      "paperchat-pro": [],
      "paperchat-ultra": [],
    });
  });

  it("shares a single model across legacy tiers and hides ultra", function () {
    const pools = deriveTierPools(["m1"], { m1: 0.2 });

    assert.deepEqual(pools, {
      "paperchat-lite": ["m1"],
      "paperchat-standard": ["m1"],
      "paperchat-pro": ["m1"],
      "paperchat-ultra": [],
    });
  });

  it("assigns low-ratio models to lite and hides ultra without metadata", function () {
    const pools = deriveTierPools(["m2", "m1"], { m1: 0.2, m2: 0.4 });

    assert.deepEqual(pools, {
      "paperchat-lite": ["m1", "m2"],
      "paperchat-standard": ["m2"],
      "paperchat-pro": ["m2"],
      "paperchat-ultra": [],
    });
  });

  it("uses threshold buckets instead of equal-count splits", function () {
    const pools = deriveTierPools(["m3", "m1", "m2"], {
      m1: 0.2,
      m2: 0.4,
      m3: 0.6,
    });

    assert.deepEqual(pools, {
      "paperchat-lite": ["m1", "m2"],
      "paperchat-standard": ["m3"],
      "paperchat-pro": ["m3"],
      "paperchat-ultra": [],
    });
  });

  it("derives tier pools from ratio thresholds", function () {
    const models = ["m4", "m1", "m6", "m2", "m5", "m3"];
    const ratios = {
      m1: 0.2,
      m2: 0.4,
      m3: 0.6,
      m4: 0.8,
      m5: 1.01,
      m6: 1.2,
    };

    const pools = deriveTierPools(models, ratios);

    assert.deepEqual(pools["paperchat-lite"], ["m1", "m2"]);
    assert.deepEqual(pools["paperchat-standard"], ["m3", "m4", "m5"]);
    assert.deepEqual(pools["paperchat-pro"], ["m6"]);
  });

  it("uses routing config metadata for tier pools when every model has a tier code", function () {
    const pools = deriveTierPools(
      ["pro-low", "lite", "standard", "pro-high"],
      {
        "pro-low": 0.1,
        lite: 9,
        standard: 9,
        "pro-high": 0.2,
      },
      {
        lite: { tierCode: 1, priority: 3 },
        standard: { tierCode: 2, priority: 2 },
        "pro-low": { tierCode: 3, priority: 1 },
        "pro-high": { tierCode: 3, priority: 4 },
      },
    );

    assert.deepEqual(pools["paperchat-lite"], ["lite"]);
    assert.deepEqual(pools["paperchat-standard"], ["standard"]);
    assert.deepEqual(pools["paperchat-pro"], ["pro-high", "pro-low"]);
    assert.deepEqual(pools["paperchat-ultra"], []);
  });

  it("uses old ratio buckets only for models missing routing tier metadata", function () {
    const pools = deriveTierPools(
      ["legacy-lite", "metadata-standard", "legacy-standard", "legacy-pro"],
      {
        "legacy-lite": 0.2,
        "metadata-standard": 9,
        "legacy-standard": 0.7,
        "legacy-pro": 1.2,
      },
      {
        "metadata-standard": { tierCode: 2, priority: 3 },
      },
    );

    assert.deepEqual(pools["paperchat-lite"], ["legacy-lite"]);
    assert.deepEqual(pools["paperchat-standard"], [
      "legacy-standard",
      "metadata-standard",
    ]);
    assert.deepEqual(pools["paperchat-pro"], ["legacy-pro"]);
    assert.deepEqual(pools["paperchat-ultra"], []);
  });

  it("decodes tier and priority from routing metadata json", function () {
    const decoded = parseModelRoutingConfig({
      version: 1,
      models: {
        m1: {
          tier: "standard",
          priority: 4,
        },
        m2: {
          tier: "ultra",
          priority: "3",
        },
      },
    });

    assert.deepEqual(decoded, {
      m1: {
        tierCode: 2,
        priority: 4,
      },
      m2: {
        tierCode: 4,
        priority: 3,
      },
    });
  });

  it("passes routing priorities as weights when auto-selecting a tier model", function () {
    const state = {
      selectedTier: "paperchat-standard",
      tiers: {
        "paperchat-lite": { mode: "auto", modelId: null },
        "paperchat-standard": { mode: "auto", modelId: null },
        "paperchat-pro": { mode: "auto", modelId: null },
        "paperchat-ultra": { mode: "auto", modelId: null },
      },
    };

    const validated = validateTierState(
      state,
      ["standard-a", "standard-b", "lite", "pro"],
      {},
      (candidates, weights) => {
        if (candidates.includes("standard-a")) {
          assert.deepEqual(weights, {
            "standard-a": 3,
            "standard-b": 2,
          });
          return "standard-a";
        }
        return candidates[0] ?? null;
      },
      {
        lite: { tierCode: 1, priority: 1 },
        "standard-a": { tierCode: 2, priority: 3 },
        "standard-b": { tierCode: 2, priority: 2 },
        pro: { tierCode: 3, priority: 4 },
      },
    );

    assert.equal(validated.tiers["paperchat-standard"].modelId, "standard-a");
  });

  it("rerolls within a tier using remaining model priorities as weights", function () {
    const rerolled = rerollTierModel(
      ["m1", "m2", "m3"],
      "m2",
      (candidates, weights) => {
        assert.deepEqual(candidates, ["m1", "m3"]);
        assert.deepEqual(weights, { m1: 3, m3: 4 });
        return "m3";
      },
      {
        m1: { tierCode: 2, priority: 3 },
        m2: { tierCode: 2, priority: 2 },
        m3: { tierCode: 2, priority: 4 },
      },
    );

    assert.equal(rerolled, "m3");
  });

  it("treats 0.51x and 1.01x as standard boundaries", function () {
    const pools = deriveTierPools(["m4", "m1", "m3", "m2"], {
      m1: 0.5,
      m2: 0.51,
      m3: 1.01,
      m4: 1.02,
    });

    assert.deepEqual(pools, {
      "paperchat-lite": ["m1"],
      "paperchat-standard": ["m2", "m3"],
      "paperchat-pro": ["m4"],
      "paperchat-ultra": [],
    });
  });

  it("falls back empty ratio buckets to the max-ratio model except ultra", function () {
    const pools = deriveTierPools(["m3", "m1", "m2"], {
      m1: 0.1,
      m2: 0.2,
      m3: 0.3,
    });

    assert.deepEqual(pools, {
      "paperchat-lite": ["m1", "m2", "m3"],
      "paperchat-standard": ["m3"],
      "paperchat-pro": ["m3"],
      "paperchat-ultra": [],
    });
  });

  it("keeps existing auto bindings through boundary drift", function () {
    const state = {
      selectedTier: "paperchat-standard",
      tiers: {
        "paperchat-lite": { mode: "auto", modelId: "m1" },
        "paperchat-standard": { mode: "auto", modelId: "m3" },
        "paperchat-pro": { mode: "auto", modelId: "m6" },
      },
    };

    const models = ["m1", "m2", "m3", "m4", "m5", "m6"];
    const shiftedRatios = {
      m1: 0.1,
      m2: 0.2,
      m4: 0.3,
      m5: 0.4,
      m6: 0.5,
      m3: 1.0,
    };

    const validated = validateTierState(state, models, shiftedRatios, () => "m2");

    assert.equal(validated.tiers["paperchat-standard"].mode, "auto");
    assert.equal(validated.tiers["paperchat-standard"].modelId, "m3");
  });

  it("includes sticky auto models in resolved pools after boundary drift", function () {
    const state = {
      selectedTier: "paperchat-standard",
      tiers: {
        "paperchat-lite": { mode: "auto", modelId: "m1" },
        "paperchat-standard": { mode: "auto", modelId: "m3" },
        "paperchat-pro": { mode: "auto", modelId: "m6" },
      },
    };

    const models = ["m1", "m2", "m3", "m4", "m5", "m6"];
    const shiftedRatios = {
      m1: 0.1,
      m2: 0.2,
      m4: 0.3,
      m5: 0.4,
      m6: 0.5,
      m3: 1.0,
    };

    const resolved = resolveTierModel(
      state,
      "paperchat-standard",
      models,
      shiftedRatios,
      () => "m2",
    );

    assert.equal(resolved.state.tiers["paperchat-standard"].mode, "auto");
    assert.equal(resolved.state.tiers["paperchat-standard"].modelId, "m3");
    assert.deepEqual(resolved.pools["paperchat-standard"], ["m3"]);
  });

  it("uses a shared deterministic pool when ratio coverage is incomplete", function () {
    const models = ["m3", "m1", "m3", "m2"];
    const incompleteRatios = {
      m1: 0.2,
      m3: 0.6,
    };

    const pools = deriveTierPools(models, incompleteRatios);

    assert.deepEqual(pools, {
      "paperchat-lite": ["m3", "m1", "m2"],
      "paperchat-standard": ["m3", "m1", "m2"],
      "paperchat-pro": ["m3", "m1", "m2"],
      "paperchat-ultra": ["m3", "m1", "m2"],
    });
  });

  it("keeps sticky and manual selections when ratios are incomplete", function () {
    const state = {
      selectedTier: "paperchat-standard",
      tiers: {
        "paperchat-lite": { mode: "auto", modelId: "m1" },
        "paperchat-standard": { mode: "manual", modelId: "m3" },
        "paperchat-pro": { mode: "auto", modelId: null },
      },
    };

    const models = ["m1", "m2", "m3"];
    const incompleteRatios = {
      m1: 0.1,
      m3: 0.3,
    };

    const validated = validateTierState(state, models, incompleteRatios, (candidates) => {
      return candidates[1] ?? null;
    });

    assert.deepEqual(validated.tiers, {
      "paperchat-lite": { mode: "auto", modelId: "m1" },
      "paperchat-standard": { mode: "manual", modelId: "m3" },
      "paperchat-pro": { mode: "auto", modelId: "m2" },
      "paperchat-ultra": { mode: "auto", modelId: "m2" },
    });
  });

  it("falls back from manual to auto when pinned model disappears", function () {
    const state = {
      selectedTier: "paperchat-standard",
      tiers: {
        "paperchat-lite": { mode: "auto", modelId: "m1" },
        "paperchat-standard": { mode: "manual", modelId: "missing-model" },
        "paperchat-pro": { mode: "auto", modelId: "m3" },
      },
    };

    const models = ["m1", "m2", "m3"];
    const ratios = {
      m1: 0.1,
      m2: 0.2,
      m3: 0.3,
    };

    const validated = validateTierState(state, models, ratios, (candidates) => {
      return candidates[0] ?? null;
    });

    assert.equal(validated.tiers["paperchat-standard"].mode, "auto");
    assert.equal(validated.tiers["paperchat-standard"].modelId, "m3");
  });

  it("classifies unsupported-model errors as hard failures", function () {
    assert.isTrue(
      isPaperChatModelHardFailure(new Error("API Error: 400 - model not found")),
    );
    assert.isTrue(
      isPaperChatModelHardFailure(new Error("API Error: 404 - unsupported model")),
    );
    assert.isTrue(
      isPaperChatModelHardFailure(
        new Error(
          'API Error: 503 - {"error":{"code":"model_not_found","message":"分组 default 下模型 test-model 无可用渠道（distributor）"}}',
        ),
      ),
    );
    assert.isFalse(
      isPaperChatModelHardFailure(new Error("API Error: 429 - rate limit exceeded")),
    );
  });

  it("rerolls within same tier excluding current model", function () {
    const rerolled = rerollTierModel(["m1", "m2", "m3"], "m2", (candidates) => {
      return candidates[1] ?? null;
    });
    const noAlternative = rerollTierModel(["m2"], "m2", () => "m2");

    assert.equal(rerolled, "m3");
    assert.isNull(noAlternative);
  });

  it("resolves manual override with updated state and pools", function () {
    const state = {
      selectedTier: "paperchat-lite",
      tiers: {
        "paperchat-lite": { mode: "manual", modelId: "m4" },
        "paperchat-standard": { mode: "auto", modelId: "m3" },
        "paperchat-pro": { mode: "auto", modelId: "m4" },
      },
    };

    const models = ["m1", "m2", "m3", "m4"];
    const ratios = {
      m1: 0.1,
      m2: 0.2,
      m3: 0.6,
      m4: 1.2,
    };

    const resolved = resolveTierModel(
      state,
      "paperchat-lite",
      models,
      ratios,
      (candidates) => candidates[0] ?? null,
    );

    assert.deepEqual(resolved, {
      state: {
        selectedTier: "paperchat-lite",
        tiers: {
          "paperchat-lite": { mode: "manual", modelId: "m4" },
          "paperchat-standard": { mode: "auto", modelId: "m3" },
          "paperchat-pro": { mode: "auto", modelId: "m4" },
          "paperchat-ultra": { mode: "auto", modelId: null },
        },
      },
      modelId: "m4",
      pools: {
        "paperchat-lite": ["m1", "m2"],
        "paperchat-standard": ["m3"],
        "paperchat-pro": ["m4"],
        "paperchat-ultra": [],
      },
    });
  });

  it("resolves the currently selected tier for provider-level calls", function () {
    const resolved = resolveSelectedTierModel(
      {
        selectedTier: "paperchat-pro",
        tiers: {
          "paperchat-lite": { mode: "auto", modelId: "m1" },
          "paperchat-standard": { mode: "manual", modelId: "m3" },
          "paperchat-pro": { mode: "auto", modelId: "m4" },
        },
      },
      ["m1", "m2", "m3", "m4"],
      { m1: 0.2, m2: 0.6, m3: 1.0, m4: 1.2 },
      (candidates) => candidates[0] ?? null,
    );

    assert.equal(resolved.selectedTier, "paperchat-pro");
    assert.equal(resolved.modelId, "m4");
    assert.deepEqual(resolved.pools["paperchat-pro"], ["m4"]);
  });

  it("maps selected tier and resolved model from session row", function () {
    const row = {
      id: "session-1",
      created_at: 100,
      updated_at: 200,
      last_active_item_key: "ABCD1234",
      last_active_item_keys: JSON.stringify(["ABCD1234", "EFGH5678"]),
      context_summary: null,
      context_state: null,
      memory_extracted_at: null,
      memory_extracted_msg_count: null,
      selected_tier: "paperchat-pro",
      resolved_model_id: "openai/gpt-4.1",
      last_retryable_user_message_id: null,
      last_retryable_error_message_id: null,
      last_retryable_failed_model_id: null,
    };

    const session = mapSessionRowToChatSession(row, [
      {
        id: "msg-valid",
        role: "user",
        content: "hello",
        timestamp: 123,
      },
      {
        id: "msg-empty",
        role: "assistant",
        content: "",
        timestamp: 124,
      },
    ]);

    assert.equal(session.selectedTier, "paperchat-pro");
    assert.equal(session.resolvedModelId, "openai/gpt-4.1");
    assert.lengthOf(session.messages, 1);
  });

  it("prefers the session resolved model while it remains available", function () {
    const result = resolveSessionPaperChatModel(
      {
        id: "s1",
        createdAt: 1,
        updatedAt: 1,
        lastActiveItemKey: null,
        messages: [],
        selectedTier: "paperchat-standard",
        resolvedModelId: "m3",
      },
      {
        selectedTier: "paperchat-standard",
        tiers: {
          "paperchat-lite": { mode: "auto", modelId: "m1" },
          "paperchat-standard": { mode: "auto", modelId: "m4" },
          "paperchat-pro": { mode: "auto", modelId: "m6" },
        },
      },
      ["m1", "m3", "m4", "m6"],
      { m1: 1, m3: 3, m4: 4, m6: 6 },
      (candidates) => candidates[0],
    );

    assert.equal(result.modelId, "m3");
    assert.equal(result.selectedTier, "paperchat-standard");
    assert.equal(result.state.tiers["paperchat-standard"].modelId, "m4");
  });

  it("prefers the manual tier override over a stale session binding", function () {
    const result = resolveSessionPaperChatModel(
      {
        id: "s-stale",
        createdAt: 1,
        updatedAt: 1,
        lastActiveItemKey: null,
        messages: [],
        selectedTier: "paperchat-standard",
        resolvedModelId: "m3",
      },
      {
        selectedTier: "paperchat-standard",
        tiers: {
          "paperchat-lite": { mode: "auto", modelId: "m1" },
          "paperchat-standard": { mode: "manual", modelId: "m4" },
          "paperchat-pro": { mode: "auto", modelId: "m6" },
        },
      },
      ["m1", "m3", "m4", "m6"],
      { m1: 1, m3: 3, m4: 4, m6: 6 },
      () => {
        throw new Error("should not pick a new model on manual override");
      },
    );

    assert.equal(result.modelId, "m4");
    assert.equal(result.selectedTier, "paperchat-standard");
    assert.deepEqual(result.pools, {
      "paperchat-lite": [],
      "paperchat-standard": ["m4"],
      "paperchat-pro": [],
      "paperchat-ultra": [],
    });
  });

  it("ignores a manual tier override whose model is unavailable", function () {
    const result = resolveSessionPaperChatModel(
      {
        id: "s-unavail",
        createdAt: 1,
        updatedAt: 1,
        lastActiveItemKey: null,
        messages: [],
        selectedTier: "paperchat-standard",
        resolvedModelId: "m3",
      },
      {
        selectedTier: "paperchat-standard",
        tiers: {
          "paperchat-lite": { mode: "auto", modelId: "m1" },
          "paperchat-standard": { mode: "manual", modelId: "m-missing" },
          "paperchat-pro": { mode: "auto", modelId: "m6" },
        },
      },
      ["m1", "m3", "m4", "m6"],
      { m1: 1, m3: 3, m4: 4, m6: 6 },
      (candidates) => candidates[0],
    );

    assert.equal(result.modelId, "m3");
    assert.equal(result.selectedTier, "paperchat-standard");
  });

  it("short-circuits pool resolution when the session binding is still valid", function () {
    const ratios = new Proxy<Record<string, number>>(
      {},
      {
        get() {
          throw new Error("should not read ratios on fast path");
        },
      },
    );

    const result = resolveSessionPaperChatModel(
      {
        id: "s-fast-path",
        createdAt: 1,
        updatedAt: 1,
        lastActiveItemKey: null,
        messages: [],
        selectedTier: "paperchat-standard",
        resolvedModelId: "m3",
      },
      {
        selectedTier: "paperchat-lite",
        tiers: {
          "paperchat-lite": { mode: "auto", modelId: "m1" },
          "paperchat-standard": { mode: "auto", modelId: "m4" },
          "paperchat-pro": { mode: "auto", modelId: "m6" },
        },
      },
      ["m1", "m3", "m4", "m6"],
      ratios,
      () => {
        throw new Error("should not pick a new model on fast path");
      },
    );

    assert.equal(result.modelId, "m3");
    assert.equal(result.selectedTier, "paperchat-standard");
    assert.deepEqual(result.pools, {
      "paperchat-lite": [],
      "paperchat-standard": ["m3"],
      "paperchat-pro": [],
      "paperchat-ultra": [],
    });
  });

  it("resolves a PaperChat session binding without mutating the session", function () {
    const session: ChatSession = {
      id: "s2",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [],
      selectedTier: "paperchat-lite",
      resolvedModelId: undefined,
    };

    const result = resolvePaperChatSessionBinding(
      session,
      {
        selectedTier: "paperchat-standard",
        tiers: {
          "paperchat-lite": { mode: "auto", modelId: "m1" },
          "paperchat-standard": { mode: "auto", modelId: "m3" },
          "paperchat-pro": { mode: "auto", modelId: "m4" },
        },
      },
      ["m1", "m2", "m3", "m4"],
      { m1: 0.1, m2: 0.2, m3: 0.6, m4: 1.2 },
      (candidates) => candidates[0] ?? null,
    );

    assert.equal(result.selectedTier, "paperchat-lite");
    assert.equal(result.modelId, "m1");
    assert.equal(session.selectedTier, "paperchat-lite");
    assert.isUndefined(session.resolvedModelId);
  });

  it("repairs a hard-failed PaperChat binding to another same-tier model", function () {
    const session: ChatSession = {
      id: "s-hard-fail",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [],
      selectedTier: "paperchat-standard",
      resolvedModelId: "m3",
    };

    const repaired = repairPaperChatSessionBindingAfterHardFailure(
      session,
      {
        selectedTier: "paperchat-standard",
        tiers: {
          "paperchat-lite": { mode: "auto", modelId: "m1" },
          "paperchat-standard": { mode: "auto", modelId: "m3" },
          "paperchat-pro": { mode: "auto", modelId: "m5" },
          "paperchat-ultra": { mode: "auto", modelId: "m5" },
        },
      },
      ["m1", "m2", "m3", "m4", "m5"],
      { m1: 0.1, m2: 0.2, m3: 0.6, m4: 0.8, m5: 1.2 },
      "m3",
      (candidates) => candidates[0] ?? null,
    );

    assert.deepEqual(repaired, {
      selectedTier: "paperchat-standard",
      modelId: "m4",
      previousModelId: "m3",
      state: {
        selectedTier: "paperchat-standard",
        tiers: {
          "paperchat-lite": { mode: "auto", modelId: "m1" },
          "paperchat-standard": { mode: "auto", modelId: "m3" },
          "paperchat-pro": { mode: "auto", modelId: "m5" },
          "paperchat-ultra": { mode: "auto", modelId: "m5" },
        },
      },
    });
  });

  it("returns null when a hard-failed tier has no alternate model", function () {
    const session: ChatSession = {
      id: "s-hard-fail-none",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [],
      selectedTier: "paperchat-standard",
      resolvedModelId: "m2",
    };

    const repaired = repairPaperChatSessionBindingAfterHardFailure(
      session,
      {
        selectedTier: "paperchat-standard",
        tiers: {
          "paperchat-lite": { mode: "auto", modelId: "m1" },
          "paperchat-standard": { mode: "auto", modelId: "m2" },
          "paperchat-pro": { mode: "auto", modelId: "m3" },
        },
      },
      ["m1", "m2", "m3"],
      { m1: 0.1, m2: 0.6, m3: 1.2 },
      "m2",
      (candidates) => candidates[0] ?? null,
    );

    assert.isNull(repaired);
  });

  it("applies a resolved PaperChat binding only when explicitly requested", function () {
    const session: ChatSession = {
      id: "s3",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [],
      selectedTier: "paperchat-standard",
      resolvedModelId: undefined,
    };

    applyPaperChatSessionBinding(session, {
      selectedTier: "paperchat-standard",
      modelId: "m3",
    });

    assert.equal(session.selectedTier, "paperchat-standard");
    assert.equal(session.resolvedModelId, "m3");
  });

  it("clears stale PaperChat retryable state when leaving the provider", function () {
    const session: ChatSession = {
      id: "s4",
      createdAt: 1,
      updatedAt: 1,
      lastActiveItemKey: null,
      messages: [],
      selectedTier: "paperchat-standard",
      resolvedModelId: "m3",
      lastRetryableUserMessageId: "user-1",
      lastRetryableErrorMessageId: "error-1",
      lastRetryableFailedModelId: "m3",
    };

    clearPaperChatRetryableState(session);

    assert.isUndefined(session.lastRetryableUserMessageId);
    assert.isUndefined(session.lastRetryableErrorMessageId);
    assert.isUndefined(session.lastRetryableFailedModelId);
    assert.equal(session.selectedTier, "paperchat-standard");
    assert.equal(session.resolvedModelId, "m3");
  });
});
