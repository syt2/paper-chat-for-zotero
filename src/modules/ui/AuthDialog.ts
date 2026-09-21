/**
 * AuthDialog - 登录/注册对话框
 *
 * 提供用户登录和注册界面
 */

import { openZToolkitDialog } from "../../utils/dialog";
import { getString } from "../../utils/locale";
import { authColors } from "../../utils/colors";
import { getAuthManager } from "../auth";
import { ANALYTICS_EVENTS, getAnalyticsService } from "../analytics";
import { buildErrorProps } from "../analytics/errorProps";
import {
  extractStatusCode,
  isNetworkErrorMessage,
} from "../analytics/errorClassify";

type DialogMode = "login" | "register";

function createRandomUsername(length = 10): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let username = "";
  for (let i = 0; i < length; i++) {
    username += alphabet[Math.floor(Math.random() * alphabet.length)] ?? "0";
  }
  return username;
}

function mapAuthCompletedReason(mode: DialogMode, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  const status = extractStatusCode(message);

  if (status !== null && status >= 500) {
    return "server_error";
  }
  if (isNetworkErrorMessage(message) && status === null) {
    return "network_error";
  }
  if (
    normalized.includes("用户名或密码错误") ||
    normalized.includes("wrong credentials") ||
    normalized.includes("wrong password") ||
    normalized.includes("invalid password") ||
    normalized.includes("password error")
  ) {
    return "wrong_credentials";
  }
  if (
    normalized.includes("账号不存在") ||
    normalized.includes("账户不存在") ||
    normalized.includes("用户不存在") ||
    normalized.includes("account not found") ||
    normalized.includes("user not found")
  ) {
    return "account_not_found";
  }
  if (
    mode === "register" &&
    (normalized.includes("邮箱已") ||
      normalized.includes("email already") ||
      normalized.includes("email has already") ||
      normalized.includes("email taken"))
  ) {
    return "email_taken";
  }
  if (
    (normalized.includes("验证码") &&
      (normalized.includes("错误") ||
        normalized.includes("无效") ||
        normalized.includes("过期"))) ||
    normalized.includes("invalid verification code") ||
    normalized.includes("verification code invalid") ||
    normalized.includes("verification code expired")
  ) {
    return "invalid_verification_code";
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("too many") ||
    normalized.includes("429") ||
    normalized.includes("频繁") ||
    normalized.includes("稍后再试")
  ) {
    return "rate_limited";
  }

  return "unknown";
}

function mapVerificationReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  const status = extractStatusCode(message);

  if (status !== null && status >= 500) {
    return "server_error";
  }
  if (isNetworkErrorMessage(message) && status === null) {
    return "network_error";
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("too many") ||
    normalized.includes("429") ||
    normalized.includes("频繁") ||
    normalized.includes("稍后再试")
  ) {
    return "rate_limited";
  }
  if (
    normalized.includes("invalid email") ||
    normalized.includes("邮箱格式") ||
    normalized.includes("邮箱无效") ||
    normalized.includes("email format")
  ) {
    return "invalid_email";
  }
  if (
    normalized.includes("quota exceeded") ||
    normalized.includes("额度") ||
    normalized.includes("配额") ||
    normalized.includes("次数已用完")
  ) {
    return "quota_exceeded";
  }

  return "unknown";
}

function trackAuthCompleted(
  mode: DialogMode,
  success: boolean,
  error?: unknown,
): void {
  if (success) {
    getAnalyticsService().track(ANALYTICS_EVENTS.authCompleted, {
      mode,
      success: true,
    });
    return;
  }

  getAnalyticsService().track(ANALYTICS_EVENTS.authCompleted, {
    mode,
    success: false,
    ...buildErrorProps(mapAuthCompletedReason(mode, error), error),
  });
}

function trackVerificationCodeSent(
  scene: "register" | "login" | "reset_password",
  success: boolean,
  error?: unknown,
): void {
  if (success) {
    getAnalyticsService().track(ANALYTICS_EVENTS.authVerificationCodeSent, {
      scene,
      success: true,
    });
    return;
  }

  getAnalyticsService().track(ANALYTICS_EVENTS.authVerificationCodeSent, {
    scene,
    success: false,
    ...buildErrorProps(mapVerificationReason(error), error),
  });
}

// 单例：跟踪当前打开的对话框
let currentDialogWindow: Window | null = null;
let currentDialogPromise: Promise<boolean> | null = null;
const AUTH_DIALOG_WINDOW_WAIT_TIMEOUT_MS = 5000;
const AUTH_DIALOG_WINDOW_POLL_MS = 50;
const AUTH_DIALOG_CONTENT_WAIT_TIMEOUT_MS = 5000;
const AUTH_DIALOG_CONTENT_POLL_MS = 50;

function clearCurrentDialog(): void {
  currentDialogWindow = null;
  currentDialogPromise = null;
}

function waitForDialogWindow(
  dialogHelper: { window?: Window | null },
  callback: (dialogWin: Window | null) => void,
  elapsedMs: number = 0,
): void {
  const dialogWin = dialogHelper.window;
  if (dialogWin && !dialogWin.closed) {
    callback(dialogWin);
    return;
  }

  if (elapsedMs >= AUTH_DIALOG_WINDOW_WAIT_TIMEOUT_MS) {
    callback(null);
    return;
  }

  setTimeout(() => {
    waitForDialogWindow(
      dialogHelper,
      callback,
      elapsedMs + AUTH_DIALOG_WINDOW_POLL_MS,
    );
  }, AUTH_DIALOG_WINDOW_POLL_MS);
}

