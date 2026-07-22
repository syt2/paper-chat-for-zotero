export interface HttpResponseErrorOptions {
  status: number;
  statusText?: string;
  responseBody?: string;
  cause?: unknown;
}

/**
 * HTTP failure returned by an AI provider.
 *
 * Keep the historical message format for UI and log compatibility while
 * exposing response metadata so retry decisions do not depend on parsing it.
 */
export class HttpResponseError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly responseBody: string;

  constructor(options: HttpResponseErrorOptions) {
    const responseBody = options.responseBody || "";
    super(`API Error: ${options.status} - ${responseBody}`, {
      cause: options.cause,
    });
    this.name = "HttpResponseError";
    this.status = options.status;
    this.statusText = options.statusText || "";
    this.responseBody = responseBody;
  }
}

export function getHttpResponseStatus(error: unknown): number | undefined {
  if (!(error instanceof HttpResponseError)) {
    return undefined;
  }
  return error.status;
}
