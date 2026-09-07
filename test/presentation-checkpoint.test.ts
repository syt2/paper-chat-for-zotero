import { assert } from "chai";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import {
  PresentationCheckpoint,
  collectPresentationCheckpointIds,
  removeUnreferencedPresentationCheckpoints,
} from "../src/modules/presentation/PresentationCheckpoint.ts";
import { DEFAULT_PRESENTATION_LAUNCH_SETTINGS } from "../src/modules/presentation/PresentationLaunchSettings.ts";
import { executePresentationCapability } from "../src/modules/presentation/PresentationCapability.ts";
import { resetPresentationRendererForTests } from "../src/modules/presentation/PresentationRendererLoader.ts";
import { PRESENTATION_RENDERER_GLOBAL } from "../src/modules/presentation/contracts.ts";
import { createPresentationLaunchAuthorization } from "../src/modules/presentation/PresentationLaunchAuthorization.ts";
import { createPresentationResumeRound } from "../src/modules/presentation/PresentationResumeRound.ts";
import { SessionStorageService } from "../src/modules/chat/SessionStorageService.ts";
import { getStorageDatabase } from "../src/modules/chat/db/StorageDatabase.ts";

const source = { itemKey: "PAPER001", libraryID: 1 };
const settings = DEFAULT_PRESENTATION_LAUNCH_SETTINGS;
const paper = {
  metadata: { title: "Test paper" },
  sections: [],
  fullText: "Evidence",
  pages: [],
  pageCount: 1,
};
const plan = {
  title: "Test deck",
  sourceItemKey: source.itemKey,
  slides: [
    { title: "Evidence", metrics: [{ value: "24%", label: "improvement" }] },
  ],
};