function waitForDialogContent(
  dialogWin: Window,
  callback: (ready: boolean) => void,
  elapsedMs: number = 0,
): void {
  if (dialogWin.closed) {
    callback(false);
    return;
  }

  const doc = dialogWin.document;
  if (
    doc.getElementById("tab-login") &&
    doc.getElementById("tab-register") &&
    doc.getElementById("auth-submit-btn")
  ) {
    callback(true);
    return;
  }

  if (elapsedMs >= AUTH_DIALOG_CONTENT_WAIT_TIMEOUT_MS) {
    callback(false);
    return;
  }

  setTimeout(() => {
    waitForDialogContent(
      dialogWin,
      callback,
      elapsedMs + AUTH_DIALOG_CONTENT_POLL_MS,
    );
  }, AUTH_DIALOG_CONTENT_POLL_MS);
}

function requireAuthElement<T extends HTMLElement>(
  doc: Document,
  id: string,
): T {
  const element = doc.getElementById(id);
  if (!element) {
    throw new Error(`Auth dialog element missing: #${id}`);
  }
  return element as T;
}

function closeDialogWindow(dialogWin: Window | null | undefined): void {
  if (!dialogWin || dialogWin.closed) {
    return;
  }

  try {
    dialogWin.close();
  } catch (error) {
    ztoolkit.log("[AuthDialog] Failed to close auth dialog:", error);
  }
}

/**
 * 显示登录/注册对话框（单例模式）
 */
