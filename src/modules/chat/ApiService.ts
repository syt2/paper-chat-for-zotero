/**
 * ApiService - OpenAI兼容API调用服务
 *
 * 特点:
 * 1. 支持自定义Base URL (兼容OpenRouter、Azure等)
 * 2. SSE流式响应处理
 * 3. Vision API支持 (图片输入)
 * 4. 错误处理和重试机制
 */

import type {
  ApiConfig,
  ChatMessage,
  OpenAIMessage,
  OpenAIMessageContent,
  StreamCallbacks,
} from "../../types/chat";
import type { PdfAttachment } from "../../types/provider";

export class ApiService {
  private config: ApiConfig;

  constructor(config: ApiConfig) {
    this.config = config;
  }

  /**
   * 更新API配置
   */
  updateConfig(config: Partial<ApiConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 流式聊天完成
   */
  async streamChatCompletion(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    pdfAttachment?: PdfAttachment,
  ): Promise<void> {
    const { onChunk, onComplete, onError } = callbacks;

    if (!this.config.apiKey) {
      onError(new Error("API Key is not configured"));
      return;
    }

    if (!this.config.baseUrl) {
      onError(new Error("API Base URL is not configured"));
      return;
    }

    try {
      const apiMessages = this.formatMessages(messages, pdfAttachment);

      // 添加系统提示
      if (this.config.systemPrompt) {
        apiMessages.unshift({
          role: "system",
          content: this.config.systemPrompt,
        });
      }

      // Build request body
      const requestBody: Record<string, unknown> = {
        model: this.config.model,
        messages: apiMessages,
        temperature: this.config.temperature ?? 0.7,
        stream: true,
      };

      // Only include max_tokens if explicitly set and > 0
      if (this.config.maxTokens && this.config.maxTokens > 0) {
        requestBody.max_tokens = this.config.maxTokens;
      }

      // Log request details
      ztoolkit.log("[ApiService] ========== API Request ==========");
      ztoolkit.log("[ApiService] URL:", `${this.config.baseUrl}/chat/completions`);
      ztoolkit.log("[ApiService] Model:", requestBody.model);
      ztoolkit.log("[ApiService] Max Tokens:", requestBody.max_tokens ?? "(not set, use API default)");
      ztoolkit.log("[ApiService] Temperature:", requestBody.temperature);
      ztoolkit.log("[ApiService] Stream:", requestBody.stream);
      ztoolkit.log("[ApiService] Message count:", apiMessages.length);
      ztoolkit.log("[ApiService] Has PDF attachment:", !!pdfAttachment);
      if (pdfAttachment) {
        ztoolkit.log("[ApiService] PDF name:", pdfAttachment.name, "base64 length:", pdfAttachment.data.length);
      }
      // Log messages structure (without base64 data)
      const messagesForLog = apiMessages.map(m => {
        if (Array.isArray(m.content)) {
          return {
            role: m.role,
            content: m.content.map(c => {
              if (c.type === "document") {
                return { type: "document", source: { type: c.source?.type, media_type: c.source?.media_type, data_length: c.source?.data?.length } };
              } else if (c.type === "image_url") {
                return { type: "image_url", url_length: c.image_url?.url?.length };
              }
              return c;
            }),
          };
        }
        return { role: m.role, content_length: typeof m.content === "string" ? m.content.length : 0 };
      });
      ztoolkit.log("[ApiService] Messages structure:", JSON.stringify(messagesForLog, null, 2));
      ztoolkit.log("[ApiService] ================================");

      const response = await fetch(
        `${this.config.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        },
      );

      ztoolkit.log("[ApiService] Response status:", response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        ztoolkit.log("[ApiService] Error response:", errorText);
        throw new Error(
          `API Error: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      // 处理流式响应
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Response body is not readable");
      }

      const decoder = new TextDecoder();
      let fullContent = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // @ts-expect-error - Zotero's type definitions may differ
        const result = await reader.read();
        if (result.done) break;
        const value = result.value as Uint8Array;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter((line) => line.trim() !== "");

        for (let line of lines) {
          // 移除 'data:' 前缀
          line = line.replace(/^data:\s*/, "");

          if (line === "[DONE]") {
            continue;
          }

          try {
            const data = JSON.parse(line);
            const content = data.choices?.[0]?.delta?.content || "";

            if (content) {
              fullContent += content;
              onChunk(content);
            }
          } catch {
            // 忽略JSON解析错误（对于不完整的块）
          }
        }
      }

      onComplete(fullContent);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * 非流式聊天完成 (备用)
   */
  async chatCompletion(messages: ChatMessage[]): Promise<string> {
    if (!this.config.apiKey || !this.config.baseUrl) {
      throw new Error("API configuration is incomplete");
    }

    const apiMessages = this.formatMessages(messages);

    if (this.config.systemPrompt) {
      apiMessages.unshift({
        role: "system",
        content: this.config.systemPrompt,
      });
    }

    const requestBody: Record<string, unknown> = {
      model: this.config.model,
      messages: apiMessages,
      temperature: this.config.temperature ?? 0.7,
      stream: false,
    };

    if (this.config.maxTokens && this.config.maxTokens > 0) {
      requestBody.max_tokens = this.config.maxTokens;
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || "";
  }

  /**
   * 格式化消息为OpenAI API格式
   * 处理Vision API格式（图片输入）
   * 处理PDF文件上传
   * 过滤掉空内容的消息
   */
  private formatMessages(messages: ChatMessage[], pdfAttachment?: PdfAttachment): OpenAIMessage[] {
    const filteredMessages = messages
      // 过滤掉错误消息（不发送给API）
      .filter((msg) => msg.role !== "error")
      // 过滤掉空内容的消息（除了最后一条assistant消息可以为空）
      .filter((msg, index, arr) => {
        // 如果是最后一条且是assistant角色，允许为空（占位用）
        if (index === arr.length - 1 && msg.role === "assistant") {
          return msg.content.trim() !== ""; // 但实际发送时也过滤掉空的
        }
        // 其他消息必须有内容
        return msg.content && msg.content.trim() !== "";
      });

    return filteredMessages.map((msg, index) => {
      // For the first user message, attach PDF if provided
      const isFirstUserMessage = index === filteredMessages.findIndex(m => m.role === "user");
      const shouldAttachPdf = pdfAttachment && msg.role === "user" && isFirstUserMessage;

      // 如果有图片附件或PDF附件，使用Vision API格式
      if ((msg.images && msg.images.length > 0) || shouldAttachPdf) {
        const content: OpenAIMessageContent[] = [];

        // Add PDF as document content (Anthropic format, supported by new-api)
        if (shouldAttachPdf) {
          content.push({
            type: "document",
            source: {
              type: "base64",
              media_type: pdfAttachment.mimeType,
              data: pdfAttachment.data,
            },
          });
        }

        // Add text
        content.push({ type: "text", text: msg.content });

        // Add images
        if (msg.images) {
          for (const image of msg.images) {
            const imageUrl =
              image.type === "base64"
                ? `data:${image.mimeType};base64,${image.data}`
                : image.data;

            content.push({
              type: "image_url",
              image_url: {
                url: imageUrl,
                detail: "auto",
              },
            });
          }
        }

        return {
          role: msg.role as "user" | "assistant" | "system",
          content,
        };
      }

      // 普通文本消息
      return {
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content,
      };
    });
  }

  /**
   * 测试API连接
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
