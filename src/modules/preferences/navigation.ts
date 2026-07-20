const AGENT_MAX_PLANNING_ITERATIONS_INPUT_ID =
  "pref-agent-max-planning-iterations";
const PAPERCHAT_PREFERENCES_PANE_ID = "paperchat-prefpane";
const PREFERENCES_FOCUS_MAX_ATTEMPTS = 12;
const PREFERENCES_FOCUS_RETRY_DELAY_MS = 120;

function getLivePreferencesWindow(): Window | undefined {
  const prefsWindow =
    typeof addon !== "undefined" ? addon.data.prefs?.window : undefined;
  return prefsWindow && !prefsWindow.closed ? prefsWindow : undefined;
}

function isLiveInput(input: HTMLInputElement, prefsWindow: Window): boolean {
  if (input.ownerDocument && input.ownerDocument !== prefsWindow.document) {
    return false;
  }
  return input.isConnected !== false;
}

export function focusAgentMaxPlanningIterationsInput(
  attempt: number = 0,
): void {
  const prefsWindow = getLivePreferencesWindow();
  const input = prefsWindow?.document.getElementById(
    AGENT_MAX_PLANNING_ITERATIONS_INPUT_ID,
  ) as HTMLInputElement | null | undefined;

  if (prefsWindow && input && isLiveInput(input, prefsWindow)) {
    input.scrollIntoView({ block: "center", behavior: "smooth" });
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }
    input.select();
    return;
  }

  if (attempt >= PREFERENCES_FOCUS_MAX_ATTEMPTS) {
    return;
  }

  globalThis.setTimeout(
    () => focusAgentMaxPlanningIterationsInput(attempt + 1),
    attempt === 0 ? 0 : PREFERENCES_FOCUS_RETRY_DELAY_MS,
  );
}

export function openAgentMaxPlanningIterationsSettings(): void {
  Zotero.Utilities.Internal.openPreferences(PAPERCHAT_PREFERENCES_PANE_ID);
  focusAgentMaxPlanningIterationsInput();
}
