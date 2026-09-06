import type { ThemeColors } from "./types";
import { getString } from "../../../utils/locale";
import { updateAnimatedBalance } from "./AnimatedBalance";

export function updateChatHeaderTitle(
  container: HTMLElement,
  session: { title?: string } | null | undefined,
): void {
  const element = container.querySelector(
    "#chat-header-title",
  ) as HTMLElement | null;
  if (!element) return;
  const title = session?.title?.trim() || getString("chat-new-chat");
  element.textContent = title;
  element.title = title;
}

export function updateChatBalanceWarning(
  container: HTMLElement,
  show: boolean,
  balance: string = "",
): void {
  const strip = container.querySelector(
    "#chat-balance-warning",
  ) as HTMLElement | null;
  const button = container.querySelector(
    "#chat-balance-warning-button",
  ) as HTMLElement | null;
  if (!strip || !button) return;
  const text = show
    ? getString("chat-low-balance-warning", { args: { balance } })
    : "";
  // Do not repeatedly announce an unchanged balance after unrelated UI updates.
  if (button.textContent !== text) button.textContent = text;
  strip.style.display = show ? "block" : "none";
}

export function updateHeaderAccountCaption(
  container: HTMLElement,
  options: {
    paperChat: boolean;
    interactive?: boolean;
    label: string;
    description: string;
    low?: boolean;
    balance?: number;
  },
): void {
  const caption = container.querySelector(
    "#chat-header-account-caption",
  ) as HTMLButtonElement | null;
  const accountArea = container.querySelector(
    "#chat-header-account",
  ) as HTMLElement | null;
  if (accountArea)
    accountArea.style.display = options.paperChat ? "flex" : "none";
  if (caption) {
    caption.disabled = !options.interactive;
    updateAnimatedBalance(caption, options.label, options.balance);
    caption.title = options.description;
    caption.setAttribute("data-low-balance", options.low ? "true" : "false");
  }
}

