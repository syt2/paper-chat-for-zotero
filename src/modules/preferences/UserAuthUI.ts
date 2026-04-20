/**
 * UserAuthUI - User authentication status display and events
 */

import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { prefColors } from "../../utils/colors";
import { getAuthManager } from "../auth";
import { BUILTIN_PROVIDERS } from "../providers";
import { showAuthDialog } from "../ui/AuthDialog";
import type { PrefsRefreshOptions } from "./types";
import { showMessage } from "./utils";

type AuthManagerType = ReturnType<typeof getAuthManager>;

const LOW_BALANCE_WARNING_THRESHOLD = 5000;
const PREFS_REFRESH_MAX_ATTEMPTS = 12;
const PREFS_REFRESH_RETRY_DELAY_MS = 120;
const TOPUP_ATTENTION_DURATION_MS = 8000;

type TopupAttentionAddonData = typeof addon.data & {
  paperchatTopupAttentionUntil?: number;
};

function getTopupAttentionAddonData(): TopupAttentionAddonData {
  return addon.data as TopupAttentionAddonData;
}

function markTopupAttentionRequested(): void {
  getTopupAttentionAddonData().paperchatTopupAttentionUntil =
    Date.now() + TOPUP_ATTENTION_DURATION_MS;
}

function hasActiveTopupAttention(): boolean {
  const attentionUntil = getTopupAttentionAddonData().paperchatTopupAttentionUntil;
  return typeof attentionUntil === "number" && attentionUntil > Date.now();
}

function shouldHighlightTopup(
  authManager: AuthManagerType,
): { highlight: boolean; forced: boolean; lowBalance: boolean } {
  const lowBalance =
    authManager.isLoggedIn() &&
    authManager.getBalance().quota < LOW_BALANCE_WARNING_THRESHOLD;
  const forced = hasActiveTopupAttention();

  return {
    highlight: lowBalance || forced,
    forced,
    lowBalance,
  };
}

function animateTopupElement(
  element: HTMLElement,
  animationKey: string,
  keyframes: Keyframe[],
  duration: number,
  fallbackResetDelay: number,
): void {
  const attr = `data-${animationKey}-animated`;
  if (element.getAttribute(attr) === "true") {
    return;
  }

  element.setAttribute(attr, "true");
  try {
    const animation = element.animate?.(
      keyframes,
      {
        duration,
        easing: "ease-out",
        iterations: 2,
      },
    );

    if (animation) {
      animation.addEventListener("finish", () => {
        element.removeAttribute(attr);
      });
      return;
    }
  } catch (error) {
    ztoolkit.log("[Preferences] Topup animation unavailable:", error);
  }

  setTimeout(() => {
    element.removeAttribute(attr);
  }, fallbackResetDelay);
}

function animateTopupButton(button: HTMLElement): void {
  animateTopupElement(
    button,
    "topup-button",
    [
      {
        transform: "translateX(-6px) scale(1)",
        boxShadow: "0 0 0 rgba(255, 145, 0, 0)",
        opacity: 0.88,
      },
      {
        transform: "translateX(6px) scale(1.04)",
        boxShadow: "0 0 0 6px rgba(255, 145, 0, 0.18)",
        opacity: 1,
      },
      {
        transform: "translateX(0) scale(1)",
        boxShadow: "0 0 0 rgba(255, 145, 0, 0)",
        opacity: 1,
      },
    ],
    1400,
    2800,
  );
}

function animateLowBalanceLabel(label: HTMLElement): void {
  animateTopupElement(
    label,
    "topup-balance",
    [
      {
        transform: "translateX(0) scale(1)",
        textShadow: "0 0 0 rgba(220, 38, 38, 0)",
        opacity: 0.92,
      },
      {
        transform: "translateX(2px) scale(1.04)",
        textShadow: "0 0 10px rgba(220, 38, 38, 0.28)",
        opacity: 1,
      },
      {
        transform: "translateX(0) scale(1)",
        textShadow: "0 0 0 rgba(220, 38, 38, 0)",
        opacity: 1,
      },
    ],
    1400,
    2800,
  );
}

function scheduleWithAvailableTimer(callback: () => void, delay: number): void {
  const prefsWindow = addon.data.prefs?.window;
  if (prefsWindow?.setTimeout) {
    prefsWindow.setTimeout(callback, delay);
    return;
  }

  setTimeout(callback, delay);
}

function schedulePrefsRefresh(
  options: PrefsRefreshOptions,
  attempt: number = 0,
): void {
  scheduleWithAvailableTimer(() => {
    if (!addon.data.prefs?.window) {
      if (attempt < PREFS_REFRESH_MAX_ATTEMPTS) {
        schedulePrefsRefresh(options, attempt + 1);
      }
      return;
    }

    void import("./index")
      .then((module) => module.refreshPrefsUI(options))
      .catch((error) => {
        ztoolkit.log("[Preferences] Failed to refresh PaperChat prefs UI:", error);
      });
  }, attempt === 0 ? 0 : PREFS_REFRESH_RETRY_DELAY_MS);
}

