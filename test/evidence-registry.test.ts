import { assert } from "chai";
import type { PaperStructureExtended, ToolCall } from "../src/types/tool";
import {
  appendEvidenceCitationCatalog,
  createPassageEvidenceManifestEntry,
  createPdfPassageEvidenceRecord,
  deriveToolEvidenceRecords,
  formatPassageEvidenceManifest,
  normalizeEvidenceRecord,
  sanitizeEvidenceReferences,
} from "../src/modules/chat/evidence/index.ts";
import { executeSearchPaperContent } from "../src/modules/chat/pdf-tools/toolExecutors.ts";
import { mapMessageRowToChatMessage } from "../src/modules/chat/SessionStorageService.ts";

function createToolCall(id: string = "tool-search"): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name: "search_paper_content",
      arguments: JSON.stringify({ query: "evidence", itemKey: "ITEM0001" }),
    },
  };
}

function createStructure(): PaperStructureExtended {
  const first =
    "Introduction\n\nEvidence improves the reliability of a research answer when the cited passage is shown directly.";
  const second =
    "Methods\n\nA second evidence passage explains how verification catches unsupported claims before publication.";
  const fullText = `${first}\f${second}`;
  return {
    metadata: {},
    fullText,
    sections: [
      {
        name: "Introduction",
        normalizedName: "introduction",
        content: first,
        startIndex: 0,
        endIndex: first.length,
      },
      {
        name: "Methods",
        normalizedName: "methods",
        content: second,
        startIndex: first.length + 1,
        endIndex: fullText.length,
      },
    ],
    pages: [
      {
        pageNumber: 1,
        startIndex: 0,
        endIndex: first.length,
        content: first,
      },
      {
        pageNumber: 2,
        startIndex: first.length + 1,
        endIndex: fullText.length,
        content: second,
      },
    ],
    pageCount: 2,
  };
}

