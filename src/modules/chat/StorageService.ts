/**
 * StorageService - 对话历史持久化 (旧版，用于迁移兼容)
 *
 * 使用Zotero Profile目录下的JSON文件存储对话历史
 * 使用索引文件缓存元数据，避免频繁读取所有session文件
 *
 * @deprecated 使用 SessionStorageService 替代
 */

import type { LegacyChatSession, StoredSessionMeta } from "../../types/chat";
import { filterValidMessages, getDataPath } from "../../utils/common";

// 使用旧版类型
type ChatSession = LegacyChatSession;

export class StorageService {
  private storagePath: string;
  private initialized: boolean = false;
  private indexCache: StoredSessionMeta[] | null = null;

  constructor() {
    // 存储路径: Zotero Profile/paper-chat-for-zotero/conversations/
    this.storagePath = "";
  }

  /**
   * 初始化存储目录
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // 获取存储目录
      this.storagePath = getDataPath("conversations");

      // 确保目录存在
      if (!(await IOUtils.exists(this.storagePath))) {
        await IOUtils.makeDirectory(this.storagePath, {
          createAncestors: true,
        });
      }

      // 加载或重建索引
      await this.loadOrRebuildIndex();

      this.initialized = true;
      ztoolkit.log("StorageService initialized:", this.storagePath);
    } catch (error) {
      ztoolkit.log("StorageService init error:", error);
      throw error;
    }
  }

  /**
   * 获取索引文件路径
   */
  private getIndexPath(): string {
    return PathUtils.join(this.storagePath, "_index.json");
  }

  /**
   * 获取会话文件路径
   */
  private getSessionPath(itemId: number): string {
    return PathUtils.join(this.storagePath, `${itemId}.json`);
  }

  /**
   * 加载或重建索引
   */
  private async loadOrRebuildIndex(): Promise<void> {
    const indexPath = this.getIndexPath();

    try {
      if (await IOUtils.exists(indexPath)) {
        this.indexCache = (await IOUtils.readJSON(
          indexPath,
        )) as StoredSessionMeta[];
        ztoolkit.log("Index loaded, sessions count:", this.indexCache.length);
        return;
      }
    } catch {
      ztoolkit.log("Index file invalid, rebuilding...");
    }

    // 重建索引
    await this.rebuildIndex();
  }

  /**
   * 重建索引（从所有session文件）
   * 使用并行读取提升性能
   */
  private async rebuildIndex(): Promise<void> {
    const children = await IOUtils.getChildren(this.storagePath);

    // 过滤出session文件（排除索引文件）
    const sessionFiles = children.filter(
      (f) => f.endsWith(".json") && !f.endsWith("_index.json"),
    );

    // 并行读取所有session文件
    const metaPromises = sessionFiles.map(async (filePath) => {
      try {
        const data = (await IOUtils.readJSON(filePath)) as ChatSession;
        return await this.buildSessionMeta(data);
      } catch {
        // 忽略无效的JSON文件
        return null;
      }
    });

    const results = await Promise.all(metaPromises);
    this.indexCache = results.filter(
      (meta): meta is StoredSessionMeta => meta !== null,
    );

    await this.saveIndex();
    ztoolkit.log("Index rebuilt, sessions count:", this.indexCache.length);
  }

  /**
   * 保存索引
   */
  private async saveIndex(): Promise<void> {
    if (!this.indexCache) return;
    const indexPath = this.getIndexPath();
    await IOUtils.writeJSON(indexPath, this.indexCache);
  }

  /**
   * 构建session元数据
   */
  private async buildSessionMeta(
    session: ChatSession,
  ): Promise<StoredSessionMeta> {
    // 获取item名称
    let itemName = "Global Chat";
    if (session.itemId !== 0) {
      try {
        const item = await Zotero.Items.getAsync(session.itemId);
        if (item) {
          if (item.isAttachment()) {
            const parentId = item.parentItemID;
            if (parentId) {
              const parent = await Zotero.Items.getAsync(parentId);
              itemName =
                parent?.getDisplayTitle() ||
                item.attachmentFilename ||
                `Item ${session.itemId}`;
            } else {
              itemName = item.attachmentFilename || `Item ${session.itemId}`;
            }
          } else {
            itemName = item.getDisplayTitle() || `Item ${session.itemId}`;
          }
        } else {
          itemName = `Item ${session.itemId} (deleted)`;
        }
      } catch {
        itemName = `Item ${session.itemId}`;
      }
    }

    // 获取最后一条消息预览
    let lastMessagePreview = "";
    if (session.messages && session.messages.length > 0) {
      const last = session.messages[session.messages.length - 1];
      lastMessagePreview =
        last.content.substring(0, 50) + (last.content.length > 50 ? "..." : "");
    }

    return {
      itemId: session.itemId,
      itemName,
      messageCount: session.messages?.length || 0,
      lastMessagePreview,
      lastUpdated: session.updatedAt,
    };
  }

