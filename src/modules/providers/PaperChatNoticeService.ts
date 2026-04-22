import { BUILTIN_PROVIDERS } from "./ProviderManager";

interface PaperChatNoticeApiResponse {
  success?: boolean;
  data?: unknown;
  message?: string;
}

let cachedNotice: string | null = null;
let inFlightRequest: Promise<string | null> | null = null;
let debugNoticeOverride: string | null = null;
let hasDebugNoticeOverride = false;

function isDebugNoticeOverrideAllowed(): boolean {
  return typeof __env__ !== "undefined" && __env__ !== "production";
}

function normalizeNoticePayload(data: unknown): string | null {
  if (typeof data !== "string") {
    return null;
  }
  const trimmed = data.trim();
  return trimmed ? trimmed : null;
}

export function getCachedPaperChatNotice(): string | null {
  if (isDebugNoticeOverrideAllowed() && hasDebugNoticeOverride) {
    return debugNoticeOverride;
  }
  return cachedNotice;
}

export function getPaperChatNoticeDebugOverride(): string | null {
  return isDebugNoticeOverrideAllowed() && hasDebugNoticeOverride
    ? debugNoticeOverride
    : null;
}

export function hasPaperChatNoticeDebugOverrideEnabled(): boolean {
  return isDebugNoticeOverrideAllowed() && hasDebugNoticeOverride;
}

export function setPaperChatNoticeDebugOverride(content: string): string | null {
  if (!isDebugNoticeOverrideAllowed()) {
    return null;
  }
  debugNoticeOverride = normalizeNoticePayload(content);
  hasDebugNoticeOverride = true;
  return debugNoticeOverride;
}

export function clearPaperChatNoticeDebugOverride(): void {
  if (!isDebugNoticeOverrideAllowed()) {
    return;
  }
  debugNoticeOverride = null;
  hasDebugNoticeOverride = false;
}

export async function refreshPaperChatNotice(): Promise<string | null> {
  if (inFlightRequest) {
    return inFlightRequest;
  }

  const url = `${BUILTIN_PROVIDERS.paperchat.website}/api/notice`;
  inFlightRequest = (async () => {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        ztoolkit.log(
          "[PaperChatNotice] Request failed:",
          response.status,
          response.statusText,
        );
        return cachedNotice;
      }

      const payload =
        (await response.json()) as PaperChatNoticeApiResponse | null;
      if (!payload?.success) {
        cachedNotice = null;
        return null;
      }

      cachedNotice = normalizeNoticePayload(payload.data);
      return cachedNotice;
    } catch (error) {
      ztoolkit.log("[PaperChatNotice] Request error:", error);
      return cachedNotice;
    } finally {
      inFlightRequest = null;
    }
  })();

  return inFlightRequest;
}