/** Presentation-only overrides. Message parsing and streaming stay untouched. */
export function getChatChromeStyles(theme: ThemeColors): string {
  return `
    .chat-panel-root { min-width: 0; color: ${theme.textPrimary}; color-scheme: light dark; }
    .chat-panel-root #chat-header {
      display: grid; grid-template-columns: minmax(0, 1fr); align-items: center;
      column-gap: 8px; row-gap: 6px; flex-shrink: 0; min-height: 48px; padding: 8px 14px; box-sizing: border-box;
      border-bottom: 1px solid ${theme.borderColor}; background: ${theme.toolbarBg};
    }
    .chat-panel-root #chat-header-title {
      font-weight: 600; white-space: normal; margin-right: auto; flex: 1;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
      line-height: 1.45; max-height: 2.9em; overflow-wrap: anywhere;
      overflow: hidden; text-overflow: ellipsis; min-width: 0;
    }
    .chat-panel-root #chat-session-actions { display: flex; gap: 2px; flex-shrink: 0; }
    .chat-panel-root #chat-header-account {
      grid-column: 1 / -1; display: flex; align-items: center; gap: 10px;
      min-width: 0; padding-top: 2px;
    }
    .chat-panel-root #chat-header-account-caption {
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      border: 0; padding: 0; background: transparent; font: inherit; text-align: left;
      font-size: .85em; line-height: 1.4; color: ${theme.textSecondary}; opacity: 1;
      cursor: default; font-variant-numeric: tabular-nums;
    }
    .chat-panel-root #chat-header-account-caption:not(:disabled) { cursor: pointer; }
    .chat-panel-root #chat-header-account-caption:not(:disabled):hover { text-decoration: underline; }
    .chat-panel-root #chat-header-account-caption[data-low-balance="true"] {
      color: ${theme.containerBg === "#1e1e1e" ? "#fca5a5" : "#b42318"};
    }
    .chat-panel-root #chat-checkin-btn {
      align-items: center; justify-content: center; min-height: 26px;
      padding: 3px 9px; border: 1px solid ${theme.borderColor}; border-radius: 6px;
      background: transparent; color: ${theme.textSecondary}; font: inherit;
      font-size: .85em; line-height: 1.4; flex-shrink: 0;
    }
    .chat-panel-root #chat-checkin-btn:hover:not(:disabled) { background: ${theme.hoverBg}; }
    .chat-panel-root #chat-checkin-btn:disabled { border-color: transparent; }
    .chat-panel-root #chat-user-bar {
      padding: 0 8px 10px; margin: 0; min-width: 0;
      background: transparent !important; color: ${theme.textSecondary} !important;
    }
    .chat-panel-root #chat-user-usage-row {
      align-items: flex-start; flex-direction: column; gap: 8px;
    }
    .chat-panel-root #chat-user-balance { font-variant-numeric: tabular-nums; font-size: 1em !important; }
    .chat-panel-root #chat-user-subscription { min-width: 64px; }
    .chat-panel-root #chat-user-subscription-progress { height: 3px !important; }
    .chat-panel-root #chat-balance-warning {
      flex-shrink: 0; padding: 5px 14px 7px; border-bottom: 1px solid ${theme.borderColor};
    }
    .chat-panel-root #chat-balance-warning-button {
      display: block; padding: 0; width: 100%; border: 0; background: transparent;
      color: ${theme.containerBg === "#1e1e1e" ? "#fca5a5" : "#b42318"};
      font: inherit; font-size: .92em; line-height: 1.5; text-align: left; cursor: pointer;
    }
    .chat-panel-root #chat-balance-warning-button:hover { text-decoration: underline; }
    .chat-panel-root #chat-account-menu { flex-shrink: 0; margin-left: auto; }
    .chat-panel-root #chat-account-trigger {
      display: flex; align-items: center; justify-content: center; list-style: none;
      width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
      background: ${theme.buttonBg};
    }
    .chat-panel-root #chat-account-trigger::-webkit-details-marker { display: none; }
    .chat-panel-root #chat-account-trigger img { width: 19px; height: 19px; }
    .chat-panel-root #chat-account-panel {
      position: absolute; right: 10px; top: 100%; z-index: 10004;
      width: 220px; max-width: calc(100% - 20px); box-sizing: border-box;
      padding: 8px; border-radius: 10px; border: 1px solid ${theme.borderColor};
      background: ${theme.dropdownBg}; color: ${theme.textPrimary};
      box-shadow: 0 8px 24px rgba(0,0,0,.12);
    }
    .chat-panel-root #chat-account-details {
      padding-bottom: 0; margin-bottom: 0;
    }
    .chat-panel-root #chat-user-name { display: block; padding: 8px; }
    .chat-panel-root #chat-account-panel button {
      width: 100% !important; height: auto !important; min-height: 32px;
      padding: 7px 8px !important; gap: 8px; justify-content: flex-start !important;
      text-align: left; border: 0 !important; border-radius: 5px !important;
      background: transparent !important; color: ${theme.textSecondary} !important;
      font: inherit;
    }
    .chat-panel-root #chat-session-actions button,
    .chat-panel-root #chat-toolbar button {
      display: flex; align-items: center; justify-content: center;
      min-width: 30px; height: 30px; padding: 6px !important; flex-shrink: 0;
      border: 0 !important; border-radius: 6px; background: transparent !important;
    }
    .chat-panel-root #chat-toolbar button {
      gap: 10px; font: inherit; width: 100%; height: 34px;
      justify-content: flex-start; padding: 7px 9px !important;
    }
    .chat-panel-root #chat-toolbar button:disabled { opacity: .45 !important; cursor: not-allowed !important; }
    .chat-panel-root #chat-tools-menu { position: relative; flex-shrink: 0; }
    .chat-panel-root #chat-tools-trigger {
      display: flex; align-items: center; justify-content: center; list-style: none;
      width: 32px; padding: 0; border-radius: 8px;
      color: ${theme.textSecondary}; font-size: 24px; font-weight: 400;
      line-height: 1; cursor: pointer; user-select: none;
    }
    .chat-panel-root #chat-tools-trigger::-webkit-details-marker { display: none; }
    .chat-panel-root #chat-tools-trigger:hover,
    .chat-panel-root #chat-tools-menu[open] > summary { background: ${theme.hoverBg}; }
    .chat-panel-root .chat-tools-heading {
      padding: 5px 9px 4px; font-size: .8em; color: ${theme.textMuted};
    }
    .chat-panel-root .chat-tool-label { font-size: .92em; color: ${theme.textSecondary}; white-space: nowrap; }
    .chat-panel-root #chat-toolbar img { width: 15px !important; height: 15px !important; opacity: .8; }
    .chat-panel-root #chat-utility-actions { display: flex; flex-shrink: 0; gap: 2px; }
    .chat-panel-root #chat-session-actions button:hover,
    .chat-panel-root #chat-toolbar button:hover:not(:disabled),
    .chat-panel-root #chat-utility-actions button:hover,
    .chat-panel-root #chat-account-panel button:hover,
    .chat-panel-root #chat-account-trigger:hover {
      background: ${theme.hoverBg} !important;
    }
    .chat-panel-root button:focus-visible,
    .chat-panel-root summary:focus-visible {
      outline: 2px solid ${theme.inputFocusBorderColor}; outline-offset: 2px;
    }
    .chat-panel-root #chat-history { padding: 12px 18px 18px !important; }
    .chat-panel-root .chat-message { margin: 16px 0 !important; }
    .chat-panel-root .assistant-message > .chat-bubble {
      display: block !important; width: 100%; max-width: 100% !important;
      padding: 4px 0 !important; box-sizing: border-box;
      background: transparent !important; border: 0 !important;
      border-radius: 0 !important; box-shadow: none !important;
    }
    .chat-panel-root .user-message > .chat-bubble {
      padding: 9px 12px !important; border-radius: 12px !important;
      border-bottom-right-radius: 4px !important; box-shadow: none !important;
    }
    .chat-panel-root #chat-input-area { flex-shrink: 0; padding: 8px 12px 12px; }
    .chat-panel-root #chat-composer {
      border: 1px solid ${theme.inputBorderColor}; border-radius: 12px;
      background: ${theme.inputBg};
    }
    .chat-panel-root #chat-composer:focus-within {
      border-color: color-mix(in srgb, ${theme.inputBorderColor} 80%, ${theme.textSecondary});
    }
    .chat-panel-root #chat-input-wrapper {
      border: 0 !important; border-radius: 12px; background: transparent !important;
    }
    /* Zotero's native textarea focus ring would add a second border inside the composer. */
    .chat-panel-root #chat-message-input,
    .chat-panel-root #chat-message-input:focus,
    .chat-panel-root #chat-message-input:focus-visible {
      appearance: none; border: 0 !important; outline: none !important; box-shadow: none !important;
    }
    .chat-panel-root #chat-message-input::placeholder { color: ${theme.textMuted}; opacity: 1; }
    .chat-panel-root #chat-attachments-preview {
      border: 0 !important; background: transparent !important; padding: 10px 12px 0 !important;
    }
    .chat-panel-root #chat-input-bottom-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 8px 8px;
    }
    .chat-panel-root #chat-toolbar {
      position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 10004;
      width: 208px; max-height: min(320px, 60vh); overflow-y: auto;
      padding: 5px; box-sizing: border-box; border-radius: 10px;
      border: 1px solid ${theme.borderColor}; background: ${theme.dropdownBg};
      color: ${theme.textPrimary}; box-shadow: 0 6px 22px rgba(0,0,0,.12);
    }
    .chat-panel-root #chat-toolbar-primary-actions,
    .chat-panel-root #chat-toolbar-secondary-actions { display: flex; flex-direction: column; gap: 1px; }
    .chat-panel-root #chat-toolbar-secondary-actions {
      border-top: 1px solid ${theme.borderColor}; margin-top: 4px; padding-top: 4px;
    }
    .chat-panel-root #chat-footer { padding-top: 5px; }
    .chat-panel-root #chat-utility-actions { margin-left: auto; align-items: center; }
    .chat-panel-root #chat-tools-trigger,
    .chat-panel-root #chat-model-selector-btn,
    .chat-panel-root #chat-send-button {
      appearance: none; box-sizing: border-box;
      height: 28px !important; min-height: 28px !important; margin-block: 0 !important;
    }
    .chat-panel-root #chat-model-selector-btn {
      background: ${theme.buttonBg} !important; border: 0 !important; border-radius: 8px;
      padding: 5px 9px !important; width: 100% !important;
    }
    .chat-panel-root #chat-model-selector-btn:hover { background: ${theme.buttonHoverBg} !important; }
    .chat-panel-root #chat-model-selector-text { text-align: left; }
    .chat-panel-root #chat-model-selector-help { flex-shrink: 0; margin: 0 3px; }
    .chat-panel-root #chat-send-button { border-radius: 8px !important; }
    .chat-panel-root #chat-empty-state { gap: 8px; padding: 24px; box-sizing: border-box; }
  `;
}

/** Native disclosure gives keyboard access without adding a second menu runtime. */
export function bindChatDisclosure(
  container: HTMLElement,
  menu: HTMLDetailsElement,
  trigger: HTMLElement,
): void {
  container.addEventListener("click", (event) => {
    if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
  });
  container.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      event.preventDefault();
      event.stopPropagation();
      menu.open = false;
      trigger.focus();
    }
  });
  // Do not dismiss on focus changes. On macOS, pressing a menu button can
  // focus the panel before mouseup/click; closing here would swallow its action.
  // Outside clicks and Escape dismiss the disclosure without that race.
}
