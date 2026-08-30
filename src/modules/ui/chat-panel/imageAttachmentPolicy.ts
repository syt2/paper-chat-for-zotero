import { getString } from "../../../utils/locale";
import type { ChatManager } from "../../chat";
import { getModelRoutingMeta } from "../../preferences/ModelsFetcher";
import { getPaperChatApiCapabilities } from "../../providers/paperchat-routing-metadata";
import { getProviderManager } from "../../providers";

/** Shared limits for images kept in a chat draft or sent to a provider. */
export const MAX_PENDING_IMAGE_ATTACHMENTS = 6;
export const MAX_PENDING_IMAGE_BYTES = 1024 * 1024;
export const MAX_PENDING_IMAGE_DRAFT_BYTES = 4 * 1024 * 1024;

export type ImageInputAvailability = "supported" | "unsupported" | "unknown";

const IMAGE_INPUT_AVAILABILITY_DATASET_KEY = "imageInputAvailability";
type ImageInputRefreshState = {
  version: number;
  promise: Promise<ImageInputAvailability>;
};
const imageInputRefreshes = new WeakMap<HTMLElement, ImageInputRefreshState>();

export function getImageInputAvailability(
  container: HTMLElement,
): ImageInputAvailability {
  const value = container.dataset[IMAGE_INPUT_AVAILABILITY_DATASET_KEY];
  return value === "supported" || value === "unsupported" ? value : "unknown";
}

export function applyImageInputAvailability(
  container: HTMLElement,
  availability: ImageInputAvailability,
): void {
  container.dataset[IMAGE_INPUT_AVAILABILITY_DATASET_KEY] = availability;
  const figureScreenshotBtn = container.querySelector(
    "#chat-figure-screenshot-btn",
  ) as HTMLButtonElement | null;
  if (figureScreenshotBtn) {
    figureScreenshotBtn.hidden = availability === "unsupported";
    figureScreenshotBtn.style.display =
      availability === "unsupported" ? "none" : "";
  }
}

export function getResolvedImageInputAvailability(
  chatManager: ChatManager,
): ImageInputAvailability {
  let activeProviderId: string | null;
  try {
    activeProviderId = getProviderManager().getActiveProviderId();
  } catch {
    return "unknown";
  }
  if (activeProviderId !== "paperchat") {
    return "unknown";
  }
  const modelId = chatManager.getActiveSession()?.resolvedModelId;
  if (!modelId) {
    return "unknown";
  }
  const vision = getPaperChatApiCapabilities(
    modelId,
    getModelRoutingMeta(),
  ).vision;
  return vision === true
    ? "supported"
    : vision === false
      ? "unsupported"
      : "unknown";
}

/**
 * Resolve the active PaperChat auto/tier selection to a concrete model and
 * synchronize image-only controls. Other providers and missing metadata keep
 * the existing UI behavior through the "unknown" state.
 */
export function refreshImageInputAvailability(
  container: HTMLElement,
  chatManager: ChatManager,
): Promise<ImageInputAvailability> {
  const refreshVersion = (imageInputRefreshes.get(container)?.version ?? 0) + 1;
  const promise = runImageInputAvailabilityRefresh(
    container,
    chatManager,
    refreshVersion,
  );
  imageInputRefreshes.set(container, { version: refreshVersion, promise });
  return promise;
}

function getSupersedingImageInputRefresh(
  container: HTMLElement,
  refreshVersion: number,
): Promise<ImageInputAvailability> | null {
  const latest = imageInputRefreshes.get(container);
  return latest && latest.version > refreshVersion ? latest.promise : null;
}

async function runImageInputAvailabilityRefresh(
  container: HTMLElement,
  chatManager: ChatManager,
  refreshVersion: number,
): Promise<ImageInputAvailability> {
  let availability: ImageInputAvailability = "unknown";
  let activeProviderId: string | null = null;
  try {
    activeProviderId = getProviderManager().getActiveProviderId();
  } catch {
    // Tests and shutdown may not have a usable provider runtime.
  }

  const activeSession = chatManager.getActiveSession();
  if (activeProviderId === "paperchat" && activeSession) {
    try {
      const modelId = await chatManager.ensureCurrentPaperChatModelResolved();
      if (
        getProviderManager().getActiveProviderId() !== "paperchat" ||
        chatManager.getActiveSession() !== activeSession
      ) {
        return (
          getSupersedingImageInputRefresh(container, refreshVersion) ??
          getImageInputAvailability(container)
        );
      }
      if (modelId) {
        availability = getResolvedImageInputAvailability(chatManager);
      }
    } catch (error) {
      ztoolkit.log(
        "[Chat] Could not resolve image-input availability; preserving current UI:",
        error,
      );
      return (
        getSupersedingImageInputRefresh(container, refreshVersion) ??
        getImageInputAvailability(container)
      );
    }
  }

  const supersedingRefresh = getSupersedingImageInputRefresh(
    container,
    refreshVersion,
  );
  if (supersedingRefresh) {
    return supersedingRefresh;
  }
  applyImageInputAvailability(container, availability);
  return availability;
}

export function getImageAttachmentLimitMessage(): string {
  return getString("chat-image-attachment-limit", {
    args: {
      maxImageMiB: MAX_PENDING_IMAGE_BYTES / (1024 * 1024),
      maxImages: MAX_PENDING_IMAGE_ATTACHMENTS,
      maxDraftMiB: MAX_PENDING_IMAGE_DRAFT_BYTES / (1024 * 1024),
    },
  });
}
