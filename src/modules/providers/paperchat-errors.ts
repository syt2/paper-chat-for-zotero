import { getString } from "../../utils/locale";

export interface PaperChatQuotaErrorDetails {
  displayMessage: string;
  rawMessage: string;
}

export interface PaperChatParsedError {
  message: string;
  code?: string;
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

export function getPaperChatErrorDisplayMessage(raw: string): string {
  return parsePaperChatError(raw).message;
}

export function parsePaperChatQuotaError(
  raw: string,
): PaperChatQuotaErrorDetails | null {
  const { message, code } = parsePaperChatError(raw);
  const normalized = `${raw}\n${message}\n${code || ""}`.toLowerCase();

  const isQuotaError =
    code === "insufficient_user_quota" ||
    normalized.includes("insufficient_user_quota");

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