function applyTopupAttentionStyles(
  userBalanceEl: HTMLElement | null,
  getRedeemCodeBtn: HTMLElement | null,
  options: { highlight: boolean; forced: boolean; lowBalance: boolean },
): void {
  if (userBalanceEl) {
    userBalanceEl.style.color = options.lowBalance ? prefColors.testError : "";
    userBalanceEl.style.fontWeight = options.lowBalance ? "700" : "";
    userBalanceEl.style.opacity = options.lowBalance ? "1" : "0.8";
    userBalanceEl.style.textShadow = "";

    if (options.lowBalance) {
      animateLowBalanceLabel(userBalanceEl);
    }
  }

  if (!getRedeemCodeBtn) {
    return;
  }

  if (options.highlight) {
    getRedeemCodeBtn.style.border = "1px solid #f59e0b";
    getRedeemCodeBtn.style.background =
      "linear-gradient(135deg, rgba(255, 244, 214, 0.98), rgba(255, 223, 128, 0.98))";
    getRedeemCodeBtn.style.boxShadow = "0 0 0 3px rgba(245, 158, 11, 0.18)";
    getRedeemCodeBtn.style.fontWeight = "700";
    animateTopupButton(getRedeemCodeBtn);
  } else {
    getRedeemCodeBtn.style.border = "";
    getRedeemCodeBtn.style.background = "";
    getRedeemCodeBtn.style.boxShadow = "";
    getRedeemCodeBtn.style.fontWeight = "";
  }
}

export function openPaperChatSettingsForTopup(): void {
  markTopupAttentionRequested();
  Zotero.Utilities.Internal.openPreferences("paperchat-prefpane");
  schedulePrefsRefresh({
    syncUserInfo: true,
    providerId: "paperchat",
  });
}

export function openPaperChatPreferences(): void {
  Zotero.Utilities.Internal.openPreferences("paperchat-prefpane");
  schedulePrefsRefresh({
    syncUserInfo: true,
  });
}

/**
 * Update user status display in preferences
 */
export function updateUserDisplay(
  doc: Document,
  authManager: AuthManagerType,
): void {
  const userStatusEl = doc.getElementById(
    "pref-user-status",
  ) as HTMLElement | null;
  const userBalanceEl = doc.getElementById(
    "pref-user-balance",
  ) as HTMLElement | null;
  const userUsedEl = doc.getElementById("pref-user-used") as HTMLElement | null;
  const loginBtn = doc.getElementById("pref-login-btn") as HTMLElement | null;
  const getRedeemCodeBtn = doc.getElementById(
    "pref-get-redeem-code-btn",
  ) as HTMLElement | null;
  const topupAttention = shouldHighlightTopup(authManager);

  if (authManager.isLoggedIn()) {
    const user = authManager.getUser();
    if (userStatusEl) {
      userStatusEl.setAttribute(
        "value",
        `${getString("user-panel-logged-in", { args: { username: user?.username || "" } })}`,
      );
      userStatusEl.style.color = prefColors.userLoggedIn;
    }
    if (userBalanceEl) {
      userBalanceEl.setAttribute(
        "value",
        `${getString("user-panel-balance")}: ${authManager.formatBalance()}`,
      );
    }
    if (userUsedEl) {
      userUsedEl.setAttribute(
        "value",
        `${getString("user-panel-used")}: ${authManager.formatUsedQuota()}`,
      );
    }
    if (loginBtn) {
      loginBtn.setAttribute("label", getString("user-panel-logout-btn"));
    }
    // Show get redeem code button
    if (getRedeemCodeBtn) {
      getRedeemCodeBtn.style.display = "inline-block";
    }
  } else {
    if (userStatusEl) {
      userStatusEl.setAttribute("value", getString("user-panel-not-logged-in"));
      userStatusEl.style.color = prefColors.userLoggedOut;
    }
    if (userBalanceEl) {
      userBalanceEl.setAttribute("value", "");
    }
    if (userUsedEl) {
      userUsedEl.setAttribute("value", "");
    }
    if (loginBtn) {
      loginBtn.setAttribute("label", getString("user-panel-login-btn"));
    }
    // Hide get redeem code button
    if (getRedeemCodeBtn) {
      getRedeemCodeBtn.style.display = "none";
    }
  }

  applyTopupAttentionStyles(userBalanceEl, getRedeemCodeBtn, topupAttention);
}

/**
 * Bind user authentication events
 */
