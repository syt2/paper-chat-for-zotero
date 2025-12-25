/**
 * ChatSidebar - 聊天侧边栏组件
 *
 * 使用 Zotero.ItemPaneManager.registerSection() 注册
 * 注意: innerHTML用于渲染经过HTML转义处理的Markdown内容
 */

import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { ChatManager, type ChatMessage, type ImageAttachment, type FileAttachment } from "../chat";
import { getAuthManager, AuthService } from "../auth";
import { showAuthDialog } from "./AuthDialog";
import { getProviderManager } from "../providers";

// 全局ChatManager实例
let chatManager: ChatManager | null = null;

/**
 * 获取ChatManager实例
 */
export function getChatManager(): ChatManager {
  if (!chatManager) {
    chatManager = new ChatManager();
  }
  return chatManager;
}

/**
 * 注册聊天侧边栏
 */
export function registerChatSidebar(): void {
  Zotero.ItemPaneManager.registerSection({
    paneID: "pdf-ai-talk-chat",
    pluginID: config.addonID,
    header: {
      l10nID: `${config.addonRef}-chat-sidebar-header`,
      icon: `chrome://${config.addonRef}/content/icons/favicon.svg`,
    },
    sidenav: {
      l10nID: `${config.addonRef}-chat-sidebar-tooltip`,
      icon: `chrome://${config.addonRef}/content/icons/favicon.svg`,
    },
    bodyXHTML: getChatBodyXHTML(),
    onInit: ({ body, item }) => {
      ztoolkit.log("ChatSidebar onInit", item?.id);
    },
    onDestroy: () => {
      ztoolkit.log("ChatSidebar onDestroy");
    },
    onItemChange: ({ item, setEnabled, tabType }) => {
      // 仅在reader标签页中启用
      setEnabled(tabType === "reader");
      return true;
    },
    onRender: ({ body, item }) => {
      // 同步渲染 - 设置初始状态
      if (!item) return;

      const emptyState = body.querySelector("#chat-empty-state") as HTMLElement;
      const chatHistory = body.querySelector("#chat-history") as HTMLElement;

      if (emptyState && chatHistory) {
        // 清空聊天历史显示
        chatHistory.textContent = "";
        chatHistory.appendChild(emptyState);
        emptyState.style.display = "flex";
      }
    },
    onAsyncRender: async ({ body, item }) => {
      if (!item) return;

      const manager = getChatManager();
      const session = await manager.getSession(item);
      manager.setActiveItem(item.id);

      // 获取DOM元素
      const chatHistory = body.querySelector("#chat-history") as HTMLElement;
      const emptyState = body.querySelector("#chat-empty-state") as HTMLElement;
      const messageInput = body.querySelector("#message-input") as HTMLTextAreaElement;
      const sendButton = body.querySelector("#send-button") as HTMLButtonElement;
      const attachPdfCheckbox = body.querySelector("#attach-pdf") as HTMLInputElement;
      const pdfStatus = body.querySelector("#pdf-status") as HTMLElement;
      const uploadImageBtn = body.querySelector("#upload-image") as HTMLButtonElement;
      const uploadFileBtn = body.querySelector("#upload-file") as HTMLButtonElement;
      const useSelectionBtn = body.querySelector("#use-selection") as HTMLButtonElement;
      const clearChatBtn = body.querySelector("#clear-chat") as HTMLButtonElement;
      const attachmentsPreview = body.querySelector("#attachments-preview") as HTMLElement;

      // 设置按钮的本地化标题
      if (uploadImageBtn) uploadImageBtn.title = getString("chat-upload-image");
      if (uploadFileBtn) uploadFileBtn.title = getString("chat-upload-file");
      if (useSelectionBtn) useSelectionBtn.title = getString("chat-use-selection");
      if (clearChatBtn) clearChatBtn.title = getString("chat-clear-chat");

      // 用户栏元素
      const userBar = body.querySelector("#user-bar") as HTMLElement;
      const userNameEl = body.querySelector("#user-name") as HTMLElement;
      const userBalanceEl = body.querySelector("#user-balance") as HTMLElement;
      const userActionBtn = body.querySelector("#user-action-btn") as HTMLButtonElement;

      // 初始化认证管理器
      const authManager = getAuthManager();

      // 更新用户栏显示 (仅PDFAiTalk provider时显示)
      function updateUserBar() {
        if (!userBar || !userNameEl || !userBalanceEl || !userActionBtn) return;

        // 仅当PDFAiTalk provider激活时显示用户栏
        const providerManager = getProviderManager();
        if (providerManager.getActiveProviderId() !== "pdfaitalk") {
          userBar.style.display = "none";
          return;
        }
        userBar.style.display = "flex";

        if (authManager.isLoggedIn()) {
          const user = authManager.getUser();
          userNameEl.textContent = user?.username || "";
          userBalanceEl.textContent = `${getString("user-panel-balance")}: ${authManager.formatBalance()}`;
          userActionBtn.textContent = getString("user-panel-logout-btn");
          userActionBtn.className = "user-action-btn logout-btn";
        } else {
          userNameEl.textContent = getString("user-panel-not-logged-in");
          userBalanceEl.textContent = "";
          userActionBtn.textContent = getString("user-panel-login-btn");
          userActionBtn.className = "user-action-btn login-btn";
        }
      }

      // 用户按钮点击处理
      userActionBtn?.addEventListener("click", async () => {
        if (authManager.isLoggedIn()) {
          // 登出
          await authManager.logout();
          updateUserBar();
        } else {
          // 显示登录对话框
          const success = await showAuthDialog("login");
          if (success) {
            updateUserBar();
          }
        }
      });

      // 设置认证回调以更新余额显示
      authManager.setCallbacks({
        onBalanceUpdate: () => {
          updateUserBar();
        },
        onLoginStatusChange: () => {
          updateUserBar();
        },
      });

      // 设置provider切换回调
      const providerManager = getProviderManager();
      providerManager.setOnProviderChange(() => {
        updateUserBar();
      });

      // 初始化用户栏
      await authManager.initialize();
      updateUserBar();

      // 当前附件状态
      let pendingImages: ImageAttachment[] = [];
      let pendingFiles: FileAttachment[] = [];
      let pendingSelectedText: string | null = null;

      // 检查PDF附件状态
      const hasPdf = await manager.hasPdfAttachment(item);
      if (pdfStatus) {
        pdfStatus.textContent = hasPdf ? "" : getString("chat-no-pdf");
        pdfStatus.style.color = hasPdf ? "#666" : "#999";
      }
      if (attachPdfCheckbox) {
        attachPdfCheckbox.disabled = !hasPdf;
      }

      // 渲染消息的辅助函数
      const renderer = manager.getMessageRenderer();
      const doc = body.ownerDocument!;
      const HTML_NS = "http://www.w3.org/1999/xhtml";

      // 创建HTML元素的辅助函数 (在XHTML环境中需要指定命名空间)
      function createHtmlElement<K extends keyof HTMLElementTagNameMap>(
        tagName: K,
      ): HTMLElementTagNameMap[K] {
        return doc.createElementNS(HTML_NS, tagName) as HTMLElementTagNameMap[K];
      }

      // 直接设置文本内容（不解析HTML，避免XHTML问题）
      function safeSetInnerHTML(element: HTMLElement, html: string): void {
        // 清空元素
        element.textContent = "";

        // 将HTML转换为纯文本显示（移除标签但保留文本）
        // 简单处理：移除HTML标签，保留文本内容
        const plainText = html
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n\n")
          .replace(/<\/div>/gi, "\n")
          .replace(/<\/h[1-6]>/gi, "\n\n")
          .replace(/<\/li>/gi, "\n")
          .replace(/<[^>]*>/g, "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        element.textContent = plainText;
      }

      // 创建消息元素 (使用DOM API而非innerHTML)
      function createMessageElement(msg: ChatMessage): HTMLElement {
        const wrapper = createHtmlElement("div");
        wrapper.className = `message-wrapper ${msg.role}-message-wrapper`;

        const bubble = createHtmlElement("div");
        bubble.className = `message-bubble ${msg.role}-bubble`;

        const content = createHtmlElement("div");
        content.className = "message-content";

        if (msg.role === "user") {
          // 用户消息 - 纯文本
          const displayContent = msg.selectedText
            ? `[Selected]: ${msg.selectedText}\n\n${msg.content.split("[Question]:").pop()?.trim() || msg.content}`
            : msg.content.includes("[Question]:")
              ? msg.content.split("[Question]:").pop()?.trim() || msg.content
              : msg.content;
          content.textContent = displayContent;

          // 附件标记
          if (msg.images?.length || msg.files?.length || msg.pdfContext || msg.selectedText) {
            const badge = createHtmlElement("span");
            badge.className = "attachment-badge";
            badge.textContent = "📎";
            bubble.appendChild(badge);
          }
        } else if (msg.role === "assistant") {
          // AI消息 - 需要渲染Markdown
          // 使用安全的方式设置HTML内容（在XHTML环境中需要特殊处理）
          safeSetInnerHTML(content, renderer.markdownToHtml(msg.content));

          // 复制按钮
          const copyBtn = createHtmlElement("button");
          copyBtn.className = "copy-btn";
          copyBtn.title = getString("chat-copy");
          copyBtn.textContent = "📋";
          copyBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(msg.content).then(() => {
              copyBtn.textContent = "✓";
              setTimeout(() => {
                copyBtn.textContent = "📋";
              }, 2000);
            });
          });
          bubble.appendChild(copyBtn);
        }

        bubble.insertBefore(content, bubble.firstChild);
        wrapper.appendChild(bubble);
        return wrapper;
      }

      // 创建错误消息元素
      function createErrorElement(error: string): HTMLElement {
        const wrapper = createHtmlElement("div");
        wrapper.className = "message-wrapper error-message-wrapper";

        const bubble = createHtmlElement("div");
        bubble.className = "message-bubble error-bubble";

        const content = createHtmlElement("div");
        content.className = "message-content";
        content.textContent = `⚠️ ${error}`;

        bubble.appendChild(content);
        wrapper.appendChild(bubble);
        return wrapper;
      }

      // 渲染所有消息
      function renderMessages(messages: ChatMessage[]) {
        if (!chatHistory) return;

        chatHistory.textContent = "";

        if (messages.length === 0) {
          if (emptyState) {
            chatHistory.appendChild(emptyState);
            emptyState.style.display = "flex";
          }
          return;
        }

        if (emptyState) {
          emptyState.style.display = "none";
        }

        for (const msg of messages) {
          chatHistory.appendChild(createMessageElement(msg));
        }

        // 滚动到底部
        chatHistory.scrollTop = chatHistory.scrollHeight;
      }

      // 初始渲染
      renderMessages(session.messages);

      // 设置ChatManager回调
      manager.setCallbacks({
        onMessageUpdate: (itemId, messages) => {
          if (itemId === item.id) {
            renderMessages(messages);
          }
        },
        onStreamingUpdate: (itemId, content) => {
          if (itemId === item.id && chatHistory) {
            // 更新最后一条AI消息
            const lastMessage = chatHistory.querySelector(".assistant-message-wrapper:last-child .message-content") as HTMLElement;
            if (lastMessage) {
              safeSetInnerHTML(lastMessage, renderer.markdownToHtml(content));
              chatHistory.scrollTop = chatHistory.scrollHeight;
            }
          }
        },
        onError: (error) => {
          ztoolkit.log("Chat error:", error);
          if (chatHistory) {
            chatHistory.appendChild(createErrorElement(error.message));
            chatHistory.scrollTop = chatHistory.scrollHeight;
          }
        },
        onPdfAttached: () => {
          // PDF已附加，取消勾选checkbox
          if (attachPdfCheckbox) {
            attachPdfCheckbox.checked = false;
            ztoolkit.log("[PDF Attach] Checkbox unchecked after successful attachment");
          }
        },
        onMessageComplete: async () => {
          // 消息完成后刷新余额（仅PDFAiTalk provider）
          const providerManager = getProviderManager();
          if (providerManager.getActiveProviderId() === "pdfaitalk") {
            ztoolkit.log("[Balance] Refreshing balance after message completion");
            await authManager.refreshUserInfo();
            updateUserBar();
          }
        },
      });

      // 更新附件预览
      function updateAttachmentsPreview() {
        if (!attachmentsPreview) return;

        attachmentsPreview.textContent = "";

        if (pendingSelectedText) {
          const tag = createHtmlElement("span");
          tag.className = "attachment-tag selection-tag";
          tag.textContent = `📝 ${getString("chat-selection-added")}`;
          attachmentsPreview.appendChild(tag);
        }

        for (const img of pendingImages) {
          const tag = createHtmlElement("span");
          tag.className = "attachment-tag image-tag";
          tag.textContent = `🖼️ ${img.name || "image"}`;
          attachmentsPreview.appendChild(tag);
        }

        for (const file of pendingFiles) {
          const tag = createHtmlElement("span");
          tag.className = "attachment-tag file-tag";
          tag.textContent = `📎 ${file.name}`;
          attachmentsPreview.appendChild(tag);
        }

        attachmentsPreview.style.display =
          (pendingSelectedText || pendingImages.length > 0 || pendingFiles.length > 0)
            ? "flex"
            : "none";
      }

      // 发送消息
      async function sendMessage() {
        const content = messageInput?.value?.trim();
        if (!content) return;

        // 检查登录状态
        if (!authManager.isLoggedIn()) {
          const success = await showAuthDialog("login");
          if (!success) {
            return;
          }
          updateUserBar();
        }

        // 禁用输入
        if (sendButton) sendButton.disabled = true;
        if (messageInput) messageInput.disabled = true;

        try {
          await manager.sendMessage(item, content, {
            attachPdf: attachPdfCheckbox?.checked,
            images: pendingImages.length > 0 ? pendingImages : undefined,
            files: pendingFiles.length > 0 ? pendingFiles : undefined,
            selectedText: pendingSelectedText || undefined,
          });

          // 清空输入
          if (messageInput) {
            messageInput.value = "";
            messageInput.style.height = "auto";
          }

          // 清空待发送附件
          pendingImages = [];
          pendingFiles = [];
          pendingSelectedText = null;
          updateAttachmentsPreview();

          // 如果已附加PDF，更新状态
          if (attachPdfCheckbox?.checked && pdfStatus) {
            pdfStatus.textContent = getString("chat-pdf-attached");
            attachPdfCheckbox.disabled = true;
          }
        } finally {
          // 恢复输入
          if (sendButton) sendButton.disabled = false;
          if (messageInput) messageInput.disabled = false;
          messageInput?.focus();
        }
      }

      // 绑定发送按钮
      sendButton?.addEventListener("click", sendMessage);

      // 绑定输入框事件
      messageInput?.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      // 自动调整输入框高度
      messageInput?.addEventListener("input", () => {
        if (messageInput) {
          messageInput.style.height = "auto";
          messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
        }
      });

      // 上传图片
      uploadImageBtn?.addEventListener("click", async () => {
        const fp = new ztoolkit.FilePicker(
          getString("chat-select-image"),
          "open",
          [["Images", "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp"]],
        );

        const filePath = await fp.open();
        if (filePath) {
          const extractor = manager.getPdfExtractor();
          const result = await extractor.imageFileToBase64(filePath);
          if (result) {
            const fileName = filePath.split(/[/\\]/).pop() || "image";
            pendingImages.push({
              type: "base64",
              data: result.data,
              mimeType: result.mimeType,
              name: fileName,
            });
            updateAttachmentsPreview();
          }
        }
      });

      // 上传文件
      uploadFileBtn?.addEventListener("click", async () => {
        const fp = new ztoolkit.FilePicker(
          getString("chat-select-file"),
          "open",
          [["Text files", "*.txt;*.md;*.json;*.xml;*.csv;*.log"]],
        );

        const filePath = await fp.open();
        if (filePath) {
          const extractor = manager.getPdfExtractor();
          const content = await extractor.readTextFile(filePath);
          if (content) {
            const fileName = filePath.split(/[/\\]/).pop() || "file.txt";
            pendingFiles.push({
              name: fileName,
              content: content.substring(0, 50000), // 限制长度
              type: "text",
            });
            updateAttachmentsPreview();
          }
        }
      });

      // 使用选中文本
      useSelectionBtn?.addEventListener("click", () => {
        const selectedText = manager.getSelectedText();
        if (selectedText) {
          pendingSelectedText = selectedText;
          updateAttachmentsPreview();
        } else {
          ztoolkit.log("No text selected in PDF reader");
        }
      });

      // 清空对话
      clearChatBtn?.addEventListener("click", async () => {
        await manager.clearSession(item.id);
        pendingImages = [];
        pendingFiles = [];
        pendingSelectedText = null;
        updateAttachmentsPreview();

        // 重置PDF附加状态
        if (attachPdfCheckbox && hasPdf) {
          attachPdfCheckbox.checked = false;
          attachPdfCheckbox.disabled = false;
        }
        if (pdfStatus) {
          pdfStatus.textContent = hasPdf ? "" : getString("chat-no-pdf");
        }
      });
    },
  });
}

