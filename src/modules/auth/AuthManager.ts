/**
 * AuthManager - 认证状态管理器
 *
 * 管理用户登录状态、Token、余额等
 * 与Zotero偏好设置集成
 */

import { AuthService } from "./AuthService";
import type { UserInfo, TokenInfo, AuthState } from "../../types/auth";
import { getPref, setPref } from "../../utils/prefs";

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
const PLUGIN_TOKEN_NAME = "PDF-AI-Talk-Plugin";

export class AuthManager {
  private authService: AuthService;
  private state: AuthState;
  private callbacks: AuthCallbacks = {};
  private listeners: CallbackListeners = {
    onLoginStatusChange: [],
    onUserInfoUpdate: [],
    onBalanceUpdate: [],
    onError: [],
  };
  private balanceRefreshInterval: ReturnType<typeof setInterval> | null = null;

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
   * 设置回调函数（添加到监听器列表，支持多个组件同时监听）
   */
  setCallbacks(callbacks: AuthCallbacks): void {
    // 保留旧的 callbacks 引用用于兼容
    this.callbacks = callbacks;

    // 添加到监听器列表
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
    this.listeners.onLoginStatusChange.forEach(cb => cb(isLoggedIn));
  }

  /**
   * 触发所有用户信息更新监听器
   */
  private notifyUserInfoUpdate(user: UserInfo | null): void {
    this.listeners.onUserInfoUpdate.forEach(cb => cb(user));
  }

