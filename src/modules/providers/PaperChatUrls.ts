import { getPref } from "../../utils/prefs";

export const DEFAULT_PAPERCHAT_SITE_BASE_URL = "https://paperchat.zotero.store";
export const DEFAULT_PAPERCHAT_API_BASE_URL = `${DEFAULT_PAPERCHAT_SITE_BASE_URL}/v1`;

export function isPaperChatBaseUrlOverrideAllowed(): boolean {
  return typeof __env__ !== "undefined" && __env__ !== "production";
}

export function normalizePaperChatSiteBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    if (parsed.pathname.toLowerCase().endsWith("/v1")) {
      parsed.pathname = parsed.pathname.slice(0, -3).replace(/\/+$/, "");
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function getPaperChatBaseUrlOverride(): string | null {
  if (!isPaperChatBaseUrlOverrideAllowed()) {
    return null;
  }

  try {
    const value = getPref("paperchatBaseUrlOverride");
    return typeof value === "string"
      ? normalizePaperChatSiteBaseUrl(value)
      : null;
  } catch {
    return null;
  }
}

export function getPaperChatSiteBaseUrl(): string {
  return getPaperChatBaseUrlOverride() || DEFAULT_PAPERCHAT_SITE_BASE_URL;
}

export function getPaperChatApiBaseUrl(): string {
  return `${getPaperChatSiteBaseUrl()}/v1`;
}

export function getPaperChatUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${getPaperChatSiteBaseUrl()}${suffix}`;
}
