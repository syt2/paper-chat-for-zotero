import { getString } from "../../../utils/locale";
import { chatFontSize } from "./ChatPanelTypography";

const homePrompts = [
  "chat-empty-home-1",
  "chat-empty-home-2",
  "chat-empty-home-3",
] as const;
const paperPrompts = [
  "chat-empty-paper-1",
  "chat-empty-paper-2",
  "chat-empty-paper-3",
] as const;

/** Choose once per empty session/reader context, without retaining session data. */
export function updateEmptyChatPrompt(
  container: HTMLElement,
  sessionId: string | undefined,
  readerItem: Zotero.Item | null,
): void {
  const empty = container.querySelector(
    "#chat-empty-state",
  ) as HTMLElement | null;
  if (!empty) return;
  const paper = readerItem?.parentID
    ? Zotero.Items.get(readerItem.parentID)
    : readerItem;
  const title = String(paper?.getField("title") || "").trim();
  const context = JSON.stringify([
    sessionId || "",
    readerItem?.key || "",
    title,
  ]);
  if (empty.dataset.promptContext === context) return;
  empty.dataset.promptContext = context;
  const prompts = title ? paperPrompts : homePrompts;
  const key = prompts[Math.floor(Math.random() * prompts.length)];
  const text = empty.ownerDocument.createElement("div");
  text.style.fontSize = chatFontSize(16);
  text.style.maxWidth = "320px";
  text.style.lineHeight = "1.75";
  text.style.overflowWrap = "anywhere";
  text.textContent = getString(key, { args: { title } });
  empty.replaceChildren(text);
}
