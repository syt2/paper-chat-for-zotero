/**
 * UserAuthUI - User authentication status display and events
 */

import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { prefColors } from "../../utils/colors";
import { getAuthManager } from "../auth";
import { BUILTIN_PROVIDERS } from "../providers";
import { showAuthDialog } from "../ui/AuthDialog";
import { showMessage } from "./utils";

type AuthManagerType = ReturnType<typeof getAuthManager>;

/**
 * Update user status display in preferences
 */
export function updateUserDisplay(doc: Document, authManager: AuthManagerType): void {
  const userStatusEl = doc.getElementById("pref-user-status") as HTMLElement | null;
  const userBalanceEl = doc.getElementById("pref-user-balance") as HTMLElement | null;
  const userUsedEl = doc.getElementById("pref-user-used") as HTMLElement | null;
  const loginBtn = doc.getElementById("pref-login-btn") as HTMLElement | null;
  const affCodeBar = doc.getElementById("pref-aff-code-bar") as HTMLElement | null;
  const affCodeEl = doc.getElementById("pref-aff-code") as HTMLElement | null;
  const getRedeemCodeBtn = doc.getElementById("pref-get-redeem-code-btn") as HTMLElement | null;

  if (authManager.isLoggedIn()) {
    const user = authManager.getUser();
    if (userStatusEl) {
      userStatusEl.setAttribute("value", `${getString("user-panel-logged-in", { args: { username: user?.username || "" } })}`);
      userStatusEl.style.color = prefColors.userLoggedIn;
    }
    if (userBalanceEl) {
      userBalanceEl.setAttribute("value", `${getString("user-panel-balance")}: ${authManager.formatBalance()}`);
    }
    if (userUsedEl) {
      userUsedEl.setAttribute("value", `${getString("user-panel-used")}: ${authManager.formatUsedQuota()}`);
    }
    if (loginBtn) {
      loginBtn.setAttribute("label", getString("user-panel-logout-btn"));
    }
    // Show invitation code
    if (affCodeBar && affCodeEl && user?.aff_code) {
      affCodeBar.style.display = "flex";
      affCodeEl.setAttribute("value", user.aff_code);
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
    // Hide invitation code
    if (affCodeBar) {
      affCodeBar.style.display = "none";
    }
    // Hide get redeem code button
    if (getRedeemCodeBtn) {
      getRedeemCodeBtn.style.display = "none";
    }
  }
}

/**
 * Bind user authentication events
 */
export function bindUserAuthEvents(
  doc: Document,
  authManager: AuthManagerType,
  onProviderListRefresh: () => void,
): void {
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
  const redeemInput = doc.getElementById("pref-redeem-code") as HTMLInputElement;

  redeemBtn?.addEventListener("click", async () => {
    const code = redeemInput?.value?.trim();
    if (!code) {
      showMessage(doc, getString("auth-error-code-required"), true);
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

  // Copy invitation code button
  const copyAffCodeBtn = doc.getElementById("pref-copy-aff-code");
  const affCodeEl = doc.getElementById("pref-aff-code") as HTMLElement;
  copyAffCodeBtn?.addEventListener("click", () => {
    const affCode = affCodeEl?.getAttribute("value");
    if (affCode) {
      // Copy to clipboard using Zotero's copyTextToClipboard
      new ztoolkit.Clipboard().addText(affCode, "text/plain").copy();
      // Show feedback
      showMessage(doc, getString("pref-copied"), false);
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
  authManager.addListener({
    onBalanceUpdate: () => updateUserDisplay(doc, authManager),
    onLoginStatusChange: () => {
      updateUserDisplay(doc, authManager);
      // Refresh provider list to update green dot status
      onProviderListRefresh();
    },
  });
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

  const purchaseUrl = "https://m.tb.cn/h.75M7wID";
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
