/**
 * AuthDialog - 登录/注册对话框
 *
 * 提供用户登录和注册界面
 */

import { getString } from "../../utils/locale";
import { authColors, colors } from "../../utils/colors";
import { getAuthManager } from "../auth";

type DialogMode = "login" | "register";

// 单例：跟踪当前打开的对话框
let currentDialogWindow: Window | null = null;
let currentDialogPromise: Promise<boolean> | null = null;

/**
 * 显示登录/注册对话框（单例模式）
 */
export async function showAuthDialog(initialMode: DialogMode = "login"): Promise<boolean> {
  // 如果已有窗口打开，聚焦到现有窗口并返回现有的 Promise
  if (currentDialogWindow && !currentDialogWindow.closed) {
    currentDialogWindow.focus();
    return currentDialogPromise || Promise.resolve(false);
  }

  currentDialogPromise = new Promise((resolve) => {
    const win = Zotero.getMainWindow();
    if (!win) {
      currentDialogWindow = null;
      currentDialogPromise = null;
      resolve(false);
      return;
    }

    const dialogData = {
      mode: initialMode,
      username: "",
      password: "",
      confirmPassword: "",
      email: "",
      verificationCode: "",
      affCode: "",
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
                styles: { padding: "8px", borderRadius: "4px", border: `1px solid ${authColors.inputBorder}` },
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
                styles: { padding: "8px", borderRadius: "4px", border: `1px solid ${authColors.inputBorder}` },
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
                properties: { textContent: getString("auth-verification-code") },
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
                    styles: { flex: "1", padding: "8px", borderRadius: "4px", border: `1px solid ${authColors.inputBorder}` },
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
                styles: { padding: "8px", borderRadius: "4px", border: `1px solid ${authColors.inputBorder}` },
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
                styles: { padding: "8px", borderRadius: "4px", border: `1px solid ${authColors.inputBorder}` },
              },
            ],
          },
          // 邀请码 (仅注册)
          {
            tag: "div",
            id: "aff-code-field",
            styles: { display: "none", flexDirection: "column", gap: "4px" },
            children: [
              {
                tag: "label",
                properties: { textContent: getString("auth-aff-code") },
              },
              {
                tag: "input",
                id: "auth-aff-code",
                attributes: {
                  type: "text",
                  "data-bind": "affCode",
                  placeholder: getString("auth-aff-code-placeholder"),
                },
                styles: { padding: "8px", borderRadius: "4px", border: `1px solid ${authColors.inputBorder}` },
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
                },
              },
            ],
          },
        ],
      });

    dialogHelper.open(getString("auth-dialog-title"), {
      resizable: true,
      centerscreen: true,
      fitContent: true,
    });

    // 等待对话框打开后绑定事件
    setTimeout(() => {
      const dialogWin = dialogHelper.window;
      if (!dialogWin) {
        currentDialogWindow = null;
        currentDialogPromise = null;
        return;
      }

      // 保存窗口引用
      currentDialogWindow = dialogWin;

      // 监听窗口关闭事件，清理单例引用
      dialogWin.addEventListener("unload", () => {
        currentDialogWindow = null;
        currentDialogPromise = null;
      });

      const doc = dialogWin.document;

      // 获取元素
      const tabLogin = doc.getElementById("tab-login") as HTMLButtonElement;
      const tabRegister = doc.getElementById("tab-register") as HTMLButtonElement;
      const usernameField = doc.getElementById("username-field") as HTMLElement;
      const emailField = doc.getElementById("email-field") as HTMLElement;
      const verificationField = doc.getElementById("verification-field") as HTMLElement;
      const confirmPasswordField = doc.getElementById("confirm-password-field") as HTMLElement;
      const affCodeField = doc.getElementById("aff-code-field") as HTMLElement;
      const forgotPasswordField = doc.getElementById("forgot-password-field") as HTMLElement;
      const forgotPasswordLink = doc.getElementById("forgot-password-link") as HTMLElement;
      const sendCodeBtn = doc.getElementById("send-code-btn") as HTMLButtonElement;
      const submitBtn = doc.getElementById("auth-submit-btn") as HTMLButtonElement;
      const cancelBtn = doc.getElementById("auth-cancel-btn") as HTMLButtonElement;
      const messageDiv = doc.getElementById("auth-message") as HTMLElement;
      const passwordField = doc.querySelector("#auth-password")?.parentElement as HTMLElement;

      const usernameInput = doc.getElementById("auth-username") as HTMLInputElement;
      const emailInput = doc.getElementById("auth-email") as HTMLInputElement;
      const verificationInput = doc.getElementById("auth-verification-code") as HTMLInputElement;
      const passwordInput = doc.getElementById("auth-password") as HTMLInputElement;
      const confirmPasswordInput = doc.getElementById("auth-confirm-password") as HTMLInputElement;
      const affCodeInput = doc.getElementById("auth-aff-code") as HTMLInputElement;

      let currentMode: DialogMode = initialMode;
      let countdownTimer: ReturnType<typeof setInterval> | null = null;

      // 更新UI状态
      function updateUI() {
        const isRegister = currentMode === "register";

        // 标签样式
        tabLogin.style.fontWeight = isRegister ? "normal" : "bold";
        tabLogin.style.borderBottom = isRegister ? "2px solid transparent" : `2px solid ${authColors.tabActive}`;
        tabLogin.style.opacity = isRegister ? "0.6" : "1";
        tabRegister.style.fontWeight = isRegister ? "bold" : "normal";
        tabRegister.style.borderBottom = isRegister ? `2px solid ${authColors.tabActive}` : "2px solid transparent";
        tabRegister.style.opacity = isRegister ? "1" : "0.6";

        // 字段显示
        usernameField.style.display = "flex";
        passwordField.style.display = "flex";
        forgotPasswordField.style.display = isRegister ? "none" : "flex";
        emailField.style.display = isRegister ? "flex" : "none";
        verificationField.style.display = isRegister ? "flex" : "none";
        confirmPasswordField.style.display = isRegister ? "flex" : "none";
        affCodeField.style.display = isRegister ? "flex" : "none";

        // 调整窗口高度
        setTimeout(() => {
          if (dialogWin) {
            const loginHeight = 360;
            const registerHeight = 620;
            const targetHeight = isRegister ? registerHeight : loginHeight;
            dialogWin.resizeTo(dialogWin.outerWidth, targetHeight);
          }
        }, 50);
      }

      // 显示消息
      function showMessage(message: string, isError: boolean) {
        messageDiv.textContent = message;
        messageDiv.style.display = "block";
        messageDiv.style.backgroundColor = isError ? authColors.errorBg : authColors.successBg;
        messageDiv.style.color = isError ? authColors.errorText : authColors.successText;
        messageDiv.style.border = `1px solid ${isError ? authColors.errorBorder : authColors.successBorder}`;
      }

      // 隐藏消息
      function hideMessage() {
        messageDiv.style.display = "none";
      }

      // 切换到登录
      tabLogin?.addEventListener("click", () => {
        currentMode = "login";
        updateUI();
        hideMessage();
      });

      // 切换到注册
      tabRegister?.addEventListener("click", () => {
        currentMode = "register";
        updateUI();
        hideMessage();
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

        const authManager = getAuthManager();
        const result = await authManager.resetPassword(username);

        forgotPasswordLink.style.opacity = "1";
        forgotPasswordLink.style.pointerEvents = "auto";

        if (result.success) {
          showMessage(getString("auth-reset-email-sent"), false);
        } else {
          showMessage(result.message, true);
        }
      });

      // 发送验证码
      sendCodeBtn?.addEventListener("click", async () => {
        const email = emailInput?.value?.trim();
        if (!email) {
          showMessage(getString("auth-error-email-required"), true);
          return;
        }

        sendCodeBtn.disabled = true;
        sendCodeBtn.textContent = getString("auth-sending");

        const authManager = getAuthManager();
        const result = await authManager.sendVerificationCode(email);

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
        } else {
          showMessage(result.message, true);
          sendCodeBtn.disabled = false;
          sendCodeBtn.textContent = getString("auth-send-code");
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
        const affCode = affCodeInput?.value?.trim();

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
            result = await authManager.register(username, password, email, verificationCode, affCode);
          }

          if (result.success) {
            showMessage(getString("auth-success"), false);
            setTimeout(() => {
              dialogHelper.window?.close();
              resolve(true);
            }, 1000);
          } else {
            // 显示API返回的错误消息
            const errorMsg = result.message || getString("auth-error-unknown");
            ztoolkit.log("[AuthDialog] Login/Register failed:", errorMsg);
            showMessage(errorMsg, true);
            buttons.forEach((btn: HTMLButtonElement) => (btn.disabled = false));
          }
        } catch (error) {
          showMessage(error instanceof Error ? error.message : getString("auth-error-unknown"), true);
          buttons.forEach((btn: HTMLButtonElement) => (btn.disabled = false));
        }
      };

      // 绑定提交按钮
      submitBtn?.addEventListener("click", handleSubmit);

      // 绑定取消按钮
      cancelBtn?.addEventListener("click", () => {
        if (countdownTimer) clearInterval(countdownTimer);
        dialogHelper.window?.close();
        resolve(false);
      });

      // 回车提交
      [usernameInput, passwordInput, confirmPasswordInput, verificationInput].forEach((input) => {
        input?.addEventListener("keypress", (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            handleSubmit();
          }
        });
      });

      // 初始化UI
      updateUI();
    }, 100);
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
