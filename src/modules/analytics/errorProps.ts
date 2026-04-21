export function buildErrorProps(
  reason: string,
  error?: unknown,
): { reason: string; error_detail?: string } {
  if (reason !== "unknown") {
    return { reason };
  }

  if (error === undefined) {
    return { reason: "unknown" };
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const sanitized = rawMessage
    .replace(/\S+@\S+\.\S+/g, "[email]")
    .replace(/(?:https?:\/\/|\/)[^\s]+/g, "[path]")
    .trim();

  if (!sanitized) {
    return { reason: "unknown" };
  }

  return {
    reason: "unknown",
    error_detail:
      sanitized.length > 200 ? `${sanitized.slice(0, 200)}…` : sanitized,
  };
}
