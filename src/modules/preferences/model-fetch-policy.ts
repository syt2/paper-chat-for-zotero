/**
 * Model fetch policy - decides when the API key panel may refresh a provider's
 * model list on its own, without the user clicking Refresh.
 *
 * The panel cannot know when a key is fully typed, so it triggers on the
 * moments that usually follow a finished credential edit: pasting, leaving a
 * field, or reopening the panel. This module holds the rules that keep those
 * triggers from turning into repeated requests.
 */

/** What made the panel consider refreshing models. */
export type ModelFetchTrigger =
  /** The user pasted into the API key field. */
  | "paste"
  /** The user left the API key or Base URL field. */
  | "blur"
  /** The provider panel was opened or refreshed. */
  | "open";

export type ModelFetchStatus =
  /** A request for these credentials is in flight. */
  | "running"
  /** The provider answered with at least one model. */
  | "loaded"
  /** The provider answered with an empty list. */
  | "empty"
  /** The provider cannot list models at all. */
  | "unsupported"
  /** The request failed (network, auth, wrong Base URL...). */
  | "failed";

export interface ModelFetchAttempt {
  /** API key + Base URL the attempt was made with. */
  credentials: string;
  status: ModelFetchStatus;
}

export interface ModelFetchPolicyInput {
  trigger: ModelFetchTrigger;
  /** API key + Base URL of the provider config as it is right now. */
  credentials: string;
  /** True when the provider config carries an API key to authenticate with. */
  hasApiKey: boolean;
  /** True when the provider config carries a Base URL to call. */
  hasBaseUrl: boolean;
  /** Number of models the provider config already lists. */
  modelCount: number;
  /** Last attempt for this provider, if the panel made one this session. */
  attempt: ModelFetchAttempt | undefined;
}

/**
 * Whether an automatic (non-manual) fetch should run.
 *
 * - Without a key, or without a Base URL to call, there is nothing to ask, so
 *   a half-filled custom provider stays quiet instead of flashing an error.
 * - Credentials that were never tried are worth a request. Opening a panel only
 *   fills an empty list, so a working setup is not re-fetched on every visit.
 * - Once these credentials produced a result, triggers do not repeat the
 *   request: pasting into a field and then leaving it is one edit, not two
 *   refreshes. Edits retry a failed request, because the user is most likely
 *   fixing the credentials that caused it; reopening the panel does not, so a
 *   broken key cannot fire one request per visit.
 * - The Refresh button bypasses all of this.
 */
export function shouldAutoFetchModels(input: ModelFetchPolicyInput): boolean {
  const { attempt, credentials, hasApiKey, hasBaseUrl, modelCount, trigger } =
    input;

  if (!hasApiKey || !hasBaseUrl) {
    return false;
  }

  if (!attempt) {
    return trigger === "open" ? modelCount === 0 : true;
  }

  // Other credentials: whatever the last attempt learned does not apply.
  if (attempt.credentials !== credentials) {
    return true;
  }

  return trigger !== "open" && attempt.status === "failed" && modelCount === 0;
}
