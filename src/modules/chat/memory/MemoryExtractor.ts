import type { ChatMessage } from "../../../types/chat";
import type { AIProvider } from "../../../types/provider";
import {
  buildMemoryExtractionConversationText,
  buildMemoryExtractionPrompt,
} from "./MemoryExtractionPrompt";
import {
  parseMemoryExtractionResponse,
  type ExtractedMemoryEntry,
} from "./MemoryExtractionParser";

type MemoryExtractionProvider = Pick<AIProvider, "isReady" | "chatCompletion">;
type MemoryProviderGetter = () => Promise<MemoryExtractionProvider | null>;

export type MemoryExtractionResult =
  | {
      ok: true;
      entries: ExtractedMemoryEntry[];
    }
  | {
      ok: false;
      reason:
        | "no_provider"
        | "provider_not_ready"
        | "empty_conversation"
        | "empty_response"
        | "no_json_array"
        | "invalid_json_array"
        | "not_array";
    };

export interface MemoryExtractor {
  extract(messages: ChatMessage[]): Promise<MemoryExtractionResult>;
}

export type MemoryExtractorFactory = () => MemoryExtractor;

async function getActiveMemoryProvider(): Promise<MemoryExtractionProvider | null> {
  try {
    const { getProviderManager } = await import("../../providers");
    return getProviderManager().getActiveProvider();
  } catch {
    return null;
  }
}

export class ProviderMemoryExtractor implements MemoryExtractor {
  constructor(private getProvider: MemoryProviderGetter = getActiveMemoryProvider) {}

  async extract(messages: ChatMessage[]): Promise<MemoryExtractionResult> {
    const provider = await this.getProvider();
    if (!provider) {
      return { ok: false, reason: "no_provider" };
    }
    if (!provider.isReady()) {
      return { ok: false, reason: "provider_not_ready" };
    }

    const conversationText = buildMemoryExtractionConversationText(messages);
    if (!conversationText.trim()) {
      return { ok: false, reason: "empty_conversation" };
    }

    const response = await provider.chatCompletion([
      {
        id: "mem-usr",
        role: "user",
        content: buildMemoryExtractionPrompt(conversationText),
        timestamp: Date.now(),
      },
    ]);
    if (!response) {
      return { ok: false, reason: "empty_response" };
    }

    return parseMemoryExtractionResponse(response);
  }
}

export function getMemoryExtractor(): MemoryExtractor {
  return new ProviderMemoryExtractor();
}
