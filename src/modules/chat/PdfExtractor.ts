/**
 * PdfExtractor - PDF内容提取工具
 */

export class PdfExtractor {
  /**
   * 查找Item的PDF附件
   * 统一的PDF附件查找逻辑，避免重复代码
   */
  private async findPdfAttachment(
    item: Zotero.Item,
  ): Promise<Zotero.Item | null> {
    // Check if the item itself is a PDF attachment
    if (item.isAttachment()) {
      if (item.attachmentContentType === "application/pdf") {
        return item;
      }
      // Non-PDF attachment, can't have child attachments
      return null;
    }

    // Notes can't have attachments
    if (item.isNote()) {
      return null;
    }

    // Otherwise, look for PDF attachments on the item
    const attachments = item.getAttachments();
    for (const attachmentID of attachments) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (attachment?.attachmentContentType === "application/pdf") {
        return attachment;
      }
    }

    return null;
  }

  /**
   * 获取Item的PDF附件文本
   */
  async extractPdfText(item: Zotero.Item): Promise<string | null> {
    try {
      const pdfAttachment = await this.findPdfAttachment(item);
      if (!pdfAttachment) return null;

      const text = await pdfAttachment.attachmentText;
      if (text) {
        ztoolkit.log("PDF text extracted, length:", text.length);
        return text;
      }
      return null;
    } catch (error) {
      ztoolkit.log("Error extracting PDF:", error);
      return null;
    }
  }

  /**
   * 检查是否有PDF附件
   */
  async hasPdfAttachment(item: Zotero.Item): Promise<boolean> {
    try {
      const pdfAttachment = await this.findPdfAttachment(item);
      return pdfAttachment !== null;
    } catch (error) {
      ztoolkit.log("Error checking PDF attachment:", error);
      return false;
    }
  }

  /**
   * 获取PDF附件信息
   */
  async getPdfInfo(
    item: Zotero.Item,
  ): Promise<{ name: string; size: number } | null> {
    try {
      const pdfAttachment = await this.findPdfAttachment(item);
      if (!pdfAttachment) return null;

      const path = await pdfAttachment.getFilePathAsync();
      if (!path) return null;

      const info = await IOUtils.stat(path);
      return {
        name: pdfAttachment.attachmentFilename || "document.pdf",
        size: info.size ?? 0,
      };
    } catch (error) {
      ztoolkit.log("Error getting PDF info:", error);
      return null;
    }
  }

  /**
   * 获取选中的PDF文本 (从Reader)
   */
  getSelectedTextFromReader(): string | null {
    try {
      const win = Zotero.getMainWindow();
      if (!win) return null;

      // 获取当前活动的Reader
      const reader = Zotero.Reader.getByTabID(
        (win as any).Zotero_Tabs?.selectedID,
      );
      if (!reader) return null;

      // 尝试获取选中文本
      const iframeWindow = (reader as any)._iframeWindow;
      if (iframeWindow) {
        const selection = iframeWindow.getSelection?.()?.toString?.();
        if (selection && selection.trim()) {
          return selection.trim();
        }
      }

      return null;
    } catch (error) {
      ztoolkit.log("Error getting selected text:", error);
      return null;
    }
  }

  /**
   * 读取本地图片文件并转换为Base64
   */
  async imageFileToBase64(
    filePath: string,
  ): Promise<{ data: string; mimeType: string } | null> {
    try {
      const data = await IOUtils.read(filePath);
      const base64 = this.arrayBufferToBase64(data);

      // 根据扩展名判断MIME类型
      const ext = filePath.toLowerCase().split(".").pop();
      const mimeTypes: Record<string, string> = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
      };

      const mimeType = mimeTypes[ext || ""] || "image/png";

      return { data: base64, mimeType };
    } catch (error) {
      ztoolkit.log("Error reading image file:", error);
      return null;
    }
  }

  /**
   * 读取文本文件内容
   */
  async readTextFile(filePath: string): Promise<string | null> {
    try {
      const data = await IOUtils.readUTF8(filePath);
      return data;
    } catch (error) {
      ztoolkit.log("Error reading text file:", error);
      return null;
    }
  }

  /**
   * Get PDF file as base64 for upload
   */
  async getPdfBase64(
    item: Zotero.Item,
  ): Promise<{ data: string; mimeType: string; name: string } | null> {
    try {
      const pdfAttachment = await this.findPdfAttachment(item);
      if (!pdfAttachment) return null;

      const path = await pdfAttachment.getFilePathAsync();
      if (!path) return null;

      const data = await IOUtils.read(path);
      const base64 = this.arrayBufferToBase64(data);
      return {
        data: base64,
        mimeType: "application/pdf",
        name: pdfAttachment.attachmentFilename || "document.pdf",
      };
    } catch (error) {
      ztoolkit.log("Error getting PDF base64:", error);
      return null;
    }
  }

  /**
   * ArrayBuffer转Base64
   */
  private arrayBufferToBase64(buffer: Uint8Array): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}
