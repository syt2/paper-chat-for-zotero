/**
 * AISummaryProcessor - 处理单个条目
 */

import type {
  AISummaryTemplate,
  AISummaryConfig,
  AISummaryMode,
  AISummaryProcessResult,
} from "../../types/ai-summary";
import type { ChatMessage, StreamToolCallingCallbacks } from "../../types/chat";
import type { ToolCallingProvider } from "../../types/provider";
import type { ToolCall, ToolDefinition } from "../../types/tool";
import katex from "katex";
import MarkdownIt from "markdown-it";
import { getProviderManager } from "../providers";
import { getString } from "../../utils/locale";
import { getErrorMessage, getItemTitle } from "../../utils/common";
import { getPdfToolManager } from "../chat/pdf-tools";

const DEEP_SUMMARY_TAG = "ai-deep-summary";
const DEEP_SUMMARY_MAX_ITERATIONS = 5;
const PRESERVE_TOKEN_PREFIX = "PAPERCHAT_PRESERVE_";
const PRESERVE_TOKEN_SUFFIX = "_TOKEN";
const summaryMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
});
const DEEP_SUMMARY_TOOL_NAMES = new Set([
  "get_annotations",
  "get_outline",
  "get_page_count",
  "get_pages",
  "get_paper_metadata",
  "get_paper_section",
  "list_sections",
  "search_paper_content",
  "search_with_regex",
]);

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
      // 获取所有附件的标注
      const attachmentIDs = item.getAttachments?.() || [];
      const annotations: Array<{
        type: string;
        text: string;
        comment: string;
        page: number;
      }> = [];

      for (const attachmentID of attachmentIDs) {
        const attachment = Zotero.Items.get(attachmentID);
        if (!attachment) continue;

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
    template: AISummaryTemplate,
    config: AISummaryConfig,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const provider = getProviderManager().getActiveProvider();
    if (!provider) {
      throw new Error("No active AI provider configured");
    }
    if (!provider.isReady()) {
      throw new Error("Active AI provider is not ready");
    }

    if (!isToolCallingProvider(provider)) {
      throw new Error(
        "Deep AI summary requires a provider that supports tool calling",
      );
    }

    const pdfToolManager = getPdfToolManager();
    const itemKey = item.key;
    const previousItemKey = pdfToolManager.getCurrentItemKey();
    pdfToolManager.setCurrentItemKey(itemKey);

    try {
      const tools = pdfToolManager
        .getToolDefinitions(true)
        .filter((tool) => DEEP_SUMMARY_TOOL_NAMES.has(tool.function.name))
        .sort((left, right) =>
          left.function.name.localeCompare(right.function.name),
        );
      const metadata = this.getItemMetadata(item);
      const annotations = config.includeAnnotations
        ? await this.extractAnnotations(item)
        : undefined;
      const locale = Zotero.locale || "en-US";
      const now = Date.now();
      const messages: ChatMessage[] = [
        {
          id: `deep-summary-system-${now}`,
          role: "system",
          content: [
            "You are an expert academic research assistant creating a deep, evidence-grounded paper summary.",
            "Use the available paper-reading tools to inspect the paper before writing the final summary.",
            "Prefer targeted section, page, and search tools. Do not call tools during the final synthesis round.",
            "The final answer must include: overview, research question, method, key findings, limitations, and why the paper matters.",
            `Respond in the language specified by locale code "${locale}".`,
          ].join("\n"),
          timestamp: now,
        },
        {
          id: `deep-summary-user-${now}`,
          role: "user",
          content: [
            "Create a deep summary for this Zotero paper.",
            `Item Key: ${itemKey}`,
            `Title: ${metadata.title}`,
            `Authors: ${metadata.authors}`,
            metadata.year ? `Year: ${metadata.year}` : "",
            metadata.doi ? `DOI: ${metadata.doi}` : "",
            metadata.abstract ? `Abstract:\n${metadata.abstract}` : "",
            annotations ? `User highlights and notes:\n${annotations}` : "",
            "First inspect metadata, outline, sections, pages, or search results as needed. Then produce the final deep summary.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          timestamp: now,
        },
      ];

      for (
        let iteration = 1;
        iteration <= DEEP_SUMMARY_MAX_ITERATIONS;
        iteration++
      ) {
        if (signal?.aborted) {
          throw new Error("Processing cancelled");
        }

        const isFinalRound = iteration === DEEP_SUMMARY_MAX_ITERATIONS;
        const result = await this.callToolRound(
          provider,
          messages,
          tools,
          isFinalRound ? "none" : "auto",
          signal,
        );

        if (!result.toolCalls?.length || isFinalRound) {
          return result.content?.trim() || null;
        }

        messages.push({
          id: `deep-summary-assistant-${Date.now()}-${iteration}`,
          role: "assistant",
          content: result.content || "",
          tool_calls: result.toolCalls,
          timestamp: Date.now(),
        });

        for (const toolCall of result.toolCalls) {
          if (!DEEP_SUMMARY_TOOL_NAMES.has(toolCall.function.name)) {
            messages.push({
              id: `deep-summary-tool-${Date.now()}-${toolCall.id}`,
              role: "tool",
              content: `Error: Tool "${toolCall.function.name}" is not available for deep summary.`,
              tool_call_id: toolCall.id,
              timestamp: Date.now(),
            });
            continue;
          }
          const content = await pdfToolManager.executeToolCall(toolCall);
          messages.push({
            id: `deep-summary-tool-${Date.now()}-${toolCall.id}`,
            role: "tool",
            content: this.compactDeepSummaryToolResult(content),
            tool_call_id: toolCall.id,
            timestamp: Date.now(),
          });
        }
      }

      return null;
    } finally {
      pdfToolManager.setCurrentItemKey(previousItemKey);
    }
  }

  private async callToolRound(
    provider: ToolCallingProvider,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    toolChoice: "auto" | "none",
    signal?: AbortSignal,
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    if (provider.streamChatCompletionWithTools) {
      return this.callStreamingToolRound(
        provider as ToolCallingProvider & {
          streamChatCompletionWithTools: NonNullable<
            ToolCallingProvider["streamChatCompletionWithTools"]
          >;
        },
        messages,
        tools,
        toolChoice,
        signal,
      );
    }

    return provider.chatCompletionWithTools(messages, tools, signal, {
      toolChoice,
    });
  }

  private async callStreamingToolRound(
    provider: ToolCallingProvider & {
      streamChatCompletionWithTools: NonNullable<
        ToolCallingProvider["streamChatCompletionWithTools"]
      >;
    },
    messages: ChatMessage[],
    tools: ToolDefinition[],
    toolChoice: "auto" | "none",
    signal?: AbortSignal,
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let content = "";

    return new Promise((resolve, reject) => {
      const callbacks: StreamToolCallingCallbacks = {
        onTextDelta: (text) => {
          content += text;
        },
        onReasoningDelta: () => {},
        onToolCallStart: ({ index, id, name }) => {
          pendingToolCalls.set(index, { id, name, arguments: "" });
        },
        onToolCallDelta: (index, argumentsDelta) => {
          const toolCall = pendingToolCalls.get(index);
          if (toolCall) {
            toolCall.arguments += argumentsDelta;
          }
        },
        onComplete: () => {
          const toolCalls: ToolCall[] = [...pendingToolCalls.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, toolCall]) => ({
              id: toolCall.id,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: toolCall.arguments,
              },
            }));
          resolve({
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          });
        },
        onError: reject,
      };

      provider
        .streamChatCompletionWithTools(messages, tools, callbacks, signal, {
          toolChoice,
        })
        .catch(reject);
    });
  }

  private compactDeepSummaryToolResult(content: string): string {
    const maxLength = 12000;
    if (content.length <= maxLength) {
      return content;
    }
    return `${content.slice(0, maxLength)}\n\n[Tool result truncated for deep summary; original length: ${content.length} characters]`;
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
    const libraryID = Zotero.Libraries.userLibraryID;
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

function isToolCallingProvider(
  provider: unknown,
): provider is ToolCallingProvider {
  return (
    typeof provider === "object" &&
    provider !== null &&
    "chatCompletionWithTools" in provider &&
    typeof (provider as ToolCallingProvider).chatCompletionWithTools ===
      "function"
  );
}

export function getDeepSummaryTag(): string {
  return DEEP_SUMMARY_TAG;
}
