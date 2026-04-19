import type { ChatSession } from "../../../types/chat";
import { SessionRunInvalidatedError } from "../errors";

export function ensureTrackedSession(
  session: ChatSession,
  isTracked: (session: ChatSession, runId?: number) => boolean,
  runId?: number,
): void {
  if (!isTracked(session, runId)) {
    throw new SessionRunInvalidatedError();
  }
}

export async function awaitWhileSessionTracked<T>(
  session: ChatSession,
  isTracked: (session: ChatSession, runId?: number) => boolean,
  runIdOrOperation: number | undefined | (() => Promise<T>),
  maybeOperation?: () => Promise<T>,
): Promise<T> {
  const runId =
    typeof runIdOrOperation === "function" ? undefined : runIdOrOperation;
  const operation =
    typeof runIdOrOperation === "function" ? runIdOrOperation : maybeOperation;
  if (!operation) {
    throw new Error("operation is required");
  }
  ensureTrackedSession(session, isTracked, runId);
  const result = await operation();
  ensureTrackedSession(session, isTracked, runId);
  return result;
}
