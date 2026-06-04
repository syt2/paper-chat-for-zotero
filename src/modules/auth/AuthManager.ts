/**
 * AuthManager - 认证状态管理器
 *
 * 管理用户登录状态、Token、余额等
 * 与Zotero偏好设置集成
 */

import {
  AuthService,
  type PaperChatOrderResult,
  type PaperChatProductsResult,
} from "./AuthService";
import type {
  UserInfo,
  TokenInfo,
  AuthState,
  ApiResponse,
  CreateTokenRequest,
  SubscriptionSelfInfo,
  SubscriptionUsageSummary,
} from "../../types/auth";
import { getPref, setPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";
import { BUILTIN_PROVIDERS, getProviderManager } from "../providers";
import {
  fetchPaperchatRoutingMeta,
  fetchPaperchatRatios,
  getModelRatios,
  getModelRoutingMeta,
} from "../preferences/ModelsFetcher";
import {
  parseTierState,
  resolveSelectedTierModel,
  validateTierState,
} from "../providers/paperchat-tier-routing";
import { isEmbeddingModel } from "../embedding/providers/PaperChatEmbedding";
import {
  buildLegacyPluginTokenCreateRequest,
  buildPluginTokenCreateRequest,
  findActiveAutoPluginToken,
  findLegacyPluginToken,
  normalizePluginApiKey,
} from "./PluginToken";

// 密码加密/解密（使用简单的 XOR 加密 + Base64 编码）
// 加密密钥基于插件 ID 和用户 profile 路径生成，比纯 Base64 更安全
const ENCRYPTION_SALT = "paper-chat-v1-salt";

function getEncryptionKey(): string {
  // 使用插件 ID、salt 和 Zotero 数据目录生成密钥
  const dataDir = Zotero.DataDirectory?.dir || "default";
  const keySource = `${ENCRYPTION_SALT}-${dataDir}`;
  // 生成固定长度的密钥
  let key = "";
  for (let i = 0; i < keySource.length; i++) {
    key += String.fromCharCode(keySource.charCodeAt(i) % 256);
  }
  return key;
}

function xorEncrypt(text: string, key: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(
      text.charCodeAt(i) ^ key.charCodeAt(i % key.length),
    );
  }
  return result;
}

function encodePassword(password: string): string {
  try {
    const key = getEncryptionKey();
    const encrypted = xorEncrypt(password, key);
    // 添加版本前缀以便后续升级
    return "v1:" + btoa(unescape(encodeURIComponent(encrypted)));
  } catch {
    return password;
  }
}

