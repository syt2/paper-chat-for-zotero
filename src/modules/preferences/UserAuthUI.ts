/**
 * UserAuthUI - User authentication status display and events
 */

import type { TagElementProps } from "zotero-plugin-toolkit";
import { getString } from "../../utils/locale";
import { prefColors } from "../../utils/colors";
import { getPref } from "../../utils/prefs";
import { getAuthManager } from "../auth";
import type {
  PaperChatProduct,
  PaperChatPurchaseOrder,
} from "../auth/AuthService";
import { BUILTIN_PROVIDERS } from "../providers";
import { showAuthDialog } from "../ui/AuthDialog";
import type { PrefsRefreshOptions } from "./types";
import { showMessage } from "./utils";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../analytics";
import { renderSanitizedHtmlToElement } from "./PaperChatNoticeRenderer";

type AuthManagerType = ReturnType<typeof getAuthManager>;

export const LOW_BALANCE_WARNING_THRESHOLD = 10000;
const PREFS_REFRESH_MAX_ATTEMPTS = 12;
const PREFS_REFRESH_RETRY_DELAY_MS = 120;
const TOPUP_ATTENTION_DURATION_MS = 8000;
const REDEEM_CODE_INFO_PATH = "/ext/paperchat/redeem-code-info";
const PURCHASE_POLL_INTERVAL_MS = 3000;
const PURCHASE_POLL_MAX_ATTEMPTS = 200;
const PURCHASE_POLL_FAILURE_NOTICE_ATTEMPTS = 3;

interface RedeemCodeInfo {
  qrImageUrl: string | null;
  qrDescription: string | null;
  purchaseUrl: string | null;
  html: string | null;
}

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
  const attentionUntil =
    getTopupAttentionAddonData().paperchatTopupAttentionUntil;
  return typeof attentionUntil === "number" && attentionUntil > Date.now();
}

export function isPaperChatLowBalance(authManager: AuthManagerType): boolean {
  return (
    authManager.isLoggedIn() &&
    authManager.getBalance().quota < LOW_BALANCE_WARNING_THRESHOLD
  );
}

function shouldHighlightTopup(authManager: AuthManagerType): {
  highlight: boolean;
  forced: boolean;
  lowBalance: boolean;
} {
  const subscriptionUsage = authManager.getSubscriptionUsageSummary();
  if (
    subscriptionUsage &&
    subscriptionUsage.amountRemaining > LOW_BALANCE_WARNING_THRESHOLD
  ) {
    return {
      highlight: false,
      forced: false,
      lowBalance: false,
    };
  }

  const lowBalance = isPaperChatLowBalance(authManager);
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
    const animation = element.animate?.(keyframes, {
      duration,
      easing: "ease-out",
      iterations: 2,
    });

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
  scheduleWithAvailableTimer(
    () => {
      if (!addon.data.prefs?.window) {
        if (attempt < PREFS_REFRESH_MAX_ATTEMPTS) {
          schedulePrefsRefresh(options, attempt + 1);
        }
        return;
      }

      void import("./index")
        .then((module) => module.refreshPrefsUI(options))
        .catch((error) => {
          ztoolkit.log(
            "[Preferences] Failed to refresh PaperChat prefs UI:",
            error,
          );
        });
    },
    attempt === 0 ? 0 : PREFS_REFRESH_RETRY_DELAY_MS,
  );
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
    trackProviderView: true,
    providerViewSource: "topup_cta",
  });
}

