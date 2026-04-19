export class SessionRunInvalidatedError extends Error {
  constructor() {
    super("Session run invalidated");
  }
}

export function isAbortError(error: unknown): boolean {
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as Error & { code?: string }).code;
  return error.name === "AbortError" || code === "ABORT_ERR";
}