function decodePassword(encoded: string): string {
  try {
    // 检查版本前缀
    if (encoded.startsWith("v1:")) {
      const base64Part = encoded.substring(3);
      const encrypted = decodeURIComponent(escape(atob(base64Part)));
      const key = getEncryptionKey();
      return xorEncrypt(encrypted, key); // XOR 是对称的
    }
    // 兼容旧版本（纯 Base64）
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

// 模型列表自动刷新间隔（1小时）
const MODEL_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

const SUPPORTED_USER_LANGUAGES = new Set([
  "zh-TW",
  "en",
  "zh-CN",
  "fr",
  "ru",
  "ja",
  "vi",
]);

function getSubscriptionEndTimeMs(endTime: number): number | null {
  if (!Number.isFinite(endTime) || endTime <= 0) {
    return null;
  }

  return endTime >= 1_000_000_000_000 ? endTime : endTime * 1000;
}

function isActiveSubscriptionCacheValid(
  subscription: { status?: string; end_time?: number },
  now: number,
): boolean {
  if (subscription.status !== "active") {
    return false;
  }

  const endTimeMs = getSubscriptionEndTimeMs(subscription.end_time || 0);
  return endTimeMs !== null && endTimeMs > now;
}

function getActiveSubscriptionInfo(
  info: SubscriptionSelfInfo | null,
): SubscriptionSelfInfo | null {
  const subscriptions = (info?.subscriptions || []).filter(
    (item) => item?.subscription?.status === "active",
  );

  if (subscriptions.length === 0) {
    return null;
  }

  return {
    ...info,
    subscriptions,
  };
}

function getUnexpiredActiveSubscriptionInfo(
  info: SubscriptionSelfInfo | null,
  now: number = Date.now(),
): SubscriptionSelfInfo | null {
  const subscriptions = (info?.subscriptions || []).filter((item) =>
    isActiveSubscriptionCacheValid(item?.subscription || {}, now),
  );

  if (subscriptions.length === 0) {
    return null;
  }

  return {
    ...info,
    subscriptions,
  };
}

export class AuthManager {
  private authService: AuthService;
  private state: AuthState;
  private listeners: CallbackListeners = {
    onLoginStatusChange: [],
    onUserInfoUpdate: [],
    onBalanceUpdate: [],
    onError: [],
  };
  private isAutoReloginInProgress = false; // 防止无限循环
  private modelRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.authService = new AuthService();
    this.state = {
      isLoggedIn: false,
      user: null,
      subscription: null,
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
   * @returns 清理函数，调用后移除所有添加的监听器
   */
  addListener(callbacks: AuthCallbacks): () => void {
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

    // 返回清理函数
    return () => {
      this.removeListener(callbacks);
    };
  }

  /**
   * 移除回调监听器
   */
  removeListener(callbacks: AuthCallbacks): void {
    if (callbacks.onLoginStatusChange) {
      const idx = this.listeners.onLoginStatusChange.indexOf(
        callbacks.onLoginStatusChange,
      );
      if (idx > -1) this.listeners.onLoginStatusChange.splice(idx, 1);
    }
    if (callbacks.onUserInfoUpdate) {
      const idx = this.listeners.onUserInfoUpdate.indexOf(
        callbacks.onUserInfoUpdate,
      );
      if (idx > -1) this.listeners.onUserInfoUpdate.splice(idx, 1);
    }
    if (callbacks.onBalanceUpdate) {
      const idx = this.listeners.onBalanceUpdate.indexOf(
        callbacks.onBalanceUpdate,
      );
      if (idx > -1) this.listeners.onBalanceUpdate.splice(idx, 1);
    }
    if (callbacks.onError) {
      const idx = this.listeners.onError.indexOf(callbacks.onError);
      if (idx > -1) this.listeners.onError.splice(idx, 1);
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
    if (
      message.includes("token") &&
      (message.includes("无效") || message.includes("invalid"))
    ) {
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
  private async withSessionRetry<
    T extends { success: boolean; message?: string },
  >(operation: () => Promise<T>, operationName: string): Promise<T> {
    let result = await operation();

    if (!result.success && this.isSessionInvalidError(result.message || "")) {
      ztoolkit.log(
        `[AuthManager] Session invalid for ${operationName}, attempting auto-relogin`,
      );
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
    const savedUserId = getPref("userId");
    const savedUsername = getPref("username");
    // quota 值可能超过 32 位整数，存为 JSON 字符串
    let savedQuota = 0;
    let savedUsedQuota = 0;
    let savedAffCode = "";
    let savedSubscription: SubscriptionSelfInfo | null = null;
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
    try {
      const subscriptionJson = getPref("userSubscriptionJson") as string;
      if (subscriptionJson) {
        savedSubscription = getUnexpiredActiveSubscriptionInfo(
          JSON.parse(subscriptionJson) as SubscriptionSelfInfo,
        );
        if (!savedSubscription) {
          setPref("userSubscriptionJson", "");
        }
      }
    } catch {
      setPref("userSubscriptionJson", "");
    }

    // 从浏览器 cookie jar 恢复 session（浏览器会自动持久化）
    this.authService.restoreSessionFromCookieJar();
    const restoredSession = this.authService.getSessionToken();
    if (restoredSession) {
      this.state.sessionToken = restoredSession;
    }

    ztoolkit.log("[AuthManager] restoreState - read from prefs:", {
      savedApiKey: savedApiKey ? "exists" : "empty",
      sessionFromCookieJar: restoredSession ? "exists" : "empty",
      savedUserId,
      savedUsername,
      savedQuota,
      savedUsedQuota,
      savedSubscription: savedSubscription ? "exists" : "empty",
    });

    if (savedApiKey) {
      const key = savedApiKey as string;
      // Reject masked keys that leaked from old versions
      if (key.includes("*")) {
        ztoolkit.log("[AuthManager] Discarding masked apiKey from prefs");
        setPref("apiKey", "");
      } else {
        this.state.apiKey = key;
        this.authService.setAccessToken(key);
      }
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
      this.state.subscription = savedSubscription;
      this.state.isLoggedIn = true;
    }
  }

  /**
   * 保存状态到偏好设置
   */
  private saveState(): void {
    if (this.state.apiKey) {
      setPref("apiKey", this.state.apiKey);
      this.authService.setAccessToken(this.state.apiKey);
    }
    // sessionToken 由浏览器 cookie jar 自动持久化，不需要存 prefs
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
    const activeSubscription = getUnexpiredActiveSubscriptionInfo(
      this.state.subscription,
    );
    if (activeSubscription) {
      setPref("userSubscriptionJson", JSON.stringify(activeSubscription));
    } else {
      setPref("userSubscriptionJson", "");
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

  private savePluginTokenKey(token: TokenInfo, key: string): string {
    this.state.token = token;
    this.state.apiKey = normalizePluginApiKey(key);
    setPref("apiKey", this.state.apiKey);
    this.authService.setAccessToken(this.state.apiKey);
    return this.state.apiKey;
  }

  private async fetchAndSavePluginTokenKey(
    token: TokenInfo,
    operationName: string,
  ): Promise<string | null> {
    const keyResult = await this.withSessionRetry(
      () => this.authService.getTokenKey(token.id),
      operationName,
    );
    if (keyResult.success && keyResult.data?.key) {
      return this.savePluginTokenKey(token, keyResult.data.key);
    }
    return null;
  }

  private async fetchAndSavePluginTokenKeyWithRetry(
    token: TokenInfo,
    operationName: string,
  ): Promise<string | null> {
    let apiKey = await this.fetchAndSavePluginTokenKey(token, operationName);
    if (apiKey) {
      return apiKey;
    }

    ztoolkit.log(`[AuthManager] ${operationName} failed, retrying after 2s...`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    apiKey = await this.fetchAndSavePluginTokenKey(token, operationName);
    if (!apiKey) {
      ztoolkit.log(
        `[AuthManager] ${operationName} failed after retry, token key unavailable`,
      );
    }
    return apiKey;
  }

  private async createAndSavePluginToken(
    request: CreateTokenRequest,
    selectToken: (tokens: TokenInfo[]) => TokenInfo | undefined,
    createOperationName: string,
    getKeyOperationName: string,
  ): Promise<string | null> {
    const createResult = await this.withSessionRetry(
      () => this.authService.createToken(request),
      createOperationName,
    );
    if (!createResult.success) {
      return null;
    }

    const tokensResult = await this.withSessionRetry(
      () => this.authService.getTokens(0, 100),
      `${createOperationName}:getTokens`,
    );
    if (!tokensResult.success || !tokensResult.data) {
      return null;
    }

    const token = selectToken(tokensResult.data.items || []);
    if (!token) {
      return null;
    }

    return this.fetchAndSavePluginTokenKeyWithRetry(token, getKeyOperationName);
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
    this.state.subscription = null;
    this.state.apiKey = null;
    this.state.sessionToken = null;
    this.state.isLoggedIn = false;
    this.authService.setUserId(null);
    this.authService.setAccessToken(null);
    this.authService.clearSessionCookie();
    setPref("userSubscriptionJson", "");

    const result = await this.authService.login({ username, password });

    if (result.success) {
      // 保存用户ID (从AuthService获取，login时已提取)
      const userId = this.authService.getUserId();
      if (userId !== null) {
        this.state.userId = userId;
      }

      // 从 HTTP Observer 捕获的 session 更新状态
      const sessionToken = this.authService.getSessionToken();
      if (sessionToken) {
        this.state.sessionToken = sessionToken;
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

      this.state.isLoggedIn = true;
      this.notifyLoginStatusChange(true);
      this.startModelRefreshTimer();
      this.syncLocalLanguagePreference().catch((error) => {
        ztoolkit.log("[AuthManager] Login language sync failed:", error);
      });

      return { success: true, message: getString("api-success-login") };
    }

    return {
      success: false,
      message:
        result.message ||
        getString("api-error-login-failed", { args: { status: "" } }),
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

        // 从 HTTP Observer 捕获的 session 更新状态
        const sessionToken = this.authService.getSessionToken();
        if (sessionToken) {
          this.state.sessionToken = sessionToken;
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
    this.stopModelRefreshTimer();
    await this.authService.logout();

    // 清除状态
    this.state = {
      isLoggedIn: false,
      user: null,
      subscription: null,
      token: null,
      apiKey: null,
      sessionToken: null,
      userId: null,
    };

    // 清除 AuthService 状态
    this.authService.setUserId(null);
    this.authService.setAccessToken(null);
    this.authService.clearSessionCookie();

    // 清除偏好设置（sessionToken 由浏览器 cookie jar 管理）
    setPref("apiKey", "");
    setPref("userId", 0);
    setPref("username", "");
    setPref("userQuotaJson", "");
    setPref("userSubscriptionJson", "");
    this.state.subscription = null;
    setPref("loginPassword", "");

    this.notifyLoginStatusChange(false);
    this.notifyUserInfoUpdate(null);
  }

  /**
   * 获取签到状态（当月）
   */
  async fetchCheckinStatus(): Promise<{
    success: boolean;
    enabled: boolean;
    checkedInToday: boolean;
    checkinCount: number;
    message?: string;
  }> {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return this.withSessionRetry(
      () => this.authService.getCheckinStatus(month),
      "getCheckinStatus",
    );
  }

  /**
   * 执行签到
   */
  async doCheckin(): Promise<{
    success: boolean;
    message?: string;
    quotaAwarded?: number;
  }> {
    return this.withSessionRetry(
      () => this.authService.doCheckin(),
      "doCheckin",
    );
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
      await this.refreshSubscriptionInfo();
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

  async getPricing(): Promise<ApiResponse<Array<Record<string, unknown>>>> {
    return this.withSessionRetry(
      () => this.authService.getPricing(),
      "getPricing",
    );
  }

  async refreshSubscriptionInfo(): Promise<void> {
    const result = await this.withSessionRetry(
      () => this.authService.getSubscriptionSelf(),
      "getSubscriptionSelf",
    );

    if (result.success) {
      const activeSubscription = getActiveSubscriptionInfo(result.data || null);
      this.state.subscription = activeSubscription;
      const cachedSubscription =
        getUnexpiredActiveSubscriptionInfo(activeSubscription);
      setPref(
        "userSubscriptionJson",
        cachedSubscription ? JSON.stringify(cachedSubscription) : "",
      );
    } else {
      ztoolkit.log(
        "[AuthManager] refreshSubscriptionInfo failed:",
        result.message || "",
      );
    }
  }

  getSubscriptionUsageSummary(): SubscriptionUsageSummary | null {
    const records = (this.state.subscription?.subscriptions || [])
      .map((item) => item?.subscription)
      .filter(
        (subscription) =>
          subscription &&
          subscription.status === "active" &&
          Number.isFinite(subscription.amount_total) &&
          subscription.amount_total > 0,
      );

    if (records.length === 0) {
      return null;
    }

    const amountTotal = records.reduce(
      (sum, subscription) => sum + Math.max(0, subscription.amount_total),
      0,
    );
    const amountUsed = records.reduce(
      (sum, subscription) =>
        sum +
        Math.max(
          0,
          Number.isFinite(subscription.amount_used)
            ? subscription.amount_used
            : 0,
        ),
      0,
    );

    if (amountTotal <= 0) {
      return null;
    }

    return {
      amountTotal,
      amountUsed,
      amountRemaining: Math.max(0, amountTotal - amountUsed),
      amountTotalLabel: AuthService.formatQuota(amountTotal),
      amountUsedLabel: AuthService.formatQuota(amountUsed),
      percentUsed: Math.min(100, Math.max(0, (amountUsed / amountTotal) * 100)),
    };
  }

  private getLocalUserLanguage(): string {
    const locale = (Zotero.locale || "en").replace("_", "-").toLowerCase();

    if (locale === "zh-tw" || locale === "zh-hant") {
      return "zh-TW";
    }
    if (locale === "zh-cn" || locale === "zh-hans" || locale === "zh-sg") {
      return "zh-CN";
    }

    const language = locale.split("-")[0];
    if (SUPPORTED_USER_LANGUAGES.has(language)) {
      return language;
    }

    return "en";
  }

  private async syncLocalLanguagePreference(): Promise<void> {
    if (!this.state.isLoggedIn) {
      return;
    }

    const language = this.getLocalUserLanguage();
    const result = await this.withSessionRetry(
      () => this.authService.updateUserLanguage(language),
      "updateUserLanguage",
    );

    if (result.success) {
      ztoolkit.log("[AuthManager] Synced user language:", language);
    } else {
      ztoolkit.log(
        "[AuthManager] Failed to sync user language:",
        result.message,
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

    let legacyToken: TokenInfo | undefined;
    if (tokensResult.success && tokensResult.data) {
      const tokens = tokensResult.data.items || [];
      const autoToken = findActiveAutoPluginToken(tokens);
      legacyToken = findLegacyPluginToken(tokens);

      if (autoToken && !forceRefresh) {
        // getTokens 返回的 key 是掩码形式，需要通过 getTokenKey 获取真实 key
        const apiKey = await this.fetchAndSavePluginTokenKey(
          autoToken,
          "getTokenKey",
        );
        if (apiKey) {
          ztoolkit.log(
            "[AuthManager] Using existing auto plugin token:",
            apiKey.substring(0, 10) + "...",
          );
          return;
        }
        // getTokenKey failed (e.g. 429 rate limit) — keep using cached apiKey if available
        const cachedApiKey = getPref("apiKey") as string;
        if (cachedApiKey && !cachedApiKey.includes("*")) {
          this.state.token = autoToken;
          this.state.apiKey = cachedApiKey;
          this.authService.setAccessToken(cachedApiKey);
          ztoolkit.log(
            "[AuthManager] getTokenKey failed, using cached apiKey:",
            cachedApiKey.substring(0, 10) + "...",
          );
          return;
        }
        // No cached key — cannot proceed, log warning
        ztoolkit.log(
          "[AuthManager] getTokenKey failed and no cached apiKey available",
        );
        if (legacyToken) {
          const legacyApiKey = await this.fetchAndSavePluginTokenKey(
            legacyToken,
            "getLegacyTokenKey",
          );
          if (legacyApiKey) {
            ztoolkit.log(
              "[AuthManager] Falling back to legacy plugin token:",
              legacyApiKey.substring(0, 10) + "...",
            );
          }
        }
        return;
      }

      // forceRefresh 只删除 auto token。旧版本默认分组 token 保留作回滚兜底。
      if (autoToken && forceRefresh) {
        ztoolkit.log("[AuthManager] Force refresh: deleting old auto token");
        await this.withSessionRetry(
          () => this.authService.deleteToken(autoToken.id),
          "deleteOldAutoToken",
        );
      } else if (legacyToken) {
        ztoolkit.log(
          "[AuthManager] Found legacy plugin token, creating auto token",
        );
      }
    }

    const autoApiKey = await this.createAndSavePluginToken(
      buildPluginTokenCreateRequest(),
      findActiveAutoPluginToken,
      "createAutoToken",
      "getAutoTokenKey",
    );
    if (autoApiKey) {
      ztoolkit.log(
        "[AuthManager] Auto plugin token created and saved:",
        autoApiKey.substring(0, 10) + "...",
      );
      return;
    }

    if (legacyToken && !forceRefresh) {
      ztoolkit.log(
        "[AuthManager] Auto token unavailable, falling back to legacy token",
      );
      const legacyApiKey = await this.fetchAndSavePluginTokenKey(
        legacyToken,
        "getLegacyTokenKey",
      );
      if (legacyApiKey) {
        return;
      }
    }

    const legacyCreateApiKey = await this.createAndSavePluginToken(
      buildLegacyPluginTokenCreateRequest(),
      findLegacyPluginToken,
      "createLegacyToken",
      "getLegacyTokenKey",
    );
    if (legacyCreateApiKey) {
      ztoolkit.log(
        "[AuthManager] Legacy plugin token created and saved:",
        legacyCreateApiKey.substring(0, 10) + "...",
      );
      return;
    }
  }

  /**
   * 获取模型列表并设置默认模型
   * 在登录成功后调用，确保使用服务端支持的模型
   * 如果已选模型不可用，自动切换到下一个可用模型并通知用户
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
      // Fetch models, ratios, and tier routing metadata in parallel.
      const [response] = await Promise.all([
        fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
        }),
        fetchPaperchatRatios(),
        fetchPaperchatRoutingMeta(),
      ]);

      if (!response.ok) {
        ztoolkit.log("[AuthManager] Failed to fetch models:", response.status);
        return;
      }

      const result = (await response.json()) as {
        data?: Array<{ id: string }>;
      };

      if (result.data && Array.isArray(result.data)) {
        const allModels = result.data.map((m) => m.id).sort();
        // Cache ALL models (embedding models are read from cache by RAG)
        setPref("paperchatModelsCache", JSON.stringify(allModels));
        // Filter out embedding models for chat model selection
        const chatModels = allModels.filter((m) => !isEmbeddingModel(m));
        ztoolkit.log(
          "[AuthManager] Chat models:",
          chatModels.length,
          "/ total:",
          allModels.length,
        );

        if (chatModels.length > 0) {
          const providerManager = getProviderManager();
          const tierState = parseTierState(
            getPref("paperchatTierState") as string | undefined,
          );
          const repaired = validateTierState(
            tierState,
            chatModels,
            getModelRatios(),
            undefined,
            getModelRoutingMeta(),
          );

          setPref("paperchatTierState", JSON.stringify(repaired));
          const resolvedDefaultModel = resolveSelectedTierModel(
            repaired,
            chatModels,
            getModelRatios(),
            undefined,
            getModelRoutingMeta(),
          ).modelId;
          providerManager.updateProviderConfig("paperchat", {
            defaultModel: resolvedDefaultModel || undefined,
            availableModels: chatModels,
          });
        }
      }
    } catch (e) {
      ztoolkit.log("[AuthManager] Failed to fetch models:", e);
    }
  }

  /**
   * Start periodic model list refresh (every 1 hour)
   */
  private startModelRefreshTimer(): void {
    this.stopModelRefreshTimer();
    this.modelRefreshTimer = setInterval(() => {
      if (this.state.isLoggedIn) {
        ztoolkit.log("[AuthManager] Periodic model refresh");
        this.fetchAndSetDefaultModel().catch((e) => {
          ztoolkit.log("[AuthManager] Periodic model refresh failed:", e);
        });
      }
    }, MODEL_REFRESH_INTERVAL_MS);
  }

  /**
   * Stop periodic model list refresh
   */
  private stopModelRefreshTimer(): void {
    if (this.modelRefreshTimer) {
      clearInterval(this.modelRefreshTimer);
      this.modelRefreshTimer = null;
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
      // 刷新用户信息以获取新余额和可能变更的 group。
      await this.refreshUserInfo();
      // 兑换后可能被扩展服务升级 group；重新拉模型列表让新权限立即生效。
      await this.fetchAndSetDefaultModel();

      const afterQuota = this.state.user?.quota || 0;
      const addedQuota = afterQuota - beforeQuota;

      return {
        success: true,
        message: getString("api-success-redeem", {
          args: { amount: AuthService.formatQuota(addedQuota) },
        }),
        addedQuota,
      };
    }

    return {
      success: false,
      message:
        result.message ||
        getString("api-error-redeem-failed", { args: { status: "" } }),
    };
  }

  async listPaperChatProducts(): Promise<PaperChatProductsResult> {
    return this.withSessionRetry(
      () => this.authService.listPaperChatProducts(),
      "listPaperChatProducts",
    );
  }

  async createPaperChatOrder(sku: string): Promise<PaperChatOrderResult> {
    return this.withSessionRetry(
      () => this.authService.createPaperChatOrder(sku),
      "createPaperChatOrder",
    );
  }

  async getPaperChatOrder(orderId: string): Promise<PaperChatOrderResult> {
    return this.withSessionRetry(
      () => this.authService.getPaperChatOrder(orderId),
      "getPaperChatOrder",
    );
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
      // 先用本地缓存通知UI，然后异步刷新最新数据
      if (this.state.user && this.state.isLoggedIn) {
        ztoolkit.log("[AuthManager] Using locally cached user info first");
        // 通知UI更新（先用缓存数据）
        this.notifyLoginStatusChange(true);
        this.notifyUserInfoUpdate(this.state.user);
        this.notifyBalanceUpdate(
          this.state.user.quota,
          this.state.user.used_quota,
        );
      }

      // 尝试从API刷新最新用户信息（session cookie 由 Services.cookies 管理）
      await this.refreshUserInfo();
      if (this.state.isLoggedIn) {
        await this.ensurePluginToken();
        // Refresh model list on startup (non-blocking — don't delay UI registration)
        this.fetchAndSetDefaultModel().catch((e) => {
          ztoolkit.log("[AuthManager] Startup model refresh failed:", e);
        });
        this.syncLocalLanguagePreference().catch((e) => {
          ztoolkit.log("[AuthManager] Startup language sync failed:", e);
        });
        // Start periodic refresh
        this.startModelRefreshTimer();
        ztoolkit.log("[AuthManager] Session restored and refreshed via API");
      } else {
        ztoolkit.log("[AuthManager] Failed to restore session from API");
      }
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
    this.stopModelRefreshTimer();
  }
}

// 全局单例
let authManager: AuthManager | null = null;
let isAuthManagerDestroyed = false;

export function getAuthManager(): AuthManager {
  if (isAuthManagerDestroyed) {
    ztoolkit.log(
      "[AuthManager] Warning: Accessing destroyed AuthManager, recreating...",
    );
    isAuthManagerDestroyed = false;
  }
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
  isAuthManagerDestroyed = true;
}

export function isAuthManagerAvailable(): boolean {
  return authManager !== null && !isAuthManagerDestroyed;
}
