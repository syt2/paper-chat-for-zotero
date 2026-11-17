import { HttpResponseError } from "./HttpResponseError";

export const CONTEXT_INPUT_TOO_LONG = "CONTEXT_INPUT_TOO_LONG";
const OVERFLOW_PATTERN =
  /context_length_exceeded|maximum context length|too many tokens|context window|exceeds? the (?:maximum|context)|(?:has )?exceeded max_prompt_tokens|max_prompt_tokens[^\n]{0,100}(?:exceed|limit)|prompt is too long|input (?:is )?too long|input token(?:s| count)?[^\n]{0,100}(?:exceed|greater than)|上下文.{0,12}(?:超出|超过|过长)/i;

export function isContextOverflowError(error: unknown): boolean {
  const text =
    error instanceof HttpResponseError
      ? error.responseBody
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
  return text.includes(CONTEXT_INPUT_TOO_LONG) || OVERFLOW_PATTERN.test(text);
}

/** The marker survives persistence as a plain chat error message. */
export class ContextInputTooLongError extends Error {
  constructor(cause: unknown) {
    super(CONTEXT_INPUT_TOO_LONG, { cause });
    this.name = "ContextInputTooLongError";
  }
}

/** One emergency compaction per turn, shared by all its model requests. */
export function createContextOverflowRecovery(options: {
  compact: () => Promise<boolean>;
  signal?: AbortSignal;
  shouldRecover?: (error: unknown) => boolean;
  checkActive?: () => void;
}) {
  let attempted = false;
  const checkAbort = () => {
    options.checkActive?.();
    if (options.signal?.aborted) {
      const error = new Error("Request aborted during context compression");
      error.name = "AbortError";
      throw error;
    }
  };
  return async <T>(
    operation: () => Promise<T>,
    compact = options.compact,
  ): Promise<T> => {
    checkAbort();
    try {
      return await operation();
    } catch (error) {
      checkAbort();
      if (options.shouldRecover?.(error) === false) throw error;
      if (!isContextOverflowError(error)) throw error;
      if (error instanceof ContextInputTooLongError || attempted) {
        throw new ContextInputTooLongError(error);
      }
      attempted = true;
      let compacted = false;
      try {
        compacted = await compact();
      } catch (compactionError) {
        checkAbort();
        throw new ContextInputTooLongError(compactionError);
      }
      checkAbort();
      if (!compacted) throw new ContextInputTooLongError(error);
      try {
        return await operation();
      } catch (retryError) {
        checkAbort();
        if (isContextOverflowError(retryError)) {
          throw new ContextInputTooLongError(retryError);
        }
        throw retryError;
      }
    }
  };
}
