/**
 * Preferences module - Split from preferenceScript.ts
 *
 * This module provides the preferences UI for managing AI providers,
 * user authentication, and model settings.
 */

import { initializePrefsUI, bindPrefEvents } from "./PreferencesManager";

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
