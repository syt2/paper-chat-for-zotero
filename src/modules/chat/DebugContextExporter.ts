import type { ChatMessage, ChatSession } from "../../types/chat";
import type { ToolDefinition } from "../../types/tool";
import { getDataPath, getItemTitleSmart } from "../../utils/common";

export interface DebugContextSnapshot {
  version: 1;
  exportedAt: string;
  session: {
    id: string;
    title?: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    contextSummary?: ChatSession["contextSummary"];
    contextState?: ChatSession["contextState"];
  };
  provider: {
    id?: string;
    type?: string;
    model?: string;
    supportsToolCalling: boolean;
  };
  currentItem?: {
    id: number;
    key?: string;
    title?: string;
    isAttachment: boolean;
  };
  requestPreview: {
    filteredMessages: ChatMessage[];
    messagesWithContext: ChatMessage[];
    providerSystemPrompt?: string;
    paperContextPrompt?: string;
    runtimeContextPrompt?: string;
    toolDefinitions?: ToolDefinition[];
  };
  notes: string[];
}

interface SaveDebugContextSnapshotArgs {
  session: ChatSession;
  provider: DebugContextSnapshot["provider"];
  currentItem?: Zotero.Item | null;
  filteredMessages: ChatMessage[];
  messagesWithContext: ChatMessage[];
  providerSystemPrompt?: string;
  paperContextPrompt?: string;
  runtimeContextPrompt?: string;
  toolDefinitions?: ToolDefinition[];
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "unknown";
}

function buildCurrentItemSnapshot(
  item?: Zotero.Item | null,
): DebugContextSnapshot["currentItem"] | undefined {
  if (!item || !item.id) {
    return undefined;
  }

  return {
    id: item.id,
    key: item.key,
    title: getItemTitleSmart(item),
    isAttachment: item.isAttachment?.() || false,
  };
}

function buildSnapshot(
  args: SaveDebugContextSnapshotArgs,
): DebugContextSnapshot {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    session: {
      id: args.session.id,
      title: args.session.title,
      createdAt: args.session.createdAt,
      updatedAt: args.session.updatedAt,
      messageCount: args.session.messages.length,
      contextSummary: args.session.contextSummary,
      contextState: args.session.contextState,
    },
    provider: args.provider,
    currentItem: buildCurrentItemSnapshot(args.currentItem),
    requestPreview: {
      filteredMessages: args.filteredMessages,
      messagesWithContext: args.messagesWithContext,
      providerSystemPrompt: args.providerSystemPrompt,
      paperContextPrompt: args.paperContextPrompt,
      runtimeContextPrompt: args.runtimeContextPrompt,
      toolDefinitions: args.toolDefinitions,
    },
    notes: [
      "This file is for debugging model context construction. It may contain user prompts, assistant responses, tool results, notes, and PDF-derived text snippets.",
      "Provider API keys and full provider configs are intentionally omitted.",
    ],
  };
}

export async function saveDebugContextSnapshot(
  args: SaveDebugContextSnapshotArgs,
): Promise<string> {
  const folder = getDataPath("debug-contexts");
  if (!(await IOUtils.exists(folder))) {
    await IOUtils.makeDirectory(folder, { createAncestors: true });
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  const title = safeFilePart(args.session.title || "untitled");
  const fileName = `${timestamp}_${safeFilePart(args.session.id)}_${title}.json`;
  const filePath = PathUtils.join(folder, fileName);
  await IOUtils.writeUTF8(
    filePath,
    JSON.stringify(buildSnapshot(args), null, 2),
  );
  return filePath;
}
