/**
 * AuthDialog - 登录/注册对话框
 *
 * 提供用户登录和注册界面
 */

import { getString } from "../../utils/locale";
import { authColors, colors } from "../../utils/colors";
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

  currentDialogPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(success);
    };

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
          // 标签切换
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
      dialogHelper.open(getString("auth-dialog-title"), {
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

          // 监听窗口关闭事件，清理单例引用
          dialogWinRef.addEventListener("unload", () => {
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
          function updateUI() {
            const isRegister = currentMode === "register";

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
            usernameField.style.display = "flex";
            passwordField.style.display = "flex";
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
            forgotPasswordField.style.display = isRegister ? "none" : "flex";
            emailField.style.display = isRegister ? "flex" : "none";
            verificationField.style.display = isRegister ? "flex" : "none";
            confirmPasswordField.style.display = isRegister ? "flex" : "none";

            // 调整窗口高度
            setTimeout(() => {
              if (!dialogWinRef.closed) {
                try {
                  const loginHeight = 360;
                  const registerHeight = 570;
                  const targetHeight = isRegister
                    ? registerHeight
                    : loginHeight;
                  dialogWinRef.resizeTo(dialogWinRef.outerWidth, targetHeight);
                } catch (error) {
                  ztoolkit.log(
                    "[AuthDialog] Failed to resize auth dialog:",
                    error,
                  );
                }
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
          }

          // 隐藏消息
          function hideMessage() {
            messageDiv.style.display = "none";
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

          // 忘记密码
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

            // 禁用提交按钮
            const buttons = doc.querySelectorAll("button");
            buttons.forEach((btn: HTMLButtonElement) => (btn.disabled = true));

            try {
              const authManager = getAuthManager();
              let result;

              if (currentMode === "login") {
                result = await authManager.login(username, password);
              } else {
                // 注册模式：使用用户名和邮箱
                result = await authManager.register(
                  username,
                  password,
                  email,
                  verificationCode,
                );
              }

              if (result.success) {
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
            }
          };

          // 绑定提交按钮
          submitBtn?.addEventListener("click", handleSubmit);

          // 绑定取消按钮
          cancelBtn?.addEventListener("click", () => {
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
          ].forEach((input) => {
            input?.addEventListener("keypress", (e: KeyboardEvent) => {
              if (e.key === "Enter") {
                handleSubmit();
              }
            });
          });

          // 初始化UI
          updateUI();
          trackAuthPageViewed(currentMode);
        } catch (error) {
          ztoolkit.log("[AuthDialog] Failed to initialize auth dialog:", error);
          clearCurrentDialog();
          finish(false);
          closeDialogWindow(dialogWinRef);
        }
      });
    });
  });

  return currentDialogPromise;
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
