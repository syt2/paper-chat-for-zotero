import { generateTimestampId, getDataPath } from "../../utils/common";
import { raceWithAbort, throwIfAborted } from "../../utils/abort";
import {
  normalizePresentationLaunchSettings,
  type PresentationLaunchSettings,
} from "./PresentationLaunchSettings";
import type { PresentationAttachmentResult } from "./PresentationAttachment";
import type { PresentationSourceContext } from "./contracts";

const ROOT = "presentation-checkpoints";
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_STEPS = 48;

export function isPresentationCheckpointId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

function isByteArray(value: unknown): value is Uint8Array {
  // The renderer runs in Zotero's main-window realm; instanceof fails there.
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

interface CheckpointManifest {
  version: 1;
  id: string;
  source: PresentationSourceContext;
  settings: PresentationLaunchSettings;
  args: Record<string, unknown>;
  steps: string[];
  attachmentPending?: boolean;
  attachment?: PresentationAttachmentResult;
  result?: string;
}

/** PPT-only durable results. Each completed expensive operation is saved once;
 * progress ticks never rewrite the plan, images, or rendered deck. */
export class PresentationCheckpoint {
  private constructor(private readonly manifest: CheckpointManifest) {}

  get id(): string {
    return this.manifest.id;
  }
  get source(): PresentationSourceContext {
    return { ...this.manifest.source };
  }
  get settings(): PresentationLaunchSettings {
    return { ...this.manifest.settings };
  }
  get args(): Record<string, unknown> {
    return { ...this.manifest.args };
  }
  get result(): string | undefined {
    return this.manifest.result;
  }

  private path(name: string): string {
    return getDataPath(ROOT, this.id, name);
  }

  static async create(
    source: PresentationSourceContext,
    settings: PresentationLaunchSettings,
    args: Record<string, unknown>,
  ): Promise<PresentationCheckpoint> {
    const checkpoint = new PresentationCheckpoint({
      version: 1,
      id: `ppt-${generateTimestampId()}`,
      source: { ...source },
      settings: normalizePresentationLaunchSettings(settings),
      args,
      steps: [],
    });
    await IOUtils.makeDirectory(getDataPath(ROOT, checkpoint.id), {
      createAncestors: true,
    });
    await checkpoint.saveManifest();
    return checkpoint;
  }

  static async load(id: string): Promise<PresentationCheckpoint> {
    if (!isPresentationCheckpointId(id))
      throw new Error("Invalid PPT checkpoint.");
    const path = getDataPath(ROOT, id, "checkpoint.json");
    if (((await IOUtils.stat(path)).size || 0) > MAX_SNAPSHOT_BYTES)
      throw new Error("PPT checkpoint is too large.");
    const data = (await IOUtils.readJSON(path)) as CheckpointManifest;
    if (
      data.version !== 1 ||
      data.id !== id ||
      !data.source?.itemKey ||
      !Number.isSafeInteger(data.source.libraryID) ||
      !data.args ||
      Array.isArray(data.args) ||
      typeof data.args !== "object" ||
      !Array.isArray(data.steps) ||
      data.steps.length > MAX_STEPS ||
      !data.steps.every((key) => /^[a-z-]+-[a-f0-9]{32}$/.test(key))
    ) {
      throw new Error(
        "PPT checkpoint is invalid or from an unsupported version.",
      );
    }
    data.settings = normalizePresentationLaunchSettings(data.settings);
    return new PresentationCheckpoint(data);
  }

  private async saveManifest(): Promise<void> {
    const path = this.path("checkpoint.json");
    await IOUtils.writeJSON(path, this.manifest, { tmpPath: `${path}.tmp` });
  }

  /** A launcher checkpoint initially contains only the confirmed paper. Freeze
   * the first execution's normalized arguments before saving expensive steps. */
  async initializeArguments(args: Record<string, unknown>): Promise<void> {
    if (
      this.manifest.steps.length ||
      this.manifest.result ||
      this.manifest.attachmentPending ||
      this.manifest.attachment
    )
      return;
    this.manifest.args = { ...args };
    await this.saveManifest();
  }

  /** Keep intermediate invalid plans for deterministic replay of a successful
   * repair chain. If planning as a whole fails, let the next attempt plan anew. */
  async discardPlanningResults(): Promise<void> {
    const discarded = this.manifest.steps.filter((key) =>
      key.startsWith("planning-"),
    );
    if (!discarded.length) return;
    this.manifest.steps = this.manifest.steps.filter(
      (key) => !key.startsWith("planning-"),
    );
    await this.saveManifest();
    for (const key of discarded) {
      await IOUtils.remove(this.path(`${key}.json`), { ignoreAbsent: true });
    }
  }

  /** The input fingerprint prevents reuse after an earlier repair changes a deck.
   * Binary PPTX bytes are kept as binary, not expanded into JSON number arrays. */
  async run<T>(
    stage: string,
    input: unknown,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    const digest = Zotero.Utilities.Internal.md5(JSON.stringify(input));
    const key = `${stage}-${digest}`;
    const path = this.path(`${key}.json`);
    if (this.manifest.steps.includes(key)) {
      if (((await IOUtils.stat(path)).size || 0) > MAX_SNAPSHOT_BYTES)
        throw new Error("PPT checkpoint stage is too large.");
      const saved = (await IOUtils.readJSON(path)) as {
        value: T;
        bytes?: "value" | "property";
      };
      if (saved.bytes) {
        const binaryPath = this.path(`${key}.bin`);
        if (((await IOUtils.stat(binaryPath)).size || 0) > MAX_SNAPSHOT_BYTES)
          throw new Error("PPT checkpoint stage is too large.");
        const bytes = await IOUtils.read(binaryPath);
        throwIfAborted(signal);
        return (
          saved.bytes === "value" ? bytes : { ...saved.value, bytes }
        ) as T;
      }
      throwIfAborted(signal);
      return saved.value;
    }
    const value = await raceWithAbort(operation, signal);
    throwIfAborted(signal);
    if (value == null) return value;
    if (this.manifest.steps.length >= MAX_STEPS)
      throw new Error("PPT checkpoint stage limit exceeded.");
    const valueIsBytes = isByteArray(value);
    const bytes = valueIsBytes ? value : (value as { bytes?: unknown })?.bytes;
    const hasBytes = isByteArray(bytes);
    const saved = hasBytes
      ? {
          value: valueIsBytes ? null : { ...value, bytes: undefined },
          bytes: valueIsBytes ? "value" : "property",
        }
      : { value };
    const json = JSON.stringify(saved);
    if (
      json.length > MAX_SNAPSHOT_BYTES ||
      (hasBytes && bytes.byteLength > MAX_SNAPSHOT_BYTES)
    ) {
      throw new Error("PPT checkpoint stage is too large.");
    }
    if (hasBytes) {
      const binaryPath = this.path(`${key}.bin`);
      await IOUtils.write(binaryPath, bytes, { tmpPath: `${binaryPath}.tmp` });
    }
    await IOUtils.writeUTF8(path, json, { tmpPath: `${path}.tmp` });
    this.manifest.steps.push(key);
    await this.saveManifest();
    throwIfAborted(signal);
    return value;
  }

  /** Do not silently re-import after an abrupt process exit inside Zotero's
   * attachment transaction. A normal pause waits for that transaction to settle. */
  assertCanResume(): void {
    if (this.manifest.attachmentPending)
      throw new Error(
        "PPT import was interrupted. Check the paper attachments before starting a new PPT task.",
      );
  }

  async attach(
    operation: () => Promise<PresentationAttachmentResult>,
  ): Promise<PresentationAttachmentResult> {
    if (this.manifest.attachment) return this.manifest.attachment;
    if (this.manifest.attachmentPending) {
      throw new Error(
        "PPT import was interrupted. Check the paper's attachments before starting a new PPT task.",
      );
    }
    this.manifest.attachmentPending = true;
    await this.saveManifest();
    const result = await operation();
    this.manifest.attachment =
      result.status === "attached" || result.attachmentCommitted
        ? result
        : undefined;
    this.manifest.attachmentPending = false;
    await this.saveManifest();
    return result;
  }

  async complete(result: string): Promise<void> {
    this.manifest.result = result;
    this.manifest.attachmentPending = false;
    await this.saveManifest();
    // The small terminal result suffices for idempotent replay. Release the
    // duplicate plan/media/render bytes once completion is durable.
    for (const key of this.manifest.steps) {
      for (const extension of ["json", "bin"]) {
        try {
          await IOUtils.remove(this.path(`${key}.${extension}`), {
            ignoreAbsent: true,
          });
        } catch {
          /* A failed cache cleanup must not undo an imported attachment. */
        }
      }
    }
  }
}

/** Collect only local checkpoint identifiers, never file paths from message JSON. */
export function collectPresentationCheckpointIds(
  values: readonly unknown[],
): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    let artifacts: unknown;
    try {
      artifacts = typeof value === "string" ? JSON.parse(value) : value;
    } catch {
      continue;
    }
    if (!Array.isArray(artifacts)) continue;
    for (const artifact of artifacts)
      if (isPresentationCheckpointId(artifact?.checkpointId))
        ids.add(artifact.checkpointId);
  }
  return [...ids];
}

export async function removeUnreferencedPresentationCheckpoints(
  ids: readonly string[],
  isReferenced: (id: string) => Promise<boolean>,
): Promise<void> {
  for (const id of new Set(ids)) {
    if (!isPresentationCheckpointId(id)) continue;
    try {
      if (await isReferenced(id)) continue;
      await IOUtils.remove(getDataPath(ROOT, id), {
        recursive: true,
        ignoreAbsent: true,
      });
    } catch (error) {
      // A locked directory or failed reference check must not prevent cleanup
      // of the other checkpoints belonging to the deleted conversation.
      ztoolkit.log("[PresentationCheckpoint] Cleanup failed:", id, error);
    }
  }
}
