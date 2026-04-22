/**
 * Preferences module - Split from preferenceScript.ts
 *
 * This module provides the preferences UI for managing AI providers,
 * user authentication, and model settings.
 */

import {
  initializePrefsUI,
  bindPrefEvents,
  refreshPrefsUI as refreshPrefsUIState,
} from "./PreferencesManager";
import { togglePaperChatNotice } from "./PaperChatNoticeRenderer";
import type { PrefsRefreshOptions } from "./types";

/**
 * Register preferences scripts - main entry point
 */
export async function registerPrefsScripts(_window: Window): Promise<void> {
  addon.data.prefs = {
    window: _window,
  };

  await initializePrefsUI();
  bindPrefEvents();
}

export async function refreshPrefsUI(
  options?: PrefsRefreshOptions,
): Promise<void> {
  if (!addon.data.prefs?.window) {
    return;
  }

  await refreshPrefsUIState(options);
}

export function togglePaperChatNoticeUI(window: Window): void {
  togglePaperChatNotice(window.document);
}
