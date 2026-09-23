import { assert } from "chai";
import { revealAttachedFile } from "../src/modules/ui/chat-panel/AttachmentActions.ts";
import {
  attachLocalFiles,
  getDroppedFilePaths,
  isFileDrop,
  setupLocalFileAttachments,
} from "../src/modules/ui/chat-panel/LocalFileAttachments.ts";
import { getProviderManager } from "../src/modules/providers/ProviderManager.ts";
import type {
  AttachmentState,
  ChatPanelContext,
} from "../src/modules/ui/chat-panel/types.ts";

class DropContainer extends EventTarget {
  isConnected = true;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  ownerDocument = { defaultView: new EventTarget() };
  querySelector() {
    return null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

function fixture() {
  const container = new DropContainer();
  let session = { id: "original" };
  let state: AttachmentState = {
    pendingImages: [],
    pendingFiles: [],
    pinnedSelectedTexts: [],
    pendingSelectedText: null,
    pendingQuotedMessages: [],
  };
  const errors: string[] = [];
  const reads: string[] = [];
  let previews = 0;
  const extractor = {
    readTextFile: async (path: string): Promise<string | null> => {
      reads.push(path);
      return "text";
    },
    imageFileToBase64: async (path: string) => {
      reads.push(path);
      return { data: "YQ==", mimeType: "image/jpeg" };
    },
  };
  const context = {
    container,
    chatManager: {
      getActiveSession: () => session,
      getPdfExtractor: () => extractor,
      ensureCurrentPaperChatModelResolved: async () => {
        throw new Error("offline");
      },
    },
    getAttachmentState: () => structuredClone(state),
    setAttachmentState: (next: AttachmentState) => {
      state = next;
    },
    updateAttachmentsPreview: () => previews++,
    appendError: (message: string) => errors.push(message),
  } as unknown as ChatPanelContext;
  return {
    container,
    context,
    extractor,
    errors,
    reads,
    state: () => state,
    previews: () => previews,
    switchSession: () => {
      session = { id: "next" };
    },
  };
}

function transfer(paths: string[]): DataTransfer {
  return {
    types: ["Files"],
    files: paths.map((mozFullPath) => ({ mozFullPath })),
  } as unknown as DataTransfer;
}

function dispatch(
  container: DropContainer,
  type: string,
  dataTransfer: DataTransfer,
) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  container.dispatchEvent(event);
  return event;
}

describe("local file attachments", function () {
  const runtime = globalThis as Record<string, any>;
  let previous: Record<string, any>;
  let restoreProvider: () => void;

  beforeEach(function () {
    previous = {
      addon: runtime.addon,
      Zotero: runtime.Zotero,
      ztoolkit: runtime.ztoolkit,
    };
    runtime.addon = {
      data: {
        locale: {
          current: {
            formatMessagesSync: (requests: Array<{ id: string }>) =>
              requests.map(({ id }) => ({ value: id })),
          },
        },
      },
    };
    runtime.Zotero = { Prefs: { get: () => undefined } };
    runtime.ztoolkit = { log: () => {} };
    const provider = getProviderManager();
    const original = provider.getActiveProviderId;
    provider.getActiveProviderId = () => "openai";
    restoreProvider = () => {
      provider.getActiveProviderId = original;
    };
  });

  afterEach(function () {
    restoreProvider();
    Object.assign(runtime, previous);
  });

  it("reads Gecko native files and DOM fallback paths once, leaving text and links alone", function () {
    assert.isFalse(isFileDrop(null));
    assert.isFalse(
      isFileDrop({
        types: ["text/plain", "text/uri-list"],
      } as unknown as DataTransfer),
    );
    const data = {
      types: ["application/x-moz-file", "Files"],
      mozItemCount: 2,
      mozGetDataAt: (_type: string, index: number) => {
        if (index === 1) throw new Error("native flavor unavailable");
        return { path: "/tmp/a.txt" };
      },
      files: [{ mozFullPath: "/tmp/a.txt" }, { mozFullPath: "/tmp/b.png" }],
    } as unknown as DataTransfer;
    assert.isTrue(isFileDrop(data));
    assert.deepEqual(getDroppedFilePaths(data), ["/tmp/a.txt", "/tmp/b.png"]);
  });

  it("attaches supported mixed files, skips unsupported formats and keeps text truncation", async function () {
    const f = fixture();
    f.extractor.readTextFile = async () => "x".repeat(60000);
    await attachLocalFiles(
      f.context,
      ["/tmp/a.PNG", "/tmp/b.md", "/tmp/paper.pdf", "/tmp/b.md"],
      () => true,
    );
    assert.equal(f.state().pendingImages[0].name, "a.PNG");
    assert.equal(f.state().pendingFiles[0].content.length, 50000);
    assert.equal(f.state().pendingFiles[0].sourcePath, "/tmp/b.md");
    assert.lengthOf(f.state().pendingFiles, 1);
    assert.include(f.errors[0], "attachment-unsupported");
    assert.equal(f.previews(), 2);
  });

  it("continues past unreadable files and accepts empty text files", async function () {
    const f = fixture();
    f.extractor.readTextFile = async (path) =>
      path.endsWith("bad.txt") ? null : "";
    await attachLocalFiles(
      f.context,
      ["/tmp/bad.txt", "/tmp/empty.txt"],
      () => true,
    );
    assert.lengthOf(f.errors, 1);
    assert.deepEqual(f.state().pendingFiles, [
      {
        name: "empty.txt",
        content: "",
        type: "text",
        sourcePath: "/tmp/empty.txt",
      },
    ]);
  });

  it("keeps the existing image count limit and rejects models without vision", async function () {
    const f = fixture();
    await attachLocalFiles(
      f.context,
      Array.from({ length: 7 }, (_, i) => `/tmp/${i}.png`),
      () => true,
    );
    assert.lengthOf(f.state().pendingImages, 6);
    assert.include(f.errors[0], "image-attachment-limit");
    const unsupported = fixture();
    getProviderManager().getActiveProviderId = () => "paperchat";
    unsupported.container.dataset.imageInputAvailability = "unsupported";
    await attachLocalFiles(
      unsupported.context,
      ["/tmp/no.png", "/tmp/ok.txt"],
      () => true,
    );
    assert.lengthOf(unsupported.state().pendingImages, 0);
    assert.deepEqual(unsupported.reads, ["/tmp/ok.txt"]);
    assert.include(unsupported.errors[0], "image-input-unsupported");
  });

  it("prevents native file drops from navigating and clears the drag highlight", async function () {
    const f = fixture();
    const input = setupLocalFileAttachments(f.context);
    const data = transfer(["/tmp/a.txt", "/tmp/b.csv"]);
    assert.isTrue(dispatch(f.container, "dragenter", data).defaultPrevented);
    dispatch(f.container, "dragenter", data);
    dispatch(f.container, "dragleave", data);
    assert.isTrue(f.container.attributes.has("data-file-drag"));
    assert.isTrue(dispatch(f.container, "drop", data).defaultPrevented);
    assert.isFalse(f.container.attributes.has("data-file-drag"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.lengthOf(f.state().pendingFiles, 2);
    assert.isFalse(
      dispatch(f.container, "drop", {
        types: ["text/plain"],
      } as unknown as DataTransfer).defaultPrevented,
    );
    input.dispose();
  });

  it("does not attach late file reads to a different session or a disposed panel", async function () {
    for (const invalidate of ["switch", "dispose"]) {
      const f = fixture();
      let finish!: (content: string) => void;
      f.extractor.readTextFile = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      const input = setupLocalFileAttachments(f.context);
      dispatch(f.container, "drop", transfer(["/tmp/a.txt"]));
      if (invalidate === "switch") f.switchSession();
      else input.dispose();
      finish("late data");
      await new Promise((resolve) => setImmediate(resolve));
      assert.isEmpty(f.state().pendingFiles);
      input.dispose();
    }
  });

  it("uses the same attachment pipeline for the file picker", async function () {
    const f = fixture();
    runtime.ztoolkit.FilePicker = class {
      async open() {
        return "/tmp/picked.json";
      }
    };
    const input = setupLocalFileAttachments(f.context);
    await input.pickFile();
    assert.deepEqual(f.state().pendingFiles, [
      {
        name: "picked.json",
        content: "text",
        type: "text",
        sourcePath: "/tmp/picked.json",
      },
    ]);
    input.dispose();
  });

  it("reveals the original attachment and falls back to a saved copy for old or moved files", async function () {
    const originalIO = runtime.IOUtils;
    const originalPaths = runtime.PathUtils;
    const revealed: string[] = [];
    const written: Array<[string, string]> = [];
    runtime.IOUtils = {
      exists: async (path: string) => path === "/original/notes.txt",
      makeDirectory: async () => {},
      writeUTF8: async (path: string, content: string) =>
        written.push([path, content]),
    };
    runtime.PathUtils = { join: (...parts: string[]) => parts.join("/") };
    runtime.Zotero.File = {
      reveal: async (path: string) => revealed.push(path),
    };
    runtime.Zotero.getTempDirectory = () => ({ path: "/temp" });
    runtime.Zotero.Utilities = { Internal: { md5: () => "content-hash" } };
    try {
      const file = { name: "notes.txt", content: "saved text", type: "text" };
      await revealAttachedFile({ ...file, sourcePath: "/original/notes.txt" });
      assert.deepEqual(revealed, ["/original/notes.txt"]);
      assert.isEmpty(written);
      await revealAttachedFile(file);
      await revealAttachedFile({ ...file, sourcePath: "/moved/notes.txt" });
      assert.deepEqual(written, [
        ["/temp/paperchat-attachments/content-hash-notes.txt", "saved text"],
        ["/temp/paperchat-attachments/content-hash-notes.txt", "saved text"],
      ]);
      const windowsPath = "C:\\Users\\tester\\Documents\\笔记.txt";
      runtime.IOUtils.exists = async (path: string) => {
        if (path.startsWith("/")) throw new Error("Invalid Windows path");
        return path === windowsPath;
      };
      runtime.PathUtils.join = (...parts: string[]) => parts.join("\\");
      runtime.Zotero.getTempDirectory = () => ({ path: "C:\\Temp" });
      await revealAttachedFile({ ...file, sourcePath: windowsPath });
      assert.equal(revealed.at(-1), windowsPath);
      await revealAttachedFile({
        ...file,
        name: "notes:copy.txt. ",
        sourcePath: "/original/notes.txt",
      });
      assert.deepEqual(written.at(-1), [
        "C:\\Temp\\paperchat-attachments\\content-hash-notes_copy.txt",
        "saved text",
      ]);
    } finally {
      runtime.IOUtils = originalIO;
      runtime.PathUtils = originalPaths;
    }
  });
});
