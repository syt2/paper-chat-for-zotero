import { getPaperChatUrl } from "./PaperChatUrls";

interface PaperChatNoticeApiResponse {
  success?: boolean;
  data?: unknown;
  message?: string;
}

let cachedNotice: string | null = null;
let inFlightRequest: Promise<string | null> | null = null;
let requestGeneration = 0;
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

export function setPaperChatNoticeDebugOverride(
  content: string,
): string | null {
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

export function resetPaperChatNoticeCache(): void {
  requestGeneration += 1;
  cachedNotice = null;
  inFlightRequest = null;
}

export async function refreshPaperChatNotice(): Promise<string | null> {
  if (inFlightRequest) {
    return inFlightRequest;
  }

  const url = getPaperChatUrl("/api/notice");
  const generation = requestGeneration;
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
        return generation === requestGeneration ? cachedNotice : null;
      }

      const payload =
        (await response.json()) as PaperChatNoticeApiResponse | null;
      if (!payload?.success) {
        if (generation === requestGeneration) {
          cachedNotice = null;
        }
        return null;
      }

      const notice = normalizeNoticePayload(payload.data);
      if (generation === requestGeneration) {
        cachedNotice = notice;
      }
      return notice;
    } catch (error) {
      ztoolkit.log("[PaperChatNotice] Request error:", error);
      return generation === requestGeneration ? cachedNotice : null;
    } finally {
      if (generation === requestGeneration) {
        inFlightRequest = null;
      }
    }
  })();

  return inFlightRequest;
}
