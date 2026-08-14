import type { PresentationSourceContext } from "./contracts";
import {
  DEFAULT_PRESENTATION_LAUNCH_SETTINGS,
  normalizePresentationLaunchSettings,
  type PresentationLaunchSettings,
} from "./PresentationLaunchSettings";

export interface PresentationLaunchAuthorization {
  readonly providerId: "paperchat";
  readonly source: Readonly<PresentationSourceContext>;
  readonly settings: Readonly<PresentationLaunchSettings>;
}

export const MAX_PRESENTATION_ATTEMPTS_PER_AUTHORIZATION = 3;

type PresentationAuthorizationState =
  | { status: "ready"; attempts: number }
  | { status: "running"; attempts: number }
  | { status: "completed"; attempts: number }
  | { status: "terminal_failure"; attempts: number };

export type PresentationAuthorizationBlockReason =
  | "not_issued"
  | "already_running"
  | "already_completed"
  | "terminal_failure"
  | "attempts_exhausted";

export type PresentationAuthorizationAttemptResult =
  | { allowed: true; attempt: number }
  | { allowed: false; reason: PresentationAuthorizationBlockReason };

const authorizationStates = new WeakMap<
  object,
  PresentationAuthorizationState
>();

/**
 * Issue an app-owned capability after the visible launch guard succeeds. Its
 * object identity exists only in memory, so model arguments and restored
 * session data cannot forge permission to run the expensive tool.
 */
export function createPresentationLaunchAuthorization(
  source: PresentationSourceContext,
  settings: PresentationLaunchSettings = DEFAULT_PRESENTATION_LAUNCH_SETTINGS,
): PresentationLaunchAuthorization {
  const normalizedSettings = normalizePresentationLaunchSettings(settings);
  const authorization: PresentationLaunchAuthorization = {
    providerId: "paperchat",
    source: Object.freeze({ ...source }),
    settings: Object.freeze({ ...normalizedSettings }),
  };
  authorizationStates.set(authorization, { status: "ready", attempts: 0 });
  return Object.freeze(authorization);
}

export function isIssuedPresentationLaunchAuthorization(
  authorization: PresentationLaunchAuthorization | null | undefined,
): authorization is PresentationLaunchAuthorization {
  return (
    !!authorization &&
    authorization.providerId === "paperchat" &&
    authorizationStates.has(authorization)
  );
}

/**
 * Consume one full-deck attempt at the executor boundary. The state change is
 * synchronous, so even direct concurrent calls cannot share one attempt.
 */
export function beginPresentationAuthorizationAttempt(
  authorization: PresentationLaunchAuthorization | null | undefined,
): PresentationAuthorizationAttemptResult {
  if (!isIssuedPresentationLaunchAuthorization(authorization)) {
    return { allowed: false, reason: "not_issued" };
  }
  const state = authorizationStates.get(authorization)!;
  if (state.status === "running") {
    return { allowed: false, reason: "already_running" };
  }
  if (state.status === "completed") {
    return { allowed: false, reason: "already_completed" };
  }
  if (state.status === "terminal_failure") {
    return { allowed: false, reason: "terminal_failure" };
  }
  if (state.attempts >= MAX_PRESENTATION_ATTEMPTS_PER_AUTHORIZATION) {
    return { allowed: false, reason: "attempts_exhausted" };
  }

  const attempt = state.attempts + 1;
  authorizationStates.set(authorization, {
    status: "running",
    attempts: attempt,
  });
  return { allowed: true, attempt };
}

/** Finish the currently running attempt and decide whether one retry remains. */
export function finishPresentationAuthorizationAttempt(
  authorization: PresentationLaunchAuthorization,
  outcome: "completed" | "retryable_failure" | "terminal_failure",
): void {
  const state = authorizationStates.get(authorization);
  if (!state || state.status !== "running") return;

  if (outcome === "completed") {
    authorizationStates.set(authorization, {
      status: "completed",
      attempts: state.attempts,
    });
    return;
  }
  if (outcome === "terminal_failure") {
    authorizationStates.set(authorization, {
      status: "terminal_failure",
      attempts: state.attempts,
    });
    return;
  }
  authorizationStates.set(authorization, {
    status:
      state.attempts >= MAX_PRESENTATION_ATTEMPTS_PER_AUTHORIZATION
        ? "terminal_failure"
        : "ready",
    attempts: state.attempts,
  });
}