/**
 * 获取聊天界面HTML模板
 */
function getChatBodyXHTML(): string {
  return `
    <html:div class="chat-container">
      <!-- 用户信息栏 -->
      <html:div id="user-bar" class="user-bar">
        <html:div id="user-status" class="user-status">
          <html:span id="user-name" class="user-name"></html:span>
          <html:span id="user-balance" class="user-balance"></html:span>
        </html:div>
        <html:button id="user-action-btn" class="user-action-btn"></html:button>
      </html:div>

      <!-- 聊天历史区域 -->
      <html:div id="chat-history" class="chat-history">
        <html:div id="chat-empty-state" class="empty-state">
          <html:div class="empty-icon">💬</html:div>
          <html:div class="empty-text" data-l10n-id="${config.addonRef}-chat-empty-state">Start a conversation</html:div>
        </html:div>
      </html:div>

      <!-- 工具栏 -->
      <html:div class="chat-toolbar">
        <html:label class="toolbar-option pdf-option">
          <html:input type="checkbox" id="attach-pdf" />
          <html:span data-l10n-id="${config.addonRef}-chat-attach-pdf">Attach PDF</html:span>
          <html:span id="pdf-status" class="pdf-status"></html:span>
        </html:label>
        <html:div class="toolbar-buttons">
          <html:button id="upload-image" class="toolbar-btn" title="Upload Image">🖼️</html:button>
          <html:button id="upload-file" class="toolbar-btn" title="Upload File">📎</html:button>
          <html:button id="use-selection" class="toolbar-btn" title="Use Selection">✂️</html:button>
          <html:button id="clear-chat" class="toolbar-btn danger" title="Clear Chat">🗑️</html:button>
        </html:div>
      </html:div>

      <!-- 附件预览区 -->
      <html:div id="attachments-preview" class="attachments-preview"></html:div>

      <!-- 输入区域 -->
      <html:div class="input-area">
        <html:textarea
          id="message-input"
          rows="2"
          class="message-input"
          data-l10n-id="${config.addonRef}-chat-input-placeholder"
        ></html:textarea>
        <html:button id="send-button" class="send-button">
          <html:span data-l10n-id="${config.addonRef}-chat-send-button">Send</html:span>
        </html:button>
      </html:div>
    </html:div>
  `;
}

/**
 * 注销聊天侧边栏
 */
export function unregisterChatSidebar(): void {
  Zotero.ItemPaneManager.unregisterSection("pdf-ai-talk-chat");

  // 销毁ChatManager
  if (chatManager) {
    chatManager.destroy();
    chatManager = null;
  }
}