  /**
   * 触发所有余额更新监听器
   */
  private notifyBalanceUpdate(quota: number, usedQuota: number): void {
    this.listeners.onBalanceUpdate.forEach(cb => cb(quota, usedQuota));
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

    // 恢复本地保存的用户信息
    if (savedUsername && savedUserId && (savedUserId as number) > 0) {
      this.state.user = {
        id: savedUserId as number,
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
      setPref("userQuotaJson", JSON.stringify({
        quota: this.state.user.quota,
        usedQuota: this.state.user.used_quota,
        affCode: this.state.user.aff_code,
      }));
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
  async sendVerificationCode(email: string): Promise<{ success: boolean; message: string }> {
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
    affCode?: string
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
  async resetPassword(email: string): Promise<{ success: boolean; message: string }> {
    const result = await this.authService.resetPassword(email);
    return {
      success: result.success,
      message: result.message,
    };
  }

  /**
   * 用户登录
   */
  async login(username: string, password: string): Promise<{ success: boolean; message: string }> {
    const result = await this.authService.login({ username, password });

    if (result.success) {
      // 保存用户ID (从AuthService获取，login时已提取)
      const userId = this.authService.getUserId();
      if (userId !== null) {
        this.state.userId = userId;
      }

      // 先尝试从 CookieSandbox 提取 session cookie
      // 这必须在 ensurePluginToken 之前，因为后续 API 调用需要 session
      const extractedSession = this.authService.extractSessionCookie();
      if (extractedSession) {
        this.state.sessionToken = extractedSession;
        this.authService.setSessionToken(extractedSession); // 设置到 AuthService
        setPref("sessionToken", extractedSession);
        ztoolkit.log("[AuthManager] Session cookie extracted and saved:", extractedSession.substring(0, 20) + "...");
      } else {
        // 如果从 CookieSandbox 提取失败，尝试从响应头获取
        const sessionToken = this.authService.getSessionToken();
        if (sessionToken) {
          this.state.sessionToken = sessionToken;
          ztoolkit.log("[AuthManager] Session token from response header:", sessionToken.substring(0, 20) + "...");
        }
      }

      // 获取用户信息
      await this.refreshUserInfo();

      // 确保有可用的Token (需要 session cookie)
      await this.ensurePluginToken();

      // 保存状态（包括密码，用于自动重新登录）
      this.saveState();
      // 保存登录密码用于自动重新登录（Zotero重启后session会丢失）
      // 使用 base64 编码存储，避免明文
      setPref("loginPassword", encodePassword(password));

      // 启动余额刷新
      this.startBalanceRefresh();

      this.state.isLoggedIn = true;
      this.notifyLoginStatusChange(true);

      return { success: true, message: "登录成功" };
    }

    return {
      success: false,
      message: result.message || "登录失败",
    };
  }

  /**
   * 自动重新登录（使用保存的凭证）
   * 当 session 过期时调用，作为 cookie 恢复失败的兜底方案
   */
  async autoRelogin(): Promise<boolean> {
    const savedUsername = getPref("username") as string;
    const savedPasswordEncoded = getPref("loginPassword") as string;

    if (!savedUsername || !savedPasswordEncoded) {
      ztoolkit.log("[AuthManager] Auto-relogin failed: no saved credentials");
      return false;
    }

    // 解码密码
    const savedPassword = decodePassword(savedPasswordEncoded);

    ztoolkit.log("[AuthManager] Attempting auto-relogin for user:", savedUsername);

    // 清除旧的 CookieSandbox，确保使用新的 session
    this.authService.resetCookieSandbox();

    const result = await this.authService.login({ username: savedUsername, password: savedPassword });

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
        this.authService.setSessionToken(extractedSession); // 设置到 AuthService
        setPref("sessionToken", extractedSession);
        ztoolkit.log("[AuthManager] New session cookie saved after auto-relogin");
      }

      return true;
    }

    ztoolkit.log("[AuthManager] Auto-relogin failed:", result.message);
    return false;
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
    let result = await this.authService.getUserInfo();

    // 如果 session 失效，尝试自动重新登录
    if (!result.success) {
      const errorMsg = result.message || "";
      if (errorMsg.includes("token") && (errorMsg.includes("无效") || errorMsg.includes("invalid"))) {
        ztoolkit.log("[AuthManager] Session invalid, attempting auto-relogin");
        const reloginSuccess = await this.autoRelogin();
        if (reloginSuccess) {
          // 重新尝试获取用户信息
          result = await this.authService.getUserInfo();
        }
      }
    }

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
      setPref("userQuotaJson", JSON.stringify({
        quota: result.data.quota,
        usedQuota: result.data.used_quota,
        affCode: result.data.aff_code,
      }));
      this.notifyUserInfoUpdate(result.data);
      this.notifyBalanceUpdate(result.data.quota, result.data.used_quota);
    } else {
      // 保留本地状态，不清除登录状态
      const errorMsg = result.message || "";
      ztoolkit.log("[AuthManager] refreshUserInfo failed, keeping local state:", errorMsg);
    }
  }

  /**
   * 确保存在插件专用Token
   */
  private async ensurePluginToken(): Promise<void> {
    // 先检查是否已有插件Token
    let tokensResult = await this.authService.getTokens(0, 100);

    // 如果 session 失效，尝试自动重新登录
    if (!tokensResult.success) {
      const errorMsg = tokensResult.message || "";
      if (errorMsg.includes("token") && (errorMsg.includes("无效") || errorMsg.includes("invalid"))) {
        ztoolkit.log("[AuthManager] Session invalid for getTokens, attempting auto-relogin");
        const reloginSuccess = await this.autoRelogin();
        if (reloginSuccess) {
          tokensResult = await this.authService.getTokens(0, 100);
        }
      }
    }

    if (tokensResult.success && tokensResult.data) {
      const existingToken = tokensResult.data.items?.find(
        (t) => t.name === PLUGIN_TOKEN_NAME && t.status === 1
      );

      if (existingToken) {
        this.state.token = existingToken;
        this.state.apiKey = `sk-${existingToken.key}`;
        setPref("apiKey", this.state.apiKey);
        return;
      }
    }

    // 创建新Token
    let createResult = await this.authService.createToken({
      name: PLUGIN_TOKEN_NAME,
      unlimited_quota: true,
      expired_time: -1, // 永不过期
    });

    // 如果 session 失效，尝试自动重新登录
    if (!createResult.success) {
      const errorMsg = createResult.message || "";
      if (errorMsg.includes("token") && (errorMsg.includes("无效") || errorMsg.includes("invalid"))) {
        ztoolkit.log("[AuthManager] Session invalid for createToken, attempting auto-relogin");
        const reloginSuccess = await this.autoRelogin();
        if (reloginSuccess) {
          createResult = await this.authService.createToken({
            name: PLUGIN_TOKEN_NAME,
            unlimited_quota: true,
            expired_time: -1,
          });
        }
      }
    }

    if (createResult.success) {
      // 重新获取Token列表以获取完整信息（createToken API 不返回 data）
      const newTokensResult = await this.authService.getTokens(0, 100);
      if (newTokensResult.success && newTokensResult.data) {
        const newToken = newTokensResult.data.items?.find(
          (t) => t.name === PLUGIN_TOKEN_NAME && t.status === 1
        );
        if (newToken) {
          this.state.token = newToken;
          this.state.apiKey = `sk-${newToken.key}`;
          setPref("apiKey", this.state.apiKey);
          // 同时更新 authService 的 accessToken
          this.authService.setAccessToken(this.state.apiKey);
          ztoolkit.log("[AuthManager] Plugin token created and saved:", this.state.apiKey.substring(0, 10) + "...");
        }
      }
    }
  }

  /**
   * 兑换充值码
   */
  async redeemCode(code: string): Promise<{ success: boolean; message: string; addedQuota?: number }> {
    const beforeQuota = this.state.user?.quota || 0;

    let result = await this.authService.redeemCode(code);

    // 如果 session 失效，尝试自动重新登录后重试
    if (!result.success) {
      const errorMsg = result.message || "";
      if (errorMsg.includes("token") && (errorMsg.includes("无效") || errorMsg.includes("invalid"))) {
        ztoolkit.log("[AuthManager] Session invalid for redeemCode, attempting auto-relogin");
        const reloginSuccess = await this.autoRelogin();
        if (reloginSuccess) {
          // 重新尝试兑换
          result = await this.authService.redeemCode(code);
        }
      }
    }

    if (result.success) {
      // 刷新用户信息以获取新余额
      await this.refreshUserInfo();

      const afterQuota = this.state.user?.quota || 0;
      const addedQuota = afterQuota - beforeQuota;

      return {
        success: true,
        message: `兑换成功! 增加余额: ${AuthService.formatQuota(addedQuota)}`,
        addedQuota,
      };
    }

    return {
      success: false,
      message: result.message || "兑换失败",
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
    if (this.state.apiKey && this.state.userId !== null && this.state.userId > 0) {
      // 如果本地已有用户信息（从prefs恢复的），直接使用，不调用API
      // 因为/api/user/self只接受session认证，重启后session cookie丢失
      if (this.state.user && this.state.isLoggedIn) {
        ztoolkit.log("[AuthManager] Using locally cached user info");
        // 通知UI更新
        this.notifyLoginStatusChange(true);
        this.notifyUserInfoUpdate(this.state.user);
        this.notifyBalanceUpdate(this.state.user.quota, this.state.user.used_quota);
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
    return AuthService.formatQuota(this.state.user.quota + this.state.user.used_quota);
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