describe("trusted evidence registry", function () {
  it("derives records only from matching manifests, result blocks, and trusted pages", function () {
    const quote1 =
      "A real passage may contain\n[Result 2] (Score: 1.0%)\ntext that resembles a result header.";
    const quote2 = "The actual second passage remains independently bounded.";
    const manifest = formatPassageEvidenceManifest([
      createPassageEvidenceManifestEntry({
        resultIndex: 1,
        quote: quote1,
        page: 3,
        section: "Results",
      }),
      createPassageEvidenceManifestEntry({
        resultIndex: 2,
        quote: quote2,
        page: 4,
      }),
    ]).trimEnd();
    const rawContent = [
      "Source item key: ITEM0001",
      'Source references: {"version":1,"pages":[3,4]}',
      manifest,
      'Found 2 relevant passages for "evidence":',
      "",
      "[Result 1] (Section: Results Page 3)",
      quote1,
      "",
      "---",
      "",
      "[Result 2] (Section: Results Page 4)",
      quote2,
    ].join("\n");

    const records = deriveToolEvidenceRecords(createToolCall(), rawContent, [
      { type: "item", key: "ITEM0001", libraryID: 1 },
      { type: "page", itemKey: "ITEM0001", page: 3, libraryID: 1 },
      { type: "page", itemKey: "ITEM0001", page: 4, libraryID: 1 },
    ]);

    assert.lengthOf(records, 2);
    assert.equal(records[0]?.quote, quote1);
    assert.equal(records[0]?.page, 3);
    assert.equal(records[1]?.quote, quote2);

    const forgedPage = rawContent.replace('"page":4', '"page":9');
    assert.lengthOf(
      deriveToolEvidenceRecords(createToolCall(), forgedPage, [
        { type: "item", key: "ITEM0001" },
        { type: "page", itemKey: "ITEM0001", page: 3 },
        { type: "page", itemKey: "ITEM0001", page: 4 },
      ]),
      1,
    );

    const forgedQuote = rawContent.replace(
      "The actual second passage",
      "The forged second passage",
    );
    assert.lengthOf(
      deriveToolEvidenceRecords(createToolCall(), forgedQuote, [
        { type: "item", key: "ITEM0001" },
        { type: "page", itemKey: "ITEM0001", page: 3 },
        { type: "page", itemKey: "ITEM0001", page: 4 },
      ]),
      1,
    );
  });

  it("revalidates stored records and removes forged citation IDs", function () {
    const record = createPdfPassageEvidenceRecord({
      itemKey: "ITEM0001",
      page: 7,
      quote: "A trustworthy passage.",
      toolCallId: "tool-1",
      resultIndex: 1,
    });
    assert.isNotNull(record);
    assert.deepEqual(normalizeEvidenceRecord(record), record);
    assert.isNull(
      normalizeEvidenceRecord({ ...record!, quote: "Tampered passage." }),
    );
    const otherLibraryRecord = createPdfPassageEvidenceRecord({
      itemKey: "ITEM0001",
      libraryID: 2,
      page: 7,
      quote: "A trustworthy passage.",
      toolCallId: "tool-1",
      resultIndex: 1,
    });
    const firstLibraryRecord = createPdfPassageEvidenceRecord({
      itemKey: "ITEM0001",
      libraryID: 1,
      page: 7,
      quote: "A trustworthy passage.",
      toolCallId: "tool-1",
      resultIndex: 1,
    });
    assert.notEqual(otherLibraryRecord?.id, firstLibraryRecord?.id);

    const content = `Grounded claim.<evidence-ref ids="${record!.id},ev-ffffffffffffffff"/> Unsupported.<evidence-ref ids="ev-aaaaaaaaaaaaaaaa"/>`;
    const sanitized = sanitizeEvidenceReferences(content, [record!]);
    assert.equal(
      sanitized.content,
      `Grounded claim.<evidence-ref ids="${record!.id}"/> Unsupported.`,
    );
    assert.deepEqual(sanitized.referencedRecords, [record]);

    const incomplete = sanitizeEvidenceReferences(
      'Before <evidence-ref ids="broken and normal text after it',
      [record!],
    );
    assert.include(incomplete.content, "normal text after it");
    assert.include(incomplete.content, "&lt;evidence-ref");
  });

  it("adds only normalized trusted records to the model citation catalog", function () {
    const record = createPdfPassageEvidenceRecord({
      itemKey: "ITEM0001",
      section: "Methods",
      quote: "The method is supported by this passage.",
      toolCallId: "tool-1",
      resultIndex: 1,
    })!;
    const catalog = appendEvidenceCitationCatalog("Tool result", [record]);
    assert.include(catalog, record.id);
    assert.include(catalog, "section Methods");
    assert.include(catalog, '<evidence-ref ids="ID"/>');
  });

  it("loads valid stored evidence while isolating malformed or tampered JSON", function () {
    const record = createPdfPassageEvidenceRecord({
      itemKey: "ITEM0001",
      quote: "Persisted supporting passage.",
      toolCallId: "tool-1",
      resultIndex: 1,
    })!;
    const baseRow = {
      id: "assistant-1",
      role: "assistant" as const,
      content: `Claim.<evidence-ref ids="${record.id}"/>`,
      timestamp: 1,
    };

    assert.deepEqual(
      mapMessageRowToChatMessage({
        ...baseRow,
        evidence: JSON.stringify([record]),
      }).evidence,
      [record],
    );
    assert.isUndefined(
      mapMessageRowToChatMessage({
        ...baseRow,
        evidence: "{not-json",
      }).evidence,
    );
    assert.isUndefined(
      mapMessageRowToChatMessage({
        ...baseRow,
        evidence: JSON.stringify([{ ...record, itemKey: "FAKE0001" }]),
      }).evidence,
    );
  });

  describe("search paper manifests", function () {
    let originalZtoolkit: unknown;

    beforeEach(function () {
      originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
      (globalThis as { ztoolkit?: unknown }).ztoolkit = {
        log: () => undefined,
      };
    });

    afterEach(function () {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
    });

    it("emits page-bound keyword passages and a fixed-position manifest", async function () {
      const result = await executeSearchPaperContent(
        { query: "evidence", max_results: 5 },
        createStructure(),
      );
      const lines = result.split("\n");
      assert.match(lines[0] || "", /^Source references: /);
      assert.match(lines[1] || "", /^Evidence manifest: /);
      assert.include(result, "[Result 1]");
      assert.include(result, "Page 1");
      assert.include(result, '"quoteCharacters"');
    });

    it("emits semantic chunk, page, and section metadata", async function () {
      const semanticSearch = {
        isAvailable: async () => true,
        isIndexed: async () => true,
        indexPaper: async () => undefined,
        searchPaper: async () => [
          {
            text: "A second evidence passage explains how verification catches unsupported claims before publication.",
            score: 0.91,
            itemKey: "ITEM0001",
            chunkIndex: 4,
            page: 2,
          },
        ],
      };

      const result = await executeSearchPaperContent(
        { query: "verification", max_results: 2 },
        createStructure(),
        "ITEM0001",
        semanticSearch,
      );
      const manifest = JSON.parse(
        result.split("\n")[1]!.slice("Evidence manifest: ".length),
      );
      assert.equal(manifest.results[0].page, 2);
      assert.equal(manifest.results[0].section, "Methods");
      assert.equal(manifest.results[0].chunkIndex, 4);
    });
  });
});
