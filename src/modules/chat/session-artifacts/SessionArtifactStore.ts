import type { ToolCall, ToolResultArtifactRef } from "../../../types/tool";
import { generateTimestampId, getDataPath } from "../../../utils/common";

const ARTIFACT_ROOT = "artifacts";
const ARTIFACT_INDEX_FILE = "index.json";
const DEFAULT_PERSIST_THRESHOLD = 12_000;
const DEFAULT_PREVIEW_LIMIT = 1_200;
const DEFAULT_READ_LIMIT = 20_000;
const MAX_READ_LIMIT = 20_000;

interface SessionArtifactIndex {
  version: 1;
  sessionId: string;
  artifacts: ToolResultArtifactRef[];
}

export interface StoredToolResultArtifact {
  ref: ToolResultArtifactRef;
  modelContent: string;
}

export interface ReadArtifactOptions {
  offset?: number;
  maxCharacters?: number;
}

export interface ReadArtifactResult {
  ref: ToolResultArtifactRef;
  content: string;
  offset: number;
  returnedCharacters: number;
  hasMore: boolean;
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 96) || "unknown";
}

function normalizeOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeReadLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_READ_LIMIT;
  }
  return Math.min(MAX_READ_LIMIT, Math.max(1, Math.floor(value)));
}

function compactPreview(content: string, limit: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function artifactKindForTool(toolName: string): ToolResultArtifactRef["kind"] {
  switch (toolName) {
    case "get_full_text":
    case "get_pages":
    case "get_paper_section":
    case "search_paper_content":
    case "search_with_regex":
      return "paper_excerpt";
    case "web_search":
      return "search_result";
    case "create_note":
    case "append_to_note":
      return "generated_note";
    default:
      return "tool_result";
  }
}

function artifactTitleForTool(toolCall: ToolCall): string {
  return `${toolCall.function.name} result`;
}

function buildModelContent(ref: ToolResultArtifactRef): string {
  return [
    "[Tool result saved as session artifact]",
    `Artifact id: ${ref.id}`,
    `Original characters: ${ref.originalCharacters}`,
    `Preview: ${ref.preview}`,
    "",
    "Use read_artifact with this artifact id if exact details are needed.",
  ].join("\n");
}

export class SessionArtifactStore {
  private readonly persistThreshold: number;
  private readonly previewLimit: number;
  private readonly indexWriteQueues = new Map<string, Promise<void>>();

  constructor(
    persistThreshold = DEFAULT_PERSIST_THRESHOLD,
    previewLimit = DEFAULT_PREVIEW_LIMIT,
  ) {
    this.persistThreshold = persistThreshold;
    this.previewLimit = previewLimit;
  }

  shouldPersist(content: string): boolean {
    return content.length > this.persistThreshold;
  }

  async maybeStoreToolResult(params: {
    sessionId?: string;
    toolCall: ToolCall;
    content: string;
  }): Promise<StoredToolResultArtifact | null> {
    const { sessionId, toolCall, content } = params;
    if (!sessionId || !this.shouldPersist(content)) {
      return null;
    }
    if (toolCall.function.name === "read_artifact") {
      return null;
    }

    const artifactId = `artifact-${safePathPart(generateTimestampId())}`;
    const now = Date.now();
    const ref: ToolResultArtifactRef = {
      id: artifactId,
      sessionId,
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      kind: artifactKindForTool(toolCall.function.name),
      title: artifactTitleForTool(toolCall),
      originalCharacters: content.length,
      preview: compactPreview(content, this.previewLimit),
      createdAt: now,
    };

    await this.ensureSessionDirectory(sessionId);
    await IOUtils.writeUTF8(
      this.getArtifactPath(sessionId, artifactId),
      content,
    );
    await this.enqueueIndexWrite(sessionId, () =>
      this.appendIndexEntry(sessionId, ref),
    );

    return {
      ref,
      modelContent: buildModelContent(ref),
    };
  }

  async readArtifact(
    sessionId: string | undefined,
    artifactId: string,
    options?: ReadArtifactOptions,
  ): Promise<ReadArtifactResult> {
    if (!sessionId) {
      throw new Error("Cannot read artifact without an active session.");
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(artifactId)) {
      throw new Error("Invalid artifact id.");
    }

    const index = await this.readIndex(sessionId);
    const ref = index.artifacts.find((artifact) => artifact.id === artifactId);
    if (!ref) {
      throw new Error("Artifact not found in this session.");
    }

    const fullContent = await IOUtils.readUTF8(
      this.getArtifactPath(sessionId, artifactId),
    );
    const offset = Math.min(
      normalizeOffset(options?.offset),
      fullContent.length,
    );
    const limit = normalizeReadLimit(options?.maxCharacters);
    const content = fullContent.slice(offset, offset + limit);
    return {
      ref,
      content,
      offset,
      returnedCharacters: content.length,
      hasMore: offset + content.length < fullContent.length,
    };
  }

  formatReadResult(result: ReadArtifactResult): string {
    return [
      `Artifact id: ${result.ref.id}`,
      `Tool: ${result.ref.toolName}`,
      `Original characters: ${result.ref.originalCharacters}`,
      `Returned range: ${result.offset}-${result.offset + result.returnedCharacters}`,
      `Has more: ${result.hasMore ? "yes" : "no"}`,
      "",
      result.content,
    ].join("\n");
  }

  async deleteSessionArtifacts(sessionId: string): Promise<void> {
    const folder = this.getSessionDirectory(sessionId);
    if (typeof IOUtils.remove !== "function") {
      return;
    }
    if (await IOUtils.exists(folder)) {
      await IOUtils.remove(folder, { recursive: true });
    }
  }

  private getSessionDirectory(sessionId: string): string {
    return getDataPath(ARTIFACT_ROOT, safePathPart(sessionId));
  }

  private getIndexPath(sessionId: string): string {
    return PathUtils.join(
      this.getSessionDirectory(sessionId),
      ARTIFACT_INDEX_FILE,
    );
  }

  private getArtifactPath(sessionId: string, artifactId: string): string {
    return PathUtils.join(
      this.getSessionDirectory(sessionId),
      `${safePathPart(artifactId)}.txt`,
    );
  }

  private async ensureSessionDirectory(sessionId: string): Promise<void> {
    const folder = this.getSessionDirectory(sessionId);
    if (!(await IOUtils.exists(folder))) {
      await IOUtils.makeDirectory(folder, { createAncestors: true });
    }
  }

  private async readIndex(sessionId: string): Promise<SessionArtifactIndex> {
    const indexPath = this.getIndexPath(sessionId);
    if (!(await IOUtils.exists(indexPath))) {
      return {
        version: 1,
        sessionId,
        artifacts: [],
      };
    }

    const raw = await IOUtils.readUTF8(indexPath);
    try {
      const parsed = JSON.parse(raw) as Partial<SessionArtifactIndex>;
      return {
        version: 1,
        sessionId,
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      };
    } catch {
      return {
        version: 1,
        sessionId,
        artifacts: [],
      };
    }
  }

  private async appendIndexEntry(
    sessionId: string,
    ref: ToolResultArtifactRef,
  ): Promise<void> {
    const index = await this.readIndex(sessionId);
    index.artifacts = [
      ...index.artifacts.filter((artifact) => artifact.id !== ref.id),
      ref,
    ];
    await IOUtils.writeUTF8(
      this.getIndexPath(sessionId),
      JSON.stringify(index, null, 2),
    );
  }

  private async enqueueIndexWrite(
    sessionId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const previous = this.indexWriteQueues.get(sessionId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.indexWriteQueues.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.indexWriteQueues.get(sessionId) === next) {
        this.indexWriteQueues.delete(sessionId);
      }
    }
  }
}

let sessionArtifactStore: SessionArtifactStore | null = null;

export function getSessionArtifactStore(): SessionArtifactStore {
  if (!sessionArtifactStore) {
    sessionArtifactStore = new SessionArtifactStore();
  }
  return sessionArtifactStore;
}

export function resetSessionArtifactStoreForTests(): void {
  sessionArtifactStore = null;
}
