import type { ChatSession } from "../../../types/chat";
import { SessionRunInvalidatedError } from "../errors";

export function ensureTrackedSession(
  session: ChatSession,
  isTracked: (session: ChatSession) => boolean,
): void {
  if (!isTracked(session)) {
    throw new SessionRunInvalidatedError();
  }
}

export async function awaitWhileSessionTracked<T>(
  session: ChatSession,
  isTracked: (session: ChatSession) => boolean,
  operation: () => Promise<T>,
): Promise<T> {
  ensureTrackedSession(session, isTracked);
  const result = await operation();
  ensureTrackedSession(session, isTracked);
  return result;
}
