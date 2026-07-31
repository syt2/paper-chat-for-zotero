/**
 * AuthService - 用户认证服务
 *
 * 与 NewAPI 后端交互，处理用户登录、注册、Token 管理等。
 * 使用 HTTP Observer 捕获 Set-Cookie 响应头，手动管理认证 cookie。
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

const LEGACY_SESSION_COOKIE = "session";
const DASHBOARD_REFRESH_COOKIE = "new_api_refresh";
const LEGACY_SESSION_COOKIE_PATH = "/";
const DASHBOARD_REFRESH_COOKIE_PATH = "/api/user/auth";
const AUTH_COOKIE_NAMES = [
  LEGACY_SESSION_COOKIE,
  DASHBOARD_REFRESH_COOKIE,
] as const;

type AuthCookieName = (typeof AUTH_COOKIE_NAMES)[number];

interface PendingAuthCookie {
  value: string;
  generation: number;
}

interface DashboardAuthData {
  access_token?: string;
  access_expires_at?: number;
  session?: { sid?: string };
  user?: { id?: number };
}

export interface DashboardSessionRefreshResult extends ApiResponse<DashboardAuthData> {
  status: number;
}

function extractSetCookieValue(
  setCookieHeader: string,
  cookieName: AuthCookieName,
): string | null {
  const escapedName = cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = setCookieHeader.match(
    new RegExp(`(?:^|[\\r\\n,]\\s*)${escapedName}=([^;]*)`),
  );
  return match ? match[1] : null;
}

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
  private dashboardRefreshToken: string | null = null;
  private dashboardSessionId: string | null = null;
  private pendingAuthCookies = new Map<AuthCookieName, PendingAuthCookie>();
  private loginAttempt: {
    generation: number;
    promise: Promise<ApiResponse>;
  } | null = null;
  private refreshAttempt: {
    generation: number;
    promise: Promise<DashboardSessionRefreshResult>;
  } | null = null;
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
      observe: (subject: any, topic: string, _data: string) => {
        if (topic !== "http-on-examine-response") return;

        try {
          const channel = subject.QueryInterface(Ci.nsIHttpChannel);
          const url = channel.URI.spec;

          if (!url.startsWith(baseUrl)) return;

          try {
            const setCookie = channel.getResponseHeader("Set-Cookie");
            if (setCookie) {
              for (const cookieName of AUTH_COOKIE_NAMES) {
                const value = extractSetCookieValue(setCookie, cookieName);
                if (value !== null) {
                  this.pendingAuthCookies.set(cookieName, {
                    value,
                    generation,
                  });
                }
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

  hasDashboardAccessToken(): boolean {
    return Boolean(this.dashboardAccessToken);
  }

  hasDashboardRefreshCookie(): boolean {
    return Boolean(this.dashboardRefreshToken);
  }

  hasAuthenticationState(): boolean {
    return Boolean(
      this.sessionToken ||
      this.dashboardAccessToken ||
      this.dashboardRefreshToken,
    );
  }

  /**
   * 清除所有登录状态（包括浏览器 cookie jar）
   */
  clearSessionCookie(): void {
    this.sessionToken = null;
    this.dashboardAccessToken = null;
    this.dashboardRefreshToken = null;
    this.dashboardSessionId = null;
    this.pendingAuthCookies.clear();
    this.removeAuthCookieFromJar(
      LEGACY_SESSION_COOKIE,
      LEGACY_SESSION_COOKIE_PATH,
    );
    this.removeAuthCookieFromJar(
      DASHBOARD_REFRESH_COOKIE,
      DASHBOARD_REFRESH_COOKIE_PATH,
    );
  }

  /**
   * 从浏览器 cookie jar 恢复认证 cookie（用于重启后恢复会话）
   */
  restoreSessionFromCookieJar(): void {
    try {
      const host = new URL(this.baseUrl).hostname;
      const cookies = Services.cookies.getCookiesFromHost(host, {});

      for (const cookie of cookies) {
        if (
          cookie.name === LEGACY_SESSION_COOKIE &&
          cookie.path === LEGACY_SESSION_COOKIE_PATH
        ) {
          this.sessionToken = cookie.value;
        } else if (
          cookie.name === DASHBOARD_REFRESH_COOKIE &&
          cookie.path === DASHBOARD_REFRESH_COOKIE_PATH
        ) {
          this.dashboardRefreshToken = cookie.value;
        }
      }
      ztoolkit.log("[AuthService] Auth cookies restored from cookie jar", {
        legacySession: Boolean(this.sessionToken),
        dashboardRefresh: Boolean(this.dashboardRefreshToken),
      });
    } catch (e) {
      ztoolkit.log(
        "[AuthService] Failed to restore auth cookies from cookie jar:",
        e,
      );
    }
  }

  /**
   * 保存 session 到浏览器 cookie jar（用于持久化）
   */
  saveSessionToCookieJar(): void {
    if (!this.sessionToken) return;

    this.saveAuthCookieToJar(
      LEGACY_SESSION_COOKIE,
      this.sessionToken,
      LEGACY_SESSION_COOKIE_PATH,
      Ci.nsICookie.SAMESITE_LAX as number,
    );
  }

  private saveDashboardRefreshCookieToJar(): void {
    if (!this.dashboardRefreshToken) return;

    this.saveAuthCookieToJar(
      DASHBOARD_REFRESH_COOKIE,
      this.dashboardRefreshToken,
      DASHBOARD_REFRESH_COOKIE_PATH,
      (Ci.nsICookie.SAMESITE_STRICT ?? Ci.nsICookie.SAMESITE_LAX) as number,
    );
  }

  private saveAuthCookieToJar(
    name: AuthCookieName,
    value: string,
    path: string,
    sameSite: number,
  ): void {
    try {
      const url = new URL(this.baseUrl);
      const host = url.hostname;
      const isSecure = url.protocol === "https:";
      // 设置过期时间为 30 天后
      const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

      Services.cookies.add(
        host, // domain
        path,
        name,
        value,
        isSecure, // isSecure
        true, // isHttpOnly
        false, // isSession (false = persistent)
        expiry, // expiry
        {}, // originAttributes
        sameSite,
        Ci.nsICookie.SCHEME_HTTPS, // schemeMap
      );
      ztoolkit.log(`[AuthService] ${name} saved to cookie jar`);
    } catch (e) {
      ztoolkit.log(`[AuthService] Failed to save ${name} to cookie jar:`, e);
    }
  }

  private removeAuthCookieFromJar(name: AuthCookieName, path: string): void {
    try {
      const host = new URL(this.baseUrl).hostname;
      Services.cookies.remove(host, name, path, {});
    } catch {
      // Services 在 Node 测试或 Zotero 关闭期间可能不可用。
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
      extractAuthCookies?: boolean;
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

      const requestPath = new URL(fullUrl).pathname;
      const cookies: string[] = [];
      if (this.sessionToken) {
        cookies.push(`${LEGACY_SESSION_COOKIE}=${this.sessionToken}`);
      }
      // Refresh Cookie 只允许发送给 NewAPI 的 refresh/logout 路径。
      if (
        this.dashboardRefreshToken &&
        (requestPath === DASHBOARD_REFRESH_COOKIE_PATH ||
          requestPath.startsWith(`${DASHBOARD_REFRESH_COOKIE_PATH}/`))
      ) {
        cookies.push(
          `${DASHBOARD_REFRESH_COOKIE}=${this.dashboardRefreshToken}`,
        );
      }
      if (cookies.length > 0) {
        headers["Cookie"] = [headers["Cookie"], ...cookies]
          .filter(Boolean)
          .join("; ");
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

      if (
        options.extractAuthCookies &&
        generation === this.environmentGeneration
      ) {
        this.applyPendingAuthCookies();
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
        if (options.extractAuthCookies) {
          this.applyPendingAuthCookies();
        }
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
   * 应用 HTTP Observer 捕获到的认证 cookie。
   */
  private applyPendingAuthCookies(): void {
    for (const [name, pending] of this.pendingAuthCookies) {
      this.pendingAuthCookies.delete(name);
      if (pending.generation !== this.environmentGeneration) {
        continue;
      }

      if (name === LEGACY_SESSION_COOKIE) {
        this.sessionToken = pending.value || null;
        if (this.sessionToken) {
          this.saveSessionToCookieJar();
        } else {
          this.removeAuthCookieFromJar(
            LEGACY_SESSION_COOKIE,
            LEGACY_SESSION_COOKIE_PATH,
          );
        }
      } else {
        this.dashboardRefreshToken = pending.value || null;
        if (this.dashboardRefreshToken) {
          this.saveDashboardRefreshCookieToJar();
        } else {
          this.removeAuthCookieFromJar(
            DASHBOARD_REFRESH_COOKIE,
            DASHBOARD_REFRESH_COOKIE_PATH,
          );
        }
      }
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
      extractAuthCookies: true,
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
    const pending = this.loginAttempt;
    if (pending?.generation === generation) {
      return pending.promise;
    }

    const promise = this.performLogin(request, generation);
    const attempt = { generation, promise };
    this.loginAttempt = attempt;
    try {
      return await promise;
    } finally {
      if (this.loginAttempt === attempt) {
        this.loginAttempt = null;
      }
    }
  }

  private async performLogin(
    request: LoginRequest,
    generation: number,
  ): Promise<ApiResponse> {
    const url = `${this.baseUrl}/api/user/login`;
    const result = await this.request<ApiResponse>("POST", url, {
      body: request,
      extractAuthCookies: true,
    });

    if (result.error) {
      return {
        success: false,
        message: result.error,
        status: result.status,
      };
    }

    if (result.status >= 400 || !result.data?.success) {
      const errorData = result.data as
        | (ApiResponse & { code?: unknown })
        | null;
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-login-failed", {
            args: { status: result.status },
          }),
        ),
        code: typeof errorData?.code === "string" ? errorData.code : undefined,
        status: result.status,
      };
    }

    if (generation !== this.environmentGeneration) {
      return {
        success: false,
        message: "PaperChat service changed during login",
      };
    }

    // 不支持 2FA
    const responseData = result.data as ApiResponse<
      DashboardAuthData & { id?: number; require_2fa?: boolean }
    >;
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

    const dashboardSessionId = responseData.data?.session?.sid;
    if (typeof dashboardSessionId === "string" && dashboardSessionId.trim()) {
      this.dashboardSessionId = dashboardSessionId.trim();
    }

    return result.data;
  }

  async refreshDashboardSession(): Promise<DashboardSessionRefreshResult> {
    const generation = this.environmentGeneration;
    const pending = this.refreshAttempt;
    if (pending?.generation === generation) {
      return pending.promise;
    }

    const promise = this.performDashboardSessionRefresh(generation);
    const attempt = { generation, promise };
    this.refreshAttempt = attempt;
    try {
      return await promise;
    } finally {
      if (this.refreshAttempt === attempt) {
        this.refreshAttempt = null;
      }
    }
  }

  private async performDashboardSessionRefresh(
    generation: number,
  ): Promise<DashboardSessionRefreshResult> {
    if (!this.dashboardRefreshToken) {
      return {
        success: false,
        message: "No dashboard refresh session",
        status: 0,
      };
    }

    const result = await this.request<ApiResponse<DashboardAuthData>>(
      "POST",
      `${this.baseUrl}/api/user/auth/refresh`,
      {
        headers: this.getDashboardSessionHeaders(),
        extractAuthCookies: true,
      },
    );

    if (generation !== this.environmentGeneration) {
      return {
        success: false,
        message: "PaperChat service changed during session refresh",
        status: 0,
      };
    }

    if (result.error) {
      return { success: false, message: result.error, status: result.status };
    }

    if (result.status >= 400 || !result.data?.success) {
      if (result.status === 401) {
        this.clearDashboardSession();
      }
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-request-failed", {
            args: { status: result.status },
          }),
        ),
        status: result.status,
      };
    }

    const data = result.data.data;
    const accessToken = data?.access_token?.trim();
    const userId = data?.user?.id;
    if (!accessToken || !userId) {
      return {
        success: false,
        message: getString("api-error-request-failed", {
          args: { status: result.status },
        }),
        status: result.status,
      };
    }

    this.dashboardAccessToken = accessToken;
    this.userId = userId;
    const sessionId = data?.session?.sid?.trim();
    if (sessionId) {
      this.dashboardSessionId = sessionId;
    }

    return { ...result.data, status: result.status };
  }

  private getDashboardSessionHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Origin: new URL(this.baseUrl).origin,
    };
    if (this.dashboardSessionId) {
      headers["X-Auth-Session"] = this.dashboardSessionId;
    }
    return headers;
  }

  private clearDashboardSession(): void {
    this.dashboardAccessToken = null;
    this.dashboardRefreshToken = null;
    this.dashboardSessionId = null;
    this.pendingAuthCookies.delete(DASHBOARD_REFRESH_COOKIE);
    this.removeAuthCookieFromJar(
      DASHBOARD_REFRESH_COOKIE,
      DASHBOARD_REFRESH_COOKIE_PATH,
    );
  }

  async logout(): Promise<ApiResponse> {
    const generation = this.environmentGeneration;
    let result = await this.request<ApiResponse>(
      "POST",
      `${this.baseUrl}/api/user/auth/logout`,
      {
        headers: this.getDashboardSessionHeaders(),
        extractAuthCookies: true,
      },
    );
    if (result.status === 404) {
      result = await this.request<ApiResponse>(
        "GET",
        `${this.baseUrl}/api/user/logout`,
      );
    }

    if (generation !== this.environmentGeneration) {
      return {
        success: false,
        message: "PaperChat service changed during logout",
      };
    }

    this.userId = null;
    this.clearSessionCookie();

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
