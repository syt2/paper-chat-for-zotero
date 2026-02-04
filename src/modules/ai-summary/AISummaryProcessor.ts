/**
 * AISummaryProcessor - 处理单个条目
 */

import type {
  AISummaryTemplate,
  AISummaryConfig,
  AISummaryProcessResult,
} from "../../types/ai-summary";
import { getProviderManager } from "../providers";
import { PdfExtractor } from "../chat/PdfExtractor";

export class AISummaryProcessor {
  private pdfExtractor: PdfExtractor;

  constructor() {
    this.pdfExtractor = new PdfExtractor();
  }

  /**
   * 处理单个条目
   */
  async processItem(
    item: Zotero.Item,
    template: AISummaryTemplate,
    config: AISummaryConfig,
    signal?: AbortSignal,
  ): Promise<AISummaryProcessResult> {
    const startTime = Date.now();
    const itemKey = item.key;
    const itemTitle = (item.getField?.("title") as string) || "Untitled";

    try {
      // 检查是否已取消
      if (signal?.aborted) {
        return {
          success: false,
          itemKey,
          itemTitle,
          error: "Processing cancelled",
        };
      }

      // 1. 获取元数据
      const metadata = this.getItemMetadata(item);

      // 2. 提取 PDF 文本（可选）
      let pdfContent: string | undefined;
      if (config.filterHasPdf) {
        pdfContent = await this.extractPdfText(item);
      }

      // 3. 构建 prompt
      const prompt = this.buildPrompt(template, metadata, pdfContent);

      // 4. 调用 AI
      const response = await this.callAI(prompt, template);

      if (!response) {
        return {
          success: false,
          itemKey,
          itemTitle,
          error: "AI returned empty response",
        };
      }

      // 5. 创建笔记
      const noteKey = await this.createNote(item, response, template, config);

      // 6. 添加已处理标签
      if (config.markProcessedTag) {
        item.addTag(config.markProcessedTag);
        await item.saveTx();
      }

      const processingTime = Date.now() - startTime;

      ztoolkit.log(
        `[AISummary] Processed: ${itemTitle} in ${processingTime}ms`,
      );

      return {
        success: true,
        itemKey,
        itemTitle,
        noteKey,
        processingTime,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      ztoolkit.log(`[AISummary] Error processing ${itemTitle}:`, errorMessage);

      return {
        success: false,
        itemKey,
        itemTitle,
        error: errorMessage,
        processingTime: Date.now() - startTime,
      };
    }
  }

  /**
   * 获取条目元数据
   */
  private getItemMetadata(item: Zotero.Item): Record<string, string> {
    const getField = (field: string): string => {
      try {
        return (item.getField?.(field) as string) || "";
      } catch {
        return "";
      }
    };

    // 获取作者
    const creators = item.getCreators?.() || [];
    const authors = creators
      .map((c: { name?: string; firstName?: string; lastName?: string }) =>
        c.name ? c.name : `${c.firstName || ""} ${c.lastName || ""}`.trim(),
      )
      .filter((name) => name.length > 0)
      .join(", ");

    return {
      title: getField("title") || "Untitled",
      authors: authors || "Unknown",
      year: getField("date")?.substring(0, 4) || "",
      abstract: getField("abstractNote") || "",
      doi: getField("DOI") || "",
      url: getField("url") || "",
      publication: getField("publicationTitle") || getField("proceedingsTitle") || "",
    };
  }

  /**
   * 提取 PDF 文本
   */
  private async extractPdfText(item: Zotero.Item): Promise<string | undefined> {
    try {
      // 检查是否有 PDF 附件
      let pdfItem: Zotero.Item | null = null;

      if (item.isPDFAttachment?.()) {
        pdfItem = item;
      } else {
        const attachmentIDs = item.getAttachments?.() || [];
        for (const id of attachmentIDs) {
          const attachment = Zotero.Items.get(id);
          if (attachment?.isPDFAttachment?.()) {
            pdfItem = attachment;
            break;
          }
        }
      }

      if (!pdfItem) {
        return undefined;
      }

      // 提取文本
      const text = await pdfItem.attachmentText;
      if (!text) return undefined;

      // 截取到合理长度（约 10000 字符，避免 token 过多）
      return text.length > 10000 ? text.substring(0, 10000) + "\n...[truncated]" : text;
    } catch (error) {
      ztoolkit.log("[AISummary] Failed to extract PDF text:", error);
      return undefined;
    }
  }

  /**
   * 构建 prompt
   */
  private buildPrompt(
    template: AISummaryTemplate,
    metadata: Record<string, string>,
    pdfContent?: string,
  ): string {
    let prompt = template.prompt;

    // 替换变量
    for (const [key, value] of Object.entries(metadata)) {
      prompt = prompt.replace(new RegExp(`{{${key}}}`, "g"), value);
    }

    // 处理条件块 {{#if xxx}}...{{/if}}
    prompt = prompt.replace(
      /{{#if\s+(\w+)}}([\s\S]*?){{\/if}}/g,
      (_, varName, content) => {
        if (varName === "pdfContent" && pdfContent) {
          return content.replace(/{{pdfContent}}/g, pdfContent);
        }
        if (metadata[varName]) {
          return content.replace(new RegExp(`{{${varName}}}`, "g"), metadata[varName]);
        }
        return "";
      },
    );

    return prompt.trim();
  }

  /**
   * 调用 AI
   */
  private async callAI(
    prompt: string,
    template: AISummaryTemplate,
  ): Promise<string | null> {
    const providerManager = getProviderManager();
    const provider = providerManager.getActiveProvider();

    if (!provider) {
      throw new Error("No active AI provider configured");
    }

    // 构建消息数组，包含系统提示（如果有）
    const messages: {
      id: string;
      role: "user" | "assistant" | "system";
      content: string;
      timestamp: number;
    }[] = [];

    const now = Date.now();

    if (template.systemPrompt) {
      messages.push({
        id: `aisummary-system-${now}`,
        role: "system",
        content: template.systemPrompt,
        timestamp: now,
      });
    }
    messages.push({
      id: `aisummary-user-${now}`,
      role: "user",
      content: prompt,
      timestamp: now,
    });

    // 使用非流式调用
    const response = await provider.chatCompletion(messages);

    return response || null;
  }

  /**
   * 创建笔记
   */
  private async createNote(
    item: Zotero.Item,
    content: string,
    template: AISummaryTemplate,
    config: AISummaryConfig,
  ): Promise<string> {
    const libraryID = Zotero.Libraries.userLibraryID;
    const note = new Zotero.Item("note");
    note.libraryID = libraryID;

    // 构建笔记标题
    let noteTitle = template.noteTitle;
    noteTitle = noteTitle.replace(
      /{{title}}/g,
      (item.getField?.("title") as string) || "Untitled",
    );

    // 构建笔记内容（HTML 格式）
    const htmlContent = this.formatContentAsHtml(noteTitle, content);
    note.setNote(htmlContent);

    // 设置父条目（如果配置为子笔记）
    if (config.noteLocation === "child") {
      // 如果 item 是附件，获取其父条目
      let parentItem: Zotero.Item | null = item;
      if (item.isAttachment?.() && item.parentID) {
        parentItem = Zotero.Items.get(item.parentID) || null;
      }
      if (parentItem) {
        note.parentID = parentItem.id;
      }
    }

    // 保存笔记
    await note.saveTx();

    // 添加标签
    for (const tag of template.tags) {
      note.addTag(tag);
    }
    await note.saveTx();

    ztoolkit.log("[AISummary] Note created:", note.key);

    return note.key;
  }

  /**
   * 格式化内容为 HTML
   */
  private formatContentAsHtml(title: string, content: string): string {
    // 转换 markdown 风格的标题
    let html = content
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>");

    // 包装列表项
    html = html.replace(/(<li>.*<\/li>)+/g, "<ul>$&</ul>");

    // 添加标题
    html = `<h1>${title}</h1><p>${html}</p>`;

    return html;
  }
}
