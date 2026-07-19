import { hashEvidenceText } from "./EvidenceRegistry";

export const EVIDENCE_MANIFEST_PREFIX = "Evidence manifest: ";

export interface PassageEvidenceManifestEntry {
  resultIndex: number;
  contentHash: string;
  quoteCharacters: number;
  page?: number;
  section?: string;
  chunkIndex?: number;
}

interface PassageEvidenceManifest {
  version: 1;
  results: PassageEvidenceManifestEntry[];
}

export function createPassageEvidenceManifestEntry(params: {
  resultIndex: number;
  quote: string;
  page?: number;
  section?: string;
  chunkIndex?: number;
}): PassageEvidenceManifestEntry {
  return {
    resultIndex: params.resultIndex,
    contentHash: hashEvidenceText(params.quote),
    quoteCharacters: params.quote.length,
    ...(params.page ? { page: params.page } : {}),
    ...(params.section ? { section: params.section } : {}),
    ...(params.chunkIndex !== undefined
      ? { chunkIndex: params.chunkIndex }
      : {}),
  };
}

export function formatPassageEvidenceManifest(
  results: PassageEvidenceManifestEntry[],
): string {
  const manifest: PassageEvidenceManifest = { version: 1, results };
  return `${EVIDENCE_MANIFEST_PREFIX}${JSON.stringify(manifest)}\n`;
}

export function parsePassageEvidenceManifestLine(
  line: string | undefined,
): PassageEvidenceManifestEntry[] {
  if (!line?.startsWith(EVIDENCE_MANIFEST_PREFIX) || line.length > 100_000) {
    return [];
  }

  try {
    const parsed = JSON.parse(line.slice(EVIDENCE_MANIFEST_PREFIX.length)) as {
      version?: unknown;
      results?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.results)) {
      return [];
    }

    const results: PassageEvidenceManifestEntry[] = [];
    const seen = new Set<number>();
    if (parsed.results.length > 100) {
      return [];
    }
    for (const raw of parsed.results) {
      if (!raw || typeof raw !== "object") continue;
      const value = raw as Record<string, unknown>;
      const resultIndex = value.resultIndex;
      const contentHash = value.contentHash;
      const quoteCharacters = value.quoteCharacters;
      if (
        typeof resultIndex !== "number" ||
        !Number.isSafeInteger(resultIndex) ||
        resultIndex < 1 ||
        seen.has(resultIndex) ||
        typeof contentHash !== "string" ||
        !/^[a-f0-9]{8}$/i.test(contentHash) ||
        typeof quoteCharacters !== "number" ||
        !Number.isSafeInteger(quoteCharacters) ||
        quoteCharacters < 1 ||
        quoteCharacters > 4_000
      ) {
        continue;
      }
      seen.add(resultIndex);

      const page = value.page;
      const section = value.section;
      const chunkIndex = value.chunkIndex;
      results.push({
        resultIndex,
        contentHash: contentHash.toLowerCase(),
        quoteCharacters,
        ...(typeof page === "number" && Number.isSafeInteger(page) && page > 0
          ? { page }
          : {}),
        ...(typeof section === "string" && section.trim()
          ? { section: section.trim().replace(/\s+/g, " ").slice(0, 240) }
          : {}),
        ...(typeof chunkIndex === "number" &&
        Number.isSafeInteger(chunkIndex) &&
        chunkIndex >= 0
          ? { chunkIndex }
          : {}),
      });
    }
    return results;
  } catch {
    return [];
  }
}
