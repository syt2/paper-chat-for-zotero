import type { ToolDefinition } from "../../types/tool";
import {
  createPresentationLaunchAuthorization,
  type PresentationLaunchAuthorization,
} from "./PresentationLaunchAuthorization";
import type {
  PresentationLaunchCoordinator,
  PresentationLaunchLifecycle,
} from "./PresentationLaunchCoordinator";
import { createPresentationLaunchKey } from "./PresentationLaunchCoordinator";
import type { PresentationLaunchGuardResult } from "./PresentationLaunchGuard";
import type { PresentationSourceContext } from "./contracts";

export const PRESENTATION_LAUNCH_TOOL_NAME = "request_presentation";

export type PresentationToolLaunchBlockReason =
  | "provider"
  | "login"
  | "balance"
  | "cancelled"
  | "already_active"
  | "capacity_exceeded"
  | "turn_finished"
  | "launch_failed";

export type PresentationToolLaunchResult =
  | {
      allowed: true;
      authorization: PresentationLaunchAuthorization;
    }
  | {
      allowed: false;
      reason: PresentationToolLaunchBlockReason;
    };

export interface PresentationToolLaunchSession {
  readonly source: Readonly<Required<PresentationSourceContext>>;
  requestAuthorization(): Promise<PresentationToolLaunchResult>;
  getAuthorization(): PresentationLaunchAuthorization | undefined;
  finish(): void;
}

export interface PresentationToolLaunchSessionOptions {
  coordinator: PresentationLaunchCoordinator;
  source: Required<PresentationSourceContext>;
  abortSignal?: AbortSignal;
  runGuard(
    onSettingsFocusReady: (focus: () => void) => void,
  ): Promise<PresentationLaunchGuardResult>;
  focusTask?: () => void;
  onCapacityExceeded?: () => void;
  onError?: (error: unknown) => void;
}

export function createPresentationLaunchToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: PRESENTATION_LAUNCH_TOOL_NAME,
      description:
        "Open PaperChat's trusted native presentation settings window when the user wants to create, generate, make, or retry a PPT for the current paper. Call this for concise requests such as '为这篇论文生成一个 PPT' and for a follow-up such as '重试下' when the preceding PPT attempt failed. This tool only starts the guarded flow; the plugin itself checks balance and asks the user for slide count, style, custom instructions, and high-token confirmation. Never invent those settings or use request_user_input for them. After the user confirms, follow the tool result and call the newly available private presentation tool.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * Per-turn bridge between the low-risk launcher and the private presentation
 * capability. It owns no UI itself: callers inject the existing native guard.
 * The authorization object never crosses the model/tool-argument boundary.
 */
export function createPresentationToolLaunchSession(
  options: PresentationToolLaunchSessionOptions,
): PresentationToolLaunchSession {
  const source = Object.freeze({ ...options.source });
  const completion = createDeferred<void>();
  let finished = false;
  let authorization: PresentationLaunchAuthorization | undefined;
  let authorizationRequest: Promise<PresentationToolLaunchResult> | undefined;
  let settlePendingAuthorizationRequest:
    | ((result: PresentationToolLaunchResult) => void)
    | undefined;

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Observers are diagnostic only and must never change launch state.
    }
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    options.abortSignal?.removeEventListener("abort", finish);
    settlePendingAuthorizationRequest?.({
      allowed: false,
      reason: "turn_finished",
    });
    completion.resolve();
  };

  if (options.abortSignal?.aborted) {
    finish();
  } else {
    options.abortSignal?.addEventListener("abort", finish, { once: true });
  }

  const requestAuthorization = (): Promise<PresentationToolLaunchResult> => {
    if (finished) {
      return Promise.resolve({ allowed: false, reason: "turn_finished" });
    }
    if (authorization) {
      return Promise.resolve({ allowed: true, authorization });
    }
    if (authorizationRequest) return authorizationRequest;

    authorizationRequest = (async () => {
      const ready = createDeferred<PresentationToolLaunchResult>();
      let readySettled = false;
      let focusConfiguration: (() => void) | undefined;
      let pendingConfigurationFocus = false;
      const settleReady = (result: PresentationToolLaunchResult): void => {
        if (readySettled) return;
        readySettled = true;
        if (settlePendingAuthorizationRequest === settleReady) {
          settlePendingAuthorizationRequest = undefined;
        }
        ready.resolve(result);
      };
      settlePendingAuthorizationRequest = settleReady;
      const setConfigurationFocus = (focus: () => void): void => {
        focusConfiguration = focus;
        if (pendingConfigurationFocus) {
          pendingConfigurationFocus = false;
          focus();
        }
      };
      const requestConfigurationFocus = (): void => {
        if (focusConfiguration) {
          focusConfiguration();
        } else {
          pendingConfigurationFocus = true;
        }
      };

      const task = async (
        lifecycle: PresentationLaunchLifecycle,
      ): Promise<boolean> => {
        try {
          if (finished) {
            settleReady({ allowed: false, reason: "turn_finished" });
            return false;
          }
          const guardResult = await Promise.race([
            options.runGuard(setConfigurationFocus),
            completion.promise.then(() => null),
          ]);
          if (!guardResult) {
            settleReady({ allowed: false, reason: "turn_finished" });
            return false;
          }
          if (!guardResult.allowed) {
            settleReady({ allowed: false, reason: guardResult.reason });
            return false;
          }
          if (finished) {
            settleReady({ allowed: false, reason: "turn_finished" });
            return false;
          }
          if (!lifecycle.beginRunning(options.focusTask || (() => undefined))) {
            settleReady({
              allowed: false,
              reason: "capacity_exceeded",
            });
            return false;
          }

          authorization = createPresentationLaunchAuthorization(
            source,
            guardResult.settings,
          );
          // Abort owns only the configuring phase. Once generation starts, the
          // coordinator slot and same-paper lock must remain held until the
          // actual tool execution settles and the outer chat turn calls finish.
          options.abortSignal?.removeEventListener("abort", finish);
          settleReady({ allowed: true, authorization });
          await completion.promise;
          return true;
        } catch (error) {
          settleReady({ allowed: false, reason: "launch_failed" });
          reportError(error);
          return false;
        }
      };

      const enqueued = options.coordinator.enqueueWithDisposition(
        createPresentationLaunchKey(source),
        task,
        {
          focusConfiguration: requestConfigurationFocus,
          onCapacityExceeded: options.onCapacityExceeded,
        },
      );
      if (enqueued.disposition === "existing") {
        settleReady({ allowed: false, reason: "already_active" });
      } else if (enqueued.disposition === "capacity_exceeded") {
        settleReady({ allowed: false, reason: "capacity_exceeded" });
      }
      // The task handles its own failures, but observe the shared promise so a
      // future coordinator implementation cannot create an unhandled rejection.
      void enqueued.promise.catch(reportError);
      const result = await ready.promise;
      if (!result.allowed && enqueued.disposition === "started") {
        // Do not report cancellation before the coordinator has released this
        // paper. An immediate retry should be able to open a fresh guard.
        await enqueued.promise.catch(() => false);
      }
      return result;
    })();

    return authorizationRequest;
  };

  return {
    source,
    requestAuthorization,
    getAuthorization: () => (finished ? undefined : authorization),
    finish,
  };
}
