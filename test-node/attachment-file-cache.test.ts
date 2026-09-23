import { assert } from "chai";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupDeletedSessionAttachmentCopies,
  getAttachmentCopyPath,
} from "../src/modules/chat/AttachmentFileCache.ts";
import { SessionStorageService } from "../src/modules/chat/SessionStorageService.ts";
import { getStorageDatabase } from "../src/modules/chat/db/StorageDatabase.ts";

describe("attachment cache cleanup", function () {
  const runtime = globalThis as Record<string, any>;
  let previous: Record<string, any>;
  let directory: string;
  const file = (name: string) => ({ name, content: name, type: "text" });
  const rows = (...files: unknown[]) => [{ files: JSON.stringify(files) }];
  const exists = async (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );

  beforeEach(async function () {
    previous = Object.fromEntries(
      ["Zotero", "IOUtils", "PathUtils", "ztoolkit"].map((key) => [
        key,
        runtime[key],
      ]),
    );
    directory = await mkdtemp(join(tmpdir(), "paperchat-cache-test-"));
    runtime.Zotero = {
      getTempDirectory: () => ({ path: directory }),
      Utilities: {
        Internal: {
          md5: (text: string) => createHash("md5").update(text).digest("hex"),
        },
      },
    };
    runtime.PathUtils = { join };
    runtime.IOUtils = {
      exists,
      remove: (path: string) => rm(path, { force: true }),
    };
    runtime.ztoolkit = { log: () => {} };
    await mkdir(join(directory, "paperchat-attachments"));
  });

  afterEach(async function () {
    Object.assign(runtime, previous);
    await rm(directory, { recursive: true, force: true });
  });

  it("removes only unshared copies, preserving originals and unrelated cached files", async function () {
    const unique = file("unique.txt");
    const shared = file("shared.txt");
    const unrelated = file("unrelated.txt");
    const original = join(directory, "original.txt");
    await writeFile(original, "original content");
    for (const attachment of [unique, shared, unrelated]) {
      await writeFile(getAttachmentCopyPath(attachment), attachment.content);
    }
    await cleanupDeletedSessionAttachmentCopies(
      rows({ ...unique, sourcePath: original }, unique, shared),
      { queryAsync: async () => rows(shared) },
    );
    assert.isFalse(await exists(getAttachmentCopyPath(unique)));
    assert.isTrue(await exists(original));
    assert.isTrue(await exists(getAttachmentCopyPath(shared)));
    assert.isTrue(await exists(getAttachmentCopyPath(unrelated)));
    await cleanupDeletedSessionAttachmentCopies(rows(shared), {
      queryAsync: async () => [],
    });
    assert.isFalse(await exists(getAttachmentCopyPath(shared)));
  });

  it("does not remove a cached path used as an original attachment", async function () {
    const attachment = file("original-in-cache.txt");
    const path = getAttachmentCopyPath(attachment);
    await writeFile(path, attachment.content);
    await cleanupDeletedSessionAttachmentCopies(
      rows({ ...attachment, sourcePath: path }),
      { queryAsync: async () => [] },
    );
    assert.isTrue(await exists(path));
  });

  it("skips remaining history when there is no cached copy", async function () {
    await cleanupDeletedSessionAttachmentCopies(rows(file("uncached.txt")), {
      queryAsync: async () => {
        throw new Error("History should not be queried");
      },
    });
  });

  it("pages through attachments and stops as soon as every copy is shared", async function () {
    const shared = file("shared.txt");
    await writeFile(getAttachmentCopyPath(shared), shared.content);
    const history = Array.from({ length: 96 }, (_, i) => ({
      cache_cursor: i + 1,
      ...rows(i === 40 ? shared : file(`other-${i}.txt`))[0],
    }));
    const cursors: number[] = [];
    let hashes = 0;
    const md5 = runtime.Zotero.Utilities.Internal.md5;
    runtime.Zotero.Utilities.Internal.md5 = (text: string) => {
      hashes++;
      return md5(text);
    };
    await cleanupDeletedSessionAttachmentCopies(rows(shared), {
      queryAsync: async (_sql, params) => {
        const cursor = Number(params?.[0]);
        const limit = Number(params?.[1]);
        cursors.push(cursor);
        assert.equal(limit, 32);
        return history
          .filter((row) => row.cache_cursor > cursor)
          .slice(0, limit);
      },
    });
    assert.deepEqual(cursors, [0, 32]);
    assert.equal(hashes, 2, "unrelated file contents should not be hashed");
    assert.isTrue(await exists(getAttachmentCopyPath(shared)));
  });

  it("preserves copies when remaining attachment metadata cannot be read safely", async function () {
    const attachment = file("candidate.txt");
    const path = getAttachmentCopyPath(attachment);
    await writeFile(path, attachment.content);
    for (const invalid of ["not json", JSON.stringify([null])]) {
      let failed = false;
      try {
        await cleanupDeletedSessionAttachmentCopies(rows(attachment), {
          queryAsync: async () => [{ files: invalid }],
        });
      } catch {
        failed = true;
      }
      assert.isTrue(failed);
      assert.isTrue(await exists(path));
    }
  });

  it("cleans only after deletion commits, and tolerates locked copies", async function () {
    const attachment = file("deleted.txt");
    const path = getAttachmentCopyPath(attachment);
    await writeFile(path, attachment.content);
    const service = new SessionStorageService() as any;
    const storage = getStorageDatabase();
    const originalEnsureInit = storage.ensureInit;
    let committed = false;
    const db = {
      queryAsync: async (sql: string) => {
        if (sql.includes("SELECT files") && sql.includes("session_id = ?"))
          return rows(attachment);
        if (sql.includes("AS cache_cursor")) assert.isTrue(committed);
        return [];
      },
    };
    storage.ensureInit = async () => db;
    try {
      service.runTransaction = async (operation: any) => {
        await operation(db);
        throw new Error("rollback");
      };
      await service
        .deleteSessionData("session")
        .catch((error: Error) => assert.equal(error.message, "rollback"));
      assert.isTrue(await exists(path));
      service.runTransaction = async (operation: any) => {
        await operation(db);
        committed = true;
      };
      runtime.IOUtils.remove = async () => {
        throw new Error("file locked");
      };
      await service.deleteSessionData("session");
      assert.isTrue(await exists(path));
      runtime.IOUtils.remove = (path: string) => rm(path, { force: true });
      await service.deleteSessionData("session");
      assert.isFalse(await exists(path));
    } finally {
      storage.ensureInit = originalEnsureInit;
    }
  });
});
