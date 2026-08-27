import { assert } from "chai";
import {
  executeAppendToNote,
  executeCreateNote,
} from "../src/modules/chat/pdf-tools/libraryExecutors.ts";

interface MockNoteItem {
  key: string;
  libraryID: number;
  parentID?: number;
  note: string;
  setNote: (html: string) => void;
  getNote: () => string;
  save: () => Promise<void>;
  addTag: (tag: string) => void;
}

describe("note library executors", function () {
  const runtime = globalThis as typeof globalThis & { Zotero?: unknown };
  let originalZotero: unknown;
  let hadZotero = false;
  let createdNotes: MockNoteItem[] = [];

  beforeEach(function () {
    hadZotero = "Zotero" in runtime;
    originalZotero = runtime.Zotero;
    createdNotes = [];

    class Item implements MockNoteItem {
      key = "NOTE0001";
      libraryID = 0;
      parentID?: number;
      note = "";

      constructor(_itemType: string) {
        createdNotes.push(this);
      }

      setNote(html: string): void {
        this.note = html;
      }

      getNote(): string {
        return this.note;
      }

      async save(): Promise<void> {}

      addTag(_tag: string): void {}
    }

    runtime.Zotero = {
      Libraries: { userLibraryID: 1 },
      Item,
      Items: {
        getByLibraryAndKey: (_libraryID: number, key: string) =>
          key === "ITEM0001"
            ? {
                id: 42,
                key,
                libraryID: 1,
                isAttachment: () => false,
                isNote: () => false,
                getNotes: () => [],
              }
            : null,
      },
      DB: {
        executeTransaction: async (operation: () => Promise<void>) =>
          operation(),
      },
    };
  });

  afterEach(function () {
    if (hadZotero) {
      runtime.Zotero = originalZotero;
    } else {
      delete runtime.Zotero;
    }
  });

  it("stores default content as safe Markdown with Zotero-native math", async function () {
    const result = await executeCreateNote(
      {
        itemKey: "ITEM0001",
        content:
          "## Result\n\n**Stable** with $x < y$.\n\n<img src=x onerror=alert(1)>",
      },
      null,
    );

    assert.equal(
      result,
      'Note created successfully!\nNote key: NOTE0001 under item "ITEM0001"',
    );
    const createdNote = createdNotes[0];
    assert.equal(createdNote?.parentID, 42);
    assert.include(createdNote?.note || "", "<h2>Result</h2>");
    assert.include(createdNote?.note || "", "<strong>Stable</strong>");
    assert.include(
      createdNote?.note || "",
      '<span class="math">$x &lt; y$</span>',
    );
    assert.notInclude(createdNote?.note || "", "<img");
    assert.include(createdNote?.note || "", "&lt;img src=x");
  });

  it("keeps the explicit trusted-html path unchanged", async function () {
    await executeCreateNote(
      {
        content: '<p data-schema-version="9">Trusted Zotero HTML</p>',
        format: "html",
      },
      null,
    );

    const createdNote = createdNotes[0];
    assert.equal(
      createdNote?.note,
      '<p data-schema-version="9">Trusted Zotero HTML</p>',
    );
  });

  it("renders default Markdown when appending to a dedicated note", async function () {
    const result = await executeAppendToNote(
      {
        itemKey: "ITEM0001",
        content: "### Follow-up\n\nResult: \\(a + b\\).",
      },
      null,
    );

    assert.include(result, "Note appended successfully!");
    assert.include(result, "Created new note: yes");
    const createdNote = createdNotes[0];
    assert.include(createdNote?.note || "", "<h1>PaperChat Notes</h1>");
    assert.include(createdNote?.note || "", "<h3>Follow-up</h3>");
    assert.include(
      createdNote?.note || "",
      '<span class="math">$a + b$</span>',
    );
  });
});