  /**
   * 更新索引中的单个条目
   */
  private async updateIndexEntry(session: ChatSession): Promise<void> {
    if (!this.indexCache) {
      this.indexCache = [];
    }

    const meta = await this.buildSessionMeta(session);

    // 查找并更新或添加
    const existingIndex = this.indexCache.findIndex(
      (m) => m.itemId === session.itemId,
    );
    if (existingIndex >= 0) {
      this.indexCache[existingIndex] = meta;
    } else {
      this.indexCache.push(meta);
    }

    await this.saveIndex();
  }

  /**
   * 从索引中删除条目
   */
  private async removeIndexEntry(itemId: number): Promise<void> {
    if (!this.indexCache) return;

    this.indexCache = this.indexCache.filter((m) => m.itemId !== itemId);
    await this.saveIndex();
  }

  /**
   * 保存会话
   */
  async saveSession(session: ChatSession): Promise<void> {
    await this.init();

    try {
      const filePath = this.getSessionPath(session.itemId);
      session.updatedAt = Date.now();

      await IOUtils.writeJSON(filePath, session);

      // 更新索引
      await this.updateIndexEntry(session);

      ztoolkit.log("Session saved:", session.itemId);
    } catch (error) {
      ztoolkit.log("Save session error:", error);
      throw error;
    }
  }

  /**
   * 加载会话
   */
  async loadSession(itemId: number): Promise<ChatSession | null> {
    await this.init();

    try {
      const filePath = this.getSessionPath(itemId);

      if (await IOUtils.exists(filePath)) {
        const data = (await IOUtils.readJSON(filePath)) as ChatSession;

        // 过滤无效消息（修复历史数据问题）
        if (data.messages) {
          data.messages = filterValidMessages(data.messages);
        }

        ztoolkit.log("Session loaded:", itemId);
        return data;
      }

      return null;
    } catch (error) {
      ztoolkit.log("Load session error:", error);
      return null;
    }
  }

  /**
   * 删除会话
   */
  async deleteSession(itemId: number): Promise<void> {
    await this.init();

    try {
      const filePath = this.getSessionPath(itemId);

      if (await IOUtils.exists(filePath)) {
        await IOUtils.remove(filePath);

        // 更新索引
        await this.removeIndexEntry(itemId);

        ztoolkit.log("Session deleted:", itemId);
      }
    } catch (error) {
      ztoolkit.log("Delete session error:", error);
      throw error;
    }
  }

  /**
   * 列出所有会话（直接返回缓存的索引）
   */
  async listSessions(): Promise<StoredSessionMeta[]> {
    await this.init();

    // 直接返回缓存的索引，按更新时间排序
    const result = [...(this.indexCache || [])];
    result.sort((a, b) => b.lastUpdated - a.lastUpdated);
    return result;
  }

  /**
   * 清空所有会话
   */
  async clearAll(): Promise<void> {
    await this.init();

    try {
      const children = await IOUtils.getChildren(this.storagePath);

      for (const filePath of children) {
        if (filePath.endsWith(".json")) {
          await IOUtils.remove(filePath);
        }
      }

      // 清空索引缓存
      this.indexCache = [];

      ztoolkit.log("All sessions cleared");
    } catch (error) {
      ztoolkit.log("Clear all sessions error:", error);
      throw error;
    }
  }

  /**
   * 导出会话为JSON字符串
   */
  async exportSession(itemId: number): Promise<string | null> {
    const session = await this.loadSession(itemId);
    if (session) {
      return JSON.stringify(session, null, 2);
    }
    return null;
  }

  /**
   * 导入会话
   */
  async importSession(jsonString: string): Promise<ChatSession | null> {
    try {
      const session = JSON.parse(jsonString) as ChatSession;
      if (session.itemId && session.messages) {
        await this.saveSession(session);
        return session;
      }
      return null;
    } catch {
      return null;
    }
  }
}
