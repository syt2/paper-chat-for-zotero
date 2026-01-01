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
  TokenInfo,
  CreateTokenRequest,
  TopUpRequest,
  PaginatedResponse,
} from "../../types/auth";
import { BUILTIN_PROVIDERS } from "../providers/ProviderManager";
import { getString } from "../../utils/locale";

const DEFAULT_API_BASE = BUILTIN_PROVIDERS.paperchat.website!;

// 临时存储从 HTTP Observer 捕获的 session cookie
let pendingSessionCookie: string | null = null;

export class AuthService {
  private baseUrl: string;
  private sessionToken: string | null = null;
  private userId: number | null = null;
  private accessToken: string | null = null;
  private httpObserver: any = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || DEFAULT_API_BASE;
    this.setupHttpObserver();
  }

  /**
   * 设置 HTTP Observer 捕获 Set-Cookie 响应头
   * 由于 Zotero 环境下浏览器 cookie jar 不可用，需要手动捕获
   */
  private setupHttpObserver(): void {
    if (this.httpObserver) return;

    const self = this;
    this.httpObserver = {
      observe(subject: any, topic: string, _data: string) {
        if (topic !== "http-on-examine-response") return;

        try {
          const channel = subject.QueryInterface(Ci.nsIHttpChannel);
          const url = channel.URI.spec;

          if (!url.startsWith(self.baseUrl)) return;

          try {
            const setCookie = channel.getResponseHeader("Set-Cookie");
            if (setCookie?.includes("session=")) {
              const match = setCookie.match(/session=([^;]+)/);
              if (match?.[1]) {
                pendingSessionCookie = match[1];
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
      Services.obs.removeObserver(this.httpObserver, "http-on-examine-response");
      this.httpObserver = null;
    }
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  setUserId(id: number | null): void {
    this.userId = id;
  }

  getUserId(): number | null {
    return this.userId;
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  /**
   * 清除 session（包括浏览器 cookie jar）
   */
  clearSessionCookie(): void {
    this.sessionToken = null;
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
      ztoolkit.log("[AuthService] Failed to restore session from cookie jar:", e);
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
        host,           // domain
        "/",            // path
        "session",      // name
        this.sessionToken, // value
        isSecure,       // isSecure
        true,           // isHttpOnly
        false,          // isSession (false = persistent)
        expiry,         // expiry
        {},             // originAttributes
        Ci.nsICookie.SAMESITE_LAX, // sameSite
        Ci.nsICookie.SCHEME_HTTPS, // schemeMap
      );
      ztoolkit.log("[AuthService] Session saved to cookie jar");
    } catch (e) {
      ztoolkit.log("[AuthService] Failed to save session to cookie jar:", e);
    }
  }

  private logRequest(method: string, url: string, body?: unknown): void {
    ztoolkit.log(`[AuthService] ${method} ${url}`, body ? JSON.stringify(body) : "");
  }

  private logResponse(method: string, url: string, status: number, data: unknown): void {
    ztoolkit.log(`[AuthService] ${method} ${url} -> ${status}`, JSON.stringify(data));
  }

  private logError(method: string, url: string, error: unknown): void {
    ztoolkit.log(`[AuthService] ${method} ${url} ERROR:`, error);
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
      skipAccessToken?: boolean; // 跳过 Authorization header（用于 session-only 接口）
    } = {},
  ): Promise<{ status: number; data: T | null; error?: string }> {
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

      // 只有在不跳过的情况下才发送 accessToken
      if (this.accessToken && !options.skipAccessToken) {
        headers["Authorization"] = `Bearer ${this.accessToken}`;
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
      });

      const data = response.response as T;

      // 登录/注册时从 HTTP Observer 提取 session
      if (options.extractSession) {
        this.extractSessionFromObserver();
      }

      this.logResponse(method, fullUrl, response.status, data);
      return { status: response.status, data };
    } catch (error: unknown) {
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
        error: error instanceof Error ? error.message : getString("api-error-network"),
      };
    }
  }

  /**
   * 从 HTTP Observer 提取 session cookie 并保存到 cookie jar
   */
  private extractSessionFromObserver(): void {
    if (pendingSessionCookie) {
      this.sessionToken = pendingSessionCookie;
      pendingSessionCookie = null;
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
          getString("api-error-request-failed", { args: { status: result.status } }),
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
          getString("api-error-request-failed", { args: { status: result.status } }),
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
          getString("api-error-register-failed", { args: { status: result.status } }),
        ),
      };
    }

    return result.data;
  }

  async login(request: LoginRequest): Promise<ApiResponse> {
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
          getString("api-error-login-failed", { args: { status: result.status } }),
        ),
      };
    }

    // 不支持 2FA
    const responseData = result.data as ApiResponse & {
      data?: { id?: number; require_2fa?: boolean };
    };
    if (responseData.data?.require_2fa) {
      return {
        success: false,
        message: getString("api-error-2fa-not-supported"),
      };
    }

    // 提取用户ID
    if (responseData.data?.id) {
      this.userId = responseData.data.id;
    }

    return result.data;
  }

  async logout(): Promise<ApiResponse> {
    const url = `${this.baseUrl}/api/user/logout`;
    const result = await this.request<ApiResponse>("POST", url);

    this.sessionToken = null;
    this.userId = null;

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-logout-failed", { args: { status: result.status } }),
        ),
      };
    }

    return result.data;
  }

  async getUserInfo(): Promise<ApiResponse<UserInfo>> {
    const url = `${this.baseUrl}/api/user/self`;
    // 这个接口只接受 session cookie 认证，不需要 accessToken
    const result = await this.request<ApiResponse<UserInfo>>("GET", url, { skipAccessToken: true });

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-get-user-failed", { args: { status: result.status } }),
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
    const result = await this.request<ApiResponse<PaginatedResponse<TokenInfo>>>("GET", url);

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-get-tokens-failed", { args: { status: result.status } }),
        ),
      };
    }

    return result.data;
  }

  async createToken(request: CreateTokenRequest): Promise<ApiResponse<string>> {
    const url = `${this.baseUrl}/api/token/`;
    const result = await this.request<ApiResponse<string>>("POST", url, { body: request });

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (result.status >= 400 || !result.data?.success) {
      return {
        success: false,
        message: this.parseErrorMessage(
          result.data,
          getString("api-error-create-token-failed", { args: { status: result.status } }),
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
          getString("api-error-delete-token-failed", { args: { status: result.status } }),
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
          getString("api-error-redeem-failed", { args: { status: result.status } }),
        ),
      };
    }

    return result.data;
  }

  static formatQuota(quota: number): string {
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
