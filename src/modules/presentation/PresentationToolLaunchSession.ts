import { Type } from "@sinclair/typebox";
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
import {
  PRESENTATION_DESIGN_SYSTEMS,
  isPresentationDesignSystem,
  normalizePresentationUserInstructions,
  parsePresentationSlideCount,
  type PresentationDesignSystem,
  type PresentationLaunchSettings,
} from "./PresentationLaunchSettings";

export const PRESENTATION_LAUNCH_TOOL_NAME = "request_presentation";

export type PresentationToolLaunchBlockReason =
  | "provider"
  | "login"
  | "balance"
  | "cancelled"
  | "source_unavailable"
  | "source_ambiguous"
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

/** Model-supplied suggestions. The native settings dialog remains authoritative. */
export interface PresentationLaunchIntent {
  sourceItemKey?: string;
  sourceLibraryID?: number;
  slideCount?: number;
  designSystem?: PresentationDesignSystem;
  instructions?: string;
}

export type PresentationLaunchSourceResolution =
  | {
      allowed: true;
      source: Required<PresentationSourceContext>;
    }
  | {
      allowed: false;
      reason: "source_unavailable" | "source_ambiguous";
    };

export type PresentationLaunchSourceResolver = (
  intent: PresentationLaunchIntent,
  fallbackSource?: PresentationSourceContext,
) => PresentationLaunchSourceResolution;

const PRESENTATION_LAUNCH_DESIGN_SYSTEM_SCHEMA = Type.Union(
  PRESENTATION_DESIGN_SYSTEMS.map((designSystem) => Type.Literal(designSystem)),
);

const PRESENTATION_LAUNCH_PARAMETERS = Type.Object(
  {
    sourceItemKey: Type.Optional(
      Type.String({
        maxLength: 32,
        description: "Optional Zotero paper item key from an explicit mention.",
      }),
    ),
    sourceLibraryID: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Zotero library ID paired with sourceItemKey.",
      }),
    ),
    slideCount: Type.Optional(
      Type.Integer({
        minimum: 4,
        maximum: 30,
        description:
          "Set only when the user explicitly requested a page/slide count. Total exported slide count includes the automatic cover.",
      }),
    ),
    designSystem: Type.Optional(PRESENTATION_LAUNCH_DESIGN_SYSTEM_SCHEMA),
    instructions: Type.Optional(
      Type.String({
        maxLength: 4000,
        description:
          "Non-empty audience, emphasis, or layout requirements explicitly stated by the user. Omit this field instead of sending an empty string.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Explicit presentation suggestions. The native settings dialog is authoritative.",
  },
);

export interface PresentationToolLaunchSession {
  readonly source: Readonly<PresentationSourceContext>;
  requestAuthorization(
    intent?: PresentationLaunchIntent,
  ): Promise<PresentationToolLaunchResult>;
  getAuthorization(): PresentationLaunchAuthorization | undefined;
  finish(): void;
}

export interface PresentationToolLaunchSessionOptions {
  coordinator: PresentationLaunchCoordinator;
  source?: PresentationSourceContext;
  resolveSource?: PresentationLaunchSourceResolver;
  abortSignal?: AbortSignal;
  runGuard(
    onSettingsFocusReady: (focus: () => void) => void,
    suggestedSettings?: Partial<PresentationLaunchSettings>,
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
        "Open PaperChat's trusted native presentation settings window when the user wants to create, generate, make, or retry a PPT. Call this for concise requests such as '为这篇论文生成一个 PPT' and for a follow-up such as '重试下' when the preceding PPT attempt failed. Pass only explicit structured suggestions from the user's request: sourceItemKey/sourceLibraryID for a Zotero mention, slideCount (4-30), designSystem, and instructions. Omit every field the user did not specify: for '为这篇论文生成一个 10 页的 PPT', call with only {\"slideCount\":10}; never choose a default designSystem or send empty instructions. The plugin resolves the source, checks balance, and lets the user confirm or edit every suggestion in the native settings window. Never use request_user_input for these settings. After the user confirms, follow the tool result and call the newly available private presentation tool.",
      parameters:
        PRESENTATION_LAUNCH_PARAMETERS as unknown as ToolDefinition["function"]["parameters"],
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
  let activeSource: Readonly<PresentationSourceContext> = Object.freeze({
    ...(options.source || {}),
  });
  const completion = createDeferred<void>();
  let finished = false;
  let authorization: PresentationLaunchAuthorization | undefined;
  let authorizationRequest: Promise<PresentationToolLaunchResult> | undefined;
  let launchIntentFingerprint: string | undefined;
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

  const normalizeIntent = (
    value: PresentationLaunchIntent | null | undefined,
  ): PresentationLaunchIntent => {
    const intent = value || {};
    const slideCount = parsePresentationSlideCount(intent.slideCount);
    const instructions = normalizePresentationUserInstructions(
      intent.instructions,
    );
    return {
      ...(typeof intent.sourceItemKey === "string" &&
      intent.sourceItemKey.trim()
        ? { sourceItemKey: intent.sourceItemKey.trim() }
        : {}),
      ...(Number.isSafeInteger(intent.sourceLibraryID) &&
      intent.sourceLibraryID! > 0
        ? { sourceLibraryID: intent.sourceLibraryID }
        : {}),
      ...(slideCount !== null ? { slideCount } : {}),
      ...(isPresentationDesignSystem(intent.designSystem)
        ? { designSystem: intent.designSystem }
        : {}),
      ...(instructions ? { instructions } : {}),
    };
  };

  const requestAuthorization = (
    requestedIntent?: PresentationLaunchIntent,
  ): Promise<PresentationToolLaunchResult> => {
    const intent = normalizeIntent(requestedIntent);
    const nextFingerprint = JSON.stringify(intent);
    if (finished) {
      return Promise.resolve({ allowed: false, reason: "turn_finished" });
    }
    if (authorization) {
      if (launchIntentFingerprint !== nextFingerprint) {
        return Promise.resolve({ allowed: false, reason: "already_active" });
      }
      return Promise.resolve({ allowed: true, authorization });
    }
    if (authorizationRequest) {
      return launchIntentFingerprint === nextFingerprint
        ? authorizationRequest
        : Promise.resolve({ allowed: false, reason: "already_active" });
    }

    const sourceResolution = options.resolveSource
      ? options.resolveSource(intent, activeSource)
      : activeSource.itemKey && Number.isSafeInteger(activeSource.libraryID)
        ? {
            allowed: true as const,
            source: {
              itemKey: activeSource.itemKey,
              libraryID: activeSource.libraryID!,
            },
          }
        : { allowed: false as const, reason: "source_unavailable" as const };
    if (!sourceResolution.allowed) {
      return Promise.resolve({
        allowed: false,
        reason: sourceResolution.reason,
      });
    }
    launchIntentFingerprint = nextFingerprint;
    activeSource = Object.freeze({ ...sourceResolution.source });
    const suggestedSettings: Partial<PresentationLaunchSettings> = {
      ...(intent.slideCount !== undefined
        ? { slideCount: intent.slideCount }
        : {}),
      ...(intent.designSystem ? { designSystem: intent.designSystem } : {}),
      ...(intent.instructions !== undefined
        ? { userInstructions: intent.instructions }
        : {}),
    };

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
            options.runGuard(setConfigurationFocus, suggestedSettings),
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
            sourceResolution.source,
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
        createPresentationLaunchKey(sourceResolution.source),
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
    get source() {
      return activeSource;
    },
    requestAuthorization,
    getAuthorization: () => (finished ? undefined : authorization),
    finish,
  };
}
