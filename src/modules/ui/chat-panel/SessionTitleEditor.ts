import { getString } from "../../../utils/locale";
import { createElement } from "./ChatPanelBuilder";
import { chatFontSize } from "./ChatPanelTypography";
import type { ThemeColors } from "./types";

/** Shared inline editor: Enter/blur saves, Escape cancels, empty resets the title. */
export function editSessionTitle(
  title: HTMLElement,
  value: string,
  theme: ThemeColors,
  save: (value: string | null) => Promise<void>,
): void {
  if (title.dataset.editing === "true") return;
  title.dataset.editing = "true";
  const display = title.style.display;
  const input = createElement(title.ownerDocument, "input", {
    width: "100%",
    minWidth: "0",
    flex: "1",
    boxSizing: "border-box",
    fontSize: chatFontSize(13),
    fontWeight: "600",
    color: theme.textPrimary,
    background: theme.inputBg,
    border: `1px solid ${theme.inputBorderColor}`,
    borderRadius: "4px",
    padding: "2px 4px",
    outline: "none",
  }) as HTMLInputElement;
  input.setAttribute("aria-label", getString("chat-edit-title"));
  input.value = value;
  title.style.display = "none";
  title.before(input);
  let finished = false;
  const restore = () => {
    input.remove();
    title.style.display = display;
    delete title.dataset.editing;
  };
  const finish = async () => {
    if (finished) return;
    finished = true;
    input.disabled = true;
    try {
      await save(input.value.trim() || null);
    } catch (error) {
      ztoolkit.log(
        "[SessionTitleEditor] Failed to update session title:",
        error,
      );
    } finally {
      restore();
    }
  };
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void finish();
    } else if (event.key === "Escape" && !finished) {
      event.preventDefault();
      finished = true;
      restore();
    }
  });
  input.addEventListener("blur", () => void finish());
  input.focus();
  input.select();
}