export function openPaperChatPreferences(): void {
  Zotero.Utilities.Internal.openPreferences("paperchat-prefpane");
  schedulePrefsRefresh({
    syncUserInfo: true,
    trackProviderView: true,
    providerViewSource: "preferences_open",
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
  const userSubscriptionEl = doc.getElementById(
    "pref-user-subscription",
  ) as HTMLElement | null;
  const userSubscriptionTotalEl = doc.getElementById(
    "pref-user-subscription-total",
  ) as HTMLElement | null;
  const userSubscriptionProgressFillEl = doc.getElementById(
    "pref-user-subscription-progress-fill",
  ) as HTMLElement | null;
  const loginBtn = doc.getElementById("pref-login-btn") as HTMLElement | null;
  const getRedeemCodeBtn = doc.getElementById(
    "pref-get-redeem-code-btn",
  ) as HTMLElement | null;
  const topupAttention = shouldHighlightTopup(authManager);

  if (authManager.isLoggedIn()) {
    const user = authManager.getUser();
    const subscriptionUsage = authManager.getSubscriptionUsageSummary();
    const shouldHideTokenBalance =
      !!subscriptionUsage &&
      subscriptionUsage.amountRemaining > LOW_BALANCE_WARNING_THRESHOLD;
    if (userStatusEl) {
      userStatusEl.setAttribute(
        "value",
        `${getString("user-panel-logged-in", { args: { username: user?.username || "" } })}`,
      );
      userStatusEl.style.color = prefColors.userLoggedIn;
    }
    if (userBalanceEl) {
      if (shouldHideTokenBalance) {
        userBalanceEl.setAttribute("value", "");
        userBalanceEl.style.display = "none";
      } else {
        userBalanceEl.style.display = "";
        userBalanceEl.setAttribute(
          "value",
          `${getString("user-panel-balance")}: ${authManager.formatBalance()}`,
        );
      }
    }
    if (userUsedEl) {
      if (shouldHideTokenBalance) {
        userUsedEl.setAttribute("value", "");
        userUsedEl.style.display = "none";
      } else {
        userUsedEl.style.display = "";
        userUsedEl.setAttribute(
          "value",
          `${getString("user-panel-used")}: ${authManager.formatUsedQuota()}`,
        );
      }
    }
    if (
      userSubscriptionEl &&
      userSubscriptionTotalEl &&
      userSubscriptionProgressFillEl
    ) {
      if (subscriptionUsage) {
        userSubscriptionTotalEl.textContent = getString(
          "user-panel-subscription",
          {
            args: { total: subscriptionUsage.amountTotalLabel },
          },
        );
        userSubscriptionProgressFillEl.style.width = `${subscriptionUsage.percentUsed}%`;
        userSubscriptionProgressFillEl.style.background =
          subscriptionUsage.percentUsed >= 99
            ? prefColors.testError
            : "#2563eb";
        userSubscriptionEl.title = `${getString("user-panel-used")}: ${subscriptionUsage.amountUsedLabel} / ${subscriptionUsage.amountTotalLabel}`;
        userSubscriptionEl.style.display = "inline-block";
      } else {
        userSubscriptionTotalEl.textContent = "";
        userSubscriptionProgressFillEl.style.width = "0%";
        userSubscriptionEl.removeAttribute("title");
        userSubscriptionEl.style.display = "none";
      }
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
      userBalanceEl.style.display = "";
    }
    if (userUsedEl) {
      userUsedEl.setAttribute("value", "");
      userUsedEl.style.display = "";
    }
    if (
      userSubscriptionEl &&
      userSubscriptionTotalEl &&
      userSubscriptionProgressFillEl
    ) {
      userSubscriptionTotalEl.textContent = "";
      userSubscriptionProgressFillEl.style.width = "0%";
      userSubscriptionEl.removeAttribute("title");
      userSubscriptionEl.style.display = "none";
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
  getRedeemCodeBtn?.addEventListener("click", async () => {
    getAnalyticsService().track(ANALYTICS_EVENTS.paperChatRedeemCodeClicked, {
      low_balance: isPaperChatLowBalance(authManager),
    });
    await showRedeemCodeDialog(doc, authManager);
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
async function showRedeemCodeDialog(
  prefsDoc: Document,
  authManager: AuthManagerType,
): Promise<void> {
  // If dialog already open, focus it
  if (redeemDialogWindow && !redeemDialogWindow.closed) {
    redeemDialogWindow.focus();
    return;
  }

  const productsResult = await authManager.listPaperChatProducts();
  const products = productsResult.success ? productsResult.products : [];
  const showProducts = products.length > 0;
  const redeemInfo = showProducts
    ? createEmptyRedeemCodeInfo()
    : await fetchRedeemCodeInfo();
  const showHtml = !!redeemInfo.html;
  const showUnavailable =
    !showProducts &&
    !showHtml &&
    !redeemInfo.qrImageUrl &&
    !redeemInfo.purchaseUrl;
  const canCopyPurchaseUrl =
    !showProducts && !showHtml && !!redeemInfo.purchaseUrl;

  const dialogHelper = new ztoolkit.Dialog(1, 1).addCell(0, 0, {
    tag: "div",
    id: "redeem-code-info-body",
    styles: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      padding: "20px",
      gap: "16px",
      minWidth: "280px",
    },
    children: showProducts
      ? buildProductPurchaseChildren(products)
      : showHtml
        ? []
        : buildRedeemCodeInfoChildren(redeemInfo, showUnavailable),
  });

  if (canCopyPurchaseUrl) {
    dialogHelper.addButton(getString("pref-copy-btn"), "copy");
  }
  dialogHelper.addButton(getString("auth-cancel"), "cancel");

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
    if (showHtml && redeemInfo.html) {
      const bodyEl = doc.getElementById(
        "redeem-code-info-body",
      ) as HTMLElement | null;
      if (bodyEl) {
        bodyEl.style.alignItems = "stretch";
        renderSanitizedHtmlToElement(bodyEl, redeemInfo.html);
      }
    }

    if (showProducts) {
      bindProductPurchaseEvents(
        doc,
        dialogWin,
        prefsDoc,
        authManager,
        products,
      );
      return;
    }

    // Click on link opens URL
    const linkEl = doc.getElementById("redeem-purchase-link");
    linkEl?.addEventListener("click", (e: Event) => {
      e.preventDefault();
      if (redeemInfo.purchaseUrl) {
        Zotero.launchURL(redeemInfo.purchaseUrl);
      }
    });

    // Copy button copies URL
    const buttons = doc.querySelectorAll("button");
    buttons.forEach((btn) => {
      if (btn.textContent === getString("pref-copy-btn")) {
        btn.addEventListener("click", (e: Event) => {
          e.preventDefault();
          if (redeemInfo.purchaseUrl) {
            new ztoolkit.Clipboard()
              .addText(redeemInfo.purchaseUrl, "text/plain")
              .copy();
          }
          dialogWin.close();
        });
      }
    });
  }, 100);
}

function buildProductPurchaseChildren(
  products: PaperChatProduct[],
): TagElementProps[] {
  const selectedProduct = products[0];
  const children: TagElementProps[] = [
    {
      tag: "div",
      id: "paperchat-purchase-status",
      properties: {
        textContent: "",
      },
      styles: {
        minHeight: "18px",
        maxWidth: "430px",
        fontSize: "13px",
        color: "#555",
        lineHeight: "1.5",
        textAlign: "center",
      },
    },
    {
      tag: "div",
      id: "paperchat-product-picker",
      styles: {
        width: "100%",
        maxWidth: "430px",
        borderRadius: "8px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      },
      children: [
        {
          tag: "div",
          properties: {
            textContent: getString("pref-paperchat-select-plan"),
          },
          styles: {
            fontSize: "13px",
            fontWeight: "700",
            color: "#555",
          },
        },
        {
          tag: "div",
          styles: {
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "8px",
          },
          children: products.map((product, index) =>
            buildProductOption(product, index === 0),
          ),
        },
        {
          tag: "div",
          id: "paperchat-selected-product-panel",
          styles: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "14px",
            border: "1px solid #dbe3f0",
            borderRadius: "8px",
            padding: "12px",
            background: "#f8fafc",
            boxSizing: "border-box",
          },
          children: [
            {
              tag: "div",
              styles: {
                minWidth: "0",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              },
              children: [
                {
                  tag: "div",
                  id: "paperchat-selected-product-name",
                  properties: {
                    textContent: selectedProduct?.name ?? "",
                  },
                  styles: {
                    minWidth: "0",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "13px",
                    fontWeight: "700",
                    color: "#334155",
                  },
                },
                {
                  tag: "div",
                  id: "paperchat-selected-product-price",
                  properties: {
                    textContent: selectedProduct
                      ? formatProductPrice(selectedProduct)
                      : "",
                  },
                  styles: {
                    fontSize: "20px",
                    fontWeight: "800",
                    color: "#111827",
                    letterSpacing: "0",
                  },
                },
              ],
            },
            {
              tag: "button",
              id: "paperchat-buy-selected",
              properties: {
                textContent: getString("pref-paperchat-buy-btn"),
              },
              styles: {
                flex: "0 0 auto",
                minWidth: "104px",
                minHeight: "38px",
                padding: "8px 16px",
                borderRadius: "7px",
                border: "1px solid #2563eb",
                background: "#2563eb",
                color: "#fff",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: "800",
              },
            },
          ],
        },
      ],
    },
  ];

  return children;
}

function buildProductOption(
  product: PaperChatProduct,
  selected: boolean,
): TagElementProps {
  return {
    tag: "button",
    id: getProductOptionId(product.sku),
    attributes: {
      "aria-pressed": selected ? "true" : "false",
      "data-sku": product.sku,
      type: "button",
    },
    styles: getProductOptionStyles(selected),
    children: [
      {
        tag: "span",
        properties: {
          textContent: product.quotaLabel || product.name,
        },
        styles: {
          minWidth: "0",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: "14px",
          fontWeight: "800",
          color: selected ? "#1d4ed8" : "#111827",
        },
      },
      {
        tag: "span",
        properties: {
          textContent: `¥${product.money}`,
        },
        styles: {
          fontSize: "12px",
          fontWeight: "700",
          color: selected ? "#2563eb" : "#64748b",
        },
      },
    ],
  };
}

function getProductOptionStyles(selected: boolean): Record<string, string> {
  return {
    position: "relative",
    minWidth: "0",
    minHeight: "54px",
    padding: "8px 10px",
    borderRadius: "8px",
    border: selected ? "2px solid #2563eb" : "2px solid #d0d7de",
    background: selected ? "#eff6ff" : "#fff",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    justifyContent: "center",
    gap: "3px",
    cursor: "pointer",
    textAlign: "left",
    outline: "none",
  };
}

function applyProductOptionStyles(
  option: HTMLElement,
  selected: boolean,
): void {
  const styles = getProductOptionStyles(selected);
  for (const [key, value] of Object.entries(styles)) {
    option.style.setProperty(toKebabCase(key), value);
  }
  option.setAttribute("aria-pressed", selected ? "true" : "false");
  const [labelEl, priceEl] = Array.from(option.children) as HTMLElement[];
  if (labelEl) {
    labelEl.style.color = selected ? "#1d4ed8" : "#111827";
  }
  if (priceEl) {
    priceEl.style.color = selected ? "#2563eb" : "#64748b";
  }
}

function formatProductPrice(product: PaperChatProduct): string {
  return product.quotaLabel
    ? `¥${product.money} · ${product.quotaLabel}`
    : `¥${product.money}`;
}

function bindProductPurchaseEvents(
  doc: Document,
  dialogWin: Window,
  prefsDoc: Document,
  authManager: AuthManagerType,
  products: PaperChatProduct[],
): void {
  const statusEl = doc.getElementById(
    "paperchat-purchase-status",
  ) as HTMLElement | null;
  const selectedNameEl = doc.getElementById(
    "paperchat-selected-product-name",
  ) as HTMLElement | null;
  const selectedPriceEl = doc.getElementById(
    "paperchat-selected-product-price",
  ) as HTMLElement | null;
  const buyButton = doc.getElementById(
    "paperchat-buy-selected",
  ) as HTMLButtonElement | null;
  let pollTimer: number | null = null;
  let selectedSku = products[0]?.sku ?? "";

  const setStatus = (message: string, isError = false) => {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.style.color = isError ? prefColors.testError : "#555";
  };

  const stopPolling = () => {
    if (pollTimer !== null) {
      dialogWin.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  dialogWin.addEventListener("unload", stopPolling);

  const setButtonsDisabled = (disabled: boolean) => {
    if (buyButton) {
      buyButton.disabled = disabled;
      buyButton.style.opacity = disabled ? "0.6" : "1";
      buyButton.style.cursor = disabled ? "default" : "pointer";
    }
    for (const product of products) {
      const option = doc.getElementById(
        getProductOptionId(product.sku),
      ) as HTMLButtonElement | null;
      if (option) {
        option.disabled = disabled;
        option.style.cursor = disabled ? "default" : "pointer";
      }
    }
  };

  const selectProduct = (product: PaperChatProduct) => {
    selectedSku = product.sku;
    for (const item of products) {
      const option = doc.getElementById(
        getProductOptionId(item.sku),
      ) as HTMLElement | null;
      if (option) {
        applyProductOptionStyles(option, item.sku === selectedSku);
      }
    }
    if (selectedNameEl) {
      selectedNameEl.textContent = product.name;
    }
    if (selectedPriceEl) {
      selectedPriceEl.textContent = formatProductPrice(product);
    }
    setStatus("");
  };

  const startPolling = (order: PaperChatPurchaseOrder) => {
    let attempts = 0;
    let consecutiveFailures = 0;
    let lastGrantFailed = false;
    stopPolling();
    pollTimer = dialogWin.setInterval(async () => {
      attempts += 1;
      if (attempts > PURCHASE_POLL_MAX_ATTEMPTS) {
        stopPolling();
        setButtonsDisabled(false);
        setStatus(
          lastGrantFailed
            ? getString("pref-paperchat-purchase-grant-failed")
            : getString("pref-paperchat-purchase-timeout"),
          true,
        );
        return;
      }

      const result = await authManager.getPaperChatOrder(order.id);
      if (!result.success || !result.order) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= PURCHASE_POLL_FAILURE_NOTICE_ATTEMPTS) {
          setStatus(getString("pref-paperchat-purchase-check-failed"), true);
        }
        return;
      }
      consecutiveFailures = 0;

      if (result.order.status === "paid") {
        if (result.order.grantStatus === "manual_review") {
          stopPolling();
          setButtonsDisabled(false);
          setStatus(getString("pref-paperchat-purchase-grant-failed"), true);
          return;
        }
        if (result.order.grantStatus === "failed") {
          lastGrantFailed = true;
          setStatus(getString("pref-paperchat-purchase-check-failed"), true);
          return;
        }
        if (result.order.grantStatus !== "granted") {
          setStatus(getString("pref-paperchat-purchase-check-failed"));
          return;
        }

        stopPolling();
        setButtonsDisabled(false);
        setStatus(getString("pref-paperchat-purchase-paid"));
        await authManager.refreshUserInfo().catch((error) => {
          ztoolkit.log(
            "[Preferences] Failed to refresh user after payment:",
            error,
          );
        });
        updateUserDisplay(prefsDoc, authManager);
      }
    }, PURCHASE_POLL_INTERVAL_MS);
  };

  for (const product of products) {
    const option = doc.getElementById(
      getProductOptionId(product.sku),
    ) as HTMLButtonElement | null;
    option?.addEventListener("click", (event: Event) => {
      event.preventDefault();
      if (!option.disabled) {
        selectProduct(product);
      }
    });
  }

  buyButton?.addEventListener("click", async (event: Event) => {
    event.preventDefault();
    const product = products.find((item) => item.sku === selectedSku);
    if (!product) {
      setStatus(getString("pref-paperchat-purchase-failed"), true);
      return;
    }
    setButtonsDisabled(true);
    setStatus(getString("pref-paperchat-purchase-creating"));
    const result = await authManager.createPaperChatOrder(product.sku);
    if (!result.success || !result.order) {
      setButtonsDisabled(false);
      setStatus(
        result.message || getString("pref-paperchat-purchase-failed"),
        true,
      );
      return;
    }

    if (result.order.paymentUrl) {
      Zotero.launchURL(result.order.paymentUrl);
    }
    setStatus(getString("pref-paperchat-purchase-opened"));
    startPolling(result.order);
  });
}

function getProductOptionId(sku: string): string {
  return `paperchat-product-${sku.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

async function fetchRedeemCodeInfo(): Promise<RedeemCodeInfo> {
  const fallback = createEmptyRedeemCodeInfo();
  try {
    const response = await Zotero.HTTP.request("GET", getRedeemCodeInfoUrl(), {
      responseType: "json",
      successCodes: false as const,
    });
    if (response.status >= 400) {
      return fallback;
    }
    return normalizeRedeemCodeInfoResponse(response.response);
  } catch (error) {
    ztoolkit.log("[Preferences] Failed to fetch redeem code info:", error);
    return fallback;
  }
}

function getRedeemCodeInfoUrl(): string {
  const baseUrl =
    (getPref("baseUrl") as string | undefined) ||
    BUILTIN_PROVIDERS.paperchat.defaultBaseUrl;
  try {
    return `${new URL(baseUrl).origin}${REDEEM_CODE_INFO_PATH}`;
  } catch {
    return `${BUILTIN_PROVIDERS.paperchat.website}${REDEEM_CODE_INFO_PATH}`;
  }
}

function normalizeRedeemCodeInfoResponse(response: unknown): RedeemCodeInfo {
  const payload =
    response && typeof response === "object" && "data" in response
      ? (response as { data?: unknown }).data
      : response;
  if (!payload || typeof payload !== "object") {
    return createEmptyRedeemCodeInfo();
  }
  const record = payload as Record<string, unknown>;
  return {
    qrImageUrl: normalizeOptionalString(record.qrImageUrl),
    qrDescription: normalizeOptionalString(record.qrDescription),
    purchaseUrl: normalizeOptionalString(record.purchaseUrl),
    html: normalizeOptionalString(record.html),
  };
}

function createEmptyRedeemCodeInfo(): RedeemCodeInfo {
  return {
    qrImageUrl: null,
    qrDescription: null,
    purchaseUrl: null,
    html: null,
  };
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildRedeemCodeInfoChildren(
  redeemInfo: RedeemCodeInfo,
  showUnavailable: boolean,
): TagElementProps[] {
  if (showUnavailable) {
    return [
      {
        tag: "div",
        styles: {
          maxWidth: "320px",
          fontSize: "14px",
          color: "#666",
          lineHeight: "1.6",
          textAlign: "center",
        },
        children: [
          {
            tag: "span",
            properties: {
              textContent: getString("pref-get-redeem-code-unavailable-prefix"),
            },
          },
          {
            tag: "a",
            properties: {
              textContent: getString("pref-get-redeem-code-unavailable-link"),
            },
            styles: {
              color: "#0078d4",
              cursor: "pointer",
              textDecoration: "underline",
            },
            listeners: [
              {
                type: "click",
                listener: (event: Event) => {
                  event.preventDefault();
                  Zotero.launchURL(BUILTIN_PROVIDERS.paperchat.website!);
                },
              },
            ],
          },
          {
            tag: "span",
            properties: {
              textContent: getString("pref-get-redeem-code-unavailable-suffix"),
            },
          },
        ],
      },
    ];
  }

  const children: TagElementProps[] = [];

  if (redeemInfo.qrImageUrl) {
    children.push({
      tag: "img",
      attributes: {
        src: redeemInfo.qrImageUrl,
      },
      styles: {
        width: "200px",
        height: "200px",
        borderRadius: "8px",
        objectFit: "contain",
      },
    });
  }

  if (redeemInfo.qrDescription) {
    children.push({
      tag: "div",
      properties: {
        textContent: redeemInfo.qrDescription,
      },
      styles: {
        fontSize: "14px",
        color: "#666",
        textAlign: "center",
      },
    });
  }

  if (redeemInfo.purchaseUrl) {
    children.push({
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
            textContent: redeemInfo.purchaseUrl,
          },
          styles: {
            color: "#0078d4",
            cursor: "pointer",
            fontSize: "13px",
            textDecoration: "underline",
          },
        },
      ],
    });
  }

  return children;
}
