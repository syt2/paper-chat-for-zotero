/**
 * AuthService - 用户认证服务
 *
 * 与NewAPI后端交互，处理用户登录、注册、Token管理等
 * 使用Zotero.HTTP.request来正确处理cookie
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

// API基础URL - 从ProviderManager获取
const DEFAULT_API_BASE = BUILTIN_PROVIDERS.pdfaitalk.website!;

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
   * 从 Gorilla securecookie 格式的 session 中解析用户ID
   * Session 格式: 整个 cookie 是 base64 编码的，解码后为 timestamp|gob_data|signature
   * GOB data 包含 map[string]interface{} 结构，其中 "id" 字段是用户ID
   */
  parseUserIdFromSession(sessionValue: string): number | null {
    try {
      // 整个 cookie 是 base64 编码的，需要先解码
      // 使用 atob 解码 base64 (需要处理 URL-safe base64)
      const normalizedBase64 = sessionValue
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      // 添加填充
      const padded =
        normalizedBase64 + "=".repeat((4 - (normalizedBase64.length % 4)) % 4);

      let fullDecoded: string;
      try {
        fullDecoded = atob(padded);
      } catch {
        ztoolkit.log("[AuthService] Failed to decode base64 session cookie");
        return null;
      }

      ztoolkit.log("[AuthService] Decoded session length:", fullDecoded.length);

      // 解码后的格式: timestamp|gob_data|signature
      const parts = fullDecoded.split("|");
      ztoolkit.log("[AuthService] Session parts count:", parts.length);

      if (parts.length < 2) {
        ztoolkit.log(
          "[AuthService] Invalid session format after decode - not enough parts",
        );
        return null;
      }

      // 第二部分是 GOB 编码的数据（可能还有一层 base64）
      let gobData = parts[1];

      // 尝试再次 base64 解码 GOB 数据
      try {
        const normalizedGob = gobData.replace(/-/g, "+").replace(/_/g, "/");
        const paddedGob =
          normalizedGob + "=".repeat((4 - (normalizedGob.length % 4)) % 4);
        gobData = atob(paddedGob);
        ztoolkit.log("[AuthService] GOB data decoded, length:", gobData.length);
      } catch {
        // GOB 数据可能不是 base64 编码的，直接使用
        ztoolkit.log("[AuthService] GOB data is not base64, using raw");
      }

      // 在 GOB 数据中查找 "id" 字段
      // GOB map 中的 string key 格式: 长度字节 + 字符串内容
      // 查找 "\x02id" (长度2 + "id") 模式

      // 方法1: 查找 "\x02id" 后面的整数值
      const idIndex = gobData.indexOf("\x02id");
      if (idIndex !== -1) {
        ztoolkit.log("[AuthService] Found 'id' field at index:", idIndex);
        // "id" 后面应该是类型标记和值
        // 跳过 "\x02id" (3字节) 后找整数
        const afterId = idIndex + 3;
        // GOB int 格式: 类型标记 + 值
        // 对于小整数，通常是 \x03int\x04\x02\x00\x?? 格式
        for (let i = afterId; i < Math.min(afterId + 15, gobData.length); i++) {
          const byte = gobData.charCodeAt(i);
          // 查找合理的用户 ID 值 (通常是 1-1000000)
          if (byte >= 2 && byte <= 127) {
            const nextByte = gobData.charCodeAt(i + 1);
            // 检查下一个字节是否是字符串长度标记 (8=username, 4=role, 6=status, 5=group)
            if (nextByte >= 4 && nextByte <= 20) {
              ztoolkit.log("[AuthService] Parsed userId from session:", byte);
              return byte;
            }
          }
        }
      }

      // 方法2: 查找 pending_user_id 字段
      const pendingIndex = gobData.indexOf("pending_user_id");
      if (pendingIndex !== -1) {
        ztoolkit.log(
          "[AuthService] Found 'pending_user_id' field at index:",
          pendingIndex,
        );
        const afterPending = pendingIndex + 15;
        for (
          let i = afterPending;
          i < Math.min(afterPending + 15, gobData.length);
          i++
        ) {
          const byte = gobData.charCodeAt(i);
          if (byte >= 2 && byte <= 127) {
            const nextByte = gobData.charCodeAt(i + 1);
            if (nextByte >= 2 && nextByte <= 20) {
              ztoolkit.log(
                "[AuthService] Parsed userId from pending_user_id:",
                byte,
              );
              return byte;
            }
          }
        }
      }

      // 方法3: 在整个数据中搜索可能的 userId 模式
      // 格式通常是: ...string...\x02id\x03int\x04\x02\x00VALUE\x08username...
      for (let offset = 0; offset < gobData.length - 10; offset++) {
        // 查找 "id" 字符串 (不带长度前缀)
        if (
          gobData.charAt(offset) === "i" &&
          gobData.charAt(offset + 1) === "d"
        ) {
          // 检查前一个字节是否是长度 2
          if (offset > 0 && gobData.charCodeAt(offset - 1) === 2) {
            // 找到了 "\x02id"
            for (
              let i = offset + 2;
              i < Math.min(offset + 15, gobData.length);
              i++
            ) {
              const byte = gobData.charCodeAt(i);
              if (byte >= 1 && byte <= 127) {
                const nextByte = gobData.charCodeAt(i + 1);
                // 检查是否是合理的下一个字段长度
                if (nextByte >= 4 && nextByte <= 20) {
                  ztoolkit.log("[AuthService] Parsed userId (method 3):", byte);
                  return byte;
                }
              }
            }
          }
        }
      }

      ztoolkit.log("[AuthService] Could not parse userId from session cookie");
      return null;
    } catch (e) {
      ztoolkit.log("[AuthService] Error parsing session cookie:", e);
      return null;
    }
  }

  /**
   * 从 CookieSandbox 提取 session cookie
   * 用于在登录后保存 cookie 到 prefs
   */
  extractSessionCookie(): string | null {
    if (!this._cookieSandbox) return null;

    try {
      // 访问 CookieSandbox 内部的 _cookies 存储
      const cookies = (this._cookieSandbox as any)._cookies;
      if (!cookies) return null;

      ztoolkit.log(
        "[AuthService] CookieSandbox _cookies:",
        JSON.stringify(cookies),
      );

      // 查找 session cookie
      // _cookies 结构: { "host": { "path": { "cookieName": { value: "...", secure: bool, hostOnly: bool } } } }
      const host = new URL(this.baseUrl).hostname;
      const hostCookies = cookies[host] || cookies[`.${host}`];
      if (hostCookies) {
        for (const path of Object.keys(hostCookies)) {
          const pathCookies = hostCookies[path];
          if (pathCookies && pathCookies.session) {
            ztoolkit.log(
              "[AuthService] Found session cookie:",
              pathCookies.session,
            );
            // cookie 可能是对象 { value, secure, hostOnly } 或字符串
            const sessionCookie = pathCookies.session;
            if (typeof sessionCookie === "object" && sessionCookie.value) {
              return sessionCookie.value;
            }
            return sessionCookie;
          }
        }
      }

      return null;
    } catch (e) {
      ztoolkit.log("[AuthService] Failed to extract session cookie:", e);
      return null;
    }
  }

  /**
   * 手动设置 session cookie 到 CookieSandbox
   * 用于重启后恢复 session
   */
  restoreSessionCookie(sessionValue: string): void {
    if (!sessionValue) return;

    // 确保 CookieSandbox 已创建
    if (!this._cookieSandbox) {
      // @ts-expect-error - CookieSandbox exists in Zotero but not in types
      this._cookieSandbox = new Zotero.CookieSandbox(null, this.baseUrl);
    }

    try {
      const host = new URL(this.baseUrl).hostname;
      // 使用 setCookie 方法设置 cookie
      const sandbox = this._cookieSandbox as any;
      if (typeof sandbox.setCookie === "function") {
        sandbox.setCookie(`session=${sessionValue}`, host, "/", false, false);
        ztoolkit.log("[AuthService] Session cookie restored to CookieSandbox");
      } else {
        // 直接操作 _cookies 对象
        if (!sandbox._cookies) sandbox._cookies = {};
        if (!sandbox._cookies[host]) sandbox._cookies[host] = {};
        if (!sandbox._cookies[host]["/"]) sandbox._cookies[host]["/"] = {};
        sandbox._cookies[host]["/"].session = sessionValue;
        ztoolkit.log(
          "[AuthService] Session cookie restored directly to _cookies",
        );
      }
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
   * 从响应头提取session token
   */
  private extractSessionFromResponse(xhr: XMLHttpRequest): void {
    try {
      // 尝试多种方式获取 Set-Cookie
      const setCookie =
        xhr.getResponseHeader("Set-Cookie") ||
        xhr.getResponseHeader("set-cookie");

      ztoolkit.log("[AuthService] Trying to extract session from response");
      ztoolkit.log(
        "[AuthService] All response headers:",
        xhr.getAllResponseHeaders(),
      );

      if (setCookie) {
        ztoolkit.log("[AuthService] Set-Cookie header found:", setCookie);
        const sessionMatch = setCookie.match(/session=([^;]+)/);
        if (sessionMatch) {
          this.sessionToken = sessionMatch[1];
          ztoolkit.log(
            "[AuthService] Session token extracted:",
            this.sessionToken,
          );
        }
      } else {
        ztoolkit.log(
          "[AuthService] Set-Cookie header not accessible (browser security restriction)",
        );
        // 由于浏览器安全限制，Set-Cookie 头通常无法通过 JavaScript 读取
        // 但 CookieSandbox 应该会自动处理 cookie 的存储和发送
        // 问题是 Zotero 重启后 CookieSandbox 会丢失
      }
    } catch (e) {
      ztoolkit.log("[AuthService] Error reading Set-Cookie header:", e);
    }
  }

  /**
   * 通用HTTP请求方法 - 使用Zotero.HTTP.request
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

      // 添加用户ID头 - NewAPI要求此头来标识用户
      if (this.userId !== null) {
        headers["New-Api-User"] = String(this.userId);
      }

      // 使用访问令牌进行身份验证 (用于聊天API)
      if (this.accessToken) {
        headers["Authorization"] = `Bearer ${this.accessToken}`;
      }

      // 手动添加session cookie (用于用户管理API)
      // NewAPI的用户管理API需要session cookie认证，不接受API Key
      // Zotero重启后CookieSandbox丢失，需要手动恢复session cookie
      if (this.sessionToken) {
        headers["Cookie"] = `session=${this.sessionToken}`;
        ztoolkit.log(
          "[AuthService] Adding session cookie to request:",
          this.sessionToken.substring(0, 20) + "...",
        );
      } else {
        ztoolkit.log("[AuthService] No session token available for request");
      }

      // 使用Zotero的CookieSandbox来处理cookie
      // 这允许跨域请求自动携带cookie
      if (!this._cookieSandbox) {
        // @ts-expect-error - CookieSandbox exists in Zotero but not in types
        this._cookieSandbox = new Zotero.CookieSandbox(null, this.baseUrl);
      }

      const response = await Zotero.HTTP.request(method, fullUrl, {
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        responseType: "json",
        // 允许处理非2xx响应
        successCodes: false as const,
        cookieSandbox: this._cookieSandbox,
      });

      // 尝试从响应头提取session
      if (options.extractSession) {
        this.extractSessionFromResponse(response);
      }

      const data = response.response as T;
      this.logResponse(method, fullUrl, response.status, data);

      return { status: response.status, data };
    } catch (error: unknown) {
      this.logError(method, fullUrl, error);

      // Zotero.HTTP.request 在非2xx状态码时可能抛出异常
      if (error && typeof error === "object" && "status" in error) {
        const httpError = error as { status: number; response?: unknown };
        const data = httpError.response as T;
        this.logResponse(method, fullUrl, httpError.status, data);
        return { status: httpError.status, data };
      }

      return {
        status: 0,
        data: null,
        error: error instanceof Error ? error.message : "网络错误",
      };
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
          `请求失败: ${result.status}`,
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
          `请求失败: ${result.status}`,
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
          `注册失败: ${result.status}`,
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
          `登录失败: ${result.status}`,
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
        message:
          "此账号启用了两步验证，插件暂不支持两步验证登录，请在网页端关闭两步验证后重试",
      };
    }

    // 从响应中提取用户ID并保存
    // 响应格式: { data: { id: number, username: string, ... }, success: true }
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
          `登出失败: ${result.status}`,
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
          `获取用户信息失败: ${result.status}`,
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
          `获取Token列表失败: ${result.status}`,
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
          `创建Token失败: ${result.status}`,
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
          `删除Token失败: ${result.status}`,
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
          `兑换失败: ${result.status}`,
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
