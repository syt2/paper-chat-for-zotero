import type { ApiKeyProviderConfig } from "../../../types/provider";
import { getProviderManager } from "../../providers";

export const DEFAULT_OFFICIAL_DEEPSEEK_API_BASE_URL =
  "https://api.deepseek.com/v1";

export function isOfficialDeepSeekBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

export function normalizeDeepSeekToolsBaseUrl(baseUrl?: string): string {
  const trimmed = (
    baseUrl?.trim() || DEFAULT_OFFICIAL_DEEPSEEK_API_BASE_URL
  ).replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * The active API-key provider when it points at DeepSeek's official API.
 * Custom providers that target the official host are supported too.
 */
export function getOfficialDeepSeekProviderConfig(): ApiKeyProviderConfig | null {
  try {
    const manager = getProviderManager();
    const config = manager.getProviderConfig(manager.getActiveProviderId());
    if (
      !config ||
      config.type === "paperchat" ||
      config.type === "anthropic" ||
      config.type === "gemini" ||
      !config.apiKey.trim()
    ) {
      return null;
    }
    const baseUrl =
      config.baseUrl.trim() ||
      (config.id === "deepseek" ? DEFAULT_OFFICIAL_DEEPSEEK_API_BASE_URL : "");
    if (!isOfficialDeepSeekBaseUrl(baseUrl)) {
      return null;
    }
    return config;
  } catch {
    return null;
  }
}

export function isOfficialDeepSeekSearchAvailable(): boolean {
  return getOfficialDeepSeekProviderConfig() !== null;
}

export function getOfficialDeepSeekSearchBaseUrl(): string {
  return normalizeDeepSeekToolsBaseUrl(
    getOfficialDeepSeekProviderConfig()?.baseUrl,
  );
}

export function getOfficialDeepSeekSearchApiKey(): string | null {
  return getOfficialDeepSeekProviderConfig()?.apiKey.trim() || null;
}
