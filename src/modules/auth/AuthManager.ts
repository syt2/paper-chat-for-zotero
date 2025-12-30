/**
 * AuthManager - 认证状态管理器
 *
 * 管理用户登录状态、Token、余额等
 * 与Zotero偏好设置集成
 */

import { AuthService } from "./AuthService";
import type { UserInfo, TokenInfo, AuthState } from "../../types/auth";
import { getPref, setPref } from "../../utils/prefs";
import { BUILTIN_PROVIDERS, getProviderManager } from "../providers";
import { getString } from "../../utils/locale";

// 简单的密码编码/解码（base64，非加密，仅混淆）
function encodePassword(password: string): string {
  try {
    return btoa(unescape(encodeURIComponent(password)));
  } catch {
    return password;
  }
}

function decodePassword(encoded: string): string {
  try {
    return decodeURIComponent(escape(atob(encoded)));
  } catch {
    return encoded;
  }
}

// 回调类型
export interface AuthCallbacks {
  onLoginStatusChange?: (isLoggedIn: boolean) => void;
  onUserInfoUpdate?: (user: UserInfo | null) => void;
  onBalanceUpdate?: (quota: number, usedQuota: number) => void;
  onError?: (error: Error) => void;
}

// 多回调监听器管理
type CallbackListeners = {
  onLoginStatusChange: Array<(isLoggedIn: boolean) => void>;
  onUserInfoUpdate: Array<(user: UserInfo | null) => void>;
  onBalanceUpdate: Array<(quota: number, usedQuota: number) => void>;
  onError: Array<(error: Error) => void>;
};

// 插件专用Token名称
const PLUGIN_TOKEN_NAME = "Paper-Chat-Plugin";

export class AuthManager {
  private authService: AuthService;
  private state: AuthState;
  private listeners: CallbackListeners = {
    onLoginStatusChange: [],
    onUserInfoUpdate: [],
    onBalanceUpdate: [],
    onError: [],
  };
  private balanceRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private isAutoReloginInProgress = false; // 防止无限循环

  constructor() {
    this.authService = new AuthService();
    this.state = {
      isLoggedIn: false,
      user: null,
      token: null,
      apiKey: null,
      sessionToken: null,
      userId: null,
    };

    // 从偏好设置恢复状态
    this.restoreState();
  }

  /**
   * 添加回调监听器（支持多个组件同时监听）
   */
  addListener(callbacks: AuthCallbacks): void {
    if (callbacks.onLoginStatusChange) {
      this.listeners.onLoginStatusChange.push(callbacks.onLoginStatusChange);
    }
    if (callbacks.onUserInfoUpdate) {
      this.listeners.onUserInfoUpdate.push(callbacks.onUserInfoUpdate);
    }
    if (callbacks.onBalanceUpdate) {
      this.listeners.onBalanceUpdate.push(callbacks.onBalanceUpdate);
    }
    if (callbacks.onError) {
      this.listeners.onError.push(callbacks.onError);
    }
  }

  /**
   * 触发所有登录状态变化监听器
   */
  private notifyLoginStatusChange(isLoggedIn: boolean): void {
    this.listeners.onLoginStatusChange.forEach((cb) => cb(isLoggedIn));
  }

  /**
   * 触发所有用户信息更新监听器
   */
  private notifyUserInfoUpdate(user: UserInfo | null): void {
    this.listeners.onUserInfoUpdate.forEach((cb) => cb(user));
  }

  /**
   * 触发所有余额更新监听器
   */
  private notifyBalanceUpdate(quota: number, usedQuota: number): void {
    this.listeners.onBalanceUpdate.forEach((cb) => cb(quota, usedQuota));
  }

  /**
   * 检查是否为 session 失效错误
   */
  private isSessionInvalidError(message: string): boolean {
    // 检查 token 无效
    if (message.includes("token") && (message.includes("无效") || message.includes("invalid"))) {
      return true;
    }
    // 检查未登录/无权操作
    if (message.includes("未登录") || message.includes("无权")) {
      return true;
    }
    return false;
  }

  /**
   * 带 session 失效重试的 API 调用包装器
   * 如果 API 返回 session 失效错误，自动尝试重新登录并重试
   */
  private async withSessionRetry<T extends { success: boolean; message?: string }>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    let result = await operation();

