import { getString } from "../../../utils/locale";

/** Shared limits for images kept in a chat draft or sent to a provider. */
export const MAX_PENDING_IMAGE_ATTACHMENTS = 6;
export const MAX_PENDING_IMAGE_BYTES = 1024 * 1024;
export const MAX_PENDING_IMAGE_DRAFT_BYTES = 4 * 1024 * 1024;

export function getImageAttachmentLimitMessage(): string {
  return getString("chat-image-attachment-limit", {
    args: {
      maxImageMiB: MAX_PENDING_IMAGE_BYTES / (1024 * 1024),
      maxImages: MAX_PENDING_IMAGE_ATTACHMENTS,
      maxDraftMiB: MAX_PENDING_IMAGE_DRAFT_BYTES / (1024 * 1024),
    },
  });
}
