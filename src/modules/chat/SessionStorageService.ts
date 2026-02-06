/**
 * SessionStorageService - 独立 Session 存储服务
 *
 * 职责:
 * 1. 文件系统存储: {dataDir}/paper-chat/sessions/
 * 2. 索引管理: session-index.json
 * 3. CRUD 操作
 * 4. 空 session 自动清理
 * 5. 最大 1000 session 限制
 * 6. 索引损坏自动恢复
 */

import type { ChatSession, SessionIndex, SessionMeta } from "../../types/chat";
import { filterValidMessages, getDataPath, generateShortId } from "../../utils/common";

// 最大 session 数量限制
const MAX_SESSIONS = 1000;

export class SessionStorageService {
  private storagePath: string = "";
  private initialized: boolean = false;
  private indexCache: SessionIndex | null = null;

  /**
   * 初始化存储目录
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // 获取存储目录
      this.storagePath = getDataPath("sessions");

      // 确保目录存在
      if (!(await IOUtils.exists(this.storagePath))) {
        await IOUtils.makeDirectory(this.storagePath, {
          createAncestors: true,
        });
      }

      // 加载或重建索引
      await this.loadOrRebuildIndex();

      this.initialized = true;
      ztoolkit.log("SessionStorageService initialized:", this.storagePath);
    } catch (error) {
      ztoolkit.log("SessionStorageService init error:", error);
      throw error;
    }
  }

  /**
   * 获取索引文件路径
   */
  private getIndexPath(): string {
    return PathUtils.join(this.storagePath, "session-index.json");
  }

  /**
   * 获取 session 文件路径
   */
  private getSessionPath(sessionId: string): string {
    return PathUtils.join(this.storagePath, `${sessionId}.json`);
  }

  /**
   * 加载或重建索引
   */
  private async loadOrRebuildIndex(): Promise<void> {
    const indexPath = this.getIndexPath();

    try {
      if (await IOUtils.exists(indexPath)) {
        this.indexCache = (await IOUtils.readJSON(indexPath)) as SessionIndex;
        ztoolkit.log(
          "Session index loaded, sessions count:",
          this.indexCache.sessions.length,
        );
        return;
      }
    } catch {
      ztoolkit.log("Session index file invalid, rebuilding...");
    }

    // 重建索引
    await this.rebuildIndexFromFiles();
  }

  /**
   * 从文件重建索引
   */
  async rebuildIndexFromFiles(): Promise<void> {
    const children = await IOUtils.getChildren(this.storagePath);

    // 过滤出 session 文件（排除索引文件）
    const sessionFiles = children.filter(
      (f) => f.endsWith(".json") && !f.endsWith("session-index.json"),
    );

    // 并行读取所有 session 文件
    const metaPromises = sessionFiles.map(async (filePath) => {
      try {
        const data = (await IOUtils.readJSON(filePath)) as ChatSession;
        return this.buildSessionMeta(data);
      } catch {
        // 忽略无效的 JSON 文件
        return null;
      }
    });

    const results = await Promise.all(metaPromises);
    const sessions = results.filter(
      (meta): meta is SessionMeta => meta !== null,
    );

    // 按更新时间排序
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);

    this.indexCache = {
      sessions,
      activeSessionId: sessions.length > 0 ? sessions[0].id : null,
    };

    await this.saveIndex();
    ztoolkit.log("Session index rebuilt, sessions count:", sessions.length);
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
   * 构建 session 元数据
   */
  private buildSessionMeta(session: ChatSession): SessionMeta {
    // 获取最后一条消息预览
    let lastMessagePreview = "";
    let lastMessageTime = session.updatedAt || Date.now();

    if (session.messages && session.messages.length > 0) {
      // 从后往前找第一条有内容的消息（跳过 tool 消息和空消息）
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const msg = session.messages[i];
        if (msg.content && msg.role !== "tool") {
          lastMessagePreview =
            msg.content.substring(0, 50) +
            (msg.content.length > 50 ? "..." : "");
          lastMessageTime = msg.timestamp || session.updatedAt || Date.now();
          break;
        }
      }
    }