describe("durable presentation checkpoints", function () {
  const runtime = globalThis as any;
  let previous: Record<string, unknown>;
  let dir: string;
  let rendererTarget: Record<string, unknown>;
  let imports: number;

  beforeEach(async function () {
    previous = Object.fromEntries(
      ["Zotero", "IOUtils", "PathUtils", "Services", "ztoolkit"].map((key) => [
        key,
        runtime[key],
      ]),
    );
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperchat-ppt-checkpoint-"));
    imports = 0;
    rendererTarget = {};
    runtime.PathUtils = { join: path.join, filename: path.basename };
    const write = async (
      file: string,
      data: string | Uint8Array,
      options?: { tmpPath?: string },
    ) => {
      await fs.writeFile(options?.tmpPath || file, data);
      if (options?.tmpPath) await fs.rename(options.tmpPath, file);
    };
    runtime.IOUtils = {
      makeDirectory: (file: string) => fs.mkdir(file, { recursive: true }),
      write,
      writeUTF8: write,
      writeJSON: (file: string, value: unknown, options: any) =>
        write(file, JSON.stringify(value), options),
      read: async (file: string) => new Uint8Array(await fs.readFile(file)),
      readJSON: async (file: string) =>
        JSON.parse(await fs.readFile(file, "utf8")),
      stat: fs.stat,
      exists: async (file: string) =>
        fs.access(file).then(
          () => true,
          () => false,
        ),
      remove: (file: string, options?: { recursive?: boolean }) =>
        fs.rm(file, { recursive: options?.recursive, force: true }),
    };
    runtime.Zotero = {
      DataDirectory: { dir },
      locale: "en-US",
      getMainWindow: () => rendererTarget,
      Utilities: {
        Internal: {
          md5: (input: string) => createHash("md5").update(input).digest("hex"),
        },
      },
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: () => ({
          id: 1,
          libraryID: 1,
          getField: () => "Test paper",
        }),
      },
      Attachments: {
        importFromFile: async ({ file }: { file: string }) => {
          imports++;
          const finalPath = path.join(dir, "attached.pptx");
          await fs.copyFile(file, finalPath);
          return {
            id: 7,
            key: "PPT001",
            libraryID: 1,
            getFilePathAsync: async () => finalPath,
          };
        },
      },
    };
    runtime.Services = { scriptloader: { loadSubScript: () => undefined } };
    runtime.ztoolkit = { log: () => undefined };
    resetPresentationRendererForTests();
  });

  afterEach(async function () {
    resetPresentationRendererForTests();
    Object.assign(runtime, previous);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reopens disk results including binary render bytes; changed inputs cannot reuse a stale step", async function () {
    const first = await PresentationCheckpoint.create(source, settings, {
      sourceItemKey: source.itemKey,
    });
    let calls = 0;
    await first.run("preview", { revision: 1 }, async () => {
      calls++;
      return {
        bytes: runInNewContext("new Uint8Array([80, 75])"),
        previewSlides: ["data:image/png;base64,AA=="],
      };
    });
    const reopened = await PresentationCheckpoint.load(first.id);
    const restored = await reopened.run(
      "preview",
      { revision: 1 },
      async () => {
        throw new Error("must not render again");
      },
    );
    assert.deepEqual(restored, {
      bytes: new Uint8Array([80, 75]),
      previewSlides: ["data:image/png;base64,AA=="],
    });
    await reopened.run("preview", { revision: 2 }, async () => {
      calls++;
      return new Uint8Array([81]);
    });
    assert.equal(calls, 2);
    const authorization = createPresentationLaunchAuthorization(
      source,
      settings,
      reopened,
    );
    assert.equal(
      createPresentationResumeRound(authorization)?.toolCalls?.[0].function
        .name,
      "presentation",
    );
    assert.isNull(createPresentationResumeRound({ ...authorization }));
    assert.isNull(
      createPresentationResumeRound(
        createPresentationLaunchAuthorization(source, settings),
      ),
    );
  });

  it("retries planning after a wholly invalid repair chain instead of caching the failure forever", async function () {
    const args = { sourceItemKey: source.itemKey, slideCount: 6 };
    const checkpoint = await PresentationCheckpoint.create(
      source,
      settings,
      args,
    );
    let calls = 0;
    const planner = async () => {
      calls++;
      return { ...plan, slides: "invalid" } as any;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = await PresentationCheckpoint.load(checkpoint.id);
      const result = await executePresentationCapability(
        args,
        undefined,
        planner,
        paper as any,
        undefined,
        undefined,
        source,
        undefined,
        reopened,
      );
      assert.match(result, /^Error: Presentation internal planning/);
    }
    assert.equal(calls, 4, "both initial planning and repair should retry");
  });

  it("does not save an unfinished or late-returning cancelled operation", async function () {
    const checkpoint = await PresentationCheckpoint.create(
      source,
      settings,
      {},
    );
    const controller = new AbortController();
    let finish!: (value: string) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = checkpoint.run(
      "planning",
      {},
      () => {
        started();
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
      controller.signal,
    );
    await ready;
    controller.abort();
    await pending.then(
      () => assert.fail("must abort"),
      (error) => assert.equal(error.name, "AbortError"),
    );
    finish("late result");
    const reopened = await PresentationCheckpoint.load(checkpoint.id);
    const result = await reopened.run(
      "planning",
      {},
      async () => "new request",
    );
    assert.equal(result, "new request");
  });

  it("resumes a repaired plan after restart during review without repeating work", async function () {
    const args = { sourceItemKey: source.itemKey, slideCount: 6 };
    const checkpoint = await PresentationCheckpoint.create(
      source,
      settings,
      args,
    );
    let plans = 0,
      media = 0,
      renders = 0,
      reviews = 0;
    const renderer = {
      renderPresentation: async () => new Uint8Array([80, 75, 3, 4]),
      renderPresentationWithPreview: async () => {
        renders++;
        return {
          bytes: new Uint8Array([80, 75, 3, 4]),
          previewSlides: [
            "data:image/png;base64,AA==",
            "data:image/png;base64,AA==",
          ],
        };
      },
    };
    runtime.Services.scriptloader.loadSubScript = () => {
      rendererTarget[PRESENTATION_RENDERER_GLOBAL] = renderer;
    };
    const controller = new AbortController();
    const planner = async () => {
      plans++;
      if (plans === 1) return { ...plan, slides: "invalid" } as any;
      return structuredClone(plan) as any;
    };
    const mediaResolver = async (request: any) => {
      media++;
      return request;
    };
    await executePresentationCapability(
      args,
      async () => {
        reviews++;
        controller.abort();
        throw new Error("paused review");
      },
      planner,
      paper as any,
      undefined,
      { mediaResolver },
      source,
      controller.signal,
      checkpoint,
    ).then(
      (value) => assert.fail(`must pause: ${value}`),
      (error) => assert.equal(error.name, "AbortError"),
    );
    assert.equal(imports, 0);
    assert.isAbove(plans, 0);
    assert.equal(renders, 1);
    const savedPlans = plans,
      savedMedia = media;
    // New instance + new renderer environment mirrors a process restart.
    resetPresentationRendererForTests();
    const reopened = await PresentationCheckpoint.load(checkpoint.id);
    const result = await executePresentationCapability(
      args,
      async () => {
        reviews++;
        return { verdict: "pass", summary: "Looks good" };
      },
      planner,
      paper as any,
      undefined,
      { mediaResolver },
      source,
      undefined,
      reopened,
    );
    assert.match(JSON.parse(result).status, /^completed/);
    assert.equal(plans, savedPlans);
    assert.equal(media, savedMedia);
    assert.equal(renders, 1);
    assert.equal(reviews, 2);
    assert.equal(imports, 1);
    await reopened.complete(result);
    const finished = await PresentationCheckpoint.load(checkpoint.id);
    assert.equal(
      await executePresentationCapability(
        args,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        source,
        undefined,
        finished,
      ),
      result,
    );
    assert.equal(imports, 1);
  });

  it("does not reuse a failed extraction or an uncommitted import after restart", async function () {
    const checkpoint = await PresentationCheckpoint.create(
      source,
      settings,
      {},
    );
    await checkpoint.run("paper", source, async () => null);
    await checkpoint.attach(async () => ({
      status: "not_attached",
      path: "/removed-draft.pptx",
    }));
    const reopened = await PresentationCheckpoint.load(checkpoint.id);
    assert.equal(
      await reopened.run("paper", source, async () => "paper is now available"),
      "paper is now available",
    );
    assert.equal(
      (
        await reopened.attach(async () => ({
          status: "attached",
          path: "/new.pptx",
          itemID: 11,
        }))
      ).itemID,
      11,
    );
  });

  it("remembers a committed import if the process exits before the final message is saved", async function () {
    const checkpoint = await PresentationCheckpoint.create(
      source,
      settings,
      {},
    );
    const result = {
      status: "attached" as const,
      itemID: 9,
      path: "/saved.pptx",
    };
    await checkpoint.attach(async () => result);
    const reopened = await PresentationCheckpoint.load(checkpoint.id);
    assert.deepEqual(
      await reopened.attach(async () => {
        throw new Error("duplicate import");
      }),
      result,
    );
  });

  it("removes deleted task checkpoints but preserves checkpoints shared by a fork", async function () {
    const checkpoint = await PresentationCheckpoint.create(
      source,
      settings,
      {},
    );
    const ids = collectPresentationCheckpointIds([
      JSON.stringify([
        { checkpointId: checkpoint.id },
        { checkpointId: "../escape" },
      ]),
      "invalid",
    ]);
    assert.deepEqual(ids, [checkpoint.id]);
    await removeUnreferencedPresentationCheckpoints(ids, async () => true);
    assert.equal(
      (await PresentationCheckpoint.load(checkpoint.id)).id,
      checkpoint.id,
    );
    await removeUnreferencedPresentationCheckpoints(ids, async () => false);
    await PresentationCheckpoint.load(checkpoint.id).then(
      () => assert.fail("must have removed"),
      (error) => assert.equal(error.code, "ENOENT"),
    );
  });

  it("continues cleanup after a locked directory or failed reference check while preserving shared checkpoints", async function () {
    const locked = await PresentationCheckpoint.create(source, settings, {});
    const unknown = await PresentationCheckpoint.create(source, settings, {});
    const shared = await PresentationCheckpoint.create(source, settings, {});
    const removable = await PresentationCheckpoint.create(source, settings, {});
    const remove = runtime.IOUtils.remove;
    runtime.IOUtils.remove = (file: string, options: unknown) => {
      if (path.basename(file) === locked.id) {
        throw new Error("directory is locked");
      }
      return remove(file, options);
    };
    await removeUnreferencedPresentationCheckpoints(
      [locked.id, unknown.id, shared.id, removable.id],
      async (id) => {
        if (id === unknown.id) throw new Error("reference query failed");
        return id === shared.id;
      },
    );
    for (const checkpoint of [locked, unknown, shared]) {
      assert.equal(
        (await PresentationCheckpoint.load(checkpoint.id)).id,
        checkpoint.id,
      );
    }
    assert.isFalse(
      await runtime.IOUtils.exists(
        path.join(dir, "paper-chat", "presentation-checkpoints", removable.id),
      ),
    );
  });

  it("cleans paused and completed checkpoints only after session deletion commits", async function () {
    const paused = await PresentationCheckpoint.create(source, settings, {});
    const completed = await PresentationCheckpoint.create(source, settings, {});
    const shared = await PresentationCheckpoint.create(source, settings, {});
    await paused.run("paper", source, async () => paper);
    await completed.complete("Saved PPT");
    const ids = [paused.id, completed.id, shared.id];
    const service = new SessionStorageService() as any;
    const storage = getStorageDatabase();
    const originalEnsureInit = storage.ensureInit;
    let committed = false;
    let rollback = true;
    const db = {
      queryAsync: async (sql: string, params: unknown[]) => {
        if (sql.startsWith("SELECT presentation_artifacts")) {
          return [
            {
              presentation_artifacts: JSON.stringify(
                ids.map((checkpointId) => ({ checkpointId })),
              ),
            },
          ];
        }
        if (sql.includes("presentation_artifacts LIKE")) {
          assert.isTrue(committed, "reference check must follow commit");
          return params[0] === `%${shared.id}%` ? [{}] : [];
        }
        return [];
      },
    };
    storage.ensureInit = async () => db;
    service.runTransaction = async (operation: any) => {
      await operation(db);
      if (rollback) throw new Error("rollback");
      committed = true;
    };
    try {
      await service.deleteSessionData("test-session").then(
        () => assert.fail("expected rollback"),
        (error: Error) => assert.equal(error.message, "rollback"),
      );
      for (const id of ids) await PresentationCheckpoint.load(id);
      rollback = false;
      await service.deleteSessionData("test-session");
      for (const id of [paused.id, completed.id]) {
        assert.isFalse(
          await runtime.IOUtils.exists(
            path.join(dir, "paper-chat", "presentation-checkpoints", id),
          ),
        );
      }
      await PresentationCheckpoint.load(shared.id);
    } finally {
      storage.ensureInit = originalEnsureInit;
    }
  });

  it("refuses an ambiguous import and malformed checkpoint IDs instead of duplicating an attachment", async function () {
    const checkpoint = await PresentationCheckpoint.create(
      source,
      settings,
      {},
    );
    await checkpoint
      .attach(async () => {
        throw new Error("simulated process termination");
      })
      .catch(() => undefined);
    const reopened = await PresentationCheckpoint.load(checkpoint.id);
    assert.throws(() => reopened.assertCanResume(), "import was interrupted");
    await PresentationCheckpoint.load("../escape").then(
      () => assert.fail("must reject"),
      (error) => assert.include(error.message, "Invalid"),
    );
  });
});
