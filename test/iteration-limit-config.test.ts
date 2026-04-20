import { assert } from "chai";

describe("IterationLimitConfig", function () {
  it("clamps finite values into the [min, max] range", async function () {
    const {
      normalizeAgentMaxPlanningIterations,
      MIN_AGENT_MAX_PLANNING_ITERATIONS,
      MAX_AGENT_MAX_PLANNING_ITERATIONS,
    } = await import(
      "../src/modules/chat/agent-runtime/IterationLimitConfig.ts"
    );

    assert.equal(
      normalizeAgentMaxPlanningIterations(-10),
      MIN_AGENT_MAX_PLANNING_ITERATIONS,
    );
    assert.equal(normalizeAgentMaxPlanningIterations(0), MIN_AGENT_MAX_PLANNING_ITERATIONS);
    assert.equal(normalizeAgentMaxPlanningIterations(1), MIN_AGENT_MAX_PLANNING_ITERATIONS);
    assert.equal(normalizeAgentMaxPlanningIterations(5), 5);
    assert.equal(normalizeAgentMaxPlanningIterations(15), 15);
    assert.equal(normalizeAgentMaxPlanningIterations(50), MAX_AGENT_MAX_PLANNING_ITERATIONS);
    assert.equal(normalizeAgentMaxPlanningIterations(999), MAX_AGENT_MAX_PLANNING_ITERATIONS);
  });

  it("falls back to the default for non-finite or missing input", async function () {
    const {
      normalizeAgentMaxPlanningIterations,
      DEFAULT_AGENT_MAX_PLANNING_ITERATIONS,
    } = await import(
      "../src/modules/chat/agent-runtime/IterationLimitConfig.ts"
    );

    assert.equal(
      normalizeAgentMaxPlanningIterations(Number.NaN),
      DEFAULT_AGENT_MAX_PLANNING_ITERATIONS,
    );
    assert.equal(
      normalizeAgentMaxPlanningIterations(Number.POSITIVE_INFINITY),
      DEFAULT_AGENT_MAX_PLANNING_ITERATIONS,
    );
    assert.equal(
      normalizeAgentMaxPlanningIterations(undefined),
      DEFAULT_AGENT_MAX_PLANNING_ITERATIONS,
    );
    assert.equal(
      normalizeAgentMaxPlanningIterations(null),
      DEFAULT_AGENT_MAX_PLANNING_ITERATIONS,
    );
  });

  it("truncates fractional values rather than rounding", async function () {
    const { normalizeAgentMaxPlanningIterations } = await import(
      "../src/modules/chat/agent-runtime/IterationLimitConfig.ts"
    );

    assert.equal(normalizeAgentMaxPlanningIterations(15.9), 15);
    assert.equal(normalizeAgentMaxPlanningIterations(2.99), 2);
  });

  it("scales the warning threshold but caps at 3 for large limits", async function () {
    const { getPlanningWarningThreshold } = await import(
      "../src/modules/chat/agent-runtime/IterationLimitConfig.ts"
    );

    assert.equal(getPlanningWarningThreshold(2), 2);
    assert.equal(getPlanningWarningThreshold(3), 2);
    assert.equal(getPlanningWarningThreshold(4), 3);
    assert.equal(getPlanningWarningThreshold(15), 3);
    assert.equal(getPlanningWarningThreshold(50), 3);
  });
});

describe("ToolBudgetLimits", function () {
  it("caps get_full_text at 3 regardless of iteration count", async function () {
    const { getToolBudgetLimits } = await import(
      "../src/modules/chat/tool-budget/ToolBudgetPolicy.ts"
    );

    assert.equal(getToolBudgetLimits(2).maxFullTextCallsPerTurn, 2);
    assert.equal(getToolBudgetLimits(3).maxFullTextCallsPerTurn, 3);
    assert.equal(getToolBudgetLimits(15).maxFullTextCallsPerTurn, 3);
    assert.equal(getToolBudgetLimits(50).maxFullTextCallsPerTurn, 3);
  });

  it("scales web_search with iterations but caps at 8", async function () {
    const { getToolBudgetLimits } = await import(
      "../src/modules/chat/tool-budget/ToolBudgetPolicy.ts"
    );

    assert.equal(getToolBudgetLimits(2).maxWebSearchCallsPerTurn, 1);
    assert.equal(getToolBudgetLimits(3).maxWebSearchCallsPerTurn, 1);
    assert.equal(getToolBudgetLimits(6).maxWebSearchCallsPerTurn, 2);
    assert.equal(getToolBudgetLimits(15).maxWebSearchCallsPerTurn, 5);
    assert.equal(getToolBudgetLimits(24).maxWebSearchCallsPerTurn, 8);
    assert.equal(getToolBudgetLimits(50).maxWebSearchCallsPerTurn, 8);
  });

  it("applies iteration normalization for garbage input", async function () {
    const { getToolBudgetLimits } = await import(
      "../src/modules/chat/tool-budget/ToolBudgetPolicy.ts"
    );

    const fromNaN = getToolBudgetLimits(Number.NaN);
    const fromDefault = getToolBudgetLimits(15);
    assert.deepEqual(fromNaN, fromDefault);
  });
});
