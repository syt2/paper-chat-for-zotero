import type { PresentationToolCardArtifact } from "../../types/chat";

export const MAX_PRESENTATION_ARTIFACTS_PER_MESSAGE = 8;
export const MAX_PRESENTATION_PREVIEWS_PER_ARTIFACT = 8;

const MAX_TOOL_CALL_ID_CHARACTERS = 512;
const MAX_LOCAL_PATH_CHARACTERS = 4096;

function readBoundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_TOOL_CALL_ID_CHARACTERS ||
    hasControlCharacters(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function readBoundedLocalPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_LOCAL_PATH_CHARACTERS ||
    hasControlCharacters(normalized)
  ) {
    return undefined;
  }
  const isAbsoluteLocalPath =
    normalized.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(normalized) ||
    normalized.startsWith("\\\\");
  if (!isAbsoluteLocalPath) return undefined;
  return normalized;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isTerminalPresentationArtifact(
  artifact: PresentationToolCardArtifact,
): boolean {
  return artifact.isDraft === false || artifact.attachmentItemID !== undefined;
}

/**
 * Normalize the app-owned artifact side channel stored with an assistant
 * message. This establishes a bounded structural contract only; callers that
 * open a path must still authorize it against PaperChat/Zotero trusted roots.
 */
export function normalizePresentationArtifacts(
  value: unknown,
): PresentationToolCardArtifact[] {
  if (!Array.isArray(value)) return [];

  const normalized: PresentationToolCardArtifact[] = [];
  const seenArtifactIds = new Set<string>();
  for (const candidate of value) {
    if (
      normalized.length >= MAX_PRESENTATION_ARTIFACTS_PER_MESSAGE ||
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }

    const raw = candidate as Record<string, unknown>;
    const toolCallId = readBoundedIdentifier(raw.toolCallId);
    const localId = readBoundedIdentifier(raw.localId);
    if (!toolCallId) continue;
    const artifactId = localId || toolCallId;
    if (seenArtifactIds.has(artifactId)) continue;

    const path = readBoundedLocalPath(raw.path);
    const previewPaths = Array.isArray(raw.previewPaths)
      ? [
          ...new Set(
            raw.previewPaths
              .map(readBoundedLocalPath)
              .filter((entry): entry is string => Boolean(entry)),
          ),
        ].slice(0, MAX_PRESENTATION_PREVIEWS_PER_ARTIFACT)
      : [];
    const attachmentItemID =
      typeof raw.attachmentItemID === "number" &&
      Number.isSafeInteger(raw.attachmentItemID) &&
      raw.attachmentItemID > 0
        ? raw.attachmentItemID
        : undefined;
    // Keep this bounded rather than applying a Zotero-key format check here:
    // the lookup boundary below remains authoritative and older test/session
    // data may contain non-canonical fixture keys.
    const sourceItemKey = readBoundedIdentifier(raw.sourceItemKey);
    const sourceLibraryID =
      typeof raw.sourceLibraryID === "number" &&
      Number.isSafeInteger(raw.sourceLibraryID) &&
      raw.sourceLibraryID > 0
        ? raw.sourceLibraryID
        : undefined;
    const isDraft = typeof raw.isDraft === "boolean" ? raw.isDraft : undefined;
    const hasUsableArtifact =
      Boolean(path) ||
      previewPaths.length > 0 ||
      attachmentItemID !== undefined;
    // A cancelled draft intentionally keeps only its bounded app-owned
    // identity. The interrupted progress card in message content binds to
    // this marker before the renderer exposes the resume action.
    const isIdentityOnlyDraft =
      Boolean(localId) && isDraft === true && !hasUsableArtifact;
    if (!hasUsableArtifact && !isIdentityOnlyDraft) {
      continue;
    }

    seenArtifactIds.add(artifactId);
    normalized.push({
      toolCallId,
      ...(localId ? { localId } : {}),
      ...(sourceItemKey ? { sourceItemKey } : {}),
      ...(sourceLibraryID !== undefined ? { sourceLibraryID } : {}),
      path,
      previewPaths: previewPaths.length > 0 ? previewPaths : undefined,
      attachmentItemID,
      isDraft,
    });
  }
  return normalized;
}

export function serializePresentationArtifacts(value: unknown): string | null {
  const normalized = normalizePresentationArtifacts(value);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}
