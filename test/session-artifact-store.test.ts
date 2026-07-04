import { assert } from "chai";
import type { ToolCall } from "../src/types/tool";
import {
  SessionArtifactStore,
  resetSessionArtifactStoreForTests,
} from "../src/modules/chat/session-artifacts/index.ts";

function installFileSystemStub() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const originalZotero = (globalThis as any).Zotero;
  const originalPathUtils = (globalThis as any).PathUtils;
  const originalIOUtils = (globalThis as any).IOUtils;

  (globalThis as any).Zotero = {
    DataDirectory: {
      dir: "/tmp/zotero",
    },
  };
  (globalThis as any).PathUtils = {
    join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
  };
  (globalThis as any).IOUtils = {
    exists: async (path: string) => files.has(path) || dirs.has(path),
    makeDirectory: async (path: string) => {
      dirs.add(path);
    },
    writeUTF8: async (path: string, content: string) => {
      files.set(path, content);
    },
    readUTF8: async (path: string) => {
      if (!files.has(path)) {
        throw new Error(`missing file: ${path}`);
      }
      return files.get(path) || "";
    },
  };

  return {
    files,
    restore: () => {
      (globalThis as any).Zotero = originalZotero;
      (globalThis as any).PathUtils = originalPathUtils;
      (globalThis as any).IOUtils = originalIOUtils;
      resetSessionArtifactStoreForTests();
    },
  };
}

function createToolCall(name: string = "search_paper_content"): ToolCall {
  return {
    id: "tool-1",
    type: "function",
    function: {
      name,
      arguments: JSON.stringify({ query: "method" }),
    },
  };
}

describe("session artifact store", function () {
  let fs: ReturnType<typeof installFileSystemStub>;

  beforeEach(function () {
    fs = installFileSystemStub();
  });

  afterEach(function () {
    fs.restore();
  });

  it("stores large tool results and reads them by session artifact id", async function () {
    const store = new SessionArtifactStore(10, 20);
    const fullContent = "0123456789abcdefghijklmnopqrstuvwxyz";
    const stored = await store.maybeStoreToolResult({
      sessionId: "session-1",
      toolCall: createToolCall(),
      content: fullContent,
    });

    assert.isNotNull(stored);
    assert.include(stored?.modelContent || "", "Artifact id:");
    assert.include(stored?.modelContent || "", "Use read_artifact");
    assert.equal(stored?.ref.originalCharacters, fullContent.length);

    const read = await store.readArtifact("session-1", stored!.ref.id, {
      offset: 10,
      maxCharacters: 8,
    });
    assert.equal(read.content, "abcdefgh");
    assert.isTrue(read.hasMore);
  });

  it("rejects path traversal and cross-session artifact reads", async function () {
    const store = new SessionArtifactStore(10, 20);
    const stored = await store.maybeStoreToolResult({
      sessionId: "session-1",
      toolCall: createToolCall(),
      content: "large content that should be persisted",
    });
    assert.isNotNull(stored);

    try {
      await store.readArtifact("session-1", "../secret");
      assert.fail("expected invalid artifact id to throw");
    } catch (error) {
      assert.include(String(error), "Invalid artifact id");
    }

    try {
      await store.readArtifact("session-2", stored!.ref.id);
      assert.fail("expected cross-session read to throw");
    } catch (error) {
      assert.include(String(error), "Artifact not found");
    }
  });

  it("keeps small results inline", async function () {
    const store = new SessionArtifactStore(100, 20);
    const stored = await store.maybeStoreToolResult({
      sessionId: "session-1",
      toolCall: createToolCall(),
      content: "short",
    });
    assert.isNull(stored);
    assert.equal(fs.files.size, 0);
  });

  it("serializes concurrent index writes for the same session", async function () {
    const store = new SessionArtifactStore(10, 20);
    const [first, second] = await Promise.all([
      store.maybeStoreToolResult({
        sessionId: "session-1",
        toolCall: createToolCall("search_paper_content"),
        content: "first large content",
      }),
      store.maybeStoreToolResult({
        sessionId: "session-1",
        toolCall: createToolCall("search_with_regex"),
        content: "second large content",
      }),
    ]);

    assert.isNotNull(first);
    assert.isNotNull(second);
    const indexPath = [...fs.files.keys()].find((path) =>
      path.endsWith("/index.json"),
    );
    assert.isString(indexPath);
    const index = JSON.parse(fs.files.get(indexPath!) || "{}") as {
      artifacts?: Array<{ id: string }>;
    };
    assert.sameMembers(
      (index.artifacts || []).map((artifact) => artifact.id),
      [first!.ref.id, second!.ref.id],
    );
  });
});
