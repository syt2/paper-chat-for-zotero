import type { PresentationToolLaunchSession } from "./PresentationToolLaunchSession";
import type { PresentationMentionSource } from "./PresentationSourceContext";

export interface PresentationTaskLocation {
  sessionId: string;
  assistantMessageId: string;
}

export interface PresentationChatLaunchOptions {
  parentWindow?: Window;
  abortSignal?: AbortSignal;
  mentionSources?: readonly PresentationMentionSource[];
}

export interface PresentationChatLaunchBridge {
  canLaunch(item: Zotero.Item | null): boolean;
  createSession(
    item: Zotero.Item | null,
    location: PresentationTaskLocation,
    options?: PresentationChatLaunchOptions,
  ): PresentationToolLaunchSession | null;
}

let activeBridge: PresentationChatLaunchBridge | null = null;

function logBridgeFailure(
  operation: "canLaunch" | "createSession",
  error: unknown,
): void {
  try {
    ztoolkit.log(
      `[PresentationChatLaunchBridge] Optional adapter ${operation} failed:`,
      error,
    );
  } catch {
    // Logging is best-effort so this optional bridge stays inert in tests and
    // during partial startup/shutdown when the shared toolkit is unavailable.
  }
}

/** The app composition root installs the UI-backed presentation adapter. */
export function registerPresentationChatLaunchBridge(
  bridge: PresentationChatLaunchBridge,
): void {
  activeBridge = bridge;
}

export function unregisterPresentationChatLaunchBridge(): void {
  activeBridge = null;
}

export function canLaunchPresentationFromChat(
  item: Zotero.Item | null,
): boolean {
  try {
    return activeBridge?.canLaunch(item) === true;
  } catch (error) {
    logBridgeFailure("canLaunch", error);
    return false;
  }
}

export function createPresentationChatLaunchSession(
  item: Zotero.Item | null,
  location: PresentationTaskLocation,
  options?: PresentationChatLaunchOptions,
): PresentationToolLaunchSession | null {
  try {
    return activeBridge?.createSession(item, location, options) ?? null;
  } catch (error) {
    // The optional PPT adapter must never make an ordinary chat turn fail.
    logBridgeFailure("createSession", error);
    return null;
  }
}
