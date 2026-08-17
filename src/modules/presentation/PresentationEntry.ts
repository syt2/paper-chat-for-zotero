import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import {
  getAnalyticsService,
  trackPaperChatPresentationEntryClicked,
} from "../analytics";
import { getAuthManager } from "../auth";
import { getProviderManager } from "../providers";
import {
  parseTierState,
  type PaperChatTier,
} from "../providers/paperchat-tier-routing";
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
  type PresentationLaunchIntent,
  type PresentationLaunchSourceResolution,
  type PresentationToolLaunchSession,
} from "./PresentationToolLaunchSession";
import type { PresentationMentionSource } from "./PresentationSourceContext";
import type {
  PresentationChatLaunchOptions,
  PresentationTaskLocation,
} from "./PresentationChatLaunchBridge";

const PRESENTATION_ITEM_MENU_ID = "paperchat-generate-presentation-menuitem";
const launchCoordinator = new PresentationLaunchCoordinator();

function getConfiguredPaperChatTier(): PaperChatTier {
  try {
    return parseTierState(getPref("paperchatTierState") as string | undefined)
      .selectedTier;
  } catch {
    // Preferences may be unavailable during startup/tests. Standard is the
    // established fallback and keeps the launch gate permissive.
    return "paperchat-standard";
  }
}

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
  try {
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
  } catch {
    // Zotero items can become stale while a reader/library view is changing.
    // Treat that as an unavailable source instead of rejecting the launcher.
    return null;
  }
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
  try {
    if (isPdfAttachment(item)) return true;
    if (item.isAttachment?.() || item.isNote?.()) return false;
    return (item.getAttachments?.() || []).some((attachmentID) => {
      try {
        const attachment = Zotero.Items.get(attachmentID) as
          | Zotero.Item
          | false;
        return !!attachment && isPdfAttachment(attachment);
      } catch {
        return false;
      }
    });
  } catch {
    // See resolvePresentationPaper: a stale item should fail closed.
    return false;
  }
}

function getPresentationLibraryIDs(): number[] {
  const ids: number[] = [];
  const add = (value: unknown) => {
    if (Number.isSafeInteger(value) && (value as number) > 0) {
      const id = value as number;
      if (!ids.includes(id)) ids.push(id);
    }
  };
  try {
    add(Zotero.Libraries?.userLibraryID);
    for (const library of Zotero.Libraries?.getAll?.() || []) {
      add(typeof library === "number" ? library : library?.libraryID);
    }
  } catch {
    // Early startup and unit tests may not expose the library registry.
  }
  return ids;
}

function getPresentationItemByKey(
  itemKey: string,
  libraryID: number,
): Zotero.Item | null {
  try {
    return (
      (Zotero.Items.getByLibraryAndKey(libraryID, itemKey) as
        | Zotero.Item
        | false) || null
    );
  } catch {
    return null;
  }
}

function resolvePresentationSourceCandidate(
  itemKey: string,
  libraryID: number | undefined,
): { paper: Zotero.Item; libraryID: number } | { ambiguous: true } | null {
  const candidates: Array<{ paper: Zotero.Item; libraryID: number }> = [];
  const libraries = libraryID ? [libraryID] : getPresentationLibraryIDs();
  for (const candidateLibraryID of libraries) {
    const item = getPresentationItemByKey(itemKey, candidateLibraryID);
    const paper = item ? resolvePresentationPaper(item) : null;
    if (!paper || !paperHasPdf(paper)) continue;
    const resolvedLibraryID = Number.isSafeInteger(paper.libraryID)
      ? paper.libraryID
      : candidateLibraryID;
    if (
      !candidates.some(
        (candidate) =>
          candidate.paper.key === paper.key &&
          candidate.libraryID === resolvedLibraryID,
      )
    ) {
      candidates.push({ paper, libraryID: resolvedLibraryID });
    }
  }
  if (candidates.length > 1) return { ambiguous: true };
  if (candidates.length === 0) return null;
  return candidates[0];
}

