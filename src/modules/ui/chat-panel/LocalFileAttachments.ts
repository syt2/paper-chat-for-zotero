import { getString } from "../../../utils/locale";
import type { ImageAttachment } from "../../../types/chat";
import type { ChatPanelContext } from "./types";
import { canAddImageAttachmentToDraft } from "./ChatPanelManager";
import {
  getImageAttachmentLimitMessage,
  refreshImageInputAvailability,
} from "./imageAttachmentPolicy";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "json", "xml", "csv", "log"]);
export const IMAGE_FILE_PATTERN = [...IMAGE_EXTENSIONS]
  .map((ext) => `*.${ext}`)
  .join(";");
export const TEXT_FILE_PATTERN = [...TEXT_EXTENSIONS]
  .map((ext) => `*.${ext}`)
  .join(";");

/** File picker and native drag/drop share format validation and draft limits. */
export async function attachLocalFiles(
  context: ChatPanelContext,
  paths: readonly string[],
  isCurrent: () => boolean,
): Promise<void> {
  const { chatManager, container } = context;
  const extractor = chatManager.getPdfExtractor();
  for (const path of new Set(paths)) {
    if (!isCurrent()) return;
    const name = path.split(/[/\\]/).pop() || path;
    const extension = name.toLowerCase().split(".").pop() || "";
    if (!IMAGE_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)) {
      context.appendError(
        getString("chat-attachment-unsupported", { args: { name } }),
        "unsupported-attachment",
      );
      continue;
    }
    try {
      if (IMAGE_EXTENSIONS.has(extension)) {
        const availability = await refreshImageInputAvailability(
          container,
          chatManager,
        );
        if (!isCurrent()) return;
        if (availability === "unsupported") {
          context.appendError(getString("chat-image-input-unsupported"));
          continue;
        }
        const result = await extractor.imageFileToBase64(path);
        if (!isCurrent()) return;
        if (!result) throw new Error("Image could not be read");
        const image: ImageAttachment = { type: "base64", ...result, name };
        const state = context.getAttachmentState();
        if (!canAddImageAttachmentToDraft(state.pendingImages, image)) {
          context.appendError(getImageAttachmentLimitMessage());
          continue;
        }
        state.pendingImages = [...state.pendingImages, image];
        context.setAttachmentState(state);
      } else {
        const content = await extractor.readTextFile(path);
        if (!isCurrent()) return;
        if (content === null) throw new Error("Text file could not be read");
        const state = context.getAttachmentState();
        state.pendingFiles.push({
          name,
          sourcePath: path,
          content: content.slice(0, 50000),
          type: "text",
        });
        context.setAttachmentState(state);
      }
      context.updateAttachmentsPreview();
    } catch (error) {
      if (!isCurrent()) return;
      ztoolkit.log("[Chat] Failed to attach local file:", error);
      context.appendError(
        getString("chat-attachment-read-failed", { args: { name } }),
      );
    }
  }
}

export function isFileDrop(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  const types = Array.from(transfer.types);
  return types.includes("Files") || types.includes("application/x-moz-file");
}

/** Read native paths synchronously while the drop event's data is accessible. */
export function getDroppedFilePaths(transfer: DataTransfer): string[] {
  const paths = new Set<string>();
  if (Array.from(transfer.types).includes("application/x-moz-file")) {
    for (let index = 0; index < transfer.mozItemCount; index++) {
      try {
        const file = transfer.mozGetDataAt("application/x-moz-file", index) as {
          path?: string;
        } | null;
        if (file?.path) paths.add(file.path);
      } catch {
        // Some platforms expose native files only through the DOM FileList.
      }
    }
  }
  for (const file of Array.from(transfer.files)) {
    if (file.mozFullPath) paths.add(file.mozFullPath);
  }
  return [...paths];
}

export function setupLocalFileAttachments(context: ChatPanelContext): {
  pickFile: () => Promise<void>;
  dispose: () => void;
} {
  const { container, chatManager } = context;
  let disposed = false;
  let dragDepth = 0;
  const resetDrag = () => {
    dragDepth = 0;
    container.removeAttribute("data-file-drag");
  };
  const captureDraft = () => {
    const session = chatManager.getActiveSession();
    return () =>
      !disposed &&
      container.isConnected &&
      chatManager.getActiveSession() === session;
  };
  const acceptDrag = (event: DragEvent) => {
    if (!isFileDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    container.setAttribute("data-file-drag", "true");
  };
  const enter = (event: DragEvent) => {
    if (!isFileDrop(event.dataTransfer)) return;
    dragDepth++;
    acceptDrag(event);
  };
  const leave = () => {
    if (--dragDepth <= 0) resetDrag();
  };
  const drop = (event: DragEvent) => {
    resetDrag();
    if (!isFileDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const paths = getDroppedFilePaths(event.dataTransfer!);
    if (!paths.length) {
      context.appendError(getString("chat-attachment-drop-unavailable"));
      return;
    }
    void attachLocalFiles(context, paths, captureDraft());
  };
  container.addEventListener("dragenter", enter, true);
  container.addEventListener("dragover", acceptDrag, true);
  container.addEventListener("dragleave", leave, true);
  container.addEventListener("drop", drop, true);
  const win = container.ownerDocument.defaultView;
  win?.addEventListener("dragend", resetDrag);
  win?.addEventListener("blur", resetDrag);

  return {
    pickFile: async () => {
      const isCurrent = captureDraft();
      const availability = await refreshImageInputAvailability(
        container,
        chatManager,
      );
      if (!isCurrent()) return;
      const filters: Array<[string, string]> = [];
      if (availability !== "unsupported") {
        filters.push(
          ["All supported", `${IMAGE_FILE_PATTERN};${TEXT_FILE_PATTERN}`],
          ["Images", IMAGE_FILE_PATTERN],
        );
      }
      filters.push(["Text files", TEXT_FILE_PATTERN]);
      const picker = new ztoolkit.FilePicker("Select File", "open", filters);
      const path = await picker.open();
      if (path && isCurrent())
        await attachLocalFiles(context, [path], isCurrent);
    },
    dispose: () => {
      disposed = true;
      resetDrag();
      container.removeEventListener("dragenter", enter, true);
      container.removeEventListener("dragover", acceptDrag, true);
      container.removeEventListener("dragleave", leave, true);
      container.removeEventListener("drop", drop, true);
      win?.removeEventListener("dragend", resetDrag);
      win?.removeEventListener("blur", resetDrag);
    },
  };
}
