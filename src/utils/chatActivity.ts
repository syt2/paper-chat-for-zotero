/**
 * Tracks whether PaperChat is currently in use (chat panel open) and lets
 * non-UI modules react to the panel being closed.
 *
 * This module stays dependency-free on purpose: the self-update scheduler and
 * the chat panel both import it, so it must not pull either of them in.
 */

const closedListeners = new Set<() => void>();

let inUseCheck: () => boolean = () => false;

/** Registers the probe used to detect an open chat panel. */
export function setChatInUseCheck(check: () => boolean): void {
  inUseCheck = check;
}

export function isChatInUse(): boolean {
  try {
    return inUseCheck();
  } catch {
    return false;
  }
}

/** Runs the listener whenever the user closes the chat panel. */
export function onChatPanelClosed(listener: () => void): void {
  closedListeners.add(listener);
}

export function notifyChatPanelClosed(): void {
  for (const listener of [...closedListeners]) {
    try {
      listener();
    } catch (error) {
      ztoolkit.log("[ChatActivity] Panel-closed listener failed:", error);
    }
  }
}

export function resetChatActivityForTests(): void {
  closedListeners.clear();
  inUseCheck = () => false;
}