export function bindUserAuthEvents(
  doc: Document,
  authManager: AuthManagerType,
  onProviderListRefresh: () => void,
): () => void {
  // Login/Logout button
  const loginBtn = doc.getElementById("pref-login-btn");
  loginBtn?.addEventListener("click", async () => {
    if (authManager.isLoggedIn()) {
      await authManager.logout();
      updateUserDisplay(doc, authManager);
      showMessage(doc, getString("auth-success"), false);
    } else {
      const success = await showAuthDialog("login");
      if (success) {
        updateUserDisplay(doc, authManager);
        showMessage(doc, getString("auth-success"), false);
      }
    }
  });

  // Redeem button
  const redeemBtn = doc.getElementById("pref-redeem-btn");
  const redeemInput = doc.getElementById(
    "pref-redeem-code",
  ) as HTMLInputElement;

  redeemBtn?.addEventListener("click", async () => {
    const code = redeemInput?.value?.trim();
    if (!code) {
      showMessage(doc, getString("auth-error-redeem-code-required"), true);
      return;
    }

    if (!authManager.isLoggedIn()) {
      const success = await showAuthDialog("login");
      if (!success) return;
      updateUserDisplay(doc, authManager);
    }

    (redeemBtn as HTMLButtonElement).disabled = true;
    try {
      const result = await authManager.redeemCode(code);
      if (result.success) {
        showMessage(doc, result.message, false);
        redeemInput.value = "";
        updateUserDisplay(doc, authManager);
      } else {
        showMessage(doc, result.message, true);
      }
    } finally {
      (redeemBtn as HTMLButtonElement).disabled = false;
    }
  });

  // Get redemption code button - show QR code dialog
  const getRedeemCodeBtn = doc.getElementById("pref-get-redeem-code-btn");
  getRedeemCodeBtn?.addEventListener("click", () => {
    showRedeemCodeDialog();
  });

  // Official website link
  const websiteLink = doc.getElementById("pref-paperchat-website");
  websiteLink?.addEventListener("click", (e: Event) => {
    e.preventDefault();
    // Open the console page
    Zotero.launchURL(`${BUILTIN_PROVIDERS.paperchat.website}`);
  });

  // Auth callbacks - refresh provider list on login status change
  const removeAuthListener = authManager.addListener({
    onBalanceUpdate: () => updateUserDisplay(doc, authManager),
    onLoginStatusChange: () => {
      updateUserDisplay(doc, authManager);
      // Refresh provider list to update green dot status
      onProviderListRefresh();
    },
  });

  return () => {
    removeAuthListener();
  };
}

// Singleton: track current redeem code dialog
let redeemDialogWindow: Window | null = null;

/**
 * Show dialog with QR code for getting redemption code
 */
function showRedeemCodeDialog(): void {
  // If dialog already open, focus it
  if (redeemDialogWindow && !redeemDialogWindow.closed) {
    redeemDialogWindow.focus();
    return;
  }

  const purchaseUrl = "https://item.taobao.com/item.htm?id=1008529360525";
  const qrCodeUrl = `chrome://${config.addonRef}/content/icons/tb_qrcode.png`;

  const dialogHelper = new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      styles: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "20px",
        gap: "16px",
        minWidth: "280px",
      },
      children: [
        // QR Code image
        {
          tag: "img",
          attributes: {
            src: qrCodeUrl,
          },
          styles: {
            width: "200px",
            height: "200px",
            borderRadius: "8px",
          },
        },
        // Scan instruction text
        {
          tag: "div",
          properties: {
            textContent: getString("pref-get-redeem-code-scan"),
          },
          styles: {
            fontSize: "14px",
            color: "#666",
            textAlign: "center",
          },
        },
        // Purchase link
        {
          tag: "div",
          styles: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
          },
          children: [
            {
              tag: "span",
              properties: {
                textContent: `${getString("pref-get-redeem-code-link")}: `,
              },
              styles: {
                fontSize: "13px",
              },
            },
            {
              tag: "a",
              id: "redeem-purchase-link",
              properties: {
                textContent: purchaseUrl,
              },
              styles: {
                color: "#0078d4",
                cursor: "pointer",
                fontSize: "13px",
                textDecoration: "underline",
              },
            },
          ],
        },
      ],
    })
    .addButton(getString("pref-copy-btn"), "copy")
    .addButton(getString("auth-cancel"), "cancel");

  dialogHelper.open(getString("pref-get-redeem-code-title"), {
    resizable: false,
    centerscreen: true,
    fitContent: true,
  });

  // Bind events after dialog opens
  setTimeout(() => {
    const dialogWin = dialogHelper.window;
    if (!dialogWin) {
      redeemDialogWindow = null;
      return;
    }

    // Save window reference
    redeemDialogWindow = dialogWin;

    // Clear reference when dialog closes
    dialogWin.addEventListener("unload", () => {
      redeemDialogWindow = null;
    });

    const doc = dialogWin.document;

    // Click on link opens URL
    const linkEl = doc.getElementById("redeem-purchase-link");
    linkEl?.addEventListener("click", (e: Event) => {
      e.preventDefault();
      Zotero.launchURL(purchaseUrl);
    });

    // Copy button copies URL
    const buttons = doc.querySelectorAll("button");
    buttons.forEach((btn) => {
      if (btn.textContent === getString("pref-copy-btn")) {
        btn.addEventListener("click", (e: Event) => {
          e.preventDefault();
          new ztoolkit.Clipboard().addText(purchaseUrl, "text/plain").copy();
          dialogWin.close();
        });
      }
    });
  }, 100);
}
