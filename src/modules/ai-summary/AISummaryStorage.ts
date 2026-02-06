/**
 * AISummaryStorage - 持久化存储服务
 *
 * Progress: SQLite (via StorageDatabase)
 * Config & Templates: File-based (paper-chat/ai-summary/)
 */

import type {
  AISummaryConfig,
  AISummaryStoredState,
  AISummaryTemplate,
} from "../../types/ai-summary";
import { DEFAULT_AISUMMARY_CONFIG } from "../../types/ai-summary";
import { getDataPath } from "../../utils/common";
import { getStorageDatabase } from "../chat/db/StorageDatabase";

export class AISummaryStorage {
  private storagePath: string = "";
  private initialized: boolean = false;

  /**
   * 初始化存储服务
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.storagePath = getDataPath("ai-summary");

    // 确保目录存在 (for config & templates)
    if (!(await IOUtils.exists(this.storagePath))) {
      await IOUtils.makeDirectory(this.storagePath, { createAncestors: true });
    }

    // Ensure StorageDatabase is ready
    await getStorageDatabase().ensureInit();

    this.initialized = true;
    ztoolkit.log("[AISummaryStorage] Initialized at:", this.storagePath);
  }

  /**
   * 保存配置 (file-based)
   */
  async saveConfig(config: AISummaryConfig): Promise<void> {
    await this.init();
    const filePath = PathUtils.join(this.storagePath, "config.json");
    const content = JSON.stringify(config, null, 2);
    await IOUtils.writeUTF8(filePath, content);
    ztoolkit.log("[AISummaryStorage] Config saved");
  }

  /**
   * 加载配置 (file-based)
   */
  async loadConfig(): Promise<AISummaryConfig> {
    await this.init();
    const filePath = PathUtils.join(this.storagePath, "config.json");

    try {
      if (await IOUtils.exists(filePath)) {
        const content = await IOUtils.readUTF8(filePath);
        const config = JSON.parse(content) as AISummaryConfig;
        // 合并默认配置（处理新增字段）
        return { ...DEFAULT_AISUMMARY_CONFIG, ...config };
      }
    } catch (error) {
      ztoolkit.log("[AISummaryStorage] Failed to load config:", error);
    }

    return { ...DEFAULT_AISUMMARY_CONFIG };
  }

  /**
   * 保存进度状态 (SQLite)
   */
  async saveProgress(state: AISummaryStoredState): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      await db.queryAsync(
        `INSERT OR REPLACE INTO ai_summary_progress
         (id, progress, pending_item_keys, completed_item_keys, failed_item_keys, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
        [
          JSON.stringify(state.progress),
          JSON.stringify(state.pendingItemKeys),
          JSON.stringify(state.completedItemKeys),
          JSON.stringify(state.failedItemKeys),
          Date.now(),
        ],
      );
    } catch (error) {
      ztoolkit.log("[AISummaryStorage] Failed to save progress:", error);
    }
  }

  /**
   * 加载进度状态 (SQLite)
   */
  async loadProgress(): Promise<AISummaryStoredState | null> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      const rows = (await db.queryAsync(
        "SELECT * FROM ai_summary_progress WHERE id = 1",
      )) || [];

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      return {
        progress: JSON.parse(row.progress),
        pendingItemKeys: JSON.parse(row.pending_item_keys),
        completedItemKeys: JSON.parse(row.completed_item_keys),
        failedItemKeys: JSON.parse(row.failed_item_keys),
      };
    } catch (error) {
      ztoolkit.log("[AISummaryStorage] Failed to load progress:", error);
      return null;
    }
  }

  /**
   * 清除进度状态 (SQLite)
   */
  async clearProgress(): Promise<void> {
    await this.init();

    try {
      const db = await getStorageDatabase().ensureInit();
      await db.queryAsync("DELETE FROM ai_summary_progress WHERE id = 1");
    } catch (error) {
      ztoolkit.log("[AISummaryStorage] Failed to clear progress:", error);
    }
  }

  /**
   * 保存自定义模板 (file-based)
   */
  async saveCustomTemplates(templates: AISummaryTemplate[]): Promise<void> {
    await this.init();
    const filePath = PathUtils.join(this.storagePath, "custom-templates.json");
    const content = JSON.stringify(templates, null, 2);
    await IOUtils.writeUTF8(filePath, content);
  }

  /**
   * 加载自定义模板 (file-based)
   */
  async loadCustomTemplates(): Promise<AISummaryTemplate[]> {
    await this.init();
    const filePath = PathUtils.join(this.storagePath, "custom-templates.json");

    try {
      if (await IOUtils.exists(filePath)) {
        const content = await IOUtils.readUTF8(filePath);
        return JSON.parse(content) as AISummaryTemplate[];
      }
    } catch (error) {
      ztoolkit.log("[AISummaryStorage] Failed to load custom templates:", error);
    }

    return [];
  }
}
