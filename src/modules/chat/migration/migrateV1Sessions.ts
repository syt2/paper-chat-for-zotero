/**
 * V1 Session Migration - 迁移旧格式 session 到新格式
 *
 * 旧格式: conversations/{itemId}.json
 * 新格式: sessions/{timestamp-uuid}.json
 */

import type {
  ChatSession,
  LegacyChatSession,
  SessionIndex,
  SessionMeta,
} from "../../../types/chat";

// 迁移标记文件名
const MIGRATION_MARKER = ".v2-migrated";

/**
 * 检测是否需要迁移
 */
export async function needsMigration(): Promise<boolean> {
  const dataDir = Zotero.DataDirectory.dir;
  const legacyPath = PathUtils.join(dataDir, "paper-chat", "conversations");
  const newPath = PathUtils.join(dataDir, "paper-chat", "sessions");
  const markerPath = PathUtils.join(newPath, MIGRATION_MARKER);

  // 如果已经有迁移标记，不需要迁移
  if (await IOUtils.exists(markerPath)) {
    return false;
  }

  // 如果有旧格式数据，需要迁移
  if (await IOUtils.exists(legacyPath)) {
    const children = await IOUtils.getChildren(legacyPath);
    const sessionFiles = children.filter(
      (f) => f.endsWith(".json") && !f.endsWith("_index.json"),
    );
    return sessionFiles.length > 0;
  }

  return false;
}

/**
 * 生成新的 session ID
 */
function generateSessionId(): string {
  const timestamp = Date.now();
  const uuid = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${uuid}`;
}

/**
 * 获取 item 的 key
 */
async function getItemKey(itemId: number): Promise<string | null> {
  if (itemId === 0) return null;

  try {
    const item = await Zotero.Items.getAsync(itemId);
    if (item) {
      return item.key;
    }
  } catch {
    // Item 可能已被删除
  }
  return null;
}

/**
 * 转换旧格式 session 为新格式
 */
async function convertLegacySession(
  legacy: LegacyChatSession,
): Promise<ChatSession> {
  const itemKey = await getItemKey(legacy.itemId);

  return {
    id: generateSessionId(),
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    lastActiveItemKey: itemKey,
    messages: legacy.messages,
    contextSummary: legacy.contextSummary,
    contextState: legacy.contextState,
  };
}

/**
 * 构建 session 元数据
 */
function buildSessionMeta(session: ChatSession): SessionMeta {
  let lastMessagePreview = "";
  let lastMessageTime = session.updatedAt || Date.now();

  if (session.messages && session.messages.length > 0) {
    // 从后往前找第一条有内容的消息
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (msg.content && msg.role !== "tool") {
        lastMessagePreview =
          msg.content.substring(0, 50) + (msg.content.length > 50 ? "..." : "");
        lastMessageTime = msg.timestamp || session.updatedAt || Date.now();
        break;
      }
    }
  }

  return {
    id: session.id,
    createdAt: session.createdAt || Date.now(),
    updatedAt: session.updatedAt || Date.now(),
    messageCount: session.messages?.length || 0,
    lastMessagePreview,
    lastMessageTime,
  };
}

/**
 * 执行迁移
 */
export async function migrate(): Promise<{
  success: boolean;
  migratedCount: number;
  errorCount: number;
}> {
  const dataDir = Zotero.DataDirectory.dir;
  const legacyPath = PathUtils.join(dataDir, "paper-chat", "conversations");
  const newPath = PathUtils.join(dataDir, "paper-chat", "sessions");

  let migratedCount = 0;
  let errorCount = 0;

  try {
    // 确保新目录存在
    if (!(await IOUtils.exists(newPath))) {
      await IOUtils.makeDirectory(newPath, { createAncestors: true });
    }

    // 检查旧目录是否存在
    if (!(await IOUtils.exists(legacyPath))) {
      ztoolkit.log(
        "[Migration] Legacy path does not exist, nothing to migrate",
      );
      return { success: true, migratedCount: 0, errorCount: 0 };
    }

    // 获取所有旧 session 文件
    const children = await IOUtils.getChildren(legacyPath);
    const sessionFiles = children.filter(
      (f) => f.endsWith(".json") && !f.endsWith("_index.json"),
    );

    ztoolkit.log(
      `[Migration] Found ${sessionFiles.length} legacy session files`,
    );

    const newSessions: ChatSession[] = [];

    // 转换每个旧 session
    for (const filePath of sessionFiles) {
      try {
        const legacy = (await IOUtils.readJSON(filePath)) as LegacyChatSession;

        // 跳过空 session
        if (!legacy.messages || legacy.messages.length === 0) {
          ztoolkit.log(`[Migration] Skipping empty session: ${filePath}`);
          continue;
        }

        // 转换为新格式
        const newSession = await convertLegacySession(legacy);
        newSessions.push(newSession);

        // 保存新 session 文件
        const newFilePath = PathUtils.join(newPath, `${newSession.id}.json`);
        await IOUtils.writeJSON(newFilePath, newSession);

        migratedCount++;
        ztoolkit.log(
          `[Migration] Migrated session: ${legacy.itemId} -> ${newSession.id}`,
        );
      } catch (error) {
        errorCount++;
        ztoolkit.log(`[Migration] Error migrating ${filePath}:`, error);
      }
    }

    // 创建新索引
    const sessionMetas = newSessions.map(buildSessionMeta);
    sessionMetas.sort((a, b) => b.updatedAt - a.updatedAt);

    const index: SessionIndex = {
      sessions: sessionMetas,
      activeSessionId: sessionMetas.length > 0 ? sessionMetas[0].id : null,
    };

    const indexPath = PathUtils.join(newPath, "session-index.json");
    await IOUtils.writeJSON(indexPath, index);

    // 写入迁移标记
    const markerPath = PathUtils.join(newPath, MIGRATION_MARKER);
    await IOUtils.writeUTF8(
      markerPath,
      JSON.stringify({
        migratedAt: Date.now(),
        migratedCount,
        errorCount,
      }),
    );

    ztoolkit.log(
      `[Migration] Completed. Migrated: ${migratedCount}, Errors: ${errorCount}`,
    );

    return { success: true, migratedCount, errorCount };
  } catch (error) {
    ztoolkit.log("[Migration] Fatal error:", error);
    return { success: false, migratedCount, errorCount };
  }
}

/**
 * 检测并执行迁移
 */
export async function checkAndMigrate(): Promise<void> {
  if (await needsMigration()) {
    ztoolkit.log("[Migration] Legacy data detected, starting migration...");
    await migrate();
  } else {
    ztoolkit.log("[Migration] No migration needed");
  }
}