    if (!result.success && this.isSessionInvalidError(result.message || "")) {
      ztoolkit.log(`[AuthManager] Session invalid for ${operationName}, attempting auto-relogin`);
      const reloginSuccess = await this.autoRelogin();
      if (reloginSuccess) {
        result = await operation();
      }
    }

    return result;
  }

  /**
   * 从偏好设置恢复状态
   */
  private restoreState(): void {
    const savedApiKey = getPref("apiKey");
    const savedSessionToken = getPref("sessionToken");
    const savedUserId = getPref("userId");
    const savedUsername = getPref("username");
    // quota 值可能超过 32 位整数，存为 JSON 字符串
    let savedQuota = 0;
    let savedUsedQuota = 0;
    let savedAffCode = "";
    try {
      const quotaJson = getPref("userQuotaJson") as string;
      if (quotaJson) {
        const parsed = JSON.parse(quotaJson);
        savedQuota = parsed.quota || 0;
        savedUsedQuota = parsed.usedQuota || 0;
        savedAffCode = parsed.affCode || "";
      }
    } catch {
      // ignore parse error
    }

    ztoolkit.log("[AuthManager] restoreState - read from prefs:", {
      savedApiKey: savedApiKey ? "exists" : "empty",
      savedSessionToken: savedSessionToken ? "exists" : "empty",
      savedUserId,
      savedUsername,
      savedQuota,
      savedUsedQuota,
    });

    if (savedApiKey) {
      this.state.apiKey = savedApiKey as string;
      // 设置访问令牌用于Authorization header验证
      this.authService.setAccessToken(savedApiKey as string);
    }

    if (savedSessionToken) {
      this.state.sessionToken = savedSessionToken as string;
      this.authService.setSessionToken(savedSessionToken as string);
      // 恢复 session cookie 到 CookieSandbox
      this.authService.restoreSessionCookie(savedSessionToken as string);
    }

    // userId 可能是0，需要检查是否为有效数字
    if (typeof savedUserId === "number" && savedUserId > 0) {
      this.state.userId = savedUserId;
      this.authService.setUserId(savedUserId);
    }
    // 注意: 如果 prefs 中没有 userId，需要用户重新登录

    // 获取最终的 userId 用于恢复用户信息
    const finalUserId = this.state.userId;

    // 恢复本地保存的用户信息
    if (savedUsername && finalUserId !== null && finalUserId > 0) {
      this.state.user = {
        id: finalUserId,
        username: savedUsername as string,
        display_name: savedUsername as string,
        email: "",
        role: 0,
        status: 1,
        quota: (savedQuota as number) || 0,
        used_quota: (savedUsedQuota as number) || 0,
        request_count: 0,
        group: "",
        aff_code: savedAffCode,
        inviter_id: 0,
        created_time: 0,
      };
      this.state.isLoggedIn = true;
    }
  }

  /**
   * 保存状态到偏好设置
   */
  private saveState(): void {
    if (this.state.apiKey) {
      setPref("apiKey", this.state.apiKey);
      // 同时更新authService的accessToken
      this.authService.setAccessToken(this.state.apiKey);
    }
    if (this.state.sessionToken) {
      setPref("sessionToken", this.state.sessionToken);
    }
    if (this.state.userId !== null && this.state.userId > 0) {
      setPref("userId", this.state.userId);
    }
    // 保存用户信息用于重启后恢复
    // quota 值可能超过 32 位整数，存为 JSON 字符串
    if (this.state.user) {
      setPref("username", this.state.user.username);
      setPref(
        "userQuotaJson",
        JSON.stringify({
          quota: this.state.user.quota,
          usedQuota: this.state.user.used_quota,
          affCode: this.state.user.aff_code,
        }),
      );
    }
  }

  /**
   * 获取当前状态
   */
  getState(): AuthState {
    return { ...this.state };
  }

  /**
   * 检查是否已登录
   */
  isLoggedIn(): boolean {
    return this.state.isLoggedIn;
  }

  /**
   * 获取当前用户
   */
  getUser(): UserInfo | null {
    return this.state.user;
  }

  /**
   * 获取API Key
   */
  getApiKey(): string | null {
    return this.state.apiKey;
  }

  /**
   * 获取用户余额
   */
  getBalance(): { quota: number; usedQuota: number } {
    return {
      quota: this.state.user?.quota || 0,
      usedQuota: this.state.user?.used_quota || 0,
    };
  }

  /**
   * 发送验证码
   */
  async sendVerificationCode(
    email: string,
  ): Promise<{ success: boolean; message: string }> {
    const result = await this.authService.sendVerificationCode(email);
    return {
      success: result.success,
      message: result.message,
    };
  }

  /**
   * 用户注册
   */
  async register(
    username: string,
    password: string,
    email: string,
    verificationCode: string,
    affCode?: string,
  ): Promise<{ success: boolean; message: string }> {
    const result = await this.authService.register({
      username,
      password,
      email,
      verification_code: verificationCode,
      aff_code: affCode,
    });

    if (result.success) {
      // 注册成功后自动登录
      return this.login(username, password);
    }

    return {
      success: result.success,
      message: result.message,
    };
  }

  /**
   * 重置密码（发送重置邮件）
   */
  async resetPassword(
    email: string,
  ): Promise<{ success: boolean; message: string }> {
    const result = await this.authService.resetPassword(email);
    return {
      success: result.success,
      message: result.message,
    };
  }

  /**
   * 用户登录
   */
  async login(
    username: string,
    password: string,
  ): Promise<{ success: boolean; message: string }> {
    // 登录前始终清除旧状态，确保干净的登录环境
    ztoolkit.log("[AuthManager] Clearing old state before login");
    this.state.userId = null;
    this.state.user = null;
    this.state.apiKey = null;
    this.state.sessionToken = null;
    this.state.isLoggedIn = false;
    this.authService.setUserId(null);
    this.authService.setAccessToken(null);
    this.authService.setSessionToken(null);
    this.authService.clearSessionCookie();

    const result = await this.authService.login({ username, password });

    if (result.success) {
      // 保存用户ID (从AuthService获取，login时已提取)
      const userId = this.authService.getUserId();
      if (userId !== null) {
        this.state.userId = userId;
      }

      // 从 CookieSandbox 提取 session cookie
      const extractedSession = this.authService.extractSessionCookie();
      if (extractedSession) {
        this.state.sessionToken = extractedSession;
        this.authService.setSessionToken(extractedSession);
        setPref("sessionToken", extractedSession);
        ztoolkit.log(
          "[AuthManager] Session cookie extracted and saved:",
          extractedSession.substring(0, 20) + "...",
        );
      } else {
        // 如果从 CookieSandbox 提取失败，尝试从响应头获取
        const sessionToken = this.authService.getSessionToken();
        if (sessionToken) {
          this.state.sessionToken = sessionToken;
          ztoolkit.log(
            "[AuthManager] Session token from response header:",
            sessionToken.substring(0, 20) + "...",
          );
        }
      }

      // 确保 authService 也有 userId 用于后续 API 调用
      if (this.state.userId !== null && this.state.userId > 0) {
        this.authService.setUserId(this.state.userId);
      } else {
        // userId 解析失败，认为登录失败
        ztoolkit.log(
          "[AuthManager] Login failed: could not parse userId from session",
        );
        return {
          success: false,
          message: getString("api-error-parse-user-failed"),
        };
      }

      // 获取用户信息
      await this.refreshUserInfo();

      // 确保有可用的Token (需要 session cookie)
      await this.ensurePluginToken();

      // 获取可用模型列表并设置默认模型
      await this.fetchAndSetDefaultModel();

      // 保存状态
      this.saveState();
      setPref("loginPassword", encodePassword(password));
      setPref("username", username);

      // 启动余额刷新
      this.startBalanceRefresh();

      this.state.isLoggedIn = true;
      this.notifyLoginStatusChange(true);

      return { success: true, message: getString("api-success-login") };
    }

    return {
      success: false,
      message: result.message || getString("api-error-login-failed", { args: { status: "" } }),
    };
  }

  /**
   * 自动重新登录（使用保存的凭证）
   * 当 session 过期时调用，作为 cookie 恢复失败的兜底方案
   */
  async autoRelogin(): Promise<boolean> {
    // 防止无限循环
    if (this.isAutoReloginInProgress) {
      ztoolkit.log("[AuthManager] Auto-relogin already in progress, skipping");
      return false;
    }

    const savedUsername = getPref("username") as string;
    const savedPasswordEncoded = getPref("loginPassword") as string;

    if (!savedUsername || !savedPasswordEncoded) {
      ztoolkit.log("[AuthManager] Auto-relogin failed: no saved credentials");
      return false;
    }

    // 解码密码
    const savedPassword = decodePassword(savedPasswordEncoded);

    ztoolkit.log(
      "[AuthManager] Attempting auto-relogin for user:",
      savedUsername,
    );

    this.isAutoReloginInProgress = true;

    try {
      // 清除旧的 CookieSandbox，确保使用新的 session
      this.authService.clearSessionCookie();

      const result = await this.authService.login({
        username: savedUsername,
        password: savedPassword,
      });

      if (result.success) {
        ztoolkit.log("[AuthManager] Auto-relogin successful");

        // 更新用户ID
        const userId = this.authService.getUserId();
        if (userId !== null) {
          this.state.userId = userId;
          this.authService.setUserId(userId);
        }

        // 尝试提取并保存新的 session cookie
        const extractedSession = this.authService.extractSessionCookie();
        if (extractedSession) {
          this.state.sessionToken = extractedSession;
          this.authService.setSessionToken(extractedSession);
          setPref("sessionToken", extractedSession);
          ztoolkit.log(
            "[AuthManager] New session cookie saved after auto-relogin",
          );
        }

        // 确保 authService 有 userId
        if (this.state.userId !== null && this.state.userId > 0) {
          this.authService.setUserId(this.state.userId);
        }

        return true;
      }

      ztoolkit.log("[AuthManager] Auto-relogin failed:", result.message);
      return false;
    } finally {
      this.isAutoReloginInProgress = false;
    }
  }

  /**
   * 用户登出
   */
  async logout(): Promise<void> {
    await this.authService.logout();

    // 清除状态
    this.state = {
      isLoggedIn: false,
      user: null,
      token: null,
      apiKey: null,
      sessionToken: null,
      userId: null,
    };

    // 清除 AuthService 状态
    this.authService.setUserId(null);
    this.authService.setAccessToken(null);
    this.authService.setSessionToken(null);
    this.authService.clearSessionCookie();

    // 清除偏好设置
    setPref("apiKey", "");
    setPref("sessionToken", "");
    setPref("userId", 0);
    setPref("username", "");
    setPref("userQuotaJson", "");
    setPref("loginPassword", ""); // 清除保存的密码

    // 停止余额刷新
    this.stopBalanceRefresh();

    this.notifyLoginStatusChange(false);
    this.notifyUserInfoUpdate(null);
  }

  /**
   * 刷新用户信息
   */
  async refreshUserInfo(): Promise<void> {
    const result = await this.withSessionRetry(
      () => this.authService.getUserInfo(),
      "getUserInfo",
    );

    if (result.success && result.data) {
      this.state.user = result.data;
      this.state.isLoggedIn = true;
      // 保存用户信息到本地，以便重启后恢复
      // quota 值可能超过 32 位整数，存为 JSON 字符串
      ztoolkit.log("[AuthManager] refreshUserInfo - saving to prefs:", {
        username: result.data.username,
        quota: result.data.quota,
        usedQuota: result.data.used_quota,
        affCode: result.data.aff_code,
      });
      setPref("username", result.data.username);
      setPref(
        "userQuotaJson",
        JSON.stringify({
          quota: result.data.quota,
          usedQuota: result.data.used_quota,
          affCode: result.data.aff_code,
        }),
      );
      this.notifyUserInfoUpdate(result.data);
      this.notifyBalanceUpdate(result.data.quota, result.data.used_quota);
    } else {
      // 保留本地状态，不清除登录状态
      const errorMsg = result.message || "";
      ztoolkit.log(
        "[AuthManager] refreshUserInfo failed, keeping local state:",
        errorMsg,
      );
    }
  }

  /**
   * 确保存在插件专用Token
   * 公开方法，允许在 API key 失效时刷新
   * @param forceRefresh 是否强制刷新（删除旧 token 并创建新的）
   */
  async ensurePluginToken(forceRefresh: boolean = false): Promise<void> {
    // 先检查是否已有插件Token
    const tokensResult = await this.withSessionRetry(
      () => this.authService.getTokens(0, 100),
      "getTokens",
    );

    if (tokensResult.success && tokensResult.data) {
      const existingToken = tokensResult.data.items?.find(
        (t) => t.name === PLUGIN_TOKEN_NAME && t.status === 1,
      );

      if (existingToken && !forceRefresh) {
        this.state.token = existingToken;
        this.state.apiKey = `sk-${existingToken.key}`;
        setPref("apiKey", this.state.apiKey);
        // 同时更新 authService 的 accessToken
        this.authService.setAccessToken(this.state.apiKey);
        ztoolkit.log(
          "[AuthManager] Using existing plugin token:",
          this.state.apiKey.substring(0, 10) + "...",
        );
        return;
      }

      // forceRefresh 时，如果有旧 token 则删除它
      if (existingToken && forceRefresh) {
        ztoolkit.log("[AuthManager] Force refresh: deleting old token");
        await this.withSessionRetry(
          () => this.authService.deleteToken(existingToken.id),
          "deleteOldToken",
        );
      }
    }

    // 创建新Token
    const createResult = await this.withSessionRetry(
      () =>
        this.authService.createToken({
          name: PLUGIN_TOKEN_NAME,
          unlimited_quota: true,
          expired_time: -1, // 永不过期
        }),
      "createToken",
    );

    if (createResult.success) {
      // 重新获取Token列表以获取完整信息（createToken API 不返回 data）
      const newTokensResult = await this.authService.getTokens(0, 100);
      if (newTokensResult.success && newTokensResult.data) {
        const newToken = newTokensResult.data.items?.find(
          (t) => t.name === PLUGIN_TOKEN_NAME && t.status === 1,
        );
        if (newToken) {
          this.state.token = newToken;
          this.state.apiKey = `sk-${newToken.key}`;
          setPref("apiKey", this.state.apiKey);
          // 同时更新 authService 的 accessToken
          this.authService.setAccessToken(this.state.apiKey);
          ztoolkit.log(
            "[AuthManager] Plugin token created and saved:",
            this.state.apiKey.substring(0, 10) + "...",
          );
        }
      }
    }
  }

  /**
   * 获取模型列表并设置默认模型
   * 在登录成功后调用，确保使用服务端支持的模型
   */
  private async fetchAndSetDefaultModel(): Promise<void> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      ztoolkit.log("[AuthManager] No API key, skip fetching models");
      return;
    }

    const url = `${BUILTIN_PROVIDERS.paperchat.defaultBaseUrl}/models`;
    ztoolkit.log("[AuthManager] Fetching models from:", url);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        ztoolkit.log("[AuthManager] Failed to fetch models:", response.status);
        return;
      }

      const result = (await response.json()) as { data?: Array<{ id: string }> };

      if (result.data && Array.isArray(result.data)) {
        const models = result.data.map((m) => m.id).sort();
        ztoolkit.log("[AuthManager] Fetched models count:", models.length);

        if (models.length > 0) {
          // 缓存模型列表
          setPref("paperchatModelsCache", JSON.stringify(models));

          // 获取当前模型设置
          const currentModel = getPref("model") as string;

          // 如果当前模型不在列表中，设置默认模型
          if (!currentModel || !models.includes(currentModel)) {
            // 优先使用 claude-haiku-4-5-20251001，否则用第一个
            const preferredModel = "claude-haiku-4-5-20251001";
            const defaultModel = models.includes(preferredModel)
              ? preferredModel
              : models[0];
            setPref("model", defaultModel);
            ztoolkit.log("[AuthManager] Set default model to:", defaultModel);

            // 更新 provider 配置
            const providerManager = getProviderManager();
            providerManager.updateProviderConfig("paperchat", {
              defaultModel: defaultModel,
              availableModels: models,
            });
          } else {
            // 只更新可用模型列表
            const providerManager = getProviderManager();
            providerManager.updateProviderConfig("paperchat", {
              availableModels: models,
            });
          }
        }
      }
    } catch (e) {
      ztoolkit.log("[AuthManager] Failed to fetch models:", e);
    }
  }

  /**
   * 兑换充值码
   */
  async redeemCode(
    code: string,
  ): Promise<{ success: boolean; message: string; addedQuota?: number }> {
    const beforeQuota = this.state.user?.quota || 0;

    const result = await this.withSessionRetry(
      () => this.authService.redeemCode(code),
      "redeemCode",
    );

    if (result.success) {
      // 刷新用户信息以获取新余额
      await this.refreshUserInfo();

      const afterQuota = this.state.user?.quota || 0;
      const addedQuota = afterQuota - beforeQuota;

      return {
        success: true,
        message: getString("api-success-redeem", { args: { amount: AuthService.formatQuota(addedQuota) } }),
        addedQuota,
      };
    }

    return {
      success: false,
      message: result.message || getString("api-error-redeem-failed", { args: { status: "" } }),
    };
  }

  /**
   * 初始化 - 检查登录状态
   */
  async initialize(): Promise<void> {
    ztoolkit.log("[AuthManager] Initializing...", {
      hasApiKey: !!this.state.apiKey,
      hasUserId: this.state.userId !== null && this.state.userId > 0,
      userId: this.state.userId,
      hasUser: !!this.state.user,
      isLoggedIn: this.state.isLoggedIn,
    });

    // 如果有apiKey和userId说明之前登录过
    if (
      this.state.apiKey &&
      this.state.userId !== null &&
      this.state.userId > 0
    ) {
      // 如果本地已有用户信息（从prefs恢复的），直接使用，不调用API
      // 因为/api/user/self只接受session认证，重启后session cookie丢失
      if (this.state.user && this.state.isLoggedIn) {
        ztoolkit.log("[AuthManager] Using locally cached user info");
        // 通知UI更新
        this.notifyLoginStatusChange(true);
        this.notifyUserInfoUpdate(this.state.user);
        this.notifyBalanceUpdate(
          this.state.user.quota,
          this.state.user.used_quota,
        );
        // 启动余额刷新 - 但不会真的刷新因为API不接受token
        // this.startBalanceRefresh();
        ztoolkit.log("[AuthManager] Session restored from local cache");
      } else {
        // 没有本地用户信息，尝试API调用（可能在同一session内）
        await this.refreshUserInfo();
        if (this.state.isLoggedIn) {
          await this.ensurePluginToken();
          this.startBalanceRefresh();
          ztoolkit.log("[AuthManager] Session restored via API");
        } else {
          ztoolkit.log("[AuthManager] Failed to restore session");
        }
      }
    }
  }

  /**
   * 启动余额定时刷新 (每60秒)
   */
  private startBalanceRefresh(): void {
    this.stopBalanceRefresh();
    this.balanceRefreshInterval = setInterval(() => {
      this.refreshUserInfo();
    }, 60000);
  }

  /**
   * 停止余额刷新
   */
  private stopBalanceRefresh(): void {
    if (this.balanceRefreshInterval) {
      clearInterval(this.balanceRefreshInterval);
      this.balanceRefreshInterval = null;
    }
  }

  /**
   * 格式化余额显示（剩余额度）
   * API 返回的 quota 就是剩余额度
   */
  formatBalance(): string {
    if (!this.state.user) return "0";
    return AuthService.formatQuota(this.state.user.quota);
  }

  /**
   * 格式化已用额度
   */
  formatUsedQuota(): string {
    if (!this.state.user) return "0";
    return AuthService.formatQuota(this.state.user.used_quota);
  }

  /**
   * 格式化总额度（剩余 + 已用）
   */
  formatTotalQuota(): string {
    if (!this.state.user) return "0";
    return AuthService.formatQuota(
      this.state.user.quota + this.state.user.used_quota,
    );
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.stopBalanceRefresh();
  }
}

// 全局单例
let authManager: AuthManager | null = null;

export function getAuthManager(): AuthManager {
  if (!authManager) {
    authManager = new AuthManager();
  }
  return authManager;
}

export function destroyAuthManager(): void {
  if (authManager) {
    authManager.destroy();
    authManager = null;
  }
}
