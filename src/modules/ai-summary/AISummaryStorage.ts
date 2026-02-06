/**
 * AISummaryStorage - 持久化存储服务
 *
 * 存储位置: {dataDir}/paper-chat/ai-summary/
 */

import type {
  AISummaryConfig,
  AISummaryStoredState,
  AISummaryTemplate,
} from "../../types/ai-summary";
import { DEFAULT_AISUMMARY_CONFIG } from "../../types/ai-summary";
import { getDataPath } from "../../utils/common";

export class AISummaryStorage {
  private storagePath: string = "";
  private initialized: boolean = false;

  /**
   * 初始化存储服务
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.storagePath = getDataPath("ai-summary");

    // 确保目录存在
    if (!(await IOUtils.exists(this.storagePath))) {
      await IOUtils.makeDirectory(this.storagePath, { createAncestors: true });
    }

    this.initialized = true;
    ztoolkit.log("[AISummaryStorage] Initialized at:", this.storagePath);
  }

  /**
   * 保存配置
   */
  async saveConfig(config: AISummaryConfig): Promise<void> {
    await this.init();
    const filePath = PathUtils.join(this.storagePath, "config.json");
    const content = JSON.stringify(config, null, 2);
    await IOUtils.writeUTF8(filePath, content);
    ztoolkit.log("[AISummaryStorage] Config saved");
  }

  /**
   * 加载配置
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
   * 保存进度状态
   */
  async saveProgress(state: AISummaryStoredState): Promise<void> {
    await this.init();
    const filePath = PathUtils.join(this.storagePath, "progress.json");
    const content = JSON.stringify(state, null, 2);
    await IOUtils.writeUTF8(filePath, content);
  }

  /**
   * 加载进度状态
   */
  async loadProgress(): Promise<AISummaryStoredState | null> {
    await this.init();
    const filePath = PathUtils.join(this.storagePath, "progress.json");

    try {
      if (await IOUtils.exists(filePath)) {
        const content = await IOUtils.readUTF8(filePath);
        return JSON.parse(content) as AISummaryStoredState;
      }
    } catch (error) {
      ztoolkit.log("[AISummaryStorage] Failed to load progress:", error);
    }

    return null;
  }

  /**
   * 清除进度状态
   */
  async clearProgress(): Promise<void> {
    await this.init();
    const filePath = PathUtils.join(this.storagePath, "progress.json");

    try {
      if (await IOUtils.exists(filePath)) {
        await IOUtils.remove(filePath);
      }
    } catch (error) {
      ztoolkit.log("[AISummaryStorage] Failed to clear progress:", error);
    }
  }

  /**
   * 保存自定义模板
   */
  async saveCustomTemplates(templates: AISummaryTemplate[]): Promise<void> {
    await this.init();
    const filePath = PathUtils.join(this.storagePath, "custom-templates.json");
    const content = JSON.stringify(templates, null, 2);
    await IOUtils.writeUTF8(filePath, content);
  }

  /**
   * 加载自定义模板
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
