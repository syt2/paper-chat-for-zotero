export type EvidenceKind = "pdf_passage";

export interface EvidenceRecord {
  version: 1;
  id: string;
  kind: EvidenceKind;
  itemKey: string;
  libraryID?: number;
  page?: number;
  section?: string;
  chunkIndex?: number;
  quote: string;
  contentHash: string;
  toolCallId: string;
  resultIndex: number;
}
