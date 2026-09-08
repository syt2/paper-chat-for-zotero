import { getString } from "../../../utils/locale";
import type { ThemeColors } from "./types";
import { HTML_NS } from "./types";

/** An inline draft belongs to this rendered message, never the main composer. */
export function openUserMessageEditor(
  content: HTMLElement,
  actions: HTMLElement,
  prompt: string,
  theme: ThemeColors,
  onSend: (prompt: string) => Promise<boolean>,
): void {
  if (content.parentElement?.querySelector(".user-message-editor")) return;
  const doc = content.ownerDocument;
  const editor = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  editor.className = "user-message-editor";
  const input = doc.createElementNS(HTML_NS, "textarea") as HTMLTextAreaElement;
  input.value = prompt;
  input.setAttribute("aria-label", getString("chat-edit-message"));
  Object.assign(input.style, {
    width: "100%",
    minWidth: "160px",
    minHeight: "88px",
    maxHeight: "320px",
    boxSizing: "border-box",
    resize: "vertical",
    font: "inherit",
    lineHeight: "1.6",
    color: theme.textPrimary,
    background: "transparent",
    border: `1px solid ${theme.borderColor}`,
    borderRadius: "8px",
    padding: "8px",
  });
  const controls = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  Object.assign(controls.style, {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    marginTop: "6px",
  });
  const makeButton = (label: string) => {
    const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
    button.type = "button";
    button.textContent = label;
    Object.assign(button.style, {
      font: "inherit",
      fontSize: "12px",
      padding: "4px 10px",
      borderRadius: "6px",
      border: `1px solid ${theme.borderColor}`,
      color: theme.textPrimary,
      background: "transparent",
      cursor: "pointer",
    });
    controls.appendChild(button);
    return button;
  };
  const cancel = makeButton(getString("auth-cancel"));
  const send = makeButton(getString("chat-edit-message-send"));
  const error = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  error.setAttribute("role", "alert");
  error.style.fontSize = "12px";
  const restore = () => {
    editor.remove();
    content.style.display = "";
    actions.style.display = "flex";
    (actions.querySelector(".edit-message-btn") as HTMLElement | null)?.focus();
  };
  const update = () => {
    send.disabled = !input.value.trim() || input.value.trim() === prompt.trim();
  };
  input.addEventListener("input", update);
  cancel.addEventListener("click", restore);
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape" && !input.disabled) {
      event.preventDefault();
      restore();
    }
  });
  send.addEventListener("click", async () => {
    if (send.disabled) return;
    input.disabled = cancel.disabled = send.disabled = true;
    error.textContent = "";
    try {
      if (await onSend(input.value.trim())) restore();
      else error.textContent = getString("chat-edit-message-unavailable");
    } catch (reason) {
      error.textContent =
        reason instanceof Error ? reason.message : String(reason);
    } finally {
      input.disabled = cancel.disabled = false;
      update();
    }
  });
  editor.append(input, controls, error);
  content.after(editor);
  content.style.display = actions.style.display = "none";
  update();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
