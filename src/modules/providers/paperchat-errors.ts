import { getString } from "../../utils/locale";

export interface PaperChatQuotaErrorDetails {
  displayMessage: string;
  rawMessage: string;
}

interface PaperChatErrorPayload {
  error?: {
    message?: string;
    code?: string;
  };
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

function extractErrorMessage(raw: string): {
  message: string;
  code?: string;
} {
  const payload = extractErrorPayload(raw);
  const message = payload?.error?.message?.trim();
  return {
    message: message || raw,
    code: payload?.error?.code?.trim(),
  };
}

export function getPaperChatErrorDisplayMessage(raw: string): string {
  return extractErrorMessage(raw).message;
}

export function parsePaperChatQuotaError(
  raw: string,
): PaperChatQuotaErrorDetails | null {
  const { message, code } = extractErrorMessage(raw);
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
