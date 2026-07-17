import { ChatHistorySearchError } from "./SearchTypes";

export const SEARCH_RANKING_VERSION = 1;
export const SEARCH_NORMALIZATION_VERSION = 1;

export interface SessionSearchOrder {
  category: number;
  sessionUpdatedAt: number;
  sessionId: string;
}

export interface MessageSearchOrder {
  category: number;
  messageTimestamp: number;
  messageSeq: number;
  messageId: string;
}

interface SessionCursorPayload {
  version: 1;
  kind: "session";
  queryKey: string;
  searchRevision: number;
  order: SessionSearchOrder;
}

interface MessageCursorPayload {
  version: 1;
  kind: "message";
  queryKey: string;
  searchRevision: number;
  sessionId: string;
  order: MessageSearchOrder;
}

export type SearchCursorPayload = SessionCursorPayload | MessageCursorPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSessionSearchOrder(value: unknown): value is SessionSearchOrder {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.category) &&
    Number(value.category) >= 0 &&
    Number(value.category) <= 3 &&
    isFiniteNumber(value.sessionUpdatedAt) &&
    isNonEmptyString(value.sessionId)
  );
}

function isMessageSearchOrder(value: unknown): value is MessageSearchOrder {
  if (!isRecord(value)) return false;
  return (
    (value.category === 0 || value.category === 1) &&
    isFiniteNumber(value.messageTimestamp) &&
    isSafeNonNegativeInteger(value.messageSeq) &&
    isNonEmptyString(value.messageId)
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ChatHistorySearchError("INVALID_CURSOR", "Invalid cursor");
  }
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new ChatHistorySearchError("INVALID_CURSOR", "Invalid cursor");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeSearchCursor(payload: SearchCursorPayload): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

export function decodeSearchCursor(value: string): SearchCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
  } catch (error) {
    if (error instanceof ChatHistorySearchError) {
      throw error;
    }
    throw new ChatHistorySearchError("INVALID_CURSOR", "Invalid cursor");
  }

  if (!isRecord(parsed)) {
    throw new ChatHistorySearchError("INVALID_CURSOR", "Invalid cursor");
  }
  if (
    parsed.version !== 1 ||
    (parsed.kind !== "session" && parsed.kind !== "message") ||
    !isNonEmptyString(parsed.queryKey) ||
    !isSafeNonNegativeInteger(parsed.searchRevision)
  ) {
    throw new ChatHistorySearchError("INVALID_CURSOR", "Invalid cursor");
  }

  if (parsed.kind === "session") {
    if (!isSessionSearchOrder(parsed.order)) {
      throw new ChatHistorySearchError("INVALID_CURSOR", "Invalid cursor");
    }
    return parsed as unknown as SessionCursorPayload;
  }

  if (
    !isNonEmptyString(parsed.sessionId) ||
    !isMessageSearchOrder(parsed.order)
  ) {
    throw new ChatHistorySearchError("INVALID_CURSOR", "Invalid cursor");
  }
  return parsed as unknown as MessageCursorPayload;
}

export async function createSearchQueryKey(
  revisionEpoch: string,
  normalizedQuery: string,
): Promise<string> {
  const input = [
    revisionEpoch,
    SEARCH_RANKING_VERSION,
    SEARCH_NORMALIZATION_VERSION,
    normalizedQuery,
  ].join("\u001f");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ChatHistorySearchError(
      "SEARCH_UNAVAILABLE",
      "SHA-256 is unavailable",
    );
  }
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function compareUtf8Bytes(left: string, right: string): number {
  if (left === right) return 0;
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] < rightBytes[index] ? -1 : 1;
    }
  }
  return leftBytes.length < rightBytes.length ? -1 : 1;
}

export function compareSessionSearchOrder(
  left: SessionSearchOrder,
  right: SessionSearchOrder,
): number {
  if (left.category !== right.category) {
    return left.category - right.category;
  }
  if (left.sessionUpdatedAt !== right.sessionUpdatedAt) {
    return right.sessionUpdatedAt - left.sessionUpdatedAt;
  }
  return compareUtf8Bytes(left.sessionId, right.sessionId);
}

export function compareMessageSearchOrder(
  left: MessageSearchOrder,
  right: MessageSearchOrder,
): number {
  if (left.category !== right.category) {
    return left.category - right.category;
  }
  if (left.messageTimestamp !== right.messageTimestamp) {
    return right.messageTimestamp - left.messageTimestamp;
  }
  if (left.messageSeq !== right.messageSeq) {
    return right.messageSeq - left.messageSeq;
  }
  return compareUtf8Bytes(left.messageId, right.messageId);
}
