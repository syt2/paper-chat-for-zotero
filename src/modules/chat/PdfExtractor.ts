/**
 * PdfExtractor - PDF内容提取工具
 */

const MAX_COMPRESSED_IMAGE_BYTES = 200 * 1024;
const INITIAL_COMPRESSED_IMAGE_MAX_DIMENSION = 1600;
const MIN_COMPRESSED_IMAGE_DIMENSION = 32;
const JPEG_COMPRESSION_QUALITIES = [0.82, 0.72, 0.62, 0.52, 0.42, 0.34, 0.28];

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
   * 读取本地图片文件，压缩为 200KB 以下的 JPEG 后转换为 Base64
   */
  async imageFileToBase64(
    filePath: string,
  ): Promise<{ data: string; mimeType: string } | null> {
    try {
      const data = await IOUtils.read(filePath);
      return await this.compressImageToJpegBase64(
        data,
        this.getImageMimeType(filePath),
      );
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

  private async compressImageToJpegBase64(
    data: Uint8Array,
    sourceMimeType: string,
  ): Promise<{ data: string; mimeType: string }> {
    const win = Zotero.getMainWindow();
    const blob = new win.Blob([data], { type: sourceMimeType });
    const objectUrl = win.URL.createObjectURL(blob);

    try {
      const image = await this.loadImage(win, objectUrl);
      const canvas = win.document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Failed to create image compression canvas context");
      }

      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;
      if (!sourceWidth || !sourceHeight) {
        throw new Error("Failed to decode image dimensions");
      }

      const initialScale = Math.min(
        1,
        INITIAL_COMPRESSED_IMAGE_MAX_DIMENSION /
          Math.max(sourceWidth, sourceHeight),
      );
      let scale = initialScale;
      let bestBytes = Number.POSITIVE_INFINITY;

      for (let attempt = 0; attempt < 18; attempt++) {
        const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
        const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        // JPEG has no alpha channel; use white instead of transparent/black.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, targetWidth, targetHeight);
        ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

        for (const quality of JPEG_COMPRESSION_QUALITIES) {
          const base64 = this.canvasToJpegBase64(canvas, quality);
          const byteLength = this.getBase64ByteLength(base64);
          if (byteLength < bestBytes) {
            bestBytes = byteLength;
          }
          if (byteLength <= MAX_COMPRESSED_IMAGE_BYTES) {
            ztoolkit.log(
              "[Image Compress] Compressed image:",
              `${sourceWidth}x${sourceHeight}`,
              "->",
              `${targetWidth}x${targetHeight}`,
              "bytes:",
              byteLength,
            );
            return { data: base64, mimeType: "image/jpeg" };
          }
        }

        if (
          Math.max(targetWidth, targetHeight) <= MIN_COMPRESSED_IMAGE_DIMENSION
        ) {
          break;
        }
        scale *= 0.75;
      }

      throw new Error(
        `Failed to compress image below ${MAX_COMPRESSED_IMAGE_BYTES} bytes, smallest result was ${bestBytes} bytes`,
      );
    } finally {
      win.URL.revokeObjectURL(objectUrl);
    }
  }

  private loadImage(win: Window, src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new win.Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to load image"));
      image.src = src;
    });
  }

  private canvasToJpegBase64(
    canvas: HTMLCanvasElement,
    quality: number,
  ): string {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex < 0) {
      throw new Error("Failed to encode compressed JPEG");
    }
    return dataUrl.slice(commaIndex + 1);
  }

  private getBase64ByteLength(base64: string): number {
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
  }

  private getImageMimeType(filePath: string): string {
    const ext = filePath.toLowerCase().split(".").pop();
    const mimeTypes: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
    };

    return mimeTypes[ext || ""] || "image/png";
  }
}
