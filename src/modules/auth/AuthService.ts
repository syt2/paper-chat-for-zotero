/**
 * AuthService - 用户认证服务
 *
 * 与 NewAPI 后端交互，处理用户登录、注册、Token 管理等。
 * 使用 Zotero.HTTP.request + CookieSandbox 处理 session cookie。
 *
 * 注意：服务器需配置 nginx proxy_cookie_flags session SameSite=None Secure;
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

// API基础URL - 从ProviderManager获取
const DEFAULT_API_BASE = BUILTIN_PROVIDERS.paperchat.website!;

export class AuthService {
  private baseUrl: string;
  private sessionToken: string | null = null;
  private userId: number | null = null;
  private accessToken: string | null = null;
  private _cookieSandbox: any = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || DEFAULT_API_BASE;
  }

  /**
   * 设置API基础URL
   */
  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  /**
   * 设置会话Token (从cookie获取)
   */
  setSessionToken(token: string | null): void {
    this.sessionToken = token;
  }

  /**
   * 获取会话Token
   */
  getSessionToken(): string | null {
    return this.sessionToken;
  }

  /**
   * 设置用户ID
   */
  setUserId(id: number | null): void {
    this.userId = id;
  }

  /**
   * 获取用户ID
   */
  getUserId(): number | null {
    return this.userId;
  }

  /**
   * 设置访问令牌 (API Key)
   */
  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  /**
   * 获取访问令牌
   */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  /**
   * 重置 CookieSandbox（用于重新登录）
   */
  resetCookieSandbox(): void {
    this._cookieSandbox = null;
  }

  /**
   * 获取当前的 session cookie
   */
  extractSessionCookie(): string | null {
    return this.sessionToken;
  }

  /**
   * 恢复 session cookie 到 CookieSandbox（用于重启后恢复会话）
   */
  restoreSessionCookie(sessionValue: string): void {
    if (!sessionValue) return;

    if (!this._cookieSandbox) {
      // @ts-expect-error - CookieSandbox exists in Zotero but not in types
      this._cookieSandbox = new Zotero.CookieSandbox(null, this.baseUrl);
    }

    try {
      const host = new URL(this.baseUrl).hostname;
      const sandbox = this._cookieSandbox as any;
      if (typeof sandbox.setCookie === "function") {
        sandbox.setCookie(`session=${sessionValue}`, host, "/", false, false);
      } else {
        if (!sandbox._cookies) sandbox._cookies = {};
        if (!sandbox._cookies[host]) sandbox._cookies[host] = {};
        if (!sandbox._cookies[host]["/"]) sandbox._cookies[host]["/"] = {};
        sandbox._cookies[host]["/"].session = sessionValue;
      }
      ztoolkit.log("[AuthService] Session cookie restored");
    } catch (e) {
      ztoolkit.log("[AuthService] Failed to restore session cookie:", e);
    }
  }

  /**
   * 通用请求日志
   */
  private logRequest(method: string, url: string, body?: unknown): void {
    ztoolkit.log(
      `[AuthService] ${method} ${url}`,
      body ? JSON.stringify(body) : "",
    );
  }

  /**
   * 通用响应日志
   */
  private logResponse(
    method: string,
    url: string,
    status: number,
    data: unknown,
  ): void {
    ztoolkit.log(
      `[AuthService] ${method} ${url} -> ${status}`,
      JSON.stringify(data),
    );
  }

  /**
   * 通用错误日志
   */
  private logError(method: string, url: string, error: unknown): void {
    ztoolkit.log(`[AuthService] ${method} ${url} ERROR:`, error);
  }

  /**
   * 解析API错误消息
   */
  private parseErrorMessage(data: unknown, defaultMsg: string): string {
    if (data && typeof data === "object") {
      const resp = data as Record<string, unknown>;
      if (resp.message && typeof resp.message === "string") {
        return resp.message;
      }
      if (resp.error && typeof resp.error === "string") {
        return resp.error;
      }
    }
    return defaultMsg;
  }

  /**
   * 通用 HTTP 请求方法
   * 使用 Zotero.HTTP.request + CookieSandbox 处理认证
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
    const fullUrl = url.startsWith("http") ? url : `${this.baseUrl}${url}`;
    this.logRequest(method, fullUrl, options.body);

    try {
      const headers: Record<string, string> = {
        ...options.headers,
      };

      if (options.body) {
        headers["Content-Type"] = "application/json";
      }

      // NewAPI 用户标识头
      if (this.userId !== null) {
        headers["New-Api-User"] = String(this.userId);
      }

      // API Key 认证（用于聊天 API）
      if (this.accessToken) {
        headers["Authorization"] = `Bearer ${this.accessToken}`;
      }

      // Session cookie 由 CookieSandbox 自动处理
      if (!this._cookieSandbox) {
        // @ts-expect-error - CookieSandbox exists in Zotero but not in types
        this._cookieSandbox = new Zotero.CookieSandbox(null, this.baseUrl);
      }

      const response = await Zotero.HTTP.request(method, fullUrl, {
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        responseType: "json",
        successCodes: false as const,
        cookieSandbox: this._cookieSandbox,
      });

      // 登录/注册时从 CookieSandbox 提取 session
      if (options.extractSession) {
        this.extractSessionFromCookieSandbox();
      }

      const data = response.response as T;
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
   * 从 CookieSandbox 提取 session cookie
   */
  private extractSessionFromCookieSandbox(): void {
    if (!this._cookieSandbox) return;

    try {
      const cookies = (this._cookieSandbox as any)._cookies;
      if (!cookies) return;

      const host = new URL(this.baseUrl).hostname;
      const hostCookies = cookies[host] || cookies[`.${host}`];
      if (hostCookies) {
        for (const path of Object.keys(hostCookies)) {
          const pathCookies = hostCookies[path];
          if (pathCookies?.session) {
            const sessionCookie = pathCookies.session;
            const value = typeof sessionCookie === "object" && sessionCookie.value
              ? sessionCookie.value
              : sessionCookie;
            if (value) {
              this.sessionToken = value;
              ztoolkit.log("[AuthService] Session extracted:", value.substring(0, 20) + "...");
              return;
            }
          }
        }
      }
      ztoolkit.log("[AuthService] No session cookie found");
    } catch (e) {
      ztoolkit.log("[AuthService] Error extracting session:", e);
    }
  }

  /**
   * 发送邮箱验证码
   */
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

  /**
   * 发送重置密码邮件
   */
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

  /**
   * 用户注册
   */
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

  /**
   * 用户登录
   */
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

    // 检查是否需要 2FA - 不支持，返回错误
    const responseData = result.data as ApiResponse & {
      data?: { id?: number; require_2fa?: boolean };
    };
    if (responseData.data?.require_2fa) {
      ztoolkit.log("[AuthService] 2FA required but not supported");
      return {
        success: false,
        message: getString("api-error-2fa-not-supported"),
      };
    }

    // 从响应中提取用户ID并保存
    if (responseData.data?.id) {
      this.userId = responseData.data.id;
      ztoolkit.log("[AuthService] User ID extracted:", this.userId);
    }

    return result.data;
  }

  /**
   * 用户登出
   */
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

  /**
   * 获取当前用户信息
   */
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
          getString("api-error-get-user-failed", { args: { status: result.status } }),
        ),
      };
    }

    return result.data;
  }

  /**
   * 获取用户的所有Token
   */
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
          getString("api-error-get-tokens-failed", { args: { status: result.status } }),
        ),
      };
    }

    return result.data;
  }

  /**
   * 创建新Token
   */
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
          getString("api-error-create-token-failed", { args: { status: result.status } }),
        ),
      };
    }

    return result.data;
  }

  /**
   * 删除Token
   */
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

  /**
   * 兑换充值码
   */
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

  /**
   * 检查登录状态
   */
  async checkLoginStatus(): Promise<boolean> {
    const result = await this.getUserInfo();
    return result.success && !!result.data;
  }

  /**
   * 格式化余额显示 (直接显示token数量，用K/M/B格式)
   */
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
