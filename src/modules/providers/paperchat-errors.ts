import { getString } from "../../utils/locale";

export interface PaperChatQuotaErrorDetails {
  displayMessage: string;
  rawMessage: string;
}

export interface PaperChatParsedError {
  message: string;
  code?: string;
}

export interface PaperChatModelUnavailableErrorDetails {
  model: string | null;
}

interface PaperChatErrorPayload {
  error?: {
    message?: unknown;
    code?: unknown;
  };
}

function normalizeErrorField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function extractErrorPayload(raw: string): PaperChatErrorPayload | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    return JSON.parse(jsonMatch[0]) as PaperChatErrorPayload;
  } catch {
    return null;
  }
}

export function parsePaperChatError(raw: string): PaperChatParsedError {
  const payload = extractErrorPayload(raw);
  const message = normalizeErrorField(payload?.error?.message);
  return {
    message: message || raw,
    code: normalizeErrorField(payload?.error?.code),
  };
}

function extractUnavailableModelName(raw: string): string | null {
  const patterns = [
    /下模型\s*["“]?([^"”\s，,（）()]+)["”]?\s*无可用渠道/i,
    /model\s+["“]?([^"”\s，,（）()]+)["”]?\s+(?:has no available channel|no available channel)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function parsePaperChatModelUnavailableError(
  raw: string,
): PaperChatModelUnavailableErrorDetails | null {
  const { message } = parsePaperChatError(raw);
  const combined = `${raw}\n${message}`;
  if (
    !combined.includes("无可用渠道") &&
    !/no available channel/i.test(combined)
  ) {
    return null;
  }
  return {
    model: extractUnavailableModelName(combined),
  };
}

export function getPaperChatErrorDisplayMessage(raw: string): string {
  const unavailable = parsePaperChatModelUnavailableError(raw);
  if (unavailable) {
    return unavailable.model
      ? getString("chat-error-model-unavailable", {
          args: { model: unavailable.model },
        })
      : getString("chat-error-model-unavailable-unknown");
  }
  return parsePaperChatError(raw).message;
}

export function parsePaperChatQuotaError(
  raw: string,
): PaperChatQuotaErrorDetails | null {
  const { message, code } = parsePaperChatError(raw);
  const normalized = `${raw}\n${message}\n${code || ""}`.toLowerCase();

  const isQuotaError =
    code === "insufficient_quota" ||
    code === "insufficient_user_quota" ||
    normalized.includes("insufficient_quota") ||
    normalized.includes("insufficient_user_quota") ||
    normalized.includes("insufficient quota") ||
    normalized.includes("额度不足");

  if (!isQuotaError) {
    return null;
  }

  return {
    displayMessage: getString("chat-error-paperchat-insufficient-quota"),
    rawMessage: message,
  };
}

export function isPaperChatQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return parsePaperChatQuotaError(message) !== null;
}
