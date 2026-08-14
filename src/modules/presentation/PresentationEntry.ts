import { getString } from "../../utils/locale";
import { getAuthManager } from "../auth";
import { getProviderManager } from "../providers";
import { showAuthDialog } from "../ui/AuthDialog";
import { createPresentationLaunchDialogs } from "./PresentationLaunchDialogs";
import {
  guardPresentationLaunch,
  PRESENTATION_LAUNCH_PROMPT,
} from "./PresentationLaunchGuard";
import { PresentationLaunchCoordinator } from "./PresentationLaunchCoordinator";
import type { PresentationLaunchSettings } from "./PresentationLaunchSettings";

const PRESENTATION_ITEM_MENU_ID = "paperchat-generate-presentation-menuitem";
const launchCoordinator = new PresentationLaunchCoordinator();

export type PresentationLaunchSource = "library_menu" | "chat_button";
export type PresentationChatOpener = (
  item: Zotero.Item,
  prompt: string,
  source: "presentation_menu" | "presentation_button",
  settings: PresentationLaunchSettings,
) => Promise<boolean>;

function isPdfAttachment(item: Zotero.Item): boolean {
  return (
    item.isPDFAttachment?.() === true ||
    (item.isAttachment?.() === true &&
      item.attachmentContentType === "application/pdf")
  );
}

/** Normalize a selected PDF attachment to the bibliographic paper it belongs to. */
export function resolvePresentationPaper(
  item: Zotero.Item | false | null | undefined,
): Zotero.Item | null {
  if (!item || item.isNote?.()) return null;
  if (item.isAttachment?.()) {
    if (!isPdfAttachment(item) || !item.parentItemID) return null;
    const parent = Zotero.Items.get(item.parentItemID) as Zotero.Item | false;
    return parent && !parent.isAttachment?.() && !parent.isNote?.()
      ? parent
      : null;
  }
  return item;
}

/** Pick the first usable paper without letting an invalid stale candidate block later fallbacks. */
export function resolvePresentationPaperFromCandidates(
  ...items: Array<Zotero.Item | false | null | undefined>
): Zotero.Item | null {
  for (const item of items) {
    const paper = resolvePresentationPaper(item);
    if (paper) return paper;
  }
  return null;
}

export function paperHasPdf(item: Zotero.Item): boolean {
  if (isPdfAttachment(item)) return true;
  if (item.isAttachment?.() || item.isNote?.()) return false;
  return (item.getAttachments?.() || []).some((attachmentID) => {
    const attachment = Zotero.Items.get(attachmentID) as Zotero.Item | false;
    return !!attachment && isPdfAttachment(attachment);
  });
}

export function getSingleSelectedPresentationPaper(): Zotero.Item | null {
  const selected =
    (Zotero.getActiveZoteroPane()?.getSelectedItems() as
      | Zotero.Item[]
      | undefined) || [];
  if (selected.length !== 1) return null;
  return resolvePresentationPaper(selected[0]);
}

function showMissingPdfDialog(): void {
  Services.prompt.alert(
    Zotero.getMainWindow() as unknown as mozIDOMWindowProxy,
    getString("presentation-source-unavailable-title"),
    getString("presentation-source-unavailable-message"),
  );
}

async function runPresentationLaunch(
  item: Zotero.Item,
  source: PresentationLaunchSource,
  openPresentationChat: PresentationChatOpener,
): Promise<boolean> {
  const paper = resolvePresentationPaper(item);
  if (!paper || !paperHasPdf(paper)) {
    showMissingPdfDialog();
    return false;
  }

  const guardResult = await guardPresentationLaunch({
    providerManager: getProviderManager(),
    authManager: getAuthManager(),
    dialogs: createPresentationLaunchDialogs(),
    ensureLoggedIn: () => showAuthDialog("login"),
  });
  if (!guardResult.allowed) return false;

  const started = await openPresentationChat(
    paper,
    PRESENTATION_LAUNCH_PROMPT,
    source === "library_menu" ? "presentation_menu" : "presentation_button",
    guardResult.settings,
  );
  if (!started) {
    Services.prompt.alert(
      Zotero.getMainWindow() as unknown as mozIDOMWindowProxy,
      getString("presentation-launch-failed-title"),
      getString("presentation-launch-failed-message"),
    );
  }
  return started;
}

/**
 * Launch one PPT per paper at a time. This protects against double-clicking
 * either entry while its modal gate is open.
 */
export function launchPresentationForItem(
  item: Zotero.Item,
  source: PresentationLaunchSource,
  openPresentationChat: PresentationChatOpener,
): Promise<boolean> {
  const paper = resolvePresentationPaper(item);
  const key = paper ? `${paper.libraryID}:${paper.key}` : `invalid:${item.id}`;
  return launchCoordinator.enqueue(key, () =>
    runPresentationLaunch(item, source, openPresentationChat),
  );
}

export function registerPresentationEntryMenu(
  openPresentationChat: PresentationChatOpener,
): void {
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: PRESENTATION_ITEM_MENU_ID,
    label: getString("presentation-generate"),
    icon: `chrome://${addon.data.config.addonRef}/content/icons/presentation.svg`,
    getVisibility: () => !!getSingleSelectedPresentationPaper(),
    commandListener: () => {
      const paper = getSingleSelectedPresentationPaper();
      if (paper) {
        void launchPresentationForItem(
          paper,
          "library_menu",
          openPresentationChat,
        ).catch((error) => {
          ztoolkit.log(
            "[PresentationEntry] Failed to launch presentation:",
            error,
          );
          Services.prompt.alert(
            Zotero.getMainWindow() as unknown as mozIDOMWindowProxy,
            getString("presentation-launch-failed-title"),
            getString("presentation-launch-failed-message"),
          );
        });
      }
    },
  });
}

export function unregisterPresentationEntryMenu(): void {
  ztoolkit.Menu.unregister(PRESENTATION_ITEM_MENU_ID);
}
