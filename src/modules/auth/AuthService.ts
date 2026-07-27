/**
 * AuthService - 用户认证服务
 *
 * 与 NewAPI 后端交互，处理用户登录、注册、Token 管理等。
 * 使用 HTTP Observer 捕获 Set-Cookie 响应头，手动管理 session cookie。
 */

import type {
  LoginRequest,
  RegisterRequest,
  ApiResponse,
  UserInfo,
  SubscriptionSelfInfo,
  TokenInfo,
  CreateTokenRequest,
  TopUpRequest,
  PaginatedResponse,
} from "../../types/auth";
import { getPaperChatSiteBaseUrl } from "../providers/PaperChatUrls";
import { getString } from "../../utils/locale";
import { NO_RETRY_ON_THROTTLE } from "../../utils/http";

export interface PaperChatProduct {
  sku: string;
  name: string;
  money: string;
  description: string;
  quotaLabel: string | null;
}

export interface PaperChatPurchaseOrder {
  id: string;
  sku: string;
  product: PaperChatProduct;
  status: "pending" | "paid";
  grantStatus: "pending" | "granted" | "failed" | "manual_review";
  qiuPayOutTradeNo: string;
  qiuPayTradeNo: string | null;
  paymentUrl: string | null;
  qrcode: string | null;
  requestedMoney: string;
  payableMoney: string;
  createdAt: string;
  paidAt: string | null;
}

export interface PaperChatProductsResult {
  success: boolean;
  message?: string;
  products: PaperChatProduct[];
}

export interface PaperChatOrderResult {
  success: boolean;
  message?: string;
  order?: PaperChatPurchaseOrder;
}

export interface PaperChatPricingResult extends ApiResponse<
  Array<Record<string, unknown>>
> {
  group_ratio?: Record<string, unknown>;
  usable_group?: Record<string, unknown>;
  auto_groups?: unknown[];
}

// 临时存储从 HTTP Observer 捕获的 session cookie
let pendingSessionCookie: { value: string; generation: number } | null = null;

const SENSITIVE_LOG_FIELDS = new Set([
  "access_token",
  "api_key",
  "authorization",
  "cookie",
  "key",
  "password",
  "refresh_token",
  "session",
  "session_token",
  "token",
  "verification_code",
]);

function stringifyForAuthLog(value: unknown): string {
  try {
    return JSON.stringify(value, (key, nestedValue) =>
      SENSITIVE_LOG_FIELDS.has(
        key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
      )
        ? "[REDACTED]"
        : nestedValue,
    );
  } catch {
    return "[unserializable]";
  }
}

