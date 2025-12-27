/**
 * MessageRenderer - Markdown渲染和消息显示
 *
 * 支持:
 * 1. 代码块高亮 (带语言标识)
 * 2. 表格渲染
 * 3. 有序/无序列表
 * 4. 粗体/斜体/链接
 * 5. 引用块
 */

export class MessageRenderer {
  /**
   * Markdown转HTML
   */
  markdownToHtml(markdown: string): string {
    // 首先转义原始HTML，但保护Markdown语法
    let html = this.escapeHtmlPreserveMarkdown(markdown);

    // 代码块处理 (```language\ncode\n```)
    html = html.replace(
      /```(\w+)?\n([\s\S]*?)```/g,
      (_match, lang: string | undefined, code: string) => {
        const langClass = lang ? ` data-lang="${this.escapeHtml(lang)}"` : "";
        const langLabel = lang
          ? `<span class="code-lang">${this.escapeHtml(lang)}</span>`
          : "";
        return `<div class="code-block-wrapper">${langLabel}<pre class="code-block"${langClass}><code>${this.escapeHtml(code.trim())}</code></pre></div>`;
      },
    );

    // 行内代码
    html = html.replace(
      /`([^`]+)`/g,
      '<code class="inline-code">$1</code>',
    );

    // 表格处理
    html = this.parseTable(html);

    // 引用块
    html = html.replace(
      /^> (.+)$/gm,
      '<blockquote class="quote-block">$1</blockquote>',
    );
    // 合并连续的引用块
    html = html.replace(
      /<\/blockquote>\n?<blockquote class="quote-block">/g,
      "<br/>",
    );

    // 标题
    html = html.replace(/^#### (.+)$/gm, '<h4 class="md-h4">$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1 class="md-h1">$1</h1>');

    // 粗体
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

    // 斜体
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/_(.+?)_/g, "<em>$1</em>");

    // 删除线
    html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

    // 有序列表
    html = this.parseOrderedList(html);

    // 无序列表
    html = this.parseUnorderedList(html);

    // 链接
    html = html.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" class="md-link" target="_blank" rel="noopener">$1</a>',
    );

    // 水平线
    html = html.replace(/^---$/gm, '<hr class="md-hr"/>');
    html = html.replace(/^\*\*\*$/gm, '<hr class="md-hr"/>');

    // 换行 (保留段落)
    html = html.replace(/\n\n/g, '</p><p class="md-paragraph">');
    html = html.replace(/\n/g, "<br/>");

    // 包装在段落中
    if (!html.startsWith("<")) {
      html = `<p class="md-paragraph">${html}</p>`;
    }

    return html;
  }

  /**
   * 解析表格
   */
  private parseTable(text: string): string {
    // 匹配Markdown表格
    const tableRegex =
      /\|(.+)\|\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/g;

    return text.replace(tableRegex, (_match, header: string, body: string) => {
      // 解析表头
      const headers = header
        .split("|")
        .map((h: string) => h.trim())
        .filter((h: string) => h);
      const headerHtml = headers
        .map((h: string) => `<th>${this.escapeHtml(h)}</th>`)
        .join("");

      // 解析表体
      const rows = body.trim().split("\n");
      const bodyHtml = rows
        .map((row: string) => {
          const cells = row
            .split("|")
            .map((c: string) => c.trim())
            .filter((c: string) => c !== "");
          return (
            "<tr>" +
            cells.map((c: string) => `<td>${this.escapeHtml(c)}</td>`).join("") +
            "</tr>"
          );
        })
        .join("");

      return `<table class="md-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
    });
  }

  /**
   * 解析无序列表
   */
  private parseUnorderedList(text: string): string {
    // 匹配连续的无序列表项
    const listRegex = /((?:^[-*+] .+$\n?)+)/gm;

    return text.replace(listRegex, (match) => {
      const items = match
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const content = line.replace(/^[-*+] /, "");
          return `<li>${content}</li>`;
        })
        .join("");

      return `<ul class="md-ul">${items}</ul>`;
    });
  }

  /**
   * 解析有序列表
   */
  private parseOrderedList(text: string): string {
    // 匹配连续的有序列表项
    const listRegex = /((?:^\d+\. .+$\n?)+)/gm;

    return text.replace(listRegex, (match) => {
      const items = match
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const content = line.replace(/^\d+\. /, "");
          return `<li>${content}</li>`;
        })
        .join("");

      return `<ol class="md-ol">${items}</ol>`;
    });
  }

  /**
   * HTML转义
   */
  private escapeHtml(text: string): string {
    const escapeMap: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return text.replace(/[&<>"']/g, (char) => escapeMap[char] || char);
  }

  /**
   * 转义HTML但保留Markdown语法
   * 只转义 & 和 < > 中不属于Markdown语法的部分
   */
  private escapeHtmlPreserveMarkdown(text: string): string {
    // 先保护代码块（它们会在后续处理中被单独转义）
    const codeBlocks: string[] = [];
    text = text.replace(/```[\s\S]*?```/g, (match) => {
      codeBlocks.push(match);
      return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    const inlineCodes: string[] = [];
    text = text.replace(/`[^`]+`/g, (match) => {
      inlineCodes.push(match);
      return `__INLINE_CODE_${inlineCodes.length - 1}__`;
    });

    // 转义独立的 & 符号（不是已有的HTML实体）
    text = text.replace(/&(?!(?:amp|lt|gt|quot|#39|#\d+|#x[\da-fA-F]+);)/g, "&amp;");

    // 转义剩余的 < 和 > (非Markdown引用)
    text = text.replace(/<(?![a-zA-Z/])/g, "&lt;");
    text = text.replace(/(?<![a-zA-Z"])>/g, "&gt;");

    // 恢复代码块
    text = text.replace(/__CODE_BLOCK_(\d+)__/g, (_, index) => codeBlocks[parseInt(index)]);
    text = text.replace(/__INLINE_CODE_(\d+)__/g, (_, index) => inlineCodes[parseInt(index)]);

    return text;
  }

  /**
   * 创建用户消息气泡HTML
   */
  createUserMessageHtml(content: string, hasAttachments: boolean = false): string {
    const attachmentBadge = hasAttachments
      ? '<span class="attachment-badge">📎</span>'
      : "";

    return `
      <div class="message-wrapper user-message-wrapper">
        <div class="message-bubble user-bubble">
          ${attachmentBadge}
          <div class="message-content">${this.escapeHtml(content)}</div>
        </div>
      </div>
    `;
  }

  /**
   * 创建AI消息气泡HTML
   */
  createAssistantMessageHtml(content: string): string {
    const renderedContent = this.markdownToHtml(content);

    return `
      <div class="message-wrapper assistant-message-wrapper">
        <div class="message-bubble assistant-bubble">
          <div class="message-content">${renderedContent}</div>
          <button class="copy-btn" title="复制">📋</button>
        </div>
      </div>
    `;
  }

  /**
   * 创建加载中的AI消息气泡
   */
  createLoadingMessageHtml(): string {
    return `
      <div class="message-wrapper assistant-message-wrapper">
        <div class="message-bubble assistant-bubble loading">
          <div class="message-content">
            <span class="typing-indicator">
              <span></span><span></span><span></span>
            </span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * 创建错误消息HTML
   */
  createErrorMessageHtml(error: string): string {
    return `
      <div class="message-wrapper error-message-wrapper">
        <div class="message-bubble error-bubble">
          <div class="message-content">⚠️ ${this.escapeHtml(error)}</div>
        </div>
      </div>
    `;
  }
}
