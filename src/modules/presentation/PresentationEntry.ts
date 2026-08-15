import { getString } from "../../utils/locale";
import {
  getAnalyticsService,
  trackPaperChatPresentationEntryClicked,
} from "../analytics";
import { getAuthManager } from "../auth";
import { getProviderManager } from "../providers";
import { showAuthDialog } from "../ui/AuthDialog";
import { createPresentationLaunchDialogs } from "./PresentationLaunchDialogs";
import {
  guardPresentationLaunch,
  PRESENTATION_LAUNCH_PROMPT,
} from "./PresentationLaunchGuard";
import {
  createPresentationLaunchKey,
  MAX_CONCURRENT_PRESENTATION_RUNS,
  PresentationLaunchCoordinator,
  type PresentationLaunchLifecycle,
} from "./PresentationLaunchCoordinator";
import type { PresentationLaunchSettings } from "./PresentationLaunchSettings";
import {
  createPresentationToolLaunchSession,
  type PresentationToolLaunchSession,
} from "./PresentationToolLaunchSession";
import type {
  PresentationChatLaunchOptions,
  PresentationTaskLocation,
} from "./PresentationChatLaunchBridge";

const PRESENTATION_ITEM_MENU_ID = "paperchat-generate-presentation-menuitem";
const launchCoordinator = new PresentationLaunchCoordinator();

export type PresentationTaskFocusHandler = (
  item: Zotero.Item,
  location: PresentationTaskLocation,
) => void;

let presentationTaskFocusHandler: PresentationTaskFocusHandler | null = null;

export type PresentationLaunchSource = "library_menu" | "chat_button";
export type PresentationChatOpener = (
  item: Zotero.Item,
  prompt: string,
  source: "presentation_menu" | "presentation_button",
  settings: PresentationLaunchSettings,
  onTaskReady?: (focusTask: () => void) => void,
) => Promise<boolean>;

export function createDeferredPresentationFocus(): {
  requestFocus: () => void;
  setFocus: (focus: () => void) => void;
  clearFocus: () => void;
} {
  let focus: (() => void) | null = null;
  let focusRequested = false;
  return {
    requestFocus: () => {
      if (focus) {
        focus();
      } else {
        focusRequested = true;
      }
    },
    setFocus: (nextFocus) => {
      focus = nextFocus;
      if (focusRequested) {
        focusRequested = false;
        focus();
      }
    },
    clearFocus: () => {
      focus = null;
      focusRequested = false;
    },
  };
}

function isPdfAttachment(item: Zotero.Item): boolean {
  return (
    item.isPDFAttachment?.() === true ||
    (item.isAttachment?.() === true &&
      item.attachmentContentType === "application/pdf")
  );
}

