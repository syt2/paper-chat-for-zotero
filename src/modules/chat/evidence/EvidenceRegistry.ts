import type { EvidenceRecord } from "../../../types/evidence";
import type { ToolExecutionResult } from "../../../types/tool";

const EVIDENCE_ID_PATTERN = /^ev-[a-f0-9]{16}$/;
const ZOTERO_KEY_PATTERN = /^[A-Z0-9]{8}$/;
const MAX_EVIDENCE_PER_MESSAGE = 100;
const MAX_QUOTE_CHARACTERS = 4_000;
const EVIDENCE_REF_OPEN_PATTERN = /<evidence-ref\b/gi;

function hash32(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function normalizeEvidenceQuote(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .trim()
    .slice(0, MAX_QUOTE_CHARACTERS);
}

export function hashEvidenceText(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function getEvidenceIdentityInput(
  evidence: Pick<
    EvidenceRecord,
    | "kind"
    | "itemKey"
    | "libraryID"
    | "page"
    | "section"
    | "chunkIndex"
    | "contentHash"
  >,
): string {
  return [
    evidence.kind,
    evidence.itemKey,
    evidence.libraryID ?? "",
    evidence.page ?? "",
    evidence.section ?? "",
    evidence.chunkIndex ?? "",
    evidence.contentHash,
  ].join("\u001f");
}

export function createEvidenceId(
  evidence: Pick<
    EvidenceRecord,
    | "kind"
    | "itemKey"
    | "libraryID"
    | "page"
    | "section"
    | "chunkIndex"
    | "contentHash"
  >,
): string {
  const identity = getEvidenceIdentityInput(evidence);
  return `ev-${hash32(identity, 2166136261)}${hash32(identity, 2246822519)}`;
}

export function createPdfPassageEvidenceRecord(params: {
  itemKey: string;
  libraryID?: number;
  page?: number;
  section?: string;
  chunkIndex?: number;
  quote: string;
  toolCallId: string;
  resultIndex: number;
}): EvidenceRecord | null {
  const itemKey = params.itemKey.trim().toUpperCase();
  const quote = normalizeEvidenceQuote(params.quote);
  const toolCallId = params.toolCallId.trim();
  if (!ZOTERO_KEY_PATTERN.test(itemKey) || !quote || !toolCallId) {
    return null;
  }
  if (!Number.isSafeInteger(params.resultIndex) || params.resultIndex < 1) {
    return null;
  }

  const contentHash = hashEvidenceText(quote);
  const libraryID =
    Number.isSafeInteger(params.libraryID) && (params.libraryID || 0) > 0
      ? params.libraryID
      : undefined;
  const page =
    Number.isSafeInteger(params.page) && (params.page || 0) > 0
      ? params.page
      : undefined;
  const chunkIndex =
    Number.isSafeInteger(params.chunkIndex) && (params.chunkIndex || 0) >= 0
      ? params.chunkIndex
      : undefined;
  const identity = {
    kind: "pdf_passage" as const,
    itemKey,
    ...(libraryID ? { libraryID } : {}),
    ...(page ? { page } : {}),
    ...(params.section?.trim()
      ? { section: params.section.trim().replace(/\s+/g, " ").slice(0, 240) }
      : {}),
    ...(chunkIndex !== undefined ? { chunkIndex } : {}),
    contentHash,
  };

  return {
    version: 1,
    id: createEvidenceId(identity),
    ...identity,
    quote,
    toolCallId: toolCallId.slice(0, 240),
    resultIndex: params.resultIndex,
  };
}

export function normalizeEvidenceRecord(value: unknown): EvidenceRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<EvidenceRecord>;
  if (
    raw.version !== 1 ||
    raw.kind !== "pdf_passage" ||
    typeof raw.id !== "string" ||
    !EVIDENCE_ID_PATTERN.test(raw.id) ||
    typeof raw.itemKey !== "string" ||
    typeof raw.quote !== "string" ||
    typeof raw.contentHash !== "string" ||
    typeof raw.toolCallId !== "string" ||
    typeof raw.resultIndex !== "number"
  ) {
    return null;
  }

  const record = createPdfPassageEvidenceRecord({
    itemKey: raw.itemKey,
    ...(typeof raw.libraryID === "number" &&
    Number.isSafeInteger(raw.libraryID) &&
    raw.libraryID > 0
      ? { libraryID: raw.libraryID }
      : {}),
    ...(typeof raw.page === "number" &&
    Number.isSafeInteger(raw.page) &&
    raw.page > 0
      ? { page: raw.page }
      : {}),
    ...(typeof raw.section === "string" ? { section: raw.section } : {}),
    ...(typeof raw.chunkIndex === "number" &&
    Number.isSafeInteger(raw.chunkIndex) &&
    raw.chunkIndex >= 0
      ? { chunkIndex: raw.chunkIndex }
      : {}),
    quote: raw.quote,
    toolCallId: raw.toolCallId,
    resultIndex: raw.resultIndex,
  });
  if (
    !record ||
    record.id !== raw.id ||
    record.contentHash !== raw.contentHash.toLowerCase()
  ) {
    return null;
  }
  return record;
}

export function normalizeEvidenceRecords(value: unknown): EvidenceRecord[] {
  if (!Array.isArray(value)) return [];
  const records: EvidenceRecord[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, MAX_EVIDENCE_PER_MESSAGE)) {
    const record = normalizeEvidenceRecord(candidate);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  return records;
}

export function collectToolEvidenceRecords(
  results: ToolExecutionResult[],
): EvidenceRecord[] {
  return normalizeEvidenceRecords(
    results.flatMap((result) => result.evidence || []),
  );
}

function findTagEnd(content: string, start: number): number | null {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return null;
}

function parseEvidenceIds(rawTagBody: string): string[] {
  const trimmed = rawTagBody.trim();
  if (!trimmed.endsWith("/")) return [];
  const attributes = trimmed.slice(0, -1).trim();
  const match = attributes.match(/^ids\s*=\s*(["'])([^"']*)\1$/i);
  if (!match) return [];
  return Array.from(
    new Set(
      match[2]
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter((id) => EVIDENCE_ID_PATTERN.test(id)),
    ),
  );
}

export interface SanitizedEvidenceContent {
  content: string;
  referencedRecords: EvidenceRecord[];
}

export function sanitizeEvidenceReferences(
  content: string,
  availableRecords: EvidenceRecord[],
): SanitizedEvidenceContent {
  const records = normalizeEvidenceRecords(availableRecords);
  const byId = new Map(records.map((record) => [record.id, record]));
  const referencedIds: string[] = [];
  const seenReferencedIds = new Set<string>();
  let sanitized = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  EVIDENCE_REF_OPEN_PATTERN.lastIndex = 0;

  while ((match = EVIDENCE_REF_OPEN_PATTERN.exec(content)) !== null) {
    sanitized += content.slice(cursor, match.index);
    const tagEnd = findTagEnd(content, EVIDENCE_REF_OPEN_PATTERN.lastIndex);
    if (tagEnd === null) {
      sanitized += "&lt;evidence-ref";
      cursor = EVIDENCE_REF_OPEN_PATTERN.lastIndex;
      break;
    }

    const requestedIds = parseEvidenceIds(
      content.slice(EVIDENCE_REF_OPEN_PATTERN.lastIndex, tagEnd),
    );
    const trustedIds = requestedIds.filter((id) => byId.has(id));
    if (trustedIds.length > 0) {
      sanitized += `<evidence-ref ids="${trustedIds.join(",")}"/>`;
      for (const id of trustedIds) {
        if (!seenReferencedIds.has(id)) {
          seenReferencedIds.add(id);
          referencedIds.push(id);
        }
      }
    }
    cursor = tagEnd + 1;
    EVIDENCE_REF_OPEN_PATTERN.lastIndex = cursor;
  }

  sanitized += content.slice(cursor);
  sanitized = sanitized.replace(/<\/evidence-ref\s*>/gi, "");
  return {
    content: sanitized,
    referencedRecords: referencedIds
      .map((id) => byId.get(id))
      .filter((record): record is EvidenceRecord => !!record),
  };
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
}

export function appendEvidenceCitationCatalog(
  content: string,
  evidence: EvidenceRecord[] | undefined,
): string {
  const records = normalizeEvidenceRecords(evidence);
  if (records.length === 0) return content;

  const catalog = records.map((record) => {
    const location = [
      record.page ? `page ${record.page}` : "",
      record.section ? `section ${record.section}` : "",
      `result ${record.resultIndex}`,
    ]
      .filter(Boolean)
      .join(", ");
    return `- ${record.id} (${location}): ${JSON.stringify(truncateInline(record.quote, 220))}`;
  });

  return [
    content,
    "",
    "Trusted evidence IDs for inline citations:",
    ...catalog,
    'When a claim is supported by one of these passages, append <evidence-ref ids="ID"/> immediately after that claim. Use only exact IDs listed above.',
  ].join("\n");
}
