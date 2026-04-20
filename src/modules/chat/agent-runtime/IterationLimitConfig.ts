export const DEFAULT_AGENT_MAX_PLANNING_ITERATIONS = 15;
export const MIN_AGENT_MAX_PLANNING_ITERATIONS = 2;
export const MAX_AGENT_MAX_PLANNING_ITERATIONS = 50;

export function normalizeAgentMaxPlanningIterations(
  value: number | null | undefined,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_AGENT_MAX_PLANNING_ITERATIONS;
  }

  return Math.min(
    MAX_AGENT_MAX_PLANNING_ITERATIONS,
    Math.max(MIN_AGENT_MAX_PLANNING_ITERATIONS, Math.trunc(value)),
  );
}

export function getPlanningWarningThreshold(maxIterations: number): number {
  return Math.min(3, Math.max(2, maxIterations - 1));
}
