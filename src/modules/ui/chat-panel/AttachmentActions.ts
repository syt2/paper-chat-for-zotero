import type { FileAttachment, ImageAttachment } from "../../../types/chat";
import { getString } from "../../../utils/locale";
import { createElement } from "./ChatPanelBuilder";

/** Older messages lack original paths, but still retain their text contents. */
export async function revealAttachedFile(file: FileAttachment): Promise<void> {
  // A history imported from another OS may contain an invalid local path.
  const originalExists = file.sourcePath
    ? await IOUtils.exists(file.sourcePath).catch(() => false)
    : false;
  if (file.sourcePath && originalExists) {
    await Zotero.File.reveal(file.sourcePath);
    return;
  }
  const name =
    (file.name || "attachment.txt")
      // eslint-disable-next-line no-control-regex -- Strip control characters from cached file names.
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120)
      .replace(/[. ]+$/, "") || "attachment.txt";
  const directory = PathUtils.join(
    Zotero.getTempDirectory().path,
    "paperchat-attachments",
  );
  await IOUtils.makeDirectory(directory, { ignoreExisting: true });
  const hash = Zotero.Utilities.Internal.md5(file.content);
  const path = PathUtils.join(directory, `${hash}-${name}`);
  await IOUtils.writeUTF8(path, file.content);
  await Zotero.File.reveal(path);
}

export function createFileAttachmentButton(
  doc: Document,
  file: FileAttachment,
): HTMLElement {
  const button = createElement(
    doc,
    "button",
    {
      minWidth: "0",
      maxWidth: "100%",
      padding: "0",
      border: "0",
      background: "transparent",
      color: "inherit",
      font: "inherit",
      cursor: "pointer",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      textAlign: "left",
    },
    {
      type: "button",
      title: getString(
        file.sourcePath
          ? "chat-attachment-reveal"
          : "chat-attachment-reveal-copy",
      ),
    },
  );
  button.textContent = file.name;
  button.className = "chat-file-attachment-button";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void revealAttachedFile(file).catch((error) => {
      ztoolkit.log("[Chat] Could not reveal attachment:", error);
      Zotero.alert(
        doc.defaultView || Zotero.getMainWindow(),
        getString("chat-upload-file"),
        getString("chat-attachment-read-failed", { args: { name: file.name } }),
      );
    });
  });
  return button;
}

export function bindAttachmentImagePreview(
  thumbnail: HTMLElement,
  image: ImageAttachment,
): void {
  thumbnail.style.cursor = "zoom-in";
  thumbnail.setAttribute("role", "button");
  thumbnail.setAttribute("tabindex", "0");
  thumbnail.setAttribute("title", getString("chat-attachment-preview-image"));
  const open = () => {
    const doc = thumbnail.ownerDocument;
    doc.querySelector(".chat-attachment-image-preview")?.remove();
    const overlay = createElement(
      doc,
      "div",
      {
        position: "fixed",
        inset: "0",
        zIndex: "10020",
        background: "rgba(0,0,0,.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px",
        boxSizing: "border-box",
      },
      {
        role: "dialog",
        "aria-modal": "true",
        "aria-label": getString("chat-attachment-preview-image"),
      },
    );
    overlay.className = "chat-attachment-image-preview";
    const fullImage = createElement(
      doc,
      "img",
      {
        display: "block",
        maxWidth: "calc(100vw - 80px)",
        maxHeight: "calc(100vh - 80px)",
        objectFit: "contain",
        borderRadius: "6px",
      },
      {
        src:
          image.type === "base64"
            ? `data:${image.mimeType};base64,${image.data}`
            : image.data,
        alt: image.name || getString("chat-attachment-preview-image"),
      },
    );
    const closeButton = createElement(
      doc,
      "button",
      {
        position: "absolute",
        top: "12px",
        right: "12px",
        width: "28px",
        height: "28px",
        minWidth: "28px",
        minHeight: "28px",
        maxWidth: "28px",
        maxHeight: "28px",
        padding: "0",
        margin: "0",
        appearance: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        border: "0",
        borderRadius: "50%",
        background: "#fff",
        color: "#333",
        cursor: "pointer",
      },
      {
        type: "button",
        "aria-label": getString("chat-attachment-close-preview"),
      },
    );
    const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("width", "16");
    icon.setAttribute("height", "16");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    icon.style.pointerEvents = "none";
    const cross = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    cross.setAttribute("d", "M4 4l8 8M12 4l-8 8");
    cross.setAttribute("stroke", "currentColor");
    cross.setAttribute("stroke-width", "1.75");
    cross.setAttribute("stroke-linecap", "round");
    icon.appendChild(cross);
    closeButton.appendChild(icon);
    const close = () => {
      overlay.remove();
      if (thumbnail.isConnected) thumbnail.focus();
    };
    closeButton.addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (event.key === "Tab") {
        event.preventDefault();
        closeButton.focus();
      }
    });
    overlay.append(fullImage, closeButton);
    doc.documentElement.appendChild(overlay);
    closeButton.focus();
  };
  thumbnail.addEventListener("click", open);
  thumbnail.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
}