export async function showAuthDialog(
  initialMode: DialogMode = "login",
): Promise<boolean> {
  if (currentDialogWindow?.closed) {
    clearCurrentDialog();
  }

  // 如果已有窗口打开，聚焦到现有窗口并返回现有的 Promise
  if (currentDialogWindow && !currentDialogWindow.closed) {
    currentDialogWindow.focus();
    return currentDialogPromise || Promise.resolve(false);
  }
  if (currentDialogPromise) {
    return currentDialogPromise;
  }

  let resolveDialog!: (success: boolean) => void;
  const dialogPromise = new Promise<boolean>((resolve) => {
    resolveDialog = resolve;
  });
  currentDialogPromise = dialogPromise;

  let settled = false;
  const finish = (success: boolean) => {
    if (settled) {
      return;
    }
    settled = true;
    resolveDialog(success);
  };

  const startDialog = () => {
    const win = Zotero.getMainWindow();
    if (!win) {
      clearCurrentDialog();
      finish(false);
      return;
    }

    const dialogData = {
      mode: initialMode,
      username: "",
      password: "",
      confirmPassword: "",
      email: "",
      verificationCode: "",
      isLoading: false,
      errorMessage: "",
      successMessage: "",
      countDown: 0,
    };

    const dialogHelper = new ztoolkit.Dialog(3, 1)
      .setDialogData(dialogData)
      .addCell(0, 0, {
        tag: "div",
        id: "auth-dialog-content",
        styles: {
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          padding: "16px",
          minWidth: "360px",
        },
        children: [
          {
            tag: "div",
            styles: {
              display: "flex",
              marginBottom: "8px",
            },
            children: [
              {
                tag: "button",
                id: "tab-login",
                properties: {
                  textContent: getString("auth-login-tab"),
                },
                styles: {
                  flex: "1",
                  padding: "8px",
                  cursor: "pointer",
                  border: "none",
                  borderBottom: "2px solid transparent",
                  background: "transparent",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                },
              },
              {
                tag: "button",
                id: "tab-register",
                properties: {
                  textContent: getString("auth-register-tab"),
                },
                styles: {
                  flex: "1",
                  padding: "8px",
                  cursor: "pointer",
                  border: "none",
                  borderBottom: "2px solid transparent",
                  background: "transparent",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                },
              },
            ],
          },
          // 错误/成功消息
          {
            tag: "div",
            id: "auth-message",
            styles: {
              padding: "8px",
              borderRadius: "4px",
              display: "none",
            },
          },
          // 使用 Zotero 登录 / 注册：两种模式共用同一个入口，桥接层会在
          // 账号不存在时直接创建，所以注册标签页也需要它。
          {
            tag: "div",
            id: "zotero-oauth-field",
            // Hidden until isZoteroLoginAvailable() resolves true. The bridge
            // signs in and creates the account with the same call, so this is
            // shown on both tabs.
            styles: {
              display: "none",
              flexDirection: "column",
              gap: "14px",
              marginBottom: "14px",
            },
            children: [
              {
                tag: "button",
                id: "zotero-oauth-btn",
                attributes: { type: "button" },
                styles: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  width: "100%",
                  padding: "10px 16px",
                  cursor: "pointer",
                  borderRadius: "6px",
                  border: `1px solid ${authColors.zoteroButtonBorder}`,
                  background: authColors.zoteroButtonBg,
                  color: authColors.zoteroBrand,
                  fontSize: "13px",
                  fontWeight: "600",
                },
                children: [
                  {
                    tag: "span",
                    id: "zotero-oauth-mark",
                    properties: { textContent: "Z" },
                    styles: {
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "18px",
                      height: "18px",
                      flex: "0 0 auto",
                      borderRadius: "4px",
                      background: authColors.zoteroBrand,
                      color: "#ffffff",
                      fontSize: "12px",
                      fontWeight: "700",
                      lineHeight: "1",
                    },
                  },
                  {
                    tag: "span",
                    id: "zotero-oauth-label",
                    properties: { textContent: getString("auth-zotero-login") },
                  },
                ],
              },
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
                    styles: {
                      flex: "1",
                      height: "1px",
                      background: authColors.inputBorder,
                    },
                  },
                  {
                    tag: "span",
                    properties: { textContent: getString("auth-or") },
                    styles: {
                      color: authColors.zoteroBrandDark,
                      fontSize: "12px",
                      opacity: "0.7",
                    },
                  },
                  {
                    tag: "span",
                    styles: {
                      flex: "1",
                      height: "1px",
                      background: authColors.inputBorder,
                    },
                  },
                ],
              },
            ],
          },
          // 用户名/邮箱 (登录时显示用户名，注册时显示邮箱)
          {
            tag: "div",
            id: "username-field",
            styles: { display: "flex", flexDirection: "column", gap: "4px" },
            children: [
              {
                tag: "label",
                id: "username-label",
                properties: { textContent: getString("auth-username") },
              },
              {
                tag: "input",
                id: "auth-username",
                attributes: {
                  type: "text",
                  "data-bind": "username",
                  placeholder: getString("auth-username-placeholder"),
                },
                styles: {
                  padding: "8px",
                  borderRadius: "4px",
                  border: `1px solid ${authColors.inputBorder}`,
                },
              },
            ],
          },
          // 邮箱 (仅注册，同时作为用户名)
          {
            tag: "div",
            id: "email-field",
            styles: { display: "none", flexDirection: "column", gap: "4px" },
            children: [
              {
                tag: "label",
                properties: { textContent: getString("auth-email") },
              },
              {
                tag: "input",
                id: "auth-email",
                attributes: {
                  type: "email",
                  "data-bind": "email",
                  placeholder: getString("auth-email-placeholder"),
                },
                styles: {
                  padding: "8px",
                  borderRadius: "4px",
                  border: `1px solid ${authColors.inputBorder}`,
                },
              },
            ],
          },
          // 验证码 (仅注册)
          {
            tag: "div",
            id: "verification-field",
            styles: { display: "none", flexDirection: "column", gap: "4px" },
            children: [
              {
                tag: "label",
                properties: {
                  textContent: getString("auth-verification-code"),
                },
              },
              {
                tag: "div",
                styles: { display: "flex", gap: "8px" },
                children: [
                  {
                    tag: "input",
                    id: "auth-verification-code",
                    attributes: {
                      type: "text",
                      "data-bind": "verificationCode",
                      placeholder: getString("auth-verification-placeholder"),
                    },
                    styles: {
                      flex: "1",
                      padding: "8px",
                      borderRadius: "4px",
                      border: `1px solid ${authColors.inputBorder}`,
                    },
                  },
                  {
                    tag: "button",
                    id: "send-code-btn",
                    properties: { textContent: getString("auth-send-code") },
                    styles: {
                      padding: "8px 12px",
                      cursor: "pointer",
                      textAlign: "center",
                      display: "flex",
                      justifyContent: "center",
                      alignItems: "center",
                      minWidth: "80px",
                    },
                  },
                ],
              },
            ],
          },
          // 密码
          {
            tag: "div",
            styles: { display: "flex", flexDirection: "column", gap: "4px" },
            children: [
              {
                tag: "label",
                properties: { textContent: getString("auth-password") },
              },
              {
                tag: "input",
                id: "auth-password",
                attributes: {
                  type: "password",
                  name: "password",
                  autocomplete: "current-password",
                  "data-bind": "password",
                  placeholder: getString("auth-password-placeholder"),
                },
                styles: {
                  padding: "8px",
                  borderRadius: "4px",
                  border: `1px solid ${authColors.inputBorder}`,
                },
              },
            ],
          },
          {
            tag: "div",
            id: "two-factor-field",
            styles: { display: "none", flexDirection: "column", gap: "8px" },
            children: [
              {
                tag: "label",
                attributes: { for: "auth-two-factor-code" },
                properties: { textContent: getString("auth-two-factor-code") },
              },
              {
                tag: "div",
                properties: {
                  textContent: getString("auth-two-factor-description"),
                },
                styles: { fontSize: "13px", lineHeight: "1.5" },
              },
              {
                tag: "input",
                id: "auth-two-factor-code",
                attributes: {
                  type: "text",
                  name: "one-time-code",
                  autocomplete: "one-time-code",
                  maxlength: "128",
                  spellcheck: "false",
                  placeholder: getString("auth-two-factor-code"),
                },
                styles: {
                  padding: "8px",
                  borderRadius: "4px",
                  border: `1px solid ${authColors.inputBorder}`,
                },
              },
              {
                tag: "button",
                id: "auth-two-factor-back",
                properties: { textContent: getString("auth-two-factor-back") },
                styles: {
                  alignSelf: "flex-start",
                  padding: "4px 0",
                  border: "none",
                  background: "transparent",
                  color: authColors.link,
                  cursor: "pointer",
                },
              },
            ],
          },
          // 忘记密码链接 (仅登录)
          {
            tag: "div",
            id: "forgot-password-field",
            styles: { display: "flex", justifyContent: "flex-end" },
            children: [
              {
                tag: "a",
                id: "forgot-password-link",
                properties: { textContent: getString("auth-forgot-password") },
                styles: {
                  color: authColors.link,
                  cursor: "pointer",
                  fontSize: "13px",
                  textDecoration: "none",
                },
              },
            ],
          },
          // 确认密码 (仅注册)
          {
            tag: "div",
            id: "confirm-password-field",
            styles: { display: "none", flexDirection: "column", gap: "4px" },
            children: [
              {
                tag: "label",
                properties: { textContent: getString("auth-confirm-password") },
              },
              {
                tag: "input",
                id: "auth-confirm-password",
                attributes: {
                  type: "password",
                  autocomplete: "new-password",
                  "data-bind": "confirmPassword",
                  placeholder: getString("auth-confirm-password-placeholder"),
                },
                styles: {
                  padding: "8px",
                  borderRadius: "4px",
                  border: `1px solid ${authColors.inputBorder}`,
                },
              },
            ],
          },
          // 按钮区域 (不使用addButton，避免自动关闭)
          {
            tag: "div",
            styles: {
              display: "flex",
              justifyContent: "flex-end",
              gap: "8px",
              marginTop: "16px",
            },
            children: [
              {
                tag: "button",
                id: "auth-cancel-btn",
                properties: { textContent: getString("auth-cancel") },
                styles: {
                  padding: "8px 16px",
                  cursor: "pointer",
                  borderRadius: "4px",
                  border: `1px solid ${authColors.buttonSecondaryBorder}`,
                  background: authColors.buttonSecondary,
                  color: authColors.buttonSecondaryText,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                },
              },
              {
                tag: "button",
                id: "auth-submit-btn",
                properties: { textContent: getString("auth-submit") },
                styles: {
                  padding: "8px 16px",
                  cursor: "pointer",
                  borderRadius: "4px",
                  border: "none",
                  background: authColors.buttonPrimary,
                  color: authColors.buttonPrimaryText,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                },
              },
            ],
          },
        ],
      });

    try {
      openZToolkitDialog(dialogHelper, win, getString("auth-dialog-title"), {
        resizable: true,
        centerscreen: true,
        fitContent: true,
      });
    } catch (error) {
      ztoolkit.log("[AuthDialog] Failed to open auth dialog:", error);
      clearCurrentDialog();
      finish(false);
      return;
    }

    // 等待对话框打开后绑定事件
    waitForDialogWindow(dialogHelper, (dialogWin) => {
      if (!dialogWin) {
        ztoolkit.log("[AuthDialog] Dialog window was not ready after waiting");
        clearCurrentDialog();
        finish(false);
        return;
      }

      waitForDialogContent(dialogWin, (contentReady) => {
        if (!contentReady) {
          ztoolkit.log(
            "[AuthDialog] Dialog content was not ready after waiting",
          );
          clearCurrentDialog();
          finish(false);
          closeDialogWindow(dialogWin);
          return;
        }

        const dialogWinRef = dialogWin;
        try {
          // 保存窗口引用
          currentDialogWindow = dialogWinRef;
          let countdownTimer: ReturnType<typeof setInterval> | null = null;
          let submitController: AbortController | null = null;
          let resolveTwoFactorCode: ((code: string | null) => void) | null =
            null;
          let submitting = false;
          let twoFactorActive = false;
          let zoteroPending = false;
          let zoteroAuthorizationURL: string | null = null;
          let zoteroLoginController: AbortController | null = null;

          const cancelLogin = () => {
            submitController?.abort();
            resolveTwoFactorCode?.(null);
            resolveTwoFactorCode = null;
          };

          // A device login keeps polling the bridge until it completes, times
          // out, or is cancelled. Closing the dialog must stop it too, or the
          // next attempt would report "login cancelled" while the stale poll
          // is still holding the interactive slot. The abort is enough: the
          // click handler's `finally` clears the pending state, so a password
          // login that supersedes the device flow cannot be overwritten later.
          const cancelZoteroLogin = () => {
            zoteroLoginController?.abort();
          };

          // 监听窗口关闭事件，清理单例引用
          dialogWinRef.addEventListener("unload", () => {
            if (!settled) cancelLogin();
            cancelZoteroLogin();
            if (countdownTimer) clearInterval(countdownTimer);
            clearCurrentDialog();
            finish(false);
          });

          const doc = dialogWinRef.document;

          // 获取元素
          const tabLogin = requireAuthElement<HTMLButtonElement>(
            doc,
            "tab-login",
          );
          const tabRegister = requireAuthElement<HTMLButtonElement>(
            doc,
            "tab-register",
          );
          const usernameField = requireAuthElement<HTMLElement>(
            doc,
            "username-field",
          );
          const usernameLabel = requireAuthElement<HTMLLabelElement>(
            doc,
            "username-label",
          );
          const emailField = requireAuthElement<HTMLElement>(
            doc,
            "email-field",
          );
          const verificationField = requireAuthElement<HTMLElement>(
            doc,
            "verification-field",
          );
          const confirmPasswordField = requireAuthElement<HTMLElement>(
            doc,
            "confirm-password-field",
          );
          const forgotPasswordField = requireAuthElement<HTMLElement>(
            doc,
            "forgot-password-field",
          );
          const forgotPasswordLink = requireAuthElement<HTMLElement>(
            doc,
            "forgot-password-link",
          );
          const sendCodeBtn = requireAuthElement<HTMLButtonElement>(
            doc,
            "send-code-btn",
          );
          const submitBtn = requireAuthElement<HTMLButtonElement>(
            doc,
            "auth-submit-btn",
          );
          const cancelBtn = requireAuthElement<HTMLButtonElement>(
            doc,
            "auth-cancel-btn",
          );
          const zoteroOAuthField = requireAuthElement<HTMLElement>(
            doc,
            "zotero-oauth-field",
          );
          const zoteroOAuthBtn = requireAuthElement<HTMLButtonElement>(
            doc,
            "zotero-oauth-btn",
          );
          const zoteroOAuthLabel = requireAuthElement<HTMLElement>(
            doc,
            "zotero-oauth-label",
          );
          // Start hidden: the entry point is revealed only once the API confirms
          // the bridge is configured, so an unconfigured or slow deployment never
          // shows a button that cannot work.
          let zoteroLoginAvailable = false;
          const messageDiv = requireAuthElement<HTMLElement>(
            doc,
            "auth-message",
          );
          const passwordField = doc.querySelector("#auth-password")
            ?.parentElement as HTMLElement;

          const usernameInput = requireAuthElement<HTMLInputElement>(
            doc,
            "auth-username",
          );
          const emailInput = requireAuthElement<HTMLInputElement>(
            doc,
            "auth-email",
          );
          const verificationInput = requireAuthElement<HTMLInputElement>(
            doc,
            "auth-verification-code",
          );
          const passwordInput = requireAuthElement<HTMLInputElement>(
            doc,
            "auth-password",
          );
          const confirmPasswordInput = requireAuthElement<HTMLInputElement>(
            doc,
            "auth-confirm-password",
          );
          const twoFactorField = requireAuthElement<HTMLElement>(
            doc,
            "two-factor-field",
          );
          const twoFactorInput = requireAuthElement<HTMLInputElement>(
            doc,
            "auth-two-factor-code",
          );
          const twoFactorBack = requireAuthElement<HTMLButtonElement>(
            doc,
            "auth-two-factor-back",
          );
          usernameInput.setAttribute("name", "username");
          usernameInput.setAttribute("autocomplete", "username");
          twoFactorBack.addEventListener("click", cancelLogin);
          if (!passwordField) {
            throw new Error(
              "Auth dialog element missing: #auth-password parent",
            );
          }

          let currentMode: DialogMode = initialMode;
          let generatedRegisterUsername = "";
          const trackAuthPageViewed = (mode: DialogMode) => {
            getAnalyticsService().track(ANALYTICS_EVENTS.authPageViewed, {
              mode,
            });
          };

          function fillRandomRegisterUsername(force = false) {
            if (
              !force &&
              usernameInput.value.trim() &&
              usernameInput.value !== generatedRegisterUsername
            ) {
              return;
            }

            generatedRegisterUsername = createRandomUsername();
            usernameInput.value = generatedRegisterUsername;
          }

          // 更新UI状态
          function applyZoteroButtonState() {
            // While the consent page waits for the user the only useful action
            // is re-opening it; starting a second device flow would orphan the
            // poll that is already running.
            zoteroOAuthLabel.textContent = getString(
              zoteroPending ? "auth-zotero-reopen" : "auth-zotero-login",
            );
            zoteroOAuthBtn.style.background = authColors.zoteroButtonBg;
            zoteroOAuthBtn.style.borderColor = authColors.zoteroButtonBorder;
          }

          function updateUI() {
            const isRegister = currentMode === "register";
            // The button only makes sense while the API reports the bridge as
            // configured; it is hidden rather than failing on click. Zotero
            // creates the account when it does not exist yet, so both tabs get
            // the same entry point.
            zoteroOAuthField.style.display = zoteroLoginAvailable
              ? "flex"
              : "none";
            applyZoteroButtonState();

            // 标签样式
            tabLogin.style.fontWeight = isRegister ? "normal" : "bold";
            tabLogin.style.borderBottom = isRegister
              ? "2px solid transparent"
              : `2px solid ${authColors.tabActive}`;
            tabLogin.style.opacity = isRegister ? "0.6" : "1";
            tabRegister.style.fontWeight = isRegister ? "bold" : "normal";
            tabRegister.style.borderBottom = isRegister
              ? `2px solid ${authColors.tabActive}`
              : "2px solid transparent";
            tabRegister.style.opacity = isRegister ? "1" : "0.6";

            // 字段显示
            usernameField.style.display = twoFactorActive ? "none" : "flex";
            passwordField.style.display = twoFactorActive ? "none" : "flex";
            twoFactorField.style.display = twoFactorActive ? "flex" : "none";
            passwordInput.setAttribute(
              "autocomplete",
              isRegister ? "new-password" : "current-password",
            );
            submitBtn.textContent = getString(
              twoFactorActive ? "auth-two-factor-verify" : "auth-submit",
            );
            usernameLabel.textContent = getString(
              isRegister ? "auth-username" : "auth-login-identity",
            );
            usernameInput.placeholder = getString(
              isRegister
                ? "auth-username-placeholder"
                : "auth-login-identity-placeholder",
            );
            if (isRegister) {
              usernameInput.maxLength = 20;
              fillRandomRegisterUsername();
            } else {
              usernameInput.removeAttribute("maxlength");
            }
            forgotPasswordField.style.display =
              isRegister || twoFactorActive ? "none" : "flex";
            emailField.style.display = isRegister ? "flex" : "none";
            verificationField.style.display = isRegister ? "flex" : "none";
            confirmPasswordField.style.display = isRegister ? "flex" : "none";

            resizeToContent();
          }

          let resizeTimer: ReturnType<typeof setTimeout> | undefined;
          function resizeToContent() {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              if (dialogWinRef.closed) return;
              try {
                // Error messages and second-factor instructions can wrap. Let
                // Gecko measure the full form instead of clipping it to a fixed height.
                dialogWinRef.sizeToContent();
              } catch (error) {
                ztoolkit.log(
                  "[AuthDialog] Failed to resize auth dialog:",
                  error,
                );
              }
            }, 50);
          }

          // 显示消息
          function showMessage(message: string, isError: boolean) {
            messageDiv.textContent = message;
            messageDiv.style.display = "block";
            messageDiv.style.backgroundColor = isError
              ? authColors.errorBg
              : authColors.successBg;
            messageDiv.style.color = isError
              ? authColors.errorText
              : authColors.successText;
            messageDiv.style.border = `1px solid ${isError ? authColors.errorBorder : authColors.successBorder}`;
            resizeToContent();
          }

          // 隐藏消息
          function hideMessage() {
            messageDiv.style.display = "none";
            resizeToContent();
          }

          // 切换到登录
          tabLogin?.addEventListener("click", () => {
            if (currentMode === "login") {
              return;
            }
            currentMode = "login";
            if (usernameInput.value === generatedRegisterUsername) {
              usernameInput.value = "";
            }
            updateUI();
            hideMessage();
            trackAuthPageViewed("login");
          });

          // 切换到注册
          tabRegister?.addEventListener("click", () => {
            if (currentMode === "register") {
              return;
            }
            currentMode = "register";
            fillRandomRegisterUsername(true);
            updateUI();
            hideMessage();
            trackAuthPageViewed("register");
          });

          // 使用 Zotero 登录
          zoteroOAuthBtn.addEventListener("mouseenter", () => {
            if (submitting) return;
            zoteroOAuthBtn.style.background = authColors.zoteroButtonHover;
            zoteroOAuthBtn.style.borderColor = authColors.zoteroBrand;
          });
          zoteroOAuthBtn.addEventListener("mouseleave", () => {
            zoteroOAuthBtn.style.background = authColors.zoteroButtonBg;
            zoteroOAuthBtn.style.borderColor = authColors.zoteroButtonBorder;
          });

          zoteroOAuthBtn.addEventListener("click", async () => {
            if (settled) return;
            // A device login is already waiting for the user in the browser.
            // Re-open that consent page instead of starting a second flow.
            // This stays reachable while `submitting`, so the user can recover
            // after closing the browser tab by accident.
            if (zoteroPending) {
              if (!zoteroAuthorizationURL) return;
              try {
                Zotero.launchURL(zoteroAuthorizationURL);
                showMessage(getString("auth-zotero-opening"), false);
              } catch (error) {
                ztoolkit.log(
                  "[AuthDialog] Failed to reopen Zotero authorization page:",
                  error,
                );
                showMessage(getString("auth-zotero-login-failed"), true);
              }
              return;
            }
            if (submitting) return;
            hideMessage();
            // Wait, do not block: the device flow runs next to the password
            // form. Submitting the form cancels it, and Cancel still closes
            // the dialog, so no control is left dead while Zotero waits.
            zoteroPending = true;
            applyZoteroButtonState();
            showMessage(getString("auth-zotero-opening"), false);
            // Zotero's plugin sandbox has no global AbortController.
            const controller = new (
              dialogWinRef as Window & typeof globalThis
            ).AbortController();
            zoteroLoginController = controller;
            const authManager = getAuthManager();
            try {
              const result = await authManager.loginWithZotero({
                signal: controller.signal,
                onAuthorizationURL: (authorizationUrl) => {
                  zoteroAuthorizationURL = authorizationUrl;
                },
              });
              if (controller.signal.aborted || dialogWinRef.closed) return;
              if (result.success) {
                showMessage(getString("auth-success"), false);
                finish(true);
                setTimeout(() => closeDialogWindow(dialogHelper.window), 700);
              } else {
                showMessage(
                  result.message || getString("auth-zotero-login-failed"),
                  true,
                );
              }
            } catch (error) {
              if (controller.signal.aborted || dialogWinRef.closed) return;
              showMessage(
                error instanceof Error
                  ? error.message
                  : getString("auth-zotero-login-failed"),
                true,
              );
            } finally {
              if (zoteroLoginController === controller) {
                zoteroLoginController = null;
              }
              zoteroPending = false;
              // Keep the last consent URL only for a re-open while the device
              // code is alive; a finished flow always starts over.
              zoteroAuthorizationURL = null;
              // Only touch the shared submit state when the device flow still
              // owns it; a password login started meanwhile must not be
              // re-enabled or have its message hidden.
              if (!dialogWinRef.closed && !settled && !submitting) {
                applyZoteroButtonState();
                updateUI();
              }
            }
          });

          forgotPasswordLink?.addEventListener("click", async () => {
            const username = usernameInput?.value?.trim();
            if (!username) {
              showMessage(getString("auth-error-email-required-reset"), true);
              return;
            }

            hideMessage();
            forgotPasswordLink.style.opacity = "0.5";
            forgotPasswordLink.style.pointerEvents = "none";

            try {
              const authManager = getAuthManager();
              const result = await authManager.resetPassword(username);
              trackVerificationCodeSent(
                "reset_password",
                result.success,
                result.message,
              );

              if (result.success) {
                showMessage(getString("auth-reset-email-sent"), false);
              } else {
                showMessage(result.message, true);
              }
            } catch (error) {
              trackVerificationCodeSent("reset_password", false, error);
              showMessage(
                error instanceof Error
                  ? error.message
                  : getString("auth-error-unknown"),
                true,
              );
            } finally {
              forgotPasswordLink.style.opacity = "1";
              forgotPasswordLink.style.pointerEvents = "auto";
            }
          });

          // 发送验证码
          sendCodeBtn?.addEventListener("click", async () => {
            if (submitting || settled) return;
            const email = emailInput?.value?.trim();
            if (!email) {
              showMessage(getString("auth-error-email-required"), true);
              return;
            }

            const scene = currentMode;
            sendCodeBtn.disabled = true;
            sendCodeBtn.textContent = getString("auth-sending");
            let startedCountdown = false;

            try {
              const authManager = getAuthManager();
              const result = await authManager.sendVerificationCode(email);
              trackVerificationCodeSent(scene, result.success, result.message);

              if (result.success) {
                showMessage(getString("auth-code-sent"), false);
                // 开始倒计时
                let countdown = 60;
                sendCodeBtn.textContent = `${countdown}s`;
                countdownTimer = setInterval(() => {
                  countdown--;
                  if (countdown <= 0) {
                    if (countdownTimer) clearInterval(countdownTimer);
                    sendCodeBtn.disabled = false;
                    sendCodeBtn.textContent = getString("auth-send-code");
                  } else {
                    sendCodeBtn.textContent = `${countdown}s`;
                  }
                }, 1000);
                startedCountdown = true;
                return;
              }

              showMessage(result.message, true);
            } catch (error) {
              trackVerificationCodeSent(scene, false, error);
              showMessage(
                error instanceof Error
                  ? error.message
                  : getString("auth-error-unknown"),
                true,
              );
            } finally {
              if (!startedCountdown) {
                sendCodeBtn.disabled = false;
                sendCodeBtn.textContent = getString("auth-send-code");
              }
            }
          });

          // 提交
          const handleSubmit = async () => {
            if (resolveTwoFactorCode) {
              const code = twoFactorInput.value.trim();
              if (!code) {
                showMessage(getString("auth-error-code-required"), true);
                return;
              }
              const resolve = resolveTwoFactorCode;
              resolveTwoFactorCode = null;
              twoFactorInput.value = "";
              twoFactorInput.disabled = true;
              submitBtn.disabled = true;
              hideMessage();
              resolve(code);
              return;
            }
            if (submitting || settled) return;
            hideMessage();

            const username = usernameInput?.value?.trim();
            const password = passwordInput?.value;
            const email = emailInput?.value?.trim();
            const verificationCode = verificationInput?.value?.trim();
            const confirmPassword = confirmPasswordInput?.value;

            // 验证
            if (currentMode === "login") {
              // 登录模式：需要用户名和密码
              if (!username) {
                showMessage(getString("auth-error-username-required"), true);
                return;
              }
              if (!password) {
                showMessage(getString("auth-error-password-required"), true);
                return;
              }
            } else {
              // 注册模式：需要用户名、邮箱、验证码、密码
              if (!username) {
                showMessage(getString("auth-error-username-required"), true);
                return;
              }
              if (!email) {
                showMessage(getString("auth-error-email-required"), true);
                return;
              }
              if (!verificationCode) {
                showMessage(getString("auth-error-code-required"), true);
                return;
              }
              if (!password) {
                showMessage(getString("auth-error-password-required"), true);
                return;
              }
              if (password !== confirmPassword) {
                showMessage(getString("auth-error-password-mismatch"), true);
                return;
              }
              if (password.length < 8) {
                showMessage(getString("auth-error-password-too-short"), true);
                return;
              }
            }

            // The user chose the password form while Zotero waited in the
            // browser, so stop that poll before starting this login. Doing it
            // after validation keeps a rejected form from killing the wait.
            cancelZoteroLogin();

            // 禁用提交按钮
            submitting = true;
            const buttons = doc.querySelectorAll("button");
            buttons.forEach((btn: HTMLButtonElement) => (btn.disabled = true));
            cancelBtn.disabled = currentMode !== "login";
            usernameInput.disabled = true;
            passwordInput.disabled = true;

            try {
              // Zotero's plugin sandbox has no global AbortController.
              const controller = new (
                dialogWinRef as Window & typeof globalThis
              ).AbortController();
              submitController = controller;
              const authManager = getAuthManager();
              let result;

              if (currentMode === "login") {
                result = await authManager.login(username, password, {
                  signal: controller.signal,
                  requestTwoFactorCode: (errorMessage) => {
                    if (dialogWinRef.closed || controller.signal.aborted)
                      return Promise.resolve(null);
                    twoFactorActive = true;
                    updateUI();
                    if (errorMessage) showMessage(errorMessage, true);
                    else hideMessage();
                    twoFactorInput.disabled = false;
                    twoFactorInput.value = "";
                    submitBtn.disabled = false;
                    twoFactorBack.disabled = false;
                    twoFactorInput.focus();
                    return new Promise((resolve) => {
                      resolveTwoFactorCode = resolve;
                    });
                  },
                });
              } else {
                // 注册模式：使用用户名和邮箱
                result = await authManager.register(
                  username,
                  password,
                  email,
                  verificationCode,
                );
              }

              if (controller.signal.aborted || dialogWinRef.closed) return;
              if (result.success) {
                passwordInput.value = "";
                twoFactorInput.value = "";
                trackAuthCompleted(currentMode, true);
                showMessage(getString("auth-success"), false);
                finish(true);
                setTimeout(() => {
                  closeDialogWindow(dialogHelper.window);
                }, 1000);
              } else {
                trackAuthCompleted(currentMode, false, result.message);
                // 显示API返回的错误消息
                const errorMsg =
                  result.message || getString("auth-error-unknown");
                ztoolkit.log("[AuthDialog] Login/Register failed:", errorMsg);
                showMessage(errorMsg, true);
                buttons.forEach(
                  (btn: HTMLButtonElement) => (btn.disabled = false),
                );
              }
            } catch (error) {
              if (submitController?.signal.aborted || dialogWinRef.closed)
                return;
              trackAuthCompleted(currentMode, false, error);
              showMessage(
                error instanceof Error
                  ? error.message
                  : getString("auth-error-unknown"),
                true,
              );
              buttons.forEach(
                (btn: HTMLButtonElement) => (btn.disabled = false),
              );
            } finally {
              const aborted = submitController?.signal.aborted;
              submitting = false;
              submitController = null;
              resolveTwoFactorCode = null;
              twoFactorActive = false;
              twoFactorInput.value = "";
              if (!dialogWinRef.closed && !settled) {
                buttons.forEach(
                  (btn: HTMLButtonElement) => (btn.disabled = false),
                );
                usernameInput.disabled = false;
                passwordInput.disabled = false;
                updateUI();
                if (aborted) hideMessage();
              }
            }
          };

          // 绑定提交按钮
          submitBtn?.addEventListener("click", handleSubmit);

          // 绑定取消按钮
          cancelBtn?.addEventListener("click", () => {
            cancelLogin();
            // Stop a Zotero device login that is still waiting for the user.
            cancelZoteroLogin();
            if (countdownTimer) clearInterval(countdownTimer);
            finish(false);
            closeDialogWindow(dialogHelper.window);
          });

          // 回车提交
          [
            usernameInput,
            passwordInput,
            confirmPasswordInput,
            verificationInput,
            twoFactorInput,
          ].forEach((input) => {
            input?.addEventListener("keypress", (e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              }
            });
          });

          // 初始化UI
          updateUI();
          trackAuthPageViewed(currentMode);

          // Hide the Zotero entry point unless the API reports the OAuth bridge
          // as configured, instead of letting the click fail.
          getAuthManager()
            .isZoteroLoginAvailable()
            .then((available) => {
              if (settled) return;
              zoteroLoginAvailable = available;
              updateUI();
            })
            .catch((error) => {
              ztoolkit.log(
                "[AuthDialog] Zotero availability check failed:",
                error,
              );
              if (settled) return;
              zoteroLoginAvailable = false;
              updateUI();
            });
        } catch (error) {
          ztoolkit.log("[AuthDialog] Failed to initialize auth dialog:", error);
          clearCurrentDialog();
          finish(false);
          closeDialogWindow(dialogWinRef);
        }
      });
    });
  };

  try {
    startDialog();
  } catch (error) {
    ztoolkit.log("[AuthDialog] Failed to set up auth dialog:", error);
    clearCurrentDialog();
    finish(false);
  }

  return dialogPromise;
}

/**
 * 检查登录状态，如未登录则显示登录对话框
 */
export async function ensureLoggedIn(): Promise<boolean> {
  const authManager = getAuthManager();

  if (authManager.isLoggedIn()) {
    return true;
  }

  // 尝试初始化（从保存的session恢复）
  await authManager.initialize();

  if (authManager.isLoggedIn()) {
    return true;
  }

  // 显示登录对话框
  return showAuthDialog("login");
}
