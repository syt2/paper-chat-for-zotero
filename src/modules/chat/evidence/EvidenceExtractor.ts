import type { EvidenceRecord } from "../../../types/evidence";
import type { ToolCall, ToolSourceReference } from "../../../types/tool";
import {
  createPdfPassageEvidenceRecord,
  hashEvidenceText,
  normalizeEvidenceQuote,
} from "./EvidenceRegistry";
import { parsePassageEvidenceManifestLine } from "./EvidenceManifest";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findPassageQuote(
  content: string,
  resultIndex: number,
  quoteCharacters: number,
  startAt: number,
): { quote: string; nextCursor: number } | null {
  const headerPattern = new RegExp(
    `^\\[Result\\s+${escapeRegExp(String(resultIndex))}\\]\\s+\\([^\\n]*\\)\\s*$`,
    "gim",
  );
  headerPattern.lastIndex = startAt;
  const match = headerPattern.exec(content);
  if (!match) return null;
  let bodyStart = (match.index || 0) + match[0].length;
  if (content[bodyStart] === "\r") bodyStart += 1;
  if (content[bodyStart] !== "\n") return null;
  bodyStart += 1;
  const bodyEnd = bodyStart + quoteCharacters;
  if (bodyEnd > content.length) return null;
  const rawQuote = content.slice(bodyStart, bodyEnd);
  const quote = normalizeEvidenceQuote(rawQuote);
  if (!quote || quote.length !== quoteCharacters || quote !== rawQuote) {
    return null;
  }
  return { quote, nextCursor: bodyEnd };
}

export function deriveToolEvidenceRecords(
  toolCall: ToolCall,
  rawContent: string,
  references: ToolSourceReference[],
): EvidenceRecord[] {
  if (toolCall.function.name !== "search_paper_content") return [];

  const lines = rawContent.split("\n");
  const manifestEntries = parsePassageEvidenceManifestLine(lines[2]);
  if (manifestEntries.length === 0) return [];
  if (manifestEntries.some((entry, index) => entry.resultIndex !== index + 1)) {
    return [];
  }

  const itemReferences = references.filter(
    (reference): reference is Extract<ToolSourceReference, { type: "item" }> =>
      reference.type === "item",
  );
  if (itemReferences.length !== 1) return [];
  const itemReference = itemReferences[0];
  const trustedPages = new Set(
    references
      .filter(
        (
          reference,
        ): reference is Extract<ToolSourceReference, { type: "page" }> =>
          reference.type === "page" && reference.itemKey === itemReference.key,
      )
      .map((reference) => reference.page),
  );
  const records: EvidenceRecord[] = [];
  let passageCursor = 0;

  for (const entry of manifestEntries) {
    const passage = findPassageQuote(
      rawContent,
      entry.resultIndex,
      entry.quoteCharacters,
      passageCursor,
    );
    if (!passage) {
      return [];
    }
    passageCursor = passage.nextCursor;
    if (hashEvidenceText(passage.quote) !== entry.contentHash) {
      continue;
    }
    if (entry.page !== undefined && !trustedPages.has(entry.page)) {
      continue;
    }
    const record = createPdfPassageEvidenceRecord({
      itemKey: itemReference.key,
      ...(itemReference.libraryID
        ? { libraryID: itemReference.libraryID }
        : {}),
      ...(entry.page ? { page: entry.page } : {}),
      ...(entry.section ? { section: entry.section } : {}),
      ...(entry.chunkIndex !== undefined
        ? { chunkIndex: entry.chunkIndex }
        : {}),
      quote: passage.quote,
      toolCallId: toolCall.id,
      resultIndex: entry.resultIndex,
    });
    if (record) records.push(record);
  }

  return records;
}
