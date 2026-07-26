/**
 * Zotero 10's Zotero.HTTP.request auto-retries 429 (and 503+Retry-After)
 * responses with backoff for up to an hour by default. Spread this into
 * request options wherever a throttle response must surface immediately.
 * Ignored by Zotero 9; typed loosely because zotero-types (4.1.3) does not
 * declare the option yet.
 */
export const NO_RETRY_ON_THROTTLE: { noRetryOnThrottle?: boolean } = {
  noRetryOnThrottle: true,
};
