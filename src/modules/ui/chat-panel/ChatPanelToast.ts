import { showToast } from "../toast";
import { getCurrentTheme } from "./ChatPanelTheme";
import { chatFontSize } from "./ChatPanelTypography";

/**
 * Transient feedback that belongs to the chat panel's own pane rather than to
 * the Zotero main window, themed like the panel.
 *
 * Use it for messages about something the user just did - a queue limit, a
 * rejected attachment, a model that had to be switched. Keep real errors on the
 * inline banner: those need to stay readable.
 */
export function showChatPanelToast(
  container: Element | null | undefined,
  message: string,
): void {
  if (!container) {
    return;
  }
  const theme = getCurrentTheme();
  const host =
    container.closest?.(".chat-panel-root") ??
    container.querySelector(".chat-panel-root") ??
    container;

  showToast(message, {
    doc: container.ownerDocument ?? undefined,
    container: host,
    positioning: "container",
    bottom: "40px",
    fontSize: chatFontSize(12),
    styles: {
      border: `1px solid ${theme.borderColor}`,
      background: theme.dropdownBg,
      color: theme.textPrimary,
      boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
    },
  });
}