    return {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages?.length || 0,
      lastMessagePreview,
      lastMessageTime,
    };
  }

  /**
   * 更新索引中的单个条目
   */
  private async updateIndexEntry(session: ChatSession): Promise<void> {
    if (!this.indexCache) {
      this.indexCache = { sessions: [], activeSessionId: null };
    }

    const meta = this.buildSessionMeta(session);

    // 查找并更新或添加
    const existingIndex = this.indexCache.sessions.findIndex(
      (m) => m.id === session.id,
    );
    if (existingIndex >= 0) {
      this.indexCache.sessions[existingIndex] = meta;
    } else {
      this.indexCache.sessions.push(meta);
    }

    // 按更新时间排序
    this.indexCache.sessions.sort((a, b) => b.updatedAt - a.updatedAt);

    await this.saveIndex();
  }

  /**
   * 从索引中删除条目
   */
  private async removeIndexEntry(sessionId: string): Promise<void> {
    if (!this.indexCache) return;

    this.indexCache.sessions = this.indexCache.sessions.filter(
      (m) => m.id !== sessionId,
    );

    // 如果删除的是活动 session，切换到最近的
    if (this.indexCache.activeSessionId === sessionId) {
      this.indexCache.activeSessionId =
        this.indexCache.sessions.length > 0
          ? this.indexCache.sessions[0].id
          : null;
    }

    await this.saveIndex();
  }

  /**
   * 生成新的 session ID (timestamp-uuid 格式)
   */
  private generateSessionId(): string {
    return `${Date.now()}-${generateShortId()}`;
  }

  /**
   * 创建新 session
   */
  async createSession(): Promise<ChatSession> {
    await this.init();

    const sessionId = this.generateSessionId();
    const now = Date.now();

    const session: ChatSession = {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      lastActiveItemKey: null,
      messages: [],
    };

    // 保存 session 文件
    await this.saveSession(session);

    // 设置为活动 session
    await this.setActiveSession(sessionId);

    ztoolkit.log("New session created:", sessionId);
    return session;
  }

  /**
   * 保存 session
   */
  async saveSession(session: ChatSession): Promise<void> {
    await this.init();

    try {
      const filePath = this.getSessionPath(session.id);
      session.updatedAt = Date.now();

      await IOUtils.writeJSON(filePath, session);

      // 更新索引
      await this.updateIndexEntry(session);

      // 检查是否超过最大限制
      await this.enforceMaxSessions();

      ztoolkit.log("Session saved:", session.id);
    } catch (error) {
      ztoolkit.log("Save session error:", error);
      throw error;
    }
  }

  /**
   * 加载 session
   */
  async loadSession(sessionId: string): Promise<ChatSession | null> {
    await this.init();

    try {
      const filePath = this.getSessionPath(sessionId);

      if (await IOUtils.exists(filePath)) {
        const data = (await IOUtils.readJSON(filePath)) as ChatSession;

        // 过滤无效消息（修复历史数据问题）
        if (data.messages) {
          data.messages = filterValidMessages(data.messages);
        }

        ztoolkit.log("Session loaded:", sessionId);
        return data;
      }

      return null;
    } catch (error) {
      ztoolkit.log("Load session error:", error);
      return null;
    }
  }

  /**
   * 删除 session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.init();

    try {
      const filePath = this.getSessionPath(sessionId);

      if (await IOUtils.exists(filePath)) {
        await IOUtils.remove(filePath);

        // 更新索引
        await this.removeIndexEntry(sessionId);

        ztoolkit.log("Session deleted:", sessionId);
      }
    } catch (error) {
      ztoolkit.log("Delete session error:", error);
      throw error;
    }
  }

  /**
   * 列出所有 session (返回元数据列表)
   */
  async listSessions(): Promise<SessionMeta[]> {
    await this.init();

    // 直接返回缓存的索引
    return [...(this.indexCache?.sessions || [])];
  }

  /**
   * 获取活动 session
   */
  async getActiveSession(): Promise<ChatSession | null> {
    await this.init();

    const activeId = this.indexCache?.activeSessionId;
    if (!activeId) {
      return null;
    }

    return this.loadSession(activeId);
  }

  /**
   * 获取活动 session ID
   */
  getActiveSessionId(): string | null {
    return this.indexCache?.activeSessionId || null;
  }

  /**
   * 设置活动 session
   */
  async setActiveSession(sessionId: string | null): Promise<void> {
    await this.init();

    if (!this.indexCache) {
      this.indexCache = { sessions: [], activeSessionId: null };
    }

    this.indexCache.activeSessionId = sessionId;
    await this.saveIndex();
  }

  /**
   * 清理空 session (没有消息的 session)
   */
  async cleanupEmptySessions(): Promise<number> {
    await this.init();

    if (!this.indexCache) return 0;

    const emptySessionIds = this.indexCache.sessions
      .filter((meta) => meta.messageCount === 0)
      .map((meta) => meta.id);

    // 保留活动 session，即使它是空的
    const activeId = this.indexCache.activeSessionId;
    const sessionsToDelete = emptySessionIds.filter((id) => id !== activeId);

    for (const sessionId of sessionsToDelete) {
      await this.deleteSession(sessionId);
    }

    ztoolkit.log("Cleaned up empty sessions:", sessionsToDelete.length);
    return sessionsToDelete.length;
  }

  /**
   * 强制执行最大 session 数量限制
   */
  private async enforceMaxSessions(): Promise<void> {
    if (!this.indexCache) return;

    if (this.indexCache.sessions.length <= MAX_SESSIONS) return;

    // 按更新时间排序（最新的在前）
    const sortedSessions = [...this.indexCache.sessions].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );

    // 保留最新的 MAX_SESSIONS 个
    const sessionsToDelete = sortedSessions.slice(MAX_SESSIONS);

    for (const meta of sessionsToDelete) {
      // 不删除活动 session
      if (meta.id === this.indexCache.activeSessionId) continue;
      await this.deleteSession(meta.id);
    }

    ztoolkit.log(
      "Enforced max sessions limit, deleted:",
      sessionsToDelete.length,
    );
  }

  /**
   * 获取或创建活动 session
   * 如果没有活动 session，则创建一个新的
   */
  async getOrCreateActiveSession(): Promise<ChatSession> {
    await this.init();

    let session = await this.getActiveSession();
    if (!session) {
      session = await this.createSession();
    }
    return session;
  }

  /**
   * 检查是否有旧格式数据需要迁移
   */
  async hasLegacyData(): Promise<boolean> {
    const legacyPath = getDataPath("conversations");
    return IOUtils.exists(legacyPath);
  }

  /**
   * 获取旧格式数据目录路径
   */
  getLegacyStoragePath(): string {
    return getDataPath("conversations");
  }
}
