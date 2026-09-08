import type { ThemeColors } from "./types";
import { getString } from "../../../utils/locale";
import { updateAnimatedBalance } from "./AnimatedBalance";
import type { SubscriptionUsageSummary } from "../../../types/auth";

/** Native multiline tooltip: one line per current subscription, no historical plans. */
export function getSubscriptionUsageTooltip(
  usage: SubscriptionUsageSummary,
  now: number = Date.now(),
): string {
  const summary = `${getString("user-panel-used")}: ${usage.amountUsedLabel} / ${usage.amountTotalLabel}`;
  if (!usage.details?.length) return summary;
  const dateLabel = (timestamp: number, fallback: string): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return fallback;
    const remaining =
      (timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1000) - now;
    if (remaining <= 0) return getString("chat-subscription-time-reached");
    const [unit, duration] =
      remaining >= 86_400_000
        ? (["days", 86_400_000] as const)
        : remaining >= 3_600_000
          ? (["hours", 3_600_000] as const)
          : (["minutes", 60_000] as const);
    return getString(`chat-subscription-in-${unit}`, {
      args: { count: Math.max(1, Math.floor(remaining / duration)) },
    });
  };
  return usage.details
    .map((detail) =>
      getString("chat-subscription-detail", {
        args: {
          plan: detail.planId,
          remaining: detail.amountRemainingLabel,
          total: detail.amountTotalLabel,
          reset: dateLabel(
            detail.nextResetTime,
            getString("chat-subscription-no-reset"),
          ),
          expires: dateLabel(
            detail.endTime,
            getString("chat-subscription-unknown-expiry"),
          ),
        },
      }),
    )
    .join("\n");
}

/** Shared details for either visible quota control. No account state is mutated here. */
export function updateAccountQuotaDetails(
  container: HTMLElement,
  usage: SubscriptionUsageSummary | null,
  balance: string | null,
): void {
  const area = container.querySelector("#chat-account-quota");
  area?.setAttribute("data-available", balance === null ? "false" : "true");
  const plans = container.querySelector("#chat-quota-subscription-details");
  const wallet = container.querySelector("#chat-quota-wallet-details");
  if (plans)
    plans.textContent =
      balance === null
        ? ""
        : usage
          ? getSubscriptionUsageTooltip(usage)
          : getString("chat-quota-no-subscriptions");
  if (wallet)
    wallet.textContent =
      balance === null
        ? ""
        : getString("chat-quota-wallet-remaining", { args: { balance } });
  for (const selector of ["#chat-user-subscription", "#chat-account-balance"]) {
    const trigger = container.querySelector(selector);
    if (balance === null) trigger?.removeAttribute("aria-describedby");
    else {
      trigger?.setAttribute("aria-describedby", "chat-quota-popover");
      trigger?.removeAttribute("title");
    }
  }
}

/** Element-owned listeners: hover/focus refresh relative times; Escape dismisses. */
export function bindAccountQuotaPopover(
  container: HTMLElement,
  refresh: () => void,
): void {
  const area = container.querySelector(
    "#chat-account-quota",
  ) as HTMLElement | null;
  if (!area) return;
  const show = () => {
    area.removeAttribute("data-dismissed");
    refresh();
  };
  area.addEventListener("mouseenter", show);
  area.addEventListener("focusin", show);
  area.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    area.setAttribute("data-dismissed", "true");
    event.stopPropagation();
  });
  area.addEventListener("click", () =>
    area.setAttribute("data-dismissed", "true"),
  );
}

