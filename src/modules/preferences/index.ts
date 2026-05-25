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
import { getAuthManager } from "../auth";
import { togglePaperChatNotice } from "./PaperChatNoticeRenderer";
import { updateUserDisplay } from "./UserAuthUI";
import type { PrefsRefreshOptions } from "./types";

/**
 * Register preferences scripts - main entry point
 */
export async function registerPrefsScripts(_window: Window): Promise<void> {
  addon.data.prefs = {
    window: _window,
  };

  try {
    await initializePrefsUI();
  } catch (error) {
    ztoolkit.log("[Preferences] Failed to initialize prefs UI:", error);
    try {
      updateUserDisplay(_window.document, getAuthManager());
    } catch (displayError) {
      ztoolkit.log(
        "[Preferences] Failed to update user display after init failure:",
        displayError,
      );
    }
  }
  try {
    bindPrefEvents();
  } catch (error) {
    ztoolkit.log("[Preferences] Failed to bind prefs events:", error);
  }
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
