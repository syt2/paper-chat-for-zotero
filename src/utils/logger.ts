/**
 * Logger - 日志级别管理工具
 *
 * 提供分级日志功能，便于控制输出详细程度
 * 默认在开发环境输出所有日志，生产环境仅输出 warn 和 error
 */

import { config } from "../../package.json";

export type LogLevel = "debug" | "info" | "warn" | "error";

// 日志级别优先级
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// 当前最低日志级别（低于此级别的不输出）
let currentLevel: LogLevel = __env__ === "production" ? "warn" : "debug";

const prefix = `[${config.addonName}]`;

/**
 * 设置日志级别
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * 获取当前日志级别
 */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * 检查是否应该输出该级别的日志
 */
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/**
 * Debug 级别日志 - 用于开发调试信息
 * 生产环境默认不输出
 */
export function debug(...args: unknown[]): void {
  if (shouldLog("debug")) {
    ztoolkit.log(prefix, "[DEBUG]", ...args);
  }
}

/**
 * Info 级别日志 - 用于一般性信息
 * 生产环境默认不输出
 */
export function info(...args: unknown[]): void {
  if (shouldLog("info")) {
    ztoolkit.log(prefix, "[INFO]", ...args);
  }
}

/**
 * Warn 级别日志 - 用于警告信息
 * 生产环境会输出
 */
export function warn(...args: unknown[]): void {
  if (shouldLog("warn")) {
    ztoolkit.log(prefix, "[WARN]", ...args);
  }
}

/**
 * Error 级别日志 - 用于错误信息
 * 生产环境会输出
 */
export function error(...args: unknown[]): void {
  if (shouldLog("error")) {
    ztoolkit.log(prefix, "[ERROR]", ...args);
  }
}

/**
 * 统一的 Logger 对象，方便导入使用
 */
export const logger = {
  debug,
  info,
  warn,
  error,
  setLevel: setLogLevel,
  getLevel: getLogLevel,
};
