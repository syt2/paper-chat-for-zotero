/**
 * Common Utilities - 通用工具函数
 *
 * 提供项目中常用的工具函数，避免代码重复
 */

import type { ChatMessage } from "../types/chat";
import { getString } from "./locale";

// ============================================
// 常量定义
// ============================================

/** 插件数据目录名称 */
export const DATA_DIR_NAME = "paper-chat";

// ============================================
// 错误处理
// ============================================

/**
 * 从 unknown 类型的错误中提取错误消息
 * @param error 任意类型的错误对象
 * @returns 错误消息字符串
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================
// ID 生成
// ============================================

/**
 * 生成短 ID（6位）
 * 用于 session ID 等场景
 * @returns 6位随机字符串
 */
export function generateShortId(): string {
  return Math.random().toString(36).substring(2, 8);
}

/**
 * 生成带时间戳的唯一 ID
 * 用于消息 ID 等需要排序的场景
 * @returns 时间戳-随机字符串 格式的 ID
 */
export function generateTimestampId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================
// Zotero Item 相关
// ============================================

/**
 * 获取 Zotero Item 的标题（智能处理附件情况）
 *
 * 如果 item 是附件，优先返回父条目的标题；
 * 如果没有父条目，返回文件名；
 * 对于普通条目，直接返回标题。
 *
 * @param item Zotero Item 对象
 * @returns 标题字符串，如果没有标题则返回"无标题"
 */
export function getItemTitleSmart(item: Zotero.Item): string {
  // 如果是附件，尝试获取父条目的标题
  if (item.isAttachment && item.isAttachment()) {
    const parentID = item.parentItemID;
    if (parentID) {
      const parent = Zotero.Items.get(parentID);
      if (parent) {
        return (
          (parent.getField("title") as string) ||
          item.attachmentFilename ||
          getString("untitled")
        );
      }
    }
    // 没有父条目，返回文件名
    return item.attachmentFilename || getString("untitled");
  }
  // 普通条目，直接返回标题
  return (item.getField("title") as string) || getString("untitled");
}

/**
 * 获取 Zotero Item 的简单标题（不处理附件）
 * @param item Zotero Item 对象
 * @returns 标题字符串，如果没有标题则返回"无标题"
 */
export function getItemTitle(item: Zotero.Item): string {
  return (item.getField?.("title") as string) || getString("untitled");
}

// ============================================
// 消息处理
// ============================================

/**
 * 过滤有效的聊天消息
 * 用于从存储中加载消息时清理无效数据
 *
 * 保留以下消息：
 * - tool 消息：可能有空 content 但包含有效的工具结果
 * - system 消息：系统提示
 * - 带 tool_calls 的 assistant 消息：content 可能为空但有工具调用
 * - 有实际内容的消息
 *
 * @param messages 消息数组
 * @returns 过滤后的消息数组
 */
export function filterValidMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (msg) =>
      msg.role === "tool" ||
      msg.role === "system" ||
      (msg.tool_calls && msg.tool_calls.length > 0) ||
      (msg.content && msg.content.trim() !== ""),
  );
}

// ============================================
// 路径处理
// ============================================

/**
 * 获取插件数据目录路径
 * @param subPath 子路径（可选）
 * @returns 完整路径
 */
export function getDataPath(...subPaths: string[]): string {
  const dataDir = Zotero.DataDirectory.dir;
  return PathUtils.join(dataDir, DATA_DIR_NAME, ...subPaths);
}
