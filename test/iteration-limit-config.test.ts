import { assert } from "chai";

describe("IterationLimitConfig", function () {
  it("defaults maximum planning iterations to 30", async function () {
    const { DEFAULT_AGENT_MAX_PLANNING_ITERATIONS } =
      await import("../src/modules/chat/agent-runtime/IterationLimitConfig.ts");

    assert.equal(DEFAULT_AGENT_MAX_PLANNING_ITERATIONS, 30);
  });

  it("clamps finite values into the [min, max] range", async function () {
    const {
      normalizeAgentMaxPlanningIterations,
      MIN_AGENT_MAX_PLANNING_ITERATIONS,
      MAX_AGENT_MAX_PLANNING_ITERATIONS,
    } =
      await import("../src/modules/chat/agent-runtime/IterationLimitConfig.ts");

    assert.equal(
      normalizeAgentMaxPlanningIterations(-10),
      MIN_AGENT_MAX_PLANNING_ITERATIONS,
    );
    assert.equal(
      normalizeAgentMaxPlanningIterations(0),
      MIN_AGENT_MAX_PLANNING_ITERATIONS,
    );
    assert.equal(
      normalizeAgentMaxPlanningIterations(1),
      MIN_AGENT_MAX_PLANNING_ITERATIONS,
    );
    assert.equal(normalizeAgentMaxPlanningIterations(5), 5);
    assert.equal(normalizeAgentMaxPlanningIterations(15), 15);
    assert.equal(
      normalizeAgentMaxPlanningIterations(50),
      MAX_AGENT_MAX_PLANNING_ITERATIONS,
    );
    assert.equal(
      normalizeAgentMaxPlanningIterations(999),
      MAX_AGENT_MAX_PLANNING_ITERATIONS,
    );
  });

  it("falls back to the default for non-finite or missing input", async function () {
    const {
      normalizeAgentMaxPlanningIterations,
      DEFAULT_AGENT_MAX_PLANNING_ITERATIONS,
    } =
      await import("../src/modules/chat/agent-runtime/IterationLimitConfig.ts");

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
    const { normalizeAgentMaxPlanningIterations } =
      await import("../src/modules/chat/agent-runtime/IterationLimitConfig.ts");

    assert.equal(normalizeAgentMaxPlanningIterations(15.9), 15);
    assert.equal(normalizeAgentMaxPlanningIterations(2.99), 2);
  });

  it("scales the warning threshold but caps at 3 for large limits", async function () {
    const { getPlanningWarningThreshold } =
      await import("../src/modules/chat/agent-runtime/IterationLimitConfig.ts");

    assert.equal(getPlanningWarningThreshold(2), 2);
    assert.equal(getPlanningWarningThreshold(3), 2);
    assert.equal(getPlanningWarningThreshold(4), 3);
    assert.equal(getPlanningWarningThreshold(15), 3);
    assert.equal(getPlanningWarningThreshold(50), 3);
  });
});
