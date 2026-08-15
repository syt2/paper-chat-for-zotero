/**
 * AISummaryProcessor - 处理单个条目
 */

import type {
  AISummaryTemplate,
  AISummaryConfig,
  AISummaryMode,
  AISummaryProcessResult,
} from "../../types/ai-summary";
import katex from "katex";
import MarkdownIt from "markdown-it";
import { getProviderManager } from "../providers";
import { getString } from "../../utils/locale";
import { getErrorMessage, getItemTitle } from "../../utils/common";
import { getChatManager, showPanelForItem } from "../ui/chat-panel";
import { formatMarkdownForMessageCopy } from "../ui/chat-panel/MarkdownRenderer";
import { runDeepSummaryChat } from "./DeepSummaryChat";

const DEEP_SUMMARY_TAG = "ai-deep-summary";
const PRESERVE_TOKEN_PREFIX = "PAPERCHAT_PRESERVE_";
const PRESERVE_TOKEN_SUFFIX = "_TOKEN";
const summaryMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
});
export class AISummaryProcessor {
  /**
   * 处理单个条目
   */
  async processItem(
    item: Zotero.Item,
    template: AISummaryTemplate,
    config: AISummaryConfig,
    signal?: AbortSignal,
    mode: AISummaryMode = "quick",
  ): Promise<AISummaryProcessResult> {
    const startTime = Date.now();
    const itemKey = item.key;
    const itemTitle = getItemTitle(item);

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

      if (mode === "deep") {
        const response = await this.processDeepItem(
          item,
          template,
          config,
          signal,
        );
        if (!response) {
          return {
            success: false,
            itemKey,
            itemTitle,
            error: "AI returned empty response",
          };
        }
        const noteKey = await this.createNote(
          item,
          response,
          template,
          config,
          mode,
        );
        item.addTag(DEEP_SUMMARY_TAG);
        await item.saveTx();

        return {
          success: true,
          itemKey,
          itemTitle,
          noteKey,
          processingTime: Date.now() - startTime,
        };
      }

      // 1. 获取元数据
      const metadata = this.getItemMetadata(item);

      // 2. 提取 PDF 文本（可选）
      let pdfContent: string | undefined;
      if (config.filterHasPdf) {
        pdfContent = await this.extractPdfText(item);
      }

      // 3. 提取用户标注（可选）
      let annotations: string | undefined;
      if (config.includeAnnotations) {
        annotations = await this.extractAnnotations(item);
      }

      // 4. 构建 prompt
      const prompt = this.buildPrompt(
        template,
        metadata,
        pdfContent,
        annotations,
      );

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
      const noteKey = await this.createNote(
        item,
        response,
        template,
        config,
        mode,
      );

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
      const errorMessage = getErrorMessage(error);
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
      title: getField("title") || getString("untitled"),
      authors: authors || "Unknown",
      year: getField("date")?.substring(0, 4) || "",
      abstract: getField("abstractNote") || "",
      doi: getField("DOI") || "",
      url: getField("url") || "",
      publication:
        getField("publicationTitle") || getField("proceedingsTitle") || "",
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
      return text.length > 10000
        ? text.substring(0, 10000) + "\n...[truncated]"
        : text;
    } catch (error) {
      ztoolkit.log("[AISummary] Failed to extract PDF text:", error);
      return undefined;
    }
  }

  /**
   * 提取用户标注（highlights 和 notes）
   */
  private async extractAnnotations(
    item: Zotero.Item,
  ): Promise<string | undefined> {
    try {
      const attachments = item.isPDFAttachment?.()
        ? [item]
        : (item.getAttachments?.() || [])
            .map((attachmentID) => Zotero.Items.get(attachmentID))
            .filter((attachment): attachment is Zotero.Item => !!attachment);
      const annotations: Array<{
        type: string;
        text: string;
        comment: string;
        page: number;
      }> = [];

      for (const attachment of attachments) {
        const annotationItems = attachment.getAnnotations?.() || [];
        for (const annotation of annotationItems) {
          if (!annotation) continue;

          const annType = annotation.annotationType || "unknown";
          // 只提取 highlight 和 note 类型
          if (annType !== "highlight" && annType !== "note") continue;

          const text = annotation.annotationText || "";
          const comment = annotation.annotationComment || "";

          // 跳过没有内容的标注
          if (!text && !comment) continue;

          let page = 0;
          if (annotation.annotationPosition) {
            try {
              const position = JSON.parse(annotation.annotationPosition);
              page = (position?.pageIndex ?? -1) + 1;
              if (page < 1) page = 0;
            } catch {
              // 忽略解析错误
            }
          }

          annotations.push({ type: annType, text, comment, page });
        }
      }

      if (annotations.length === 0) {
        return undefined;
      }

      // 格式化标注内容
      const formattedAnnotations = annotations.map((ann) => {
        const parts: string[] = [];
        parts.push(`- [${ann.type.toUpperCase()}]`);
        if (ann.page > 0) parts.push(`(Page ${ann.page})`);
        if (ann.text) parts.push(`"${ann.text}"`);
        if (ann.comment) parts.push(`Comment: ${ann.comment}`);
        return parts.join(" ");
      });

      return formattedAnnotations.join("\n");
    } catch (error) {
      ztoolkit.log("[AISummary] Failed to extract annotations:", error);
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
    annotations?: string,
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
        if (varName === "annotations" && annotations) {
          return content.replace(/{{annotations}}/g, annotations);
        }
        if (metadata[varName]) {
          return content.replace(
            new RegExp(`{{${varName}}}`, "g"),
            metadata[varName],
          );
        }
        return "";
      },
    );

    return prompt.trim();
  }

  private async processDeepItem(
    item: Zotero.Item,
    _template: AISummaryTemplate,
    config: AISummaryConfig,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (signal?.aborted) {
      throw new Error("Processing cancelled");
    }

    const metadata = this.getItemMetadata(item);
    const annotations = config.includeAnnotations
      ? await this.extractAnnotations(item)
      : undefined;
    if (signal?.aborted) {
      throw new Error("Processing cancelled");
    }

    const sessionTitle = `${getString("aisummary-task-mode-deep")}: ${metadata.title}`;
    const prompt = [
      "Create a deep, evidence-grounded summary of the paper bound to this chat session.",
      "Use the available paper-reading tools to inspect this paper before writing the final answer. Do not inspect or discuss other library items.",
      "Prefer targeted outline, section, page, annotation, and content-search calls. The final answer must include: overview, research question, method, key findings, limitations, and why the paper matters.",
      `Respond in the language specified by locale code "${Zotero.locale || "en-US"}".`,
      `Item Key: ${item.key}`,
      `Title: ${metadata.title}`,
      `Authors: ${metadata.authors}`,
      metadata.year ? `Year: ${metadata.year}` : "",
      metadata.doi ? `DOI: ${metadata.doi}` : "",
      metadata.abstract ? `Abstract:\n${metadata.abstract}` : "",
      annotations ? `User highlights and notes:\n${annotations}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return runDeepSummaryChat(
      { item, sessionTitle, prompt, signal },
      {
        chatManager: getChatManager(),
        showPanelForItem: (targetItem) =>
          showPanelForItem(targetItem, "ai_summary"),
        formatAssistantMessage: (message) =>
          formatMarkdownForMessageCopy(message.content, {
            evidenceRecords: message.evidence,
          }),
      },
    );
  }

  /**
   * Get language instruction based on Zotero locale
   */
  private getLanguageInstruction(): string {
    const locale = Zotero.locale || "en-US";
    return `IMPORTANT: You MUST respond in the language specified by locale code "${locale}". Write your entire response in that language.`;
  }

  /**
   * 调用 AI (带超时)
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

    // Get language instruction based on Zotero locale
    const languageInstruction = this.getLanguageInstruction();

    // Combine system prompt with language instruction
    const systemContent = template.systemPrompt
      ? `${template.systemPrompt}\n\n${languageInstruction}`
      : languageInstruction;

    messages.push({
      id: `aisummary-system-${now}`,
      role: "system",
      content: systemContent,
      timestamp: now,
    });
    messages.push({
      id: `aisummary-user-${now}`,
      role: "user",
      content: prompt,
      timestamp: now,
    });

    // 使用非流式调用，带超时 (60秒)
    const timeoutMs = 60000;
    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(
        () => reject(new Error("AI request timed out after 60 seconds")),
        timeoutMs,
      );
    });

    const response = await Promise.race([
      provider.chatCompletion(messages),
      timeoutPromise,
    ]);

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
    mode: AISummaryMode = "quick",
  ): Promise<string> {
    const libraryID = item.libraryID || Zotero.Libraries.userLibraryID;
    const note = new Zotero.Item("note");
    note.libraryID = libraryID;

    // 构建笔记标题
    let noteTitle =
      mode === "deep"
        ? `${getString("aisummary-template-deep-prefix")}: {{title}}`
        : template.noteTitle;
    noteTitle = noteTitle.replace(/{{title}}/g, getItemTitle(item));

    // 构建笔记内容（HTML 格式）
    const htmlContent = this.formatContentAsHtml(noteTitle, content);
    note.setNote(htmlContent);

    // 设置父条目（如果配置为子笔记）
    if (config.noteLocation === "child") {
      let parentItem: Zotero.Item | null = null;
      if (item.isAttachment?.()) {
        const parentID = item.parentItemID || item.parentID;
        if (parentID) {
          const candidate = Zotero.Items.get(parentID) || null;
          if (
            candidate &&
            !candidate.isAttachment?.() &&
            !candidate.isNote?.()
          ) {
            parentItem = candidate;
          }
        } else {
          // Zotero attachments cannot own child notes. Keep the summary beside
          // an independent PDF in the same library and collections instead.
          const collections = item.getCollections?.() || [];
          if (collections.length > 0) note.setCollections(collections);
        }
      } else if (!item.isNote?.()) {
        parentItem = item;
      }
      if (parentItem) {
        note.parentID = parentItem.id;
      }
    }

    // 保存笔记
    await note.saveTx();

    // 添加标签
    const noteTags =
      mode === "deep" ? [...template.tags, DEEP_SUMMARY_TAG] : template.tags;
    for (const tag of noteTags) {
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
    // 转义 HTML 特殊字符（防止 XSS）
    const escapeHtml = (text: string): string => {
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };

    // 转义标题
    const safeTitle = escapeHtml(title);

    // 渲染数学公式为 MathML（在 markdown 转换之前），并保护代码片段。
    const { processed, preserved } = this.renderMathInContent(content);

    let html = summaryMarkdown.render(processed);

    // 恢复被保护的内容（代码块 + MathML）
    html = html.replace(
      new RegExp(`${PRESERVE_TOKEN_PREFIX}(\\d+)${PRESERVE_TOKEN_SUFFIX}`, "g"),
      (_, idx) => preserved[parseInt(idx)],
    );

    // 添加标题
    html = `<h1>${safeTitle}</h1>${html}`;

    return html;
  }

  /**
   * 渲染数学公式为 MathML，保护代码块和数学输出不被后续处理破坏
   * 返回处理后的内容和被保护的片段数组
   */
  private renderMathInContent(content: string): {
    processed: string;
    preserved: string[];
  } {
    const preserved: string[] = [];
    let processed = content;

    const preserve = (html: string): string => {
      preserved.push(html);
      return `${PRESERVE_TOKEN_PREFIX}${preserved.length - 1}${PRESERVE_TOKEN_SUFFIX}`;
    };

    // 保护 fenced 代码块
    processed = processed.replace(/```[\s\S]*?```/g, (match) => {
      return preserve(summaryMarkdown.render(match));
    });
    // 保护行内代码
    processed = processed.replace(/`[^`]+`/g, (match) => {
      return preserve(summaryMarkdown.renderInline(match));
    });

    // 转换 \[...\] → $$...$$ 和 \(...\) → $...$
    processed = processed.replace(
      /\\\[([\s\S]*?)\\\]/g,
      (_, math) => `$$${math}$$`,
    );
    processed = processed.replace(/\\\((.*?)\\\)/g, (_, math) => `$${math}$`);

    // 替换 $$...$$ 为 KaTeX MathML（display 模式），先处理双 $
    processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
      const trimmed = (math as string).trim();
      if (!trimmed) return match;
      const mathml = this.renderKatexToMathML(trimmed, true);
      if (!mathml) return match;
      return preserve(mathml);
    });

    // 替换 $...$ 为 KaTeX MathML（inline 模式），不跨行
    processed = processed.replace(/\$([^$\n]+?)\$/g, (match, math) => {
      const trimmed = (math as string).trim();
      if (!trimmed) return match;
      const mathml = this.renderKatexToMathML(trimmed, false);
      if (!mathml) return match;
      return preserve(mathml);
    });

    return { processed, preserved };
  }

  /**
   * 用 KaTeX 将 LaTeX 渲染为 MathML 字符串
   * 返回 null 表示渲染失败
   */
  private renderKatexToMathML(
    content: string,
    displayMode: boolean,
  ): string | null {
    try {
      return katex.renderToString(content, {
        displayMode,
        output: "mathml",
        throwOnError: false,
        strict: false,
      });
    } catch {
      return null;
    }
  }
}

export function getDeepSummaryTag(): string {
  return DEEP_SUMMARY_TAG;
}