/** Return whether a key belongs to the paper itself or one of its PDF attachments. */
function paperContainsPresentationSourceKey(
  paper: Zotero.Item,
  sourceKey: string,
): boolean {
  if (paper.key === sourceKey) return true;
  try {
    return (paper.getAttachments?.() || []).some((attachmentID) => {
      try {
        const attachment = Zotero.Items.get(attachmentID) as
          | Zotero.Item
          | false;
        return !!attachment && attachment.key === sourceKey;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Resolve a model suggestion to one concrete Zotero paper before opening the
 * expensive settings flow. This function only parses explicit identifiers;
 * it never guesses intent from natural language.
 */
export function resolvePresentationLaunchSource(
  intent: PresentationLaunchIntent,
  fallbackItem?: Zotero.Item | null,
  mentionSources: readonly PresentationMentionSource[] = [],
): PresentationLaunchSourceResolution {
  const fallbackPaper = resolvePresentationPaper(fallbackItem);
  const requestedKey =
    typeof intent.sourceItemKey === "string" && intent.sourceItemKey.trim()
      ? intent.sourceItemKey.trim()
      : undefined;
  let requestedLibraryID = Number.isSafeInteger(intent.sourceLibraryID)
    ? intent.sourceLibraryID
    : undefined;

  const uniqueMentionKeys = new Map<string, PresentationMentionSource>();
  for (const mention of mentionSources) {
    const itemKey =
      typeof mention.itemKey === "string" ? mention.itemKey.trim() : "";
    if (!itemKey) continue;
    const libraryID =
      Number.isSafeInteger(mention.libraryID) && mention.libraryID! > 0
        ? mention.libraryID
        : undefined;
    uniqueMentionKeys.set(`${libraryID || 0}:${itemKey}`, {
      ...mention,
      itemKey,
      ...(libraryID ? { libraryID } : {}),
    });
  }

  const mentionedSources = [...uniqueMentionKeys.values()];
  if (mentionedSources.length > 0) {
    let mentioned: PresentationMentionSource | undefined;
    if (requestedKey) {
      const matchingMentions = mentionedSources.filter(
        (mention) => mention.itemKey === requestedKey,
      );
      if (matchingMentions.length === 0) {
        // An explicit selector marker is app-authored source identity. Do not
        // let a hallucinated model key silently redirect the task elsewhere.
        return { allowed: false, reason: "source_ambiguous" };
      }
      if (requestedLibraryID !== undefined) {
        mentioned = matchingMentions.find(
          (mention) => mention.libraryID === requestedLibraryID,
        );
        if (!mentioned) {
          return { allowed: false, reason: "source_ambiguous" };
        }
      } else if (matchingMentions.length === 1) {
        mentioned = matchingMentions[0];
      } else {
        // A key-only model argument cannot choose between duplicate keys in
        // different libraries, even when the user included both markers.
        return { allowed: false, reason: "source_ambiguous" };
      }
      // A legacy key-only marker still does not authorize the model to invent
      // a library. Let the resolver detect whether that key is globally unique.
      requestedLibraryID = mentioned.libraryID;
    } else if (mentionedSources.length === 1) {
      mentioned = mentionedSources[0];
      requestedLibraryID = mentioned.libraryID;
    } else {
      return { allowed: false, reason: "source_ambiguous" };
    }

    if (!mentioned) return { allowed: false, reason: "source_ambiguous" };
    const resolved = resolvePresentationSourceCandidate(
      mentioned.itemKey,
      requestedLibraryID,
    );
    if (resolved && "paper" in resolved) {
      return {
        allowed: true,
        source: { itemKey: resolved.paper.key, libraryID: resolved.libraryID },
      };
    }
    return {
      allowed: false,
      reason:
        resolved && "ambiguous" in resolved
          ? "source_ambiguous"
          : "source_unavailable",
    };
  }

  if (requestedKey) {
    // When a reader paper is already bound to this turn, keep that exact
    // library identity even if the model repeats only the key. A key can be
    // reused in group libraries, so scanning every library here would turn a
    // normal current-paper request into a false ambiguity (or a redirect).
    if (fallbackPaper) {
      if (!paperHasPdf(fallbackPaper)) {
        return { allowed: false, reason: "source_unavailable" };
      }
      const fallbackLibraryID = Number.isSafeInteger(fallbackPaper.libraryID)
        ? fallbackPaper.libraryID
        : undefined;
      // The reader/chat context can be bound to the PDF attachment while the
      // presentation source is the parent paper. The model is then expected
      // to repeat the context key, which is the attachment key, even though
      // the normalized fallback paper has the parent item's key. Treat that
      // attachment as an alias only when it resolves back to this exact
      // fallback paper; never use it to redirect to an unrelated item.
      const requestedSource =
        paperContainsPresentationSourceKey(fallbackPaper, requestedKey) ||
        requestedKey === fallbackItem?.key
          ? { paper: fallbackPaper, libraryID: fallbackLibraryID }
          : fallbackLibraryID !== undefined
            ? resolvePresentationSourceCandidate(
                requestedKey,
                fallbackLibraryID,
              )
            : null;
      const matchesFallbackPaper =
        requestedSource &&
        "paper" in requestedSource &&
        requestedSource.paper.key === fallbackPaper.key &&
        requestedSource.libraryID === fallbackLibraryID;
      if (matchesFallbackPaper) {
        if (fallbackLibraryID === undefined) {
          return { allowed: false, reason: "source_unavailable" };
        }
        if (
          requestedLibraryID !== undefined &&
          requestedLibraryID !== fallbackLibraryID
        ) {
          return { allowed: false, reason: "source_ambiguous" };
        }
        return {
          allowed: true,
          source: {
            itemKey: fallbackPaper.key,
            libraryID: fallbackLibraryID,
          },
        };
      }
      // A different key must come from an explicit @mention. Do not let a
      // model-generated identifier silently redirect a current-paper task.
      return { allowed: false, reason: "source_ambiguous" };
    }
    const resolved = resolvePresentationSourceCandidate(
      requestedKey,
      requestedLibraryID,
    );
    if (resolved && "paper" in resolved) {
      return {
        allowed: true,
        source: { itemKey: resolved.paper.key, libraryID: resolved.libraryID },
      };
    }
    // An explicit key with no unique PDF source must never silently fall back
    // to the paper currently open in the reader.
    return {
      allowed: false,
      reason:
        resolved && "ambiguous" in resolved
          ? "source_ambiguous"
          : "source_unavailable",
    };
  }

  if (
    fallbackPaper &&
    paperHasPdf(fallbackPaper) &&
    Number.isSafeInteger(fallbackPaper.libraryID)
  ) {
    return {
      allowed: true,
      source: {
        itemKey: fallbackPaper.key,
        libraryID: fallbackPaper.libraryID,
      },
    };
  }

  let selected: Zotero.Item | null = null;
  try {
    selected = getSingleSelectedPresentationPaper();
  } catch {
    // The Zotero pane is unavailable during startup and in Node tests.
  }
  if (
    selected &&
    paperHasPdf(selected) &&
    Number.isSafeInteger(selected.libraryID)
  ) {
    return {
      allowed: true,
      source: { itemKey: selected.key, libraryID: selected.libraryID },
    };
  }
  return { allowed: false, reason: "source_unavailable" };
}

export function getSingleSelectedPresentationPaper(): Zotero.Item | null {
  try {
    const selected =
      (Zotero.getActiveZoteroPane()?.getSelectedItems() as
        | Zotero.Item[]
        | undefined) || [];
    if (selected.length !== 1) return null;
    return resolvePresentationPaper(selected[0]);
  } catch {
    // The active pane is unavailable during early startup and some tests.
    return null;
  }
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

async function runSharedPresentationGuard(options: {
  onSettingsFocusReady?: (focus: () => void) => void;
  abortSignal?: AbortSignal;
  suggestedSettings?: Partial<PresentationLaunchSettings>;
  paperChatTier?: PaperChatTier;
}) {
  return guardPresentationLaunch({
    providerManager: getProviderManager(),
    authManager: getAuthManager(),
    dialogs: createPresentationLaunchDialogs({
      onSettingsFocusReady: options.onSettingsFocusReady,
      abortSignal: options.abortSignal,
    }),
    ensureLoggedIn: () => showAuthDialog("login"),
    suggestedSettings: options.suggestedSettings,
    paperChatTier: options.paperChatTier,
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

  const guardResult = await runSharedPresentationGuard({
    onSettingsFocusReady,
    paperChatTier: getConfiguredPaperChatTier(),
  }).finally(clearSettingsFocus);
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
  item: Zotero.Item | null,
  location: PresentationTaskLocation,
  options: PresentationChatLaunchOptions = {},
): PresentationToolLaunchSession | null {
  // Bind the library selection when the chat turn starts. The model round can
  // take several seconds, so resolving the selection later could silently
  // switch the source if the user clicks another Zotero row meanwhile.
  const paper = item
    ? resolveLaunchablePresentationPaper(item)
    : resolveLaunchablePresentationPaper(getSingleSelectedPresentationPaper());
  const fallbackSource = paper
    ? { itemKey: paper.key, libraryID: paper.libraryID }
    : undefined;
  let resolvedSource = fallbackSource;

  return createPresentationToolLaunchSession({
    coordinator: launchCoordinator,
    source: fallbackSource,
    resolveSource: (intent) => {
      const resolution = resolvePresentationLaunchSource(
        intent,
        paper,
        options.mentionSources || [],
      );
      if (resolution.allowed) resolvedSource = resolution.source;
      return resolution;
    },
    abortSignal: options.abortSignal,
    runGuard: (onSettingsFocusReady, suggestedSettings) =>
      runSharedPresentationGuard({
        onSettingsFocusReady,
        abortSignal: options.abortSignal,
        suggestedSettings,
        paperChatTier: options.paperChatTier ?? getConfiguredPaperChatTier(),
      }),
    focusTask: () => {
      const resolvedPaper =
        resolvedSource?.itemKey &&
        Number.isSafeInteger(resolvedSource.libraryID)
          ? resolvePresentationPaper(
              getPresentationItemByKey(
                resolvedSource.itemKey,
                resolvedSource.libraryID!,
              ),
            )
          : paper;
      if (resolvedPaper)
        presentationTaskFocusHandler?.(resolvedPaper, location);
    },
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

export function canLaunchChatPresentationForItem(
  item: Zotero.Item | null,
): boolean {
  const candidate = item || getSingleSelectedPresentationPaper();
  return resolveLaunchablePresentationPaper(candidate) !== null;
}

function resolveLaunchablePresentationPaper(
  item: Zotero.Item | null,
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