export class AuthService {
  private baseUrl: string;
  private sessionToken: string | null = null;
  private userId: number | null = null;
  private dashboardAccessToken: string | null = null;
  private httpObserver: any = null;
  private environmentGeneration = 0;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || getPaperChatSiteBaseUrl();
    this.setupHttpObserver();
  }

  /**
   * 设置 HTTP Observer 捕获 Set-Cookie 响应头
   * 由于 Zotero 环境下浏览器 cookie jar 不可用，需要手动捕获
   */
  private setupHttpObserver(): void {
    if (typeof Services === "undefined") return;
    if (this.httpObserver) return;

    const baseUrl = this.baseUrl; // 捕获到闭包中
    const generation = this.environmentGeneration;

    this.httpObserver = {
      observe(subject: any, topic: string, _data: string) {
        if (topic !== "http-on-examine-response") return;

        try {
          const channel = subject.QueryInterface(Ci.nsIHttpChannel);
          const url = channel.URI.spec;

          if (!url.startsWith(baseUrl)) return;

          try {
            const setCookie = channel.getResponseHeader("Set-Cookie");
            if (setCookie?.includes("session=")) {
              const match = setCookie.match(/session=([^;]+)/);
              if (match?.[1]) {
                pendingSessionCookie = { value: match[1], generation };
              }
            }
          } catch {
            // 没有 Set-Cookie 头
          }
        } catch {
          // 忽略错误
        }
      },
    };

    Services.obs.addObserver(this.httpObserver, "http-on-examine-response");
  }

  /**
   * 清理资源
   */
  destroy(): void {
    if (this.httpObserver) {
      if (typeof Services !== "undefined") {
        Services.obs.removeObserver(
          this.httpObserver,
          "http-on-examine-response",
        );
      }
      this.httpObserver = null;
    }
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  setBaseUrl(baseUrl: string): void {
    if (this.baseUrl === baseUrl) {
      return;
    }
    if (this.httpObserver) {
      if (typeof Services !== "undefined") {
        Services.obs.removeObserver(
          this.httpObserver,
          "http-on-examine-response",
        );
      }
      this.httpObserver = null;
    }
    this.environmentGeneration += 1;
    this.baseUrl = baseUrl;
    this.setupHttpObserver();
  }

  setUserId(id: number | null): void {
    this.userId = id;
  }

  getUserId(): number | null {
    return this.userId;
  }

  setDashboardAccessToken(token: string | null): void {
    this.dashboardAccessToken = token;
  }

  /**
   * 清除 session（包括浏览器 cookie jar）
   */
  clearSessionCookie(): void {
    this.sessionToken = null;
    this.dashboardAccessToken = null;
    pendingSessionCookie = null;

    // 从浏览器 cookie jar 中删除
    try {
      const host = new URL(this.baseUrl).hostname;
      Services.cookies.remove(host, "session", "/", {});
    } catch {
      // 忽略错误
    }
  }

  /**
   * 从浏览器 cookie jar 恢复 session（用于重启后恢复会话）
   */
  restoreSessionFromCookieJar(): void {
    try {
      const host = new URL(this.baseUrl).hostname;
      const cookies = Services.cookies.getCookiesFromHost(host, {});

      for (const cookie of cookies) {
        if (cookie.name === "session") {
          this.sessionToken = cookie.value;
          ztoolkit.log("[AuthService] Session restored from cookie jar");
          return;
        }
      }
      ztoolkit.log("[AuthService] No session cookie found in cookie jar");
    } catch (e) {
      ztoolkit.log(
        "[AuthService] Failed to restore session from cookie jar:",
        e,
      );
    }
  }

  /**
   * 保存 session 到浏览器 cookie jar（用于持久化）
   */
  saveSessionToCookieJar(): void {
    if (!this.sessionToken) return;

    try {
      const url = new URL(this.baseUrl);
      const host = url.hostname;
      const isSecure = url.protocol === "https:";
      // 设置过期时间为 30 天后
      const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

      Services.cookies.add(
        host, // domain
        "/", // path
        "session", // name
        this.sessionToken, // value
        isSecure, // isSecure
        true, // isHttpOnly
        false, // isSession (false = persistent)
        expiry, // expiry
        {}, // originAttributes
        Ci.nsICookie.SAMESITE_LAX as number, // sameSite
        Ci.nsICookie.SCHEME_HTTPS, // schemeMap
      );
      ztoolkit.log("[AuthService] Session saved to cookie jar");
    } catch (e) {
      ztoolkit.log("[AuthService] Failed to save session to cookie jar:", e);
    }
  }

  private logRequest(method: string, url: string, body?: unknown): void {
    ztoolkit.log(
      `[AuthService] ${method} ${url}`,
      body ? stringifyForAuthLog(body) : "",
    );
  }

  private logResponse(
    method: string,
    url: string,
    status: number,
    data: unknown,
  ): void {
    ztoolkit.log(
      `[AuthService] ${method} ${url} -> ${status}`,
      stringifyForAuthLog(data),
    );
  }

  private logError(method: string, url: string, error: unknown): void {
    ztoolkit.log(
      `[AuthService] ${method} ${url} ERROR:`,
      error instanceof Error ? error.message : stringifyForAuthLog(error),
    );
  }

  private parseErrorMessage(data: unknown, defaultMsg: string): string {
    if (data && typeof data === "object") {
      const resp = data as Record<string, unknown>;
      if (resp.message && typeof resp.message === "string") return resp.message;
      if (resp.error && typeof resp.error === "string") return resp.error;
    }
    return defaultMsg;
  }

  /**
   * 通用 HTTP 请求方法
   */
  private async request<T>(
    method: string,
    url: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      extractSession?: boolean;
    } = {},
  ): Promise<{ status: number; data: T | null; error?: string }> {
    const generation = this.environmentGeneration;
    const fullUrl = url.startsWith("http") ? url : `${this.baseUrl}${url}`;
    this.logRequest(method, fullUrl, options.body);

    try {
      const headers: Record<string, string> = { ...options.headers };

      if (options.body) {
        headers["Content-Type"] = "application/json";
      }

      if (this.userId !== null) {
        headers["New-Api-User"] = String(this.userId);
      }

      if (this.dashboardAccessToken) {
        headers["Authorization"] = `Bearer ${this.dashboardAccessToken}`;
      }

      // 手动添加 session cookie（Zotero 环境下浏览器 cookie jar 不可用）
      if (this.sessionToken) {
        headers["Cookie"] = `session=${this.sessionToken}`;
      }

      const response = await Zotero.HTTP.request(method, fullUrl, {
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        responseType: "json",
        successCodes: false as const,
        // Quota errors must reach the UI immediately for its own handling.
        ...NO_RETRY_ON_THROTTLE,
      });

      if (generation !== this.environmentGeneration) {
        return {
          status: 0,
          data: null,
          error: "PaperChat service changed during request",
        };
      }

      const data = response.response as T;

      // 登录/注册时从 HTTP Observer 提取 session
      if (options.extractSession && generation === this.environmentGeneration) {
        this.extractSessionFromObserver();
      }

      this.logResponse(method, fullUrl, response.status, data);
      return { status: response.status, data };
    } catch (error: unknown) {
      if (generation !== this.environmentGeneration) {
        return {
          status: 0,
          data: null,
          error: "PaperChat service changed during request",
        };
      }
      this.logError(method, fullUrl, error);

      if (error && typeof error === "object" && "status" in error) {
        const httpError = error as { status: number; response?: unknown };
        const data = httpError.response as T;
        this.logResponse(method, fullUrl, httpError.status, data);
        return { status: httpError.status, data };
      }

      return {
        status: 0,
        data: null,
        error:
          error instanceof Error
            ? error.message
            : getString("api-error-network"),
      };
    }
  }

  /**
   * 从 HTTP Observer 提取 session cookie 并保存到 cookie jar
   */
  private extractSessionFromObserver(): void {
    const pending = pendingSessionCookie;
    pendingSessionCookie = null;
    if (pending?.generation === this.environmentGeneration) {
      this.sessionToken = pending.value;
      // 保存到 cookie jar 以便重启后恢复
      this.saveSessionToCookieJar();
    }
  }

  async sendVerificationCode(email: string): Promise<ApiResponse> {
    const url = `${this.baseUrl}/api/verification?email=${encodeURIComponent(email)}`;
    const result = await this.request<ApiResponse>("GET", url);

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-request-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return result.data;
  }

  async resetPassword(email: string): Promise<ApiResponse> {
    const url = `${this.baseUrl}/api/reset_password?email=${encodeURIComponent(email)}`;
    const result = await this.request<ApiResponse>("GET", url);

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-request-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return result.data;
  }

  async register(request: RegisterRequest): Promise<ApiResponse> {
    const url = `${this.baseUrl}/api/user/register`;
    const result = await this.request<ApiResponse>("POST", url, {
      body: request,
      extractSession: true,
    });

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-register-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return result.data;
  }

  async login(request: LoginRequest): Promise<ApiResponse> {
    const generation = this.environmentGeneration;
    const url = `${this.baseUrl}/api/user/login`;
    const result = await this.request<ApiResponse>("POST", url, {
      body: request,
      extractSession: true,
    });

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-login-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    if (generation !== this.environmentGeneration) {
      return {
        success: false,
        message: "PaperChat service changed during login",
      };
    }

    // 不支持 2FA
    const responseData = result.data as ApiResponse & {
      data?: {
        id?: number;
        access_token?: string;
        require_2fa?: boolean;
        user?: { id?: number };
      };
    };
    if (responseData.data?.require_2fa) {
      return {
        success: false,
        message: getString("api-error-2fa-not-supported"),
      };
    }

    // 提取用户ID
    const userId = responseData.data?.id ?? responseData.data?.user?.id;
    if (userId) {
      this.userId = userId;
    }

    const dashboardAccessToken = responseData.data?.access_token;
    if (
      typeof dashboardAccessToken === "string" &&
      dashboardAccessToken.trim()
    ) {
      this.dashboardAccessToken = dashboardAccessToken.trim();
    }

    return result.data;
  }

  async logout(): Promise<ApiResponse> {
    const generation = this.environmentGeneration;
    let result = await this.request<ApiResponse>(
      "POST",
      `${this.baseUrl}/api/user/auth/logout`,
    );
    if (result.status === 404) {
      result = await this.request<ApiResponse>(
        "POST",
        `${this.baseUrl}/api/user/logout`,
      );
    }

    if (generation !== this.environmentGeneration) {
      return {
        success: false,
        message: "PaperChat service changed during logout",
      };
    }

    this.sessionToken = null;
    this.userId = null;
    this.dashboardAccessToken = null;

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-logout-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return result.data;
  }

  async getUserInfo(): Promise<ApiResponse<UserInfo>> {
    const url = `${this.baseUrl}/api/user/self`;
    const result = await this.request<ApiResponse<UserInfo>>("GET", url);

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-get-user-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return result.data;
  }

  async getSubscriptionSelf(): Promise<ApiResponse<SubscriptionSelfInfo>> {
    const url = `${this.baseUrl}/api/subscription/self`;
    const result = await this.request<ApiResponse<SubscriptionSelfInfo>>(
      "GET",
      url,
    );

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-request-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return result.data;
  }

  async updateUserLanguage(language: string): Promise<ApiResponse> {
    const url = `${this.baseUrl}/api/user/self`;
    const result = await this.request<ApiResponse>("PUT", url, {
      body: { language },
    });

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-request-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return result.data;
  }

  async getPricing(): Promise<PaperChatPricingResult> {
    const url = `${this.baseUrl}/api/pricing`;
    const result = await this.request<PaperChatPricingResult>("GET", url);

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          `Failed to fetch pricing: HTTP ${result.status}`,
        ),
      };
    }

    return result.data;
  }

  async getCheckinStatus(month: string): Promise<{
    success: boolean;
    enabled: boolean;
    checkedInToday: boolean;
    checkinCount: number;
    message?: string;
  }> {
    const url = `${this.baseUrl}/api/user/checkin?month=${encodeURIComponent(month)}`;
    const result = await this.request<{
      success: boolean;
      data: {
        enabled: boolean;
        stats: { checked_in_today: boolean; total_checkins: number };
      };
    }>("GET", url);

    if (result.error) {
      return {
        success: false,
        enabled: false,
        checkedInToday: false,
        checkinCount: 0,
        message: result.error,
      };
    }
    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        enabled: false,
        checkedInToday: false,
        checkinCount: 0,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-get-user-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }
    return {
      success: true,
      enabled: result.data.data.enabled,
      checkedInToday: result.data.data.stats.checked_in_today,
      checkinCount: result.data.data.stats.total_checkins,
    };
  }

  async doCheckin(): Promise<{
    success: boolean;
    message?: string;
    quotaAwarded?: number;
  }> {
    const url = `${this.baseUrl}/api/user/checkin`;
    const result = await this.request<{
      success: boolean;
      message: string;
      data: { checkin_date: string; quota_awarded: number };
    }>("POST", url);

    if (result.error) {
      return { success: false, message: result.error };
    }
    return {
      success: result.data?.success ?? false,
      message: result.data?.message,
      quotaAwarded: result.data?.data?.quota_awarded,
    };
  }

  async getTokenKey(id: number): Promise<ApiResponse<{ key: string }>> {
    const url = `${this.baseUrl}/api/token/${id}/key`;
    const result = await this.request<ApiResponse<{ key: string }>>(
      "POST",
      url,
    );

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-get-token-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return result.data;
  }

  async getTokens(
    page: number = 0,
    pageSize: number = 10,
  ): Promise<ApiResponse<PaginatedResponse<TokenInfo>>> {
    const url = `${this.baseUrl}/api/token/?p=${page}&page_size=${pageSize}`;
    const result = await this.request<
      ApiResponse<PaginatedResponse<TokenInfo>>
    >("GET", url);

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-get-tokens-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return result.data;
  }

  async createToken(request: CreateTokenRequest): Promise<ApiResponse<string>> {
    const url = `${this.baseUrl}/api/token/`;
    const result = await this.request<ApiResponse<string>>("POST", url, {
      body: request,
    });

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-create-token-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return result.data;
  }

  async deleteToken(tokenId: number): Promise<ApiResponse> {
    const url = `${this.baseUrl}/api/token/${tokenId}`;
    const result = await this.request<ApiResponse>("DELETE", url);

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-delete-token-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return result.data;
  }

  async redeemCode(code: string): Promise<ApiResponse> {
    const url = `${this.baseUrl}/api/user/topup`;
    const result = await this.request<ApiResponse>("POST", url, {
      body: { key: code } as TopUpRequest,
    });

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-redeem-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    await this.syncCurrentUserEntitlement();

    return result.data;
  }

  async listPaperChatProducts(): Promise<PaperChatProductsResult> {
    const url = `${this.baseUrl}/ext/paperchat/products`;
    const result = await this.request<{
      success?: boolean;
      message?: string;
      data?: { products?: PaperChatProduct[] };
    }>("GET", url);

    if (result.error) {
      return { success: false, message: result.error, products: [] };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-request-failed", {
            args: { status: result.status },
          }),
        ),
        products: [],
      };
    }

    return {
      success: true,
      products: Array.isArray(result.data.data?.products)
        ? result.data.data.products
        : [],
    };
  }

  async createPaperChatOrder(sku: string): Promise<PaperChatOrderResult> {
    const url = `${this.baseUrl}/ext/paperchat/orders`;
    const result = await this.request<{
      success?: boolean;
      message?: string;
      data?: PaperChatPurchaseOrder;
    }>("POST", url, {
      body: { sku },
    });

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success || !result.data.data) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-request-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return { success: true, order: result.data.data };
  }

  async getPaperChatOrder(orderId: string): Promise<PaperChatOrderResult> {
    const url = `${this.baseUrl}/ext/paperchat/orders/${encodeURIComponent(orderId)}`;
    const result = await this.request<{
      success?: boolean;
      message?: string;
      data?: PaperChatPurchaseOrder;
    }>("GET", url);

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success || !result.data.data) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-request-failed", {
            args: { status: result.status },
          }),
        ),
      };
    }

    return { success: true, order: result.data.data };
  }

  private async syncCurrentUserEntitlement(): Promise<void> {
    try {
      const url = `${this.baseUrl}/ext/entitlements/sync-current-user`;
      const result = await this.request<ApiResponse>("POST", url);

      if (result.error || result.status >= 400) {
        ztoolkit.log(
          "[AuthService] Entitlement sync after topup failed:",
          result.error || result.status,
        );
      }
    } catch (error) {
      ztoolkit.log("[AuthService] Entitlement sync after topup failed:", error);
    }
  }

  static formatQuota(quota: number): string {
    if (!Number.isFinite(quota)) {
      return "0";
    }

    if (quota >= 1_000_000_000_000) {
      return `${(quota / 1_000_000_000_000).toFixed(1)}T`;
    } else if (quota >= 1_000_000_000) {
      return `${(quota / 1_000_000_000).toFixed(1)}B`;
    } else if (quota >= 1_000_000) {
      return `${(quota / 1_000_000).toFixed(1)}M`;
    } else if (quota >= 1_000) {
      return `${(quota / 1_000).toFixed(1)}K`;
    } else {
      return `${quota}`;
    }
  }
}
