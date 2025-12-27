/**
 * Auth Types - 用户认证相关类型定义
 */

/**
 * 登录请求
 */
export interface LoginRequest {
  username: string;
  password: string;
}

/**
 * 注册请求
 */
export interface RegisterRequest {
  username: string;
  password: string;
  email: string;
  verification_code: string;
  aff_code?: string;
}

/**
 * API响应基础结构
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
}

/**
 * 用户信息
 */
export interface UserInfo {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: number;
  status: number;
  quota: number;
  used_quota: number;
  request_count: number;
  group: string;
  aff_code: string;
  inviter_id: number;
  created_time: number;
}

/**
 * Token信息
 */
export interface TokenInfo {
  id: number;
  user_id: number;
  key: string;
  name: string;
  status: number;
  created_time: number;
  accessed_time: number;
  expired_time: number;
  remain_quota: number;
  unlimited_quota: boolean;
  used_quota: number;
  model_limits_enabled: boolean;
  model_limits: string;
  allow_ips: string;
  group: string;
}

/**
 * 创建Token请求
 */
export interface CreateTokenRequest {
  name: string;
  expired_time?: number;
  remain_quota?: number;
  unlimited_quota?: boolean;
  model_limits?: string;
  group?: string;
}

/**
 * 兑换码请求
 */
export interface TopUpRequest {
  key: string;  // 兑换码
}

/**
 * 认证状态
 */
export interface AuthState {
  isLoggedIn: boolean;
  user: UserInfo | null;
  token: TokenInfo | null;
  apiKey: string | null;
  sessionToken: string | null;
  userId: number | null;
}

/**
 * 分页响应
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
}