export function updateChatHeaderTitle(
  container: HTMLElement,
  session: { id?: string; title?: string } | null | undefined,
): void {
  const element = container.querySelector(
    "#chat-header-title",
  ) as HTMLElement | null;
  if (!element) return;
  const editButton = container.querySelector(
    "#chat-edit-title",
  ) as HTMLButtonElement | null;
  if (editButton) editButton.disabled = !session?.id;
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

export function updateAccountBalance(
  container: HTMLElement,
  options: {
    paperChat: boolean;
    interactive?: boolean;
    label: string;
    description: string;
    low?: boolean;
    balance?: number;
    hidden?: boolean;
  },
): void {
  const caption = container.querySelector(
    "#chat-account-balance",
  ) as HTMLButtonElement | null;
  const accountArea = container.querySelector(
    "#chat-account-area",
  ) as HTMLElement | null;
  if (accountArea)
    accountArea.style.display = options.paperChat ? "flex" : "none";
  if (caption) {
    caption.style.display = options.hidden ? "none" : "";
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
      display: flex; align-items: center;
      column-gap: 8px; row-gap: 6px; flex-shrink: 0; min-height: 48px; padding: 8px 14px; box-sizing: border-box;
      border-bottom: 1px solid ${theme.borderColor}; background: ${theme.toolbarBg};
    }
    .chat-panel-root #chat-edit-title {
      display: flex; align-items: center; justify-content: center; flex: 0 0 24px;
      width: 24px; height: 24px; padding: 0; border: none; border-radius: 4px;
      background: transparent; color: ${theme.textMuted}; font-size: 13px; cursor: pointer;
    }
    .chat-panel-root #chat-edit-title:hover { background: ${theme.hoverBg}; }
    .chat-panel-root #chat-edit-title:disabled { opacity: .4; cursor: default; }
    .chat-panel-root #chat-header-title {
      font-weight: 600; white-space: normal; margin-right: auto; flex: 1;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
      line-height: 1.45; max-height: 2.9em; overflow-wrap: anywhere;
      overflow: hidden; text-overflow: ellipsis; min-width: 0;
    }
    .chat-panel-root #chat-header-login {
      flex: 0 0 auto; margin-left: auto; white-space: nowrap;
      border: 1px solid ${theme.borderColor}; border-radius: 6px; padding: 4px 8px;
      background: transparent; color: ${theme.textSecondary}; font: inherit;
      font-size: .85em; line-height: 1.4; cursor: pointer;
    }
    .chat-panel-root #chat-header-login:hover { background: ${theme.hoverBg}; }
    .chat-panel-root #chat-session-actions { display: flex; gap: 2px; flex-shrink: 0; }
    .chat-panel-root #chat-history-btn { position: relative; }
    .chat-panel-root .chat-unread-dot {
      position: absolute; width: 6px; height: 6px; border-radius: 50%;
      background: #16a34a; pointer-events: none;
    }
    .chat-panel-root #chat-history-btn > .chat-unread-dot { top: 2px; right: 2px; }
    .chat-panel-root [data-history-session-id] > .chat-unread-dot { top: 18px; left: 4px; }
    .chat-panel-root #chat-account-area {
      display: flex; align-items: center; justify-content: flex-start; gap: 4px;
      min-width: 0; flex: 0 1 auto; flex-wrap: wrap; align-self: stretch;
      margin-inline-start: 8px;
    }
    .chat-panel-root #chat-account-quota {
      display: flex; align-items: center; justify-content: flex-start; flex-wrap: wrap;
      gap: 3px 6px; min-width: 0; align-self: stretch;
    }
    .chat-panel-root #chat-quota-popover {
      visibility: hidden; position: absolute; left: 0; right: 0; bottom: calc(100% - 5px);
      z-index: 10005; padding: 12px; border: 1px solid ${theme.borderColor};
      border-radius: 9px; background: ${theme.dropdownBg}; color: ${theme.textPrimary};
      box-shadow: 0 4px 16px rgba(0,0,0,.12); font-size: .85em; line-height: 1.6;
      max-height: min(360px, 60vh); overflow-y: auto; overflow-wrap: anywhere;
    }
    .chat-panel-root #chat-account-quota[data-available="true"]:not([data-dismissed]):hover #chat-quota-popover {
      visibility: visible; transition: visibility 0s linear 0.3s;
    }
    .chat-panel-root #chat-account-quota[data-available="true"]:not([data-dismissed]):focus-within #chat-quota-popover {
      visibility: visible; transition: none;
    }
    .chat-panel-root .chat-quota-section + .chat-quota-section {
      margin-top: 10px; padding-top: 10px; border-top: 1px solid ${theme.borderColor};
    }
    .chat-panel-root .chat-quota-heading { font-weight: 600; margin-bottom: 4px; }
    .chat-panel-root #chat-quota-subscription-details { white-space: pre-line; color: ${theme.textSecondary}; }
    .chat-panel-root #chat-quota-wallet-details { color: ${theme.textSecondary}; font-variant-numeric: tabular-nums;
    }
    .chat-panel-root #chat-account-balance {
      flex: 0 0 auto; width: max-content; min-width: max-content; white-space: nowrap;
      border: 0; padding: 2px 0; background: transparent; font: inherit; text-align: left;
      font-size: .8em; line-height: 1.4; color: ${theme.textSecondary}; opacity: 1;
      cursor: default; font-variant-numeric: tabular-nums;
    }
    .chat-panel-root #chat-account-balance:not(:disabled) { cursor: pointer; }
    .chat-panel-root #chat-account-balance:not(:disabled):hover { text-decoration: underline; }
    .chat-panel-root #chat-account-balance[data-low-balance="true"] {
      color: ${theme.containerBg === "#1e1e1e" ? "#fca5a5" : "#b42318"};
    }
    .chat-panel-root #chat-checkin-btn {
      align-items: center; justify-content: center; min-height: 22px;
      padding: 2px 4px; border: 0; border-radius: 4px;
      background: ${theme.buttonBg}; color: ${theme.textSecondary}; font: inherit;
      font-size: .8em; line-height: 1.4; flex-shrink: 0;
    }
    .chat-panel-root #chat-checkin-btn:hover:not(:disabled) { background: ${theme.hoverBg}; }
    .chat-panel-root #chat-checkin-btn:disabled { border-color: transparent; }
    .chat-panel-root #chat-user-subscription { min-width: 64px; }
    .chat-panel-root #chat-user-subscription-progress {
      height: 3px !important; background: rgba(96, 145, 195, .28);
    }
    .chat-panel-root #chat-user-subscription-progress-fill { background: #6a91b9; }
    .chat-panel-root #chat-user-subscription[data-subscription-limit-clickable="true"] #chat-user-subscription-progress {
      background: rgba(215, 107, 104, .2);
    }
    .chat-panel-root #chat-user-subscription[data-subscription-limit-clickable="true"] #chat-user-subscription-progress-fill {
      background: #d76b68;
    }
    .chat-panel-root #chat-balance-warning {
      flex-shrink: 0; padding: 5px 14px 7px; border-bottom: 1px solid ${theme.borderColor};
    }
    .chat-panel-root #chat-balance-warning-button {
      display: block; padding: 0; width: 100%; border: 0; background: transparent;
      color: ${theme.containerBg === "#1e1e1e" ? "#fca5a5" : "#b42318"};
      font: inherit; font-size: .92em; line-height: 1.5; text-align: left; cursor: pointer;
    }
    .chat-panel-root #chat-balance-warning-button:hover { text-decoration: underline; }
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
    .chat-panel-root #chat-utility-actions button:hover {
      background: ${theme.hoverBg} !important;
    }
    .chat-panel-root button:focus-visible,
    .chat-panel-root summary:focus-visible {
      outline: 2px solid ${theme.inputFocusBorderColor}; outline-offset: 2px;
    }
    .chat-panel-root .chat-message { margin: 16px 0 !important; }
    .chat-panel-root #chat-viewport[data-turn-navigation] #chat-history { padding-left: 20px !important; }
    .chat-panel-root .chat-turn-rail {
      position: absolute; left: 2px; width: 16px; z-index: 3;
      flex-direction: column; align-items: stretch; gap: var(--turn-marker-gap);
      overflow: hidden;
    }
    .chat-panel-root .chat-turn-tick {
      display: flex; align-items: center; justify-content: flex-start;
      flex: 0 0 var(--turn-marker-size); width: 16px; min-height: 0; height: var(--turn-marker-size); padding: 0 2px;
      border: 0; border-radius: 3px; background: transparent; cursor: pointer;
    }
    .chat-panel-root .chat-turn-tick::before {
      content: ""; height: 2px; width: var(--turn-marker-size); border-radius: 1px; flex-shrink: 0;
      background: ${theme.textMuted}; opacity: .4;
    }
    .chat-panel-root .chat-turn-tick[aria-current]::before {
      height: var(--turn-marker-size); border-radius: 50%; background: ${theme.textPrimary}; opacity: .95;
    }
    .chat-panel-root .chat-turn-tick:not([aria-current]):hover::before,
    .chat-panel-root .chat-turn-tick:not([aria-current]):focus-visible::before {
      height: var(--turn-marker-size); border-radius: 50%; opacity: .75;
    }
    .chat-panel-root .chat-turn-tick:focus-visible { outline-offset: -2px; }
    .chat-panel-root .chat-turn-preview {
      position: absolute; left: 30px; z-index: 4; pointer-events: none;
      width: 290px; max-width: calc(100% - 42px); box-sizing: border-box;
      padding: 10px 12px; border: 1px solid ${theme.borderColor}; border-radius: 10px;
      background: ${theme.dropdownBg}; color: ${theme.textPrimary};
      box-shadow: 0 3px 12px rgba(0, 0, 0, .1); font-size: .85em; line-height: 1.5;
    }
    .chat-panel-root .chat-turn-preview-question,
    .chat-panel-root .chat-turn-preview-answer {
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
      overflow: hidden; overflow-wrap: anywhere;
    }
    .chat-panel-root .chat-turn-preview-question { font-weight: 600; }
    .chat-panel-root .chat-turn-preview-answer { color: ${theme.textMuted}; margin-top: 4px; }
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
    .chat-panel-root[data-file-drag] #chat-composer {
      outline: 2px dashed ${theme.textMuted}; outline-offset: 2px;
      background: ${theme.hoverBg};
    }
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
    .chat-panel-root #chat-footer { position: relative; padding-top: 5px; width: 100%; flex: none !important; }
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