/** Normalize a selected PDF to its paper, or keep an independent PDF as the source. */
export function resolvePresentationPaper(
  item: Zotero.Item | false | null | undefined,
): Zotero.Item | null {
  if (!item || item.isNote?.()) return null;
  if (item.isAttachment?.()) {
    if (!isPdfAttachment(item)) return null;
    if (!item.parentItemID) return item;
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

function showPresentationConcurrencyLimitDialog(parentWindow?: Window): void {
  Services.prompt.alert(
    (parentWindow || Zotero.getMainWindow()) as unknown as mozIDOMWindowProxy,
    getString("presentation-concurrency-limit-title"),
    getString("presentation-concurrency-limit-message", {
      args: { maximum: MAX_CONCURRENT_PRESENTATION_RUNS },
    }),
  );
}

async function runSharedPresentationGuard(
  onSettingsFocusReady?: (focus: () => void) => void,
  abortSignal?: AbortSignal,
) {
  return guardPresentationLaunch({
    providerManager: getProviderManager(),
    authManager: getAuthManager(),
    dialogs: createPresentationLaunchDialogs({
      onSettingsFocusReady,
      abortSignal,
    }),
    ensureLoggedIn: () => showAuthDialog("login"),
  });
}

async function runPresentationLaunch(
  item: Zotero.Item,
  source: PresentationLaunchSource,
  openPresentationChat: PresentationChatOpener,
  lifecycle: PresentationLaunchLifecycle,
  onSettingsFocusReady: (focus: () => void) => void,
  clearSettingsFocus: () => void,
): Promise<boolean> {
  const paper = resolvePresentationPaper(item);
  if (!paper || !paperHasPdf(paper)) {
    showMissingPdfDialog();
    return false;
  }

  const guardResult =
    await runSharedPresentationGuard(onSettingsFocusReady).finally(
      clearSettingsFocus,
    );
  if (!guardResult.allowed) return false;

  const taskFocus = createDeferredPresentationFocus();
  if (!lifecycle.beginRunning(taskFocus.requestFocus)) {
    return false;
  }

  const started = await openPresentationChat(
    paper,
    PRESENTATION_LAUNCH_PROMPT,
    source === "library_menu" ? "presentation_menu" : "presentation_button",
    guardResult.settings,
    taskFocus.setFocus,
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

/** Register the UI-only action used when another entry focuses a model task. */
export function registerPresentationTaskFocusHandler(
  handler: PresentationTaskFocusHandler,
): void {
  presentationTaskFocusHandler = handler;
}

export function unregisterPresentationTaskFocusHandler(): void {
  presentationTaskFocusHandler = null;
}

/**
 * Build the per-turn bridge used by the model-visible launcher. It reuses the
 * exact same balance/settings guard and launch coordinator as the toolbar and
 * library menu, but does not expose the resulting authorization to the model.
 */
export function createChatPresentationToolLaunchSession(
  item: Zotero.Item,
  location: PresentationTaskLocation,
  options: PresentationChatLaunchOptions = {},
): PresentationToolLaunchSession | null {
  const paper = resolveLaunchablePresentationPaper(item);
  if (!paper) return null;

  return createPresentationToolLaunchSession({
    coordinator: launchCoordinator,
    source: {
      itemKey: paper.key,
      libraryID: paper.libraryID,
    },
    abortSignal: options.abortSignal,
    runGuard: (onSettingsFocusReady) =>
      runSharedPresentationGuard(onSettingsFocusReady, options.abortSignal),
    focusTask: () => presentationTaskFocusHandler?.(paper, location),
    onCapacityExceeded: () =>
      showPresentationConcurrencyLimitDialog(options.parentWindow),
    onError: (error) => {
      ztoolkit.log(
        "[PresentationEntry] Model-triggered presentation launch failed:",
        error,
      );
    },
  });
}

export function canLaunchChatPresentationForItem(item: Zotero.Item): boolean {
  return resolveLaunchablePresentationPaper(item) !== null;
}

function resolveLaunchablePresentationPaper(
  item: Zotero.Item,
): Zotero.Item | null {
  const paper = resolvePresentationPaper(item);
  if (
    !paper ||
    !paperHasPdf(paper) ||
    !paper.key ||
    !Number.isSafeInteger(paper.libraryID)
  ) {
    return null;
  }
  return paper;
}

/**
 * Keep one launch per paper, focus its settings window or running task on a
 * repeated click, and let different papers run in parallel within the global
 * presentation concurrency limit.
 */
export function launchPresentationForItem(
  item: Zotero.Item,
  source: PresentationLaunchSource,
  openPresentationChat: PresentationChatOpener,
  parentWindow?: Window,
): Promise<boolean> {
  const paper = resolvePresentationPaper(item);
  const key = paper
    ? createPresentationLaunchKey({
        libraryID: paper.libraryID,
        itemKey: paper.key,
      })
    : `invalid:${item.id}`;
  const settingsFocus = createDeferredPresentationFocus();
  return launchCoordinator.enqueue(
    key,
    (lifecycle) =>
      runPresentationLaunch(
        item,
        source,
        openPresentationChat,
        lifecycle,
        settingsFocus.setFocus,
        settingsFocus.clearFocus,
      ),
    {
      focusConfiguration: settingsFocus.requestFocus,
      onCapacityExceeded: () =>
        showPresentationConcurrencyLimitDialog(parentWindow),
    },
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
      trackPaperChatPresentationEntryClicked(
        getAnalyticsService(),
        "library_menu",
      );
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
