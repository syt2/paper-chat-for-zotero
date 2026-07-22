import { getErrorMessage } from "../../utils/common";
import { getHttpResponseStatus } from "./HttpResponseError";

export const PROVIDER_REQUEST_MAX_ATTEMPTS = 4;
export const PROVIDER_RETRY_BACKOFF_BASE_MS = 2000;
const PROVIDER_RETRY_BACKOFF_MAX_MS = 8000;

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 524]);

/** Transient failures may use a non-standard HTTP status. */
const RETRYABLE_TRANSIENT_ERROR_PATTERNS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /timeout/i,
  /timed?.?out/i,
  /ETIMEDOUT/,
  /service.?unavailable/i,
  /bad.?gateway/i,
  /network.?error/i,
  /ECONNREFUSED/,
  /ENOTFOUND/,
  /fetch.?failed/i,
];

/** Persistent account quota exhaustion must win over an HTTP 429 status. */
const NON_RETRYABLE_QUOTA_PATTERNS = [
  /insufficient(?:[_ .-]?user)?[_ .-]?quota/i,
  /quota.?exceeded/i,
  /额度不足/,
];

/** Legacy and network errors that do not carry structured HTTP metadata. */
const RETRYABLE_UNSTRUCTURED_ERROR_PATTERNS = [
  ...RETRYABLE_TRANSIENT_ERROR_PATTERNS,
  /429/,
  /503/,
  /502/,
];

export function isRetryableProviderError(error: unknown): boolean {
  const errorMessage = getErrorMessage(error);
  const httpStatus = getHttpResponseStatus(error);

  if (
    NON_RETRYABLE_QUOTA_PATTERNS.some((pattern) => pattern.test(errorMessage))
  ) {
    return false;
  }

  if (httpStatus !== undefined) {
    return (
      RETRYABLE_HTTP_STATUSES.has(httpStatus) ||
      RETRYABLE_TRANSIENT_ERROR_PATTERNS.some((pattern) =>
        pattern.test(errorMessage),
      )
    );
  }

  return RETRYABLE_UNSTRUCTURED_ERROR_PATTERNS.some((pattern) =>
    pattern.test(errorMessage),
  );
}

export function getProviderRetryBackoffDelayMs(
  completedAttempts: number,
  baseMs: number = PROVIDER_RETRY_BACKOFF_BASE_MS,
): number {
  return Math.min(
    baseMs * 2 ** Math.max(0, completedAttempts - 1),
    PROVIDER_RETRY_BACKOFF_MAX_MS,
  );
}
